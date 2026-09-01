const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SECRET = process.env.JWT_SECRET;
const GOVERNOR_TOKEN_TTL = '12h';
const STUDENT_TOKEN_TTL = '30d';
const ADMIN_TOKEN_TTL = '4h'; // shorter-lived — this token can read across every stream
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Any Governor can sign up and create their own stream — this is what
// makes the whole app self-serve rather than needing one shared,
// operator-set GOVERNOR_PASSWORD. The stream this creates is fully
// isolated from every other stream from the moment it exists: its own
// app_state row, its own join code, its own roster.
async function governorSignup(req, res) {
  const { streamName, email, password } = req.body || {};
  if (!streamName || !String(streamName).trim()) {
    return res.status(400).json({ error: 'Give your stream a name (e.g. your class or cohort name).' });
  }
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'Choose a password of at least 6 characters.' });
  }
  try {
    const existing = await db.getStreamByEmail(cleanEmail);
    if (existing) {
      return res.status(409).json({ error: 'A stream is already registered to that email — try signing in instead.' });
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    const { id: streamId, joinCode, status } = await db.createStream(String(streamName).trim(), cleanEmail, passwordHash);
    const token = jwt.sign({ role: 'governor', streamId }, SECRET, { expiresIn: GOVERNOR_TOKEN_TTL });
    res.json({ token, stream: { id: streamId, name: String(streamName).trim(), joinCode, status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create your stream — try again.' });
  }
}

// Governor sign-in is now email + password, scoped to whichever stream
// that email created — no more single shared GOVERNOR_PASSWORD, since
// there's no longer just one Governor for the whole app.
async function login(req, res) {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  try {
    const stream = await db.getStreamByEmail(cleanEmail);
    if (!stream) return res.status(401).json({ error: 'No stream is registered to that email.' });
    const match = await bcrypt.compare(password, stream.governor_password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ role: 'governor', streamId: stream.id }, SECRET, { expiresIn: GOVERNOR_TOKEN_TTL });
    res.json({ token, stream: { id: stream.id, name: stream.name, joinCode: stream.join_code, status: stream.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not sign you in — try again.' });
  }
}

function requireGovernor(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Sign in as Governor to make changes.' });
  }
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== 'governor' || !payload.streamId) throw new Error('wrong role');
    req.auth = payload;
    req.streamId = payload.streamId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session expired — sign in again.' });
  }
}

// A Governor's token doesn't carry their stream's current approval
// status (it's set once at login and could go stale — an admin might
// approve the stream minutes later, same session). The frontend calls
// this after every sign-in and on reload to get the authoritative,
// current status before deciding whether to show the dashboard or a
// "waiting for approval" screen.
async function getMyStream(req, res) {
  try {
    const stream = await db.getStreamById(req.streamId);
    if (!stream) return res.status(404).json({ error: 'Stream not found.' });
    res.json({ stream: { id: stream.id, name: stream.name, joinCode: stream.join_code, status: stream.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your stream.' });
  }
}

// Public: lets the student-facing UI turn a join code (typed in, or from
// a shared join link) into the stream it belongs to, before the student
// has any account or token yet.
async function resolveJoinCode(req, res) {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Enter a join code.' });
  try {
    const stream = await db.getStreamByJoinCode(code);
    if (!stream) return res.status(404).json({ error: "That join code doesn't match any class. Check it and try again." });
    // A stream awaiting (or denied) admin approval doesn't exist yet as
    // far as students are concerned — resolving its join code is the
    // first step of finding a class, so this is where that gets stopped,
    // before a signup/login form for it is ever shown.
    if (stream.status !== 'approved') {
      return res.status(403).json({ error: 'This class is awaiting approval and isn\'t open to students yet — check back soon.' });
    }
    res.json({ streamId: stream.id, name: stream.name, joinCode: stream.join_code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not look up that code — try again.' });
  }
}

// A student picks their own password on first signup — this account is
// separate from anything the Governor sets, and lets the app tell one
// student apart from another instead of trusting a free-pick name dropdown.
// joinCode identifies which stream they're registering into; the same
// matric number can exist independently in a different stream.
async function studentSignup(req, res) {
  const { joinCode, matric, name, email, password } = req.body || {};
  if (!joinCode || !String(joinCode).trim()) {
    return res.status(400).json({ error: 'Missing class join code — use the join link your Governor shared.' });
  }
  if (!matric || !String(matric).trim()) {
    return res.status(400).json({ error: 'Enter your matric number.' });
  }
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'Choose a password of at least 4 characters.' });
  }
  try {
    const stream = await db.getStreamByJoinCode(String(joinCode));
    if (!stream) return res.status(404).json({ error: "That join code doesn't match any class." });
    // Defense in depth: the frontend already stops here via
    // resolveJoinCode, but this endpoint is reachable directly too.
    if (stream.status !== 'approved') {
      return res.status(403).json({ error: 'This class is awaiting approval and isn\'t open to students yet.' });
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    const result = await db.studentSignup(stream.id, String(matric), String(name || '').trim(), String(email).trim(), passwordHash);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const token = jwt.sign(
      { role: 'student', studentId: result.student.id, streamId: stream.id },
      SECRET,
      { expiresIn: STUDENT_TOKEN_TTL }
    );
    res.json({ token, student: result.student, version: result.version, stream: { id: stream.id, name: stream.name, joinCode: stream.join_code } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create your account — try again.' });
  }
}

async function studentLogin(req, res) {
  const { joinCode, matric, password } = req.body || {};
  if (!joinCode || !String(joinCode).trim()) {
    return res.status(400).json({ error: 'Missing class join code — use the join link your Governor shared.' });
  }
  if (!matric || !password) {
    return res.status(400).json({ error: 'Enter your matric number and password.' });
  }
  try {
    const stream = await db.getStreamByJoinCode(String(joinCode));
    if (!stream) return res.status(404).json({ error: "That join code doesn't match any class." });
    if (stream.status !== 'approved') {
      return res.status(403).json({ error: 'This class is awaiting approval and isn\'t open to students yet.' });
    }
    const cred = await db.studentCredential(stream.id, String(matric));
    if (!cred) return res.status(401).json({ error: 'No account found for that matric number in this class. Sign up first.' });
    const match = await bcrypt.compare(String(password), cred.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });
    const student = await db.findStudentById(stream.id, cred.student_id);
    const token = jwt.sign(
      { role: 'student', studentId: cred.student_id, streamId: stream.id },
      SECRET,
      { expiresIn: STUDENT_TOKEN_TTL }
    );
    res.json({
      token,
      student: student
        ? { id: student.id, name: student.name, roll: student.roll, email: student.email }
        : { id: cred.student_id, name: '', roll: matric, email: '' },
      stream: { id: stream.id, name: stream.name, joinCode: stream.join_code },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not sign you in — try again.' });
  }
}

function requireStudent(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Sign in to check in.' });
  }
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== 'student' || !payload.streamId) throw new Error('wrong role');
    req.auth = payload;
    req.streamId = payload.streamId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session expired — sign in again.' });
  }
}

// Governor-only: a student who forgot their password has no self-service
// reset (that would need an email service, which is a separate piece of
// infrastructure to set up). Instead, the person who already holds the
// keys to this stream — its Governor — can set a new password for them
// directly, the same way a teacher hands out a reset in person. Scoped to
// req.streamId (set by requireGovernor), so a Governor can only ever
// reset passwords for students in their own stream.
async function resetStudentPassword(req, res) {
  const { studentId } = req.params;
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'Choose a password of at least 4 characters.' });
  }
  try {
    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    const ok = await db.resetStudentPassword(req.streamId, studentId, passwordHash);
    if (!ok) return res.status(404).json({ error: "This student hasn't signed up for an account yet — there's nothing to reset." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reset the password — try again.' });
  }
}

function requireAnyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Sign in to use the study assistant.' });
  }
  try {
    const payload = jwt.verify(token, SECRET);
    if ((payload.role !== 'governor' && payload.role !== 'student') || !payload.streamId) throw new Error('bad role');
    req.auth = payload;
    req.streamId = payload.streamId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session expired — sign in again.' });
  }
}

// A single, hardcoded admin account — deliberately not a signup flow, and
// deliberately not stored in the database: ADMIN_EMAIL/ADMIN_PASSWORD are
// read straight from the environment on every login attempt, so there's
// no admin row anywhere for an application bug (or a future feature) to
// accidentally expose. This account can see across every stream, which
// is exactly why it's kept this minimal and this separate from the
// Governor/student account system.
async function adminLogin(req, res) {
  const { email, password } = req.body || {};
  const configuredEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const configuredPassword = process.env.ADMIN_PASSWORD || '';
  if (!configuredEmail || !configuredPassword) {
    return res.status(503).json({ error: 'Admin login is not configured on this server.' });
  }
  const cleanEmail = String(email || '').trim().toLowerCase();
  // Plain comparison, not bcrypt — there's exactly one of these accounts
  // and its password lives in an environment variable, not a database
  // row, so there's nothing here for a hash to protect against (no table
  // to leak, no other admin rows to compare timing against). Simpler is
  // safer than adding a hashing step that provides no real benefit here.
  if (cleanEmail !== configuredEmail || String(password || '') !== configuredPassword) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: ADMIN_TOKEN_TTL });
  res.json({ token });
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Sign in as admin.' });
  }
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== 'admin') throw new Error('wrong role');
    req.auth = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your admin session expired — sign in again.' });
  }
}

module.exports = {
  governorSignup, login, requireGovernor, resolveJoinCode, getMyStream,
  studentSignup, studentLogin, requireStudent, resetStudentPassword, requireAnyAuth,
  adminLogin, requireAdmin,
};
