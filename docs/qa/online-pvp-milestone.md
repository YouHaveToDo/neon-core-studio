# QA Report — Online PvP Milestone

**Scope:** `docs/design/spec-online-pvp.md` §1–§10 vs. actual implementation (`server/`, `js/`).
Corresponds to `docs/design/online-pvp-plan.md` Phase 6 (tasks 6.1–6.4). This is the
first QA pass in this repo — `docs/qa/` did not exist before this report. Naming
convention going forward: kebab-case, feature-scoped, e.g.
`docs/qa/<feature-or-milestone>.md`.

**Method:** Independent verification, not a re-run of the programmer's own smoke
tests (though those were run first as a sanity baseline — all pass, see below).
Testing used a genuinely running local stack: Postgres.app (`neoncore_dev`,
migrations already applied), the real `server/` process (`npm start`, sometimes with
`PVP_TURN_TIMEOUT_MS` / `PVP_DISCONNECT_GRACE_MS` / `PVP_CLAIM_FORFEIT_FLOOR_MS` env
overrides — same mechanism `server/scripts/pvp-smoke-test.js` uses — to make
multi-second wait windows practical without changing spec-default production
behavior), a static file server for `index.html`/`js/`/`css/`, and Playwright
(`chromium@151`, two **separate browser process launches**, not just two contexts —
see the note under Turn-Timer Correctness for why that distinction mattered) driving
the real UI end-to-end. All test scripts referenced below live in this session's
scratchpad and are not part of the repo; commands/output are reproduced inline so a
programmer can re-derive exact repro steps without re-discovering them.

---

## Verdict

**Not ready to call fully done.** The core PvP loop (auth, deck persistence, matchmaking,
real-time battle, match end, match history) genuinely works end-to-end and a real,
unscripted two-client match plays out correctly with no desync at any checked point.
However, one **blocker**-severity bug was found in the turn-timer's server-enforcement
path — the exact area task 6.3 flagged as needing dedicated scrutiny — that undermines
the stated reason server-side enforcement was built in the first place. Two more
**major** issues (double-disconnect dead-end, opponent deck-size display) and two
**minor** items round out the findings. Recommend: fix the Blocker before shipping;
the two Majors are real player-facing bugs but narrower in trigger conditions and
could ship with a tracked follow-up if the timeline is tight — that's a product call,
not mine to make unilaterally.

---

## Summary table

| # | Finding | Severity | Task ref |
|---|---|---|---|
| 1 | Server-enforced turn timeout doesn't reliably propagate to the OPPONENT's game state when the timed-out client is unresponsive (frozen JS) or parked on a non-battle screen (How to Play) — defeats the stated purpose of server-side enforcement, and causes hand-count corruption on recovery | **Blocker** | 6.3 (+ the flagged How-to-Play gap) |
| 2 | Simultaneous double-disconnect: room silently deleted, no `match_ended` for either side, no `match_history` row, no reconnect path | **Major** | 6.4 |
| 3 | Opponent deck-size display uses the LOCAL player's own deck length as a fallback — confirmed visibly wrong in a real mismatched-deck-size match, both directions | **Major** | spec §7.2 |
| 4 | Spec self-contradiction: §5.2's parenthetical ("disabled button, not just unresponsive-click") vs. §5.5's explicit instruction for the same editor tiles ("disabled style + click has no response") — implementation follows §5.5 | Minor (spec ambiguity, not a bug) | spec §5.2 vs §5.5 |
| 5 | Client hardcodes the 45s/10s disconnect timings independently of the server's actual config (`js/battle.js`, "display-only") | Minor (latent drift risk, not a bug today) | spec §8 |
| — | Everything in "What passed" below | Pass | 6.1, 6.2, 6.3 (happy path), 6.4 (happy path), coin-flip |

---

## What passed

### Programmer's own smoke tests (baseline re-run, all green)
Ran fresh against a live local server/DB (not just read, actually executed):
- `node scripts/smoke-test.js` — 21/21 assertions pass (signup/login/logout, dup-email,
  validation, unified wrong-password/no-such-account message, session persistence).
