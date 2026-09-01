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

**Trade-off to know about:** the data model below (one JSON document per
stream) is still simpler than a fully relational schema, which is fine —
each stream's document is independent, so this doesn't need to change as
more streams are added. If a single stream's data outgrows "one JSON
blob" — e.g. you want the database itself to enforce things like "a
student can't be added twice" *within* that stream — you'd want proper
relational tables (`courses`, `students`, `attendance_records`, etc.) for
that stream's data specifically. That's a bigger rewrite touching the
frontend too, so treat it as a "phase 2" rather than something to do now.

### Multi-tenant streams

Each Governor runs their own independent **stream** — their own class,
with its own roster, courses, attendance, and materials. Streams are
fully walled off from each other, with no shared "admin" view across
them anywhere in the app (see `streams` table in `src/db.js`):

- **Any Governor can sign up and create their own stream**, self-serve —
  no invitation or operator setup needed. Signing up asks for a stream
  name, email, and password, and immediately returns a join code/link.
- **Students find their stream via that join code or link** — there's no
  directory of streams to browse. A join code resolves to exactly one
  stream (`GET /api/streams/by-code/:code`) and is what disambiguates
  which stream a student's matric number, signup, and login all belong
  to (the same matric number can exist independently in two different
  streams without conflict).
- **Nobody — including whoever runs this deployment — can list or read
  across streams through the ordinary Governor/student app.** Every
  data-bearing route resolves exactly one `streamId`, either from the
  caller's own signed token or from an explicit join code/id supplied by
  the caller, and every query is scoped to it. The one deliberate,
  logged exception is the separate admin backoffice described next.
- **Upgrading an existing single-tenant deployment:** `src/db.js` runs a
  one-time migration on boot that wraps any pre-existing class data into
  its own stream, so nothing is lost. See `GOVERNOR_EMAIL` /
  `GOVERNOR_PASSWORD` in `.env.example` — if either was already set for
  that deployment, the migration reuses it so the existing Governor can
  keep signing in the same way; otherwise the data is preserved but
  nobody can sign into it until you either set those and restart, or
  reassign it manually.

### Admin backoffice (separate service, separate URL)

A separate, minimal page (`public/admin.html`) for account recovery and
support — the situation that prompted it was getting locked out of a
Governor account with no way back in except raw SQL. It's the one place
that can see across every stream, so it's built deliberately narrow —
including running as its **own deployment**, not a path on the main
app's domain. `render.yaml` defines it as a second Render service,
`classroom-governor-admin`, sharing the same database as the main
`classroom-governor` service but nothing else — different URL, different
process, different environment variables. A path like `/admin` on the
main domain would still be reachable by anyone who guesses it, even
without a password; a separate service means the main app's domain has
no admin routes and no `admin.html` on it at all.

Same codebase, switched by one environment variable:

- **`ADMIN_ONLY=true`** is what makes `src/server.js` serve *only*
  `admin.html` and the `/api/admin/*` routes — set on the
  `classroom-governor-admin` service and nowhere else. Leave it unset
  (the default) for the main app.
- **`ADMIN_EMAIL`/`ADMIN_PASSWORD`** — the single hardcoded account, read
  straight from the environment on every login, never stored as a
  database row. Required whenever `ADMIN_ONLY=true`; the server refuses
  to boot without them, since there'd be no way to log in otherwise.
- **Its token lives in `sessionStorage`, not `localStorage`**, and expires
  after 4 hours — shorter than a Governor's 12-hour token — since this
  one can read every stream, not just one. It's also signed with its own
  `JWT_SECRET` (generated separately for this service in `render.yaml`),
  so it isn't interchangeable with a Governor/student token even if
  someone got hold of one.
- **Can do:** approve or reject a newly self-signed-up stream (see below),
  list all streams (name, join code, Governor email, status, student/
  course counts, last activity), view a stream's full class data
  read-only, reset a Governor's password, regenerate a join code, delete
  a stream entirely (with a type-the-name-to-confirm prompt — this is
  irreversible and cascades to that stream's roster, credentials, files,
  and saved chats).
