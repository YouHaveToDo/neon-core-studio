/**
 * In-memory room bookkeeping for the relay (plan.md Phase 2.1/2.3).
 *
 * Pure process memory, no DB -- rooms are ephemeral matchmaking/relay state,
 * not persisted data (match results, once 2.6 lands, are what gets written
 * to Postgres; the room itself never is). This also means rooms don't
 * survive a server restart -- acceptable for an MVP relay per the "small
 * team, don't over-build" principle; revisit only if that becomes a real
 * problem (e.g. multi-instance horizontal scaling would need this moved to
 * shared storage, but a single ~$7/mo Render instance doesn't).
 */

const crypto = require('crypto');

// spec-online-pvp.md §6.2.4 (2026-08 revision): this is now purely an
// internal relay identifier -- no player ever reads, types, or copies it by
// hand anymore (the room-list screen is what replaces the old "share this
// code" flow, see routes/rooms.js's listOpenRooms()). The original
// ambiguity-avoiding charset (excludes 0/O/1/I) is harmless to keep even
// though the reason it existed no longer applies -- changing the ID format
// isn't needed just because its exposure changed, and keeping it avoids
// touching every place that still assumes a 6-char code (protocol.js's
// room_create/room_join shape, the existing smoke tests).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** code -> Room */
const rooms = new Map();

/** ws -> { code, accountId }, so the close handler can find what to clean up */
const socketMeta = new WeakMap();

function generateCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(creator) {
  const code = generateCode();
  const room = {
    code,
    players: [{ ...creator, connected: true, disconnectedAt: null, graceTimeoutHandle: null, graceExpired: false }],
    createdAt: Date.now(),
    ended: false,
    // Turn-timer state (plan.md 2.5/2.7), null until start_match arrives.
    // Shape while a turn is actively counting down:
    //   { activeAccountId, deadline: <ms epoch>, remainingMs: null, timeoutHandle }
    // Shape while paused (opponent disconnected mid-turn, spec §8.2):
    //   { activeAccountId, deadline: null, remainingMs: <ms left>, timeoutHandle: null }
    turn: null,
    matchStarted: false,
    // Set true by claimResult() the instant any match-end path (report_result,
    // claim_forfeit/auto-forfeit, double-disconnect void) starts resolving
    // this room -- see claimResult()'s own doc comment for why this needs to
    // be a synchronous flag rather than relying on the room being deleted
    // only after the DB write finishes.
    resultClaimed: false,
  };
  rooms.set(code, room);
  socketMeta.set(creator.ws, { code, accountId: creator.accountId });
  return room;
}

function getRoom(code) {
  return rooms.get(code) || null;
}

/**
 * Open (waiting-for-second-player) rooms, newest-first -- backs the
 * room-list screen (spec §6.2.1-§6.2.3). "Open" means exactly: exactly one
 * player in it (the host, still connected -- see below), and the match
 * hasn't started. A full (2-player) room, whether mid-match or one side
 * currently disconnected/reconnecting, is deliberately excluded -- spec
 * §6.2 only ever describes the list as a way to find a HOST WAITING FOR AN
 * OPPONENT, never a way to spectate or barge into a room that already has
 * two players in some state. Rejoining a full room you're already part of
 * still goes through room_join's reconnect branch above, unrelated to this
 * list.
 *
 * A solo room's host is always `connected` here: markDisconnected() deletes
 * a solo room outright the instant its only player's socket closes (see
 * that function's own doc comment), so there's no "host disconnected but
 * the room is still sitting in the list" state to filter out separately.
 */
function listOpenRooms() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.ended || room.matchStarted) continue;
    if (room.players.length !== 1) continue;
    const host = room.players[0];
    list.push({ id: room.code, hostDisplayName: host.displayName, createdAt: room.createdAt });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

function findPlayer(room, accountId) {
  return room.players.find((p) => p.accountId === accountId) || null;
}

function opponentOf(room, accountId) {
  return room.players.find((p) => p.accountId !== accountId) || null;
}

/**
 * Join or reconnect to a room by code.
 * Returns { ok: true, room, reconnected } or { ok: false, error }.
 * error is one of: 'ROOM_NOT_FOUND' | 'ROOM_FULL'
 */
