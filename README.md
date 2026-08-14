# Course Governor — API & Deployment

Your prototype's UI is unchanged. What changed is where the data lives:
it used to sit in the browser tab (`window.storage`, which only works
inside a Claude artifact); it now lives in a real Postgres database
behind a small Express API, so the app works as a normal website anyone
can open.

## How it fits together

```
Browser (public/index.html)
   │
   │  fetch()
   ▼
Express API (src/server.js)
   │
   ▼
Postgres (src/db.js)
```

One Node service does two jobs: it serves the frontend file and it
answers the API. That's deliberate — one Render web service instead of
two, which is simpler to run and cheaper to host.

### The data model — one document, not many tables

Rather than splitting courses/students/attendance/etc. into separate
database tables, the whole class's data is stored as a single JSON
document in one Postgres row (a `jsonb` column). This was the pragmatic
call for a single-Governor MVP: it meant **zero changes** to your
existing 1,300-line frontend's rendering logic — it already worked
entirely off one in-memory `data` object, so the API just had to give
that object a real home.

**Trade-off to know about:** if you outgrow "one Governor running one
class register" — e.g. multiple governors, multiple classes on one
deployment, or you want the database itself to enforce things like "a
student can't be added twice" — you'd want to move to proper relational
tables (`courses`, `students`, `attendance_records`, etc). That's a
bigger rewrite touching the frontend too, so treat it as a "phase 2"
rather than something to do now.

### Auth model

- **Reading the class register is public** — no login. This matches how
  the app already worked (students browse freely) and is what lets a
  student open a check-in link with zero setup.
- **Writing requires the Governor password.** Set once as an environment
  variable (`GOVERNOR_PASSWORD`), never stored in the database. Signing
  in exchanges it for a 12-hour token.
- **Student self-check-in is a separate, narrow endpoint**
  (`POST /api/checkin/:code/signin`) that doesn't need the Governor
  token. It re-checks the session's time window and the code itself on
  the server every time — so even though it's open to anyone with the
  link, someone can't use it to rewrite anything except "mark this one
  student present, only while the window is open."
- **Concurrent-edit protection:** every save carries the version number
  the Governor last loaded. If two edits land at once, the second is
  rejected with the fresh data instead of silently overwriting the
  first — you'll rarely hit this with one Governor, but it's what a
  real save endpoint should do.

## Local setup

1. **Install Postgres** if you don't have it, and create a database:
   ```
   createdb classroom_governor
   ```
2. **Copy the env template and fill it in:**
   ```
   cp .env.example .env
   ```
   Generate a `JWT_SECRET`:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Set `GOVERNOR_PASSWORD` to whatever you want to type in as Governor.
3. **Install and run:**
   ```
   npm install
   npm start
   ```
4. Open `http://localhost:3000`. Click **Governor** in the top right —
   it'll ask for the password you set. Everything else works exactly
   like the prototype you already had.

## Deploying to Render

You have a Render account connected — here's the one-click path.

1. **Push this project to a GitHub repo.** Render deploys from git, not
   file upload:
   ```
   cd classroom-governor
   git init
   git add .
   git commit -m "Course Governor — API + deploy config"
   git branch -M main
   git remote add origin https://github.com/<you>/classroom-governor.git
   git push -u origin main
   ```
2. **In the Render dashboard:** New → Blueprint → pick this repo.
   Render reads `render.yaml` and provisions two things together:
   - A free Postgres database
   - A free web service running `npm install` then `npm start`

   `DATABASE_URL` is wired automatically. You'll be prompted to fill in
   one secret it can't generate for you: `GOVERNOR_PASSWORD`. `JWT_SECRET`
   is generated for you.
3. **Deploy.** First boot creates the database table automatically —
   nothing to run by hand.
4. Your app is live at the `.onrender.com` URL Render gives you. Share
   that URL (or a custom domain, which Render also supports) with
   lecturers and students; each attendance link you generate is a
   `#checkin=CODE` fragment on that same URL.

### Known limitations worth knowing before you rely on this

- **Free-tier Postgres on Render expires after 90 days** unless you
  upgrade to a paid plan — fine for testing this semester, not for
  something you want running unattended for years.
- **Free web services spin down when idle** and take a few seconds to
  wake on the next request — the first person to open the link after a
  quiet period will see a short delay.
- **File uploads for materials and course outlines are link/text-based,
  not binary storage** — this matches how your original prototype
  worked (paste the outline text, or link to a hosted file like Google
  Drive). If you want actual file uploads later, that's a real feature
  to scope separately (needs object storage like S3 or Cloudinary).
- **A single Governor password**, not individual lecturer accounts. Fine
  for one person running the register; if multiple lecturers need their
  own logins later, that's also a scoped follow-up.

## Project layout

```
classroom-governor/
├── package.json
├── render.yaml          ← Render Blueprint (web service + Postgres)
├── .env.example
├── src/
│   ├── server.js         ← Express app, routes, static file serving
│   ├── db.js              ← Postgres connection + state read/write
│   └── auth.js            ← Governor login + token verification
└── public/
    └── index.html         ← your existing frontend, now calling the API
```
