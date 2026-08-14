const { Pool } = require('pg');

// Render (and most managed Postgres hosts) require SSL, and their certs
// aren't always in the default trust chain from a small web service —
// rejectUnauthorized:false is the standard pragmatic setting here.
const useSsl = process.env.DATABASE_SSL !== 'false';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

const DEFAULT_DATA = () => ({
  className: 'MBA Cohort',
  courses: [],
  students: [],
  lectures: [],
  attendance: {},
  attendanceSessions: [],
  materials: [],
  assignments: [],
  announcements: [],
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
  const { rows } = await pool.query('SELECT id FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    await pool.query(
      'INSERT INTO app_state (id, data, version) VALUES (1, $1, 1)',
      [DEFAULT_DATA()]
    );
    console.log('app_state seeded with empty default data');
  }
}

async function getState() {
  const { rows } = await pool.query('SELECT data, version FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    // Shouldn't happen after init(), but guard anyway.
    await pool.query('INSERT INTO app_state (id, data, version) VALUES (1, $1, 1)', [DEFAULT_DATA()]);
    return { data: DEFAULT_DATA(), version: 1 };
  }
  return { data: rows[0].data, version: rows[0].version };
}

// Optimistic concurrency: caller must supply the version they last read.
// Returns { ok:true, version } on success, or { ok:false, current:{data,version} } on conflict.
async function setState(newData, expectedVersion) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT version FROM app_state WHERE id = 1 FOR UPDATE');
    const currentVersion = rows[0].version;
    if (currentVersion !== expectedVersion) {
      const { rows: cur } = await client.query('SELECT data, version FROM app_state WHERE id = 1');
      await client.query('ROLLBACK');
      return { ok: false, current: { data: cur[0].data, version: cur[0].version } };
    }
    const nextVersion = currentVersion + 1;
    await client.query(
      'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE id = 1',
      [newData, nextVersion]
    );
    await client.query('COMMIT');
    return { ok: true, version: nextVersion };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Used only by the public self check-in endpoint: re-reads state fresh,
// validates the session code + time window server-side (never trusts the
// caller's copy), applies a single attendance record, and saves — all
// inside one transaction so two students signing in at once can't clobber
// each other the way a naive read-modify-write from the client could.
async function signInAttendance(code, studentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data, version FROM app_state WHERE id = 1 FOR UPDATE');
    const data = rows[0].data;
    const version = rows[0].version;

    const session = (data.attendanceSessions || []).find(
      (s) => s.code === code.toUpperCase()
    );
    if (!session) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'No session matches this check-in link.' };
    }
    const now = new Date();
    const starts = new Date(session.startsAt);
    const ends = new Date(session.endsAt);
    if (now < starts) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'This check-in has not opened yet.' };
    }
    if (now > ends) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'This check-in window has closed.' };
    }
    const student = (data.students || []).find((s) => s.id === studentId);
    if (!student) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'Student not found on the roll.' };
    }

    if (!data.attendance[session.lectureId]) data.attendance[session.lectureId] = {};
    const existing = data.attendance[session.lectureId][studentId];
    const record = { status: 'present', method: 'self', at: existing && existing.method === 'self' ? existing.at : now.toISOString() };
    data.attendance[session.lectureId][studentId] = record;

    await client.query(
      'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE id = 1',
      [data, version + 1]
    );
    await client.query('COMMIT');
    return { ok: true, record, lectureId: session.lectureId, studentId, version: version + 1 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, init, getState, setState, signInAttendance, DEFAULT_DATA };
