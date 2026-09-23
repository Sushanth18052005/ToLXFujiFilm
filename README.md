# Workshop QR Entry System

Import registrations from Excel, email every attendee a unique QR code, and
verify entry at the door from any phone. Each QR checks a person in exactly
once — a second scan shows **Already Entered** and denies entry.

## How it works

1. **Import** the registration spreadsheet → each person gets a random,
   unguessable token stored in a local SQLite database.
2. **Email** each attendee their personal QR code (the QR encodes
   `BASE_URL/scan?t=<token>`).
3. At the entrance, staff open `/scan`, log in once, and point a phone camera
   at each QR. Valid codes are marked **Entered**; repeats are rejected.

The token is a 24-byte cryptographic random value — it is not derived from any
registration field, so it can't be guessed or forged. Marking entry is gated
behind a shared staff password, and the check-in write is atomic, so two
simultaneous scans of the same code can never both succeed.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env (see below)
npm run init-db
```

Edit `.env`:

- `BASE_URL` — the public HTTPS URL of the deployed site. **Must be HTTPS** or
  phone cameras will refuse to open the scan link and refuse camera access.
- `STAFF_PASSWORD` — what staff type to unlock the scanner.
- `SESSION_SECRET` — a long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
- `SMTP_*` / `MAIL_FROM` — your mail server (Gmail: use an App Password).

## Usage

```bash
npm run import -- ./data/registrations.xlsx   # load the spreadsheet
npm run qrs                                    # write PNGs to ./qrcodes (optional)
npm run send                                   # email everyone their QR
npm run send -- --dry-run                      # preview who would be emailed
npm run start                                  # run the entrance web app
```

The importer auto-detects a **Name** column and an **Email** column (any header
containing "name" / "email"). Every other column is preserved and shown to
staff on scan. Re-running the import updates existing people and keeps their
tokens (matched by email, or by name when there's no email).

## At the door

- `/scan` — live camera scanner (continuous). Green = entered, red = already
  entered / denied.
- `/admin` — live counts, search, and an **Undo** button to reverse an
  accidental check-in.

Staff can also just use their phone's native camera: scanning the QR opens the
scan URL directly, which verifies the code after a one-time staff login.

## Deployment notes

- Serve over **HTTPS** (Render, Railway, Fly, or Nginx/Caddy in front). Set
  `TRUST_PROXY=1` when behind a TLS-terminating proxy so secure cookies work.
- SQLite lives in `./data/entry.db`. Back it up (or use a persistent volume) so
  check-in state survives restarts.
- This is a single-instance app (in-process SQLite + login throttle). Run one
  instance; don't scale to multiple replicas without moving to a shared DB.

## Files

| Path | Purpose |
|------|---------|
| `scripts/import.js` | Excel → DB, assigns tokens |
| `scripts/generate-qrs.js` | Writes QR PNGs to `./qrcodes` |
| `scripts/send-emails.js` | Emails each attendee their QR |
| `server.js` | Entrance web app (scanner, verify API, dashboard) |
| `lib/db.js` | SQLite schema + token generator |
| `lib/session.js` | Staff login / signed cookie |
| `public/` | Scanner + dashboard front-end |
