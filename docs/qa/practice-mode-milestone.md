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

---

## Follow-up verification — re-check of commit `5435b4f`'s fixes (2026-08-10)

**Scope:** independently re-verifying both fixes commit `5435b4f` ("Fix backgrounded-tab
timer + add practice/PvP mode guard") claims for Finding 1 (Major, local timer) and
Finding 2 (Minor, mode guard) above. Same rigor as the original pass: real spawned
`server/` process, real local Postgres (`server/.env`'s `DATABASE_URL` reconfirmed
pointing at `postgresql://postgres@localhost:5432/neoncore_dev` before any testing —
never touched production), real static file server, real client bundle, Playwright
(`chromium`, scratchpad-local install) driving genuine UI flows end-to-end. Did not
just read/trust the commit message's own verification claims — independently
reconfirmed the sandbox limitation it describes, built a stronger direct-mechanism
test for Finding 1 rather than accepting the commit's substitute method on faith, and
adversarially probed Finding 2's fix for a third path beyond the two originally
reported. All scripts referenced below live only in this session's scratchpad
(`/private/tmp/.../scratchpad/pw/`), not the repo.

### Updated verdict

**Not ready to ship as-is.** Finding 1 (Major, local timer) is **genuinely fixed** —
confirmed with a direct-mechanism test that is stronger evidence than either the
original report's real-backgrounding repro (blocked by a confirmed sandbox limitation)
or the commit's own described substitute harness. Finding 2 (Minor, mode guard) is
**only partially fixed** — both of the two originally-reported adversarial directions
are now solidly blocked, but adversarial re-scanning per this task's explicit ask found
a **third, equally-reachable-only-via-devtools path the fix does not cover**, with
concrete evidence of real practice-match actions leaking onto the real WebSocket relay
connection. Full regression suite: 19/21 scripts clean; the 2 failures are confirmed
**pre-existing on the parent commit** (unrelated to this fix, see below), not a new
regression, but they do mean the commit message's "Full 21-script regression suite
green" claim doesn't hold in this environment as literally stated.

### Finding 1 re-check: backgrounded-tab timer — genuinely fixed, verified via a stronger direct-mechanism test

**Step 0 — independently reconfirmed the sandbox limitation before adapting method
(as instructed), rather than taking the commit's word for it:** wrote a minimal
check (`check-visibility-sandbox.js`) that opens two real pages in one browser
context, calls `page2.bringToFront()`, and polls `document.hidden`/`document.hasFocus()`
on page1. Result: `document.hidden` stayed `false` and no `visibilitychange`/`blur`/
`focus` events fired on page1 at all, before or after the switch. Confirmed this
independently — this sandbox's Chromium genuinely does not deliver real
`visibilitychange`/`focus` events from `bringToFront()`-driven tab occlusion. This
matches the commit's claim; it is a real sandbox limitation, not a lazy excuse.

**Step 1 — re-ran the ORIGINAL real-backgrounding repro against the current code**
(`qa-timer-real-backgrounding-retest.js`): real signup → deck select → lobby → real
practice CTA click → real 24s timer → second real tab brought to front for 26s → practice
tab brought back → polled for recovery. Result: **still stuck** (`AL.state.turn`
stayed `'player'`), and `document.hidden` on the practice tab never flipped to `true`
at any point during backgrounding. This is the same sandbox limitation as Step 0, not
a sign the fix is broken — the fix's own mechanism (`visibilitychange`/`focus`
listeners) structurally cannot be exercised via genuine tab-occlusion in this sandbox,
same as it couldn't during the original QA pass.

**Step 2 — built a stronger direct-mechanism test** (`qa-timer-visibility-direct.js`),
per this task's suggestion, since genuine OS-level occlusion isn't available here.
Real signup → deck select → lobby → real practice CTA click → real player-turn 24s
timer, via a fully real UI flow (including dismissing the first-time-player onboarding
`#screen-howto` overlay, `docs/design/onboarding.md`, which both this and the original
QA session's flow needed to pass through). On top of that real flow:
1. **`window.setInterval` neutered via `page.addInitScript()`** before any app script
   runs, so `js/practice.js`'s own `setInterval(tick, 250)` is installed but its
   callback never fires again — a **total**, not partial, simulation of background-tab
   interval starvation (strictly worse than real throttling).
2. Confirmed the timer UI genuinely froze (`24` → `24` after a real 2s wait) —
   verifying the interval really was fully neutered, not just probably throttled.
3. Let **real wall-clock time** (`page.waitForTimeout(25000)`, no fake clock) pass
   25s — past the real 24s deadline — with the interval still neutered. Confirmed
   `AL.state.turn` was still `'player'` — a **live-reproduced baseline**: with only the
   interval-tick path available, the timer is still genuinely stuck, exactly matching
   the original Major finding's failure mode.
4. Dispatched **synthetic `visibilitychange` and `focus` DOM events**
   (`document.dispatchEvent(new Event('visibilitychange'))` /
   `window.dispatchEvent(new Event('focus'))`) via `page.evaluate()`. This exercises
   the real, `addEventListener`-registered `handleVisibilityOrFocusRegain()` →
   `tick()` → `checkTimerExpiry()` code path added in this commit, using the real
   `Date.now()` vs. real `timerDeadline` check and the real `AL.endTurn()`
   consequence — only the event's *delivery mechanism* is synthetic (necessary given
   the confirmed sandbox limitation), none of the fix's own logic is bypassed, mocked,
   or called via an internal test-only hook.
