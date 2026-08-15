require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { login, requireGovernor, studentSignup, studentLogin, requireStudent } = require('./auth');

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

// Public: anyone with the site URL can read the register — this mirrors a
// physical noticeboard, and students need it to populate the check-in
// roster without an account. Only writes require the Governor token.
app.get('/api/state', async (req, res) => {
  try {
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

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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
