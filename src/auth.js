const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SECRET = process.env.JWT_SECRET;
const GOVERNOR_PASSWORD = process.env.GOVERNOR_PASSWORD;
const GOVERNOR_TOKEN_TTL = '12h';
const STUDENT_TOKEN_TTL = '30d';

function login(req, res) {
  if (!GOVERNOR_PASSWORD) {
    return res.status(500).json({ error: 'Server is missing GOVERNOR_PASSWORD — set it in the environment.' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== GOVERNOR_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = jwt.sign({ role: 'governor' }, SECRET, { expiresIn: GOVERNOR_TOKEN_TTL });
  res.json({ token, expiresIn: GOVERNOR_TOKEN_TTL });
}

function requireGovernor(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Sign in as Governor to make changes.' });
  }
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== 'governor') throw new Error('wrong role');
    req.auth = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session expired — sign in again.' });
  }
}

// A student picks their own password on first signup — this account is
// separate from anything the Governor sets, and lets the app tell one
// student apart from another instead of trusting a free-pick name dropdown.
async function studentSignup(req, res) {
  const { matric, name, password } = req.body || {};
  if (!matric || !String(matric).trim()) {
    return res.status(400).json({ error: 'Enter your matric number.' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'Choose a password of at least 4 characters.' });
  }
  try {
    const passwordHash = await bcrypt.hash(String(password), 10);
    const result = await db.studentSignup(String(matric), String(name || '').trim(), passwordHash);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const token = jwt.sign(
      { role: 'student', studentId: result.student.id },
      SECRET,
      { expiresIn: STUDENT_TOKEN_TTL }
    );
    res.json({ token, student: result.student, version: result.version });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create your account — try again.' });
  }
}

async function studentLogin(req, res) {
  const { matric, password } = req.body || {};
  if (!matric || !password) {
    return res.status(400).json({ error: 'Enter your matric number and password.' });
  }
  try {
    const cred = await db.studentCredential(String(matric));
    if (!cred) return res.status(401).json({ error: 'No account found for that matric number. Sign up first.' });
    const match = await bcrypt.compare(String(password), cred.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });
    const student = await db.findStudentById(cred.student_id);
    const token = jwt.sign(
      { role: 'student', studentId: cred.student_id },
      SECRET,
      { expiresIn: STUDENT_TOKEN_TTL }
    );
    res.json({
      token,
      student: student
        ? { id: student.id, name: student.name, roll: student.roll }
        : { id: cred.student_id, name: '', roll: matric },
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
    if (payload.role !== 'student') throw new Error('wrong role');
    req.auth = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session expired — sign in again.' });
  }
}

// Governor-only: a student who forgot their password has no self-service
// reset (that would need an email service, which is a separate piece of
// infrastructure to set up). Instead, the person who already holds the
// keys to the whole class — the Governor — can set a new password for
// them directly, the same way a teacher hands out a reset in person.
async function resetStudentPassword(req, res) {
  const { studentId } = req.params;
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'Choose a password of at least 4 characters.' });
  }
  try {
    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    const ok = await db.resetStudentPassword(studentId, passwordHash);
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
    if (payload.role !== 'governor' && payload.role !== 'student') throw new Error('bad role');
    req.auth = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session expired — sign in again.' });
  }
}

module.exports = { login, requireGovernor, studentSignup, studentLogin, requireStudent, resetStudentPassword, requireAnyAuth };
