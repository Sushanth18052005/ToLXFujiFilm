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

const config = {
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  port: parseInt(process.env.PORT || '3000', 10),
  trustProxy: process.env.TRUST_PROXY === '1',

  staffPassword: process.env.STAFF_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',

  registrationsFile: process.env.REGISTRATIONS_FILE || path.join(__dirname, '..', 'data', 'registrations.xlsx'),
  qrDir: process.env.QR_DIR || path.join(__dirname, '..', 'qrcodes'),

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
