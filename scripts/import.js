'use strict';
// Import registrations from an Excel file into the DB, assigning each person a
// unique token. Idempotent: re-running updates existing people (matched by
// email, or by name when no email) and keeps their existing token.
//
//   npm run import -- [path/to/registrations.xlsx]

const fs = require('fs');
const ExcelJS = require('exceljs');
const config = require('../lib/config');
const { db, newToken } = require('../lib/db');

const file = process.argv[2] || config.registrationsFile;

function norm(s) {
  return String(s == null ? '' : s).trim();
}

// Pick the header cell whose text matches one of the given patterns.
function findColumn(headers, patterns) {
  for (const [idx, h] of headers) {
    const key = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (patterns.some((p) => p.test(key))) return idx;
  }
  return null;
}

const findByEmail = db.prepare(`SELECT id FROM attendees WHERE email = ?`);
const updateByEmail = db.prepare(`UPDATE attendees SET name = @name, extra = @extra WHERE id = @id`);
const findByName = db.prepare(
  `SELECT id FROM attendees WHERE (email IS NULL OR email = '') AND lower(name) = lower(?)`
);
const insertRow = db.prepare(
  `INSERT INTO attendees (name, email, extra, token) VALUES (@name, @email, @extra, @token)`
);
const updateNoEmail = db.prepare(`UPDATE attendees SET name = @name, extra = @extra WHERE id = @id`);

async function main() {
  if (!fs.existsSync(file)) {
    console.error(`Registration file not found: ${file}`);
    console.error('Put your spreadsheet there or pass a path: npm run import -- ./data/regs.xlsx');
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in the file.');

  // Build a map of column index -> header label from the first row.
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => headers.push([col, norm(cell.text || cell.value)]));

  const nameCol = findColumn(headers, [/^name$/, /fullname/, /firstname/, /attendee/]);
  const emailCol = findColumn(headers, [/email/, /mail/]);
  if (!nameCol) {
    throw new Error(`Could not find a "Name" column. Headers seen: ${headers.map((h) => h[1]).join(', ')}`);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const name = norm(row.getCell(nameCol).text || row.getCell(nameCol).value);
      if (!name) {
        skipped++;
        continue;
      }
      const email = emailCol ? norm(row.getCell(emailCol).text || row.getCell(emailCol).value).toLowerCase() : '';

      // Everything that isn't name/email is preserved as JSON in `extra`.
      const extra = {};
      for (const [idx, label] of headers) {
        if (idx === nameCol || idx === emailCol || !label) continue;
        const v = norm(row.getCell(idx).text || row.getCell(idx).value);
        if (v) extra[label] = v;
      }
      const extraJson = JSON.stringify(extra);

      if (email) {
        const existing = findByEmail.get(email);
        if (existing) {
          updateByEmail.run({ name, extra: extraJson, id: existing.id });
          updated++;
        } else {
          insertRow.run({ name, email, extra: extraJson, token: newToken() });
          created++;
        }
      } else {
        const existing = findByName.get(name);
        if (existing) {
          updateNoEmail.run({ name, extra: extraJson, id: existing.id });
          updated++;
        } else {
          insertRow.run({ name, email: null, extra: extraJson, token: newToken() });
          created++;
        }
      }
    }
  });
  run();

  const total = db.prepare('SELECT COUNT(*) c FROM attendees').get().c;
  console.log(`Import complete. Created ${created}, updated ${updated}, skipped ${skipped}.`);
  console.log(`Total attendees in DB: ${total}.`);
  if (!emailCol) console.log('Note: no email column detected — emails cannot be sent for these rows.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
