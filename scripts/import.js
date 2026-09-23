'use strict';
// Import registrations from an Excel file into the DB, assigning each person a
// unique token. Idempotent: re-running updates existing people (matched by
// email, or by name when no email) and keeps their existing token.
//
//   npm run import -- [path/to/registrations.xlsx]

const fs = require('fs');
const config = require('../lib/config');
const { pool } = require('../lib/db');
const { runImport } = require('../lib/importer');

const file = process.argv[2] || config.registrationsFile;

(async () => {
  if (!fs.existsSync(file)) {
    console.error(`Registration file not found: ${file}`);
    console.error('Put your spreadsheet there or pass a path: npm run import -- ./data/regs.xlsx');
    process.exit(1);
  }

  const res = await runImport({ file });
  console.log(`Import complete. Created ${res.created}, updated ${res.updated}, skipped ${res.skipped}.`);
  console.log(`Total attendees in DB: ${res.total}.`);
  if (!res.emailColDetected) console.log('Note: no email column detected — emails cannot be sent for these rows.');
})()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
