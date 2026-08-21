require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const db = require('./db');
const { login, requireGovernor, studentSignup, studentLogin, requireStudent, resetStudentPassword, requireAnyAuth } = require('./auth');
const { askAssistant, listConversations, getConversationHandler, deleteConversationHandler } = require('./assistant');

// Files are held in memory only long enough to write them to Postgres —
// nothing is written to local disk, which matters on Render's free tier
// where disk contents don't persist between deploys anyway.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB cap

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'GOVERNOR_PASSWORD'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill these in (see README.md).');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------- API ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/login', login);
app.post('/api/auth/student-signup', studentSignup);
app.post('/api/auth/student-login', studentLogin);
app.post('/api/students/:studentId/reset-password', requireGovernor, resetStudentPassword);
app.delete('/api/students/:studentId', requireGovernor, async (req, res) => {
  try {
    const result = await db.removeStudent(req.params.studentId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove the student — try again.' });
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
    await db.saveCgpaRecord(req.auth.studentId, semesters);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save your CGPA record.' });
  }
});

// Public: anyone with the site URL can read the register — this mirrors a
// physical noticeboard, and students need it to populate the check-in
// roster without an account. Only writes require the Governor token.
app.get('/api/state', async (req, res) => {
  try {
    await db.finalizeExpiredSessions();
    const { data, version } = await db.getState();
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
    const result = await db.setState(data, version);
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
// server uses the identity from their token, not anything the client sends,
// so a student can only ever mark themselves present, never a classmate.
app.post('/api/checkin/:code/signin', requireStudent, async (req, res) => {
  const { code } = req.params;
  const studentId = req.auth.studentId;
  try {
    const result = await db.signInAttendance(code, studentId);
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
    const saved = await db.saveFile(req.file.originalname, req.file.mimetype, req.file.buffer);
    res.json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the file.' });
  }
});

// Public: materials and outlines need to be viewable by students, who
// aren't Governor-authenticated. A file's id is a long random token, not
// a guessable sequence, so this is the same "link is the access" model as
// the check-in codes.
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
