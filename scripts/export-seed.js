'use strict';
// Export attendees (name, email, extra, token — NOT entry status) to
// data/seed.json. The deployed server loads this on first boot so it has the
// exact same tokens as your local DB — the QRs you generated/emailed will
// verify correctly at the door.
//
//   npm run export-seed   (then commit data/seed.json and deploy)

const fs = require('fs');
const path = require('path');
const { pool, query } = require('../lib/db');

const OUT = path.join(__dirname, '..', 'data', 'seed.json');
const B64 = path.join(__dirname, '..', 'data', 'seed.b64.txt');

async function main() {
  const { rows } = await query('SELECT name, email, extra, token FROM attendees ORDER BY id');

  if (rows.length === 0) {
    console.error('No attendees in the DB. Run "npm run import" first.');
    process.exit(1);
  }

  const json = JSON.stringify(rows, null, 2);
  fs.writeFileSync(OUT, json);
  fs.writeFileSync(B64, Buffer.from(json, 'utf8').toString('base64'));
  console.log(`Wrote ${rows.length} attendees to ${OUT}`);
  console.log('');
  console.log('These files contain entry tokens — they are gitignored. Do NOT commit them');
  console.log('to a public repo. Load them on the server one of two ways:');
  console.log('  • Recommended: set the SEED_DATA env var in Render to the contents of');
  console.log('    data/seed.b64.txt (base64). Nothing secret goes into git.');
  console.log('  • Or, only if your repo is PRIVATE: un-ignore and commit data/seed.json.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