- **Cannot do:** edit a stream's roster/attendance/materials content
  directly — that stays the Governor's own action, through their own
  account, on the main service. The backoffice can look, and can reset
  access, but doesn't reach in and change class data itself.

### Live class calls & recording

Voice/video calls run on Daily.co, embedded via their Prebuilt UI (a
plain `<iframe>` — no separate video SDK bundled into the app). This is
a deliberate build-vs-buy choice: running your own WebRTC signaling/SFU
infrastructure for this is a large, ongoing commitment, and Daily's
Prebuilt already ships the call UI (tiles, mute, screen share, and a
Record button for the room owner) rather than needing to hand-build one.

- **`POST /api/calls`** (Governor, approved stream only) creates a Daily
  room and a `call_rooms` row, and returns a meeting token for the
  Governor to join as room owner.
- **`POST /api/calls/:id/token`** issues a join token for anyone else in
  that same stream — Governor or student, checked by `req.streamId`
  matching the room's stream, same as everywhere else in this app.
- **Recording is started/stopped from inside the call** (the Record
  button Daily's Prebuilt UI shows to the owner when a room has
  `enable_recording: 'cloud'` set — see `src/daily.js`), not a separate
  API route here.
- **`POST /api/webhooks/daily`** is Daily's own notification channel —
  it tells this app when a recording starts, finishes, or fails, and
  that's how a `call_recordings` row gets created and later marked
  `ready`. Verified with an HMAC signature (`DAILY_WEBHOOK_SECRET`) so an
  arbitrary caller can't forge a "recording ready" event.