- `node scripts/deck-smoke-test.js` — full CRUD + rule enforcement + logout/login
  persistence, all pass.

(`ws-smoke-test.js`, `pvp-smoke-test.js`, `match-history-smoke-test.js` were read in
full and their coverage judged sound; I did not re-run them verbatim since my own
independent tests below cover the same ground through the real UI/DB rather than
raw WS, which is a stronger signal for the same claims. `pvp-smoke-test.js`'s
Scenario A specifically already proves the server fires `turn_timeout` within
~200ms of the configured deadline — I relied on that for "does the server's own
clock fire on schedule" and spent my own effort on "does that actually reach the
opponent," which is where the bug in Finding 1 lives.)

### 6.1 — Auth + persistence
- Starter deck verified **card-by-card** against spec §5.4's table (not just "24
  cards exist"): `strike:3, defend:3, heavySlash:2, twinStrike:2, piercingStrike:2,
  execute:1, recklessSwing:1, quickGuard:2, secondWind:2, adrenaline:1, fortify:2,
  ironSkin:1, bloodlust:1, hoarder:1` — exact match against
  `server/src/lib/starterDeck.js`'s `STARTER_DECK_SLOT1`, sums to 24, all 14 card ids
  present at ≥1.
- Additional auth boundary-value edge cases beyond the existing smoke test (all via
  direct `fetch` against the live server, real DB writes):
  - Password exactly 8 chars → **accepted** (201); 7 chars → **rejected** (400).
  - Display name exactly 2 chars → accepted; exactly 16 → accepted; 1 char →
    rejected; 17 chars → rejected; whitespace-only (`"  "`, trims to empty) →
    rejected.
  - Email dedup is case-insensitive (`Foo@Example.com` then `FOO@EXAMPLE.COM` →
    second signup correctly rejected as duplicate); login with a different-case
    email than the one used at signup still succeeds (200).
  - Fully empty signup body → all three field errors returned together, not a crash.
- Zero-valid-deck gating (spec §6.1) verified live end-to-end: fresh account → 플레이
  enabled → delete the only deck (the starter deck) via the real delete-confirm
  modal → 플레이 becomes **disabled at the main-menu level** (not just inside
  deck-select) with the exact spec copy "매치를 시작하려면 유효한 덱(20~30장)이
  하나 이상 있어야 합니다" + "덱 관리로 이동" button.
- Deck editor UI-level max-3-copies / max-30-total enforcement verified by code
  inspection (`js/deck.js` `renderPoolGrid()`: the click listener is conditionally
  never attached once `maxedOut` is true, plus a defense-in-depth check inside
  `addCard()`; `css/pvp-components.css` `.pool-card-wrap.maxed` lowers opacity) —
  **not** re-driven interactively via Playwright clicks (time budget); the
  server-side version of the same rule (which is the actual enforcement boundary,
  per `routes/decks.js`'s own doc comments — "never trust the client") IS covered
  by the deck-smoke-test.js re-run above.

### 6.2 — Two-client PvP regression
Ran a **genuine, unscripted** two-client match (`two-client-match.js`): real signup
via the UI, real deck select, real room create/join, real How-to-Play dismissal on
both sides, then repeatedly queried each hand for "the first affordable card" and
played it for real (not a scripted sequence of specific cards) until the match
reached a natural HP-based conclusion. Checked sync at **multiple points**, not just
start/end:
- At match start: exactly one client saw `turn === 'player'`; first player's own
  hand was 5 cards, second player's was 6, and each side's *view of the other's*
  hand count matched (spec §6.3 step 3).
- After the first real card play (Fortify, a self-target skill): mana and hand
  count matched between the active player's own view and the passive player's
  "opponent" view.
- After a manual End Turn: both clients' `turn` flipped correctly (active→opponent,
  passive→player).
- After the second player's own real card play (Piercing Strike, an attack):
  mana still in sync.
- Full match played to conclusion in 13 simulated turns: ended with exactly one
  `matchResult: 'win'` and one `'loss'`, no desync detected at any checkpoint.

No hand/deck/HP/mana desync was found in this normal-conditions run. (Contrast with
Finding 1 below, which required deliberately abnormal conditions — a frozen client
or a stuck How-to-Play overlay — to surface.)

### 6.3 — Turn-timer correctness (happy-path half)
Confirmed the server's *own* internal clock fires `turn_timeout` on schedule
regardless of anything client-side (this is what `pvp-smoke-test.js`'s existing
Scenario A already proves rigorously — elapsed time asserted ≥ configured timeout
- 200ms). Confirmed via my own frozen-client test (see Finding 1) that a genuinely
JS-frozen client's socket stays alive (browser-level WS ping/pong is handled below
the page's JS thread, confirmed empirically — the connection never drops during a
9s main-thread freeze) and that **the timed-out client itself**, once its JS
resumes, correctly self-corrects to the server-forced result (discarded hand, turn
flipped to opponent) — this part of "the server is authoritative, not the client's
own clock" does work as designed. What does *not* work is documented as the
Blocker below.

### 6.4 — Disconnect/forfeit (happy path)
Ran end-to-end via a **real browser-context close** (genuine WS close frame, not a
frozen thread) against the server running with real spec timings
(`disconnect-forfeit.js`, no timing overrides — 45s/10s exactly as production would
run):
- Disconnect overlay appears on the connected client immediately.
- Claim-forfeit button is disabled immediately after disconnect.
- Claim-forfeit button becomes enabled at 10007ms (spec: 10s floor) — did not
  claim, to also exercise the next step.
- Auto-forfeit fires at 45490ms (spec: 45s) with the exact copy "승리! (상대방
  접속 종료)".

Timer pause/resume across a disconnect is already covered rigorously by
`pvp-smoke-test.js` Scenario C (resume mid-turn after reconnect, asserting the same
paused deadline resumes) — read and judged sound, not re-derived independently
given the time budget went to the double-disconnect gap instead (see Finding 2).

### Coin-flip (host-first / guest-first, `js/match.js`)
`hostGoesFirst()` is `(abs(hashRoomCode(roomCode)) % 2) === 0` — a pure function of
the room code. Ran the real function against 20,000 randomly generated 6-char room
codes (same alphabet the server actually generates from,
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`): **50.33% host-first / 49.67% guest-first** — no
meaningful bias. Also observed both outcomes directly in real two-client matches
across multiple different room codes during the other tests above (e.g. `first
player: B` in one run, `first player: A` in another, different room codes each
time). No bug found here.

