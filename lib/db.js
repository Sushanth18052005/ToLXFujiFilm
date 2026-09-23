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

