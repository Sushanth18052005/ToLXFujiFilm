'use strict';

const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const config = require('./lib/config');
const { pool, query, init, newToken } = require('./lib/db');
const session = require('./lib/session');
const { runImport } = require('./lib/importer');
const { buildAttendeesWorkbook } = require('./lib/exporter');
const { sendEmails } = require('./lib/mailer');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- tiny cookie parser (avoids an extra dependency) ---
app.use((req, res, next) => {
  const header = req.headers.cookie || '';
  req.cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});

// ---------- SQL ----------
const SQL_CLAIM = `UPDATE attendees SET status='entered', entered_at=now() WHERE token=$1 AND status='registered'`;
const SQL_GET = `SELECT id, name, email, status,
    to_char(entered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS entered_at, extra
  FROM attendees WHERE token=$1`;
const SQL_LOG = `INSERT INTO scans (attendee_id, token, result, ip) VALUES ($1,$2,$3,$4)`;
const SQL_UNDO = `UPDATE attendees SET status='registered', entered_at=NULL WHERE id=$1 RETURNING name, email`;

function publicView(a) {
  let extra = {};
  try { extra = a.extra ? JSON.parse(a.extra) : {}; } catch { /* ignore */ }
  return { id: a.id, name: a.name, email: a.email, status: a.status, entered_at: a.entered_at, extra };
}

// Atomically claim entry for a token. Safe against double-scans / races because
// the UPDATE only succeeds when status is still 'registered' — Postgres locks
// the row, so exactly one concurrent scan gets rowCount === 1.
async function verifyToken(token, ip) {
  if (!token || typeof token !== 'string') {
    await query(SQL_LOG, [null, String(token || ''), 'invalid', ip]);
    return { result: 'invalid' };
  }
  const claim = await query(SQL_CLAIM, [token]);
  const { rows } = await query(SQL_GET, [token]);
  const a = rows[0];
  if (!a) {
    await query(SQL_LOG, [null, token, 'invalid', ip]);
    return { result: 'invalid' };
  }
  if (claim.rowCount === 1) {
    await query(SQL_LOG, [a.id, token, 'entered', ip]);
    return { result: 'entered', attendee: publicView(a) };
  }
  await query(SQL_LOG, [a.id, token, 'already', ip]);
  return { result: 'already', attendee: publicView(a) };
}

// ---------- HTML helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function loginPage(next, error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title> ${esc(config.eventName)}</title>
<link rel="stylesheet" href="/styles.css">
<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/img/favicon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/img/favicon-512.png">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png"></head>
<body class="center">
  <div class="login">
    <div class="login__media">
      <img src="/img/hero.jpg" alt="Traces of Lenses × Fujifilm">
      <div class="cap">See • Frame • Create</div>
    </div>
    <form class="login__form" method="post" action="/login">
      <div class="brand">Traces of Lenses <span class="x">×</span> Fujifilm <span class="kmit">KMIT</span></div>
      <span class="eyebrow">Staff Access</span>
      <h1>Entry<br>Scanner</h1>
      <p class="tagline">A New Way To See</p>
      <hr class="rule">
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <input type="hidden" name="next" value="${esc(next || '/scan')}">
      <label>Staff password
        <input type="password" name="password" autocomplete="current-password" required autofocus>
      </label>
      <button type="submit">Unlock Scanner</button>
    </form>
  </div>
