'use strict';
// Build an .xlsx workbook of all attendees for download from the admin dashboard.
// Mirrors the import format (Name, Email, then every extra registration column)
// and appends system columns — including "Added Manually", which flags people
// created in the dashboard (source='manual') rather than imported from a sheet.

const ExcelJS = require('exceljs');
const { query } = require('./db');

async function buildAttendeesWorkbook() {
  const { rows } = await query(
    `SELECT name, email, status, source, extra,
       to_char(entered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS entered_at,
       to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS created_at
     FROM attendees
     ORDER BY lower(name), id`
  );

  // Union of extra keys (registration columns), in first-seen order.
  const extraKeys = [];
  const parsed = rows.map((r) => {
    let extra = {};
    try { extra = r.extra ? JSON.parse(r.extra) : {}; } catch { /* ignore bad JSON */ }
    for (const k of Object.keys(extra)) if (k && !extraKeys.includes(k)) extraKeys.push(k);
    return { row: r, extra };
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendees');
  ws.columns = [
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Email', key: 'email', width: 30 },
    ...extraKeys.map((k, i) => ({ header: k, key: `x${i}`, width: 18 })),
    { header: 'Added Manually', key: 'manual', width: 15 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Entered At (IST)', key: 'entered_at', width: 20 },
    { header: 'Registered At (IST)', key: 'created_at', width: 20 },
  ];

  for (const { row: r, extra } of parsed) {
    const out = {
      name: r.name,
      email: r.email || '',
      manual: r.source === 'manual' ? 'Yes' : '',
      status: r.status,
      entered_at: r.entered_at || '',
      created_at: r.created_at || '',
    };
    extraKeys.forEach((k, i) => { out[`x${i}`] = extra[k] == null ? '' : String(extra[k]); });
    ws.addRow(out);
  }

  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  return wb.xlsx.writeBuffer();
}

module.exports = { buildAttendeesWorkbook };
