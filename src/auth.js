const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const GOVERNOR_PASSWORD = process.env.GOVERNOR_PASSWORD;
const TOKEN_TTL = '12h';

function login(req, res) {
  if (!GOVERNOR_PASSWORD) {
    return res.status(500).json({ error: 'Server is missing GOVERNOR_PASSWORD — set it in the environment.' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== GOVERNOR_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = jwt.sign({ role: 'governor' }, SECRET, { expiresIn: TOKEN_TTL });
  res.json({ token, expiresIn: TOKEN_TTL });
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

module.exports = { login, requireGovernor };
