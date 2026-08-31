const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SECRET = process.env.JWT_SECRET;
const GOVERNOR_TOKEN_TTL = '12h';
const STUDENT_TOKEN_TTL = '30d';
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
    const { id: streamId, joinCode } = await db.createStream(String(streamName).trim(), cleanEmail, passwordHash);
    const token = jwt.sign({ role: 'governor', streamId }, SECRET, { expiresIn: GOVERNOR_TOKEN_TTL });
    res.json({ token, stream: { id: streamId, name: String(streamName).trim(), joinCode } });
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
    res.json({ token, stream: { id: stream.id, name: stream.name, joinCode: stream.join_code } });
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

// Public: lets the student-facing UI turn a join code (typed in, or from
// a shared join link) into the stream it belongs to, before the student
// has any account or token yet.
async function resolveJoinCode(req, res) {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Enter a join code.' });
  try {
    const stream = await db.getStreamByJoinCode(code);
    if (!stream) return res.status(404).json({ error: "That join code doesn't match any class. Check it and try again." });
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

module.exports = {
  governorSignup, login, requireGovernor, resolveJoinCode,
  studentSignup, studentLogin, requireStudent, resetStudentPassword, requireAnyAuth,
};
