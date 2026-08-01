/**
 * Wire protocol for the PvP relay (plan.md Phase 2.2, spec-online-pvp.md §6-§8).
 *
 * Every message is JSON with a top-level `type` string, no envelope/versioning
 * beyond that -- small team, no speculative protocol machinery.
 *
 * The relay is a pure opaque passthrough for gameplay content: `action`
 * messages carry whatever payload the client sends (play card / target /
 * end turn / etc.) and the server never inspects or validates that payload's
 * *contents* -- see spec-online-pvp.md §6.3 (per-client RNG authority) and
 * the plan's explicit "no game-rule interpretation" scope boundary. The
 * server only knows about rooms, connections, and the handful of message
 * types below that it needs to interpret for bookkeeping.
 *
 * ---------------------------------------------------------------------------
 * Client -> Server
 * ---------------------------------------------------------------------------
 * room_create   {}
 *   Create a new room. Server replies ROOM_CREATED with a generated code.
 *
 * room_join     { code }
 *   Join (or reconnect to) a room by its code. Server replies ROOM_JOINED to
 *   the joiner and OPPONENT_JOINED/OPPONENT_RECONNECTED to the other player
 *   already in the room, if any.
 *
 * leave_room    {}
 *   Voluntarily leave the current room (spec §6.2 "뒤로" button). If no
 *   opponent has joined yet, the room is discarded outright. Otherwise this
 *   is treated the same as a disconnect (see OPPONENT_DISCONNECTED below).
 *
 * action        { payload }
 *   Opaque passthrough -- play card / target / end turn / whatever the
 *   client-side game engine wants to send. `payload` is forwarded verbatim
 *   to the other player in the room as an ACTION message; the server does
 *   not validate or interpret its contents.
 *
 * report_result { result: 'win' | 'loss' }
 *   Sent by a client when its own (client-authoritative, per spec §6.4)
 *   game logic determines the match is over. Relayed to both players as
 *   MATCH_ENDED. NOTE: this phase does NOT write to match_history (plan.md
 *   2.6) -- that's deferred; see the handler for the TODO.
 *
 * claim_forfeit {}
 *   "기권승 처리하기" (spec §8.2) -- claim a win because the opponent is
 *   disconnected. Server only sanity-checks that the opponent is currently
 *   marked disconnected in this room. It does NOT yet enforce the 10s floor
 *   before the button may be used, nor the 45s auto-forfeit -- both are
 *   plan.md 2.7, deferred.
 *
 * ---------------------------------------------------------------------------
 * Server -> Client
 * ---------------------------------------------------------------------------
 * room_created            { code }
 * room_joined              { code, opponent: { displayName } | null, reconnected }
 * opponent_joined           { opponent: { displayName } }
 * opponent_disconnected     { disconnectedAt: <ms epoch> }
 * opponent_reconnected      { opponent: { displayName } }
 * action                    { payload, from: <sender displayName> }
 * match_ended               { result: 'win' | 'loss' | 'win_forfeit', reason }
 *                              reason: 'client_reported' | 'forfeit_claimed'
 * error                     { code, message }
 *
 * ---------------------------------------------------------------------------
 * Server -> Client, SHAPE-ONLY for now (plan.md 2.5) -- not emitted by any
 * code path yet. Defined here so the wire format doesn't need to change
 * later, per this session's explicit scope (2.1-2.3 only).
 * ---------------------------------------------------------------------------
 * turn_started  { activeAccountId, deadline: <ms epoch> }
 *   Server stamps `deadline` = turn-start time + 24000ms (spec §7.3); both
 *   clients render the same countdown from this one server-issued value
 *   instead of computing it locally. NOT implemented: the relay currently
 *   has no visibility into turn boundaries, because `action` payloads are
 *   opaque by design (see above). Whoever picks up 2.5 will need to either
 *   special-case an `end_turn` action type or introduce a dedicated
 *   non-opaque message for it -- left as an open decision for that task
 *   rather than guessed at here.
 *
 * turn_timeout  { accountId }
 *   Server fires this itself when a turn's deadline elapses with no
 *   end-turn from the active player (spec §7.3). Not implemented.
 */

const TYPE = {
  // client -> server
  ROOM_CREATE: 'room_create',
  ROOM_JOIN: 'room_join',
  LEAVE_ROOM: 'leave_room',
  ACTION: 'action',
  REPORT_RESULT: 'report_result',
  CLAIM_FORFEIT: 'claim_forfeit',

  // server -> client
  ROOM_CREATED: 'room_created',
  ROOM_JOINED: 'room_joined',
  OPPONENT_JOINED: 'opponent_joined',
  OPPONENT_DISCONNECTED: 'opponent_disconnected',
  OPPONENT_RECONNECTED: 'opponent_reconnected',
  MATCH_ENDED: 'match_ended',
  ERROR: 'error',

  // server -> client, shape-only / not yet emitted (plan.md 2.5)
  TURN_STARTED: 'turn_started',
  TURN_TIMEOUT: 'turn_timeout',
};

function errorMessage(code, message) {
  return { type: TYPE.ERROR, code, message };
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

module.exports = { TYPE, errorMessage, sendJson };
