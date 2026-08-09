# QA Report — Practice Mode (vs-AI) Milestone

**Scope:** `docs/design/practice-mode-proposal.md` §0–§12 vs. actual implementation across
all 4 tracks (AI engine + local timer `js/ai.js`/`js/practice.js`, server Ink-cap/audit-log
backend `server/src/routes/economy.js` + `server/migrations/004_add_practice_ink_cap.sql`,
lobby entry point `js/match.js`/`index.html`, practice-distinct result screen). Corresponds
to commits `17955a2`, `73912d6`, `8255845`, `0781311`, `9f574e2`.

**Method:** Independent verification against a genuinely running local stack, following this
repo's established convention (`docs/qa/online-pvp-milestone.md`, `docs/qa/card-shop-currency-milestone.md`)
— not a re-run of the programmer's own tests trusted at face value (though those were run
fresh first as a baseline; all pass, see below). Confirmed `server/.env`'s `DATABASE_URL`
points at `postgresql://postgres@localhost:5432/neoncore_dev` (local Postgres, not
production Supabase) before running anything; migration 004 confirmed already applied
locally via `node scripts/migrate.js` ("Migrations up to date") — no writes ever touched
production. All testing used a real spawned `server/` process, real local Postgres, a
static file server for `index.html`/`js/`/`css/`, and Playwright (`chromium`, scratchpad-local
install, not a repo dependency) driving the real UI end-to-end, plus raw `fetch` calls for
endpoint-level adversarial testing that deliberately bypasses the client entirely. All
independent scripts referenced below were written from scratch this session and live only
in this session's scratchpad, not the repo; exact repro steps and output are reproduced
inline so a programmer can re-derive them without re-discovering anything.

---

## Verdict

**Not ready to ship as-is — one Major finding, one Minor/defense-in-depth finding.**

