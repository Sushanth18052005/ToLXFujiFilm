'use strict';

const path = require('path');
const express = require('express');
const config = require('./lib/config');
const { pool, query, init } = require('./lib/db');
const session = require('./lib/session');

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
    to_char(entered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS entered_at, extra
  FROM attendees WHERE token=$1`;
const SQL_LOG = `INSERT INTO scans (attendee_id, token, result, ip) VALUES ($1,$2,$3,$4)`;
const SQL_UNDO = `UPDATE attendees SET status='registered', entered_at=NULL WHERE id=$1`;

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
<title>Staff login — ${esc(config.eventName)}</title>
<link rel="stylesheet" href="/styles.css"></head>
<body class="center">
  <form class="card" method="post" action="/login">
    <h1>${esc(config.eventName)}</h1>
    <p class="muted">Staff entry scanner</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <input type="hidden" name="next" value="${esc(next || '/scan')}">
    <label>Staff password
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    <button type="submit">Unlock scanner</button>
  </form>
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

// ---------- routes ----------
app.get('/healthz', (req, res) => res.type('text').send('ok'));

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
         COUNT(*) FILTER (WHERE status='entered')::int AS entered
       FROM attendees`
    );
    const { total, entered } = rows[0];
    res.json({ total, entered, remaining: total - entered });
  } catch (err) {
    console.error('stats error:', err.message);
    res.status(500).json({ error: 'stats_failed' });
  }
});

app.get('/api/attendees', session.requireStaff, async (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  try {
    const { rows } = await query(
      `SELECT id, name, email, status,
         to_char(entered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS entered_at
       FROM attendees
       WHERE lower(name) LIKE $1 OR lower(COALESCE(email,'')) LIKE $2
       ORDER BY entered_at DESC NULLS LAST, name LIMIT 200`,
      [q, q]
    );
    res.json(rows);
  } catch (err) {
    console.error('attendees error:', err.message);
    res.status(500).json({ error: 'query_failed' });
  }
});

// Staff correction: undo an accidental entry so the person can re-enter.
app.post('/api/attendees/:id/undo', session.requireStaff, async (req, res) => {
  try {
    const info = await query(SQL_UNDO, [parseInt(req.params.id, 10)]);
    res.json({ ok: info.rowCount === 1 });
  } catch (err) {
    console.error('undo error:', err.message);
    res.status(500).json({ ok: false });
  }
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

// ---------- startup ----------
(async () => {
  try {
    await init(); // create schema (idempotent) and seed if empty
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

