'use strict';

const crypto = require('crypto');
const config = require('./config');

// Minimal signed-cookie session: value is "exp.hmac" where hmac covers "staff|exp".
// No server-side store needed — good for a single shared staff role.

const COOKIE = 'sid';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(exp) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`staff|${exp}`)
    .digest('base64url');
}

function issue() {
  const exp = Date.now() + MAX_AGE_MS;
  return `${exp}.${sign(exp)}`;
}

function isValid(value) {
  if (!value || typeof value !== 'string') return false;
  const [expStr, mac] = value.split('.');
  const exp = parseInt(expStr, 10);
  if (!exp || Number.isNaN(exp) || exp < Date.now()) return false;
  const expected = sign(exp);
  // Constant-time compare to avoid timing leaks on the MAC.
  const a = Buffer.from(mac || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Constant-time password check.
function checkPassword(input) {
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(config.staffPassword, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function setCookie(res) {
  res.cookie(COOKIE, issue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.trustProxy || config.baseUrl.startsWith('https'),
    maxAge: MAX_AGE_MS,
  });
}

function clearCookie(res) {
  res.clearCookie(COOKIE);
}

// Express middleware: allow through if a valid staff cookie is present.
function requireStaff(req, res, next) {
  if (isValid(req.cookies && req.cookies[COOKIE])) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const back = encodeURIComponent(req.originalUrl || '/scan');
  return res.redirect(`/login?next=${back}`);
}

module.exports = { COOKIE, issue, isValid, checkPassword, setCookie, clearCookie, requireStaff };
