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

function html(name) {
  return `
  <div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:auto;color:#111">
    <h2 style="margin:0 0 8px">${escapeHtml(config.eventName)}</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>You're registered! Show the QR code below at the entrance to check in.
       Please keep it private &mdash; it's your personal entry pass.</p>
    <p style="text-align:center;margin:24px 0">
      <img src="cid:qr@entry" alt="Your entry QR code" width="260" height="260"
           style="border:1px solid #eee;border-radius:12px;padding:8px"/>
    </p>
    <p style="color:#666;font-size:13px">See you there!</p>
  </div>`;
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
        subject: `Your entry QR code — ${config.eventName}`,
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

module.exports = { sendEmails, scanUrl };
