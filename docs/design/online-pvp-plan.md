# ARCANE LEDGER — Online 1:1 PvP + Accounts/Deck Persistence: Task Breakdown

**v2 — updated after CEO closed all original open questions and the game-designer expanded
`docs/design/spec-online-pvp.md` with accounts, deck-slot persistence, and match history.**
This version supersedes v1: the "open questions for CEO" section below is now a resolved
historical record, not a blocker list. `spec-online-pvp.md` (§1–§10) is the authoritative
source for *what* to build; this doc is sequencing and ownership only — read the spec
alongside this before starting any task.

---

## What changed since v1 (context, not action items)

- **AI/vs-computer mode**: removed entirely. PvP is the only mode — no mode-select UI.
- **Match structure**: confirmed standalone single battle, not the dungeon-run loop.
- **Deck pool**: confirmed fully open from the start, no unlocks.
- **Turn timer**: confirmed 24s, and now specifically **server-enforced** — the server
  stamps `turn_started` with a deadline and fires `turn_timeout` itself, since v1's
  original non-authoritative-relay design didn't address client-clock trust for timers.
  This is new work, not just "add a timer."
- **Disconnect**: confirmed 45s grace + 10s-floor claim-forfeit button.
- **NEW scope (not in v1 at all)**: accounts (email/password, no guest mode), 3
  account-bound deck slots (new accounts pre-filled with a 24-card starter deck in slot
  1), match history (list of up to 100 matches, not just a counter), and a final
  infrastructure decision — plain Node.js + `ws` relay on **Render** (~$7/mo) + **Neon or
  Supabase Postgres** (free tier), no ORM, ~4 tables. This was chosen specifically because
  Render/plain-Node can run standard `bcrypt`/`argon2` packages, which a
  Workers+D1 alternative could not.

---

## Scope check (re-run, because scope grew again)

This is now genuinely **three** subsystems bolted together, not two: (1) the PvP
engine/sync rewrite flagged as the project's biggest lift in v1 — still true, unchanged;
(2) a brand-new backend — this team's first-ever auth/persistence system, from zero; (3)
three new UI screens (login/signup, deck slot list + editor, match history) plus the
opponent-panel/card-back art debt the designer already flagged in spec §9.

**Recommendation:** still shippable, but treat Phase 1 (backend foundation) as a hard
gate, not a fast-follow — deck persistence, match history, and the relay's connection
auth all sit downstream of it, so rushing or skipping it just moves the pain later.
**If the timeline gets tight, the safest single cut is Phase 5 (match history screen)** —
it's additive polish with a clean, isolated dependency chain; PvP core, auth, and deck
slots are all load-bearing for the game to function at all and shouldn't be the first
thing cut.

---

## Open questions — RESOLVED (historical record only, nothing here blocks anything)

| # | v1 question | Resolution |
|---|---|---|
| 1 | AI mode keep-or-kill | Killed. spec §1.1, §2 |
| 2 | Dungeon-run vs. standalone battle | Standalone single battle. spec §1.2, §2 |
| 3 | Deck pool fairness / unlocks | Fully open, all 14 cards, no unlocks. spec §1.3, §5.1 |
| 4 | Turn timer or untimed | 24s, server-enforced. spec §1.4, §7.3 |
| 5 | Disconnect/forfeit policy | 45s grace, 10s floor for claim-forfeit. spec §1.5, §8 |
| 6 | Relay hosting | Render, ~$7/mo. (this doc, infra decision above) |
| 7 | Deck editor spec | Done: 20–30 cards, max 3 copies/card. spec §5.2 |

**New open questions raised by this update: none that need CEO sign-off.** One item is
worth flagging so it isn't mistaken for still-open: the spec offers **"Neon or Supabase"**
Postgres as an either/or — that's intentionally left as game-programmer's implementation
pick (both are free-tier managed Postgres, functionally equivalent for ~4 plain-SQL
tables), not a design decision waiting on the CEO.

---

## Phase 1 — Backend foundation: DB + auth (NEW, do this first)