- **Recording files themselves stay on Daily's storage** — this app only
  ever stores a `daily_recording_id` pointer, fetching a fresh, temporary
  playback link from Daily's API on each request (`GET
  /api/recordings/:id/link`), since Daily's own download links expire
  after a few hours.
- **Written against Daily's documented API without a live account to
  test against.** The first real call with a real `DAILY_API_KEY` is the
  actual test — `src/daily.js` is the file to check first if something
  doesn't match Daily's current API shape.
- **Optional, like `GROQ_API_KEY`:** without `DAILY_API_KEY`/
  `DAILY_DOMAIN` set, the server still boots (with a console warning),
  and `/api/calls` routes fail with a clear error instead.
- **Consent:** both starting and joining a call show a plain confirmation
  ("this call may be recorded") before proceeding. This is a first pass,
  not a substitute for checking what a real consent notice needs to say
  for an institutional deployment.

### Approval gate on new streams

Self-serve signup means anyone can spin up a stream — which is the
point, but it also means new streams shouldn't get full run of the
platform unreviewed. Every stream now has a `status`:
`pending` → `approved` / `rejected`.

- A stream created via `governorSignup` starts `pending`. Every stream
  that already existed before this feature (including from before
  multi-tenancy) was automatically marked `approved` when the `status`
  column was added — nothing already running gets locked out.
- **While pending or rejected:** the Governor can still sign in, but sees
  a "waiting for approval" (or "not approved") screen instead of the
  dashboard. Every mutating route — saving class data, uploading files,
  managing the roster, checking in to attendance — is blocked server-side
  by `requireApprovedStream` in `src/server.js`, not just hidden in the
  UI. Students can't even resolve the join code for an unapproved stream,
  so they can't find it to sign up.
- **Approving/rejecting** happens from the admin backoffice — either
  inline from the stream list (pending streams show Approve/Reject
  buttons directly) or from a stream's detail page. Both actions are
  logged to `admin_audit_log` like everything else the backoffice does.
- A Governor's session doesn't know their status has changed until they
  check — the app re-checks automatically on page load and offers a
  "Check status" button on the waiting screen, via `GET /api/streams/me`.

  access, but doesn't reach in and change class data itself.
- **Every view and action is written to `admin_audit_log`** (action,
  which stream, when) — an append-only table nothing else in the app
  touches. This is what keeps "walled off, even from me" honest once an
  admin account exists at all: there's no way to look at or touch a
  stream through this door without it being recorded.

### Auth model

- **Reading a stream's class register is public** — no login. This
  matches how the app already worked (students browse freely) and is
  what lets a student open a check-in link with zero setup. It's still
  scoped to one stream at a time — either resolved from a signed-in
  token, or from an explicit stream id the caller already has (from a
  join link, or a saved session) — never all streams.
- **Writing requires signing in as that stream's Governor** — email +
  password, chosen at signup, never a shared operator-set password.
  Signing in exchanges it for a 12-hour token scoped to that Governor's
  own stream only.
- **Students have real accounts now.** A student resolves their stream's
  join code first, then signs up with their matric number, name, and a
  password of their choosing — this automatically adds (or claims, if
  the Governor already pre-loaded that matric number) their entry in
  that stream's roster. Their password is hashed and stored in a
  dedicated `student_credentials` table (keyed by stream + matric number,
  so the same matric number in two different streams never collides),
  kept completely separate from the main class data — so a Governor edit
  can never accidentally wipe anyone's password (see below).
- **Self-check-in requires being signed in**, and the server always uses
  the identity from the student's own token, never anything the client
  sends — so a student can only ever mark *themselves* present, never
  pick a classmate's name from a list the way the very first version of
  this app allowed.
- **Concurrent-edit protection:** every save carries the version number
  the Governor last loaded. If two edits land at once, the second is
  rejected with the fresh data instead of silently overwriting the
  first — you'll rarely hit this with one Governor, but it's what a
  real save endpoint should do.

### Why student passwords live in their own table

The whole class register — courses, roster, attendance, materials — is
one JSON document that the Governor's browser loads, edits, and saves
back in full. If a student's password lived inside that same document,
an ordinary Governor save (edit a course, add an assignment) would
overwrite it with whatever stale copy the Governor's browser happened to
have loaded — silently locking students out. Keeping credentials in
their own table (`student_credentials`, matric number → password hash)
means the Governor's saves never touch them at all.

### File uploads (materials, course outlines)

The Governor can upload files directly now (any type — PDF, DOCX, PPTX,
images, etc.) instead of only linking to something hosted elsewhere.
Uploaded files live in their own Postgres table too (`files`), for the
same reason credentials do: the main class document is fetched in full
on every page load — including the public check-in kiosk — so embedding
file bytes in it would mean everyone downloads every uploaded file just
to open the app. Keeping files in their own table means only someone who
actually clicks "Download" fetches that file's bytes.

- **Upload limit is 15MB per file** (set in `src/server.js`, search for
  `fileSize`) — comfortable for slide decks and PDFs, but raise it if you
  need to.
- **Files are stored as bytes in Postgres**, not a separate storage
  service like S3 — the simplest option that needed no new account or
  credentials. The trade-off: they count against your database's storage
  quota (Neon's free tier is 0.5GB). If you're uploading a lot of large
  files, that's the number to watch — Neon's dashboard shows current
  usage.
- **Deleting a material or course doesn't delete its uploaded file** —
  the file stays in the `files` table, just unreferenced. Harmless at
  small scale; if it matters later, that's a small cleanup job to add.

### AI study assistant ("Ask AI")

Students (and the Governor) can ask questions about a course and get
answers grounded in that course's outline and uploaded materials first,
falling back to general knowledge — clearly labeled as such — when the
materials don't cover it. Runs on Groq's API, which serves fast
open-weight models on a genuinely free, permanent tier (no credit card,
no expiration).

Needs one more environment variable:

```
GROQ_API_KEY=...
```

Get a free key from https://console.groq.com/keys — sign in with an
email or Google account, no billing setup required — and add it in
Render's Environment tab. Without it, the "Ask AI" tab still shows, but
every question returns a clear "not configured yet" message instead of
a server error.

**This app has already been through two providers and several model
names during setup** (Anthropic needed paid credit; a too-new Gemini
preview model hit tight limits; the next Gemini choice stopped being
reachable; Groq's own tutorial-standard model turned out to have been
shut down the day before this was wired up). Whichever provider ends up
behind this, treat the exact model name as something that will need
updating occasionally, not something to set once and forget — it's one
line in `src/assistant.js`, not a rebuild. If "Ask AI" ever fails, the
error message names exactly what's wrong:

- **A message mentioning a rate limit** → the provider's own free-tier
  cap was hit — wait a minute, it clears on its own. Not a bug.
- **A message naming the model directly** → that model is no longer
  reachable. Check https://console.groq.com/docs/models for a current
  name and update the `MODEL` constant.
- Anything else → check Render's Logs tab, search for "Groq API error",
  and the status code + message will be right there.

**On scaling to ~160 students — read this before relying on it for a
real class.** Groq's free tier gives 30 requests/minute, but only 6,000
*tokens* per minute, shared across every request the whole app makes —
not per student, the whole app. That ceiling is what this app's context
budget is now built around (kept small, ranked by relevance — see
below), but the ceiling itself doesn't move. In practice: light,
spread-out use across a class of 160 will generally work. A burst —
say, many students asking questions in the same few minutes right
before an exam — will hit the shared limit, and whoever's request
lands after the cap will get a clear "try again in a minute" message
rather than a broken one, but they will get that message. No free tier
from any provider is actually built for a synchronized burst at this
scale; that's the honest trade-off of "free," not a bug specific to
this app or to Groq. If that becomes a real problem once you have usage
data, the paths forward, roughly in order of effort:
1. **A few dollars/month in paid Groq credit** — removes the shared
   ceiling almost entirely; at this usage level the actual cost would be
   small.
2. **Route across multiple free providers** (Groq + Gemini + others) so
   one ceiling being hit doesn't stop the whole class — more moving
   parts, not a small change.
3. **Do nothing** — accept that free means occasional waits during
   bursts, which may be perfectly fine depending on how central this
   feature ends up being.

Google's free-tier terms (and most free LLM tiers generally, including
Groq's) allow your prompts to be used to improve their models — worth
knowing, though not unusual for a free API tier, and not something
course outlines and public readings are especially sensitive about.

**How grounding actually works, and its limits:**

- On first use, any uploaded PDF or DOCX file for that course has its
  text extracted and cached (in the `files` table, alongside the raw
  bytes) — the extraction only ever runs once per file, not on every
  question. Plain text/Markdown files are read directly. **PPTX slide
  decks and images aren't extracted** — they don't contribute to what the
  assistant knows, though they still work fine as regular downloadable
  materials. If you need those grounded too, extracting text from
  PowerPoint files is a contained addition to `src/textExtract.js`, not a
  rebuild.
- All the course's outline text and material text/notes are gathered and
  sent as context, capped at roughly 9,000 characters total
  (`MAX_CONTEXT_CHARS` in `src/assistant.js`) — small on purpose, sized
  to comfortably fit under Groq's shared 6,000-token-per-minute ceiling
  even when several requests land in the same minute. This is **not**
  true semantic search — it's simple keyword overlap, not an embeddings
  model that understands meaning. Before packing, materials are ranked
  by how many of the question's words appear in their title or text (a
  title match counts extra), so asking about something specific reliably
  pulls in the material actually named after it — the course outline
  always goes in first, regardless of relevance, since it's foundational
  context for every question. With a budget this tight, usually only the
  outline plus one or two materials fit per question; for a course with
  a large reading list, that means most materials never make it into any
  single answer's context, only whichever are most relevant to what was
  actually asked. The honest upgrade path here, if that becomes a real
  problem, is embeddings-based retrieval (understanding meaning, not
  just matching words, and not gated by a shared token-per-minute
  budget) — a real project on its own, not a small tweak.
- The system prompt instructs the model to lead with what's in the
  course materials and say plainly when something isn't covered, rather
  than silently guessing — but it's also allowed to fall back to general
  knowledge when asked, as long as it's clear about which is which. It's
  a strong instruction, not a hard technical guarantee — treat answers
  as a study aid, not an authoritative source, the same way you'd treat
  any AI tool.
- **Rate-limited** to 30 questions per hour per signed-in identity
  (`RATE_LIMIT_PER_HOUR` in `src/assistant.js`), tracked in memory. This
  guards against one person hammering the endpoint — it does **not**
  protect against Groq's own shared limit being hit by many different
  people at once (see the scaling note above; those are two different
  ceilings). It resets whenever the server restarts/redeploys, and
  wouldn't coordinate correctly if you ever ran more than one server
  instance. Both are fine at this app's scale.
- **Conversation history is saved as multiple, separate threads** — not
  one rolling chat that gets overwritten. Each "New chat" starts a fresh
  thread; a "History" button lists past ones by title (auto-set from the
  first question asked) and lets a student reopen or delete any of them.
  Threads are stored in `assistant_conversations`, scoped to the signed-in
  identity — nobody can read or list another person's saved conversations,
  including the Governor. An earlier, single-thread version of this used
  a table called `assistant_chats`; that table is left in place unused
  rather than dropped, so no data was lost in the switch.
- Only signed-in users (Governor or a registered student) can use it —
  unlike materials and outlines, this endpoint isn't public.

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
   Leave `GOVERNOR_EMAIL`/`GOVERNOR_PASSWORD` blank — those are only for
   migrating a pre-existing single-tenant database (see "Multi-tenant
   streams" above). You'll create your own stream from the app itself.
3. **Install and run:**
   ```
   npm install
   npm start
   ```
4. Open `http://localhost:3000`. Click **Sign in as Governor**, then
   **Create a stream** — give it a name, your email, and a password.
   You'll land in your new stream and get a join code to share with
   students. Everything else works exactly like the prototype you
   already had.

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
   Render reads `render.yaml` and provisions three things together:
   - A free Postgres database
   - The main app service (`classroom-governor`) — Governor + student UI
   - The admin backoffice service (`classroom-governor-admin`) — its own
     separate URL, sharing the same database, nothing else

   `DATABASE_URL` is wired automatically for both services, and each gets
   its own `JWT_SECRET` generated for you — no manual secrets needed to
   deploy the main app. (`GROQ_API_KEY` is optional, for the AI study
   assistant — add it to the main app's Environment tab whenever you're
   ready; without it that tab just shows a "not configured" message.) The
   admin service needs `ADMIN_EMAIL`/`ADMIN_PASSWORD` set by hand in its
   own Environment tab before you can sign into it — until then it's up
   but unusable, which is the safe default. If you don't need the
   backoffice yet, just ignore that service; it costs nothing extra to
   leave idle on Render's free tier.
