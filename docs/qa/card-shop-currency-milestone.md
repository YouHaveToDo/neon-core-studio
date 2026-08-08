# QA Report — Card Shop & Currency Milestone

**Scope:** `docs/design/card-shop-currency-proposal.md` §1–§11 vs. actual implementation
(Weaken status-effect engine, Ink currency, 8 expansion cards, deck-editor ownership
validation, shop/pull backend, shop screen UI). Method follows
`docs/qa/online-pvp-milestone.md`'s established convention for this repo: independent
verification against a genuinely running local stack, not a re-run of the programmer's
own tests trusted at face value (though those were run fresh first as a baseline — all
pass, see below).

**Environment:** Confirmed `server/.env`'s `DATABASE_URL` points at
`postgresql://postgres@localhost:5432/neoncore_dev` (local Postgres.app, not
production Supabase) before running anything, per the task's explicit warning about a
prior session's accidental prod write. All testing used a real spawned `server/`
process (`node src/index.js`, with `PVP_*` env overrides only where noted), real
Postgres, a static file server for `index.html`/`js/`/`css/`, and Playwright
(`chromium`, via a scratchpad-local install — not a repo dependency) driving the real
UI end-to-end for anything UI-relevant. All independent scripts referenced below were
written from scratch this session and live only in this session's scratchpad
(`/private/tmp/.../scratchpad/qa/`), not the repo; exact repro steps and output are
reproduced inline so a programmer can re-derive them without re-discovering anything.

---

## Verdict

**Not ready for production. Three independent Blocker-severity bugs found**, each in
a different subsystem this milestone shipped, none of which are caught by the
programmer's own (otherwise reasonable and passing) test suite:

1. **The entire 8-card expansion pool crashes the real battle UI the moment a card
   from it is actually in a player's hand during a match** (`js/ui.js` never learned
   about `EXPANSION_CARD_DEFS`). This is not a rare edge case — it is the normal,
   expected outcome of the feature working as designed (own a card → deck it → draw
   it in a match), and it makes the milestone's headline content (new cards) unusable
   in real play today.
2. **Ink can be double-awarded (and `match_history` double-written) for a single
   match** via a real, 100%-reproducible race in `report_result` handling — directly
   contradicts §5.4's atomicity claim and is exactly the class of bug the task asked
   to stress hardest.