| # | Task | Owner | Depends on |
|---|---|---|---|
| 1.1 | Stand up `server/` Node project scaffold + provision Postgres (Neon or Supabase, programmer's pick, free tier). Plain SQL via a `pg` client, no ORM per the infra decision. | game-programmer | — |
| 1.2 | Define and migrate schema: `accounts` (id, email unique, password_hash, display_name, created_at), `sessions` (token, account_id, expires_at), `decks` (id, account_id, slot 1–3, name, card list/counts, updated_at), `match_history` (id, account_id, opponent_display_name snapshot, result enum win/loss/win_forfeit, date). Field semantics per spec §4–§6.5. | game-programmer | 1.1 |
| 1.3 | Auth endpoints: `POST /signup` (email format + server-side dup check, password ≥8 chars + confirm-match, display name 2–16 chars, argon2id/bcrypt hashing, opaque session token in an HttpOnly cookie, auto-login on success — spec §4.1), `POST /login` (single unified error message, no account-existence leak — spec §4.2), `POST /logout`, session-validation middleware for all authenticated routes. | game-programmer | 1.2 |
| 1.4 | New-account seeding: account creation also inserts the exact 24-card starter deck (spec §5.4 table) into slot 1; slots 2/3 start empty. | game-programmer | 1.2, 1.3 |
| 1.5 | Smoke-test auth endpoints directly (no UI needed yet): signup/login/logout, duplicate-email rejection, wrong-password unified message, session cookie persists across requests. Catches backend bugs before a UI can mask them. | qa-tester | 1.3 |

Nothing in this phase depends on Phase 0's old items — start immediately.

---

## Phase 2 — Relay server + state-engine groundwork

| # | Task | Owner | Depends on |
|---|---|---|---|
| 2.1 | Relay server skeleton: plain `ws` on Node in `server/` (pure message relay — create room, generate code, forward JSON between the two sockets, no game rules). | game-programmer | — |
| 2.2 | Wire protocol: room-create/join, action-relay (play card/target/end turn), `turn_started` (server-stamped deadline)/`turn_timeout` (server-fired) per spec §7.3, disconnect/reconnect/forfeit messages per spec §8, match-end/result-report messages. | game-programmer | 2.1 |
| 2.3 | **WS connection auth**: on room join, validate the session token (from 1.3) server-side before admitting the connection, so display names are server-verified, not client-claimed. New requirement this update adds. | game-programmer | 1.3, 2.1 |
| 2.4 | Audit/restructure `js/state.js`: `state.enemy` (scripted-pattern shape) → mirrored player state; `runEnemyTurn()` → apply-remote-action; confirm RNG stays client-authoritative per player (each client shuffles/draws its own deck locally, never syncs opponent deck contents) — this was a v1 recommendation, now written directly into spec §6.3 step 2, so it's settled, not still a judgment call. | game-programmer | — |
| 2.5 | Server-side turn-timer enforcement (24s): server stamps `turn_started` with a deadline and is the one that fires `turn_timeout`, forcing the timed-out player's turn to end exactly per spec §7.3 (cancel unresolved selected card, discard remaining hand, reset mana next turn). | game-programmer | 2.2, 2.4 |
| 2.6 | Server writes match results to `match_history` at match end — trusts the client's win/loss report (optionally cross-checking both clients agree), no server-side game-rule validation. Deliberate scope boundary, same spirit as the RNG-authority call. | game-programmer | 1.2, 2.2 |
| 2.7 | Disconnect/forfeit server logic: 45s grace timer that pauses the turn timer (§8.2), 10s floor before "claim forfeit win" is enabled, auto-forfeit at 45s, result written via 2.6. | game-programmer | 2.5, 2.6 |

2.1 and 2.4 have no dependencies and can start immediately, in parallel with Phase 1.
2.3/2.5–2.7 need Phase 1's auth/DB pieces.

---

## Phase 3 — Deck management (now persistence-backed, not client-only)

| # | Task | Owner | Depends on |
|---|---|---|---|
| 3.1 | Deck slot list screen logic: fetch the account's 3 slots, render filled/empty tile states, valid/"미완성" badge (20–30 cards), delete-with-confirm. Per spec §5.4. | game-programmer | 1.2, 1.3 |
| 3.2 | Deck editor screen logic: full 14-card pool grid always open, add/remove cards, live-save-per-click (no save/undo button — every click persists immediately per spec §5.5), enforce 20–30 total / max 3 copies per card by disabling rather than rejecting. | game-programmer | 3.1 |
| 3.3 | Deck slot list + editor visuals: reuse the existing 132×184 card frame (`art-direction.md` §3), new "미완성" badge, pool-grid vs. deck-list layout distinction. Spec §5.4–§5.5, flagged as art debt in §9. Spec is locked — can start now, doesn't need to wait on 3.1/3.2. | pixel-artist | — |
| 3.4 | Verify deck rules are enforced (20–30 range, max 3 copies, UI blocks rather than silently rejecting) and that slot edits persist across logout/login and across a different browser/device. | qa-tester | 3.2 |

---

## Phase 4 — PvP client integration (match flow)

| # | Task | Owner | Depends on |
|---|---|---|---|
| 4.1 | Login/signup screen logic: client-side email format + password length/confirm-match validation, inline errors matching spec §4.1–§4.2 exact copy, auto-login on signup success. | game-programmer | 1.3 |
| 4.2 | Login/signup screen visuals — brand-new screen type for this project. Spec §9 art debt. Can start now. | pixel-artist | — |
| 4.3 | Main menu rework: 덱 관리 / 전적 / 플레이 buttons + display name + always-visible logout (never shown mid-battle, per spec §4.2). Replaces the old single "Begin Run" entry. | game-programmer | 4.1 |
| 4.4 | Deck-select-before-lobby screen: only valid (20–30 card) slots selectable; "플레이" disabled at the main-menu level if zero valid decks exist. Spec §6.1. | game-programmer | 3.1, 4.3 |
| 4.5 | Lobby UI: create/join room, room code display/copy, opponent display name reveal on connect (server-verified via 2.3, not client-claimed). Spec §6.2. | game-programmer | 2.1, 2.3, 4.4 |
| 4.6 | Match start sequence: coin-flip first player, local shuffle, first player draws 5 / second player draws 6. Spec §6.3. | game-programmer | 2.4, 4.5 |
| 4.7 | **Battle screen integration** — opponent panel (HP/mana/block/deck+discard counts/display name; hand shown as count-only, cards revealed only when played), strict turn alternation over the network, 24s timer UI reflecting the server-stamped deadline (not a client-computed one), disconnect overlay + "claim forfeit win" gated at the 10s floor. Spec §7, §8. **This is the long pole of the whole milestone**, same as v1's assessment. | game-programmer | 2.4–2.7, 4.6 |
| 4.8 | Match-end screen + trigger: win/loss/win_forfeit text variants (spec §6.4), "다시 플레이"/"메인 메뉴" buttons, triggers 2.6's match-history write. | game-programmer | 4.7, 2.6 |
| 4.9 | Battle-screen visuals: new opponent player-panel layout (replacing the old scripted-enemy portrait/intent-badge layout, which no longer applies), card-back design (never existed before), 10s-or-under timer pulse (reuse `art-direction.md` §7 pattern). Spec §9. Can start now. | pixel-artist | — |
| 4.10 | Lobby/room-code/waiting-screen visuals, "opponent connection lost" overlay banner (§8.2). Can start now. | pixel-artist | — |

---

## Phase 5 — Match history screen

| # | Task | Owner | Depends on |
|---|---|---|---|
| 5.1 | Match history screen: fetch + render up to 100 most recent matches (opponent name snapshot, result incl. "승(기권)" distinction, `YYYY-MM-DD` date), derived win/loss count header, empty state. Spec §6.5. | game-programmer | 1.2, 2.6, 4.3 |
| 5.2 | Match history screen visuals: count header + list layout. Spec §9 art debt. Can start now. | pixel-artist | — |
| 5.3 | Verify match history accuracy: win/loss/win_forfeit correctly recorded and labeled, 100-match cap behaves, header count matches list contents, both accounts' histories update after a match. | qa-tester | 5.1 |

---

## Phase 6 — QA (cross-cutting regression)

| # | Task | Owner | Depends on |
|---|---|---|---|
| 6.1 | Auth + persistence regression: signup/login/logout edge cases, deck-slot persistence across sessions/devices, starter-deck-on-new-account correctness (exact 24-card list, spec §5.4). Consolidates 1.5 + 3.4 into one pass before final sign-off. | qa-tester | 1.5, 3.4 |
| 6.2 | Two-client PvP regression — still the first time this project needs two simulated clients (two windows/devices); plan the test setup explicitly. Verify no hand/deck/HP/mana desync across a full match. | qa-tester | 4.7 |
| 6.3 | **Turn-timer correctness, specifically server-side**: confirm the server (not the client) actually enforces the 24s timeout — e.g. a client with a frozen/wrong local clock should still get timed out correctly. This is the entire reason server-enforcement was chosen over v1's non-authoritative approach; worth a dedicated check. | qa-tester | 4.7 |
| 6.4 | Disconnect/forfeit flow: 45s auto-forfeit, 10s floor on the claim-forfeit button, turn timer correctly pauses and resumes across a disconnect. | qa-tester | 4.7 |
| 6.5 | Write consolidated findings to `docs/qa/` — **first QA report in this repo**, establish the naming convention (kebab-case, feature-scoped) other QA work will follow. | qa-tester | 6.1–6.4, 5.3 |

---

## Suggested execution order

1. **Phase 1 (backend foundation)** — start immediately, no dependencies. This is the new
   critical path: deck persistence, match history, and WS connection auth all sit
   downstream of it.
2. **Phase 2.1/2.4 (relay skeleton + state-engine audit)** — start immediately in
   parallel with Phase 1, no dependency on it.
3. **Phase 3.3, 4.2, 4.9, 4.10, 5.2 (art)** — start immediately in parallel; spec is
   locked, none of it needs backend or programmer work to begin.
4. **Phase 2.2–2.3, 2.5–2.7** — once Phase 1's auth/DB pieces land.
5. **Phase 3.1–3.2 (deck persistence)** — once Phase 1 lands.
6. **Phase 4** — once Phase 2 and 3 land; 4.7 (battle screen) is the long pole, same as
   v1 — get it working with minimal polish before investing in lobby/timer visuals.
7. **Phase 5** — once 2.6 is writing real match results and 4.3 exists to link to it.
8. **Phase 6** — after Phase 4 has something to test end-to-end; 6.1 can start earlier,
   right after Phase 1 + 3 ship, in parallel with Phase 4 work.
