# QA Report — Fractional Damage / HP-Block Milestone

**Scope:** `docs/design/fractional-damage-proposal.md` §5-§7 (Option B, CEO-approved) vs.
commit `3b2e9ab` ("Implement fractional HP/block"). This is a core state-representation
change (`target.hp`/`target.block` can now hold real `.5` values) that touches win/loss
detection, the display layer, real PvP's mirrored state, and the practice-mode AI's
HP-ratio heuristic. Also re-checked `docs/qa/card-shop-currency-milestone.md`'s
Weaken-related findings against the new behavior, per that report's own forward-flag and
this task's explicit ask.

**Environment:** Confirmed `server/.env`'s `DATABASE_URL` points at
`postgresql://postgres@localhost:5432/neoncore_dev` (local Postgres.app) before running
anything server-side. Method: independent verification, not a re-run of the programmer's
own tests trusted at face value (though `weaken-status-test.js` and 7 other
server-side regression scripts were run fresh first as a baseline — all pass, see
below). Independent tests were written from scratch this session in the scratchpad
(`/private/tmp/.../scratchpad/qa/`, not the repo) using the same `vm`-loaded
real-`js/state.js`/`js/data.js`/`js/ai.js` technique this repo's own
`weaken-status-test.js` already uses and treats as sound for pure rules-engine
verification (no browser-only globals in the code paths under test) — every assertion
below drives the exact, unmodified production module through its real public API
(`selectCard`/`targetOpponent`/`endTurn`/`applyRemoteAction`), never a reimplementation
or direct mutation of internal fields except where seeding a precondition (the same
convention the programmer's own test suite already uses for Tests C/H).

---

## Verdict

**Ready for production as far as this milestone's scope is concerned. No blocking or
major issues found**, despite deliberately adversarial probing across every vector the
task flagged as high-risk (win/loss boundaries at exactly `0`/`0.5`, multi-turn float
accumulation, two-independent-client mirrored sync, Execute/practice-AI ratio
thresholds at the fractional boundary, Twin Strike's lethal-first-hit edge case). This
is a clean implementation of a genuinely tricky spec. One pre-disclosed cosmetic
side-effect (already called out in the design doc itself) was independently confirmed
accurate rather than worse than described; no new issue attaches to it.

This does **not** mean nothing is worth a second look — see "Notes, not blockers"
below for two low-priority observations (a pre-existing, unrelated UI gap noticed
along the way, and a scope note on what wasn't independently re-verified this pass).

---

## What was checked and passed

### 1. Win/loss detection at fractional HP boundaries — correct, including the `0`-vs-`0.5` edge
`dealDamage()` (`js/state.js`) clamps with `target.hp = Math.max(0, target.hp - remaining)`
— HP is **never allowed to go negative**, so the `hp <= 0` win/loss check downstream
always compares against a literal `0`, never a small negative epsilon. Verified via real
combat (repeated real Weakened `Strike` plays through `selectCard()`/`targetOpponent()`,
not direct `hp` assignment) driving an opponent from 50 HP down through every `.5` step
(45.5, 41, 36.5, ... 0.5) — confirmed `state.screen === 'battle'`/`matchResult === null`
(still alive) at every intermediate step including exactly `0.5`, and confirmed the next
hit clamps to exactly `0` and immediately transitions to `screen: 'victory'`,
`matchResult: 'win'`. Also verified the symmetric loss-side path (`applyRemoteAction`
driving `state.player.hp` down the same way) and the "lands exactly on `0`, no clamping
needed" case (`4.5 - 4.5 = 0`) both resolve identically correctly. Twin Strike's
`if (target.hp > 0)` gate for its second hit was also verified at the fractional
boundary: a first hit landing exactly on `0` correctly skips the second hit and ends the
match immediately; a first hit landing on a nonzero fractional remainder (`0.5`)
correctly lets the second hit fire and finish the job.

### 2. Display consistency — no misleading "still alive"/"dead" mismatch is possible given the current card pool
Because Weaken's `x0.75` can only ever produce a whole number or exactly `.5` (proven
structurally in the design doc's §2.2 and independently re-derived), the *minimum
possible nonzero* HP value is exactly `0.5` — which `fmtStat()`'s round-half-up
(`Math.round(0.5) === 1`, confirmed empirically) always displays as **"1"**, never "0".
So a player can never see "0 HP" while actually still alive, and can never see a
nonzero displayed HP while actually dead (death is detected and the screen transitions
synchronously, in the same tick, before any render of a `hp <= 0` state as still-battle
is possible — `applyCardEffect()` → the `hp <= 0` check → `winMatch()/loseMatch()` all
run before `emit()` fires a render). There is also no "low HP" color/warning threshold
anywhere in the UI today (confirmed via grep across `js/*.js`/`css/*.css`) that could
independently use a rounded vs. precise value inconsistently — one less surface for this
class of bug to hide in.

Independently re-derived the design doc's own §5.4 "known/disclosed" caveat rather than
just trusting it was described accurately: the HP-bar-implied delta and the
damage-popup number for the *same* hit can legitimately round to different-looking
integers (e.g. HP text drops from "46" to "42" — a visual "-4" — while the popup for
that same hit shows "-5", because the popup rounds the raw hit amount independently of
the before/after HP text rounding). Confirmed this is exactly the doc's own disclosed
behavior, not worse than described, and it is Weaken-only-and-cosmetic in practice
(never off by more than the doc's own stated 0.5-per-hit bound given the current card
pool). Not filing this as a new bug — flagging only to confirm the disclosure was
accurate.

Also spot-checked the Execute (`§6.3` HP<=30% bonus) and practice-AI (`§3.2`'s 30%/15pp
thresholds, `js/ai.js`) ratio checks specifically at the fractional boundary, since both
read `hp/maxHp` directly: with `maxHp` always exactly `50` in this game, the 30%
threshold (`15`) sits exactly on an integer, which (given fractional HP only ever being
`X` or `X+0.5`) means there is never a case where the *displayed* rounded HP is
ambiguous about which side of the threshold the *real* value is on — verified this
empirically for both Execute (`15.5/50` does not trigger the bonus, `14.5/50` and exactly
`15/50` both do, matching the literal `<= 0.3` spec wording) and the practice AI
(`decideNextCard()` correctly switches from the attack-first branch to the
self-preservation skill-first branch exactly at the `14.5` vs `15.5` boundary), not just
reasoned through from the code.

### 3. Multi-turn accumulation — no float drift
Ran a real, multi-turn sequence mixing Weakened and unweakened hits from both sides,
partial block-absorption leaving a fractional block remainder, and 20 additional
alternating strikes, then checked every one of `player.hp`/`opponent.hp`/`player.block`/
`opponent.block` for the `45.49999999999999`-style residue the task specifically asked
to rule out empirically (`Number.isInteger(n * 2)` — i.e., every value sits exactly on
the `.5` grid with no extra binary dust). **No drift found** — every value was exactly
clean. This matches the design doc's own reasoning (`0.5 === 2^-1`, exactly
representable in IEEE754 double precision, so sums/differences of values built only from
integers and exact halves can never accumulate rounding error) but was verified with a
real sequence rather than taken on that reasoning alone.

### 4. Mirrored-state sync (real PvP) — bit-for-bit identical across two independent clients
Simulated two fully independent `AL` instances (equivalent to two separate browser
tabs each running their own copy of `js/state.js`), one driving a Weaken-affected
exchange through its own local API (`selectCard`/`targetOpponent`) and the other
receiving the identical sequence as `applyRemoteAction({type:'playCard', ...})` calls
(exactly the shape `js/battle.js` wires in production). After a `Strike` → `Twin Strike`
(partial block absorb, fractional block remainder) → `Heavy Slash` sequence, both
clients' `hp`/`block` values were checked with `Object.is()` (not just `===`, to rule out
`+0`/`-0` or `NaN` divergence) — **identical every step**. Also verified a lethal
fractional exchange: both clients independently land on exactly `0` HP and independently
reach matching verdicts (`clientA` detects its own win via `winMatch()`, `clientB`
independently detects its own loss via `applyRemoteCardPlay()`'s own `player.hp <= 0`
check — neither needs the other to tell it the result, exactly as the file's own
match-end architecture intends).

### 5. Interaction with existing systems
- **Ink award / match-end reporting:** confirmed by reading `js/battle.js`
  (`onLocalMatchEnd`) and `server/src/lib/matchHistory.js` that `report_result` only
  ever transmits the literal string `'win'`/`'loss'` — **no HP/damage value is ever sent
  to the server**. Since win/loss detection itself was independently verified correct at
  every fractional boundary (§1 above), Ink award/`match_history` correctness for a
  fractional-HP-triggered win reduces entirely to "was the right string sent," which is
  unaffected by this change and already covered by the existing, still-green
  `report-result-race-smoke-test.js`/`ink-award-smoke-test.js`/`practice-ink-smoke-test.js`
  (all re-run fresh against a live local server/DB this session — all pass).
- **Practice-mode AI heuristic:** see §2 above — the `selfHp/selfMaxHp`/`oppHp/oppMaxHp`
  ratio reads in `js/ai.js` handle fractional inputs correctly and, per the design doc's
  own observation, are if anything now *more* precise than the old integer-HP version
  (no pre-existing rounding error at the ratio boundary).

### 6. Re-check of `card-shop-currency-milestone.md`'s Weaken findings against the new (un-floored) behavior
Re-ran `weaken-status-test.js` fresh (now updated by the implementing session to expect
exact `.5` values instead of floored integers, plus 3 new tests for
accumulation/block-partial-absorb/display) — **all pass**. The turn-boundary decay
timing fix from that report's Finding 3 (decay fires at the weakened side's own
turn-*end*, not turn-*start*) is structurally untouched by this change (it operates on
the integer `weaken` stack counter, never the fractional damage value) and Tests D/F in
the suite (unaffected by floor removal in their assertions' *shape*, only their damage
*numbers*) still confirm it holds. Findings 1 (expansion-card UI crash) and 2
(`report_result` double-award race) are unrelated to HP/block representation and were
not expected to regress — confirmed via the fresh full regression run below. Finding 4
(Corrosive Aura firing on a fully-blocked 0-HP-damage hit) is untouched by this change
(the trigger check reads `card.type`/`card.target`/`card.id`, never a damage amount) and
remains exactly the same open design-ambiguity flag as before, not a fractional-damage
concern.

