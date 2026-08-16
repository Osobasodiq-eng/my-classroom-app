const { Pool } = require('pg');
const crypto = require('crypto');

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
  // Kept in its own table, deliberately never inside the app_state JSON blob:
  // the Governor's saves overwrite that whole document, and if password
  // hashes lived inside it, an ordinary Governor edit could silently wipe
  // every student's password. This table is never touched by that save.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_credentials (
      matric TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Uploaded files (materials, course outlines) live here rather than in
  // the app_state JSON blob — that document is fetched in full on every
  // page load, so embedding file bytes in it would make every visit
  // (including the public check-in kiosk) download every uploaded file.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      data BYTEA NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Added after the files table already existed in earlier deploys —
  // IF NOT EXISTS makes this safe to run again on every boot.
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS extracted_text TEXT;`);
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_done BOOLEAN NOT NULL DEFAULT false;`);
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

// Self-service signup. If the matric number already exists in the roster
// (e.g. the Governor pre-loaded it), the student claims that same roster
// row instead of creating a duplicate. If it doesn't exist yet, a new
// roster entry is created — this is what makes signup "auto-register" the
// student, as requested.
async function studentSignup(matricRaw, name, passwordHash) {
  const matric = matricRaw.trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingCred = await client.query('SELECT 1 FROM student_credentials WHERE matric = $1', [matric]);
    if (existingCred.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'That matric number is already registered — try signing in instead.' };
    }
    const { rows } = await client.query('SELECT data, version FROM app_state WHERE id = 1 FOR UPDATE');
    const data = rows[0].data;
    const version = rows[0].version;

    let student = (data.students || []).find(
      (s) => (s.roll || '').trim().toUpperCase() === matric
    );
    if (student) {
      if (name) student.name = name;
    } else {
      student = {
        id: 'stu-' + crypto.randomBytes(6).toString('hex'),
        roll: matricRaw.trim(),
        name: name || matricRaw.trim(),
        email: '',
      };
      if (!data.students) data.students = [];
      data.students.push(student);
    }

    await client.query(
      'INSERT INTO student_credentials (matric, student_id, password_hash) VALUES ($1, $2, $3)',
      [matric, student.id, passwordHash]
    );
    await client.query(
      'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE id = 1',
      [data, version + 1]
    );
    await client.query('COMMIT');
    return {
      ok: true,
      student: { id: student.id, name: student.name, roll: student.roll },
      version: version + 1,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function studentCredential(matricRaw) {
  const matric = matricRaw.trim().toUpperCase();
  const { rows } = await pool.query(
    'SELECT student_id, password_hash FROM student_credentials WHERE matric = $1',
    [matric]
  );
  return rows[0] || null;
}

async function findStudentById(studentId) {
  const { data } = await getState();
  return (data.students || []).find((s) => s.id === studentId) || null;
}

async function saveFile(filename, mimeType, buffer) {
  const id = 'file-' + crypto.randomBytes(8).toString('hex');
  await pool.query(
    'INSERT INTO files (id, filename, mime_type, size_bytes, data) VALUES ($1, $2, $3, $4, $5)',
    [id, filename, mimeType || 'application/octet-stream', buffer.length, buffer]
  );
  return { id, filename, mimeType: mimeType || 'application/octet-stream', sizeBytes: buffer.length };
}

async function getFile(id) {
  const { rows } = await pool.query(
    'SELECT filename, mime_type, data FROM files WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function resetStudentPassword(studentId, passwordHash) {
  const result = await pool.query(
    'UPDATE student_credentials SET password_hash = $1 WHERE student_id = $2',
    [passwordHash, studentId]
  );
  return result.rowCount > 0;
}

// Runs lazily on read, not on a schedule — there's no background job
// runner here, so this is triggered by ordinary traffic instead. A cheap
// unlocked check runs first so a normal request doesn't pay for a row
// lock; only when something is actually past its window does it take the
// lock and do the write. Each session is marked `finalized` once handled
// so this is a one-time transition, not something that reprocesses every
// request forever.
async function finalizeExpiredSessions() {
  const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (!rows.length) return;
  const now = Date.now();
  const needsWork = (rows[0].data.attendanceSessions || []).some(
    (s) => !s.finalized && new Date(s.endsAt).getTime() <= now
  );
  if (!needsWork) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query('SELECT data, version FROM app_state WHERE id = 1 FOR UPDATE');
    const data = locked[0].data;
    const version = locked[0].version;
    const nowInner = Date.now();
    let changed = false;

    for (const session of data.attendanceSessions || []) {
      if (session.finalized) continue;
      if (new Date(session.endsAt).getTime() > nowInner) continue;
      if (!data.attendance[session.lectureId]) data.attendance[session.lectureId] = {};
      for (const student of data.students || []) {
        const existing = data.attendance[session.lectureId][student.id];
        if (!existing || !existing.status || existing.status === 'unmarked') {
          data.attendance[session.lectureId][student.id] = {
            status: 'absent',
            method: 'auto',
            at: session.endsAt,
          };
          changed = true;
        }
      }
      session.finalized = true;
      changed = true;
    }

    if (changed) {
      await client.query(
        'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE id = 1',
        [data, version + 1]
      );
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Extraction happens on first use, not on upload — uploading stays fast
// (no waiting on PDF parsing), and it means files uploaded before the
// study assistant existed still get grounded the first time anyone asks
// about them. Result is cached so the same file is never re-parsed.
async function getFileText(id) {
  const { rows } = await pool.query(
    'SELECT filename, mime_type, data, extracted_text, extraction_done FROM files WHERE id = $1',
    [id]
  );
  if (!rows.length) return '';
  const file = rows[0];
  if (file.extraction_done && file.extracted_text) return file.extracted_text;
  const { extractText } = require('./textExtract');
  const text = await extractText(file.mime_type, file.filename, file.data);
  // Only cache real successes. An empty result might be a genuinely
  // unsupported file (a scanned/image-only PDF, for instance) or it might
  // be a transient hiccup — caching it as "done" either way would mean a
  // file that failed once stays permanently blank to the assistant, even
  // after a fix. Retrying a still-empty file each time is cheap; silently
  // and permanently losing a document's content is not.
  if (text.trim()) {
    await pool.query('UPDATE files SET extracted_text = $1, extraction_done = true WHERE id = $2', [text, id]);
  }
  return text;
}

module.exports = { pool, init, getState, setState, signInAttendance, studentSignup, studentCredential, findStudentById, resetStudentPassword, saveFile, getFile, getFileText, finalizeExpiredSessions, DEFAULT_DATA };
