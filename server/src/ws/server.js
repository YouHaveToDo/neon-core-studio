/**
 * WS relay server (plan.md Phase 2.1/2.3/2.5/2.6/2.7). Attaches to the same
 * HTTP server as the Express app (single Render service, single port)
 * rather than listening on a separate port.
 *
 * Auth (2.3): the session token lives in an HttpOnly cookie (set by the
 * Phase 1 /api/auth endpoints), which the browser automatically attaches to
 * the WS upgrade request same-origin -- so that's the only place the token
 * is available to read, and where we validate it. A client can't read or
 * forge it into a message payload (HttpOnly), which is exactly what
 * prevents self-declaring a display name: the display name attached to
 * every message this connection sends is resolved server-side from the
 * validated session, once, at connection time, and never taken from client
 * input afterward.
 *
 * Heartbeat (closes a gap flagged by the earlier session): a hard network
 * drop (wifi cut, laptop closed) doesn't always fire a clean WS close frame
 * promptly, which would make the 2.7 disconnect-grace timing inaccurate --
 * the server might not even notice the disconnect until long after it
 * actually happened. Standard `ws` ping/pong liveness check below: every
 * WS_HEARTBEAT_INTERVAL_MS, ping every client and terminate() any socket
 * that didn't pong since the last ping. terminate() fires a real 'close'
 * event, so this feeds into the exact same handleClose() path as a clean
 * disconnect -- no separate code path needed for "detected via heartbeat"
 * vs. "detected via close frame".
 */

const { WebSocketServer } = require('ws');
const { readSessionCookie, findAccountBySessionToken } = require('../lib/session');
const { recordMatchResult, recordVoidMatch } = require('../lib/matchHistory');
const rooms = require('./rooms');
const { TYPE, errorMessage, sendJson } = require('./protocol');
const {
  TURN_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  CLAIM_FORFEIT_FLOOR_MS,
  WS_HEARTBEAT_INTERVAL_MS,
} = require('../config');

const WS_PATH = '/ws';

function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = req.url || '';
    if (!url.startsWith(WS_PATH)) {
      socket.destroy();
      return;
    }

    try {
      const token = readSessionCookie(req);
      const account = await findAccountBySessionToken(token);
      if (!account) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, account);
      });
    } catch (err) {
      console.error('WS upgrade failed', err);
      socket.destroy();
    }
  });

  wss.on('connection', (ws, account) => {
    ws.accountId = account.id;
    ws.displayName = account.display_name;
    ws.roomCode = null;
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('close', () => handleClose(ws));
    ws.on('error', (err) => console.error('WS connection error', err));
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, WS_HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return sendJson(ws, errorMessage('BAD_MESSAGE', '메시지를 파싱할 수 없습니다'));
  }
  if (!msg || typeof msg.type !== 'string') {
    return sendJson(ws, errorMessage('BAD_MESSAGE', 'type 필드가 필요합니다'));
  }

  switch (msg.type) {
    case TYPE.ROOM_CREATE:
      return onRoomCreate(ws, msg);
    case TYPE.ROOM_JOIN:
      return onRoomJoin(ws, msg);
    case TYPE.LEAVE_ROOM:
      return onLeaveRoom(ws);
    case TYPE.ACTION:
      return onAction(ws, msg);
    case TYPE.START_MATCH:
      return onStartMatch(ws, msg);
    case TYPE.END_TURN:
      return onEndTurn(ws);
    case TYPE.REPORT_RESULT:
      return onReportResult(ws, msg);
    case TYPE.CLAIM_FORFEIT:
      return onClaimForfeit(ws);
    default:
      return sendJson(ws, errorMessage('UNKNOWN_TYPE', `알 수 없는 메시지 타입: ${msg.type}`));
  }
}