5. Result: `AL.state.turn` flipped from `'player'` to `'opponent'` **immediately**
   after the synthetic dispatch (no manual End Turn click), and
   `AL.state.player.hand.length` went from `5` to `0` — the real discard/pass-turn
   consequence actually ran, not just a flag flip.

**Ran 3 times total, all 3 fully clean (`ALL PASS`), fully deterministic** — no flake
across runs, consistent with this being a real `Date.now()`-based check rather than
timing-sensitive.

**Why this is stronger evidence than either the original repro or the commit's own
described substitute:** it drives the *exact* real fix code path (real listeners
registered via `init()`, real `Date.now()` comparison, real `AL.endTurn()`) through a
full genuine browser UI session — not a Node-side reimplementation of the timer logic,
not an internal test-only hook, and not reliant on genuine OS-level tab-occlusion
(which this sandbox cannot produce, confirmed independently in Step 0/Step 1 above). I
was not able to inspect the commit's own "controlled interval-drop harness" directly
(described only in the commit message, lives in that session's own scratchpad, not the
repo), so I can't audit its exact implementation — but per its own description ("real
Date.now()/game logic, only the callback-delivery mechanism substituted") it sounds
methodologically similar in spirit to what I built. Regardless of how that harness was
implemented, my own from-scratch test reaches the same conclusion via a fully
independent, real-UI-driven path, which is what this follow-up needed to establish
confidence rather than relying on the programmer's self-report.

**Bottom line on Finding 1:** genuinely fixed, with high confidence. The one thing
neither QA pass (original or this follow-up) can verify in this sandbox is "does a
*real* OS-level tab switch reliably fire `visibilitychange`/`focus` promptly" — but
that's a well-documented browser API contract external to this app's own code, not
something further testing in this environment can add confidence to either way.

### Finding 2 re-check: mode guard — Directions A and B fully fixed; a THIRD adversarial path was found, not covered by the fix

**Direction A re-check (`qa-mode-guard-direction-a.js`) — CONFIRMED FIXED.** Two real
accounts, real room create/join, real match reaching real `AL.state` (opponent name,
50/50 HP). Forced `Practice.start([...])` via a direct console-style call on the client
with the live real match (`Battle.isActive()` confirmed `true` immediately beforehand).
Result: `Practice.start()` refused (`Practice.isActive()` stayed `false` afterward),
and the real match's `AL.state` was **completely untouched** — opponent name, HP, and
screen all identical before/after the forced call. The original silent clobber
(opponent name → `"연습 상대"`, HP reset to 50/50) does not reproduce.

**Direction B re-check (`qa-mode-guard-direction-b.js`) — CONFIRMED FIXED.** Host (A)
creates a real room, leaves it open, forces `Practice.start()` over it (no
`leave_room` sent, exactly the original repro). A real third account (C) then joins
that abandoned room via the real room list. Result: A's live practice match's
`AL.state` (`opponentName: "연습 상대"`, HP, turn) was **completely unchanged** after
C joined and the resulting `opponent_joined`/`turn_started` traffic arrived —
`Practice.isActive()` stayed `true` throughout, confirming `js/match.js`'s
`onBothPresent()`/`handleTurnStarted()` guards correctly refuse to process real-match
traffic while a practice match is live.

**THIRD path found — [new finding, same severity class as the original Finding 2] `Battle.start()` itself has no internal guard against `Practice.isActive()`, unlike the symmetric guard `Practice.start()` got**

This task explicitly asked to think adversarially about whether a third path exists
beyond the two originally found, rather than assuming the fix is exhaustive. It does:

- The fix added a guard *inside* `js/practice.js`'s `start()` itself
  (`if (Battle.isActive()) return;` — defends itself regardless of caller) but only
  added guards at `js/match.js`'s two call sites that invoke `AL.startMatch()`
  (`onBothPresent()`/`handleTurnStarted()`), **not inside `js/battle.js`'s `start()`
  itself**. `Battle.start()` has zero internal awareness of `Practice.isActive()` — it
  unconditionally sets its own module-local `started = true` and arms its own timer
  interval, exactly as before this commit.