3. **The Weaken status effect's turn-boundary decay fires one turn too early**,
   systematically shortening every Weaken grant's real effect by exactly one turn
   versus §3's literal definition — and reduces the single most common grant
   (Crippling Blow's Weaken 1) to a complete no-op with zero actual gameplay effect,
   ever.

Everything **not** touched by these three bugs is in good shape: the bag-pull
mechanic held up very well under genuinely adversarial concurrency testing (this was
the area flagged as highest-risk, and it earned that confidence), deck-ownership
validation is solid and correctly server-enforced (including under a deliberate
TOCTOU race against a concurrent pull), the 8 cards' data matches the spec table
exactly, Corrosive Aura's broader-than-expected interpretation is confirmed correct
against the doc's literal wording, and the shop UI's three response states plus
reload-mid-flow behavior all check out.

---

## Summary table

| # | Finding | Severity | Area |
|---|---|---|---|
| 1 | `js/ui.js` never falls back to `EXPANSION_CARD_DEFS` (3 call sites use raw `CARD_DEFS[cardId]`) — client throws an uncaught `TypeError` and the battle UI breaks the moment an expansion card needs to render in a player's own hand | **Blocker** | Battle UI / §4 |
| 2 | `report_result` has no protection against two near-simultaneous WS messages for the same match both being processed before the first's DB write tears the room down — Ink double-awarded, `match_history` double-written | **Blocker** | Ink atomicity / §5.4 |
| 3 | Weaken decay fires at the *start* of the weakened side's own turn, before they act — every grant delivers exactly N-1 effective turns instead of N; Weaken 1 (Crippling Blow) delivers 0 effective turns, a complete no-op | **Blocker** | Weaken engine / §3 |
| 4 | Corrosive Aura fires even on a fully-blocked hit (0 real HP damage) | Minor / ambiguous | §4 Corrosive Aura |
| — | Everything in "What passed" below | Pass | pull mechanic, deck ownership, card spec-conformance, Corrosive Aura's core-card scope, shop UI, void-match 0-Ink |

---

## What passed

### Programmer's own smoke/test suite (baseline re-run, all green)
Ran fresh against a live local server/DB (13 scripts, all actually executed, not just
read): `smoke-test.js`, `deck-smoke-test.js`, `ws-smoke-test.js`, `pvp-smoke-test.js`,
`match-history-smoke-test.js`, `expansion-cards-test.js`,
`expansion-deck-ownership-test.js`, `weaken-status-test.js`, `pull-smoke-test.js`,
`ink-award-smoke-test.js`, `double-disconnect-smoke-test.js`,
`deck-size-relay-smoke-test.js`, and `shop-ui-smoke-test.js` (needed a local
Playwright install pointed at via `NODE_PATH`, not a repo dependency). **All 13 pass.**
This is a genuinely well-tested suite for the scenarios it covers — the three Blockers
below all fall into gaps the suite's own scenario design doesn't reach (see each
finding's "why the existing tests didn't catch this").

### The "bag" pull mechanic — highest-risk area per the task brief, held up well
Independently written adversarial tests (`qa-pull-adversarial.js`), beyond what
`pull-smoke-test.js` already covers:
- **12 truly concurrent pull requests** (`Promise.all`, not sequential) against an
  account with Ink for exactly 5 pulls: exactly 5 succeeded, the other 7 all failed
  cleanly with `insufficient_ink`, final balance was exactly 0, final owned-card total
  was exactly 5, no card exceeded 3 copies, and the sum of every successful response's
  `cardId` matched the final DB state exactly — no lost update, no double-grant.
- **The exact 23/24 → 24/24 collection-complete boundary under concurrency**: seeded
  an account at 7 cards/3-copies + 1 card/2-copies (23 owned total, Ink for 6 pulls),
  fired 6 concurrent pulls. Exactly 1 succeeded (pulling precisely the missing 3rd
  copy), the other 5 all got `409 collection_complete` (never `insufficient_ink`,
  never a crash), final total was exactly 24 (never 25), and Ink was debited by
  exactly one pull's cost (structurally-impossible pulls never touch the balance, per
  §6.2's own stated invariant). A subsequent 25th pull attempt (post-boundary) was
  also correctly rejected with the balance unchanged.
- **Distribution check**: 400 single-pull trials with the bag artificially pinned to
  exactly 2 candidates each time (isolating the RNG pick from bag-composition
  effects) — 52.8%/47.3% split, no meaningful bias.

The row lock (`SELECT ... FOR UPDATE`) genuinely does what its doc comment claims.
This was the task's explicitly-flagged highest-risk area and it is the strongest
result in this whole pass.

### Deck ownership validation — solid, server is the real trust boundary
Independent adversarial tests via raw `fetch` calls (`qa-deck-ownership-adversarial.js`,
bypassing the UI entirely):
- Fresh account (0 expansion cards owned) attempting to save a deck with 1 copy of
  `enfeeble` → `400`, correct ownership-referencing error message.
- Account owning exactly 1 copy attempting to save 3 copies → `400`; saving exactly 1
  copy → `200` (the boundary is exact, not off-by-one in either direction).
- Malformed payload shapes (array instead of object, negative counts) → `400`, not
  silently coerced.
- **TOCTOU race**: fired a `PUT /api/decks/1` claiming 1 copy of an unowned card
  concurrently with a real `POST /api/economy/pull` that could grant that account's
  first copy of something. Checked the invariant directly against final DB state
  (not either response alone): the saved deck never claimed more copies than actually
  owned, in either race outcome.
- Core cards are genuinely unaffected: a fresh 0-expansion-cards account can still
  save a legitimate 27-card all-core deck at max-3-copies-each with zero ownership
  checks in the way.

### 8 expansion cards — spec conformance
Read `js/data.js`'s `EXPANSION_CARD_DEFS` against §4's table entry-by-entry (cost,
type, target, exact Korean effect text) for all 8 cards — **exact match**, not "close
enough" (including the deliberately-flavor-matching subtleties: Enfeeble correctly
`type: 'attack'` despite 0 damage, per §4.2's first-turn-lock rationale).

### Corrosive Aura's "core or expansion" claim — confirmed correct, one edge case flagged (see Finding 4)
Independently verified (`qa-corrosive-aura.js`, vm harness against the real
unmodified `js/state.js`/`js/data.js`):
- Casting Corrosive Aura then playing a **core** Strike (not one of the 8 new cards)
  correctly applies Weaken 1 to the opponent — the "fires for any Attack-vs-enemy
  card, core or expansion" claim is genuinely true, matching §4's Corrosive Aura row's
  literal wording ("이후 Attack 카드로 데미지를 줄 때마다") with no expansion-only
  qualifier in the doc text. The implementing session's broader-than-expected
  interpretation is correct, not an overreach.
- Correctly does NOT double-fire on Enfeeble (which already grants its own Weaken 2)
  — the explicit id exclusion in `applyCardEffect()` works as intended.

### Shop UI — all 3 response states + reload-mid-flow
`shop-ui-smoke-test.js` (programmer's own, re-run fresh) already drives all 3 states
via real clicks with server cross-checks: success reveal, insufficient-Ink error,
collection-complete banner. Independently added (`qa-shop-reload.js`) the one gap the
task specifically flagged that wasn't in that suite: **reloading the page mid-flow**
(right after a real pull, staying on the shop screen) — the reloaded page correctly
re-fetches and displays the server's real Ink balance (450, matching the real
post-pull server state exactly), not a stale/cached value. No `localStorage`/
`sessionStorage` caching of Ink/ownership exists anywhere in `js/shop.js`/`js/main.js`
(confirmed by grep), consistent with this passing cleanly.

### Ink award amounts and `void` — correct in isolation
`ink-award-smoke-test.js` and `match-history-smoke-test.js` (programmer's own, re-run
fresh) already cover win=15/loss=5/win_forfeit=15/forfeit-loss=5 via real matches.
Independently added a live check for the one case those don't specifically dollar-test
(`qa-void-ink-check.js`): a genuine simultaneous double-disconnect (both sockets
closed back-to-back, neither reconnects) resolves as `void` for both accounts with
**Ink balance provably unchanged** (0→0 in the test, checked against real pre/post
balances, not assumed from reading `recordVoidMatch()`'s code).

---

## Findings

### 1. [BLOCKER] Battle UI crashes the moment an expansion card is in a player's own hand — the entire 8-card pool is unusable in real matches

**Root cause (confirmed by code, not just inference):** `js/data.js` defines
`cardDefById(id)` specifically as the shared `CARD_DEFS[id] || EXPANSION_CARD_DEFS[id]`
lookup so callers never have to re-derive that fallback (its own doc comment says so
explicitly). `js/deck.js` and `js/shop.js` correctly use `cardDefById()` everywhere.
**`js/ui.js` does not** — it has 3 call sites that read the raw `CARD_DEFS[cardId]`
directly, which is `undefined` for any of the 8 expansion card ids:
- `buildCardNode()` (line 186) — builds the DOM node for every card in the hand
  (called from `renderHand()`, which runs on essentially every state-change render).
- The turn-1 attack-lock tooltip check (line 247): `CARD_DEFS[cardId].type === 'attack'`.
- `onHandCardClick()` (line 278): reads `card.target` to decide click behavior.

Confirmed via `git log --oneline -- js/ui.js`: the last commit to touch `js/ui.js` was
`f157db8` (an unrelated online-PvP fix). Neither `a3dede1` ("Add 8 expansion cards")
nor `bc4b72e` ("Wire shop screen... milestone complete") touched it — the file was
simply never updated when the expansion pool was introduced.

**Repro (confirmed via a genuine two-client, real-network Playwright match, not a
mocked/isolated test —`qa-weaken-decay-real-match.js`, originally written to test
Finding 3 below, but it hit this bug first while trying to reach that scenario):**
1. Real server, real Postgres, two separate signups, real room create/join, real
   How-to-Play dismissal, real battle screen reached on both sides.
2. The (2nd-player, now-active-on-turn-2) client's hand is set to contain
   `cripplingBlow` (one of the 8 expansion cards) — exactly what a normal draw from a
   deck containing an owned expansion card would produce.
3. That client calls `AL.selectCard(0)` (the real function a click on that card in
   hand invokes) to play it.

   **Result:**
   ```
   page.evaluate: TypeError: Cannot read properties of undefined (reading 'type')
       at buildCardNode (http://localhost:8081/js/ui.js:188:40)
       at http://localhost:8081/js/ui.js:227:16
       at Array.forEach (<anonymous>)
       at renderHand (http://localhost:8081/js/ui.js:221:10)
       at renderBattle (http://localhost:8081/js/ui.js:163:5)
       at render (http://localhost:8081/js/ui.js:99:36)
       at http://localhost:8081/js/state.js:137:47
       at Array.forEach (<anonymous>)
       at emit (http://localhost:8081/js/state.js:137:31)
       at Object.selectCard (http://localhost:8081/js/state.js:375:7)
   ```
   `state.js`'s `emit()` has no error handling around its listener `forEach`, so this
   propagates as an uncaught exception straight out of `selectCard()`. The DOM never
   updates for that render pass; depending on exactly when this happens the client is
   left with a stale/partial hand render, a `console.error`, and the game state having
   silently diverged from what's on screen.

**Why the programmer's own tests didn't catch this:** `weaken-status-test.js` and
`expansion-cards-test.js` both use a Node `vm` harness that loads `js/state.js`/
`js/data.js` directly and calls their functions programmatically — this never touches
`js/ui.js`'s render path at all, so a card ever actually rendering in a hand is never
exercised. `shop-ui-smoke-test.js` is a real Playwright test, but it only ever
exercises the **shop screen** (`js/shop.js`, which correctly uses `cardDefById()`),
never the battle screen with an expansion card actually in a deck/hand. No existing
test in the suite drives a real battle with an owned expansion card in a real deck.

**Why Blocker:** this is not an edge case — it is the default, expected outcome of a
player using the feature exactly as designed (pull a card in the shop → put it in a
deck via the editor, which the editor correctly allows → queue a match with that deck
→ draw the card). The entire 8-card expansion pool, the headline content of this
milestone, cannot currently be used in a real match without crashing the client.

**Suggested area to look at (not a fix):** the 3 call sites in `js/ui.js` listed
above; the fix pattern `js/deck.js`/`js/shop.js` already use (`cardDefById()`) is
right there as a working reference.

---

### 2. [BLOCKER] `report_result` race: Ink can be double-awarded and `match_history` double-written for one match

**Spec reference:** §5.4 states Ink is credited "정확히 같은 시점" (at exactly the
same moment) as the `match_history` write, in the same transaction, specifically to
avoid any window where one happens without the other. The transaction itself
(`lib/matchHistory.js`'s `recordMatchResult`) is correctly atomic for a **single**
call — the bug is that the server can be made to call it **twice** for what is really
one match ending.

**Root cause (confirmed by code):** `server/src/ws/server.js`'s `handleMessage()`
dispatches `onReportResult(ws, msg)` (an `async` function) without awaiting it — two
different WebSocket connections' `message` events are handled independently, and
Node's event loop can interleave them. `onReportResult()`'s own doc comment claims
this is safe ("if the other client also sends its own report_result a moment later,
the room is already gone... no double-write") — but that's only true if the second
message arrives *after* the room teardown at the end of the first call. If both
clients send `report_result` close enough together that both handlers start running
before the first one's `await recordMatchResult(...)` (a real DB round-trip) resolves
and `endRoomAndClearSockets(room)` runs, **both handlers find the room still present**,
and both independently call `recordMatchResult()`.

This is not a contrived timing window — both clients detecting match end and
independently reporting their own result at essentially the same real-world instant
is the normal path (spec §6.4: "HP hitting 0 ends the match IMMEDIATELY on whichever
client detects it"). Any exchange where a hit brings a player's HP to 0 causes *both*
clients to independently and near-simultaneously conclude the match is over and each
report their own side's result.

**Repro (`qa-double-report-result-race.js`, real spawned server, real Postgres, real
two-account WS session):**
1. Real signup (Alice, Bob), real room, real `start_match`.
2. Fire `report_result` from **both** clients back-to-back, no `await` between the two
   `ws.send()` calls (Alice reports `'win'`, Bob reports `'loss'` — consistent
   results, this isn't even a disagreement case, just a race):
   ```js
   aliceWs.send(JSON.stringify({ type: 'report_result', result: 'win' }));
   bobWs.send(JSON.stringify({ type: 'report_result', result: 'loss' }));
   ```
3. Wait 1.5s for everything to settle, then read Ink balances via `GET /api/economy`
   and `match_history` rows directly from Postgres.

   **Result (100% reproducible, 3/3 runs):**
   ```
   Ink gain -- Alice: +30 (expected +15), Bob: +10 (expected +5)
   Alice match_history rows: [{"result":"win", ...}, {"result":"win", ...}]  (2 rows, identical)
   Bob match_history rows:   [{"result":"loss", ...}, {"result":"loss", ...}] (2 rows, identical)
   ```
   Alice's Ink was credited +15 **twice** (30 total), Bob's +5 **twice** (10 total),
   and each account got 2 identical `match_history` rows for what was one match.

**Why the existing tests didn't catch this:** `pvp-smoke-test.js` and
`ink-award-smoke-test.js` both exercise `report_result`/forfeit paths sequentially
(one client's message, wait for the response, then proceed) — never two clients
racing the same match-end message against each other, which is exactly the scenario
that matters here.

**Severity:** Blocker. This is a direct, 100%-reproducible violation of the currency
atomicity guarantee the task asked to stress hardest, triggered by completely normal
play (not a contrived double-click or malicious client) — any real match's natural
ending is a plausible trigger.

**Note:** the *disconnect/forfeit* paths (`finalizeForfeit`, `finalizeVoidMatch`) look
structurally safer against the equivalent race — `onDisconnectGraceExpired` is driven
by server-side timers rather than two independently-racing client messages for the
same event, and `claim_forfeit`'s check on `opponent.connected` plus the grace-floor
timing makes a symmetric double-call harder to construct — but this wasn't
exhaustively fuzzed given the time budget; flagging as unverified rather than
claiming it's clean.

**Suggested area to look at (not a fix):** `onReportResult()` currently checks
`rooms.getRoom(ws.roomCode)` for existence but does nothing to claim/lock the room
before its `await`; the room-teardown (`endRoomAndClearSockets`) that's supposed to
prevent a second call happens strictly after the DB write completes, leaving the race
window described above open for the entire duration of that write.

---

### 3. [BLOCKER] Weaken decay fires one turn too early — every grant delivers N-1 effective turns instead of N, and Weaken 1 is a complete no-op

**Spec reference:** §3.1, literally: *"약화 N은 '이 캐릭터의 앞으로 오는 턴 N번
동안 공격력 -25%'를 의미한다"* — "Weaken N means -25% attack power for this
character's next N turns." The decay rule says stacks decrement "약화 스택을 가진
캐릭터의 자기 턴이 끝날 때마다(End Turn 처리 시점, 방어도가 리셋되는 것과 같은 턴
경계 훅)" — at that character's own turn-end, the same turn-boundary hook as Block's
reset.

**Root cause (confirmed by code, exact production module, not a paraphrase):**
`js/state.js`'s `localTurnStart()` (fires when the local player's own turn begins)
and `applyRemoteTurnStart()` (fires when the opponent's own turn begins) both
decrement `weaken` **as the very first thing they do, before any card can be played
that turn**:
```js
function localTurnStart() {
    state.player.block = 0;
    if (state.player.weaken > 0) state.player.weaken -= 1;   // <-- decays BEFORE this turn's actions
    state.player.mana = state.player.maxMana;
    ...
```
Block resetting at the start of your own turn is a standard, correct convention (block
persists through the opponent's turn to absorb their attack, then clears when you
start planning your own turn). But applying Weaken's decay at that *same* moment means
a stack granted **during the opponent's preceding turn** (the overwhelmingly common
case — every enemy-targeting card, e.g. Crippling Blow, is played on the attacker's
own turn, which is the *target's* opponent-turn) gets decremented **before the
weakened character ever gets to act on it**. For a 1-stack grant, this means the
character's next attack is never actually reduced at all.

**Repro A — vm harness against the real, unmodified `js/state.js`/`js/data.js`
(`qa-weaken-decay-timing.js`, same technique as the programmer's own
`weaken-status-test.js`, so no risk of this being a harness artifact — it's the exact
production module):**
1. Fresh match, player ends turn 1 with nothing played.
2. Opponent's turn starts (`applyRemoteAction({type:'turnStart'})`), opponent plays
   Crippling Blow on the player (`applyRemoteAction({type:'playCard', cardId:
   'cripplingBlow'})`) — confirmed `player.weaken === 1` right after.
3. Opponent ends their turn (`applyRemoteAction({type:'endTurn'})`) → player's own
   turn starts (`localTurnStart()` runs). Read `player.weaken` immediately: **0**
   (decayed already, before any card has been played this turn).
4. Player plays Strike (base 6, no Bloodlust) targeting the opponent.

   **Result:**
   ```
   player's Weaken immediately after their own turn-start boundary: 0
   Strike dealt 6 damage (expected 4 if Weaken 1 still applied a reduction)
   FAIL  Strike is reduced by Weaken 1 granted last turn -- floor(6*0.75)=4 (got 6)
   ```
   Weaken 1, applied by an opponent's Crippling Blow, has **zero measurable effect**
   on the target's very next (and only) turn where it could have mattered.

**Repro B — same harness, Weaken 3 (Crushing Curse), tracking how many of the
player's own turns actually see the reduction:**
```
player's turn #1 after the grant: Weaken now 3, Strike dealt 4   (reduced)
player's turn #2 after the grant: Weaken now 2, Strike dealt 4   (reduced)
player's turn #3 after the grant: Weaken now 0, Strike dealt 6   (NOT reduced)
total reduced-damage turns: 2 (spec implies this should be 3)
```
Weaken 3 delivers exactly 2 effective turns of reduction, not 3.

**Repro C — self-granted Weaken (Overextend, "자신에게 약화 2 부여") — same
off-by-one, informational, included for completeness since self-grants happen mid the
caster's own turn (after that turn's decay already ran) and so behave slightly
differently in timing but not in outcome:**
```
player's Weaken right after casting Overextend on themselves: 2
player's own turn #1 after self-cast: weaken-after-decay=1, Strike dealt 4  (reduced)
player's own turn #2 after self-cast: weaken-after-decay=0, Strike dealt 6  (NOT reduced)
self-granted Weaken 2 produced 1 turn(s) of actual reduced own-damage (spec implies 2)
```

**Real-network confirmation attempted, blocked by Finding 1:** a genuine two-client
Playwright repro of Repro A was written (`qa-weaken-decay-real-match.js`) to confirm
this isn't a vm-harness-only artifact, but it hit **Finding 1's crash** the moment the
opponent tried to play `cripplingBlow` from their real hand — which is itself
independent, real-network corroboration of Finding 1's severity (a real match cannot
currently get an expansion card through a real hand-render at all). Finding 3 itself
is still confirmed with high confidence because the vm harness loads the *exact,
unmodified* `js/state.js`/`js/data.js` files (not a reimplementation) — the same
technique the programmer's own `weaken-status-test.js` uses and that this project's
QA conventions already treat as sound for pure rules-engine verification (no
browser-only globals involved in the code path under test).

**Why the programmer's own `weaken-status-test.js` didn't catch this:** its Test D
(turn-boundary decay) starts from `weaken = 2`/`3` and only checks the *counter value*
decrements correctly across boundaries — it never combines "decay just fired" with
"immediately play a damage-dealing card in that same turn" to check whether the
*effect* still applies. Its final check (weaken reaches 0 → full damage) only tests
the fully-decayed end state, not the critical "still nonzero right after this turn's
decay" moment where the off-by-one actually lives.

**Severity:** Blocker. This is not a cosmetic numbers-off-by-a-little issue — it
systematically breaks the stated behavior of the milestone's single new core mechanic
across every card that uses it. Crippling Blow (§4's own design rationale explicitly
prices it as delivering "a lighter payload than Piercing/Execute" specifically
*because* of its Weaken 1 grant) currently delivers **no payload at all** — it is
just a plain damage card with dead flavor text. Exploit Weakness's own conditional
bonus ("상대가 이미 약화 상태면 16 데미지") still combos correctly *within the same
turn* as a setup card (no decay happens mid-turn), but any attempt to set up Weaken on
one turn and capitalize on it your *next* turn is undermined by this bug across the
board.

**Suggested area to look at (not a fix):** `localTurnStart()`/`applyRemoteTurnStart()`
decrementing `weaken` at the same moment they reset `block`/`mana`, before that
turn's actions happen, is the mechanism — some form of "decay at the end of the
weakened side's turn instead of the start of their next one" (matching the literal
spec wording, not just the "same hook as Block" shorthand) looks like the shape of a
fix, but that's a call for the programmer/designer, not prescribed here.

---

### 4. [Minor / ambiguous] Corrosive Aura fires even when the target's Block fully absorbs the hit (0 real HP damage)

`js/state.js`'s Corrosive Aura trigger check (`card.type === 'attack' && card.target
=== 'enemy' && card.id !== 'enfeeble'`) does not check whether any HP damage actually
landed — only whether the played card is a non-Enfeeble Attack card targeting the
enemy. Confirmed live (`qa-corrosive-aura.js`): giving the opponent 999 Block, then
playing Strike (fully absorbed, 0 HP damage), Corrosive Aura still applies Weaken 1.

§4's Corrosive Aura effect text is "이후 Attack 카드로 데미지를 줄 때마다 상대에게
약화 1 부여" ("whenever [you] deal damage with an Attack card") — whether "deal
damage" should be read as "the card's raw damage value is non-zero" (current
behavior, consistent with Enfeeble's explicit 0-damage-by-design exclusion, which
suggests the intended reading really is "any non-Enfeeble Attack card played") or
"damage actually reached the target's HP" (which a fully-blocked hit arguably didn't)
is genuinely ambiguous from the doc text alone. Flagging for the game designer to
confirm the intended reading rather than treating this as a clear-cut bug — the
current behavior is internally consistent with the Enfeeble exclusion's own logic,
which is why this is Minor/ambiguous rather than a bug report with a definite
expected value.

---

## What I did not get to (for honesty about coverage)

- Did not exhaustively fuzz the disconnect/forfeit result-recording paths
  (`finalizeForfeit`/`finalizeVoidMatch`) for the equivalent double-call race Finding 2
  found in `report_result` — reasoned through why they look structurally less exposed
  (server-timer-driven rather than two racing client messages) but did not write a
  dedicated adversarial repro given the time budget.
- Did not attempt to reach Finding 3's real-network confirmation past the point where
  it hit Finding 1's crash (would require either fixing Finding 1 first or stubbing
  around it, which felt like scope creep for a QA pass — noting the dependency instead
  is more honest than working around it silently).
- Did not test Weaken's interaction with the turn-1 attack-lock or a
  forfeit-mid-Weaken-effect scenario specifically (e.g. does a claimed forfeit while
  a Weaken stack is active leave anything in a bad state) — `expansion-cards-test.js`
  already confirms the 8 cards' turn-1-lock classification is correct, and no
  Weaken-specific forfeit interaction was found or suspected during this pass, but it
  wasn't specifically adversarially tested either.
- Did not test the shop/pull flow against a genuinely different physical device — same
  equivalence the prior PvP milestone report used (separate browser process = good
  enough proxy), not literally tested from a second machine.

---

## Files referenced

- Spec: `/Users/jungjongchan/Desktop/company/docs/design/card-shop-currency-proposal.md`
- Root cause, Finding 1: `/Users/jungjongchan/Desktop/company/js/ui.js` (`buildCardNode`
  line 186, turn-lock tooltip check line 247, `onHandCardClick` line 278),
  contrasted with the correct pattern in `/Users/jungjongchan/Desktop/company/js/deck.js`
  and `/Users/jungjongchan/Desktop/company/js/shop.js` (`cardDefById()`,
  `/Users/jungjongchan/Desktop/company/js/data.js` line 159)
- Root cause, Finding 2: `/Users/jungjongchan/Desktop/company/server/src/ws/server.js`
  (`handleMessage`, `onReportResult`), `/Users/jungjongchan/Desktop/company/server/src/lib/matchHistory.js`
  (`recordMatchResult`)
- Root cause, Finding 3: `/Users/jungjongchan/Desktop/company/js/state.js`
  (`localTurnStart`, `applyRemoteTurnStart`, `applyWeaken`, `applyWeakenToDamage`)
- Finding 4: `/Users/jungjongchan/Desktop/company/js/state.js` (`applyCardEffect`'s
  Corrosive Aura trigger check, near the end of the function)
- Existing programmer tests read/re-run (all pass, baseline):
  `/Users/jungjongchan/Desktop/company/server/scripts/smoke-test.js`, `deck-smoke-test.js`,
  `ws-smoke-test.js`, `pvp-smoke-test.js`, `match-history-smoke-test.js`,
  `expansion-cards-test.js`, `expansion-deck-ownership-test.js`, `weaken-status-test.js`,
  `pull-smoke-test.js`, `ink-award-smoke-test.js`, `double-disconnect-smoke-test.js`,
  `deck-size-relay-smoke-test.js`, `shop-ui-smoke-test.js`
- Independent QA scripts (this session's scratchpad, not part of the repo):
  `qa-double-report-result-race.js`, `qa-pull-adversarial.js`,
  `qa-deck-ownership-adversarial.js`, `qa-weaken-decay-timing.js`,
  `qa-weaken-decay-real-match.js`, `qa-corrosive-aura.js`, `qa-shop-reload.js`,
  `qa-void-ink-check.js`
- Migration verified: `/Users/jungjongchan/Desktop/company/server/migrations/003_add_ink_and_expansion_cards.sql`
- `server/.env` confirmed pointing at local Postgres (`neoncore_dev`) before any
  testing began, per the task's explicit warning.
