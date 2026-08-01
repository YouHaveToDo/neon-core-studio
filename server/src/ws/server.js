/**
 * WS relay server (plan.md Phase 2.1/2.3). Attaches to the same HTTP server
 * as the Express app (single Render service, single port) rather than
 * listening on a separate port.
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
 * Known gap (documented, not fixed here): no ping/pong heartbeat, so a hard
 * network drop without a clean close frame (e.g. wifi cut, laptop closed)
 * may not fire the 'close' event promptly. Standard `ws` heartbeat pattern
 * should be added when plan.md 2.7 (45s disconnect grace timer) is built --
 * accurate disconnect *timing* needs it; this phase only needs disconnect
 * *detection*, which does work whenever the socket does close.
 */

const { WebSocketServer } = require('ws');
const { readSessionCookie, findAccountBySessionToken } = require('../lib/session');
const rooms = require('./rooms');
const { TYPE, errorMessage, sendJson } = require('./protocol');

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

    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('close', () => handleClose(ws));
    ws.on('error', (err) => console.error('WS connection error', err));
  });

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
      return onRoomCreate(ws);
    case TYPE.ROOM_JOIN:
      return onRoomJoin(ws, msg);
    case TYPE.LEAVE_ROOM:
      return onLeaveRoom(ws);
    case TYPE.ACTION:
      return onAction(ws, msg);
    case TYPE.REPORT_RESULT:
      return onReportResult(ws, msg);
    case TYPE.CLAIM_FORFEIT:
      return onClaimForfeit(ws);
    default:
      return sendJson(ws, errorMessage('UNKNOWN_TYPE', `알 수 없는 메시지 타입: ${msg.type}`));
  }
}

function onRoomCreate(ws) {
  if (ws.roomCode) {
    return sendJson(ws, errorMessage('ALREADY_IN_ROOM', '이미 방에 참여 중입니다'));
  }
  const room = rooms.createRoom({ accountId: ws.accountId, displayName: ws.displayName, ws });
  ws.roomCode = room.code;
  sendJson(ws, { type: TYPE.ROOM_CREATED, code: room.code });
}

function onRoomJoin(ws, msg) {
  const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
  if (!code) {
    return sendJson(ws, errorMessage('INVALID_CODE', '방 코드를 입력해주세요'));
  }

  const result = rooms.joinRoom(code, { accountId: ws.accountId, displayName: ws.displayName, ws });
  if (!result.ok) {
    return sendJson(ws, errorMessage(result.error, roomErrorText(result.error)));
  }

  const { room, reconnected } = result;
  ws.roomCode = room.code;
  const opponent = rooms.opponentOf(room, ws.accountId);

  sendJson(ws, {
    type: TYPE.ROOM_JOINED,
    code: room.code,
    opponent: opponent ? { displayName: opponent.displayName } : null,
    reconnected,
  });

  if (opponent && opponent.connected && opponent.ws) {
    sendJson(opponent.ws, {
      type: reconnected ? TYPE.OPPONENT_RECONNECTED : TYPE.OPPONENT_JOINED,
      opponent: { displayName: ws.displayName },
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
    rooms.deleteRoom(room.code);
  }
  ws.roomCode = null;
  // If an opponent was already present, closing here is handled identically
  // to a normal disconnect by handleClose (opponent gets OPPONENT_DISCONNECTED).
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

function onReportResult(ws, msg) {
  if (msg.result !== 'win' && msg.result !== 'loss') {
    return sendJson(ws, errorMessage('BAD_RESULT', 'result는 win 또는 loss여야 합니다'));
  }
  const room = ws.roomCode && rooms.getRoom(ws.roomCode);
  if (!room) {
    return sendJson(ws, errorMessage('NOT_IN_ROOM', '참여 중인 방이 없습니다'));
  }

  // TODO (plan.md 2.6): write to match_history here (both accounts, trusting
  // the client's report per spec's deliberate scope boundary, same spirit as
  // the RNG-authority call). NOT implemented in this phase -- this handler
  // only relays the report so both clients can render a consistent
  // end-of-match screen; nothing is persisted yet.
  sendJson(ws, { type: TYPE.MATCH_ENDED, result: msg.result, reason: 'client_reported' });

  const opponent = rooms.opponentOf(room, ws.accountId);
  if (opponent && opponent.connected && opponent.ws) {
    sendJson(opponent.ws, {
      type: TYPE.MATCH_ENDED,
      result: msg.result === 'win' ? 'loss' : 'win',
      reason: 'client_reported',
    });
  }
  endRoomAndClearSockets(room);
}

function onClaimForfeit(ws) {
  const room = ws.roomCode && rooms.getRoom(ws.roomCode);
  if (!room) {
    return sendJson(ws, errorMessage('NOT_IN_ROOM', '참여 중인 방이 없습니다'));
  }
  const opponent = rooms.opponentOf(room, ws.accountId);
  if (!opponent || opponent.connected) {
    return sendJson(ws, errorMessage('OPPONENT_CONNECTED', '상대가 연결되어 있어 기권 처리를 할 수 없습니다'));
  }
  // NOTE (plan.md 2.7): spec §8.2 requires this button to only be enabled
  // once 10s have elapsed since disconnect was detected. That floor is NOT
  // enforced server-side yet (nor is the 45s auto-forfeit this is a manual
  // alternative to) -- both are deferred to 2.7. `opponent.disconnectedAt`
  // is already tracked in room state so 2.7 can add the check without
  // touching the message shape.
  sendJson(ws, { type: TYPE.MATCH_ENDED, result: 'win_forfeit', reason: 'forfeit_claimed' });
  endRoomAndClearSockets(room);
}

// Ending a room (match_ended) should free both sockets to create/join a new
// one afterward (e.g. "다시 플레이" -> deck select -> lobby, spec §6.4).
// Without this, a socket's `roomCode` would keep pointing at a room that no
// longer exists in `rooms`, and the next room_create would wrongly reject
// with ALREADY_IN_ROOM.
function endRoomAndClearSockets(room) {
  for (const player of room.players) {
    if (player.ws) player.ws.roomCode = null;
  }
  rooms.endRoom(room.code);
}

function handleClose(ws) {
  const info = rooms.markDisconnected(ws);
  if (!info) return;
  const { room, player } = info;
  const opponent = rooms.opponentOf(room, player.accountId);
  if (opponent && opponent.connected && opponent.ws) {
    sendJson(opponent.ws, { type: TYPE.OPPONENT_DISCONNECTED, disconnectedAt: player.disconnectedAt });
  }
}

module.exports = { attachWebSocketServer };