### Regression suite — fresh run, all pass
Ran fresh against a live local server/DB (migrations confirmed up to date):
`smoke-test.js`, `ws-smoke-test.js`, `pvp-smoke-test.js`, `match-history-smoke-test.js`,
`ink-award-smoke-test.js`, `weaken-status-test.js`, `expansion-cards-test.js`,
`report-result-race-smoke-test.js`, `practice-mode-ai-test.js`, `practice-ink-smoke-test.js`.
**All pass, no failures, no server-log errors.**

---

## Notes, not blockers

1. **Two-real-browser (Playwright) PvP verification was not performed this pass** — no
   Playwright install was available locally or in the repo's `node_modules`
   (`server/node_modules/playwright` does not exist), and installing one fresh (plus a
   Chromium download) felt like disproportionate cost for what this specific feature
   needs: unlike the original card-shop-currency milestone's `report_result` race (a
   genuine network-timing concurrency bug that *required* real sockets to expose), this
   feature is pure deterministic arithmetic replayed identically on both clients from a
   `cardId` string — the "real PvP sync" question reduces exactly to "do two independent
   copies of the same deterministic JS function converge," which §4 above verifies
   directly and rigorously (bit-for-bit, `Object.is()`) via two independent `AL`
   instances. Flagging the gap for honesty rather than silently treating the
   vm-harness check as equivalent to a literal two-browser session — if a future session
   has Playwright available, a real two-client render check (confirming both screens'
   HP text agree, not just the underlying state) would be a cheap, if likely
   redundant, confirmation.
