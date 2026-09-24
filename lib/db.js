'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('./config');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Put your Neon (Postgres) connection string in .env');
}

// Neon and most hosted Postgres require TLS; a local Postgres usually doesn't.
const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com|render\.com/.test(connectionString)
  || process.env.PGSSL === 'require';

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
});
pool.on('error', (err) => console.error('Unexpected Postgres pool error:', err.message));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS attendees (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT,
    extra         TEXT,                       -- JSON blob of any other spreadsheet columns
    token         TEXT NOT NULL UNIQUE,       -- random unguessable secret embedded in the QR
    status        TEXT NOT NULL DEFAULT 'registered',  -- 'registered' | 'entered'
    entered_at    TIMESTAMPTZ,
    email_sent_at TIMESTAMPTZ,
    source        TEXT NOT NULL DEFAULT 'import',       -- 'import' (spreadsheet) | 'manual' (added in dashboard)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_email
    ON attendees (email) WHERE email IS NOT NULL AND email <> '';
  CREATE INDEX IF NOT EXISTS idx_attendees_status ON attendees (status);

  CREATE TABLE IF NOT EXISTS scans (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    attendee_id BIGINT REFERENCES attendees(id),
    token       TEXT,
    result      TEXT NOT NULL,   -- 'entered' | 'already' | 'invalid'
    ip          TEXT,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Upgrade databases created before the source column existed (no-op otherwise).
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'import';

  -- Track whether someone was emailed more than once (a "resend"). Only reflects
  -- resends performed after this column exists; pre-existing emails count as a
  -- first send (resent = false).
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS resent BOOLEAN NOT NULL DEFAULT false;

  -- QR regeneration audit on the row: how many times a fresh code was issued and
  -- when it last happened. (The append-only audit_log below is the tamper-evident
  -- record; this counter is the convenient per-row number shown in the export.)
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS regen_count INT NOT NULL DEFAULT 0;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS regenerated_at TIMESTAMPTZ;

  -- Append-only log of sensitive staff actions (regenerate / add / delete / undo).
  -- Intentionally has NO foreign key to attendees: it must SURVIVE deletes, so a
  -- staff member can't erase the trail by deleting + re-adding a person. name and
  -- email are denormalized copies captured at action time.
  CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action      TEXT NOT NULL,   -- 'regenerate' | 'add' | 'delete' | 'undo'
    attendee_id BIGINT,          -- may reference a now-deleted attendee
    name        TEXT,
    email       TEXT,
    detail      TEXT,            -- free note, e.g. 'single' | 'bulk'
    ip          TEXT,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_email ON audit_log (lower(email));
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
`;

function newToken() {
  // 24 random bytes -> 32-char URL-safe string. Not derivable from any
  // registration field, so it cannot be forged or guessed.
  return crypto.randomBytes(24).toString('base64url');
}

// Create the schema (idempotent). Safe to call from any script that needs the
// tables to exist before it runs.
async function ensureSchema() {
  await pool.query(SCHEMA);
  return pool;
}

// Create the schema (idempotent). Call once at startup.
async function init() {
  await ensureSchema();
  return pool;
}

// Thin query helper.
const query = (text, params) => pool.query(text, params);

module.exports = { pool, query, init, ensureSchema, newToken };

