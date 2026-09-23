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
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },

  required,
};

module.exports = config;
