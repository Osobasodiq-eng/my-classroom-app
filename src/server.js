require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const db = require('./db');
const {
  governorSignup, login, requireGovernor, resolveJoinCode,
  studentSignup, studentLogin, requireStudent, resetStudentPassword, requireAnyAuth,
} = require('./auth');
const { askAssistant, listConversations, getConversationHandler, deleteConversationHandler } = require('./assistant');

// Files are held in memory only long enough to write them to Postgres —
// nothing is written to local disk, which matters on Render's free tier
// where disk contents don't persist between deploys anyway.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB cap

// GOVERNOR_PASSWORD is no longer required — Governors now sign themselves
// up with their own email/password instead of sharing one operator-set
// password. It's still read (optionally) by the one-time migration in
// db.js, to keep a pre-existing single-tenant deployment's Governor able
// to sign in after upgrading.
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill these in (see README.md).');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Every stream is fully walled off from every other — including from
// whoever runs this server. There is deliberately no "list all streams"
// or "read any stream's data" route anywhere in this file: the only way
// in is a Governor's own email/password, or a student's own join
// code + account. That's true for every route below, not just the ones
// that say so explicitly.

// Resolves which stream a request belongs to when there's no Governor/
// student token yet — used only by the public, pre-login parts of the
// app (the check-in kiosk, and the "what class is this join code for?"
// screen before a student has signed up or in). The stream id must be
// supplied explicitly by the caller (as a query param); nothing here
// scans across streams or infers one from a partial hint.
function resolveStreamOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.streamId) {
        req.streamId = payload.streamId;
        return next();
      }
    } catch (err) {
      // fall through to the query-param path below
    }
  }
  const stream = String(req.query.stream || '').trim();
  if (!stream) {
    return res.status(400).json({ error: 'Missing stream — sign in, or open this page via your class join link.' });
  }
  req.streamId = stream;
  next();
}

// ---------- API ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/governor-signup', governorSignup);
app.post('/api/auth/login', login);
app.get('/api/streams/by-code/:code', resolveJoinCode);
app.post('/api/auth/student-signup', studentSignup);
app.post('/api/auth/student-login', studentLogin);
app.post('/api/students/:studentId/reset-password', requireGovernor, resetStudentPassword);
app.delete('/api/students/:studentId', requireGovernor, async (req, res) => {
  try {
    const result = await db.removeStudent(req.streamId, req.params.studentId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove the student — try again.' });
  }
});
app.delete('/api/matric/:matric', requireGovernor, async (req, res) => {
  try {
    const freed = await db.releaseMatric(req.streamId, req.params.matric);
    res.json({ ok: true, freed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not release that matric number — try again.' });
  }
});
app.post('/api/assistant/ask', requireAnyAuth, askAssistant);
app.get('/api/assistant/conversations', requireAnyAuth, listConversations);
app.get('/api/assistant/conversations/:id', requireAnyAuth, getConversationHandler);
app.delete('/api/assistant/conversations/:id', requireAnyAuth, deleteConversationHandler);

// A student's own self-reported CGPA record — theirs to read and write,
// nobody else's. requireStudent (not requireAnyAuth) since this has no
// meaningful Governor use case the way the study assistant does.
app.get('/api/cgpa', requireStudent, async (req, res) => {
  try {
    const semesters = await db.getCgpaRecord(req.auth.studentId);
    res.json({ semesters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your CGPA record.' });
  }
});
app.put('/api/cgpa', requireStudent, async (req, res) => {
  const { semesters } = req.body || {};
  if (!Array.isArray(semesters)) return res.status(400).json({ error: 'Malformed request.' });
  try {
    await db.saveCgpaRecord(req.streamId, req.auth.studentId, semesters);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save your CGPA record.' });
  }
});

// Reading a stream's class register stays technically unauthenticated at
// the API level (mirrors a physical noticeboard, and the check-in kiosk
// depends on it) — but it's now scoped to exactly one stream, resolved
// either from a signed-in token or from an explicit ?stream= id the
// front end already knows (from a join link or a saved session). There's
// no way to enumerate or discover other streams from this endpoint.
app.get('/api/state', resolveStreamOptional, async (req, res) => {
  try {
    await db.finalizeExpiredSessions(req.streamId);
    const { data, version } = await db.getState(req.streamId);
    res.json({ data, version });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load class data.' });
  }
});

app.put('/api/state', requireGovernor, async (req, res) => {
  const { data, version } = req.body || {};
  if (typeof version !== 'number' || typeof data !== 'object' || data === null) {
    return res.status(400).json({ error: 'Malformed save request.' });
  }
  try {
    const result = await db.setState(req.streamId, data, version);
    if (!result.ok) {
      return res.status(409).json({
        error: 'This class was updated elsewhere just now.',
        currentData: result.current.data,
        currentVersion: result.current.version,
      });
    }
    res.json({ version: result.version });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save changes.' });
  }
});

// Requires a signed-in student now (not just anyone with the link) — the
// server uses the identity AND stream from their token, not anything the
// client sends, so a student can only ever mark themselves present, on a
// session that belongs to their own stream, never a classmate or another
// stream's session.
app.post('/api/checkin/:code/signin', requireStudent, async (req, res) => {
  const { code } = req.params;
  const studentId = req.auth.studentId;
  try {
    const result = await db.signInAttendance(req.streamId, code, studentId);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ record: result.record, lectureId: result.lectureId, studentId: result.studentId, version: result.version });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record attendance.' });
  }
});

// Governor-only upload — used for materials and course outline attachments.
app.post('/api/files', requireGovernor, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const saved = await db.saveFile(req.streamId, req.file.originalname, req.file.mimetype, req.file.buffer);
    res.json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the file.' });
  }
});

// Public: materials and outlines need to be viewable by students, who
// aren't Governor-authenticated. A file's id is a long random token, not
// a guessable sequence, so this is the same "link is the access" model as
// the check-in codes — unchanged by multi-tenancy, since a file's id
// alone (not its stream) has always been what gates access to it.
app.get('/api/files/:id', async (req, res) => {
  try {
    const file = await db.getFile(req.params.id);
    if (!file) return res.status(404).send('File not found.');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + file.filename.replace(/"/g, '') + '"');
    res.send(file.data);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load the file.');
  }
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That file is too large — the limit is 15MB.' });
    }
    return res.status(400).json({ error: 'Could not process that upload.' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Course Governor server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
