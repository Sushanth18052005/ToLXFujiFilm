'use strict';
// Build an .xlsx workbook of all attendees for download from the admin dashboard.
// Mirrors the import format (Name, Email, then every extra registration column)
// and appends system columns — including "Added Manually", which flags people
// created in the dashboard (source='manual') rather than imported from a sheet.

const ExcelJS = require('exceljs');
const { query } = require('./db');

async function buildAttendeesWorkbook() {
  const { rows } = await query(
    `SELECT a.name, a.email, a.status, a.source, a.extra, a.regen_count,
       to_char(a.entered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS entered_at,
       to_char(a.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS created_at,
       to_char(a.regenerated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS regenerated_at,
       COALESCE((
         SELECT count(*) FROM audit_log l
          WHERE l.action = 'regenerate'
            AND a.email IS NOT NULL AND a.email <> ''
            AND lower(l.email) = lower(a.email)
       ), 0)::int AS regens_logged,
       COALESCE((
         SELECT count(*) FROM audit_log l
          WHERE l.action = 'delete'
            AND a.email IS NOT NULL AND a.email <> ''
            AND lower(l.email) = lower(a.email)
       ), 0)::int AS deletes_logged,
       COALESCE((
         SELECT count(*) FROM audit_log l
          WHERE l.action = 'delete' AND l.detail LIKE '%ENTERED%'
            AND a.email IS NOT NULL AND a.email <> ''
            AND lower(l.email) = lower(a.email)
       ), 0)::int AS deleted_after_entry
     FROM attendees a
     ORDER BY lower(a.name), a.id`
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
    { header: 'Regenerated (times)', key: 'regen_count', width: 18 },
    { header: 'Last Regenerated (IST)', key: 'regenerated_at', width: 22 },
    { header: 'Regens Logged (all-time)', key: 'regens_logged', width: 24 },
    { header: 'Times Deleted (all-time)', key: 'deletes_logged', width: 22 },
    { header: 'Deleted After Entry', key: 'deleted_after_entry', width: 18 },
    { header: '⚠ Review Flag', key: 'review', width: 30 },
  ];

  for (const { row: r, extra } of parsed) {
    // Seat-reuse review flag. Deleting an already-entered person is the strongest
    // signal (their entry was wiped and the seat freed); any prior delete on an
    // email that's present again means the person was re-added or re-imported after
    // deletion. Blank-email rows can't be correlated to the log, so they're never
    // flagged. This is a prompt to review, not proof — clear it if it was legit.
    const review = r.deleted_after_entry > 0
      ? '⚠ DELETED-AFTER-ENTRY (re-added)'
      : (r.deletes_logged > 0 ? '⚠ RE-ADDED AFTER DELETE' : '');
    const out = {
      name: r.name,
      email: r.email || '',
      manual: r.source === 'manual' ? 'Yes' : '',
      status: r.status,
      entered_at: r.entered_at || '',
      created_at: r.created_at || '',
      regen_count: r.regen_count || 0,
      regenerated_at: r.regenerated_at || '',
      regens_logged: r.regens_logged || 0,
      deletes_logged: r.deletes_logged || 0,
      deleted_after_entry: r.deleted_after_entry || 0,
      review,
    };
    extraKeys.forEach((k, i) => { out[`x${i}`] = extra[k] == null ? '' : String(extra[k]); });
    const added = ws.addRow(out);
    if (review) {
      const cell = added.getCell('review');
      cell.font = { bold: true, color: { argb: 'FF9A3412' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE4C4' } };
    }
  }

  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Second sheet: the append-only audit trail. Survives deletes, so it exposes
  // the delete+re-add loophole — a person's per-row "Regenerated (times)" resets
  // to 0 when they're removed and re-added, but every regenerate stays logged
  // here (and is counted per email in "Regens Logged (all-time)" on sheet 1).
  const { rows: auditRows } = await query(
    `SELECT action,
       to_char(at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS at,
       name, email, detail, ip
     FROM audit_log
     ORDER BY at DESC, id DESC`
  );

  const aws = wb.addWorksheet('Audit Log');
  aws.columns = [
    { header: 'Time (IST)', key: 'at', width: 20 },
    { header: 'Action', key: 'action', width: 14 },
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Detail', key: 'detail', width: 12 },
    { header: 'IP', key: 'ip', width: 18 },
  ];
  for (const r of auditRows) {
    aws.addRow({
      at: r.at || '',
      action: r.action || '',
      name: r.name || '',
      email: r.email || '',
      detail: r.detail || '',
      ip: r.ip || '',
    });
  }
  aws.getRow(1).font = { bold: true };
  aws.views = [{ state: 'frozen', ySplit: 1 }];

  return wb.xlsx.writeBuffer();
}

module.exports = { buildAttendeesWorkbook };
