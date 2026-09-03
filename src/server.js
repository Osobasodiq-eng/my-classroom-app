require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('./db');
const livekit = require('./livekit');
const {
  governorSignup, login, requireGovernor, resolveJoinCode, getMyStream,
  studentSignup, studentLogin, requireStudent, resetStudentPassword, requireAnyAuth,
  adminLogin, requireAdmin,
} = require('./auth');
const { askAssistant, listConversations, getConversationHandler, deleteConversationHandler } = require('./assistant');

// This same codebase runs as one of two things, chosen by ADMIN_ONLY:
// the ordinary Governor/student app (the default), or the admin
// backoffice — never both from the same process. Deploying them as two
// separate services (see render.yaml) is what gives the backoffice its
// own URL, not just its own path: a path on the same domain is still
// reachable by anyone who guesses it, even if they can't log in. A
// separate service means the main app's domain has zero admin routes,
// zero admin.html, nothing to find at all.
const ADMIN_ONLY = String(process.env.ADMIN_ONLY || '').trim().toLowerCase() === 'true';

// GOVERNOR_PASSWORD is no longer required — Governors now sign themselves
// up with their own email/password instead of sharing one operator-set
// password. It's still read (optionally) by the one-time migration in
// db.js, to keep a pre-existing single-tenant deployment's Governor able
// to sign in after upgrading.
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
if (ADMIN_ONLY) REQUIRED_ENV.push('ADMIN_EMAIL', 'ADMIN_PASSWORD'); // pointless to run this deploy without them
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill these in (see README.md).');
  process.exit(1);
}
// Live class calls are optional — without LIVEKIT_API_KEY/
// LIVEKIT_API_SECRET/LIVEKIT_URL, /api/calls routes will fail with a
// clear error rather than the whole server refusing to boot, the same
// way GROQ_API_KEY works for the study assistant.
if (!ADMIN_ONLY && (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_URL)) {
  console.warn('LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL not set — live class calls are disabled until all three are set.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, mode: ADMIN_ONLY ? 'admin' : 'app' }));

if (ADMIN_ONLY) {
  // ---------- Admin backoffice service ----------
  // Everything here can see across every stream — the one deliberate
  // exception to "streams are fully walled off." Every route logs to
  // admin_audit_log, including plain reads, so that exception leaves a
  // trail rather than being silent. This is read-only with respect to a
  // stream's actual class data: an admin can view it for support
  // purposes, reset a Governor's password, regenerate a join code, or
  // delete a stream outright, but cannot edit roster/attendance/
  // materials content directly — that stays the Governor's own action,
  // done through their own account, on the other service.

  app.post('/api/admin/login', adminLogin);

  app.get('/api/admin/streams', requireAdmin, async (req, res) => {
    try {
      const streams = await db.listStreamsForAdmin();
      await db.logAdminAction('list_streams', null, null);
      res.json({ streams });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load streams.' });
    }
  });

  // A new stream is unusable — no class data changes, no student
  // signups — until one of these two is called. Kept as two explicit
  // endpoints (rather than one generic "set status") so each is its own
  // clearly-named, clearly-logged action.
  app.post('/api/admin/streams/:id/approve', requireAdmin, async (req, res) => {
    try {
      const ok = await db.setStreamStatus(req.params.id, 'approved');
      if (!ok) return res.status(404).json({ error: 'Stream not found.' });
      await db.logAdminAction('approve_stream', req.params.id, null);
      res.json({ ok: true, status: 'approved' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not approve the stream.' });
    }
  });

  app.post('/api/admin/streams/:id/reject', requireAdmin, async (req, res) => {
    try {
      const ok = await db.setStreamStatus(req.params.id, 'rejected');
      if (!ok) return res.status(404).json({ error: 'Stream not found.' });
      await db.logAdminAction('reject_stream', req.params.id, null);
      res.json({ ok: true, status: 'rejected' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not reject the stream.' });
    }
  });

  app.get('/api/admin/streams/:id', requireAdmin, async (req, res) => {
    try {
      const stream = await db.getStreamForAdmin(req.params.id);
      if (!stream) return res.status(404).json({ error: 'Stream not found.' });
      const { data, version } = await db.getState(req.params.id);
      await db.logAdminAction('view_stream', req.params.id, null);
      res.json({ stream, data, version });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load that stream.' });
    }
  });

  app.post('/api/admin/streams/:id/reset-governor-password', requireAdmin, async (req, res) => {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Choose a password of at least 6 characters.' });
    }
    try {
      const passwordHash = await bcrypt.hash(String(newPassword), 10);
      const ok = await db.adminResetGovernorPassword(req.params.id, passwordHash);
      if (!ok) return res.status(404).json({ error: 'Stream not found.' });
      await db.logAdminAction('reset_governor_password', req.params.id, null);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not reset the password.' });
    }
  });

  app.post('/api/admin/streams/:id/regenerate-join-code', requireAdmin, async (req, res) => {
    try {
      const newCode = await db.regenerateJoinCode(req.params.id);
      if (!newCode) return res.status(404).json({ error: 'Stream not found.' });
      await db.logAdminAction('regenerate_join_code', req.params.id, 'new code: ' + newCode);
      res.json({ joinCode: newCode });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not regenerate the join code.' });
    }
  });

  app.delete('/api/admin/streams/:id', requireAdmin, async (req, res) => {
    try {
      const ok = await db.deleteStreamCascade(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Stream not found.' });
      await db.logAdminAction('delete_stream', req.params.id, null);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not delete the stream.' });
    }
  });

  app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
    try {
      const entries = await db.listAdminAuditLog();
      res.json({ entries });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load the audit log.' });
    }
  });

  // Every path on this service serves the same single-page admin app —
  // there is no Governor/student UI here at all, not even to redirect to.
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });
} else {
  // ---------- Main app service (Governor + student) ----------
  // Files are held in memory only long enough to write them to Postgres —
  // nothing is written to local disk, which matters on Render's free tier
  // where disk contents don't persist between deploys anyway.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB cap

  // Every stream is fully walled off from every other on this service —
  // there is deliberately no "list all streams" or "read any stream's
  // data" route anywhere below. The only way in is a Governor's own
  // email/password, or a student's own join code + account. (The one
  // exception, the admin backoffice, lives entirely on a separate
  // service — see the ADMIN_ONLY branch above and render.yaml.)

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

  // A stream that hasn't been approved by an admin yet exists (the
  // Governor can sign in, the row is real) but can't be used for actual
  // class administration — this is the gate that enforces that. Kept
  // separate from requireGovernor itself so identity/auth stays a
  // distinct concern from "is this stream allowed to operate yet."
  async function requireApprovedStream(req, res, next) {
    try {
      const stream = await db.getStreamById(req.streamId);
      if (!stream) return res.status(404).json({ error: 'Stream not found.' });
      if (stream.status !== 'approved') {
        return res.status(403).json({
          error: stream.status === 'rejected'
            ? 'This stream was not approved and can\'t be used. Contact support if you believe this is a mistake.'
            : 'This stream is awaiting admin approval — you\'ll be able to make changes once it\'s approved.',
          status: stream.status,
        });
      }
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not verify stream status.' });
    }
  }

  app.post('/api/auth/governor-signup', governorSignup);
  app.post('/api/auth/login', login);
  app.get('/api/streams/by-code/:code', resolveJoinCode);
  app.post('/api/auth/student-signup', studentSignup);
  app.post('/api/auth/student-login', studentLogin);
  // Lets a signed-in Governor re-check their own stream's current
  // approval status at any time — their token is issued once at login
  // and doesn't update itself if an admin approves the stream mid-session.
  app.get('/api/streams/me', requireGovernor, getMyStream);
  app.post('/api/students/:studentId/reset-password', requireGovernor, requireApprovedStream, resetStudentPassword);
  app.delete('/api/students/:studentId', requireGovernor, requireApprovedStream, async (req, res) => {
    try {
      const result = await db.removeStudent(req.streamId, req.params.studentId);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not remove the student — try again.' });
    }
  });
  app.delete('/api/matric/:matric', requireGovernor, requireApprovedStream, async (req, res) => {
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

  // ---------- Live class calls ----------
  // Governor and student, in a Governor's own stream, join the SAME
  // LiveKit room — a room's name is unguessable and unique to a single
  // stream's call, and every route below re-checks stream ownership
  // before handing out a join token. There's no explicit "create room"
  // call to LiveKit at all: a room is created automatically the moment
  // the first token is used to join it, and closes itself once everyone
  // leaves — one less thing that can fail compared to a provider that
  // needs a room provisioned up front.
  //
  // Recording is NOT implemented yet on this provider — the
  // call_recordings table and its read routes below are kept (so the
  // frontend's "Past calls" list keeps working, just showing no
  // recordings), but nothing currently writes to that table. Adding
  // LiveKit Egress-based recording is a distinct follow-up, not part of
  // this swap from Daily.

  app.post('/api/calls', requireGovernor, requireApprovedStream, async (req, res) => {
    const roomName = 'stream-' + req.streamId.replace(/^stream-/, '') + '-' + Date.now().toString(36);
    try {
      const roomId = await db.createCallRoom(req.streamId, roomName, req.body && req.body.title);
      const token = await livekit.createToken(roomName, { isOwner: true, identity: 'governor', name: 'Governor' });
      res.json({ roomId, wsUrl: process.env.LIVEKIT_URL, token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Could not start the call.' });
    }
  });

  app.post('/api/calls/:id/token', requireAnyAuth, async (req, res) => {
    try {
      const room = await db.getCallRoom(req.streamId, req.params.id);
      if (!room || room.status !== 'active') return res.status(404).json({ error: 'This call is not active.' });
      const isOwner = req.auth.role === 'governor';
      const identity = isOwner ? 'governor' : 'student-' + req.auth.studentId;
      const name = isOwner ? 'Governor' : ((req.body && req.body.name) || 'Student');
      const token = await livekit.createToken(room.daily_room_name, { isOwner, identity, name });
      res.json({ wsUrl: process.env.LIVEKIT_URL, token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Could not join the call.' });
    }
  });

  app.post('/api/calls/:id/end', requireGovernor, requireApprovedStream, async (req, res) => {
    try {
      const room = await db.getCallRoom(req.streamId, req.params.id);
      if (!room) return res.status(404).json({ error: 'Call not found.' });
      await db.endCallRoom(req.streamId, req.params.id);
      await livekit.endRoom(room.daily_room_name); // disconnects everyone still in it
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not end the call.' });
    }
  });

  app.get('/api/calls', requireAnyAuth, async (req, res) => {
    try {
      const rooms = await db.listCallRooms(req.streamId);
      res.json({ rooms });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load calls.' });
    }
  });

  app.get('/api/calls/:id/recordings', requireAnyAuth, async (req, res) => {
    try {
      const room = await db.getCallRoom(req.streamId, req.params.id);
      if (!room) return res.status(404).json({ error: 'Call not found.' });
      const recordings = await db.listRecordingsForRoom(req.streamId, req.params.id);
      res.json({ recordings });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load recordings.' });
    }
  });

  // Nothing writes to call_recordings yet (see note above) so this will
  // currently always 404 — kept in place, unchanged in shape, for when
  // recording is actually added rather than needing another route
  // rewrite at that point.
  app.get('/api/recordings/:id/link', requireAnyAuth, async (req, res) => {
    try {
      const recording = await db.getRecording(req.streamId, req.params.id);
      if (!recording) return res.status(404).json({ error: 'Recording not found.' });
      if (recording.status !== 'ready') return res.status(409).json({ error: 'This recording is still processing.' });
      res.status(501).json({ error: 'Recording playback is not implemented for this provider yet.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load the recording.' });
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

  app.put('/api/state', requireGovernor, requireApprovedStream, async (req, res) => {
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
  app.post('/api/checkin/:code/signin', requireStudent, requireApprovedStream, async (req, res) => {
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
  app.post('/api/files', requireGovernor, requireApprovedStream, upload.single('file'), async (req, res) => {
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
}

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Course Governor server (${ADMIN_ONLY ? 'admin' : 'app'} mode) listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
