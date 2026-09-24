'use strict';
require('dotenv').config();

const path = require('path');

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env and fill it in)`);
  }
  return v;
}

// An action is "gated" (needs the organizer password) when its ALLOW_* flag is
// explicitly turned off. 1 / true / yes / on (or leaving it unset) = open;
// 0 / false / no / off = locked. Default is open so nothing breaks before the
// flags are configured — you opt into locking each action deliberately.
function gated(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

const config = {
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  port: parseInt(process.env.PORT || '3000', 10),
  trustProxy: process.env.TRUST_PROXY === '1',

  staffPassword: process.env.STAFF_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',

  // A second "organizer" password, separate from the staff login, that gates the
  // sensitive actions below. The per-action ALLOW_* flags decide which need it.
  // Fail-closed: if an action is locked but this is blank, that action is blocked.
  organizerPassword: process.env.ORGANIZER_PASSWORD || '',
  // true = that action is LOCKED behind organizerPassword; false = open with just
  // the staff login. See gated(): set the ALLOW_* env flag to 0 to lock an action.
  locks: {
    regen: gated('ALLOW_REGEN'),
    add: gated('ALLOW_ADD'),
    delete: gated('ALLOW_DELETE'),
    undo: gated('ALLOW_UNDO'),
  },

  registrationsFile: process.env.REGISTRATIONS_FILE || path.join(__dirname, '..', 'data', 'registrations.xlsx'),

  eventName: process.env.EVENT_NAME || 'Workshop',
  eventDate: process.env.EVENT_DATE || '26 September 2026',
  eventTime: process.env.EVENT_TIME || '12:00 PM – 5:00 PM',
  eventVenue: process.env.EVENT_VENUE || 'Sardar Vallabhbhai Patel Auditorium, KMIT',
  eventMapUrl: process.env.EVENT_MAP_URL || 'https://maps.app.goo.gl/QQPSdsV7T3WL6H4P9?g_st=ac',
  mailFrom: process.env.MAIL_FROM || process.env.BREVO_SENDER || '',
  // Email is sent via Brevo's transactional HTTP API (port 443). Render's free
  // tier blocks outbound SMTP, so Gmail/SMTP can't be used from there.
  brevo: {
    apiKey: process.env.BREVO_API_KEY || '',
    sender: process.env.BREVO_SENDER || '',
  },

  required,
};

module.exports = config;
