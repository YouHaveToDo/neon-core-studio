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

---

## Follow-up verification #2 — independent re-check of commit `6e981c9` (2026-08-10)

**Scope:** independently re-verifying `6e981c9` ("Close the mode-guard asymmetry:
`Battle.start()` now checks `Practice.isActive()`"), the fix for the THIRD path found in
the prior follow-up above. Same rigor as both previous passes: real spawned `server/`
process, real local Postgres (`server/.env`'s `DATABASE_URL` reconfirmed pointing at
`postgresql://postgres@localhost:5432/neoncore_dev` before any testing — migrations
confirmed already applied, never touched production), real static file server serving
the repo root, real client bundle, Playwright (`chromium`, scratchpad-local install)
driving genuine two/three-account UI flows end-to-end, plus `page.on('websocket')` frame
capture for the WS-leak-specific claims (not just state inspection). Did not trust the
commit message's own verification claims at face value — independently rebuilt all three
prior repros from scratch against the current code, and then did a fourth, adversarial
pass per this task's explicit instruction to keep questioning whether the fix is
exhaustive rather than assuming it now is.

All scripts referenced below live only in this session's scratchpad
(`/private/tmp/.../scratchpad/qa-followup2/`), not the repo.

### Updated verdict

**Not ready to close out Finding 2 as fully resolved — but the specific, more serious
risk this round's task was scoped around (real WS-relay leakage) is genuinely fixed.**
All three previously-known repros (Direction A, Direction B, and the THIRD path found
last round) are now solidly blocked, including the WS-frame-capture check for the third
path specifically (zero outgoing frames on the real relay after the forced
`Battle.start()` call is refused). However, one more adversarial pass — exactly what this
task asked for, not assuming `6e981c9`'s fix is exhaustive — found a **fourth path**:
calling `AL.startMatch()` directly (bypassing both `Practice.start()` and `Battle.start()`,
and therefore both of their guards entirely) still silently overwrites `AL.state` while a
practice match is live. This is real and reproduced live, but meaningfully **lower
severity** than the third path: it does not leak any WS traffic (confirmed via frame
capture, with and without a real open room connection present) and stays in the same
"devtools-only, self-corrupts only the attacker's own client" reachability/consequence
tier the original Finding 2 was always rated at — it does not reach a third party's real
match the way the third path's leaked frames could have.

### Test 1 — Direction A recheck: CONFIRMED still fixed

Real two-account PvP match reaching real `AL.state` (`Battle.isActive()` confirmed `true`
beforehand). Forced `Practice.start([...20 strikes...])` via console-style call on the
live-match client.

```
PASS  precondition: Battle.isActive() is true on Alice's client before the attack (got true)
PASS  precondition: Practice.isActive() is false before the attack (got false)
PASS  Practice.start() refused to run (Practice.isActive() still false) (got false)
PASS  real match's opponent name untouched (before=Bob_MG2, after=Bob_MG2)
PASS  HP totals untouched (before p=50/o=50, after p=50/o=50)
PASS  turn untouched (before=opponent, after=opponent)
PASS  no uncaught page errors (got [])
```

### Test 2 — Direction B recheck: CONFIRMED still fixed

Host creates a real room, leaves it open (no `leave_room`), forces `Practice.start()` over
it. A real third account then joins the abandoned room via the real room list.

```
PASS  precondition: practice match is genuinely live on Carol's client (got true)
PASS  precondition: opponent name is the fixed practice label (got 연습 상대)
PASS  Practice.isActive() stayed true throughout (got true)
PASS  opponent name unchanged by the real 3rd-account join traffic (before=연습 상대, after=연습 상대)
PASS  turn unchanged (before=opponent, after=opponent)
PASS  no uncaught page errors on Carol's client (got [])
```

### Test 3 — THIRD path (`Battle.start()` direct call) recheck: CONFIRMED fixed, including the WS-leak claim specifically

This is the exact gap `6e981c9` was written to close, and the exact repro that produced
the leaked `{"type":"action",...}`/`{"type":"end_turn"}` frames documented in the prior
follow-up. Repro (`mode-guard-followup2.js`, Test 3): real open room (live WS connection,
`Battle.isActive()` `false`), legit `Practice.start()` on top of it, then a forced
`Battle.start('forced-account-id', null)` console call — followed by a real click on the
real "End Turn" button in the still-live practice match, with `page.on('websocket')`
frame capture armed around the whole attack window (not just state inspection, since the
original gap's actual harm was network leakage, not just a flag check).

```
PASS  precondition: Battle.isActive() is false before the forced call (got false)
PASS  Battle.start() refused to run (Battle.isActive() still false) -- this is 6e981c9's claimed fix (got false)
PASS  NO outgoing WebSocket frames sent on the real relay connection after Battle.start() was refused and a real practice End Turn was clicked (got [])
PASS  no uncaught page errors (got [])
```

**This specific finding — the one this round's task was centered on — is genuinely,
solidly fixed.** The one-line `if (typeof Practice !== 'undefined' && Practice.isActive())
return;` guard added to `Battle.start()` does exactly what its doc comment claims.

### Test 4 — NEW adversarial pass: `AL.startMatch()` called directly bypasses BOTH guards and still clobbers state

**What was tested (per this task's explicit item 3):** with the guard now symmetric on
both `Practice.start()` and `Battle.start()`, is there any remaining way to get `AL.state`
corrupted across modes that doesn't go through either `start()` function directly?

Three sub-hypotheses were considered:
- **A race between the two guards' checks:** ruled out by code inspection, not just
  testing — both `Battle.start()` and `Practice.start()` run their
  `Practice.isActive()`/`Battle.isActive()` check and the subsequent state mutation
  (`started = true` / `active = true`, etc.) fully synchronously, with no `await` or other
  yield point in between. JS's single-threaded execution model means no interleaving is
  structurally possible between the check and the mutation within either function — there
  is no window for the other function to run in between. No live repro was needed to rule
  this out because the code itself makes it impossible, not just unlikely.
- **A reconnect/resume flow:** grepped the whole `js/` tree for `reconnect`/`resume` — the
  only reconnect-adjacent code (`js/battle.js`'s `handleOpponentReconnected`) only ever
  calls `AL.setFrozen(false)`, never touches match-start; there is no session-resume path
  that re-enters `AL.startMatch()`/`Practice.start()`/`Battle.start()` outside the two
  already-guarded call sites in `js/match.js` (`onBothPresent()`, `handleTurnStarted()`)
  and `js/practice.js`'s own `start()`.
- **A state mutation path that bypasses both `start()` functions entirely:** **this one is
  real.** `js/state.js`'s `AL.startMatch()` — the actual function both `Practice.start()`
  and `js/match.js`'s `handleTurnStarted()` call to do the real work of overwriting
  `state.player`/`state.opponent`/`state.turn`/etc. — has **no guard of its own**. Both of
  `6e981c9`'s (and `5435b4f`'s) guards live in the two *callers*, not in the shared
  mutator itself.

**Repro (`mode-guard-followup2.js`, Test 4):** real signup → deck select → lobby → real
`Practice.start()` (legit call, no room even needed) → real practice match reaches a real
turn in progress. Then, via a forced console-style call:

```js
AL.startMatch({
  deck: ['strike'],
  isFirstPlayer: true,
  opponentName: 'INTRUDER-DIRECT-STARTMATCH',
  opponentDeckSize: 1,
});
```

Result:
```
PASS  precondition: real practice match live (got true)
before: {"practiceActive":true,"battleActive":false,"opponentName":"연습 상대","playerHp":44,"opponentHp":50,"turn":"opponent"}
after:  {"practiceActive":true,"battleActive":false,"opponentName":"INTRUDER-DIRECT-STARTMATCH","playerHp":50,"opponentHp":50,"turn":"player"}
PASS  AL.startMatch() called directly DOES clobber AL.state even after 6e981c9 (opponentName before=연습 상대 after=INTRUDER-DIRECT-STARTMATCH) -- confirms neither guard lives in the actual mutator
PASS  Practice.isActive() STILL reports true even though the displayed match state was completely swapped out from under it (got true) -- the guard's own bookkeeping is now lying about what's on screen
PASS  Battle.isActive() stayed false (no relay/timer wiring armed by this path) (got false)
```

(Note: the `PASS` labels above mean "the predicted bug behavior was confirmed" — this is
an investigative script, not a pass/fail regression test; a "PASS" here is the finding,
not a clean bill of health.)

**Why this is lower severity than the third path, not just "another instance of it"
(`mode-guard-followup2b.js`):** re-ran the same attack with a real open room/live WS
connection present (Direction B's precondition) and `page.on('websocket')` frame capture
armed before and after the attack, then continued interacting with the corrupted match
(dismissed the `AL.startMatch()`-triggered fresh How-to-Play overlay — `startMatch()`
always routes through `'howto'` first, per its own doc comment — then clicked the real End
Turn button):

```
PASS  no WS frames sent purely from the direct AL.startMatch() call itself, even with a real open room connection present (got [])
PASS  still no WS frames leaked to the real relay after continuing to interact with the corrupted match (got [])
```

`Battle.start()` was never called by this path, so `Battle`'s own `started`-gated
`onLocalAction`/`onLocalTurnEndNotify` subscribers (the ones that actually call
`Net.send`) stay permanently no-op-ed, exactly as `js/practice.js`'s file header already
documents for the normal case. This path corrupts the **local client's own displayed
state** (a real, confusing bug if ever reachable — an opponent name, HP bar, and turn that
don't match what the player was actually doing) but does not, unlike the third path,
create any path for that corruption to reach a real second account's real match via the
relay.

**Reachability (same tier as every mode-guard finding so far):** requires a direct
console call to `AL.startMatch()` — there is no button, UI element, or normal click
sequence that reaches this; identical devtools-only reachability to Directions A, B, and
the third path.

**Why worth flagging rather than waving through (per this task's explicit ask to apply
the same scrutiny a third time):** this is the **third round in a row** a "make the fix
symmetric" patch at specific call sites has left at least one more call site uncovered
(original 2 directions → third path found in round 1 follow-up → fourth path found here).
That pattern itself is the actual signal: guarding individual callers of a shared mutator
is structurally always going to be a whack-a-mole fix as long as the mutator itself
(`AL.startMatch()`) has no opinion on whether it's safe to run. A guard placed *inside*
`AL.startMatch()` itself (e.g. refusing to run, or requiring an explicit
"tear down whichever mode is currently active first" call) would close this class of gap
for any future caller, not just the ones found so far — the same principle `6e981c9`'s own
commit message invokes for why it put the guard inside `Practice.start()`/`Battle.start()`
rather than only at their call sites, just not carried one level deeper to where the two
of them actually converge.

### Full regression suite — fresh run, 19/21 clean; same 2 pre-existing failures as the prior follow-up

Ran all 21 scripts in `server/scripts/` (excluding `migrate.js`) fresh against a
freshly-migrated local Postgres (migrations reconfirmed already applied before running):

- **19/21 pass clean:** `smoke-test.js`, `deck-smoke-test.js`, `ws-smoke-test.js`,
  `room-list-smoke-test.js`, `pvp-smoke-test.js`, `deck-size-relay-smoke-test.js`,
  `double-disconnect-smoke-test.js`, `pull-smoke-test.js`, `practice-ink-smoke-test.js`,
  `practice-mode-ai-test.js`, `expansion-cards-test.js`, `expansion-deck-ownership-test.js`,
  `ink-award-smoke-test.js`, `match-history-smoke-test.js`, `report-result-race-smoke-test.js`,
  `weaken-status-test.js`, `expansion-card-battle-ui-smoke-test.js`, `room-list-ui-fill-race-test.js`,
  `shop-ui-smoke-test.js`.
- **2/21 fail, same signature as the prior follow-up's cross-checked pre-existing
  failures (not re-litigated with a fresh worktree diff this round since the prior
  follow-up already established these are unrelated to the mode-guard/timer code and
  reproduced identically on the parent commit):**
  - `auto-end-turn-timer-sync-test.js`: 2 assertion failures, computed `~23994`–`23997ms`
    deadline where `~8000ms` was expected (matches the `~23999ms` figure recorded last
    round almost exactly).
  - `frozen-client-turn-timeout-test.js`: 15 assertion failures (identical count to the
    prior follow-up's run).
  - Neither script touches practice mode or `js/battle.js`'s/`js/practice.js`'s mode-guard
    code; both are real-PvP server-configured short-turn-timeout scenarios, same as before.
  - This follow-up's own regression run had an unrelated **local environment hiccup**
    worth noting for hygiene, not as a code finding: a leftover static file server from
    this session's own manual setup was still bound to port 8080 the first time the suite
    ran, causing `expansion-card-battle-ui-smoke-test.js`/`room-list-ui-fill-race-test.js`/
    `shop-ui-smoke-test.js` (which each spawn their own static server on that port) to fail
    with `EADDRINUSE`. Killed the stray process and re-ran; all three passed cleanly on the
    second run, shown above. Flagging this only so the `EADDRINUSE` failures don't get
    mistaken for a real regression by anyone re-reading this log later — they were this
    session's own test-harness cleanup issue, not a bug in the fix under test.

### Bottom line for the CEO

**Not a clean "fully done" verdict, but close, and the part of the milestone this round
was specifically scoped to re-check is genuinely solid.** To be precise about what's
actually true right now:

- **The specific WS-leak risk this round's task centered on (the third path,
  `Battle.start()` bypassing the mode guard) is genuinely fixed, high confidence** —
  verified with real WS frame capture, not just a state flag check, both in isolation and
  with a real live match/end-turn click driving it.
- **Direction A and Direction B (the original two Finding-2 repros) remain solidly
  fixed**, reconfirmed fresh against the current code.
- **A fourth path exists** (`AL.startMatch()` called directly) that still silently
  corrupts `AL.state` while a practice match is live, bypassing both of `6e981c9`'s
  guards entirely because neither guard lives in the shared mutator both `Practice.start()`
  and `Battle.start()` ultimately call. This is real and independently reproduced live,
  including confirming (not assuming) it does **not** leak WS traffic and stays in the
  original Finding 2's severity/reachability tier — devtools-console-only, self-corrupts
  only the attacking client, does not touch a real second account's match.
- Regression suite: 19/21, same 2 pre-existing/unrelated failures as last round, no new
  regressions from `6e981c9`.

**Recommendation, not a blocker:** given this is now the third consecutive round where a
narrowly-scoped symmetric-guard fix left one more caller of the same underlying mutator
uncovered, the durable fix is likely to move the check into `AL.startMatch()` itself
(`js/state.js`) rather than continuing to add guards at each new caller as it's
discovered — that would close this specific class of gap for any future call site, not
just the four found across three QA passes so far. This is a design/implementation call
for the programmer, not prescribed here. Given the unchanged devtools-only reachability
and the confirmed absence of any WS-leak consequence for this specific path, I would not
personally block shipping the milestone on this alone — but "Finding 2 is fully closed,
mutual guard, no gaps" is not yet an accurate statement, and CEO should make the shipping
call knowingly rather than being told it's fully resolved when one more thread was still
loose.

### Files referenced (follow-up #2)

- Commit under test: `6e981c9` (`js/battle.js`)
- Test 1-3 script: `mode-guard-followup2.js` (scratchpad,
  `/private/tmp/.../scratchpad/qa-followup2/`)
- Test 4 scripts: `mode-guard-followup2.js` (Test 4), `mode-guard-followup2b.js`
  (WS-leak-absence + continued-interaction supplementary check)
- Fix code re-verified: `/Users/jungjongchan/Desktop/company/js/battle.js` (`start()`'s
  new `Practice.isActive()` guard, `isActive()`)
- New gap located in: `/Users/jungjongchan/Desktop/company/js/state.js` (`startMatch()` —
  no guard of its own; the actual mutator both `js/practice.js`'s `start()` and
  `js/match.js`'s `handleTurnStarted()` call into)
- Regression suite: all 21 scripts in `server/scripts/` (excluding `migrate.js`); the 2
  pre-existing failures match the prior follow-up's already-cross-checked signature
  (`auto-end-turn-timer-sync-test.js`, `frozen-client-turn-timeout-test.js`)
- `server/.env` reconfirmed pointing at local Postgres (`neoncore_dev`) before any
  testing began; migrations reconfirmed already applied locally.

---

## Follow-up verification #3 — independent re-check of commit `52f1d72` (2026-08-10)

**Scope:** independently re-verifying `52f1d72` ("Move mode guard into the shared
`AL.startMatch()` root"), the fix for the FOURTH path (`AL.startMatch()` called
directly, bypassing both `Practice.start()`'s and `Battle.start()`'s guards) found in
follow-up #2 above. This is the third consecutive round of the same class of finding, so
per this round's task, the same scrutiny was applied once more — including, per explicit
instruction, stress-testing the `state.screen` boundary logic itself (not just re-running
the four known repros) and one more adversarial pass for a fifth path. Same rigor as all
three prior passes: real spawned `server/` process, real local Postgres
(`server/.env`'s `DATABASE_URL` reconfirmed pointing at
`postgresql://postgres@localhost:5432/neoncore_dev` before any testing — migrations
reconfirmed already applied via `node scripts/migrate.js`, never touched production),
real static file server serving the repo root, real client bundle, Playwright
(`chromium` 1.62.1, scratchpad-local install, `NODE_PATH`-injected, not a repo
dependency) driving genuine multi-account UI flows end-to-end, plus `page.on('websocket')`
frame capture for every test in this round (not just the ones that historically leaked),
plus real card-by-card gameplay (via `AL.selectCard()`/`AL.targetOpponent()`/`AL.endTurn()`
calls that mirror real click behavior) to drive matches to genuine conclusions rather than
only ever injecting state.

All scripts referenced below live only in this session's scratchpad
(`/private/tmp/.../scratchpad/qa-followup3/`), not the repo.

### Updated verdict

**The specific fix under test (`52f1d72`) is genuinely solid — all four cumulative
cross-mode-corruption paths are now blocked, the screen-boundary logic behaves correctly
in both directions (blocks the illegitimate case, does not break the legitimate replay
case), and a fifth adversarial path was found but is meaningfully different in kind from
the first four (see below), not "yet another caller of the same gap." However, this
round's screen-boundary stress-testing (specifically, driving a REAL practice match to a
real conclusion and clicking the REAL "다시 연습하기" replay button, exactly what the task
asked to verify) surfaced a separate, unrelated, and more serious bug: the AI's own §3.3
turn-1 attack lock is completely broken whenever the AI is the genuinely-first player in
practice mode, deterministically confirmed (3/3 isolated repro trials, 100% reproducible,
not flaky) and root-caused to a parameter-semantics inversion between `js/practice.js` and
`js/ai.js` that has been present, unchanged, since the very first practice-mode-AI commit
(`8255845`) — i.e., pre-dating and completely unrelated to the mode-guard fix under test
in this round, but directly contradicting a claim in the original milestone QA report's own
"What passed" section. This bug is legitimately reachable through completely normal
gameplay (no devtools needed) roughly half the time, which changes this round's overall
bottom line even though the guard fix itself checks out cleanly.**

### Test 1 — EXACT original repro: CONFIRMED fixed

Direct `AL.startMatch()` console call during a live, real practice match (not the whole
match torn down and rebuilt — the exact repro that found the fourth path last round).
`mode-guard-followup3.js`, Test 1:

```
PASS  precondition: real practice match live on battle screen (got battle)
PASS  AL.startMatch() returned undefined (early-return guard path, not a value) (got undefined)
PASS  opponent name UNCHANGED (before=연습 상대, after=연습 상대)
PASS  HP totals UNCHANGED (before p=50/o=50, after p=50/o=50)
PASS  turn UNCHANGED (before=player, after=player)
PASS  hand length UNCHANGED -- no re-deal happened (before=5, after=5)
PASS  screen UNCHANGED (before=battle, after=battle)
PASS  Practice.isActive() still true (got true)
PASS  no WS frames sent (got [])
PASS  no uncaught page errors (got [])
```

Zero state mutation of any kind, confirmed field-by-field (not just the one field the prior
round happened to check) — this is a clean, complete block, not a partial one.

### Test 2 — Direction A recheck: CONFIRMED still fixed

Real two-account PvP match, forced `Practice.start()` on top of it. `Practice.start()`
refused; real match's opponent name, HP, all untouched. No uncaught errors.

### Test 3 — Direction B recheck: CONFIRMED still fixed

Host leaves a real room open, forces a real practice match over it (no `leave_room` sent),
a real third account joins the abandoned room. `Practice.isActive()` stayed `true`
throughout; the live practice match's opponent name/turn were unchanged by the intruding
real-match traffic.

### Test 4 — Third path (`Battle.start()` direct call) recheck: CONFIRMED still fixed, including WS-frame capture

Forced `Battle.start('forced-account-id', null)` over a live practice match, then a real
click on the real End Turn button, with WS frame capture armed around the whole window:

```
PASS  precondition: Battle.isActive() is false before the forced call (got false)
PASS  Battle.start() refused to run (got false)
PASS  NO outgoing WS frames after Battle.start() refused + real practice End Turn click (got [])
PASS  no uncaught page errors (got [])
```

### Test 5 — Screen-boundary stress: legitimate replay from a genuinely-concluded VICTORY screen works correctly (not just "illegitimate case blocked")

This is the task's explicit item 3 ask: does calling `startMatch()` at the exact moment
`state.screen` is `'victory'`/`'defeat'` (the legitimate replay case) still work, not just
"does the guard block the bad case." Rather than injecting state, this drove a **real
practice match to a genuine conclusion via real card plays** (`AL.selectCard()`/
`AL.targetOpponent()`/`AL.endTurn()` calls, the same functions real clicks invoke), then
clicked the real `#btn-practice-again-victory` button:

```
PASS  real match reached a genuine conclusion via real card plays (got resultScreen=victory)
PASS  practice replay button (#btn-practice-again-victory) is visible on the real result screen
PASS  legit replay click DID start a fresh match (screen transitioned to 'howto', got howto)
PASS  fresh match reached the real battle screen after dismissing howto (got battle)
PASS  fresh match has a real, freshly-initialized opponent (got 연습 상대)
PASS  fresh match HP correctly reset to 50/50 (got p=50 o=50)
PASS  fresh match hand correctly re-dealt to 5 cards (got 5)
PASS  no uncaught page errors across the whole match+replay flow (got [])
```

Confirms `startMatch()`'s guard (`state.screen === 'battle' || state.screen === 'howto'`)
correctly treats a real, HP-confirmed match conclusion's resulting `'victory'`/`'defeat'`
screen as "safe to replay from" — the legitimate path is not collateral damage from the
fix. (Re-run twice more for determinism; see Test 5 note under "A separate bug surfaced by
this exact test" below — one of the three runs' HP-reset assertion failed, but for a reason
proven unrelated to the guard itself.)

### Test 6 — Rapid DOUBLE-CLICK on the replay button at the victory screen: guard does not break the legitimate race

Fired two real `.click()` calls on `#btn-practice-again-victory` with zero event-loop turns
between them (`btn.click(); btn.click();` inside one `page.evaluate()`, the same
tightest-possible-race technique the original QA pass used for the room-list race):

```
PASS  after double-click, screen is a single valid post-replay state, not stuck (got howto)
PASS  opponent correctly re-initialized exactly once, not corrupted by the double call (got 연습 상대)
PASS  player HP correctly reset to exactly 50 (not double-reset or partial) (got 50)
PASS  reaches real battle screen cleanly after the double-click race (got battle)
PASS  hand has exactly 5 cards, not 10 (would indicate startMatch() ran twice and drew twice) (got 5)
PASS  no uncaught page errors from the double-click race (got [])
```

The second click's `Practice.restart()` → `Practice.start()` → `AL.startMatch()` call
lands while `state.screen` is already `'howto'` (the first click's own transition,
synchronous) and is correctly refused by the guard — exactly one match starts, not a
half-applied mix of two.

### Test 7 — 'howto' inclusion: confirmed there is no legitimate path that needs unblocking

Task item 3's second half: is there a legitimate scenario where a real `startMatch()` call
should be allowed to proceed while `state.screen === 'howto'`, that this fix incorrectly
blocks? Checked both statically and dynamically:

- **Static (index.html/js/ui.js):** `#btn-restart-victory`/`#btn-practice-again-victory`/
  `#btn-restart-defeat`/`#btn-practice-again-defeat` (the only 4 UI elements that can ever
  trigger a `startMatch()` call) live inside `#screen-victory`/`#screen-defeat`, separate
  `<section class="screen">` elements from `#screen-howto` — `js/ui.js`'s `render()` calls
  `Screens.show('screen-' + state.screen)`, a mutually-exclusive single-screen swap. There
  is no DOM state in which `#screen-howto` and either result screen are both visible/
  reachable at once.
- **Dynamic** (`mode-guard-followup3.js`, Test 7): reopened Howto mid-match via the real
  "?" button (`howtoContext` correctly becomes `'reopen'`), then checked the actual
  rendered DOM:
  ```
  PASS  mid-match reopened Howto correctly enters screen='howto'/context='reopen'
  PASS  #screen-victory and #screen-defeat are both hidden while on the reopened howto
        screen -- no DOM path to either replay button
  PASS  closing reopened howto correctly returns to 'battle' (real live match undisturbed)
  ```

No legitimate path was found or is architecturally possible today. The fix's own doc
comment's claim ("'battle'/'howto' together mean a match is currently live") holds up
under both static and dynamic scrutiny.

### Test 8 — FIFTH adversarial path found: `AL.endMatchByResult()` can forge the screen transition the guard trusts

Per this task's explicit instruction not to assume the fix is now exhaustive: is there a
way to make `state.screen` become `'victory'`/`'defeat'` *without* a real match actually
ending, and then chain a `startMatch()` call through the now-reopened guard window?

`js/state.js`'s `endMatchByResult()` — the function `js/battle.js` calls in reaction to a
real relay `match_ended` message — is itself publicly exposed on `AL` and callable directly.
Called directly (bypassing its only real caller, the same "call a real function via
devtools instead of through its normal trigger" pattern every prior path in this doc used),
it unconditionally sets `state.screen` to `'victory'`/`'defeat'` with **no check that either
side's HP is actually 0** (`mode-guard-followup3.js`, Test 8):

```
PASS  precondition: a genuinely live, unfinished practice match (neither side at 0 HP)
      (got {"screen":"battle","playerHp":50,"opponentHp":50,"matchResult":null})
PASS  AL.endMatchByResult('win') alone (no HP change) DOES force screen to 'victory' with
      neither side actually at 0 HP (got screen=victory, playerHp=50, opponentHp=50)
PASS  chained AL.startMatch() after the forged endMatchByResult() call DOES succeed and
      overwrite state (opponentName after=INTRUDER-VIA-FORGED-END) -- confirms the
      screen-based guard's "victory/defeat means a real match genuinely ended" assumption
      can be forged by a different exposed function
PASS  no WS frames leaked from this chain either (self-corruption only, same tier as path 4)
PASS  no uncaught page errors (got [])
```

**Why this is real but is NOT rated/treated the same as "yet another instance of the same
gap" (findings 1-4):** unlike the first four paths — each of which was a different *caller
of the same underlying mutator* that a plausible future legitimate code path could
realistically reintroduce (a new screen, a reconnect flow, a new caller of
`Battle.start()`, etc.) — this fifth path requires forging a **second, unrelated function's**
result first (`endMatchByResult()`, which itself has no HP/legitimacy check of its own,
a real gap in its own right, separate from anything the mode-guard commits touched). It is
also one level further from "a future legitimate caller could stumble into this" than paths
1-4 were: paths 1-4 were all single direct calls to a function whose whole *purpose* is to
start a match; this path requires first calling a function whose purpose is to react to a
match ending, with a fabricated result, specifically to manufacture the precondition the
guard trusts. Same devtools-only reachability tier as every other finding in this document,
same "self-corrupts only the attacking client, no WS leak" consequence tier as the fourth
path — not escalating severity, but real, and worth recording as a reminder that a
screen-value check is fundamentally a proxy for "is a match really over," not the thing
itself, and any other function that can set that proxy without the real underlying
condition being true can reopen the same door. (Also worth noting for completeness, though
not tested as a separate "path" here since it's not really a distinct *mechanism*: `AL.state`
itself is a live, directly-mutable object reference exposed on the public `AL` API — literally
any field, including `state.screen` itself, can be set directly via
`AL.state.screen = 'victory'` from devtools with no function call at all. This is a
structural property of every field in this app, not something specific to the mode guard,
and no function-level guard can ever close it — noted for completeness/honesty about the
actual trust boundary here, not as an actionable item.)

### A separate, more serious bug surfaced incidentally by Test 5's exact scenario: the AI's turn-1 attack lock is broken when the AI goes first in practice mode

**This is NOT a mode-guard finding and is unrelated to `52f1d72`.** It surfaced because Test
5 (per this round's explicit task item 3) drove a *real* practice match through a *real*
"다시 연습하기" replay, which — unlike the match's original `Practice.start()` call from the
lobby — performs a **fresh, un-forced coin flip every time** (`js/practice.js`'s `restart()`
calls `start()` without an explicit `isFirstPlayer`, by design, "exactly like a real new
match would"). On one of three otherwise-identical re-runs of Test 5, the freshly-replayed
match's `AL.state.player.hp` was `36` immediately after the replay's How-to-Play overlay was
dismissed — i.e., **the AI dealt 14 damage before the player had taken a single action**,
on what should have been a locked first turn.

**Deterministic, isolated, root-caused confirmation** (`turn1-lock-deep-dive.js`, run 3
times, 3/3 reproductions, not flaky):

- **Scenario B — AI explicitly set first (`isFirstPlayer: false`), mixed deck (10× Strike +
  10× Defend):**
  ```
  PASS  precondition: AI's own turn 1 (isFirstPlayer:false) (got turn=opponent)
  FAIL  SPEC REQUIREMENT (§6.3.1/§7.2, CEO decision): the AI, as the genuine first player,
        must deal 0 damage on its own real first turn -- player HP must stay at 50
        (got 32 / 38 / 36 across the 3 runs)
  ```
  Genuinely first-player AI deals real, unanswered damage (12-18 HP, i.e. 24-36% of max HP)
  on its true turn 1, in every one of 3 trials.
- **Scenario A — player explicitly set first (`isFirstPlayer: true`), same deck, for
  comparison:** the AI's own actual first turn (the match's 2nd turn boundary, since player
  went first) correctly dealt 0 damage in all 3 trials — but this turns out to be the
  *other* half of the same bug (see root cause below), not evidence the lock works
  correctly in general.

**Root cause, confirmed by reading the code (not just inferred from behavior):**
`js/practice.js`'s `start()` computes a single `isFirstPlayer` boolean (its own established
meaning throughout this codebase: "does the real, local player go first" — this exact value
is what gets passed to `AL.startMatch({ isFirstPlayer, ... })`, whose own semantics are
unambiguous: `state.turn = isFirstPlayer ? 'player' : 'opponent'`). `start()` then passes
this **exact same, un-inverted** value into `AI.createBrain(deckIds, { isFirstPlayer, ... })`
— but `js/ai.js`'s own doc comment for that parameter states the opposite meaning: `//
isFirstPlayer -- whether AL.startMatch() made the AI go first`, and its code
(`blockAttack = isFirstPlayer && turnsTaken === 0`) is written consistently with *that*
(inverted) meaning. The two modules disagree about what this one shared field name means,
and the actual production glue code (`js/practice.js`) never reconciles the difference.

**This is confirmed to be a real, known, intended contract by the programmer's own unit
test** (`server/scripts/practice-mode-ai-test.js`, section 2a/2b) — which manually inverts
the value at every call site specifically to get correct behavior in isolation:
```js
freshMatch(AL, { isFirstPlayer: false, deck: [...] });
// isFirstPlayer:false means the LOCAL player is second -> the AI (opponent) goes first.
...
const brain = AI.createBrain([...], {
  isFirstPlayer: true, pacingMs: 0, maxIterations: 10,   // <-- manually inverted here
});
```
The unit test's own comment demonstrates the test author understood the two meanings are
opposite and correctly inverted the value at the call site — but this inversion was never
carried into the real production caller (`js/practice.js`), so the unit test (which tests
`AI.createBrain()` in isolation with an already-correct, pre-inverted parameter) passes
cleanly and gives false confidence, while the real integrated app is broken. This is a
textbook "unit test validates the component correctly, but the integration wiring the real
app actually uses is wrong" gap — exactly the class of bug that requires live/E2E testing to
catch, which is presumably why it survived three prior QA rounds' regression-suite re-runs
(which only re-ran the existing, already-passing unit test) without being caught with
certainty.

**This also appears to conflict with a specific claim in the original milestone QA report**
(this document, "What passed" §3): *"(b) a real, unscripted browser match where the AI
happened to go first: player HP was unchanged after the AI's entire first turn, confirmed
via `AL.state`."* Given this round's deterministic, repeated, code-corroborated
reproduction, that earlier single live-browser observation was very likely either a
coincidental hand draw with no immediately-affordable Attack card, a misread of which side
actually went first, or a state of the code that has since changed — I cannot reconcile it
with what the code and 3/3 deterministic trials show today, and flag the discrepancy
honestly rather than silently overriding the earlier claim without comment.

**Confirmed via `git blame`:** both the `js/practice.js` call site and the mismatched
`js/ai.js` doc comment/logic have been present, byte-for-byte unchanged, since commits
`8255845` (AI engine) and `9f574e2` (lobby wiring) — the very first practice-mode
commits — meaning this is **not** a regression from `52f1d72` or any of the mode-guard
commits; it predates all of them and is orthogonal to this round's actual assignment.

**Severity: Major.** Reasoning, calibrated the same way this document already rates its one
other Major finding (the backgrounded-tab timer): this is a real, deterministically
reproducible break of one of only two design points the CEO explicitly overrode the
original recommendation on (§0 decision, §6.3.1/§7.2's turn-1 attack lock, "선공을 하는
플레이어는 첫 턴에는 공격을 못하게 해야겠다") — and unlike every other finding in this
document's three follow-up rounds, **it requires no devtools, no forced call, and no
adversarial setup whatsoever** — it happens on a genuinely ordinary coin-flip outcome that
occurs on roughly half of all real practice matches (and on every single "다시 연습하기"
restart, independent of the previous match's outcome, since restart always re-flips). Not
rated Blocker because, like Finding 1, there is no crash/state-corruption and the match
remains fully playable — it's a fairness/feel violation, not a hard break — but it directly
undercuts the specific headline guarantee (§3.3: "AI가 선공일 때도 동일하게 첫 턴 공격
불가") this milestone's own design doc calls out by name as a CEO-confirmed requirement,
in the single most common way a real player would ever encounter it (just playing/replaying
practice mode normally).

**Suggested area to look at (not a fix, matching this document's convention):**
`js/practice.js`'s `start()`, the one call site that passes `isFirstPlayer` into
`AI.createBrain()` — needs to pass the AI-relative value (`!isFirstPlayer`, given
`AI.createBrain()`'s documented contract, or alternatively align `js/ai.js`'s contract to
match what's actually passed and fix the semantic there instead) rather than the
player-relative value `AL.startMatch()` correctly uses. Either module's contract could be
the one that changes — a call for the programmer, not prescribed here.

### Full regression suite — fresh run, 19/21 clean, same 2 pre-existing/unrelated failures as both prior follow-up rounds

Ran all 21 scripts in `server/scripts/` (excluding `migrate.js`) fresh against a
freshly-migrated local Postgres (migrations reconfirmed already applied before running):

- **19/21 pass clean:** `smoke-test.js`, `deck-smoke-test.js`, `ws-smoke-test.js`,
  `room-list-smoke-test.js`, `pvp-smoke-test.js`, `deck-size-relay-smoke-test.js`,
  `double-disconnect-smoke-test.js`, `pull-smoke-test.js`, `practice-ink-smoke-test.js`,
  `practice-mode-ai-test.js` (passes cleanly, per above — it validates `AI.createBrain()`
  in isolation with an already-manually-inverted parameter, so it does not exercise the
  integration bug found in this round), `expansion-cards-test.js`,
  `expansion-deck-ownership-test.js`, `ink-award-smoke-test.js`, `match-history-smoke-test.js`,
  `report-result-race-smoke-test.js`, `weaken-status-test.js`,
  `expansion-card-battle-ui-smoke-test.js`, `room-list-ui-fill-race-test.js`,
  `shop-ui-smoke-test.js`.
- **2/21 fail, identical signature to both prior follow-up rounds:**
  `auto-end-turn-timer-sync-test.js` (2 assertion failures, computed `~23994`-`23999ms`
  deadline where `~8000ms` was expected, plus the same `waitFor` timeout crash in Scenario
  C) and `frozen-client-turn-timeout-test.js` (15 assertion failures, same
  server-driven turn-reconciliation scenarios). Neither script touches practice mode or any
  code this round's fix (`52f1d72`) or investigation touched — both were already
  independently cross-checked against a parent-commit `git worktree` in follow-up #1 and
  reconfirmed present with an identical signature in follow-up #2; not re-litigated a third
  time since nothing relevant to them has changed and their signature (exact failure
  counts, exact computed values) is unchanged again this round.
- **Minor environment hygiene note (not a code finding):** `expansion-card-battle-ui-smoke-test.js`,
  `room-list-ui-fill-race-test.js`, and `shop-ui-smoke-test.js` each attempt to spawn their
  own dedicated server process on port 3001 and logged an `EADDRINUSE` error from that child
  process, because this session already had its own manually-started `server/` process bound
  to port 3001 for the earlier tests in this round. All three scripts still completed with
  `ALL PASS`/exit 0 (they evidently tolerate their own spawn failing and proceed against
  whatever is already listening) — flagging only so this doesn't get mistaken for a real
  regression by anyone re-reading this log later, same spirit as the port-8080 hygiene note
  in follow-up #1.

### Bottom line for the CEO — on this round's fix, AND a genuinely final verdict on the whole practice-mode milestone

**On `52f1d72` specifically: genuinely fixed, high confidence.** All four cumulative
cross-mode-corruption repros (Direction A, Direction B, the third path/WS-leak, and this
round's exact original fourth-path repro) are solidly blocked, field-by-field, with zero
state mutation and zero WS leakage. The screen-boundary logic the fix relies on was
stress-tested in both directions per this round's explicit ask: it correctly blocks the
illegitimate case AND does not break the legitimate replay case (real match → real victory
screen → real "다시 연습하기" click → real fresh match, HP/hand/opponent all correctly
reset, including under a genuine double-click race). The `'howto'` inclusion was checked
both statically and dynamically and has no legitimate path that needs unblocking. A fifth
adversarial path was found (`endMatchByResult()` forging the screen transition the guard
trusts) but is a different, one-level-removed class of gap from the four found across
rounds 1-3 — not "the same whack-a-mole pattern continuing a fourth time." Putting the
guard in the shared mutator, as this commit did, was the right call and it holds up.

**On the whole practice-mode milestone, now that this specific thread is closed: not
ready to ship as fully complete, but for a reason this round's task did not originally
target.** To state this plainly, since three rounds of "found one more gap" makes it
important not to either inflate remaining doubt or paper over a real one:

- **The cross-mode state-corruption class of bug (original Finding 2 and all of its
  follow-on paths) is now genuinely, solidly closed.** This does not need another round of
  the same kind of scrutiny — four rounds of adversarial pressure on this exact mechanism
  have converged on "fixed," and the one further gap found this round (the fifth path) is
  categorically different, not a sign the same fix is still leaking.
- **Finding 1 (the backgrounded-tab timer, from the very first QA pass) remains fixed** per
  follow-up #1's high-confidence direct-mechanism verification; nothing in this round
  touched that code and nothing here casts doubt on it.
- **A new Major finding stands in the way of a clean "ready" verdict:** the AI's turn-1
  attack lock is broken for roughly half of all real practice matches (and every
  "다시 연습하기" restart), in a way any real player can hit through completely ordinary
  play, no devtools required — directly contradicting one of the milestone's two explicit
  CEO-overridden design decisions, in the single most common way a player would encounter
  it. This was not on this round's original task list, but it was found while faithfully
  executing the task's own explicit instruction to verify the legitimate replay path
  actually works correctly, not just that the illegitimate path is blocked — and it is
  serious enough, common enough, and clearly enough root-caused that reporting it as "out of
  scope, someone else's problem" would not serve the CEO well.

**Recommendation:** the mode-guard work (this round's actual assignment) can be considered
done — no further rounds of "find one more path" are warranted for that specific class of
bug. The milestone as a whole should not ship until the newly-found turn-1-lock integration
bug is fixed and re-verified; it is a genuine regression against explicit CEO-approved
design intent, reliably reproducible through ordinary play, not a devtools-only edge case
like everything else in this document's mode-guard thread. Recommend routing this new
finding back to the programmer the same way Finding 1 and Finding 2 originally were.

### Files referenced (follow-up #3)

- Commit under test: `52f1d72` (`js/state.js`)
- Test 1-4, 7 scripts: `mode-guard-followup3.js` (scratchpad,
  `/private/tmp/.../scratchpad/qa-followup3/`)
- Test 5-6 (screen-boundary/replay) scripts: `mode-guard-followup3.js` (Tests 5, 6)
- Test 8 (fifth path) script: `mode-guard-followup3.js` (Test 8)
- Fix code re-verified: `/Users/jungjongchan/Desktop/company/js/state.js` (`startMatch()`'s
  new `state.screen === 'battle' || state.screen === 'howto'` guard, `openHowto()`,
  `closeHowto()`, `winMatch()`, `loseMatch()`, `endMatchByResult()`)
- Fifth-path gap located in: `/Users/jungjongchan/Desktop/company/js/state.js`
  (`endMatchByResult()` — no HP/legitimacy check of its own before forcing
  `state.screen`)
- New, unrelated turn-1-lock bug: deep-dive script `turn1-lock-deep-dive.js` (scratchpad,
  same directory), root cause in
  `/Users/jungjongchan/Desktop/company/js/practice.js` (`start()`'s
  `AI.createBrain(deckIds, { isFirstPlayer, ... })` call, passing the player-relative value
  unchanged) vs. `/Users/jungjongchan/Desktop/company/js/ai.js` (`createBrain()`'s doc
  comment and `blockAttack` logic, which expect the AI-relative value), cross-checked
  against `/Users/jungjongchan/Desktop/company/server/scripts/practice-mode-ai-test.js`
  (section 2a/2b, which manually inverts the value at its own call sites, confirming the
  intended contract); confirmed present unchanged since commits `8255845`/`9f574e2` via
  `git blame`
- Regression suite: all 21 scripts in `server/scripts/` (excluding `migrate.js`); the 2
  pre-existing failures match both prior follow-up rounds' already-cross-checked signature
  exactly (`auto-end-turn-timer-sync-test.js`, `frozen-client-turn-timeout-test.js`)
- `server/.env` reconfirmed pointing at local Postgres (`neoncore_dev`) before any testing
  began; migrations reconfirmed already applied locally (`Migrations up to date`).
