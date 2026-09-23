'use strict';
// Generate a QR PNG for every attendee into the qrcodes/ folder.
// Each QR encodes:  <BASE_URL>/scan?t=<token>
//
//   npm run qrs

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const config = require('../lib/config');
const { pool, query } = require('../lib/db');

function safeName(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'attendee';
}

function scanUrl(token) {
  return `${config.baseUrl}/scan?t=${encodeURIComponent(token)}`;
}

async function main() {
  fs.mkdirSync(config.qrDir, { recursive: true });
  const { rows } = await query('SELECT id, name, token FROM attendees ORDER BY id');
  if (rows.length === 0) {
    console.log('No attendees found. Run "npm run import" first.');
    return;
  }

  let n = 0;
  for (const a of rows) {
    const file = path.join(config.qrDir, `${a.id}_${safeName(a.name)}.png`);
    await QRCode.toFile(file, scanUrl(a.token), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
    });
    n++;
  }
  console.log(`Generated ${n} QR code(s) in ${config.qrDir}`);
  if (config.baseUrl.startsWith('http://') && !config.baseUrl.includes('localhost')) {
    console.log('WARNING: BASE_URL is not https — phone cameras may refuse to open the link.');
  }
}

// Only run when invoked directly (not when required by send-emails.js for scanUrl).
if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { scanUrl, safeName };