- `js/battle.js`'s own file header explicitly documents that its permanently-wired
  `onLocalAction`/`onLocalMatchEnd`/`onLocalTurnEndNotify` subscribers (on the exact
  same `AL.onAction()`/`onMatchEnd()`/`onLocalTurnEnd()` buses `js/practice.js` also
  drives real practice-match actions through) are safe to leave wired up
  unconditionally *specifically because* they're gated on `started`, "which only
  `Battle.start()` ever sets true." That safety invariant depends on `Battle.start()`
  never running while a practice match is live — which the fix does not actually
  guarantee, since `Battle.start()` can still be called directly.
- **Repro (`qa-mode-guard-direction-c-with-ws.js`):** real account creates a real room
  (opens a real WebSocket connection; `Battle.isActive()` is `false` at this point, no
  opponent matched yet). Legitimately starts a real practice match on top of it (same
  precondition Direction B already reconfirmed safe by itself). Then forces
  `Battle.start('forced-account-id', null)` directly via console — bypassing
  `js/match.js`'s guarded `handleTurnStarted()` entirely, the same class of "devtools
  console call" attack as the original two directions. `Battle.isActive()` flips to
  `true` with no resistance. Clicking the real End Turn button in the still-live
  practice match then produced these **actual captured outgoing WebSocket frames** on
  the real room connection:
  ```
  {"type":"action","payload":{"type":"endTurn"}}
  {"type":"end_turn"}
  ```
  I.e., a real practice-match turn-end **leaked onto the real relay connection**,
  exactly the class of cross-mode contamination Finding 2 was about, just through a
  path the fix didn't close.
- **Downstream consequence (reasoned from server code, not independently
  re-verified end-to-end with a live third account due to time):**
  `server/src/ws/server.js`'s `onAction()` only errors back
  (`OPPONENT_UNAVAILABLE`) if the room has no second player yet — in a room with a
  real matched opponent (e.g., Direction B's "abandoned room + real third account C
  joins" scenario, or any room that legitimately fills before this attack is
  performed), this same leaked message **would relay to the real opponent's real
  client**, since the server has no concept of "practice mode" at all (matchmaking is
  100% a client-side distinction) — a real third party's real match state could be
  corrupted by an unrelated practice match's local actions, not just self-corruption
  on the attacking client. This makes the exposure of this specific gap arguably more
  serious in consequence than the original two directions (which only ever
  self-corrupted the attacker's own client), even though the reachability
  precondition (devtools-only, no normal click path) is identical.

**Reachability caveat (same as the original Finding 2, why not escalating severity
tier):** requires a direct console call to `Battle.start()` — there is no UI element,
button, or normal click sequence that reaches this; the "third path" label refers to
a third *attack vector*, not a third normally-reachable UI bug.

**Suggested fix (not prescribed, matching this doc's convention):** add the same
`if (Practice.isActive()) return;` guard directly inside `js/battle.js`'s own
`start()`, mirroring what `js/practice.js`'s `start()` already does for the reverse
direction — this would make the guard genuinely symmetric and self-defending
regardless of call site, rather than depending on every current and future caller of
`Battle.start()` to check first.

### Full regression suite — fresh run, 19/21 clean; 2 failures confirmed pre-existing on the parent commit (not a regression from this fix)

Ran all 21 scripts in `server/scripts/` (excluding `migrate.js`) fresh against a
freshly-migrated local Postgres:

- **19/21 pass clean:** `smoke-test.js`, `deck-smoke-test.js`, `ws-smoke-test.js`,
  `room-list-smoke-test.js`, `pvp-smoke-test.js`, `deck-size-relay-smoke-test.js`,
  `double-disconnect-smoke-test.js`, `pull-smoke-test.js`, `practice-ink-smoke-test.js`,
  `practice-mode-ai-test.js`, `expansion-cards-test.js`, `expansion-deck-ownership-test.js`,
  `ink-award-smoke-test.js`, `match-history-smoke-test.js`, `report-result-race-smoke-test.js`,
  `weaken-status-test.js`, `expansion-card-battle-ui-smoke-test.js` (Playwright-based,
  needed `NODE_PATH` pointed at a scratchpad-local Playwright install, same as this
  session's other scripts), `room-list-ui-fill-race-test.js`, `shop-ui-smoke-test.js`.
- **2/21 fail:** `auto-end-turn-timer-sync-test.js` (2 assertion failures around a
  computed `~23999ms` deadline where `~8000ms` was expected, plus a `waitFor` timeout
  crash in its Scenario C) and `frozen-client-turn-timeout-test.js` (15 failures,
  server-driven turn-reconciliation assertions). **Neither script touches practice
  mode or the mode-guard code this commit changed** — both exercise real-PvP
  server-configured short turn-timeout scenarios (`PVP_TURN_TIMEOUT_MS`-style
  short-deadline test configs).
- **Confirmed these are pre-existing, not introduced by `5435b4f`:** checked out the
  immediate parent commit (`6b26fc4`) into a separate `git worktree`, pointed it at
  the same local Postgres, and re-ran both scripts fresh. **Identical failure
  signatures reproduced on the parent commit** — same `~23999ms` vs. `~8000ms`
  mismatch, same Scenario C `waitFor` timeout, same 15 assertion failures in
  `frozen-client-turn-timeout-test.js` (including the exact same computed values,
  e.g. mana/block figures). This is an environment-specific issue in this particular
  sandbox (most likely a short-turn-timeout test-config value not taking effect the
  way it does in the programmer's own environment, given `docs/qa/online-pvp-milestone.md`'s
  own earlier follow-up records `frozen-client-turn-timeout-test.js` passing cleanly
  in an earlier session) — not something this follow-up's scope (the timer fix / mode
  guard fix) caused or can fix. Flagging honestly rather than omitting it: the commit
  message's claim of "Full 21-script regression suite green" does not hold exactly as
  stated in this environment, but the discrepancy is pre-existing and unrelated to
  either of this commit's two fixes.

### Bottom line for the CEO

**Finding 1 (Major, backgrounded-tab timer): genuinely fixed, high confidence.**
Verified via a direct-mechanism test stronger than either QA pass's original
real-backgrounding repro (blocked by a sandbox limitation, independently
reconfirmed) or the commit's own described substitute harness (couldn't audit
directly, but reached the same conclusion independently from scratch). The evidence
here is trustworthy: it exercises the fix's real listeners, real `Date.now()` check,
and real consequence, end-to-end through a genuine browser session, 3/3 clean runs,
no flake.

**Finding 2 (Minor, mode guard): partially fixed.** Both originally-reported
directions are solidly closed. But this follow-up's adversarial re-scan (explicitly
asked for, not just re-running the same two repros) found a third, real path — direct
`Battle.start()` calls bypass the fix entirely, and I captured actual leaked WS
traffic proving practice-match actions can reach the real relay connection. Given the
server has zero concept of practice mode, this could in principle reach a real third
account's real match. Recommend logging this as a small follow-up fix (mirror the
guard inside `Battle.start()` itself) before treating Finding 2 as fully closed — not
a blocker on its own (same devtools-only reachability tier as before), but the "mutual
guard, both directions" claim in the commit message is not yet actually true.

