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
- **Students have real accounts now.** A student signs up with their
  matric number, name, and a password of their choosing — this
  automatically adds (or claims, if the Governor already pre-loaded that
  matric number) their entry in the class roster. Their password is
  hashed and stored in a dedicated `student_credentials` table, kept
  completely separate from the main class data — so a Governor edit can
  never accidentally wipe anyone's password (see below).
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
answers grounded only in that course's outline and uploaded materials —
not the model's general knowledge. Runs on Google's Gemini API rather
than a paid provider, specifically because Gemini has a genuinely free,
permanent tier (no credit card, no expiration) suitable for a classroom's
usage level — unlike most alternatives, which only offer a small one-time
trial credit.

Needs one more environment variable:

```
GEMINI_API_KEY=...
```

Get a free key from https://aistudio.google.com/apikey — sign in with a
Google account, no billing setup required — and add it in Render's
Environment tab. Without it, the "Ask AI" tab still shows, but every
question returns a clear "not configured yet" message instead of a
server error.

**On the free tier's limits:** roughly 1,000+ requests/day and single-
digit requests/minute on the Flash model this uses, which comfortably
covers normal classroom use. Google's free-tier terms also allow your
prompts to be used to improve their models — worth knowing, though not
unusual for a free API tier, and not something course outlines and
public readings are especially sensitive about. If Google ever renames
or retires the specific model this points at, update the `MODEL`
constant at the top of `src/assistant.js` — one line, not a rebuild.

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
  sent to Claude as one block of context, capped at roughly 40,000
  characters total (`MAX_CONTEXT_CHARS` in `src/assistant.js`). This is
  **not** a smart retrieval system — it doesn't search for the most
  relevant passage, it just includes everything in order (outline first,
  then materials) until the budget runs out, truncating whatever's left
  over. For a normal course's worth of readings this comfortably fits;
  if a course accumulates a large library of long documents, older or
  later-added materials may get cut. The honest upgrade path here, if it
  becomes a real problem, is embeddings-based retrieval (find just the
  relevant paragraphs instead of sending everything) — a real project on
  its own, not a small tweak.
- The system prompt instructs Claude to answer only from what's
  provided and to say plainly when something isn't covered, rather than
  filling gaps from its own training. It's a strong instruction, not a
  hard technical guarantee — treat answers as a study aid, not an
  authoritative source, the same way you'd treat any AI tool.
- **Rate-limited** to 30 questions per hour per signed-in identity
  (`RATE_LIMIT_PER_HOUR` in `src/assistant.js`), tracked in memory. This
  exists purely to stop one runaway account from generating a large
  Anthropic API bill — it resets whenever the server restarts/redeploys,
  and wouldn't coordinate correctly if you ever ran more than one server
  instance. Both are fine at this app's scale.
- Only signed-in users (Governor or a registered student) can use it —
  unlike materials and outlines, this endpoint isn't public, specifically
  because every question costs real money in API usage.

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
