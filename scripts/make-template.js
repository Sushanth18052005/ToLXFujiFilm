'use strict';
// Generates a styled, ready-to-fill registration template at
//   data/registrations-template.xlsx
// Fill it in (or paste your existing data under the headers), delete the
// example rows, then: npm run import -- ./data/registrations-template.xlsx

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const OUT = path.join(__dirname, '..', 'data', 'registrations-template.xlsx');

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Registrations');

  // Column A (Name) and B (Email) are the two the importer looks for.
  // Everything else is optional and gets shown to staff on scan.
  ws.columns = [
    { header: 'Full Name', key: 'name', width: 26 },
    { header: 'Email Address', key: 'email', width: 30 },
    { header: 'Ticket Type', key: 'ticket', width: 16 },
    { header: 'Organization', key: 'org', width: 26 },
    { header: 'Phone', key: 'phone', width: 18 },
  ];

  // Style the header row.
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // A couple of clearly-labelled example rows to delete before importing.
  const examples = [
    { name: 'EXAMPLE — delete this row', email: 'example1@email.com', ticket: 'Standard', org: 'Acme Inc', phone: '555-0100' },
    { name: 'EXAMPLE — delete this row', email: 'example2@email.com', ticket: 'VIP', org: 'Globex', phone: '555-0111' },
  ];
  examples.forEach((e) => {
    const row = ws.addRow(e);
    row.font = { italic: true, color: { argb: 'FF999999' } };
  });

  await wb.xlsx.writeFile(OUT);
  console.log(`Template written to ${OUT}`);
  console.log('Fill it in, delete the two EXAMPLE rows, then:');
  console.log('  npm run import -- ./data/registrations-template.xlsx');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
