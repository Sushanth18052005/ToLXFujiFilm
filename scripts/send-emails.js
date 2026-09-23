'use strict';
// Email each attendee their personal QR code via SMTP.
// By default only emails people who haven't been emailed yet.
//
//   npm run send                 # only un-emailed attendees
//   npm run send -- --resend     # everyone with an email
//   npm run send -- --dry-run    # print who would be emailed, send nothing

const { pool } = require('../lib/db');
const { sendEmails } = require('../lib/mailer');

const RESEND = process.argv.includes('--resend');
const DRY = process.argv.includes('--dry-run');

(async () => {
  const res = await sendEmails({
    resend: RESEND,
    dryRun: DRY,
    onProgress: ({ sent, total }) => process.stdout.write(`\r  sent ${sent}/${total}`),
  });

  if (res.dryRun) {
    if (res.total === 0) {
      console.log('Nobody to email. (Use --resend to include people already emailed.)');
    } else {
      res.recipients.forEach((r) => console.log(`  would email: ${r.name} <${r.email}>`));
      console.log(`[dry run] ${res.total} recipient(s).`);
    }
    return;
  }
  if (res.total === 0) {
    console.log('Nobody to email. (Use --resend to email everyone again.)');
    return;
  }
  console.log(`\nDone. Sent ${res.sent}, failed ${res.failed}.`);
  (res.errors || []).forEach((e) => console.error(`  FAILED ${e.email}: ${e.error}`));
})()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
