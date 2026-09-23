'use strict';
// Shared emailing logic: generate each attendee's QR in memory and email it via
// SMTP. Used by both the CLI (scripts/send-emails.js) and the web admin
// (POST /api/send). The QR encodes <BASE_URL>/scan?t=<token>.

const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const config = require('./config');
const { query } = require('./db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scanUrl(token) {
  return `${config.baseUrl}/scan?t=${encodeURIComponent(token)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Branded HTML email built from tables + inline styles (the only thing email
// clients render reliably). Mirrors the event brochure: black header with the
// TRACES OF LENSES × FUJIFILM wordmark, cream body, the QR as an inline image.
function html(name) {
  const nm = escapeHtml(name);
  const c = config;
  const P = [];
  P.push(`<!doctype html><html><body style="margin:0;padding:0;background:#0a0a0a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#f2f0eb;border-radius:6px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background:#0a0a0a;padding:26px 30px 0;">
<div style="font-size:18px;font-weight:bold;letter-spacing:1px;color:#ffffff;text-transform:uppercase;">Traces of Lenses <span style="color:#e4002b;">&times; Fujifilm</span></div>
<div style="font-size:11px;letter-spacing:2px;color:#9a9a9a;text-transform:uppercase;margin-top:6px;">KMIT &middot; Photography &amp; Videography Club</div>
</td></tr>
<tr><td style="background:#0a0a0a;padding:22px 30px 28px;">
<div style="height:3px;width:46px;background:#e4002b;line-height:3px;font-size:0;margin-bottom:16px;">&nbsp;</div>
<div style="font-size:24px;font-weight:bold;color:#ffffff;text-transform:uppercase;line-height:1.12;">Interactive Photography Workshop</div>
<div style="font-size:12px;letter-spacing:3px;color:#9a9a9a;text-transform:uppercase;margin-top:12px;">See &bull; Frame &bull; Create</div>
</td></tr>`);
  P.push(`<tr><td style="padding:30px 30px 6px;">
<div style="font-size:11px;letter-spacing:2px;color:#e4002b;text-transform:uppercase;font-weight:bold;">Your Entry Pass</div>
<p style="font-size:15px;color:#1a1a1a;margin:14px 0 4px;">Hi ${nm},</p>
<p style="font-size:15px;color:#444444;line-height:1.6;margin:0;">You're confirmed for the workshop. Show the QR code below at the entrance &mdash; it's your personal entry pass, so please keep it private.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr>
<td align="center" style="background:#ffffff;border:1px solid #dddddd;border-radius:8px;padding:20px;">
<img src="cid:qr@entry" alt="Your entry QR code" width="240" height="240" style="display:block;border:0;outline:none;"/>
<div style="font-size:11px;color:#888888;margin-top:12px;letter-spacing:2px;">SHOW THIS AT ENTRANCE</div>
</td></tr></table></td></tr>
<tr><td style="padding:0 30px 26px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #d8d5cc;">
<tr><td style="padding:16px 0 5px;font-size:11px;letter-spacing:1px;color:#e4002b;text-transform:uppercase;font-weight:bold;">Date</td></tr>
<tr><td style="padding:0 0 13px;font-size:15px;color:#1a1a1a;border-bottom:1px solid #e4e1d8;">${escapeHtml(c.eventDate)}</td></tr>
<tr><td style="padding:16px 0 5px;font-size:11px;letter-spacing:1px;color:#e4002b;text-transform:uppercase;font-weight:bold;">Time</td></tr>
<tr><td style="padding:0 0 13px;font-size:15px;color:#1a1a1a;border-bottom:1px solid #e4e1d8;">${escapeHtml(c.eventTime)}</td></tr>
<tr><td style="padding:16px 0 5px;font-size:11px;letter-spacing:1px;color:#e4002b;text-transform:uppercase;font-weight:bold;">Venue</td></tr>
<tr><td style="padding:0;font-size:15px;color:#1a1a1a;">${escapeHtml(c.eventVenue)}</td></tr>
</table>
<p style="font-size:13px;color:#777777;line-height:1.6;margin:20px 0 0;">If the code doesn't display, just show this email at the entrance and our team will check you in by name.</p>
</td></tr>
<tr><td style="background:#0a0a0a;padding:24px 30px;">
<div style="font-size:15px;font-weight:bold;color:#ffffff;text-transform:uppercase;letter-spacing:1px;">A New Way To See</div>
<div style="font-size:11px;color:#8a8a8a;margin-top:8px;letter-spacing:1px;">Traces of Lenses &times; Fujifilm &middot; KMIT</div>
</td></tr>
</table></td></tr></table></body></html>`);
  return P.join('');
}

// Plain-text alternative (shown by clients that don't render HTML). The QR only
// exists in the HTML part, so this points the reader there.
function text(name) {
  const c = config;
  return `TRACES OF LENSES x FUJIFILM — Interactive Photography Workshop\n\n`
    + `Hi ${name},\n\n`
    + `You're confirmed for the workshop. Your entry pass is the QR code in the `
    + `HTML version of this email — show it at the entrance to check in. Please keep it private.\n\n`
    + `Date:  ${c.eventDate}\n`
    + `Time:  ${c.eventTime}\n`
    + `Venue: ${c.eventVenue}\n\n`
    + `If the code doesn't display, show this email at the entrance and our team will check you in by name.\n\n`
    + `See • Frame • Create — A New Way To See\nKMIT · Photography & Videography Club`;
}

// Emails attendees their QR. Options:
//   resend   — include people already emailed (default only un-emailed)
//   dryRun   — send nothing, just return who would be emailed
//   onProgress({ sent, total, name }) — optional callback per successful send
async function sendEmails({ resend = false, dryRun = false, onProgress } = {}) {
  const where = resend
    ? `email IS NOT NULL AND email <> ''`
    : `email IS NOT NULL AND email <> '' AND email_sent_at IS NULL`;
  const { rows } = await query(`SELECT id, name, email, token FROM attendees WHERE ${where} ORDER BY id`);

  if (dryRun) {
    return { dryRun: true, total: rows.length, sent: 0, failed: 0,
      recipients: rows.map((r) => ({ name: r.name, email: r.email })) };
  }
  if (rows.length === 0) return { total: 0, sent: 0, failed: 0, errors: [] };

  if (!config.smtp.host) throw new Error('SMTP_HOST is not set. Configure the SMTP_* env vars.');
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    // Force IPv4. Some hosts (incl. Render) resolve smtp.gmail.com to an IPv6
    // address they can't route to, which fails with ENETUNREACH on ::/port.
    family: 4,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  await transporter.verify();

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const a of rows) {
    try {
      const png = await QRCode.toBuffer(scanUrl(a.token), { errorCorrectionLevel: 'M', margin: 2, width: 512 });
      await transporter.sendMail({
        from: config.mailFrom,
        to: a.email,
        subject: 'Your Entry Pass — Traces of Lenses × Fujifilm Workshop',
        text: text(a.name),
        html: html(a.name),
        attachments: [{ filename: 'entry-qr.png', content: png, cid: 'qr@entry' }],
      });
      await query(`UPDATE attendees SET email_sent_at = now() WHERE id = $1`, [a.id]);
      sent++;
      if (onProgress) onProgress({ sent, total: rows.length, name: a.name });
      await sleep(250); // be gentle with the SMTP server
    } catch (err) {
      failed++;
      errors.push({ email: a.email, error: err.message });
    }
  }
  return { total: rows.length, sent, failed, errors };
}

module.exports = { sendEmails, scanUrl, html, text };
