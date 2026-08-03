/**
 * Wire protocol for the PvP relay (plan.md Phase 2.2/2.5/2.6/2.7,
 * spec-online-pvp.md §6-§8).
 *
 * Every message is JSON with a top-level `type` string, no envelope/versioning
 * beyond that -- small team, no speculative protocol machinery.
 *
 * The relay is a pure opaque passthrough for gameplay content: `action`
 * messages carry whatever payload the client sends (play card / target /
 * etc.) and the server never inspects or validates that payload's *contents*
 * -- see spec-online-pvp.md §6.3 (per-client RNG authority) and the plan's
 * explicit "no game-rule interpretation" scope boundary. Two things the
 * server DOES need real (non-opaque) visibility into, because it's the
 * authority for them, are turn boundaries (2.5's timer) and match results
 * (2.6/2.7) -- those get their own dedicated message types below rather than
 * being inferred from `action` contents.
 *
 * ---------------------------------------------------------------------------
 * Client -> Server
 * ---------------------------------------------------------------------------
 * room_create   { deckSize }
 *   Create a new room. Server replies ROOM_CREATED with a generated code.
 *   `deckSize` (QA finding #3, docs/qa/online-pvp-milestone.md) is this
 *   client's own deck's real card count, known client-side by this point
 *   since deck selection (spec §6.1) always happens before the lobby (§6.2)
 *   -- relayed to the opponent (OPPONENT_JOINED) purely so their public
 *   deck-count display (spec §7.2) has a real number instead of guessing.
 *   Not validated/enforced here (20-30 range enforcement is entirely
 *   routes/decks.js's job, an existing boundary); an omitted/non-numeric
 *   value is just treated as "unknown" (null) rather than silently coerced.
 *
 * room_join     { code, deckSize }
 *   Join (or reconnect to) a room by its code. Server replies ROOM_JOINED to
 *   the joiner and OPPONENT_JOINED/OPPONENT_RECONNECTED to the other player
 *   already in the room, if any. On a reconnect, this also clears that
 *   player's 45s auto-forfeit grace timer (2.7) and, if both players are now
 *   connected again, resumes the paused turn timer (2.5) from wherever it
 *   was left off -- see ROOM_JOINED's `turn` field below. `deckSize`: same
 *   meaning/purpose as room_create's -- see above. On a reconnect, a
 *   missing/invalid value does NOT overwrite the deck size already recorded
 *   from this player's original join (deck size can't legitimately change
 *   mid-match, and a page-reload reconnect may not have it cached
 *   client-side anymore).
 *
 * leave_room    {}
 *   Voluntarily leave the current room (spec §6.2 "뒤로" button). If no
 *   opponent has joined yet, the room is discarded outright. Otherwise this
 *   is treated the same as a disconnect (see OPPONENT_DISCONNECTED below).
 *
 * action        { payload }
 *   Opaque passthrough -- play card / target / whatever the client-side game
 *   engine wants to send. `payload` is forwarded verbatim to the other
 *   player in the room as an ACTION message; the server does not validate or
 *   interpret its contents. Turn-end is NOT inferred from this -- see
 *   end_turn below.
 *
 * start_match   { firstAccountId }
 *   Signals "the match-start sequence (spec §6.3: coin flip, local
 *   shuffle/draw) is done on the client side, begin turn 1 for
 *   firstAccountId now." Either player may send this; only the first one to
 *   arrive takes effect (idempotent no-op after that, since both clients may
 *   race to send it). `firstAccountId` must be one of the two accounts in
 *   the room. Client/server responsibility split: the coin flip itself and
 *   agreeing on who won it is entirely a client-side (Phase 4) concern --
 *   this relay does not compute or arbitrate the coin flip, it just accepts
 *   whatever the client(s) report and starts the server-authoritative 24s
 *   timer from that point. Server replies (broadcast to both) with
 *   TURN_STARTED for firstAccountId's first turn.
 *
 * end_turn      {}
 *   Sent by the player whose turn it currently is, when their turn ends
 *   (manual "End Turn" click). This is the dedicated turn-boundary signal
 *   plan.md 2.5 flagged as needed instead of opaque `action` inspection.
 *   Rejected with NOT_YOUR_TURN if the sender isn't the active player.
 *   Strict two-player alternation means the server doesn't need the OTHER
 *   client to separately announce "my turn starts" -- ending player A's turn
 *   IS player B's turn starting, so the server immediately stamps a fresh
 *   24s deadline for B and broadcasts TURN_STARTED. See also TURN_TIMEOUT:
 *   the server fires the exact same turn-advance logic itself if end_turn
 *   never arrives in time.
 *
 * report_result { result: 'win' | 'loss' }
 *   Sent by a client when its own (client-authoritative, per spec §6.4)
 *   game logic determines the match is over. The server does not validate
 *   this against any game state (no server-side rule engine exists) --
 *   whichever client's report_result arrives FIRST is trusted, written to
 *   match_history for both accounts (2.6), relayed to both players as
 *   MATCH_ENDED, and the room is torn down immediately. A second
 *   report_result from the other client (e.g. if both clients call it
 *   independently) lands after the room is gone and just gets a harmless
 *   NOT_IN_ROOM error -- see ws/server.js for why "trust the first report"
 *   was chosen over "wait for/cross-check both."
 *
 * claim_forfeit {}
 *   "기권승 처리하기" (spec §8.2) -- claim a win because the opponent is
 *   disconnected. Server checks (a) the opponent is currently marked
 *   disconnected in this room, AND (b) at least CLAIM_FORFEIT_FLOOR_MS
 *   (spec: 10s) have elapsed since that disconnect was detected -- rejected
 *   with CLAIM_TOO_EARLY otherwise. On success, writes match_history (2.6,
 *   forfeit: true) the same way the 45s auto-forfeit path does.
 *
 * ---------------------------------------------------------------------------
 * Server -> Client
 * ---------------------------------------------------------------------------
 * room_created            { code }
 * room_joined              { code, opponent: { displayName, deckSize } | null,
 *                             reconnected,
 *                             turn: { activeAccountId, deadline } | null }
 *   `turn` reflects the room's current turn-timer state at the moment of
 *   joining/reconnecting (post-resume, if this join just resumed a paused
 *   timer) -- null if the match hasn't started yet or the timer is still
 *   paused waiting on the OTHER player to also reconnect. `opponent.deckSize`
 *   is null if the opponent hasn't reported one (QA finding #3) -- callers
 *   should treat null as "unknown", not as zero.
 * opponent_joined           { opponent: { displayName, deckSize } }
 * opponent_disconnected     { disconnectedAt: <ms epoch> }
 * opponent_reconnected      { opponent: { displayName } }
 * action                    { payload, from: <sender displayName> }
 * turn_started              { activeAccountId, deadline: <ms epoch> }
 *   Server-stamped deadline = the moment this message is sent + 24000ms
 *   (spec §7.3), or, on resume after a disconnect pause, + however much time
 *   was left when the pause started (spec §8.2: "멈췄던 지점부터 다시
 *   흐른다"). Both clients render the same countdown from this one
 *   server-issued value instead of computing it locally -- the entire point
 *   of server-side enforcement (spec §1.4/plan.md "confirmed
 *   server-enforced").
 * turn_timeout               { accountId }
 *   Server fires this itself when a turn's 24s deadline elapses with no
 *   end_turn from the active player. See the CLIENT/SERVER RESPONSIBILITY
 *   note below -- this event is the server's entire contribution to
 *   timeout handling; everything spec §7.3 describes as happening to the
 *   timed-out player's hand/selected-card is applied by that client itself
 *   in response to receiving this message (or, for the opponent's client,
 *   simply observing the turn switch normally).
 * match_ended                { result: 'win' | 'loss' | 'win_forfeit' | 'void', reason }
 *                               reason: 'client_reported' | 'forfeit_claimed'
 *                                       | 'disconnect_timeout' | 'double_disconnect'
 *   result: 'void' / reason: 'double_disconnect' (QA finding #2, docs/qa/
 *   online-pvp-milestone.md) is the outcome for a genuinely simultaneous
 *   double-disconnect: BOTH players' 45s grace periods expire with neither
 *   having reconnected, so there's no one left present to award a forfeit
 *   win to. Only ever sent to a socket that's still connected at that exact
 *   moment (rare in practice, since both sides are by definition
 *   disconnected when this fires) -- the real, durable record of this
 *   outcome is the match_history 'void' row written for both accounts
 *   regardless (see server/src/lib/matchHistory.js's recordVoidMatch),
 *   which is what actually matters since neither client is likely to be
 *   listening live when it happens.
 * error                       { code, message }
 *
 * ---------------------------------------------------------------------------
 * CLIENT / SERVER RESPONSIBILITY BOUNDARY for turn timeout (plan.md 2.5)
 * ---------------------------------------------------------------------------
 * Server's job: own the clock. Stamp deadlines, fire turn_timeout exactly
 * once per elapsed turn regardless of either client's local clock, advance
 * `activeAccountId` to the other player, and immediately start that
 * player's fresh 24s timer -- all of this happens even if BOTH clients are
 * frozen/crashed, because it lives in a server-side setTimeout, not a
 * client-driven message loop.
 *
 * Client's job (NOT implemented in this phase -- server has no visibility
 * into hand contents, `selected` card state, mana, etc., by design): on
 * receiving turn_timeout for its own accountId, apply spec §7.3's steps --
 * cancel any card mid-target-selection with no mana spent, discard the rest
 * of the hand, and locally transition to "opponent's turn" UI state. The
 * server does not and cannot verify a client actually did this; it trusts
 * the same way it trusts report_result, because there is no server-side
 * game engine to check against (an explicit, repeated scope boundary
 * throughout this relay, not something new introduced here).
 * ---------------------------------------------------------------------------
 */

const TYPE = {
  // client -> server
  ROOM_CREATE: 'room_create',
  ROOM_JOIN: 'room_join',
  LEAVE_ROOM: 'leave_room',
  ACTION: 'action',
  START_MATCH: 'start_match',
  END_TURN: 'end_turn',
  REPORT_RESULT: 'report_result',
  CLAIM_FORFEIT: 'claim_forfeit',

  // server -> client
  ROOM_CREATED: 'room_created',
  ROOM_JOINED: 'room_joined',
  OPPONENT_JOINED: 'opponent_joined',
  OPPONENT_DISCONNECTED: 'opponent_disconnected',
  OPPONENT_RECONNECTED: 'opponent_reconnected',
  TURN_STARTED: 'turn_started',
  TURN_TIMEOUT: 'turn_timeout',
  MATCH_ENDED: 'match_ended',
  ERROR: 'error',
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
