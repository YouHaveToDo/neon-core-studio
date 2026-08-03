/* Manual smoke test for QA finding #3 (docs/qa/online-pvp-milestone.md):
 * opponent deck-size display fell back to the LOCAL player's own deck
 * length because no relay message carried the opponent's real deck size.
 * This test drives the raw WS protocol directly (same style as
 * pvp-smoke-test.js / ws-smoke-test.js) to confirm room_create/room_join's
 * new `deckSize` field is actually relayed to the opponent, in both
 * directions, with MISMATCHED sizes (the exact condition QA's repro used --
 * a same-size match wouldn't have caught the bug even before the fix).
 *
 * Usage (from server/): node scripts/deck-size-relay-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied (npm run migrate).
 */
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = 3096;
const BASE_HTTP = `http://localhost:${TEST_PORT}`;
const BASE_WS = `ws://localhost:${TEST_PORT}`;

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.log(`  FAIL  ${msg}`);
    failures += 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  return setCookie.split(';')[0];
}

async function signup(displayName) {
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `decksize-${rand}@example.com`;
  const res = await fetch(`${BASE_HTTP}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', confirmPassword: 'password123', displayName }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const cookie = extractCookie(res);
  return { email, cookie, accountId: body.account.id, displayName };
}

// Trims the auto-created 24-card starter deck (slot 1) down to a
// deliberately DIFFERENT valid size, so the two accounts in this test have
// mismatched deck sizes -- same technique QA's own deck-size-mismatch.js
// repro used (docs/qa/online-pvp-milestone.md Finding #3).
async function setDeckSize(cookie, total) {
  const cards = { strike: Math.min(3, total) };
  let remaining = total - cards.strike;
  const others = ['defend', 'heavySlash', 'twinStrike', 'piercingStrike', 'quickGuard', 'fortify'];
  for (const id of others) {
    if (remaining <= 0) break;
    const n = Math.min(3, remaining);
    cards[id] = n;
    remaining -= n;
  }
  if (remaining > 0) throw new Error(`could not build a ${total}-card deck within 3-per-card limits`);

  const res = await fetch(`${BASE_HTTP}/api/decks/1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: `Deck${total}`, cards }),
  });
  if (res.status !== 200) throw new Error(`deck edit failed: ${res.status} ${await res.text()}`);
  const deck = await res.json();
  if (deck.total !== total) throw new Error(`deck edit total mismatch: wanted ${total}, got ${deck.total}`);
  return deck.total;
}

function connectWs(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_WS}/ws`, { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('open', () => {
      ws.buffered = [];
      ws.waiters = [];
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        const waiterIndex = ws.waiters.findIndex((w) => w.predicate(msg));
        if (waiterIndex !== -1) {
          const [waiter] = ws.waiters.splice(waiterIndex, 1);
          waiter.resolve(msg);
          return;
        }
        ws.buffered.push(msg);
      });
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  const bufferedIndex = ws.buffered.findIndex(predicate);
  if (bufferedIndex !== -1) {
    return Promise.resolve(ws.buffered.splice(bufferedIndex, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const waiter = { predicate };
    const timer = setTimeout(() => {
      const i = ws.waiters.indexOf(waiter);
      if (i !== -1) ws.waiters.splice(i, 1);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    waiter.resolve = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
    ws.waiters.push(waiter);
  });
}

async function waitForServerReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_HTTP}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error('server did not become ready in time');
}

async function main() {
  console.log(`\n== spawning server on port ${TEST_PORT} ==`);
  const serverDir = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  try {
    await waitForServerReady();
    console.log('  server is up');

    console.log('\n== signup Alice (24-card starter deck) + Bob (trimmed to 20 cards) ==');
    const alice = await signup('AliceDeck');
    const bob = await signup('BobDeck');
    const aliceDeckSize = 24; // untouched starter deck
    const bobDeckSize = await setDeckSize(bob.cookie, 20);
    assert(bobDeckSize === 20, `Bob's deck trimmed to 20 cards (got ${bobDeckSize})`);
    assert(aliceDeckSize !== bobDeckSize, 'the two decks are deliberately mismatched (sanity check on the test itself)');

    const aliceWs = await connectWs(alice.cookie);
    const bobWs = await connectWs(bob.cookie);

    console.log('\n== Alice creates a room, reporting her real 24-card deck size ==');
    aliceWs.send(JSON.stringify({ type: 'room_create', deckSize: aliceDeckSize }));
    const created = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
    const roomCode = created.code;

    console.log('== Bob joins, reporting his real 20-card (mismatched) deck size ==');
    const opponentJoinedPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_joined');
    bobWs.send(JSON.stringify({ type: 'room_join', code: roomCode, deckSize: bobDeckSize }));
    const [bobJoinedAck, aliceSeesOpponentJoined] = await Promise.all([
      waitForMessage(bobWs, (m) => m.type === 'room_joined'),
      opponentJoinedPromise,
    ]);

    assert(
      bobJoinedAck.opponent && bobJoinedAck.opponent.deckSize === aliceDeckSize,
      `Bob's room_joined reports Alice's REAL deck size (24), not Bob's own (got ${JSON.stringify(bobJoinedAck.opponent)})`
    );
    assert(
      aliceSeesOpponentJoined.opponent && aliceSeesOpponentJoined.opponent.deckSize === bobDeckSize,
      `Alice's opponent_joined reports Bob's REAL deck size (20), not Alice's own (got ${JSON.stringify(aliceSeesOpponentJoined.opponent)})`
    );
    // The exact failure QA found: each side wrongly showed the OTHER side's
    // deck size as a copy of their OWN. Guard against that regression
    // explicitly, not just "it's some number".
    assert(
      bobJoinedAck.opponent.deckSize !== bobDeckSize,
      "Bob's view of the opponent's deck size is NOT Bob's own deck size (the exact regression QA found)"
    );
    assert(
      aliceSeesOpponentJoined.opponent.deckSize !== aliceDeckSize,
      "Alice's view of the opponent's deck size is NOT Alice's own deck size (the exact regression QA found)"
    );

    console.log('\n== Bob disconnects and reconnects WITHOUT resending deckSize -- server must not wipe the stored value ==');
    const disconnectPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
    bobWs.close();
    await disconnectPromise;
    const bobWs2 = await connectWs(bob.cookie);
    const reconnectAckPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_reconnected');
    bobWs2.send(JSON.stringify({ type: 'room_join', code: roomCode })); // deliberately no deckSize this time
    const bobRejoinAck = await waitForMessage(bobWs2, (m) => m.type === 'room_joined');
    assert(bobRejoinAck.reconnected === true, 'Bob successfully reconnected');
    await reconnectAckPromise;

    console.log('== Alice disconnects/reconnects too, to independently re-observe Bob\'s (still-preserved) deck size ==');
    const aliceDisconnectPromise = waitForMessage(bobWs2, (m) => m.type === 'opponent_disconnected');
    aliceWs.close();
    await aliceDisconnectPromise;
    const aliceWs2 = await connectWs(alice.cookie);
    aliceWs2.send(JSON.stringify({ type: 'room_join', code: roomCode }));
    const aliceRejoinAck = await waitForMessage(aliceWs2, (m) => m.type === 'room_joined');
    assert(
      aliceRejoinAck.opponent && aliceRejoinAck.opponent.deckSize === bobDeckSize,
      `Bob's deck size (20) survived his own no-deckSize reconnect, still correct on Alice's rejoin (got ${JSON.stringify(aliceRejoinAck.opponent)})`
    );

    aliceWs2.close();
    bobWs2.close();
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Deck-size relay smoke test crashed:', err);
  process.exit(1);
});
