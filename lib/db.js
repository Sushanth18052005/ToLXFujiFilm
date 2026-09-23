'use strict';

const fs = require('fs');
const path = require('path');
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

// PLACEHOLDER_INIT_SEED

// Create the schema (idempotent). Safe to call from any script that needs the
// tables to exist before it runs.
async function ensureSchema() {
  await pool.query(SCHEMA);
  return pool;
}

// Create the schema (idempotent) and seed if empty. Call once at startup.
async function init() {
  await ensureSchema();
  await maybeSeed();
  return pool;
}

// Optional fallback seeding for the file-based workflow: if the table is empty
// and SEED_DATA (base64 JSON) or data/seed.json is present, load it. When you
// import directly into a shared DB (e.g. Neon) this never triggers.
async function maybeSeed() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM attendees');
  if (rows[0].c > 0) return;

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

  let seedRows;
  try {
    seedRows = JSON.parse(raw);
  } catch (err) {
    console.error('Seed data is not valid JSON — skipping seed.', err.message);
    return;
  }
  for (const r of seedRows) {
    if (!r || !r.name || !r.token) continue;
    await pool.query(
      `INSERT INTO attendees (name, email, extra, token) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO NOTHING`,
      [r.name, r.email || null, r.extra || null, r.token]
    );
  }
  const { rows: after } = await pool.query('SELECT COUNT(*)::int AS c FROM attendees');
  console.log(`Seeded ${after[0].c} attendees from ${source}.`);
}

// Thin query helper.
const query = (text, params) => pool.query(text, params);

module.exports = { pool, query, init, ensureSchema, newToken };