**Not ready to ship as fully complete as claimed** — but close: one Major finding is
solidly resolved, and the remaining gap in the Minor finding is small, well-understood,
and has an obvious, narrow fix (one more guard line, mirroring the one that already
exists in `js/practice.js`). Regression suite is otherwise clean (19/21, with the 2
failures confirmed pre-existing and unrelated).

### Files referenced (follow-up)

- Commit under test: `5435b4f` (`js/practice.js`, `js/match.js`, `js/battle.js`)
- Sandbox-limitation reconfirmation: `check-visibility-sandbox.js` (scratchpad)
- Finding 1 re-check scripts (scratchpad): `qa-timer-real-backgrounding-retest.js`,
  `qa-timer-visibility-direct.js`
- Finding 1 fix code re-verified:
  `/Users/jungjongchan/Desktop/company/js/practice.js` (`checkTimerExpiry`,
  `handleVisibilityOrFocusRegain`, `init`)
- Finding 2 re-check scripts (scratchpad): `qa-mode-guard-direction-a.js`,
  `qa-mode-guard-direction-b.js`, `qa-mode-guard-direction-c-third-path.js`,
  `qa-mode-guard-direction-c-with-ws.js`
- Finding 2 fix code re-verified: `/Users/jungjongchan/Desktop/company/js/practice.js`
  (`start()`'s `Battle.isActive()` guard, `isActive()`),
  `/Users/jungjongchan/Desktop/company/js/match.js` (`onBothPresent()`,
  `handleTurnStarted()`'s `Practice.isActive()` guards)
- Finding 2 new gap located in: `/Users/jungjongchan/Desktop/company/js/battle.js`
  (`start()` — no internal guard), confirmed via
  `/Users/jungjongchan/Desktop/company/server/src/ws/server.js` (`onAction()`,
  `onEndTurn()`) for the downstream real-relay consequence reasoning
- Regression suite: all 21 scripts in `server/scripts/` (excluding `migrate.js`); the
  2 pre-existing failures cross-checked against parent commit `6b26fc4` via a
  temporary `git worktree` (removed after use)
- `server/.env` reconfirmed pointing at local Postgres (`neoncore_dev`) before any
  testing began; migrations reconfirmed already applied locally.
