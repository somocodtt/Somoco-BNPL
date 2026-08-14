# Somo BNPL — Server Installation

A small Node.js/Express server that hosts Somo BNPL and shares one data store
across everyone who visits it — applicants, Verification Officer, BSM, AGM,
CFO, MD, and Admin can all be on different computers and see the same
applications and loan records.

## What's inside

```
somo-bnpl-server/
├── server.js            Express app: serves the frontend + a tiny storage API
├── package.json
├── public/
│   └── index.html        The whole application (UI + logic) — talks to /api/storage
├── data/
│   └── store.json         All system data lives here, as one JSON file
├── Dockerfile
└── docker-compose.yml
```

Data model: everything is stored under simple string keys (e.g.
`application:SOMO-APP-2026-XXXXX`, `vehicle-list`, `team-accounts`,
`brand-logo`, etc.) in `data/store.json`. There's no database server to
install — this keeps setup to "install Node, run one command" — but it does
mean:
- only run **one** server process against a given `data/store.json` at a time
- **back up `data/store.json` regularly** — it is the entire system's data
  (applications, documents metadata, staff accounts, vehicle prices, the logo)
- if you outgrow this (heavy concurrent use, need for real backups/replication,
  audit querying), swap `loadStore()`/`saveStore()` in `server.js` for a real
  database (Postgres, MySQL, etc.) — the API shape the frontend expects
  (`GET/POST/DELETE /api/storage/:key`, `GET /api/storage?prefix=`) stays the
  same either way.

## Running it locally (development / testing)

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
cd somo-bnpl-server
npm install
npm start
```

Open http://localhost:3000. That's it — the server serves the frontend and
the storage API from the same process.

Change the port with an environment variable if 3000 is taken:
```bash
PORT=8080 npm start
```

## Running it with Docker (recommended for a real server)

```bash
cd somo-bnpl-server
docker compose up -d --build
```

This builds the image, starts the container, and mounts `./data` on the host
into the container so your data survives container restarts/upgrades. Visit
`http://<your-server-address>:3000`.

To update after changing the app: `docker compose up -d --build` again.

## Running it without Docker on a Linux server (systemd)

1. Copy this folder to the server, e.g. `/opt/somo-bnpl`.
2. Install dependencies: `cd /opt/somo-bnpl && npm install --omit=dev`
3. Create a system user to run it (don't run as root):
   ```bash
   sudo useradd -r -s /bin/false somobnpl
   sudo chown -R somobnpl:somobnpl /opt/somo-bnpl
   ```
4. Create `/etc/systemd/system/somo-bnpl.service`:
   ```ini
   [Unit]
   Description=Somo BNPL server
   After=network.target

   [Service]
   Type=simple
   User=somobnpl
   WorkingDirectory=/opt/somo-bnpl
   Environment=PORT=3000
   ExecStart=/usr/bin/node server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```
5. Enable and start it:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now somo-bnpl
   sudo systemctl status somo-bnpl
   ```

### Putting it behind Nginx with HTTPS

Keep Node listening only on `localhost:3000` and let Nginx handle the public
side and TLS:

```nginx
server {
    listen 80;
    server_name bnpl.yourcompany.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then get a free certificate and auto-configure HTTPS with
[Certbot](https://certbot.eff.org/):
```bash
sudo certbot --nginx -d bnpl.yourcompany.com
```

## Backups

The entire system's state is one file: `data/store.json`. A simple daily cron
job is enough for most cases:
```bash
0 2 * * * cp /opt/somo-bnpl/data/store.json /opt/somo-bnpl/backups/store-$(date +\%F).json
```
Keep backups off the same server if possible.

## Security notes (read before real use)

- **Staff sign-in is a demo, not real security.** Passcodes are stored in
  plain text in `data/store.json`. Anyone who can read that file, or who can
  guess a 4–6 digit passcode, can act as any staff role. For real deployments,
  put this behind proper authentication (e.g. an SSO/reverse-proxy auth layer,
  or replace the sign-in flow with real hashed-password/session-based auth)
  before handling genuine customer data.
- The default seeded account is **System Admin / 0000** — remove it and
  create your own Admin account with a private passcode immediately after
  first deploying.
- There's no HTTPS built into `server.js` itself — always run it behind a
  reverse proxy (Nginx/Caddy) with a real TLS certificate for anything beyond
  local testing, since applicant Ghana Card numbers, phone numbers, and
  coordinates would otherwise travel in plain text.
- "Send report" and "send to MD" open the visiting device's own email client
  (`mailto:`) rather than sending mail from the server — there's no SMTP
  integration here. For automatic delivery, wire `server.js` up to an email
  API (e.g. SendGrid, SES, Postmark) and add a `/api/send-report` endpoint
  that the frontend can call instead.
- There's no real Ghana Card/NIA verification, credit bureau check, or actual
  file storage of uploaded documents (only filename/size/type are recorded) —
  this system handles workflow and record-keeping, not identity verification.
