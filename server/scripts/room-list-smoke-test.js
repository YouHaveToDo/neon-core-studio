/* Manual end-to-end smoke test for the open room-list matchmaking flow
 * (spec-online-pvp.md §6.2, 2026-08 revision -- replaces room-code create/
 * join). Same spirit/style as scripts/ws-smoke-test.js: programmer's own
 * sanity pass, not a substitute for a dedicated QA pass.
 *
 * Covers what ws-smoke-test.js (room-code era) and the other existing
 * scripts don't:
 *   - GET /api/rooms (server/src/routes/rooms.js): shape, newest-first
 *     sorting, and that a room stops appearing once it's full (no longer
 *     "open") -- an account browsing the list who never created/joined
 *     anything should still be able to see it (REST, no WS room context
 *     needed, per that route's own doc comment).
 *   - The fill-race case spec §6.2.6 explicitly calls out: two accounts
 *     send room_join for the SAME room back-to-back with no await between
 *     them (as close to simultaneous as a single Node process can produce)
 *     -- exactly one must get room_joined, the other a graceful ROOM_FULL
 *     error (not a crash, not a hang, not both succeeding).
 *
 * Usage: server must already be running (npm start), then:
 *   node scripts/room-list-smoke-test.js [baseUrl]
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
  const email = `roomlist-${rand}@example.com`;
  const res = await fetch(`${BASE_HTTP}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', confirmPassword: 'password123', displayName }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const cookie = extractCookie(res);
  return { email, cookie };
}

async function listRooms(cookie) {
  const res = await fetch(`${BASE_HTTP}/api/rooms`, { headers: { Cookie: cookie } });
  if (res.status !== 200) throw new Error(`GET /api/rooms failed: ${res.status} ${await res.text()}`);
  return (await res.json()).rooms;
}

function connectWs(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_WS}/ws`, { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => resolve({ rejected: true, statusCode: res.statusCode }));
    ws.once('error', reject);
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n== GET /api/rooms requires auth ==');
  const noAuthRes = await fetch(`${BASE_HTTP}/api/rooms`);
  assert(noAuthRes.status === 401, `no-session GET /api/rooms returns 401 (got ${noAuthRes.status})`);

  console.log('\n== signup accounts ==');
  const alice = await signup('AliceRoomList');
  const bob = await signup('BobRoomList');
  const carol = await signup('CarolRoomList'); // pure browser -- never creates/joins anything herself
  const dave = await signup('DaveRoomList');

  console.log('\n== empty state: no rooms open yet ==');
  const emptyList = await listRooms(carol.cookie);
  assert(Array.isArray(emptyList), 'GET /api/rooms returns a rooms array');
  assert(emptyList.length === 0, `no open rooms before anyone creates one (got ${emptyList.length})`);

  console.log('\n== Alice creates a room over WS (no browser needed to see it in the REST list) ==');
  const aliceWs = await connectWs(alice.cookie);
  aliceWs.send(JSON.stringify({ type: 'room_create', deckSize: 24 }));
  const aliceCreated = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
  assert(typeof aliceCreated.code === 'string' && aliceCreated.code.length > 0, 'room_created carries an internal room id');

  const listAfterAlice = await listRooms(carol.cookie);
  assert(listAfterAlice.length === 1, `exactly 1 open room after Alice creates one (got ${listAfterAlice.length})`);
  assert(
    listAfterAlice[0] && listAfterAlice[0].hostDisplayName === 'AliceRoomList',
    `room lists Alice's display name, not her email or the code (got ${JSON.stringify(listAfterAlice[0])})`
  );
  assert(
    typeof listAfterAlice[0].createdAt === 'number' && Math.abs(Date.now() - listAfterAlice[0].createdAt) < 5000,
    `room's createdAt is a recent epoch-ms timestamp (got ${listAfterAlice[0].createdAt})`
  );
  assert(listAfterAlice[0].id === aliceCreated.code, "room-list id matches room_created's code (same internal id, just relayed two ways)");

  console.log('\n== Dave creates a second room -- newest-first sort ==');
  await sleep(20); // ensure a distinguishable createdAt ordering
  const daveWs = await connectWs(dave.cookie);
  daveWs.send(JSON.stringify({ type: 'room_create', deckSize: 22 }));
  const daveCreated = await waitForMessage(daveWs, (m) => m.type === 'room_created');

  const listAfterDave = await listRooms(carol.cookie);
  assert(listAfterDave.length === 2, `2 open rooms now (got ${listAfterDave.length})`);
  assert(
    listAfterDave[0].hostDisplayName === 'DaveRoomList',
    `newest room (Dave's) sorts first (got ${JSON.stringify(listAfterDave.map((r) => r.hostDisplayName))})`
  );

  console.log("\n== Bob joins Alice's room -- it's full now, so it drops out of the open list ==");
  const bobWs = await connectWs(bob.cookie);
  bobWs.send(JSON.stringify({ type: 'room_join', code: aliceCreated.code, deckSize: 20 }));
  await waitForMessage(bobWs, (m) => m.type === 'room_joined');
  await waitForMessage(aliceWs, (m) => m.type === 'opponent_joined');

  const listAfterFull = await listRooms(carol.cookie);
  assert(
    listAfterFull.length === 1 && listAfterFull[0].hostDisplayName === 'DaveRoomList',
    `Alice's now-full room no longer appears in the open list, only Dave's remains (got ${JSON.stringify(listAfterFull)})`
  );

  console.log('\n== fill-race (spec §6.2.6): two accounts room_join the SAME (Dave\'s) room back-to-back ==');
  const frank = await signup('FrankRace');
  const grace = await signup('GraceRace');
  const frankWs = await connectWs(frank.cookie);
  const graceWs = await connectWs(grace.cookie);

  const frankResultP = waitForMessage(frankWs, (m) => m.type === 'room_joined' || m.type === 'error');
  const graceResultP = waitForMessage(graceWs, (m) => m.type === 'room_joined' || m.type === 'error');
  // Sent with no await between them -- as close to simultaneous as this
  // single Node process can produce (both land in the server's event queue
  // essentially back-to-back).
  frankWs.send(JSON.stringify({ type: 'room_join', code: daveCreated.code, deckSize: 20 }));
  graceWs.send(JSON.stringify({ type: 'room_join', code: daveCreated.code, deckSize: 21 }));
  const [frankResult, graceResult] = await Promise.all([frankResultP, graceResultP]);

  const results = [frankResult, graceResult];
  const successes = results.filter((r) => r.type === 'room_joined');
  const rejections = results.filter((r) => r.type === 'error');
  assert(successes.length === 1, `exactly one of the two simultaneous joiners succeeds (got ${successes.length} successes)`);
  assert(rejections.length === 1, `exactly one of the two simultaneous joiners is gracefully rejected (got ${rejections.length} rejections)`);
  assert(
    rejections.length === 1 && rejections[0].code === 'ROOM_FULL',
    `the rejected joiner gets ROOM_FULL (room still exists, just filled a moment earlier), not a crash or a different code (got ${JSON.stringify(rejections[0])})`
  );

  const listAfterRace = await listRooms(carol.cookie);
  assert(listAfterRace.length === 0, `Dave's room is gone from the open list now that it's full too (got ${listAfterRace.length})`);

  aliceWs.close();
  bobWs.close();
  daveWs.close();
  frankWs.close();
  graceWs.close();

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Room-list smoke test crashed:', err);
  process.exit(1);
});
