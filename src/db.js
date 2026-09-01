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

// Unambiguous alphabet — no 0/O or 1/I/L — since this is read aloud and
// typed by hand far more often than any other code in the app.
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genJoinCode(len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) out += JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)];
  return out;
}

async function columnExists(table, column) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function tableExists(table) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [table]
  );
  return rows.length > 0;
}

// One-time migration from the old single-tenant schema (one global
// app_state row, one shared GOVERNOR_PASSWORD) into the multi-tenant one
// (many streams, each with its own Governor account and its own
// app_state row). Runs at most once — after it runs, app_state has a
// stream_id column and this whole function becomes a no-op forever.
// Existing class data is preserved and wrapped into a single stream
// rather than discarded, since this may be a live deployment with real
// students on it.
async function migrateToMultiTenant() {
  const alreadyMultiTenant = await columnExists('app_state', 'stream_id');
  if (alreadyMultiTenant) return;

  const legacyHasData = await tableExists('app_state');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let legacyStreamId = null;
    if (legacyHasData) {
      const { rows } = await client.query('SELECT id, data FROM app_state WHERE id = 1');
      if (rows.length) {
        legacyStreamId = 'stream-' + crypto.randomBytes(6).toString('hex');
        const joinCode = genJoinCode();
        const email = (process.env.GOVERNOR_EMAIL || 'governor@legacy.local').trim().toLowerCase();
        // If GOVERNOR_PASSWORD is still set, the existing Governor keeps
        // using it (now paired with GOVERNOR_EMAIL, or the fallback
        // address above) so this migration doesn't lock anyone out of
        // data that already exists. If it's not set, a random
        // unguessable placeholder hash is stored instead — nobody can
        // sign in with it, so operators must set GOVERNOR_EMAIL /
        // GOVERNOR_PASSWORD (or create a fresh stream) and manually
        // reassign this data, but at least the data itself isn't lost.
        const bcrypt = require('bcryptjs');
        const passwordHash = await bcrypt.hash(
          process.env.GOVERNOR_PASSWORD || crypto.randomBytes(24).toString('hex'),
          10
        );
        await client.query(
          `CREATE TABLE IF NOT EXISTS streams (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            join_code TEXT UNIQUE NOT NULL,
            governor_email TEXT UNIQUE NOT NULL,
            governor_password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );`
        );
        await client.query(
          'INSERT INTO streams (id, name, join_code, governor_email, governor_password_hash) VALUES ($1, $2, $3, $4, $5)',
          [legacyStreamId, (rows[0].data && rows[0].data.className) || 'My Class', joinCode, email, passwordHash]
        );
        console.log('--------------------------------------------------------------');
        console.log('MIGRATION: existing class data was moved into a new stream.');
        console.log('  Stream id:   ' + legacyStreamId);
        console.log('  Join code:   ' + joinCode);
        console.log('  Governor sign-in email: ' + email);
        if (!process.env.GOVERNOR_PASSWORD) {
          console.log('  GOVERNOR_PASSWORD was not set — a random password was generated');
          console.log('  and NOT recorded anywhere. Set GOVERNOR_EMAIL/GOVERNOR_PASSWORD and');
          console.log('  restart, or ask this stream\'s Governor to sign up fresh.');
        }
        console.log('--------------------------------------------------------------');
      }
    }

    // app_state: id (INTEGER, always 1) -> stream_id (TEXT, one row per stream)
    await client.query(`ALTER TABLE app_state ADD COLUMN IF NOT EXISTS stream_id TEXT;`);
    if (legacyStreamId) {
      await client.query('UPDATE app_state SET stream_id = $1 WHERE id = 1', [legacyStreamId]);
    }
    await client.query(`ALTER TABLE app_state DROP CONSTRAINT IF EXISTS single_row;`);
    await client.query(`ALTER TABLE app_state DROP CONSTRAINT IF EXISTS app_state_pkey;`);
    // Any row left without a stream (shouldn't happen outside a fresh,
    // never-seeded deploy) is removed rather than left as an orphan with
    // no owner and no way to reach it.
    await client.query(`DELETE FROM app_state WHERE stream_id IS NULL;`);
    await client.query(`ALTER TABLE app_state ALTER COLUMN stream_id SET NOT NULL;`);
    await client.query(`ALTER TABLE app_state DROP COLUMN IF EXISTS id;`);
    await client.query(`ALTER TABLE app_state ADD PRIMARY KEY (stream_id);`);

    // student_credentials: matric was globally unique; now scoped per stream
    // so two different streams can each have their own "CS/2020/001".
    if (await tableExists('student_credentials')) {
      await client.query(`ALTER TABLE student_credentials ADD COLUMN IF NOT EXISTS stream_id TEXT;`);
      if (legacyStreamId) {
        await client.query('UPDATE student_credentials SET stream_id = $1 WHERE stream_id IS NULL', [legacyStreamId]);
      }
      await client.query(`DELETE FROM student_credentials WHERE stream_id IS NULL;`);
      await client.query(`ALTER TABLE student_credentials ALTER COLUMN stream_id SET NOT NULL;`);
      await client.query(`ALTER TABLE student_credentials DROP CONSTRAINT IF EXISTS student_credentials_pkey;`);
      await client.query(`ALTER TABLE student_credentials ADD PRIMARY KEY (stream_id, matric);`);
    }

    // files and cgpa_records: student_id / file id are already globally
    // unique random tokens, so no key changes are needed — stream_id is
    // added purely as bookkeeping for future scoped queries.
    if (await tableExists('files')) {
      await client.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS stream_id TEXT;`);
      if (legacyStreamId) {
        await client.query('UPDATE files SET stream_id = $1 WHERE stream_id IS NULL', [legacyStreamId]);
      }
    }
    if (await tableExists('cgpa_records')) {
      await client.query(`ALTER TABLE cgpa_records ADD COLUMN IF NOT EXISTS stream_id TEXT;`);
      if (legacyStreamId) {
        await client.query('UPDATE cgpa_records SET stream_id = $1 WHERE stream_id IS NULL', [legacyStreamId]);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function init() {
  // app_state must exist (in whatever shape) before migrateToMultiTenant
  // can inspect/alter it, so create the pre-migration shape first if this
  // is a genuinely fresh database with no table at all yet.
  if (!(await tableExists('app_state'))) {
    await pool.query(`
      CREATE TABLE app_state (
        stream_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      join_code TEXT UNIQUE NOT NULL,
      governor_email TEXT UNIQUE NOT NULL,
      governor_password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Added after `streams` already existed in earlier deploys — the
  // DEFAULT here is what makes this safe: every already-existing stream
  // (including ones created before this feature existed at all)
  // automatically becomes 'approved' the moment this column is added, so
  // nothing already running gets locked out. Only streams created by
  // createStream() from here on start life as 'pending' (it inserts that
  // explicitly, overriding this default).
  await pool.query(`ALTER TABLE streams ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';`);

  await migrateToMultiTenant();

  // Kept in its own table, deliberately never inside the app_state JSON blob:
  // the Governor's saves overwrite that whole document, and if password
  // hashes lived inside it, an ordinary Governor edit could silently wipe
  // every student's password. This table is never touched by that save.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_credentials (
      stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
      matric TEXT NOT NULL,
      student_id TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (stream_id, matric)
    );
  `);
  // Uploaded files (materials, course outlines) live here rather than in
  // the app_state JSON blob — that document is fetched in full on every
  // page load, so embedding file bytes in it would make every visit
  // (including the public check-in kiosk) download every uploaded file.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      stream_id TEXT REFERENCES streams(id) ON DELETE CASCADE,
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
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS stream_id TEXT;`);
  // Kept separate from app_state for the same reason credentials and
  // files are: a Governor's whole-document save shouldn't be able to
  // wipe out a student's saved chat history, and this way it can't.
  // Superseded by assistant_conversations below (which supports multiple
  // saved threads per student instead of one rolling one) — left in place
  // rather than dropped, so nothing existing gets silently deleted.
  // `identity` already embeds the stream (see auth.js/assistant.js —
  // "governor:<streamId>" / "student:<streamId>:<studentId>"), so no
  // separate stream_id column is needed here to keep threads isolated.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_chats (
      identity TEXT NOT NULL,
      course_id TEXT NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (identity, course_id)
    );
  `);
  // Each row is one saved conversation thread — a student can have several
  // per course and browse back through past ones, not just one rolling
  // conversation that gets overwritten by "New chat".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_conversations (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      course_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      messages JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assistant_conversations_lookup ON assistant_conversations (identity, course_id, updated_at DESC);`);
  // A student's own CGPA entries — self-reported grades they type in,
  // not something the Governor tracks or edits. Kept in its own table for
  // the same reason as the two above: it's the student's personal record,
  // and a Governor save should never be able to touch it. student_id is a
  // globally unique random token, so no stream_id is needed in the key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cgpa_records (
      student_id TEXT PRIMARY KEY,
      semesters JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE cgpa_records ADD COLUMN IF NOT EXISTS stream_id TEXT;`);

  // Append-only — nothing in this app ever updates or deletes a row here,
  // by design. It exists purely so the one place that can see across
  // streams (the admin backoffice) leaves a trail of every time it did.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      stream_id TEXT,
      detail TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ---------- Streams ----------

async function createStream(name, email, passwordHash) {
  const id = 'stream-' + crypto.randomBytes(6).toString('hex');
  let joinCode = genJoinCode();
  // Vanishingly unlikely to collide, but a unique constraint means a
  // collision would otherwise surface as an ugly 500 — retry a couple of
  // times with a fresh code instead.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // New streams start 'pending' — an admin has to approve them
      // before the Governor can do anything with class data, or a
      // student can even resolve the join code. See requireApprovedStream
      // in server.js and the status checks in auth.js.
      await pool.query(
        'INSERT INTO streams (id, name, join_code, governor_email, governor_password_hash, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, name, joinCode, email, passwordHash, 'pending']
      );
      await pool.query('INSERT INTO app_state (stream_id, data, version) VALUES ($1, $2, 1)', [id, DEFAULT_DATA()]);
      return { id, joinCode, status: 'pending' };
    } catch (err) {
      if (err.code === '23505' && String(err.constraint).includes('join_code')) {
        joinCode = genJoinCode();
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not generate a unique join code — try again.');
}

async function getStreamByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM streams WHERE governor_email = $1', [email.trim().toLowerCase()]);
  return rows[0] || null;
}

async function getStreamByJoinCode(code) {
  const { rows } = await pool.query('SELECT id, name, join_code, status FROM streams WHERE join_code = $1', [String(code).trim().toUpperCase()]);
  return rows[0] || null;
}

async function getStreamById(id) {
  const { rows } = await pool.query('SELECT id, name, join_code, status FROM streams WHERE id = $1', [id]);
  return rows[0] || null;
}

// Admin-only view — includes the Governor's email (never the password
// hash; that never leaves auth.js's bcrypt comparison). Kept separate
// from getStreamById so nothing accidentally starts exposing more than
// intended to a non-admin caller in the future.
async function getStreamForAdmin(id) {
  const { rows } = await pool.query(
    'SELECT id, name, join_code, governor_email, status, created_at FROM streams WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

// One row per stream, with cheap counts pulled from its app_state
// document — enough for an admin to see what a stream is at a glance
// without opening it. LEFT JOIN so a stream somehow missing its
// app_state row (shouldn't happen) still shows up rather than vanishing.
// Ordered pending-first — that's the queue an admin actually needs to
// work through — then newest-first within each status.
async function listStreamsForAdmin() {
  const { rows } = await pool.query(`
    SELECT
      s.id, s.name, s.join_code, s.governor_email, s.status, s.created_at,
      COALESCE(jsonb_array_length(a.data->'students'), 0) AS student_count,
      COALESCE(jsonb_array_length(a.data->'courses'), 0) AS course_count,
      a.updated_at AS last_activity
    FROM streams s
    LEFT JOIN app_state a ON a.stream_id = s.id
    ORDER BY (s.status = 'pending') DESC, s.created_at DESC
  `);
  return rows;
}

// A new stream can't do anything — no class data changes, no students
// able to join — until an admin flips it to 'approved' here. See
// requireApprovedStream in server.js and the status checks around
// join-code resolution and student signup/login in auth.js.
async function setStreamStatus(streamId, status) {
  const result = await pool.query('UPDATE streams SET status = $1 WHERE id = $2', [status, streamId]);
  return result.rowCount > 0;
}

async function adminResetGovernorPassword(streamId, passwordHash) {
  const result = await pool.query('UPDATE streams SET governor_password_hash = $1 WHERE id = $2', [passwordHash, streamId]);
  return result.rowCount > 0;
}

async function regenerateJoinCode(streamId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genJoinCode();
    try {
      const result = await pool.query('UPDATE streams SET join_code = $1 WHERE id = $2', [code, streamId]);
      if (result.rowCount === 0) return null; // stream not found
      return code;
    } catch (err) {
      if (err.code === '23505') continue; // collision — try another code
      throw err;
    }
  }
  throw new Error('Could not generate a unique join code — try again.');
}

// Deletes a stream and everything scoped to it. app_state/student_credentials/
// files/cgpa_records don't have DB-level ON DELETE CASCADE tying them to
// streams.id (student_credentials and files do; app_state and
// cgpa_records were added before that pattern was settled on), so this
// cleans all of them up explicitly in one transaction rather than relying
// on a mix of enforced and unenforced foreign keys. Irreversible — the
// caller (the admin route) is responsible for requiring confirmation
// before calling this.
async function deleteStreamCascade(streamId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM streams WHERE id = $1 FOR UPDATE', [streamId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('DELETE FROM cgpa_records WHERE stream_id = $1', [streamId]);
    await client.query('DELETE FROM assistant_conversations WHERE identity = $1 OR identity LIKE $2', ['governor:' + streamId, 'student:' + streamId + ':%']);
    await client.query('DELETE FROM assistant_chats WHERE identity = $1 OR identity LIKE $2', ['governor:' + streamId, 'student:' + streamId + ':%']);
    await client.query('DELETE FROM files WHERE stream_id = $1', [streamId]);
    await client.query('DELETE FROM student_credentials WHERE stream_id = $1', [streamId]);
    await client.query('DELETE FROM app_state WHERE stream_id = $1', [streamId]);
    await client.query('DELETE FROM streams WHERE id = $1', [streamId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Every admin action is recorded here — including read-only views of a
// stream's data, not just the destructive ones. This table is what keeps
// "walled off, even from me" honest once an admin backoffice exists at
// all: there's no code path that reads across streams without leaving a
// trace of who looked and when.
async function logAdminAction(action, streamId, detail) {
  await pool.query(
    'INSERT INTO admin_audit_log (action, stream_id, detail) VALUES ($1, $2, $3)',
    [action, streamId || null, detail || null]
  );
}

async function listAdminAuditLog(limit = 200) {
  const { rows } = await pool.query(
    'SELECT action, stream_id, detail, at FROM admin_audit_log ORDER BY at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

// ---------- Per-stream class data ----------

async function getState(streamId) {
  const { rows } = await pool.query('SELECT data, version FROM app_state WHERE stream_id = $1', [streamId]);
  if (rows.length === 0) {
    // Shouldn't happen for a real stream (createStream seeds this row),
    // but guard anyway rather than 500ing.
    await pool.query('INSERT INTO app_state (stream_id, data, version) VALUES ($1, $2, 1)', [streamId, DEFAULT_DATA()]);
    return { data: DEFAULT_DATA(), version: 1 };
  }
  return { data: rows[0].data, version: rows[0].version };
}

// Optimistic concurrency: caller must supply the version they last read.
// Returns { ok:true, version } on success, or { ok:false, current:{data,version} } on conflict.
async function setState(streamId, newData, expectedVersion) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT version FROM app_state WHERE stream_id = $1 FOR UPDATE', [streamId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      throw new Error('Stream not found.');
    }
    const currentVersion = rows[0].version;
    if (currentVersion !== expectedVersion) {
      const { rows: cur } = await client.query('SELECT data, version FROM app_state WHERE stream_id = $1', [streamId]);
      await client.query('ROLLBACK');
      return { ok: false, current: { data: cur[0].data, version: cur[0].version } };
    }
    const nextVersion = currentVersion + 1;
    await client.query(
      'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE stream_id = $3',
      [newData, nextVersion, streamId]
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
// Scoped to a single stream's row via streamId, same as everything else —
// a session code from one stream can never be matched against another's.
async function signInAttendance(streamId, code, studentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data, version FROM app_state WHERE stream_id = $1 FOR UPDATE', [streamId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Class not found.' };
    }
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
      'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE stream_id = $3',
      [data, version + 1, streamId]
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

// Self-service signup, scoped to one stream. If the matric number already
// exists in that stream's roster (e.g. the Governor pre-loaded it), the
// student claims that same roster row instead of creating a duplicate. If
// it doesn't exist yet, a new roster entry is created — this is what
// makes signup "auto-register" the student, as requested. The same matric
// number can exist independently in a different stream without conflict,
// since credentials are now keyed by (stream_id, matric).
async function studentSignup(streamId, matricRaw, name, email, passwordHash) {
  const matric = matricRaw.trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingCred = await client.query('SELECT 1 FROM student_credentials WHERE stream_id = $1 AND matric = $2', [streamId, matric]);
    if (existingCred.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'That matric number is already registered — try signing in instead.' };
    }
    const { rows } = await client.query('SELECT data, version FROM app_state WHERE stream_id = $1 FOR UPDATE', [streamId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'This class could not be found — check the join link.' };
    }
    const data = rows[0].data;
    const version = rows[0].version;

    let student = (data.students || []).find(
      (s) => (s.roll || '').trim().toUpperCase() === matric
    );
    if (student) {
      if (name) student.name = name;
      if (email) student.email = email;
    } else {
      student = {
        id: 'stu-' + crypto.randomBytes(6).toString('hex'),
        roll: matricRaw.trim(),
        name: name || matricRaw.trim(),
        email: email || '',
      };
      if (!data.students) data.students = [];
      data.students.push(student);
    }

    await client.query(
      'INSERT INTO student_credentials (stream_id, matric, student_id, password_hash) VALUES ($1, $2, $3, $4)',
      [streamId, matric, student.id, passwordHash]
    );
    await client.query(
      'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE stream_id = $3',
      [data, version + 1, streamId]
    );
    await client.query('COMMIT');
    return {
      ok: true,
      student: { id: student.id, name: student.name, roll: student.roll, email: student.email },
      version: version + 1,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function studentCredential(streamId, matricRaw) {
  const matric = matricRaw.trim().toUpperCase();
  const { rows } = await pool.query(
    'SELECT student_id, password_hash FROM student_credentials WHERE stream_id = $1 AND matric = $2',
    [streamId, matric]
  );
  return rows[0] || null;
}

async function findStudentById(streamId, studentId) {
  const { data } = await getState(streamId);
  return (data.students || []).find((s) => s.id === studentId) || null;
}

async function saveFile(streamId, filename, mimeType, buffer) {
  const id = 'file-' + crypto.randomBytes(8).toString('hex');
  await pool.query(
    'INSERT INTO files (id, stream_id, filename, mime_type, size_bytes, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, streamId, filename, mimeType || 'application/octet-stream', buffer.length, buffer]
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

// Frees a matric number directly by deleting its credential row, with no
// dependency on a matching roster entry existing. Exists specifically for
// registrations that got orphaned before removeStudent cleaned up
// credentials on removal (or from any other stuck state) — the roster
// row is long gone, so there's nothing left to click "Remove" on, but
// the matric is still locked. Scoped to the calling Governor's own
// stream, so this can never touch another stream's matric numbers.
async function releaseMatric(streamId, matricRaw) {
  const result = await pool.query('DELETE FROM student_credentials WHERE stream_id = $1 AND matric = $2', [streamId, matricRaw.trim().toUpperCase()]);
  return result.rowCount > 0;
}

async function resetStudentPassword(streamId, studentId, passwordHash) {
  const result = await pool.query(
    'UPDATE student_credentials SET password_hash = $1 WHERE stream_id = $2 AND student_id = $3',
    [passwordHash, streamId, studentId]
  );
  return result.rowCount > 0;
}

// Removing a student needs to touch three places, not just the roster:
// their credential row (student_credentials, keyed by matric) and their
// saved chat history (assistant_chats) both live outside the app_state
// document on purpose — the same separation that protects passwords from
// a Governor's save also means removing a student from the roster alone
// does NOT free up their matric number. Without this, a removed student
// could never sign up again with the same matric, since the orphaned
// credential row would still match. Scoped to streamId throughout so a
// Governor can only ever remove students from their own stream.
async function removeStudent(streamId, studentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data, version FROM app_state WHERE stream_id = $1 FOR UPDATE', [streamId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, removed: false };
    }
    const data = rows[0].data;
    const version = rows[0].version;

    const target = (data.students || []).find((s) => s.id === studentId);
    const before = (data.students || []).length;
    data.students = (data.students || []).filter((s) => s.id !== studentId);
    const removed = before !== data.students.length;

    await client.query(
      'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE stream_id = $3',
      [data, version + 1, streamId]
    );
    await client.query('DELETE FROM student_credentials WHERE stream_id = $1 AND student_id = $2', [streamId, studentId]);
    // Also clear by matric number directly, not just by this row's id. If
    // an older duplicate roster entry (from before duplicate-matric
    // checks existed, or from a bulk CSV import that matched loosely)
    // left credentials pointing at a *different* id than the one being
    // removed here, deleting only by student_id would leave that matric
    // number permanently locked even though every visible roster row for
    // it is gone. Removing a student should always free up their matric.
    if (target && target.roll) {
      await client.query('DELETE FROM student_credentials WHERE stream_id = $1 AND matric = $2', [streamId, target.roll.trim().toUpperCase()]);
    }
    await client.query('DELETE FROM assistant_chats WHERE identity = $1', ['student:' + streamId + ':' + studentId]);
    await client.query('DELETE FROM assistant_conversations WHERE identity = $1', ['student:' + streamId + ':' + studentId]);
    await client.query('DELETE FROM cgpa_records WHERE student_id = $1', [studentId]);
    await client.query('COMMIT');
    return { ok: true, removed, version: version + 1 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Runs lazily on read, not on a schedule — there's no background job
// runner here, so this is triggered by ordinary traffic instead. A cheap
// unlocked check runs first so a normal request doesn't pay for a row
// lock; only when something is actually past its window does it take the
// lock and do the write. Each session is marked `finalized` once handled
// so this is a one-time transition, not something that reprocesses every
// request forever. Scoped to one stream's row — each stream's attendance
// windows close independently of every other stream's.
async function finalizeExpiredSessions(streamId) {
  const { rows } = await pool.query('SELECT data FROM app_state WHERE stream_id = $1', [streamId]);
  if (!rows.length) return;
  const now = Date.now();
  const needsWork = (rows[0].data.attendanceSessions || []).some(
    (s) => !s.finalized && new Date(s.endsAt).getTime() <= now
  );
  if (!needsWork) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query('SELECT data, version FROM app_state WHERE stream_id = $1 FOR UPDATE', [streamId]);
    if (!locked.length) {
      await client.query('ROLLBACK');
      return;
    }
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
        'UPDATE app_state SET data = $1, version = $2, updated_at = now() WHERE stream_id = $3',
        [data, version + 1, streamId]
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

const MAX_SAVED_MESSAGES = 60;

// Lightweight — just enough to render a conversation list without pulling
// every saved message for every thread. `identity` already embeds the
// stream (see auth.js), so this can never cross a stream boundary.
async function listConversations(identity, courseId) {
  const { rows } = await pool.query(
    'SELECT id, title, created_at, updated_at FROM assistant_conversations WHERE identity = $1 AND course_id = $2 ORDER BY updated_at DESC',
    [identity, courseId]
  );
  return rows;
}

// Scoped to identity so one student can never fetch another's saved
// conversation just by guessing or reusing an id.
async function getConversation(identity, id) {
  const { rows } = await pool.query(
    'SELECT id, course_id, title, messages FROM assistant_conversations WHERE id = $1 AND identity = $2',
    [id, identity]
  );
  return rows[0] || null;
}

async function createConversation(identity, courseId) {
  const id = 'conv-' + crypto.randomBytes(8).toString('hex');
  await pool.query(
    'INSERT INTO assistant_conversations (id, identity, course_id) VALUES ($1, $2, $3)',
    [id, identity, courseId]
  );
  return id;
}

// Title is set once, from the first question, and left alone after —
// so a conversation's name in the list stays stable even as it grows.
async function appendToConversation(identity, id, messages, titleIfUnset) {
  const trimmed = messages.slice(-MAX_SAVED_MESSAGES);
  const { rows } = await pool.query(
    `UPDATE assistant_conversations
     SET messages = $1, updated_at = now(), title = CASE WHEN title = '' THEN $2 ELSE title END
     WHERE id = $3 AND identity = $4
     RETURNING title`,
    [JSON.stringify(trimmed), titleIfUnset.slice(0, 80), id, identity]
  );
  return { messages: trimmed, title: rows.length ? rows[0].title : titleIfUnset };
}

async function deleteConversation(identity, id) {
  const result = await pool.query('DELETE FROM assistant_conversations WHERE id = $1 AND identity = $2', [id, identity]);
  return result.rowCount > 0;
}

async function getCgpaRecord(studentId) {
  const { rows } = await pool.query('SELECT semesters FROM cgpa_records WHERE student_id = $1', [studentId]);
  return rows.length ? rows[0].semesters : [];
}

async function saveCgpaRecord(streamId, studentId, semesters) {
  await pool.query(
    `INSERT INTO cgpa_records (student_id, stream_id, semesters, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (student_id)
     DO UPDATE SET semesters = $3, updated_at = now()`,
    [studentId, streamId, JSON.stringify(semesters)]
  );
}

module.exports = {
  pool, init, DEFAULT_DATA,
  createStream, getStreamByEmail, getStreamByJoinCode, getStreamById,
  getState, setState, signInAttendance, studentSignup, studentCredential, findStudentById,
  resetStudentPassword, removeStudent, releaseMatric, saveFile, getFile, getFileText,
  finalizeExpiredSessions, listConversations, getConversation, createConversation,
  appendToConversation, deleteConversation, getCgpaRecord, saveCgpaRecord,
  getStreamForAdmin, listStreamsForAdmin, adminResetGovernorPassword, regenerateJoinCode,
  deleteStreamCascade, logAdminAction, listAdminAuditLog, setStreamStatus,
};
