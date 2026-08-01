/* Manual end-to-end smoke test for the WS relay (plan.md Phase 2.1-2.3:
 * relay skeleton, wire protocol, connection auth). Not a substitute for
 * QA's own pass -- this is the programmer's own sanity check that the
 * relay behaves as written, and doubles as a runnable example of expected
 * message shapes, same spirit as scripts/smoke-test.js for the HTTP auth
 * endpoints.
 *
 * Usage: server must already be running (npm start), then:
 *   node scripts/ws-smoke-test.js [baseUrl]
 * Defaults to http://localhost:3001
 */
const WebSocket = require('ws');

const BASE_HTTP = process.argv[2] || 'http://localhost:3001';
const BASE_WS = BASE_HTTP.replace(/^http/, 'ws');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.log(`  FAIL  ${msg}`);
    failures += 1;
  }
}

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  return setCookie.split(';')[0];
}

async function signup(displayName) {
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `wstest-${rand}@example.com`;
  const res = await fetch(`${BASE_HTTP}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', confirmPassword: 'password123', displayName }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const cookie = extractCookie(res);
  return { email, cookie };
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

function connectWs(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_WS}/ws`, { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => resolve({ rejected: true, statusCode: res.statusCode }));
    ws.once('error', reject);
  });
}

async function main() {
  console.log('\n== WS connection auth: reject missing/invalid session ==');
  const badConn = await connectWs('al_session=totally-not-a-real-token');
  assert(
    badConn.rejected === true && badConn.statusCode === 401,
    `unauthenticated WS upgrade rejected with 401 (got ${JSON.stringify(badConn)})`
  );

  console.log('\n== signup two accounts ==');
  const alice = await signup('Alice');
  const bob = await signup('Bob');
  assert(!!alice.cookie && !!bob.cookie, 'both signups produced session cookies');

  console.log('\n== WS connection auth: accept valid session ==');
  const aliceWs = await connectWs(alice.cookie);
  assert(aliceWs instanceof WebSocket, 'authenticated WS upgrade for Alice succeeds');
  const bobWs = await connectWs(bob.cookie);
  assert(bobWs instanceof WebSocket, 'authenticated WS upgrade for Bob succeeds');

  console.log('\n== room create/join, server-resolved display names ==');
  aliceWs.send(JSON.stringify({ type: 'room_create' }));
  const created = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
  assert(typeof created.code === 'string' && created.code.length === 6, `room_created has a 6-char code (got "${created.code}")`);

  bobWs.send(JSON.stringify({ type: 'room_join', code: created.code }));
  const [joined, opponentJoined] = await Promise.all([
    waitForMessage(bobWs, (m) => m.type === 'room_joined'),
    waitForMessage(aliceWs, (m) => m.type === 'opponent_joined'),
  ]);
  assert(
    joined.opponent && joined.opponent.displayName === 'Alice',
    `Bob sees opponent displayName "Alice" (server-resolved, not client-claimed) -- got ${JSON.stringify(joined.opponent)}`
  );
  assert(
    opponentJoined.opponent && opponentJoined.opponent.displayName === 'Bob',
    `Alice sees opponent displayName "Bob" -- got ${JSON.stringify(opponentJoined.opponent)}`
  );

  console.log('\n== opaque action relay (server does not interpret contents, cannot be used to spoof identity) ==');
  const weirdPayload = {
    kind: 'play_card',
    cardId: 'heavy_slash',
    targetId: 'enemy',
    displayName: 'NOT-ALICE-HAHA', // a client-claimed name inside the opaque payload must be ignored
    nested: { anything: [1, 2, 3] },
  };
  aliceWs.send(JSON.stringify({ type: 'action', payload: weirdPayload }));
  const relayed = await waitForMessage(bobWs, (m) => m.type === 'action');
  assert(JSON.stringify(relayed.payload) === JSON.stringify(weirdPayload), 'action payload relayed byte-for-byte, untouched');
  assert(
    relayed.from === 'Alice',
    `relayed action tags sender with the server-resolved displayName "Alice", not the spoofed payload field (got "${relayed.from}")`
  );

  console.log('\n== disconnect bookkeeping ==');
  const disconnectPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
  bobWs.close();
  const disconnectMsg = await disconnectPromise;
  assert(
    typeof disconnectMsg.disconnectedAt === 'number',
    `opponent_disconnected carries a disconnectedAt timestamp (got ${JSON.stringify(disconnectMsg)})`
  );

  console.log('\n== claim_forfeit accepted once opponent is disconnected ==');
  aliceWs.send(JSON.stringify({ type: 'claim_forfeit' }));
  const forfeitResult = await waitForMessage(aliceWs, (m) => m.type === 'match_ended' || m.type === 'error');
  assert(
    forfeitResult.type === 'match_ended' && forfeitResult.result === 'win_forfeit',
    `claim_forfeit succeeds after opponent disconnect (got ${JSON.stringify(forfeitResult)})`
  );

  console.log('\n== reconnect flow: rejoin same room code, opponent notified ==');
  aliceWs.send(JSON.stringify({ type: 'room_create' }));
  const created2 = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
  const bobWs2 = await connectWs(bob.cookie);
  bobWs2.send(JSON.stringify({ type: 'room_join', code: created2.code }));
  await waitForMessage(bobWs2, (m) => m.type === 'room_joined');
  await waitForMessage(aliceWs, (m) => m.type === 'opponent_joined');

  const reconnectNoticePromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
  bobWs2.close();
  await reconnectNoticePromise;

  const bobWs3 = await connectWs(bob.cookie);
  const reconnectAckPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_reconnected');
  bobWs3.send(JSON.stringify({ type: 'room_join', code: created2.code }));
  const rejoinAck = await waitForMessage(bobWs3, (m) => m.type === 'room_joined');
  assert(
    rejoinAck.reconnected === true,
    `rejoining the same room with the same account is flagged reconnected:true (got ${JSON.stringify(rejoinAck)})`
  );
  const reconnectAck = await reconnectAckPromise;
  assert(reconnectAck.opponent.displayName === 'Bob', "opponent_reconnected notifies Alice with Bob's displayName");

  console.log('\n== room full: a third stranger cannot join ==');
  const carol = await signup('Carol');
  const carolWs = await connectWs(carol.cookie);
  carolWs.send(JSON.stringify({ type: 'room_join', code: created2.code }));
  const roomFullErr = await waitForMessage(carolWs, (m) => m.type === 'error');
  assert(roomFullErr.code === 'ROOM_FULL', `third player rejected with ROOM_FULL (got ${JSON.stringify(roomFullErr)})`);

  console.log('\n== invalid room code ==');
  carolWs.send(JSON.stringify({ type: 'room_join', code: 'ZZZZZZ' }));
  const notFoundErr = await waitForMessage(carolWs, (m) => m.type === 'error');
  assert(notFoundErr.code === 'ROOM_NOT_FOUND', `bogus code rejected with ROOM_NOT_FOUND (got ${JSON.stringify(notFoundErr)})`);

  aliceWs.close();
  bobWs3.close();
  carolWs.close();

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('WS smoke test crashed:', err);
  process.exit(1);
});