### XSS spot-check (not explicitly requested, cheap to verify given display names are shown in several places)
`js/ui.js`'s opponent-name render uses `textContent` (safe). `js/history.js`'s
match-list rows build each cell via `textContent` (safe). `js/match.js`'s lobby
"opponent found" line is the one place that builds `innerHTML` with an
attacker-influenced value (the opponent's display name) — it runs the string
through a local `escapeHtml()` first. No injection point found.

---

## Findings

### 1. [BLOCKER] Server-enforced turn timeout doesn't reliably propagate to the opponent's actual game state — undermines the reason server-side enforcement exists

**Spec/task reference:** `online-pvp-plan.md` task 2.5's stated rationale ("since
v1's original non-authoritative-relay design didn't address client-clock trust for
timers") and task 6.3's explicit ask ("simulate a frozen/unresponsive client and
confirm the server times it out anyway, not just 'the timer visually counts down in
a normal browser'").

**Root cause (confirmed by code, not just inference):** The server's
`turn_timeout`/`turn_started` broadcasts (`server/src/ws/server.js`) are real and
fire on schedule (already proven by `pvp-smoke-test.js`). But on the client,
`js/battle.js`'s `handleTurnStarted()` **only updates the timer UI** (deadline +
label position) — it never touches `AL.state.turn` or any other game state. The
*only* place `AL.state.turn` actually flips for the **passive** (non-timed-out)
player is `applyRemoteEndTurn()` (`js/state.js`), which is only ever invoked in
response to a peer-to-peer `action` message of type `endTurn` — and that message is
only ever sent by the **timed-out client itself**, from inside
`handleTurnTimeout()`, which explicitly early-returns unless
`AL.state.screen === 'battle'` and the timed-out client's own turn/frozen flags are
in the expected shape. In other words: the server's "authoritative" timeout is
authoritative for *when the server privately advances its own bookkeeping*, but the
actual game-state transition for the OTHER player is still 100% dependent on the
misbehaving client's own JS eventually running and cooperating — exactly the
trust assumption server-side enforcement was supposed to remove.

