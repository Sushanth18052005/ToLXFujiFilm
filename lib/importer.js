'use strict';
// Shared import logic: read an Excel workbook (from a file path or an in-memory
// buffer) and upsert attendees into Postgres, assigning a token to new people.
// Used by both the CLI (scripts/import.js) and the web admin (POST /api/import).

const ExcelJS = require('exceljs');
const { pool, query, ensureSchema, newToken } = require('./db');

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

async function loadWorksheet({ buffer, file }) {
  const wb = new ExcelJS.Workbook();
  if (buffer) await wb.xlsx.load(buffer);
  else await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in the file.');
  return ws;
}

// Idempotent: re-running updates existing people (matched by email, or by name
// when no email) and keeps their existing token. Runs in one transaction so a
// mid-import failure rolls back cleanly.
async function runImport({ buffer, file }) {
  await ensureSchema();
  const ws = await loadWorksheet({ buffer, file });

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
          await client.query(`INSERT INTO attendees (name, email, extra, token) VALUES ($1, $2, $3, $4)`,
            [name, email, extraJson, newToken()]);
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
          await client.query(`INSERT INTO attendees (name, email, extra, token) VALUES ($1, $2, $3, $4)`,
            [name, null, extraJson, newToken()]);
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
  return { created, updated, skipped, total: rows[0].c, emailColDetected: !!emailCol };
}

module.exports = { runImport };