3. **Deploy.** First boot creates the database tables automatically —
   nothing to run by hand.
4. Your app is live at the `.onrender.com` URL Render gives the
   `classroom-governor` service. Share that URL with anyone who wants to
   run their own class — they click **Sign in as Governor → Create a
   stream** and get their own isolated roster and a join code to hand
   out to students. Each attendance link you generate is a
   `#checkin=JOINCODE.CODE` fragment on that same URL. The admin
   backoffice lives at the *other* `.onrender.com` URL Render gives the
   `classroom-governor-admin` service — bookmark it separately; it's
   intentionally not linked from anywhere in the main app.

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
- **Signup is open** — anyone who knows (or guesses) a matric number
  format can create an account and appear on the roster, since there's
  no separate step where the Governor approves new signups. This matches
  how you described the feature (registering auto-adds someone to the
  roster), but it does mean a bad-faith actor could register a fake
  entry. If that becomes a real concern, the fix is an invite-only model
  — Governor pre-loads the real roster, and signup only succeeds for a
  matric number that's already there — which is a small change to
  `db.js`'s `studentSignup` function, not a rebuild.

## Project layout

### CGPA calculator

A self-service tool for students — Nigerian 5.0 scale (A=5, B=4, C=3,
D=2, F=0). Not connected to any actual grading system in this app (there
isn't one — this app tracks attendance, not grades), so it's entirely
self-reported: students type in their own grades per course per
semester. Saved per student in its own database table (`cgpa_records`),
same reasoning as chat history and credentials — a Governor's save
should never be able to touch a student's personal record.

Governors can optionally set a **credit units** number on each course
(in the course form) — when a student picks that course from the
dropdown while adding a semester entry, its name and units auto-fill,
though they can still type a custom course/units manually for anything
not in the system (a prior semester, a course from before this app
existed, etc).

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
