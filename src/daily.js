// Thin wrapper around Daily.co's REST API. Uses the global `fetch`
// built into Node 18+ rather than adding a new dependency — these are
// plain JSON HTTP calls, nothing an SDK buys much for.
//
// NOTE: written carefully against Daily's documented API shape, but
// without a live account to test against from this environment. The
// first real call against a real DAILY_API_KEY is the actual test —
// if Daily has changed a field name or endpoint since, this is the
// file to check first.

const DAILY_API_BASE = 'https://api.daily.co/v1';

function authHeaders() {
  if (!process.env.DAILY_API_KEY) {
    throw new Error('DAILY_API_KEY is not set — live class calls are disabled until it is.');
  }
  return {
    Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function dailyRequest(method, path, body) {
  const res = await fetch(DAILY_API_BASE + path, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Daily's error bodies carry two parts: `error` (a stable type
    // string) and `info` (the actually diagnostic human-readable detail,
    // per https://docs.daily.co/docs/create-and-manage-rooms-with-the-rest-api).
    // Picking only `error` silently threw away the useful half — this
    // was a real bug, not a Daily quirk, and it's why an earlier failure
    // only ever showed "invalid-request-error" with nothing else.
    const parts = [];
    if (json && json.error) parts.push(json.error);
    if (json && json.info) parts.push(json.info);
    const message = parts.length ? parts.join(': ') : `Daily API error (${res.status})`;
    throw new Error(message);
  }
  return json;
}

// Cloud recording is enabled on the room itself — this is what makes
// Daily's own Prebuilt call UI show a Record button to the room owner
// at all, so there's no separate "start recording" endpoint to call
// from our own backend; the Governor starts/stops it from inside the
// call, and the webhook (see server.js) tells us when a file is ready.
// exp is a Unix timestamp: rooms are set to self-delete a few hours
// after class ends, rather than accumulating unused rooms forever.
async function createRoom(name) {
  const expiresInSeconds = 6 * 60 * 60; // 6 hours — generous for one class session
  return dailyRequest('POST', '/rooms', {
    name,
    properties: {
      enable_recording: 'cloud',
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      eject_at_room_exp: true,
    },
  });
}

async function deleteRoom(name) {
  try {
    await dailyRequest('DELETE', `/rooms/${encodeURIComponent(name)}`);
  } catch (err) {
    // Already gone (expired, or never confirmed created) — not worth
    // failing the caller's request over.
    console.warn('Could not delete Daily room (may already be gone):', err.message);
  }
}

// isOwner controls whether Daily's Prebuilt UI shows the Governor's
// call-management controls (recording, removing participants) — this
// is the actual permission boundary, not anything checked client-side.
async function createMeetingToken(roomName, { isOwner, userName }) {
  const json = await dailyRequest('POST', '/meeting-tokens', {
    properties: {
      room_name: roomName,
      is_owner: !!isOwner,
      user_name: userName || undefined,
    },
  });
  return json.token;
}

// Recording download links are signed and expire after a few hours —
// this is called fresh every time someone wants to actually play a
// recording back, rather than storing one link permanently.
async function getRecordingAccessLink(dailyRecordingId) {
  const json = await dailyRequest('GET', `/recordings/${encodeURIComponent(dailyRecordingId)}/access-link`);
  return json.download_link;
}

module.exports = { createRoom, deleteRoom, createMeetingToken, getRecordingAccessLink };
