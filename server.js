'use strict';

const path = require('path');
const express = require('express');
const config = require('./lib/config');
const { db } = require('./lib/db');
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

// ---------- prepared statements ----------
const claimEntry = db.prepare(
  `UPDATE attendees SET status='entered', entered_at=datetime('now') WHERE token=? AND status='registered'`
);
const getByToken = db.prepare(`SELECT * FROM attendees WHERE token=?`);
const logScan = db.prepare(`INSERT INTO scans (attendee_id, token, result, ip) VALUES (?,?,?,?)`);
const undoEntry = db.prepare(`UPDATE attendees SET status='registered', entered_at=NULL WHERE id=?`);

function publicView(a) {
  let extra = {};
  try { extra = a.extra ? JSON.parse(a.extra) : {}; } catch { /* ignore */ }
  return { id: a.id, name: a.name, email: a.email, status: a.status, entered_at: a.entered_at, extra };
}

// Atomically claim entry for a token. Safe against double-scans / races because
// the UPDATE only succeeds when status is still 'registered'.
function verifyToken(token, ip) {
  if (!token || typeof token !== 'string') {
    logScan.run(null, String(token || ''), 'invalid', ip);
    return { result: 'invalid' };
  }
  const info = claimEntry.run(token);
  const a = getByToken.get(token);
  if (!a) {
    logScan.run(null, token, 'invalid', ip);
    return { result: 'invalid' };
  }
  if (info.changes === 1) {
    logScan.run(a.id, token, 'entered', ip);
    return { result: 'entered', attendee: publicView(a) };
  }
  logScan.run(a.id, token, 'already', ip);
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

app.post('/api/verify', session.requireStaff, (req, res) => {
  const token = req.body && req.body.token;
  res.json(verifyToken(token, req.ip));
});

app.get('/api/stats', session.requireStaff, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM attendees').get().c;
  const entered = db.prepare(`SELECT COUNT(*) c FROM attendees WHERE status='entered'`).get().c;
  res.json({ total, entered, remaining: total - entered });
});

app.get('/api/attendees', session.requireStaff, (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const rows = db
    .prepare(
      `SELECT id, name, email, status, entered_at FROM attendees
       WHERE lower(name) LIKE ? OR lower(COALESCE(email,'')) LIKE ?
       ORDER BY entered_at DESC NULLS LAST, name LIMIT 200`
    )
    .all(q, q);
  res.json(rows);
});

// Staff correction: undo an accidental entry so the person can re-enter.
app.post('/api/attendees/:id/undo', session.requireStaff, (req, res) => {
  const info = undoEntry.run(parseInt(req.params.id, 10));
  res.json({ ok: info.changes === 1 });
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

app.listen(config.port, () => {
  console.log(`Entry system running on ${config.baseUrl} (port ${config.port})`);
  console.log(`Scanner:  ${config.baseUrl}/scan`);
  console.log(`Dashboard: ${config.baseUrl}/admin`);
});