// QA finding #3 (docs/qa/online-pvp-milestone.md): the relay never told
// either client how big the OTHER player's deck actually is, so js/state.js
// fell back to the local player's own deck length -- wrong whenever the two
// decks differ in size. Both room_create and room_join now optionally carry
// the sender's own deck size (already known client-side by the time either
// message is sent -- deck selection, spec §6.1, always happens before the
// lobby, spec §6.2); not a validated/trusted-for-gameplay number (nothing
// server-side enforces 20-30 here, that boundary is entirely routes/decks.js's
// job already) -- purely relayed to the opponent for the public deck-count
// display (spec §7.2). Anything that isn't a sane positive integer is
// treated as "unknown" (null) rather than silently coerced to something
// wrong.
function parseDeckSize(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function onRoomCreate(ws, msg) {
  if (ws.roomCode) {
    return sendJson(ws, errorMessage('ALREADY_IN_ROOM', '이미 방에 참여 중입니다'));
  }
  const deckSize = parseDeckSize(msg.deckSize);
  const room = rooms.createRoom({ accountId: ws.accountId, displayName: ws.displayName, deckSize, ws });
  ws.roomCode = room.code;
  sendJson(ws, { type: TYPE.ROOM_CREATED, code: room.code });
}

function onRoomJoin(ws, msg) {
  const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
  if (!code) {
    return sendJson(ws, errorMessage('INVALID_CODE', '방 코드를 입력해주세요'));
  }

  const deckSize = parseDeckSize(msg.deckSize);
  const result = rooms.joinRoom(code, { accountId: ws.accountId, displayName: ws.displayName, deckSize, ws });
  if (!result.ok) {
    return sendJson(ws, errorMessage(result.error, roomErrorText(result.error)));
  }

  const { room, reconnected } = result;
  ws.roomCode = room.code;

  if (reconnected) {
    const player = rooms.findPlayer(room, ws.accountId);
    if (player && player.graceTimeoutHandle) {
      clearTimeout(player.graceTimeoutHandle);
      player.graceTimeoutHandle = null;
    }
    // Only resumes the turn timer if every player in the room is connected
    // again -- if this was a "both players dropped" scenario and only one
    // has come back, the clock stays paused until the other also returns.
    resumeTurnTimerIfPaused(room);
  }

  const opponent = rooms.opponentOf(room, ws.accountId);

  sendJson(ws, {
    type: TYPE.ROOM_JOINED,
    code: room.code,
    opponent: opponent ? { displayName: opponent.displayName, deckSize: opponent.deckSize } : null,
    reconnected,
    turn: room.turn ? { activeAccountId: room.turn.activeAccountId, deadline: room.turn.deadline } : null,
  });

  if (opponent && opponent.connected && opponent.ws) {
    sendJson(opponent.ws, {
      type: reconnected ? TYPE.OPPONENT_RECONNECTED : TYPE.OPPONENT_JOINED,
      opponent: { displayName: ws.displayName, deckSize },
    });
  }
}

function roomErrorText(code) {
  if (code === 'ROOM_NOT_FOUND') return '존재하지 않는 방입니다';
  if (code === 'ROOM_FULL') return '이미 꽉 찬 방입니다';
  return '방에 참가할 수 없습니다';
}

function onLeaveRoom(ws) {
  if (!ws.roomCode) return;
  const room = rooms.getRoom(ws.roomCode);
  if (room && room.players.length < 2) {
    // Solo host backing out before anyone joined -- room is discarded
    // outright (spec §6.2: "방 만들기로 대기 중이었다면 방은 폐기됨").
    clearRoomTimers(room);
    rooms.deleteRoom(room.code);
  }
  ws.roomCode = null;
  // If an opponent was already present, closing here is handled identically
  // to a normal disconnect by handleClose (opponent gets OPPONENT_DISCONNECTED,
  // turn timer pauses, 45s grace starts).
  ws.close();
}

function onAction(ws, msg) {
  const room = ws.roomCode && rooms.getRoom(ws.roomCode);
  if (!room) {
    return sendJson(ws, errorMessage('NOT_IN_ROOM', '참여 중인 방이 없습니다'));
  }
  const opponent = rooms.opponentOf(room, ws.accountId);
  if (!opponent || !opponent.connected || !opponent.ws) {
    return sendJson(ws, errorMessage('OPPONENT_UNAVAILABLE', '상대가 연결되어 있지 않습니다'));
  }
  // Opaque passthrough -- payload contents are never inspected/validated.
  sendJson(opponent.ws, { type: TYPE.ACTION, payload: msg.payload, from: ws.displayName });
}

// ---------------------------------------------------------------------------
// 2.5: turn timer
// ---------------------------------------------------------------------------

function onStartMatch(ws, msg) {
  const room = ws.roomCode && rooms.getRoom(ws.roomCode);
  if (!room) {
    return sendJson(ws, errorMessage('NOT_IN_ROOM', '참여 중인 방이 없습니다'));
  }
  if (room.players.length < 2) {
    return sendJson(ws, errorMessage('OPPONENT_UNAVAILABLE', '상대가 아직 참여하지 않았습니다'));
  }
  const firstAccountId = typeof msg.firstAccountId === 'string' ? msg.firstAccountId : null;
  if (!firstAccountId || !rooms.findPlayer(room, firstAccountId)) {
    return sendJson(ws, errorMessage('BAD_FIRST_PLAYER', 'firstAccountId가 이 방의 플레이어가 아닙니다'));
  }

  const started = rooms.startMatch(room, firstAccountId);
  if (!started) {
    // Already started (the other client's start_match got here first, or a
    // duplicate send) -- idempotent no-op, not an error. If a turn is
    // already running, nothing to do; the earlier turn_started broadcast
    // already reached both clients.
    return;
  }

  beginTurn(room, firstAccountId, TURN_TIMEOUT_MS);
}

function onEndTurn(ws) {
  const room = ws.roomCode && rooms.getRoom(ws.roomCode);
  if (!room) {
    return sendJson(ws, errorMessage('NOT_IN_ROOM', '참여 중인 방이 없습니다'));
  }
  if (!room.turn) {
    return sendJson(ws, errorMessage('NO_ACTIVE_TURN', '진행 중인 턴이 없습니다'));
  }
  if (room.turn.activeAccountId !== ws.accountId) {
    return sendJson(ws, errorMessage('NOT_YOUR_TURN', '자신의 턴이 아닙니다'));
  }
  if (room.turn.timeoutHandle) {
    clearTimeout(room.turn.timeoutHandle);
    room.turn.timeoutHandle = null;
  }
  advanceTurnAfterEnd(room, ws.accountId);
}

/** Starts a fresh `durationMs` countdown for `accountId` and broadcasts turn_started. */
function beginTurn(room, accountId, durationMs) {
  const deadline = Date.now() + durationMs;
  room.turn = {
    activeAccountId: accountId,
    deadline,
    remainingMs: null,
    timeoutHandle: setTimeout(() => onTurnTimeout(room), durationMs),
  };
  broadcastToRoom(room, { type: TYPE.TURN_STARTED, activeAccountId: accountId, deadline });
}

/** Fires when a turn's deadline elapses with no end_turn (spec §7.3). */
function onTurnTimeout(room) {
  if (rooms.getRoom(room.code) !== room) return; // room already ended/removed
  if (!room.turn) return;
  const timedOutAccountId = room.turn.activeAccountId;
  room.turn.timeoutHandle = null;
  broadcastToRoom(room, { type: TYPE.TURN_TIMEOUT, accountId: timedOutAccountId });
  advanceTurnAfterEnd(room, timedOutAccountId);
}

/** Shared by manual end_turn and the server-fired timeout -- switch to the opponent, start their timer. */
function advanceTurnAfterEnd(room, endedAccountId) {
  const opponent = rooms.opponentOf(room, endedAccountId);
  if (!opponent) return; // shouldn't happen in a 2-player room, defensive only
  beginTurn(room, opponent.accountId, TURN_TIMEOUT_MS);
}

/** Stops the running countdown (if any) and remembers how much time was left. */
function pauseTurnTimerIfRunning(room) {
  if (!room.turn || !room.turn.timeoutHandle) return;
  clearTimeout(room.turn.timeoutHandle);
  room.turn.timeoutHandle = null;
  room.turn.remainingMs = Math.max(0, room.turn.deadline - Date.now());
  room.turn.deadline = null;
}

/** Resumes a paused countdown from wherever it was left off, but only once everyone is back (spec §8.2). */
function resumeTurnTimerIfPaused(room) {
  if (!room.turn) return;
  if (room.turn.timeoutHandle) return; // not paused
  if (room.turn.remainingMs == null) return; // nothing to resume
  if (!room.players.every((p) => p.connected)) return; // still waiting on someone else

  const ms = room.turn.remainingMs;
  room.turn.remainingMs = null;
  room.turn.deadline = Date.now() + ms;
  room.turn.timeoutHandle = setTimeout(() => onTurnTimeout(room), ms);
  broadcastToRoom(room, {
    type: TYPE.TURN_STARTED,
    activeAccountId: room.turn.activeAccountId,
    deadline: room.turn.deadline,
  });
}

function clearRoomTimers(room) {
  if (room.turn && room.turn.timeoutHandle) {
    clearTimeout(room.turn.timeoutHandle);
    room.turn.timeoutHandle = null;
  }
  for (const player of room.players) {
    if (player.graceTimeoutHandle) {
      clearTimeout(player.graceTimeoutHandle);
      player.graceTimeoutHandle = null;
    }
  }
}

function broadcastToRoom(room, obj) {
  for (const player of room.players) {
    if (player.connected && player.ws) sendJson(player.ws, obj);
  }
}

// ---------------------------------------------------------------------------
// 2.6: match-result persistence
// ---------------------------------------------------------------------------

async function onReportResult(ws, msg) {
  if (msg.result !== 'win' && msg.result !== 'loss') {
    return sendJson(ws, errorMessage('BAD_RESULT', 'result는 win 또는 loss여야 합니다'));
  }
  const room = ws.roomCode && rooms.getRoom(ws.roomCode);
  if (!room) {
    return sendJson(ws, errorMessage('NOT_IN_ROOM', '참여 중인 방이 없습니다'));
  }
  const reporter = rooms.findPlayer(room, ws.accountId);
  const opponent = rooms.opponentOf(room, ws.accountId);
  if (!reporter || !opponent) {
    return sendJson(ws, errorMessage('OPPONENT_UNAVAILABLE', '상대 정보를 찾을 수 없습니다'));
  }

  // Design call (plan.md 2.6 explicitly leaves "wait for both / trust one"
  // to programmer judgment): trust whichever client's report_result arrives
  // FIRST, write both accounts' rows from it, and tear the room down
  // immediately -- consistent with the existing "no server-side game-rule
  // validation, trust the client" boundary already established for this
  // relay (spec §6.3 RNG authority, the report_result doc comment in
  // protocol.js). If the other client also sends its own report_result a
  // moment later, the room is already gone and it just gets a harmless
  // NOT_IN_ROOM error -- no double-write, no cross-check deadlock if the two
  // reports ever disagreed.
  const winner = msg.result === 'win' ? reporter : opponent;
  const loser = msg.result === 'win' ? opponent : reporter;

  try {
    await recordMatchResult({
      winner: { accountId: winner.accountId, displayName: winner.displayName },
      loser: { accountId: loser.accountId, displayName: loser.displayName },
      forfeit: false,
    });
  } catch (err) {
    console.error('match_history write failed (report_result)', err);
    // Still relay match_ended below so the match doesn't hang for either
    // client's UI even if persistence failed -- gameplay shouldn't block on
    // a DB write, and the match itself is genuinely over either way.
  }

  const otherResult = msg.result === 'win' ? 'loss' : 'win';
  sendJson(ws, { type: TYPE.MATCH_ENDED, result: msg.result, reason: 'client_reported' });
  if (opponent.connected && opponent.ws) {
    sendJson(opponent.ws, { type: TYPE.MATCH_ENDED, result: otherResult, reason: 'client_reported' });
  }
  endRoomAndClearSockets(room);
}

// ---------------------------------------------------------------------------
// 2.7: disconnect / forfeit
// ---------------------------------------------------------------------------

function onClaimForfeit(ws) {
  const room = ws.roomCode && rooms.getRoom(ws.roomCode);
  if (!room) {
    return sendJson(ws, errorMessage('NOT_IN_ROOM', '참여 중인 방이 없습니다'));
  }
  const claimer = rooms.findPlayer(room, ws.accountId);
  const opponent = rooms.opponentOf(room, ws.accountId);
  if (!claimer || !opponent || opponent.connected) {
    return sendJson(ws, errorMessage('OPPONENT_CONNECTED', '상대가 연결되어 있어 기권 처리를 할 수 없습니다'));
  }

  const elapsed = Date.now() - (opponent.disconnectedAt || 0);
  if (elapsed < CLAIM_FORFEIT_FLOOR_MS) {
    const remainingSec = Math.ceil((CLAIM_FORFEIT_FLOOR_MS - elapsed) / 1000);
    return sendJson(
      ws,
      errorMessage('CLAIM_TOO_EARLY', `아직 기권 처리를 할 수 없습니다 (${remainingSec}초 후 가능)`)
    );
  }

  finalizeForfeit(room, { winner: claimer, loser: opponent, reason: 'forfeit_claimed' });
}

/** Shared by claim_forfeit and the 45s auto-forfeit grace timeout. */
async function finalizeForfeit(room, { winner, loser, reason }) {
  clearRoomTimers(room);

  try {
    await recordMatchResult({
      winner: { accountId: winner.accountId, displayName: winner.displayName },
      loser: { accountId: loser.accountId, displayName: loser.displayName },
      forfeit: true,
    });
  } catch (err) {
    console.error('match_history write failed (forfeit)', err);
  }

  if (winner.connected && winner.ws) {
    sendJson(winner.ws, { type: TYPE.MATCH_ENDED, result: 'win_forfeit', reason });
  }
  if (loser.connected && loser.ws) {
    sendJson(loser.ws, { type: TYPE.MATCH_ENDED, result: 'loss', reason });
  }
  endRoomAndClearSockets(room);
}

/** Fires when a disconnected player's 45s grace period runs out with no reconnect (spec §8.2). */
function onDisconnectGraceExpired(room, accountId) {
  if (rooms.getRoom(room.code) !== room) return; // room already ended/removed
  const player = rooms.findPlayer(room, accountId);
  if (!player || player.connected) return; // reconnected in the meantime, defensive no-op
  const opponent = rooms.opponentOf(room, accountId);
  if (!opponent) return;

  player.graceTimeoutHandle = null;
  player.graceExpired = true;

  if (opponent.connected) {
    // The normal, single-disconnect case: someone is actually still here to
    // award the forfeit win to.
    finalizeForfeit(room, { winner: opponent, loser: player, reason: 'disconnect_timeout' });
    return;
  }

  // QA finding #2 (docs/qa/online-pvp-milestone.md): the opponent is ALSO
  // currently disconnected -- a simultaneous double-disconnect. There is no
  // one present to award a forfeit win to, so this can't resolve as a normal
  // forfeit no matter whose grace timer happens to fire first (that would
  // just be an arbitrary tiebreak on timer-firing order, not a meaningful
  // result).
  if (opponent.graceExpired) {
    // The opponent's OWN grace period already expired too (their timer fired
    // before this one, saw the same "still disconnected" state, and left
    // graceExpired=true for exactly this moment) -- both sides are now
    // confirmed gone with neither having reconnected. Resolve as a void/
    // no-contest for both rather than leaving the match to vanish silently
    // (the bug being fixed) or crowning an arbitrary "winner".
    finalizeVoidMatch(room, player, opponent);
    return;
  }

  // Opponent's own grace timer is still running (their disconnect landed
  // slightly after this one, or their timer just hasn't fired yet) -- wait
  // for it. Either they reconnect first (clears graceExpired via
  // rooms.joinRoom's reconnect branch and this player's own timer already
  // being cleared/expired is harmless), or their timer also expires and
  // finds THIS player's graceExpired already true, taking the branch above.
}

/**
 * Resolves a genuinely simultaneous double-disconnect (QA finding #2): both
 * players' 45s grace periods ran out with neither reconnecting. Writes a
 * symmetric 'void' match_history row for both accounts (see
 * lib/matchHistory.js's recordVoidMatch) and tears the room down. Does NOT
 * attempt to notify either socket live (match_ended) -- by definition both
 * are disconnected at this point, so there's nothing to notify; the
 * match_history row is the durable record either player will see once they
 * next log in and check their match history (spec §6.5).
 */
async function finalizeVoidMatch(room, playerA, playerB) {
  clearRoomTimers(room);

  try {
    await recordVoidMatch({
      playerA: { accountId: playerA.accountId, displayName: playerA.displayName },
      playerB: { accountId: playerB.accountId, displayName: playerB.displayName },
    });
  } catch (err) {
    console.error('match_history write failed (void double-disconnect)', err);
  }

  // Defensive only -- in the vast majority of real double-disconnects
  // neither socket is actually open anymore by the time both grace timers
  // have expired, but if either somehow reconnected a socket without the
  // room-level bookkeeping reflecting it yet, don't leave them hanging.
  for (const player of [playerA, playerB]) {
    if (player.connected && player.ws) {
      sendJson(player.ws, { type: TYPE.MATCH_ENDED, result: 'void', reason: 'double_disconnect' });
    }
  }

  endRoomAndClearSockets(room);
}

// Ending a room (match_ended) should free both sockets to create/join a new
// one afterward (e.g. "다시 플레이" -> deck select -> lobby, spec §6.4).
// Without this, a socket's `roomCode` would keep pointing at a room that no
// longer exists in `rooms`, and the next room_create would wrongly reject
// with ALREADY_IN_ROOM.
function endRoomAndClearSockets(room) {
  clearRoomTimers(room);
  for (const player of room.players) {
    if (player.ws) player.ws.roomCode = null;
  }
  rooms.endRoom(room.code);
}

function handleClose(ws) {
  const info = rooms.markDisconnected(ws);
  if (!info) return;
  const { room, player } = info;

  // A solo room (no opponent ever joined) is deleted outright by
  // markDisconnected itself -- nothing left to pause/notify/grace-time for.
  if (rooms.getRoom(room.code) !== room) {
    clearRoomTimers(room);
    return;
  }

  pauseTurnTimerIfRunning(room);

  // QA finding #2 (docs/qa/online-pvp-milestone.md): this player's own 45s
  // grace timer is armed unconditionally now, even if the opponent is ALSO
  // currently disconnected (a simultaneous double-disconnect) -- the old
  // code short-circuited this whole block in that case because
  // markDisconnected() used to delete the room the instant no one was
  // connected, which silently canceled BOTH sides' forfeit/void resolution.
  // rooms.markDisconnected() no longer deletes a full room just because
  // it's momentarily empty, so this always has a live room to work with; see
  // onDisconnectGraceExpired() for how a still-disconnected opponent gets
  // resolved once (if) this timer actually fires.
  const opponent = rooms.opponentOf(room, player.accountId);
  if (opponent && opponent.connected && opponent.ws) {
    sendJson(opponent.ws, { type: TYPE.OPPONENT_DISCONNECTED, disconnectedAt: player.disconnectedAt });
  }

  player.graceTimeoutHandle = setTimeout(
    () => onDisconnectGraceExpired(room, player.accountId),
    DISCONNECT_GRACE_MS
  );
}

module.exports = { attachWebSocketServer };
