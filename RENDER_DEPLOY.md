# Free Deployment — Render (API + Frontend, one service) + Neon (Postgres)

No credit card, no server admin. ~15 minutes.

**This backend now also serves the ATS frontend itself** (the file is
bundled at `public/index.html`) — the frontend's own code expects its API to
live at its own origin, so one Render URL serves both the app people open
in their browser AND the `/api/...` routes it calls. You do NOT need a
separate static-hosting step; deploying this one service is the whole
frontend + backend deployment.

## 1. Create the free database on Neon
1. Go to https://neon.tech → Sign up (GitHub/Google login is fine) → New Project.
2. Name it `teamlink-ats`, pick a region close to Hyderabad/Bengaluru
   (Singapore is usually closest).
3. Once created, Neon shows a **connection string** like:
   `postgresql://neondb_owner:xxxxx@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
   — copy it, you'll need it in step 4.
4. Open Neon's **SQL Editor** (left sidebar) — you'll run the migrations
   here in step 5, no local `psql` needed.

## 2. Put this backend code on GitHub
Render deploys from a Git repo, so:
1. Create a new **private** repo on https://github.com/new, e.g. `teamlink-ats`.
2. From this backend folder on your machine:
   ```bash
   git init
   git add .
   git commit -m "TeamLink ATS"
   git branch -M main
   git remote add origin https://github.com/<your-username>/teamlink-ats.git
   git push -u origin main
   ```
   (`.gitignore` already excludes `node_modules` and `.env` — your secrets
   won't be pushed.)

## 3. Deploy on Render
1. Go to https://render.com → sign up with GitHub → **New +** → **Blueprint**.
2. Connect the `teamlink-ats` repo. Render reads `render.yaml`
   (already in this folder) and shows one service: `teamlink-ats-api`.
3. It'll ask you to fill in the `sync: false` value:
   - `DATABASE_URL` → paste the Neon connection string from step 1.3.
   (`CORS_ORIGIN` can stay as-is. The frontend is served from this same
   service, so browser requests are same-origin and CORS never comes into
   play — it only matters if you later host the HTML somewhere else.)
4. Click **Apply** / **Deploy**. First deploy takes 2–3 minutes.
5. When it's live, Render gives you a URL like
   `https://teamlink-ats.onrender.com` — **that single URL is the app.**
   That's the link you send to your team.

*(If Render's UI doesn't offer "Blueprint" for your account, do it manually
instead: **New + → Web Service → connect the repo → Build command: `npm
install` → Start command: `node server.js`** — then add the same env vars
from `render.yaml` by hand in the dashboard's Environment tab.)*

## 4. Run the migrations (in Neon's SQL Editor)
Open these four files from this folder and run them **in order**, pasting
each into Neon's SQL Editor and clicking Run:
1. `migrations/001_rbac_core.sql`
2. `migrations/002_ats_extensions.sql`
3. `migrations/003_frontend_contract_alignment.sql`
4. `migrations/004_add_it_department.sql`
5. `migrations/005_notifications.sql`
6. `migrations/006_invoices_files_followups_portal.sql`
7. `migrations/007_portal_and_support_roles.sql`

Each should finish with no red errors (you'll see a stream of `CREATE
TABLE` / `INSERT` / `COMMIT` messages, same as when this was tested locally).

## 5. Seed the first login
You can't run `node seed.js` on Render's free tier via SSH (that needs a
paid plan), so run it **from your own machine**, pointed at Neon:
```bash
cd teamlink-ats
npm install
DATABASE_URL="<paste the Neon connection string>" DATABASE_SSL=true node seed.js
```
This creates `superadmin@teamlink.com` / `Teamlink@2026` and a small demo
record — **change that password after your first real login.**

## 6. Verify it's actually live and SHARED
1. Open `https://teamlink-ats.onrender.com` in your browser.
2. Log in with `superadmin@teamlink.com` / `Teamlink@2026` — **do not tick
   the Demo toggle.**
3. Top-right should show a green **LIVE** badge (not `LOCAL`). That badge is
   how you know it's talking to the real database, not this browser's
   localStorage.
4. The real test: open the app on two laptops, logged in as two different
   people. Add a candidate on one — it appears on the other **within a
   couple of seconds, with no refresh** (a WebSocket pushes the change and
   the other browser refetches). Stage changes, interviews and new
   requirements behave the same way.

First request after idle time will be slow (~30–50s — free tier spins the
service down after 15 minutes of no traffic and wakes it on the next
request). Every request after that is fast until it goes idle again.

## 7. Create logins for your team
Everyone needs their own account (don't share the superadmin login — the
RBAC scoping is per-user, so shared logins defeat the whole
Recruiter/TL/BDE visibility model). As Super Admin, go to
**Administration → Users & Roles → Invite user**, or insert them via the
API. Change the seeded superadmin password immediately.

---

## Portal logins (Client / Candidate)
Client and Candidate logins must be **linked to the record they represent**,
or their portal correctly refuses to show anything:

```sql
UPDATE users SET client_id = (SELECT client_id FROM clients WHERE name = 'Apollo Health Group')
WHERE email = 'hr@apollohealth.in';

UPDATE users SET candidate_email = 'anitha@example.com'
WHERE email = 'anitha@example.com';
```
These portals scope by that link, **not** by the reports_to hierarchy: a
client sees only their own requirements and only candidates actually shared
with them; a candidate sees only their own applications. Both are blocked
(403) from every staff endpoint - verified by test.

## Real-time notes
- Live updates ride a WebSocket at `/ws` on the same service — Render's free
  tier supports this, no extra config needed.
- If a laptop's connection drops (sleep, wifi change) the frontend
  auto-reconnects after ~4 seconds, and a 30-second server ping stops idle
  connections being killed by proxies.
- While Render's free service is asleep (15 min idle) nothing is pushed.
  The first person to open the app wakes it; after that everyone is live.

## Free-tier limits worth knowing
- **Render free web service**: sleeps after 15 min idle, ~750 hrs/month
  included (enough for one always-running small service), 512MB RAM.
- **Neon free tier**: 0.5 GB storage, database auto-suspends after 5 min
  idle too (wakes on next query, similar delay) — plenty for a pilot with
  your team, not a hard limit you'll hit early on.
- Neither charges you automatically when you exceed free limits — Render
  pauses/limits the service and Neon just won't let new data in past the
  storage cap, so there's no surprise bill.

When you outgrow these (real daily users, no tolerance for the cold-start
delay), moving to the paid Hostinger VPS path (see `DEPLOY.md`) is the same
codebase — no rebuild needed, just re-point `DATABASE_URL`.
