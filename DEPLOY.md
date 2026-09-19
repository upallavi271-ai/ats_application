# TeamLink ATS Backend — Deployment Runbook (Hostinger)

## 0. What you're deploying
A Node.js/Express API backed by PostgreSQL, implementing the RBAC schema you
already had (`migrations/001_rbac_core.sql` — your `rbac_schema.sql`, byte
for byte) plus the ATS extensions it needed (`migrations/002_ats_extensions.sql`
— jobs, clients, teams, invoices, and the real candidate stage machine).

Tested locally against a real Postgres 16 instance: migrations run clean,
login issues a real JWT, candidate/job/client/dashboard endpoints return
correctly scoped data, and the stage-transition guard rail blocks illegal
jumps (e.g. Applied → Selected) while allowing legal ones.

## 1. Buy the right plan
You need SSH access and the ability to run a persistent Node process, so:
- **Hostinger VPS** (any tier — KVM 1 is enough to start). NOT shared hosting
  — shared/cPanel plans generally can't run a long-lived Node process +
  PostgreSQL together reliably.
- Pick Ubuntu 22.04 or 24.04 as the OS image.

## 2. First login to the VPS
```bash
ssh root@<your-vps-ip>
apt update && apt upgrade -y
```

## 3. Install Node.js, PostgreSQL, and a process manager
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs postgresql postgresql-contrib nginx
npm install -g pm2
```

## 4. Create the database
```bash
su - postgres -c "psql -c \"CREATE USER teamlink WITH PASSWORD 'CHANGE_ME';\""
su - postgres -c "createdb -O teamlink teamlink_ats"
```

## 5. Upload this backend folder to the VPS
From your own machine:
```bash
scp -r teamlink-ats-backend root@<your-vps-ip>:/opt/teamlink-ats-backend
```

## 6. Configure environment
On the VPS:
```bash
cd /opt/teamlink-ats-backend
cp .env.example .env
nano .env
```
Set:
- `DATABASE_URL=postgresql://teamlink:CHANGE_ME@localhost:5432/teamlink_ats`
- `JWT_SECRET=` — generate one with `openssl rand -hex 32`, paste it in
- `CORS_ORIGIN=` — the exact origin your frontend will be served from
  (e.g. `https://ats.tmlink.cloud`)
- `NODE_ENV=production`

## 7. Install dependencies, migrate, seed
```bash
npm install --production
npm run migrate
npm run seed   # creates superadmin@teamlink.com / Teamlink@2026 — CHANGE THIS PASSWORD after first login
```

## 8. Run it under PM2 (keeps it alive, restarts on crash/reboot)
```bash
pm2 start server.js --name teamlink-ats-api
pm2 save
pm2 startup   # follow the printed instructions so it survives a reboot
```

## 9. Put nginx in front of it (so it's on 443, not a raw port)
`/etc/nginx/sites-available/teamlink-ats-api`:
```nginx
server {
    listen 80;
    server_name api.tmlink.cloud;
    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
```bash
ln -s /etc/nginx/sites-available/teamlink-ats-api /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx
certbot --nginx -d api.tmlink.cloud   # free HTTPS cert, auto-renews
```

## 10. Point your DNS
In Hostinger's DNS panel, add an A record: `api` → your VPS IP. Once it
resolves, `https://api.tmlink.cloud/health` should return `{"ok":true}`.

## 11. Sanity check from your own machine
```bash
curl https://api.tmlink.cloud/health
curl -X POST https://api.tmlink.cloud/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"superadmin@teamlink.com","password":"Teamlink@2026"}'
```
You should get back a JWT. **Log in once and change that password immediately**
(there's no "change password" endpoint yet — see Known Gaps below; for now,
update it directly: `UPDATE users SET password_hash = crypt(...)` or re-run
a small script with bcrypt).

---

## What's built vs. what's still needed

**Built and tested (this pass):**
- Auth (JWT login)
- RBAC exactly as your `rbac_schema.sql` defines it (`permissions` table,
  `get_visible_user_ids()` recursive scoping, roles/departments/modules)
- Candidates: list (filtered + scoped), create, stage transitions (with the
  same forward-only guard rail as the frontend), interview scheduling,
  feedback
- Jobs/Requirements: list, create, status changes
- Clients: list, and a "complete picture" endpoint per client
- Dashboard summary
- Users: list, create

**Not built yet — needed before this fully replaces the frontend's demo mode:**
- The frontend HTML is currently 100% localStorage — it does **not** call
  this API at all yet. Wiring it up (replacing `S.candidates = [...]` etc.
  with `fetch('/api/candidates')`) is a separate, substantial pass — the
  data shapes here were designed to be a close match, but the frontend's
  `BACKEND.online` flag and API-calling code need to actually be pointed at
  these routes and tested against them.
- Recruiter Workspace / Reports / Administration API endpoints (users list
  exists; permissions editing, audit log, IVR settings do not yet)
- File uploads (resumes, JD documents)
- Password reset / change-password endpoint
- Rate limiting, request logging, automated backups of the Postgres data

If you want, the next pass can wire the frontend to this API end-to-end —
that's the piece that actually turns "everyone can use it together" into
reality, since right now both the backend (just built) and frontend (built
earlier) are real but not yet talking to each other.
