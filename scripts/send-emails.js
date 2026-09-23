'use strict';
// Email each attendee their personal QR code via SMTP.
// By default only emails people who haven't been emailed yet.
//
//   npm run send                 # only un-emailed attendees
//   npm run send -- --resend     # everyone with an email
//   npm run send -- --dry-run    # print who would be emailed, send nothing

const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const config = require('../lib/config');
const { pool, query } = require('../lib/db');
const { scanUrl } = require('./generate-qrs');

const RESEND = process.argv.includes('--resend');
const DRY = process.argv.includes('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function html(name) {
  return `
  <div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:auto;color:#111">
    <h2 style="margin:0 0 8px">${config.eventName}</h2>
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function main() {
  const where = RESEND
    ? `email IS NOT NULL AND email <> ''`
    : `email IS NOT NULL AND email <> '' AND email_sent_at IS NULL`;
  const { rows } = await query(`SELECT id, name, email, token FROM attendees WHERE ${where} ORDER BY id`);

  if (rows.length === 0) {
    console.log('Nobody to email. (Use --resend to email everyone again.)');
    return;
  }
  console.log(`${DRY ? '[dry run] ' : ''}Emailing ${rows.length} attendee(s)...`);

  let transporter = null;
  if (!DRY) {
    if (!config.smtp.host) throw new Error('SMTP_HOST is not set. Fill in the SMTP_* vars in .env.');
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
    await transporter.verify();
  }

  let sent = 0;
  let failed = 0;

  for (const a of rows) {
    if (DRY) {
      console.log(`  would email: ${a.name} <${a.email}>`);
      continue;
    }
    try {
      const png = await QRCode.toBuffer(scanUrl(a.token), { errorCorrectionLevel: 'M', margin: 2, width: 512 });
      await transporter.sendMail({
        from: config.mailFrom,
        to: a.email,
        subject: `Your entry QR code — ${config.eventName}`,
        html: html(a.name),
        attachments: [
          { filename: 'entry-qr.png', content: png, cid: 'qr@entry' },
        ],
      });
      await query(`UPDATE attendees SET email_sent_at = now() WHERE id = $1`, [a.id]);
      sent++;
      process.stdout.write(`\r  sent ${sent}/${rows.length}`);
      await sleep(250); // be gentle with the SMTP server
    } catch (err) {
      failed++;
      console.error(`\n  FAILED ${a.email}: ${err.message}`);
    }
  }
  console.log(`\nDone. Sent ${sent}, failed ${failed}.`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
