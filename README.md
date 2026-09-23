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

## Deploying to Render

The server and your local machine must use the **same tokens**, or the QRs you
email won't verify at the door. The flow: prepare data locally, ship a seed file,
and let the deployed server load it on first boot.

**1. Prepare data locally** (once your real list is imported):

```bash
npm run export-seed     # writes data/seed.json + data/seed.b64.txt
```

Both files hold entry tokens and are **gitignored** — never commit them to a
public repo. You'll load them on the server via an env var in step 2.

**2. Create the service on Render:**

- Push this repo to GitHub, then in Render: **New + → Blueprint**, point it at the
  repo. `render.yaml` provisions a Node web service with a 1 GB persistent disk.
- Set the `sync: false` env vars in the dashboard: `STAFF_PASSWORD`, `EVENT_NAME`,
  and (after the first deploy gives you a URL) `BASE_URL` = `https://<name>.onrender.com`.
- Set **`SEED_DATA`** to the full contents of `data/seed.b64.txt`. On first boot the
  server decodes it and seeds the DB with the exact tokens from your machine.
  (Alternative, only if your repo is **private**: un-ignore `data/seed.json`, commit
  it, and skip `SEED_DATA` — the server falls back to the committed file.)
- Redeploy after setting `BASE_URL`. Entry status always starts fresh.

**3. Generate QRs / emails pointing at the live URL** (back on your machine):

```bash
BASE_URL=https://<name>.onrender.com npm run qrs      # or: npm run send
```

The tokens already match the server, so these QRs verify correctly at the door.

### Persistence — important

- The `disk:` block in `render.yaml` needs Render's **Starter plan ($7/mo)**. With
  it, the SQLite DB (and everyone's Entered status) survives restarts and
  redeploys. You can cancel after the event.
- On the **free plan** you must delete the `disk:` block and set `DB_FILE` back to
  the default. Then the filesystem is ephemeral: any restart wipes entry state
  (re-seeding everyone to "not entered"), and the service sleeps after 15 min idle
  (cold start on the first scan). Fine for testing, risky for a live door.
- Run a **single instance** (in-process SQLite). Don't scale to multiple replicas.
- To reload an updated attendee list after go-live, the DB is no longer empty so it
  won't auto-reseed — clear the disk's `entry.db` (or re-import) first.

## Files

| Path | Purpose |
|------|---------|
| `scripts/make-template.js` | Writes a blank registration template |
| `scripts/import.js` | Excel → DB, assigns tokens |
| `scripts/export-seed.js` | Dumps attendees+tokens to `data/seed.json` for deploy |
| `scripts/generate-qrs.js` | Writes QR PNGs to `./qrcodes` |
| `scripts/send-emails.js` | Emails each attendee their QR |
| `server.js` | Entrance web app (scanner, verify API, dashboard) |
| `lib/db.js` | SQLite schema, token generator, seed-on-boot |
| `lib/session.js` | Staff login / signed cookie |
| `render.yaml` | Render Blueprint (web service + persistent disk) |
| `public/` | Scanner + dashboard front-end |
