'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

// Ensure the data directory exists before opening the DB file.
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS attendees (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    email        TEXT,
    extra        TEXT,                       -- JSON blob of any other spreadsheet columns
    token        TEXT    NOT NULL UNIQUE,    -- random unguessable secret embedded in the QR
    status       TEXT    NOT NULL DEFAULT 'registered',  -- 'registered' | 'entered'
    entered_at   TEXT,
    email_sent_at TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_email
    ON attendees(email) WHERE email IS NOT NULL AND email <> '';
  CREATE INDEX IF NOT EXISTS idx_attendees_status ON attendees(status);

  -- Audit log of every scan attempt (including rejected / duplicate ones).
  CREATE TABLE IF NOT EXISTS scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    attendee_id INTEGER REFERENCES attendees(id),
    token       TEXT,
    result      TEXT NOT NULL,   -- 'entered' | 'already' | 'invalid'
    ip          TEXT,
    at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function newToken() {
  // 24 random bytes -> 32-char URL-safe string. Not derivable from any
  // registration field, so it cannot be forged or guessed.
  return crypto.randomBytes(24).toString('base64url');
}

// On first boot with an empty table, seed attendees (with their tokens) from
// SEED_DATA (base64 JSON) or data/seed.json. This lets the deployed server
// share the exact tokens generated locally, without importing the Excel again.
// Entry status is intentionally NOT seeded, so it always starts as 'registered'.
function maybeSeed() {
  const count = db.prepare('SELECT COUNT(*) c FROM attendees').get().c;
  if (count > 0) return;

  let raw = null;
  let source = null;
  if (process.env.SEED_DATA) {
    raw = Buffer.from(process.env.SEED_DATA, 'base64').toString('utf8');
    source = 'SEED_DATA env';
  } else {
    const seedFile = path.join(__dirname, '..', 'data', 'seed.json');
    if (fs.existsSync(seedFile)) {
      raw = fs.readFileSync(seedFile, 'utf8');
      source = 'data/seed.json';
    }
  }
  if (!raw) return;

  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (err) {
    console.error('Seed data is not valid JSON — skipping seed.', err.message);
    return;
  }
  const ins = db.prepare(
    `INSERT OR IGNORE INTO attendees (name, email, extra, token) VALUES (@name, @email, @extra, @token)`
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r || !r.name || !r.token) continue;
      ins.run({ name: r.name, email: r.email || null, extra: r.extra || null, token: r.token });
    }
  });
  tx();
  const total = db.prepare('SELECT COUNT(*) c FROM attendees').get().c;
  console.log(`Seeded ${total} attendees from ${source}.`);
}

maybeSeed();

module.exports = { db, newToken };