</body></html>`;
}

// Only allow redirecting back to local paths (never open redirects).
function safeNext(next) {
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/scan';
}

// ---------- simple login throttle (per IP) ----------
const attempts = new Map(); // ip -> { count, first }
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && now - rec.first < 15 * 60 * 1000 && rec.count >= 10) return true;
  return false;
}
function noteFail(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > 15 * 60 * 1000) attempts.set(ip, { count: 1, first: now });
  else rec.count++;
}

// ---------- organizer-password gate for sensitive actions ----------
// Middleware factory. An action whose ALLOW_* flag is left open (config.locks
// false) passes straight through with just the staff login. A LOCKED action
// requires the organizer password in the `X-Organizer-Password` header:
//   - not_configured : action is locked but ORGANIZER_PASSWORD is blank → fail
//                       closed (blocked for everyone until it's set).
//   - unlock_required : locked and no password was sent.
//   - bad_password    : locked and the password was wrong.
function requireUnlock(action) {
  return (req, res, next) => {
    if (!config.locks[action]) return next();
    if (!config.organizerPassword) {
      return res.status(403).json({ ok: false, error: 'not_configured' });
    }
    const pw = req.get('x-organizer-password') || '';
    if (!pw) return res.status(403).json({ ok: false, error: 'unlock_required' });
    if (session.checkOrganizer(pw)) return next();
    return res.status(403).json({ ok: false, error: 'bad_password' });
  };
}

// Append rows to the tamper-evident audit_log. Batched (one INSERT) and never
// throws into the request path — a logging failure must not fail the action, so
// errors are only logged to the console. `entries` is an array of
// { action, attendee_id, name, email, detail }.
async function audit(entries, ip) {
  if (!entries || !entries.length) return;
  try {
    await query(
      `INSERT INTO audit_log (action, attendee_id, name, email, detail, ip)
       SELECT action, attendee_id, name, email, detail, $6::text
         FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[])
           AS t(action, attendee_id, name, email, detail)`,
      [
        entries.map((e) => e.action),
        entries.map((e) => (Number.isInteger(e.attendee_id) ? e.attendee_id : null)),
        entries.map((e) => e.name ?? null),
        entries.map((e) => e.email ?? null),
        entries.map((e) => e.detail ?? null),
        ip || null,
      ]
    );
  } catch (err) {
    console.error('audit log error:', err.message);
  }
}

// ---------- routes ----------
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Public: an attendee's QR as a PNG, for the hosted <img> in their email (Brevo
// can't embed inline CID images). Only serves QRs for tokens that exist. The
// token is the entry credential the email already contains, so this exposes
// nothing new; the ?t= link inside still requires a staff login to check anyone in.
app.get('/qr/:token', async (req, res) => {
  const token = String(req.params.token || '').replace(/\.png$/i, '');
  try {
    const { rows } = await query('SELECT 1 FROM attendees WHERE token = $1', [token]);
    if (!rows.length) return res.status(404).type('text').send('not found');
    const png = await QRCode.toBuffer(`${config.baseUrl}/scan?t=${encodeURIComponent(token)}`,
      { errorCorrectionLevel: 'M', margin: 2, width: 512 });
    res.type('png').set('Cache-Control', 'public, max-age=86400').send(png);
  } catch (err) {
    console.error('qr error:', err.message);
    res.status(500).type('text').send('error');
  }
});

app.get('/', (req, res) => res.redirect('/scan'));

app.get('/login', (req, res) => {
  res.type('html').send(loginPage(safeNext(req.query.next), null));
});

app.post('/login', (req, res) => {
  const ip = req.ip;
  const next = safeNext(req.body.next);
  if (throttled(ip)) {
    return res.status(429).type('html').send(loginPage(next, 'Too many attempts. Wait a few minutes.'));
  }
  if (!config.staffPassword) {
    return res.status(500).type('html').send(loginPage(next, 'STAFF_PASSWORD is not configured on the server.'));
  }
  if (session.checkPassword(req.body.password)) {
    session.setCookie(res);
    return res.redirect(next);
  }
  noteFail(ip);
  return res.status(401).type('html').send(loginPage(next, 'Incorrect password.'));
});

app.post('/logout', (req, res) => {
  session.clearCookie(res);
  res.redirect('/login');
});

// Everything below requires a valid staff session.
app.get('/scan', session.requireStaff, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

app.get('/admin', session.requireStaff, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/verify', session.requireStaff, async (req, res) => {
  const token = req.body && req.body.token;
  try {
    res.json(await verifyToken(token, req.ip));
  } catch (err) {
    console.error('verify error:', err.message);
    res.status(500).json({ result: 'error' });
  }
});

app.get('/api/stats', session.requireStaff, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status='entered')::int AS entered,
         COUNT(*) FILTER (WHERE email_sent_at IS NOT NULL)::int AS emailed
       FROM attendees`
    );
    const { total, entered, emailed } = rows[0];
    res.json({ total, entered, emailed, remaining: total - entered });
  } catch (err) {
    console.error('stats error:', err.message);
    res.status(500).json({ error: 'stats_failed' });
  }
});