function joinRoom(code, player) {
  const room = rooms.get(code);
  if (!room || room.ended) {
    return { ok: false, error: 'ROOM_NOT_FOUND' };
  }

  const existing = findPlayer(room, player.accountId);
  if (existing) {
    // Same account rejoining a room it's already part of == reconnect
    // (spec §8.3: same session, connection resumed).
    existing.ws = player.ws;
    existing.connected = true;
    existing.disconnectedAt = null;
    // A fresh reconnect always means "no grace period has expired for this
    // player right now" -- reset so a LATER disconnect in the same room
    // (e.g. they drop again after reconnecting) is judged on its own merits
    // rather than being treated as "already expired" from a previous cycle
    // (QA finding #2's double-disconnect void resolution relies on this
    // flag meaning "expired since the MOST RECENT disconnect", see
    // ws/server.js's onDisconnectGraceExpired).
    existing.graceExpired = false;
    socketMeta.set(player.ws, { code, accountId: player.accountId });
    return { ok: true, room, reconnected: true };
  }

  if (room.players.length >= 2) {
    return { ok: false, error: 'ROOM_FULL' };
  }

  room.players.push({ ...player, connected: true, disconnectedAt: null, graceTimeoutHandle: null, graceExpired: false });
  socketMeta.set(player.ws, { code, accountId: player.accountId });
  return { ok: true, room, reconnected: false };
}

/**
 * Starts the match's first turn (plan.md 2.5). No-op (returns false) if
 * already started or the room isn't full yet -- callers should treat that
 * as "ignore/idempotent", not a hard error, since either client may send
 * `start_match` and only the first one should take effect.
 */
function startMatch(room, firstAccountId) {
  if (room.matchStarted) return false;
  if (room.players.length < 2) return false;
  if (!findPlayer(room, firstAccountId)) return false;
  room.matchStarted = true;
  return true;
}

/**
 * Claims the right to resolve (record + tear down) this room's match result.
 * Returns true exactly once per room -- every subsequent call (whether from
 * a second `report_result`, a racing `claim_forfeit`, or a second grace-
 * timer expiry) returns false and should be treated as an idempotent no-op,
 * same convention as startMatch() above.
 *
 * This exists because `rooms.getRoom(code)` staying non-null is NOT by
 * itself a safe "hasn't been resolved yet" check: the room is only deleted
 * (via endRoom()) strictly AFTER the async recordMatchResult()/
 * recordVoidMatch() DB write finishes. Two near-simultaneous match-end
 * events (e.g. both clients' report_result for the same match, spec §6.4 --
 * or, equivalently, both sides' disconnect-grace timers expiring close
 * together) can both pass a `getRoom` check and both start their own DB
 * write before either finishes tearing the room down, double-recording the
 * match and double-awarding Ink. claimResult() must be called synchronously
 * -- before any `await` -- so the check-and-set can't be interleaved by the
 * event loop the way the old "room still exists" check could be.
 */
function claimResult(room) {
  if (room.resultClaimed) return false;
  room.resultClaimed = true;
  return true;
}

/**
 * Mark the player owning `ws` as disconnected (socket closed).
 *
 * A SOLO room (nobody else ever joined -- e.g. a host who closed the tab
 * while still waiting in the lobby) is deleted immediately, same as always:
 * there is no opponent who could ever reconnect into it, so keeping it
 * around would just leak memory forever.
 *
 * A FULL (2-player) room is deliberately NOT deleted here anymore, even if
 * this disconnect leaves BOTH players marked disconnected (a genuinely
 * simultaneous double-disconnect -- QA finding #2, docs/qa/online-pvp-
 * milestone.md). The old behavior deleted the room outright the instant no
 * player was connected, which canceled whatever grace timer(s) the caller
 * (ws/server.js's handleClose) was about to arm and left the match silently
 * unresolved for both sides -- no forfeit, no match_history row, no
 * reconnect path. Now the room stays alive so each disconnected player's
 * normal 45s grace timer can run its course: either side reconnecting in
 * time resumes the match as usual, and ws/server.js's
 * onDisconnectGraceExpired() resolves the room (forfeit, or a 'void'
 * no-contest if BOTH grace periods expire with nobody back) instead of this
 * function silently discarding it.
 *
 * Returns { room, player } or null if `ws` wasn't tracked in any room.
 */
function markDisconnected(ws) {
  const meta = socketMeta.get(ws);
  if (!meta) return null;
  const room = rooms.get(meta.code);
  if (!room) return null;
  const player = findPlayer(room, meta.accountId);
  if (!player) return null;

  player.connected = false;
  player.disconnectedAt = Date.now();
  player.ws = null;

  if (room.players.length < 2) {
    rooms.delete(room.code);
  }
  return { room, player };
}

function deleteRoom(code) {
  rooms.delete(code);
}

/** Match is over (result reported / forfeit claimed) -- discard the room. */
function endRoom(code) {
  const room = rooms.get(code);
  if (room) room.ended = true;
  rooms.delete(code);
}

module.exports = {
  createRoom,
  getRoom,
  listOpenRooms,
  joinRoom,
  findPlayer,
  opponentOf,
  markDisconnected,
  deleteRoom,
  endRoom,
  startMatch,
  claimResult,
};