**Repro A — frozen client (`frozen-client-timeout.js` + `frozen-client-timeout-probe.js`):**
1. Server run with `PVP_TURN_TIMEOUT_MS=6000`.
2. Two **separate Chromium browser process launches** (important — see note below),
   real signup, real room, both dismiss How to Play, reach battle. Confirm exactly
   one client has `turn === 'player'`.
3. On the **active** player's page, run a synchronous busy-loop for 8.5s
   (`while (Date.now() < end) {}`) — this blocks that tab's entire JS main thread,
   including its own timer rendering and WS message handling, while the underlying
   WS connection itself stays alive (confirmed: no disconnect/forfeit path
   triggers during the freeze — browser-level ping/pong is handled below the page's
   JS thread).
4. Poll the **passive** (alive) player's `AL.state.turn` from Node throughout.

   **Expected** (per the stated design goal): passive client's turn should begin
   ~6000ms after the freeze starts, driven by the server's broadcast, independent
   of when the frozen tab wakes up.

   **Actual:** passive client's `turn` only flips to `'player'` at **8537ms** — i.e.
   almost exactly when the frozen tab's busy-loop *ends* (8500ms), not when the
   server's 6000ms deadline fires. Confirmed via a follow-up probe
   (`frozen-client-timeout-probe.js`) reading the passive client's state at
   T+7500ms (1.5s after the server's deadline, 1.5s before the freeze ends):
   ```json
   { "turn": "opponent", "frozen": false, "turnBusy": false, "handLen": 6,
     "mana": 3, "timerLabel": "Opponent", "timerValue": "05",
     "timerParent": "opponent-meta-row" }
   ```
   The timer UI *did* pick up a fresh countdown from the server's new
   `turn_started` broadcast (value "05" ≈ time remaining in what is, per the
   server, already the passive player's own new turn) — but `turn` is still
   `'opponent'` and the timer is still positioned/labeled as if it's the opponent's
   turn. The passive player cannot act, doesn't know it's "their turn" by any
   signal other than a countdown mislabeled as belonging to someone else, and if
   nothing intervenes, the server's own clock for *that* turn will eventually
   time out too, cascading further while the frozen player is still frozen.
5. Once the frozen tab's freeze ends and its own queued `turn_timeout` (matching
   its own account id) is finally processed, it calls `AL.endTurn()` locally →
   emits its `endTurn` action → **only then** does the passive client's state
   catch up. Observed **hand-count corruption** as a direct result: the passive
   client's hand grew from 6 to **11 cards** (the stale 6-card hand was never
   discarded through a normal turn-end, and a fresh 5-card draw was added on top
   once `localTurnStart()` finally ran) — a real, reproducible state-integrity bug,
   not just a display delay.

   *(Testing note: this was originally run with two Playwright **contexts** of one
   browser instance, which produced a misleadingly identical artifact — the
   passive context's own `evaluate()` calls appeared to stall for the same
   duration as the freeze, which could be mistaken for a test-harness bug. Two
   fully separate `chromium.launch()` processes eliminated that ambiguity and
   reproduced the identical ~8537ms figure, confirming this is a real product bug,
   not a test artifact. Flagging this so nobody "fixes" the finding by blaming the
   test tooling without re-verifying with separate processes.)*

