// Server-side LiveKit integration, using the official livekit-server-sdk
// rather than hand-rolling JWT construction or their Twirp-based REST
// protocol — both are easy to get subtly wrong, and the SDK is the
// vendor-maintained source of truth for both.
//
// Written against LiveKit's documented token/room APIs
// (https://docs.livekit.io) without a live project to test against from
// this sandbox (no outbound network access here). The first real call
// with real LIVEKIT_* credentials is the actual test.

const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

function requireConfig() {
  if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_URL) {
    throw new Error('LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL is not set — live class calls are disabled until they are.');
  }
}

// No separate "create room" call exists here on purpose — unlike Daily,
// a LiveKit room is created automatically the moment the first
// participant's token is used to join it, and it closes automatically
// once everyone leaves. One less moving part, one less thing to fail.
async function createToken(roomName, { isOwner, identity, name }) {
  requireConfig();
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: '4h',
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  // isOwner isn't turned into a special LiveKit grant here — the
  // meaningful "owner" power (ending the call for everyone) is enforced
  // on our own backend route, via requireGovernor, not via anything
  // baked into this token. Kept as a parameter for the join UI to know
  // whose name to show as "Governor" without a second lookup.
  return at.toJwt();
}

// The server SDK's RoomServiceClient talks over plain HTTP(S), not the
// wss:// URL clients use to actually join a call — same host, different
// scheme.
function roomServiceClient() {
  requireConfig();
  const httpUrl = process.env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return new RoomServiceClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
}

// Ends a call for everyone immediately — deleting the room disconnects
// every participant still in it. Safe to call even if the room already
// closed itself (e.g. everyone already left) — that's a normal outcome,
// not an error worth surfacing to the Governor.
async function endRoom(roomName) {
  try {
    await roomServiceClient().deleteRoom(roomName);
  } catch (err) {
    console.warn('Could not delete LiveKit room (may already be gone):', err.message);
  }
}

module.exports = { createToken, endRoom };
