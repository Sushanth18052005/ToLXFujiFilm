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

module.exports = { db, newToken };