The two areas the task flagged as highest-risk (the Ink economy's daily cap, and the
AI's safety cap against a hang) both held up very well under genuinely adversarial
testing — better than average confidence for a first QA pass on a milestone this size.
Real PvP regression is completely clean (this milestone did not break the existing
mode it shares an engine with). However, one of the milestone's own explicit, CEO-confirmed
design decisions — the 24-second local turn timer (§0 decision #3, §5) — has a real,
non-deterministic reliability bug: in real Chromium tab-backgrounding tests, the timer
**failed to auto-expire the player's turn in roughly half of repeated trials** after the
tab was backgrounded past the 24s deadline, leaving the match silently stuck until the
player manually clicks End Turn. This isn't a hard trap (manual recovery always worked
in testing) and doesn't corrupt state or crash anything, but it's a real, reproducible
break of a headline feature under an extremely common real-world action (switching tabs
mid-turn) — rating it Major, not Blocker, specifically because of the manual-recovery
path and because the design doc's own economic reasoning (§5.2) means a broken timer
here doesn't create a farming exploit, "only" a broken feel.

The second finding (no state-machine-level guard between practice-mode and real-PvP-mode
state) is real but only reachable by bypassing the UI's own disabled-button/hidden-element
guards (e.g., via devtools) — every normal click-driven path was tested adversarially and
held up cleanly.

---

## Summary table

| # | Finding | Severity | Area |
|---|---|---|---|
| 1 | Local 24s practice-mode turn timer intermittently (≈50% of repeated real-backgrounding trials) fails to auto-discard the hand/pass the turn after the tab is backgrounded past the deadline — recoverable via manual End Turn, but the automatic enforcement silently doesn't fire | **Major** | §5 local timer |
| 2 | No state-machine-level guard prevents a real-PvP match flow and a practice match flow from clobbering each other's `AL.state` if both get triggered on the same client — confirmed reachable only by bypassing the UI's disabled/hidden-button guards, not through any normal click sequence | Minor / defense-in-depth | §9 lobby entry / cross-mode isolation |
| — | Everything in "What passed" below | Pass | Ink cap (§6), AI heuristic + safety cap (§3), match-history isolation (§7), real PvP regression, lobby entry (normal-path), info-hiding parity, match-end copy (§7.3) |

---

## What passed

### 1. Ink cap correctness and abuse resistance — thoroughly adversarial-tested, no bugs found

Independent script (`qa-ink-cap-adversarial.js`), raw `fetch` calls only, **never touches
any client JS** — simulating exactly the "call the endpoint directly, bypassing the client"
scenario the task asked to stress:

- **30 sequential win reports, no delay between calls, far past the daily cap**: awards
  sequence was exactly `[4,4,4,4,4,0,0,...]` — total 20, never more, matching the cap
  exactly (5 wins × 4 Ink = the 20/day cap with no remainder, since 20 is evenly
  divisible by 4).
- **Partial-award boundary math**: seeded an account to exactly 18/20 today (4 wins + 2
  losses), then a win at that point awarded **exactly 2** (not the full nominal 4), landing
  the counter at exactly 20; the very next call (any result) awarded **exactly 0**. Final
  balance matched the sum of awards exactly (20), never an overshoot.
- **Genuinely concurrent submissions AT the boundary** (`Promise.all`, not sequential):
  seeded an account to 17/20 (remaining cap = 3, less than one win's nominal 4 — forces
  real contention), fired **10 truly concurrent win reports**. Sum of awards across all
  10 was exactly 3 (17+3=20), final balance exactly 20, never 21+. A second burst of 10
  more concurrent win reports once already at the cap awarded exactly 0 total. The
  `SELECT ... FOR UPDATE` row lock genuinely serializes these correctly — no lost-update
  race let extra Ink through.
- **Loss-only spam** (rate=1/call): 25 sequential loss reports still capped at exactly 20,
  not 25.
- **Malformed payloads** (`WIN` wrong case, trailing space, `tie`, `null`, a number, an
  empty body): all correctly rejected with 400, balance unaffected.

**53/53 independent adversarial assertions pass.** This was the task's explicitly
highest-stress-priority area and it held up completely.

### 2. UTC day-reset — genuinely UTC, not server-local time (claim independently verified, not trusted)

The implementing session's own code comment claims the day boundary is computed
entirely in SQL (`(now() AT TIME ZONE 'utc')::date`) specifically to avoid trusting the
Node process's local timezone. Verified this independently rather than taking the
comment's word for it: ran the real server process under two different, deliberately
extreme `TZ` environment overrides —

- `TZ=Etc/GMT+12` (UTC−12): at the moment of testing, this made the server process's own
  local calendar date **one full day behind** the real UTC date (process-local:
  2026-08-08 19:56, real UTC: 2026-08-09 07:56). A fresh account's practice-result call
  under this process wrote `practice_ink_reset_date = 2026-08-09` in Postgres — **the
  real UTC date, not the process's own local date.** If the implementation had used
  `new Date()`/JS-local-time anywhere in this path, this test would have caught it
  writing 2026-08-08 instead.
- `TZ=Pacific/Kiritimati` (UTC+14) was also tried as the opposite-direction extreme (did
  not produce a diverging calendar date at the specific real-world moment tested, since
  the offset wasn't large enough to cross a UTC day boundary at that instant — noted for
  completeness, not a meaningful negative result).

Confirmed via direct `psql` queries against the real `accounts` row, not through the
API's own self-reported values. The implementing session's claim holds.

### 3. AI behavior sanity — heuristic, turn-1 lock, and the safety cap all verified correct

- **Priority heuristic (§3.2)**: re-ran the programmer's own `practice-mode-ai-test.js`
  fresh (all pass) — every branch (self-preservation cascade skill→power→attack,
  HP-race-behind pooling skill+power, default attack-first, tie-break randomization
  across 200 trials) checked against real numbers, not just code-read.
- **Turn-1 attack lock (§3.3)**: verified independently three ways — (a) the existing
  unit tests (AI-as-first-player deals 0 damage on turn 1; AI-as-second-player is
  correctly *not* locked), (b) a real, unscripted browser match where the AI happened to
  go first: player HP was unchanged after the AI's entire first turn, confirmed via
  `AL.state`, and (c) code inspection confirms this gate is implemented independently in
  `js/ai.js` (the design doc's own flagged risk — `applyRemoteCardPlay` doesn't enforce
  it, so the AI's own decision logic has to) rather than accidentally relying on an
  engine-level check that doesn't exist for the opponent side.
- **Safety cap against a hang (`maxIterations=10`)** — went beyond the programmer's own
  test (which uses an illegal 20-copies-of-one-card deck to prove the cap *can* bite) and
  constructed a **real, legally-buildable worst-case deck** under the actual deck-editor
  rules (20–30 cards, max 3 copies per id): 3× Quick Guard (0-cost, draw 1) + 3× Adrenaline
  (1-cost, draw 2) + 3× Opportunist (1-cost, draw 1–2) + padding, plus a Hoarder variant
  (permanent +1 draw/turn). Ran this across 15 simulated AI turns each. **The AI never
  came close to needing the 10-iteration cap on any legal deck** — the max-3-copies rule
  structurally bounds how degenerate a real deck can be, so the cap functions purely as
  defensive headroom against the illegal/synthetic case, not a load-bearing necessity for
  any deck a real player could actually build. Either way: since the loop's own condition
  (`iterations < maxIterations`) is unconditional, a hang is **structurally impossible**
  regardless of deck composition — confirmed by reading the loop, not just testing around
  it.
- **AI turn pacing (§4.4)**: confirmed via real wall-clock measurement (not a test
  override) that the AI's real first turn as first player took **1505ms** to play 4 cards
  with the default ~750ms pacing — genuinely paced, not instantaneous.

### 4. Match-history isolation — verified bidirectionally under real conditions

Real, full end-to-end Playwright run (`qa-practice-real-match.js`): signup → deck select
→ lobby → practice CTA → real AI match played to a genuine conclusion via real card
clicks (not state injection) → practice-distinct victory/defeat screen → navigated to the
real 전적 (match-history) screen. **전적 승/패 집계 was 0/0, and the match list did not
mention "연습 상대"** — confirmed via the real rendered DOM, not just the API response.
Separately, a full two-real-client real PvP match (`qa-real-pvp-regression.js`, see below)
confirms the *opposite* direction: a real PvP match played immediately afterward records
correctly (1 win / 0 losses for the winner, 0/1 for the loser) — no cross-contamination in
either direction. `practice-ink-smoke-test.js` (programmer's own, re-run fresh) also
independently confirms zero `match_history` rows are ever written by the practice-result
endpoint across multiple win/loss calls, while `practice_ink_log` correctly gets exactly
one audit row per call with the correct result/amount.

### 5. Real PvP regression — fully clean, no evidence this milestone broke anything

Two **separate `chromium.launch()` processes** (not just contexts), real signup, real
room create/join via the actual room list, real coin flip, a full real match played to
conclusion via real clicks on both sides simultaneously, real match-end screen, and real
`match_history` recording verified two ways (direct `API.matchHistory.list()` call and
the rendered 전적 screen DOM) for both accounts. **14/14 assertions pass, zero uncaught
page errors on either client.** `js/battle.js`'s buses and `js/state.js`'s
`applyRemoteAction` — the exact shared code paths this milestone's AI/practice code also
drives — behave identically to the pre-milestone baseline for a real match.

### 6. Lobby entry point — normal UI path is genuinely safe under adversarial timing

- **Click the room row (real room_join in flight), then immediately try clicking the
  practice link** (`qa-lobby-practice-race.js`): the practice link was already
  `.disabled` at the DOM level *before* any network round-trip completed —
  `setRoomListInteractive(false)` runs synchronously at the very start of the room-join
  handler, so there's no window for a second click (even a forced native `.click()` call,
  not just a Playwright actionability-checked click) to slip through. The guest correctly
  ended up in the real PvP match, not a phantom practice match.
- **Room creation** similarly synchronously hides the entire `#room-list-body` (which
  contains both practice CTAs) before its first `await`, so the same class of race is
  closed for that path too.
- Both were tested with truly zero event-loop turns between the two dispatched clicks
  (both fired inside one `page.evaluate()` call) — as tight a race as is meaningfully
  constructible.

### 7. Information-hiding parity + match-end copy — exact spec conformance

- `AL.state.opponent.hand`/`drawPile` entries are **all `null` (HIDDEN)** during a real
  practice match, exactly matching real PvP's info-hiding rule (§1, §4.2) — verified live,
  not from reading the code alone. `.length` is still real (hand-count UI shows a correct
  number).
- Match-end title copy verified for **all 4 of §7.3's table rows**: a normal win showed
  `연습 승리 · +4 잉크`; forcing the account to the daily cap first (via real
  `practice-result` calls) and then finishing a match showed `연습 패배 · 오늘 연습 잉크
  한도 도달(0 잉크)` — an exact character-for-character match to the spec table, not
  "close enough." The `전적에 기록되지 않습니다` subtitle and the correct 3-button set
  (다시 연습하기 / 로비로 돌아가기, with the real-PvP `다시 플레이` button hidden) were
  also confirmed live.
- Disconnect/reconnect UI (`#disconnect-overlay`) was confirmed never visible at any point
  during a full real practice match, matching §1's explicit requirement.

---

## Findings

### 1. [MAJOR] Local 24s turn timer intermittently fails to auto-expire after the tab is backgrounded past the deadline

**Spec reference:** §5.1 — on the local timer reaching 0, the client must call the same
consequence a real PvP `turn_timeout` would (`AL.endTurn()`: discard hand, pass turn).
§0 decision #3 is one of only two design points the CEO explicitly overrode the original
recommendation on, so this is not a peripheral feature.

**What was tested:** whether the timer still behaves sanely if the player backgrounds/
switches tabs during their own turn, per the task's explicit callout of this scenario
(since there's no server to force resolution the way real PvP has).

**Repro (`qa-timer-bg-diagnostic3.js`, real Chromium, real UI flow — no test overrides,
no forced JS calls to `Practice.start()`, real 24s default):**
1. Real signup → deck select → lobby → click "연습 상대와 붙어보기" → reach a real
   practice match, confirm it's genuinely the player's own turn (real hand, timer UI
   showing "24" counting down).
2. Open a second tab in the same browser context and bring it to the front (pushing the
   practice match's tab into the background) for **26 seconds** — 2 seconds past the 24s
   deadline. The practice tab is never touched/queried at all during this window.
3. Bring the practice tab back to the front and poll `AL.state` at 200ms resolution for
   up to 12 seconds.

**Result across 7 total independent trials of this exact scenario across this session
(`qa-timer-bg-diagnostic.js`/`diagnostic3.js`, run repeatedly):**
```
Trial 1 (diag1, ~29s background + sparse polling):     STUCK
Trial 2 (diag3 original):                               STUCK
Trial 3 (diag3 rerun):                                  recovered correctly (~400ms after foreground)
Trial 4 (repeat run 1):                                 recovered correctly (~610ms after foreground)
Trial 5 (repeat run 2):                                 STUCK (11+s of foreground polling, never recovered)
Trial 6 (repeat run 3):                                 STUCK (11+s of foreground polling, never recovered)
Trial 7 (repeat run 4):                                 recovered correctly (~1024ms after foreground)
```
**Roughly half of trials never fired the auto-expiry** even after the tab regained focus
and multiple more seconds elapsed — `AL.state.turn` stayed `'player'`, the hand stayed at
its original (unplayed) content, and the on-screen timer never triggered the
discard/pass-turn consequence. The other half recovered promptly (within ~1s of
regaining focus) with the hand correctly discarded and turn correctly passed to the AI.

**Manual recovery confirmed (`qa-timer-bg-manual-recovery.js`):** when stuck, clicking the
real "End Turn" button still works normally — the match is not permanently deadlocked,
just not auto-resolving the way the timer is supposed to. This is why the finding is
Major, not Blocker.

**Root-cause investigation (partial — flagging for the programmer rather than claiming a
definitive answer):**
- A deterministic reproduction attempt using Playwright's fake-clock API
  (`page.clock`) gave **inconsistent results depending on exactly when the clock was
  installed relative to page load/match start** — installing it cleanly before any
  navigation and driving everything through real UI clicks did **not** reproduce the bug
  (`qa-timer-final-repro.js`: `runFor(25000)` correctly triggered expiry), while
  installing it mid-session on top of a freshly-force-started match did reproduce a stuck
  state (`qa-timer-clock-isolated.js`). A sanity check confirmed the fake clock itself
  correctly drives *other* timers in this exact app (`js/ai.js`'s `setTimeout`-based AI
  pacing completed correctly under the same fake clock, `qa-timer-clock-sanity.js`), so
  the clock-mocking tool itself isn't the confound for that particular result — but given
  the same scenario was NOT reproducible with a clean from-the-start clock install, this
  points toward the failure being tied to **real browser background-tab timer scheduling
  behavior** (i.e., something about how Chromium throttles/coalesces `setInterval`
  callbacks in `js/practice.js`'s `tick()` for a backgrounded page) rather than a
  deterministic, always-reproducible logic error independent of the browser environment.
  This is offered as a lead, not a confirmed root cause — a programmer with access to
  Chrome's own timer-scheduling internals/DevTools performance profiler would be better
  positioned to pin down exactly why `tick()`'s `Date.now() >= timerDeadline` check
  sometimes never gets evaluated again after a long-enough background period, even though
  the same page's other `setTimeout`-driven code (AI pacing) doesn't show the same
  problem in equivalent background-duration tests (15s and 28s backgrounded during the
  AI's own turn both recovered correctly, `qa-timer-bg-during-ai-turn.js`) — suggesting
  whatever the mechanism is, it's specific to `js/practice.js`'s `setInterval`-based
  polling loop rather than a blanket "whole page frozen" effect.

**Why Major, not Blocker:** manual recovery always worked in every trial (not a hard
trap); no state corruption, crash, or match-history/Ink-award incorrectness resulted from
being stuck (the match just sits there until the player acts); and per the design doc's
own §5.2 reasoning, a broken timer here doesn't create an economic exploit (the daily Ink
cap bounds that risk independently, confirmed solid in Finding-free section 1 above).
**Why not Minor:** this breaks one of only two headline decisions the CEO explicitly
reversed the original recommendation on, under an extremely ordinary real-world action
(switching tabs/apps mid-turn — not a contrived edge case), roughly half the time in
testing, silently (no error, no indication to the player that anything went wrong) — the
core promise "the timer works the same as real PvP, just enforced locally" is not
reliably true today.

**Suggested area to look at (not a fix):** `js/practice.js`'s `ensureTimerInterval()`/
`tick()` (`setInterval(tick, 250)`) is the only place this milestone implements new
timer-firing logic; consider whether checking elapsed time on `document.visibilitychange`/
window `focus` (which fire reliably even when a page's interval callbacks get starved)
rather than relying solely on the interval's own schedule to notice an already-passed
deadline would close this gap — but that's a call for the programmer, not prescribed here.

---

### 2. [Minor / defense-in-depth] No state-machine-level guard between practice-mode and real-PvP-mode state — only reachable by bypassing the UI's own disabled/hidden guards

**What was tested:** task item 6's "starts a practice match then somehow tries to also
join/create a real room mid-practice-match" (and the reverse).

**Normal UI path: confirmed safe (see "What passed" §6 above).** Every timing race
reachable through real clicks was closed by synchronous DOM state changes
(`.disabled`/`.hidden`) that happen before any `await`.

**Forced/adversarial path (bypassing the disabled UI entirely, e.g. via
`element.click()` on an already-`disabled` real `<button>`, or a direct console call —
simulating what a player *could* do via browser devtools, not a normal click):**

- **Direction A (`qa-lobby-practice-race.js`, Test 2):** with a real `room_join` request
  genuinely in flight (and, in practice, by the time the forced call landed, already
  resolved into a real live match), forcing `Practice.start(deckIds)` on top of it
  **silently overwrote the live real match's `AL.state`** — `state.opponent.name` flipped
  from the real opponent's display name to `"연습 상대"`, HP reset to 50/50, turn reset —
  while the real WebSocket session/room stayed open server-side, unaware anything
  happened client-side. No `leave_room` is ever sent by `Practice.start()`.
- **Direction B (`qa-lobby-practice-race-2.js`):** a host creates a real room and (via a
  forced call, since the UI has no legitimate path to this state) starts a practice match
  without cancelling the still-open real room. The room stays genuinely open
  server-side (confirmed: `server/src/ws/server.js`'s `handleClose()`/`markDisconnected()`
  only deletes a still-solo room when the socket actually *closes* — a forced client-side
  state change without closing the socket doesn't trigger that cleanup). When a real
  third account later joins that abandoned-but-still-open room, the resulting
  `opponent_joined`/`turn_started` traffic **silently overwrote the active practice
  match's state** on the original client (`opponentName` flipped from `"연습 상대"` to
  the intruder's real name, HP reset, turn changed) — with zero uncaught errors, just
  silent state clobbering.

**Reachability caveat (why this is Minor, not Major):** both repros required either a
forced native `.click()` on a DOM element with `disabled` genuinely set (browsers
suppress the click event entirely for disabled form controls — real users cannot trigger
this through actual clicks/taps) or a direct `Practice.start()` console call. Confirmed
via code + the "closes properly on real socket close" check above that there is no
ordinary sequence of clicks, reloads, or navigation that reaches either scenario — a
normal player closing/reloading the tab while hosting an unmatched room correctly tears
the room down server-side (`handleClose` → `markDisconnected`), so the "abandoned open
room" precondition for Direction B specifically requires an artificially-kept-alive
socket, not anything a real user action produces.

**Why still worth flagging:** the task explicitly asked to check this, and the underlying
architectural fact is real — `Practice.start()`/`onPracticeClick()` have no check at all
for "is there a live real match/room membership right now," and `Match.js`'s real-match
network handlers (`handleTurnStarted`, `opponent_joined`, etc.) have no check for "is a
practice match currently active" — the two flows are only kept apart by UI-layer
button-state discipline, not by any deeper guard. If a future change ever introduces a
new path to either state (e.g. a keyboard shortcut, a reconnect-flow edge case, browser
autofill/extension interference with a disabled attribute), there is currently no second
line of defense.

---

## What I did not get to (for honesty about coverage)

- Did not pin down the exact root cause of Finding 1 at the browser-internals level
  (Chrome's specific timer-coalescing/throttling policy for backgrounded pages) — flagged
  as a lead (interaction with `setInterval`-based polling specifically, not a blanket
  page-freeze) rather than a confirmed mechanism, given the deterministic fake-clock
  reproduction attempts gave inconsistent results depending on install timing.
- Did not test Finding 1 across real mobile browsers (Safari iOS/Chrome Android) or a
  real second physical device/OS-level app-switch — all testing used Chromium desktop
  automation; mobile OS background-tab throttling policies are generally *more*
  aggressive than desktop Chrome, so this finding's ~50% rate should be treated as a
  floor, not a ceiling, for how often real players might hit it.
- Did not exhaustively fuzz every possible interleaving for Finding 2 (e.g., a genuinely
  concurrent forced-`Practice.start()` racing the exact microtask a `room_joined` handler
  runs in) — the two concrete directions tested are representative of the task's ask, but
  this wasn't an exhaustive state-space search.
- Did not test the AI's behavior against every one of the 22 individual cards
  combinatorially — relied on the programmer's own `practice-mode-ai-test.js` (re-run
  fresh, all pass) for exhaustive card-level coverage and focused independent effort on
  the two things the task flagged as needing dedicated scrutiny (safety cap under a real
  legal deck, turn-1 lock under real match conditions).
- Did not test §12's open (non-blocking) questions (mirroring-deck long-term fun,
  threshold tuning) — the task brief and the design doc both explicitly mark these as
  QA/playtest-data questions for later, not this pass's acceptance criteria.

---

## Files referenced

- Spec: `/Users/jungjongchan/Desktop/company/docs/design/practice-mode-proposal.md`
- Root cause area, Finding 1: `/Users/jungjongchan/Desktop/company/js/practice.js`
  (`ensureTimerInterval`, `tick`, `startPlayerTimer`, `onTimerExpire`)
- Root cause area, Finding 2: `/Users/jungjongchan/Desktop/company/js/match.js`
  (`onPracticeClick`, `registerNetHandlers`'s `opponent_joined`/`turn_started`/`room_joined`
  handlers), `/Users/jungjongchan/Desktop/company/js/practice.js` (`start()` — no
  `leave_room`/live-match check), `/Users/jungjongchan/Desktop/company/server/src/ws/server.js`
  (`handleClose`, `markDisconnected` — confirmed correct cleanup for the real-socket-close
  case, which is why Finding 2 needs a forced/artificial precondition)
- Ink cap implementation verified: `/Users/jungjongchan/Desktop/company/server/src/routes/economy.js`
  (`POST /practice-result`), `/Users/jungjongchan/Desktop/company/server/migrations/004_add_practice_ink_cap.sql`
- AI implementation verified: `/Users/jungjongchan/Desktop/company/js/ai.js` (`decideNextCard`,
  `createBrain`), `/Users/jungjongchan/Desktop/company/server/scripts/practice-mode-ai-test.js`
  (programmer's own, re-run fresh, all pass)
- Real PvP regression path verified unaffected: `/Users/jungjongchan/Desktop/company/js/battle.js`,
  `/Users/jungjongchan/Desktop/company/js/state.js` (`applyRemoteAction` and friends)
- Programmer's own tests re-run fresh (all pass, baseline): `smoke-test.js`,
  `deck-smoke-test.js`, `ws-smoke-test.js`, `pvp-smoke-test.js`, `match-history-smoke-test.js`,
  `practice-ink-smoke-test.js`, `practice-mode-ai-test.js` (all in `server/scripts/`)
- Independent QA scripts (this session's scratchpad, not part of the repo):
  `qa-ink-cap-adversarial.js`, `qa-ink-utc-tz-check.js`, `qa-practice-real-match.js`,
  `qa-real-pvp-regression.js`, `qa-lobby-practice-race.js`, `qa-lobby-practice-race-2.js`,
  `qa-ai-legal-worst-case-deck.js`, `qa-ai-pacing-realtime.js`, `qa-hidden-hand-and-cap-copy.js`,
  `qa-timer-bg-diagnostic.js`, `qa-timer-bg-diagnostic2.js`, `qa-timer-bg-diagnostic3.js`,
  `qa-timer-clock-isolated.js`, `qa-timer-clock-sanity.js`, `qa-timer-final-repro.js`,
  `qa-timer-bg-manual-recovery.js`, `qa-timer-bg-during-ai-turn.js`, `qa-timer-instrument.js`
- `server/.env` confirmed pointing at local Postgres (`neoncore_dev`) before any testing
  began; migration 004 confirmed already applied locally (not re-applied to production).
