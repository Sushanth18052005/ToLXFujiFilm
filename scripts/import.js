'use strict';
// Import registrations from an Excel file into the DB, assigning each person a
// unique token. Idempotent: re-running updates existing people (matched by
// email, or by name when no email) and keeps their existing token.
//
//   npm run import -- [path/to/registrations.xlsx]

const fs = require('fs');
const ExcelJS = require('exceljs');
const config = require('../lib/config');
const { pool, query, ensureSchema, newToken } = require('../lib/db');

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

async function main() {
  if (!fs.existsSync(file)) {
    console.error(`Registration file not found: ${file}`);
    console.error('Put your spreadsheet there or pass a path: npm run import -- ./data/regs.xlsx');
    process.exit(1);
  }

  await ensureSchema();

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

  // One transaction on a dedicated connection so a mid-import failure rolls back.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
        const existing = await client.query(`SELECT id FROM attendees WHERE email = $1`, [email]);
        if (existing.rows[0]) {
          await client.query(`UPDATE attendees SET name = $1, extra = $2 WHERE id = $3`,
            [name, extraJson, existing.rows[0].id]);
          updated++;
        } else {
          await client.query(
            `INSERT INTO attendees (name, email, extra, token) VALUES ($1, $2, $3, $4)`,
            [name, email, extraJson, newToken()]
          );
          created++;
        }
      } else {
        const existing = await client.query(
          `SELECT id FROM attendees WHERE (email IS NULL OR email = '') AND lower(name) = lower($1)`,
          [name]
        );
        if (existing.rows[0]) {
          await client.query(`UPDATE attendees SET name = $1, extra = $2 WHERE id = $3`,
            [name, extraJson, existing.rows[0].id]);
          updated++;
        } else {
          await client.query(
            `INSERT INTO attendees (name, email, extra, token) VALUES ($1, $2, $3, $4)`,
            [name, null, extraJson, newToken()]
          );
          created++;
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await query('SELECT COUNT(*)::int AS c FROM attendees');
  console.log(`Import complete. Created ${created}, updated ${updated}, skipped ${skipped}.`);
  console.log(`Total attendees in DB: ${rows[0].c}.`);
  if (!emailCol) console.log('Note: no email column detected — emails cannot be sent for these rows.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