**Repro B — How to Play left open past the timeout (`howto-during-timeout.js`),
the specific scenario flagged by a prior session as "low likelihood, not fixed":**
1. Server run with `PVP_TURN_TIMEOUT_MS=6000`.
2. Active player deliberately does **not** dismiss the auto-shown How-to-Play
   overlay (passive player dismisses theirs normally and reaches battle).
3. Wait 9000ms (past the active player's own 6000ms turn timeout).

   **Result:**
   - Active player: still on `screen: 'howto'`, `turn` still `'player'` — their own
     timed-out turn never gets force-ended locally (matches `handleTurnTimeout()`'s
     `AL.state.screen !== 'battle'` early return, confirmed).
   - Passive player, **same moment**: `turn: 'opponent'` still, hand untouched —
     **the entire match is frozen for both players**, not just a display glitch on
     the active side. This is a stronger real-world impact than the prior "low
     likelihood" framing suggested: it doesn't require How-to-Play to be open
     "past 24s" by accident — a player who is simply reading the tutorial slowly,
     or who opens it mid-match via the "?" button and gets distracted, silently
     stalls the *opponent* too, with no visible indication anything is wrong on
     the opponent's side (their timer UI shows a normal-looking countdown, per
     Repro A's finding above).
   - When the active player **finally** closes the overlay: `screen` returns to
     `'battle'`, but **`turn` is still `'player'`** — the spec §7.3 timeout
     behavior (cancel unresolved selected card, discard hand, pass turn) is never
     applied. The player effectively keeps their turn indefinitely as long as they
     hold the overlay open, and none of the server-side timeouts that fired in the
     background (there could be several, stacking, if held open long enough) ever
     get reconciled — this is a working way to get unlimited extra time on a turn,
     not just a cosmetic gap.

**Why Blocker, not Major:** Task 6.3 explicitly named this exact scenario
("simulate a frozen/unresponsive client") as the reason a dedicated check was
warranted, because it's the whole justification for building server-side
enforcement in the first place (vs. trusting each client's own clock). The feature
does not actually deliver on that promise under the specific condition it was built
to handle, and the failure mode (opponent silently stuck, plus real hand-count
corruption on recovery) is a genuine "game is broken" experience for the innocent
opponent, not a minor visual issue.

**Suggested area to look at (not a fix — QA doesn't prescribe implementation):**
`handleTurnStarted()`/`handleTurnTimeout()` in `js/battle.js` and `applyRemoteAction`
in `js/state.js` currently treat the server's `turn_started`/`turn_timeout` messages
as timer-UI-only signals; the actual turn-boundary state transition
(`localTurnStart()`/discard) only ever runs in response to the peer `action`
channel. Making the *passive* client's own turn genuinely begin off the server's
`turn_started` broadcast (independent of ever receiving the timed-out player's
`endTurn` action) looks like it would close both repros, but that's a call for the
programmer, not something to prescribe here.

---

### 2. [MAJOR] Simultaneous double-disconnect: match never resolves for either side, no history record, no recovery

**Spec/task reference:** flagged explicitly in commit `2ffd857`'s message as a known
gap ("simultaneous double-disconnect deletes the room immediately (pre-existing
behavior) and skips auto-forfeit — not addressed here, flagged for QA"). Task
brief's own framing: "confirm what actually happens, don't just take the prior
report's word for it."

**Root cause (confirmed by code):** `server/src/ws/rooms.js`'s `markDisconnected()`
deletes the room outright the moment *no* player in it is still connected — if both
sockets close within the same handling window, the second `markDisconnected()` call
deletes the room before any grace timer / forfeit logic ever gets a chance to run
for the first disconnect. `server/src/ws/server.js`'s `handleClose()` explicitly
short-circuits ("Both players gone ... nothing left to pause/notify/grace-time
for") and clears whatever timers existed without writing any result.

**Repro (`double-disconnect.js`, raw WS against a spawned server instance with
`PVP_DISCONNECT_GRACE_MS=4000` for a fast test — the underlying race is timing-
independent, this only shortens the wait):**
1. Two accounts, real room, `start_match`, confirm both sides get `turn_started`.
2. Close **both** WebSocket connections back-to-back (no gap).
3. Wait 7 seconds (well past the 4s grace window).
4. Query `match_history` directly for both accounts: **`[]` for both** — no win, no
   loss, no `win_forfeit`, nothing recorded for a match that will never resolve.
5. Attempt to reconnect with the same room code: **`ROOM_NOT_FOUND`** — the room is
   gone, there is no path back into the match for either player.

**Severity reasoning:** Major, not Blocker — this needs both sockets to close
within roughly the same server-side handling tick, which in practice means both
players losing connectivity together (e.g. shared wifi/router drop, or a brief
server-side network blip affecting both sockets at once). That's a real but
narrower trigger than Finding 1 (which fires any time a single client hangs or gets
distracted on a sub-screen). The player-facing outcome is still a genuine dead end
— an unresolvable, unrecorded match with no in-app recovery — so it's a real bug
worth fixing, just not a "breaks every match" one.

---

### 3. [MAJOR] Opponent deck-size display falls back to the local player's own deck size — confirmed visibly wrong

**Spec/task reference:** flagged in commit `cd3341e`: "opponent deck-size display
falls back to the local player's own deck length ... wrong when deck sizes differ."
Spec §7.2 explicitly lists "덱 더미 장수" (deck pile count) as public information
that should be shown accurately for both sides.

**Repro (`deck-size-mismatch.js`, real two-client match, real API call to trim one
account's deck):**
1. Account A keeps the default 24-card starter deck. Account B's slot 1 is
   edited via a real `PUT /api/decks/1` call down to an intentionally different,
   still-valid 20-card composition (server confirms `total: 20`).
2. Real match started between A and B.
3. Read `AL.state.opponent.drawPile.length` on each side and compare to the real
   ground truth (each side's own `masterDeck.length` minus their own opening hand,
   as reported by their own client):

   | | A's displayed "opponent (B) deck count" | real value | B's displayed "opponent (A) deck count" | real value |
   |---|---|---|---|---|
   | | 19 | **15** | 14 | **18** |

   Both directions are wrong, and in both cases the wrong number exactly equals
   *the viewing client's own deck size* minus the opponent's real opening draw —
   i.e. each client is displaying its own deck size dressed up as the opponent's,
   confirming the flagged root cause precisely (`js/state.js`:
   `opponentDeckSize = opts.opponentDeckSize || deck.length` — always falls
   through to `deck.length`, the caller's own deck, because `js/match.js` never has
   a protocol message to learn the opponent's real deck size).

**Severity reasoning:** Major, not Blocker — this is display-only; no gameplay
logic reads `opponentDeckSize` for anything besides rendering the counter, so
nothing breaks mechanically. But it's a confirmed, visible violation of a DoD line
("상대 보드 상태: ... 덱 더미 장수 ... 전부 실시간 공개") in any match where the two
players' deck sizes differ — which, given decks can range 20-30 cards by design,
is not an edge case; it's a normal, expected situation.

---

### 4. [Ambiguous — needs a design decision, not a bug fix] Spec self-contradiction on deck-editor max-out tile behavior

`spec-online-pvp.md` §5.2 says (parenthetical, about max-copies/max-30 enforcement
generally): *"버튼 비활성화, 클릭해도 무반응 아님"* — i.e., it should be a
disabled button, explicitly **not** "clickable but does nothing."

But §5.5, describing this exact editor screen, says: *"최대 매수(3) 또는 최대 덱
장수(30) 도달 시 타일이 비활성 스타일(불투명도 낮춤)로 바뀌고 클릭 무반응"* — i.e.
lowered opacity **and click has no response** — the literal thing §5.2 says not to
do.

The implementation (`js/deck.js` `renderPoolGrid()`) follows §5.5: once maxed, the
tile's click listener is never attached (functionally identical to "disabled," just
not via the HTML `disabled` attribute on a real `<button>`, since these are `<div>`
tiles) and `.maxed` lowers opacity via CSS. This satisfies §5.5's explicit
instruction for this screen and is a reasonable, working implementation — but it
technically contradicts §5.2's general parenthetical. Flagging for the game
designer to reconcile the wording (most likely §5.2's parenthetical should be read
as non-binding boilerplate superseded by §5.5's screen-specific spec, but that's a
design call, not mine to make).

---

### 5. [Minor / informational] Client hardcodes disconnect-grace/claim-forfeit timing independently of server config

`js/battle.js` hardcodes `DISCONNECT_GRACE_MS = 45000` and
`CLAIM_FORFEIT_FLOOR_MS = 10000` as local constants, with an honest comment
("display-only; the server is the real authority on the actual auto-forfeit").
Today this is harmless — both the client's hardcoded values and the server's
`config.js` defaults are the same spec numbers, and there's no production
mechanism that would set the server's env overrides without also being a deliberate,
coordinated change. But it's worth naming as a latent trap: this is also *why* I
couldn't test the disconnect/forfeit flow through the real UI with short timings
(see Testing note in the 6.4 section above) — the server-side override and the
client's own display timing have no way to agree unless someone remembers to keep
them in sync by hand. Not a bug today; flagging in case a future session is
tempted to change the server's spec timing without realizing the client needs a
matching update.

---

## What I did not get to (explicitly, for honesty about coverage)

- Deck editor max-copies/max-30 UI enforcement: verified by code inspection only,
  not re-driven interactively via Playwright clicks (server-side version of the
  same rule, which is the actual trust boundary, IS covered live via
  `deck-smoke-test.js`).
- `ws-smoke-test.js` / `pvp-smoke-test.js` / `match-history-smoke-test.js`: read in
  full and judged sound, not re-run verbatim this session (my own tests cover
  overlapping ground through the real UI/DB instead, which is a stronger signal for
  the same claims, but I did not literally execute those three scripts myself this
  pass).
- Did not attempt a security-focused pass beyond the opportunistic XSS spot-check
  above (e.g. signup rate-limiting/abuse, session-fixation, CSRF on state-changing
  endpoints) — out of this task's explicit scope but worth naming as unexamined.
- "Different device" persistence was verified via a fresh session (logout/login)
  and via separate browser contexts/processes on the same machine, per the task
  brief's own suggested equivalence ("a simulated 'different device' = fresh
  session") — not literally tested from a second physical machine.

---

## Files referenced

- Spec: `/Users/jungjongchan/Desktop/company/docs/design/spec-online-pvp.md`
- Plan: `/Users/jungjongchan/Desktop/company/docs/design/online-pvp-plan.md`
- Root-cause code for Finding 1: `/Users/jungjongchan/Desktop/company/js/battle.js`
  (`handleTurnStarted`, `handleTurnTimeout`), `/Users/jungjongchan/Desktop/company/js/state.js`
  (`applyRemoteAction`, `applyRemoteEndTurn`, `localTurnStart`)
- Root-cause code for Finding 2: `/Users/jungjongchan/Desktop/company/server/src/ws/rooms.js`
  (`markDisconnected`), `/Users/jungjongchan/Desktop/company/server/src/ws/server.js` (`handleClose`)
- Root-cause code for Finding 3: `/Users/jungjongchan/Desktop/company/js/state.js`
  (`startMatch`'s `opponentDeckSize` fallback), `/Users/jungjongchan/Desktop/company/js/match.js`
  (`handleTurnStarted`'s doc comment, which already self-flags this)
- Starter deck under test: `/Users/jungjongchan/Desktop/company/server/src/lib/starterDeck.js`
- Existing programmer smoke tests read/re-run: `/Users/jungjongchan/Desktop/company/server/scripts/smoke-test.js`,
  `deck-smoke-test.js`, `ws-smoke-test.js`, `pvp-smoke-test.js`, `match-history-smoke-test.js`