// Which sensitive actions are locked behind the organizer password. The admin
// page reads this so it only prompts for the password on actions that need it.
app.get('/api/locks', session.requireStaff, (req, res) => {
  res.json(config.locks);
});

app.get('/api/attendees', session.requireStaff, async (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const status = String(req.query.status || '');
  const emailed = String(req.query.emailed || '');
  const source = String(req.query.source || '');
  const regen = String(req.query.regen || '');
  const params = [q, q];
  const where = [`(lower(name) LIKE $1 OR lower(COALESCE(email,'')) LIKE $2)`];
  if (status === 'entered' || status === 'registered') {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (emailed === 'yes') where.push(`email_sent_at IS NOT NULL`);
  else if (emailed === 'no') where.push(`email_sent_at IS NULL AND email IS NOT NULL AND email <> ''`);
  else if (emailed === 'resent') where.push(`resent = true`);
  else if (emailed === 'none') where.push(`(email IS NULL OR email = '')`);
  if (source === 'import' || source === 'manual') {
    params.push(source);
    where.push(`source = $${params.length}`);
  }
  if (regen === 'yes') where.push(`regen_count > 0`);
  else if (regen === 'no') where.push(`regen_count = 0`);
  try {
    const { rows } = await query(
      `SELECT id, name, email, status, resent, regen_count,
         to_char(entered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS entered_at,
         to_char(email_sent_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS email_sent_at,
         to_char(regenerated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS regenerated_at
       FROM attendees
       WHERE ${where.join(' AND ')}
       ORDER BY entered_at DESC NULLS LAST, name LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('attendees error:', err.message);
    res.status(500).json({ error: 'query_failed' });
  }
});

// Staff correction: undo an accidental entry so the person can re-enter.
app.post('/api/attendees/:id/undo', session.requireStaff, requireUnlock('undo'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  try {
    const info = await query(SQL_UNDO, [id]);
    if (info.rowCount === 1) {
      const a = info.rows[0];
      await audit([{ action: 'undo', attendee_id: id, name: a.name, email: a.email, detail: 'single' }], req.ip);
    }
    res.json({ ok: info.rowCount === 1 });
  } catch (err) {
    console.error('undo error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Re-issue an attendee's QR: assign a fresh token (the QR is derived from it, so
// this makes a new code and INVALIDATES the old one) and clear their email state
// so they resurface as "not sent" and can be re-emailed. Use when a QR didn't
// generate/arrive or a code needs to be reset.
app.post('/api/attendees/:id/regenerate', session.requireStaff, requireUnlock('regen'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  try {
    const info = await query(
      `UPDATE attendees
          SET token = $2, email_sent_at = NULL, resent = false,
              regen_count = regen_count + 1, regenerated_at = now()
        WHERE id = $1
        RETURNING name, email`,
      [id, newToken()]
    );
    if (info.rowCount === 1) {
      const a = info.rows[0];
      await audit([{ action: 'regenerate', attendee_id: id, name: a.name, email: a.email, detail: 'single' }], req.ip);
    }
    res.json({ ok: info.rowCount === 1 });
  } catch (err) {
    console.error('regenerate error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Add a single attendee by hand (assigns a token, like the importer does).
app.post('/api/attendees', session.requireStaff, requireUnlock('add'), async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  try {
    const { rows } = await query(
      `INSERT INTO attendees (name, email, extra, token, source) VALUES ($1, $2, $3, $4, 'manual') RETURNING id`,
      [name, email || null, '{}', newToken()]
    );
    await audit([{ action: 'add', attendee_id: rows[0].id, name, email: email || null, detail: 'manual' }], req.ip);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An attendee with that email already exists.' });
    }
    console.error('add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete an attendee (and their scan logs).
app.delete('/api/attendees/:id', session.requireStaff, requireUnlock('delete'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  try {
    await query('DELETE FROM scans WHERE attendee_id = $1', [id]);
    const info = await query(
      `DELETE FROM attendees WHERE id = $1
         RETURNING name, email, status,
           to_char(entered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS entered_at`,
      [id]
    );
    if (info.rowCount === 1) {
      const a = info.rows[0];
      // Stamp the victim's state at delete time into the (append-only) audit detail.
      // Deleting someone who had ALREADY ENTERED is the fingerprint of the delete+
      // re-add seat-recycling trick, so the export can flag it. Past deletes logged
      // before this change stay as plain 'single' — the prior status wasn't captured.
      const detail = a.status === 'entered'
        ? `single; was ENTERED (${a.entered_at || '?'} IST)`
        : 'single';
      await audit([{ action: 'delete', attendee_id: id, name: a.name, email: a.email, detail }], req.ip);
    }
    res.json({ ok: info.rowCount === 1 });
  } catch (err) {
    console.error('delete error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Clean array of integer ids from a JSON body { ids: [...] } (for bulk actions).
function bodyIds(req) {
  return Array.isArray(req.body && req.body.ids)
    ? req.body.ids.map((n) => parseInt(n, 10)).filter(Number.isInteger)
    : [];
}

// Bulk undo: return the selected 'entered' people to 'registered' so they can
// re-enter. Only rows currently 'entered' are affected.
app.post('/api/attendees/bulk-undo', session.requireStaff, requireUnlock('undo'), async (req, res) => {
  const ids = bodyIds(req);
  if (!ids.length) return res.status(400).json({ ok: false, error: 'no ids' });
  try {
    const info = await query(
      `UPDATE attendees SET status='registered', entered_at=NULL
         WHERE id = ANY($1::bigint[]) AND status='entered'
         RETURNING id, name, email`,
      [ids]
    );
    await audit(
      info.rows.map((r) => ({ action: 'undo', attendee_id: r.id, name: r.name, email: r.email, detail: 'bulk' })),
      req.ip
    );
    res.json({ ok: true, updated: info.rowCount });
  } catch (err) {
    console.error('bulk-undo error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Bulk delete: remove the selected attendees and their scan logs.
app.post('/api/attendees/bulk-delete', session.requireStaff, requireUnlock('delete'), async (req, res) => {
  const ids = bodyIds(req);
  if (!ids.length) return res.status(400).json({ ok: false, error: 'no ids' });
  try {
    await query('DELETE FROM scans WHERE attendee_id = ANY($1::bigint[])', [ids]);
    const info = await query(
      `DELETE FROM attendees WHERE id = ANY($1::bigint[])
         RETURNING id, name, email, status,
           to_char(entered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS entered_at`,
      [ids]
    );
    await audit(
      info.rows.map((r) => ({
        action: 'delete', attendee_id: r.id, name: r.name, email: r.email,
        detail: r.status === 'entered' ? `bulk; was ENTERED (${r.entered_at || '?'} IST)` : 'bulk',
      })),
      req.ip
    );
    res.json({ ok: true, deleted: info.rowCount });
  } catch (err) {
    console.error('bulk-delete error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Bulk regenerate: rotate the token for each selected attendee (a new QR each,
// old ones invalidated) and reset their email state so they resurface as "not
// sent". Done in one statement — unnest pairs each id with its own freshly
// generated token, so every row gets a distinct code.
app.post('/api/attendees/bulk-regenerate', session.requireStaff, requireUnlock('regen'), async (req, res) => {
  const ids = bodyIds(req);
  if (!ids.length) return res.status(400).json({ ok: false, error: 'no ids' });
  try {
    const tokens = ids.map(() => newToken());
    const info = await query(
      `UPDATE attendees AS a
          SET token = t.token, email_sent_at = NULL, resent = false,
              regen_count = a.regen_count + 1, regenerated_at = now()
         FROM unnest($1::bigint[], $2::text[]) AS t(id, token)
        WHERE a.id = t.id
        RETURNING a.id, a.name, a.email`,
      [ids, tokens]
    );
    await audit(
      info.rows.map((r) => ({ action: 'regenerate', attendee_id: r.id, name: r.name, email: r.email, detail: 'bulk' })),
      req.ip
    );
    res.json({ ok: true, updated: info.rowCount });
  } catch (err) {
    console.error('bulk-regenerate error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Upload an .xlsx from the admin page and import it (assigns tokens, upserts).
// The file is sent as the raw request body; parsed in memory (no disk write).
const XLSX_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
];
app.post(
  '/api/import',
  session.requireStaff,
  express.raw({ type: XLSX_TYPES, limit: '15mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'No file received. Upload an .xlsx file.' });
    }
    try {
      const result = await runImport({ buffer: req.body });
      res.json(result);
    } catch (err) {
      console.error('import error:', err.message);
      res.status(400).json({ error: err.message });
    }
  }
);

// Export every attendee as a downloadable .xlsx from the admin page. Mirrors the
// import columns and adds an "Added Manually" flag for people created in the
// dashboard rather than imported from a spreadsheet. Never includes the token.
app.get('/api/export', session.requireStaff, async (req, res) => {
  try {
    const buf = await buildAttendeesWorkbook();
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="attendees-${stamp}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('export error:', err.message);
    res.status(500).json({ error: 'export_failed' });
  }
});

// Background email send job. Sending is a serial loop (one Brevo API call per
// attendee) that can take minutes for a big list; awaiting it inside the request
// makes Render's proxy time out and return an HTML error page (the admin page then
// chokes on "Unexpected token '<'"). So we kick the send off in the background and
// let the admin page poll /api/send/status. Single shared staff role + single
// instance ⇒ one job at a time.
let sendJob = {
  running: false, done: false, startedAt: null, finishedAt: null,
  total: 0, sent: 0, failed: 0, errors: [], last: null, error: null, resend: false,
};

function runSendJob({ resend, ids }) {
  sendJob = {
    running: true, done: false, startedAt: Date.now(), finishedAt: null,
    total: 0, sent: 0, failed: 0, errors: [], last: null, error: null, resend,
  };
  sendEmails({
    resend,
    ids,
    onProgress: ({ sent, total, name }) => {
      sendJob.sent = sent;
      sendJob.total = total;
      sendJob.last = name;
    },
  }).then((result) => {
    sendJob.total = result.total;
    sendJob.sent = result.sent;
    sendJob.failed = result.failed;
    sendJob.errors = result.errors || [];
  }).catch((err) => {
    console.error('send job error:', err.message);
    sendJob.error = err.message;
  }).finally(() => {
    sendJob.running = false;
    sendJob.done = true;
    sendJob.finishedAt = Date.now();
  });
}

// Email attendees their QR from the admin page. Body: { resend, dryRun, ids? }.
// dryRun answers synchronously (a DB query only, no email sent); a real send starts
// a background job and returns 202 — progress is read from /api/send/status.
// When `ids` is present, only those attendees are targeted (and they are (re)sent
// regardless of whether they were emailed before).
app.post('/api/send', session.requireStaff, async (req, res) => {
  const resend = !!(req.body && req.body.resend);
  const dryRun = !!(req.body && req.body.dryRun);
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.map((n) => parseInt(n, 10)).filter(Number.isInteger)
    : null;

  if (dryRun) {
    try {
      res.json(await sendEmails({ resend, dryRun: true, ids }));
    } catch (err) {
      console.error('send dry-run error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (sendJob.running) {
    return res.status(409).json({ error: 'A send is already in progress.', status: sendJob });
  }
  runSendJob({ resend, ids });
  res.status(202).json({ started: true });
});

app.get('/api/send/status', session.requireStaff, (req, res) => {
  res.json(sendJob);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- startup checks ----------
if (!config.sessionSecret) {
  console.error('FATAL: SESSION_SECRET is not set. Copy .env.example to .env and set it.');
  process.exit(1);
}
if (!config.staffPassword) {
  console.warn('WARNING: STAFF_PASSWORD is empty — staff will not be able to log in.');
}

// Summarize the organizer-password gate so misconfiguration is obvious in logs.
{
  const locked = Object.keys(config.locks).filter((k) => config.locks[k]);
  if (!locked.length) {
    console.log('Organizer lock: OFF — regen/add/delete/undo are open to any logged-in staff.');
  } else if (!config.organizerPassword) {
    console.warn(
      `WARNING: these actions are LOCKED (${locked.join(', ')}) but ORGANIZER_PASSWORD is empty — `
      + 'they are BLOCKED for everyone until you set it.'
    );
  } else {
    console.log(`Organizer lock: ON for ${locked.join(', ')} (organizer password required); others open.`);
  }
}

// ---------- startup ----------
(async () => {
  try {
    await init(); // create schema (idempotent)
  } catch (err) {
    console.error('FATAL: could not initialize the database:', err.message);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Entry system running on ${config.baseUrl} (port ${config.port})`);
    console.log(`Scanner:  ${config.baseUrl}/scan`);
    console.log(`Dashboard: ${config.baseUrl}/admin`);
  });
})();

