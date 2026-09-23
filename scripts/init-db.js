'use strict';
// Creates the Postgres schema (idempotent) and seeds if empty. Run once before importing.
const { init, pool } = require('../lib/db');

init()
  .then(() => {
    console.log('Database initialized.');
    return pool.end();
  })
  .catch(async (err) => {
    console.error('Failed to initialize database:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