2. **Pre-existing, unrelated observation:** `index.html`'s player-side HP display has no
   fill-bar element at all (only `#player-hp-text`; contrast `#opponent-hp-fill`, which
   exists and is wired). This predates this milestone entirely (confirmed via `git log`
   — the last touch to `js/ui.js` before this commit was an unrelated online-PvP fix)
   and this commit didn't need to touch it (the fractional-HP change only added
   `fmtStat()` rounding to the text/popup render sites, none of which required a fill
   bar to exist). Not a fractional-damage bug — noting only because it was noticed while
   reading `renderBattle()` for this review, in case it's useful for a future UI pass.
3. Did not independently re-verify `card-shop-currency-milestone.md`'s Finding 1
   (expansion-card UI crash) or Finding 2 (`report_result` double-award race) fixes from
   scratch this pass — those are already independently re-verified and closed in that
   report's own 2026-08-08 follow-up section, are structurally unrelated to
   HP/block becoming fractional, and the fresh regression run above (including
   `report-result-race-smoke-test.js`) shows no regression.

---

## Files referenced
- Spec: `/Users/jungjongchan/Desktop/company/docs/design/fractional-damage-proposal.md`
- Commit reviewed: `3b2e9ab` ("Implement fractional HP/block (fractional-damage-proposal.md Option B)")
- Engine: `/Users/jungjongchan/Desktop/company/js/state.js` (`applyWeakenToDamage`,
  `dealDamage`, `applyDamage`, `applyBlock`, `winMatch`/`loseMatch`,
  `applyRemoteCardPlay`)
- Display: `/Users/jungjongchan/Desktop/company/js/ui.js` (`fmtStat`, `renderBattle`,
  `handleFx`)
- Practice AI: `/Users/jungjongchan/Desktop/company/js/ai.js` (`decideNextCard`)
- Network/Ink (confirmed unaffected): `/Users/jungjongchan/Desktop/company/js/battle.js`
  (`onLocalMatchEnd`), `/Users/jungjongchan/Desktop/company/server/src/lib/matchHistory.js`
- Prior QA re-checked: `/Users/jungjongchan/Desktop/company/docs/qa/card-shop-currency-milestone.md`
  (Weaken findings #3/#4)
- Programmer's own updated test re-run fresh (all pass):
  `/Users/jungjongchan/Desktop/company/server/scripts/weaken-status-test.js`
- Independent QA scripts (this session's scratchpad, not part of the repo):
  `01-winloss-boundary.js`, `02-accumulation-drift.js`, `03-mirrored-pvp-sync.js`,
  `04-execute-and-ai-thresholds.js`, `05-twinstrike-lethal-first-hit.js`, `lib.js`
  (shared vm-harness loader)
- `server/.env` confirmed pointing at local Postgres (`neoncore_dev`) before any
  server-side testing began.
