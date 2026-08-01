# ARCANE LEDGER — Platform Expansion (Steam + iOS/Android) Task Breakdown

CEO decision: keep the existing plain HTML/CSS/JS codebase as-is; wrap it. Steam via a
desktop shell, mobile via Capacitor. No engine rewrite, no build tooling introduced into
the game code itself — agents keep authoring `index.html` / `css/` / `js/` as plain text
and verifying in-browser, same as today.

## Scope check first

This is three shipping targets (Steam, iOS, Android) plus store submission, on top of a
game that is currently a single-combat vertical slice with no save/resume, no options
menu, no store-page assets, and no build tooling at all in the repo (confirmed: no
`package.json`). Doing all three simultaneously in one milestone is too big.

**Recommended cut for this milestone:** ship Steam (Electron) first — one platform, one
review process (none, actually — no cert gate), fastest feedback loop. Stand up the
Capacitor mobile shell in parallel at the config/skeleton level (Phase 3 below) so it's
proven early, but treat actual App Store / Play Store submission (signing, store
listings, review) as the *next* milestone once Steam ships and the wrapper pattern is
validated. iOS App Review in particular can bounce a build for reasons unrelated to code
readiness (metadata, screenshots, age rating) — don't couple that risk to the Steam
launch date.

Engine-wrapper recommendation: **Electron, not Tauri**, for this milestone. Reasoning to
confirm with CEO: Electron bundles Chromium, so the game runs in the same rendering
engine the team has been building/QA-ing against in-browser — behavior parity is closer
to guaranteed. Tauri renders through the OS-native WebView (WebKit on macOS, WebView2 on
Windows), which can diverge from Chromium in CSS/animation edge cases and would need a
second QA pass per OS. Tauri also requires a Rust toolchain the team has no code in
today. Tauri's smaller binary size isn't a priority at this stage. Revisit Tauri later
only if installer size becomes a real complaint.

Steamworks integration (achievements, cloud saves, Steam overlay) is explicitly **not**
in this milestone — that's a separate later task once a plain installer is running.

---

## Phase 0 — Design decisions (blocking, do first)

| # | Task | Owner |
|---|---|---|
| 0.1 | Decide: does mobile need a distinct layout spec, or do the existing responsive breakpoints (already down to 400px in `css/style.css`) cover it? Current CSS has no `.card:hover`-dependent functionality (hover is a bonus lift effect, not required for play), so touch should already work functionally — but touch *target sizes* need an explicit pass (see 0.2). | game-designer |
| 0.2 | Audit + spec minimum touch target sizes for mobile: `.btn-howto` is currently 24×24px (below the ~44×44pt Apple HIG / Material 48dp minimum). Produce updated sizing for the how-to button and any other sub-40px tappable element, as an addendum to `docs/design/art-direction.md`, not a new mobile-only UI. | game-designer |
| 0.3 | Decide run-persistence behavior for mobile: mobile OSes can suspend/kill a backgrounded app mid-run. Does a killed run need to resume, or is "run is lost, start over" acceptable for this milestone (matches current no-save-at-all behavior)? This is a scope/product call, not something to guess into code. | game-designer + CEO input (see Open Questions) |
| 0.4 | Confirm iOS safe-area handling requirement (notch / home indicator): spec whether the topbar/hand-row need `env(safe-area-inset-*)` padding, or whether centered-layout-with-margin already absorbs it. | game-designer |

Phase 0 can run in parallel with Phase 1 setup tasks (1.1–1.3 below don't depend on it),
but 0.2–0.4 must land before the corresponding programmer/artist polish tasks in Phase 4.

---

## Phase 1 — Web app readiness (no wrapper yet)

Everything here is auditing/fixing the existing web app so it's wrap-ready. Small,
concrete, no rewrite.

| # | Task | Owner | Depends on |
|---|---|---|---|
| 1.1 | Audit `index.html`/`css/`/`js/` for browser-only assumptions: confirmed clean so far — relative paths throughout (`css/style.css`, `js/*.js`), icon sprite already inlined specifically to survive `file://` load (see `index.html` comment), `100dvh` used for mobile viewport height, `overscroll-behavior: none` and `user-scalable=no` already set. No `localStorage`/cookies/`window.open`/absolute-URL usage found in `js/state.js`, `js/ui.js`, `js/main.js`. **Task is to re-verify this holds** once Phase 0 changes land, not to redo the audit from scratch. | game-programmer | — |
| 1.2 | Add `touch-action: manipulation` (or targeted equivalent) to interactive elements to kill the mobile 300ms tap delay on cards/buttons — currently relying only on the viewport meta tag. | game-programmer | — |
| 1.3 | Implement the touch target sizing and safe-area CSS changes specified in 0.2/0.4. | game-programmer | 0.2, 0.4 |
| 1.4 | Verify desktop window resize behavior: current CSS has responsive rules *down* to 400px width but nothing verified at typical desktop windowed sizes (e.g. 1024×768 up to 1920×1080) or ultrawide/very-short windows. Not a mobile concern — this is Steam-window-specific. Adjust `#app`/`.screen` max-width or centering if the layout looks sparse/broken at large widths. | game-programmer | — |

1.1–1.4 can run in parallel with each other and with Phase 0.

---

## Phase 2 — Steam / Electron wrapper (setup only, first shippable target)

| # | Task | Owner | Depends on |
|---|---|---|---|
| 2.1 | Scaffold `package.json` + `electron/main.js` (new folder, kept separate from `js/` so Node-context main-process code is never confused with browser-context game code loaded via `<script>` tags). Point Electron's `BrowserWindow` at the existing `index.html` unmodified. | game-programmer | — |
| 2.2 | Configure sane Electron window defaults: resizable, reasonable min-width/min-height (derive from 1.4's findings so the layout never renders below its usable floor), disable the default menu bar (or trim it to just Quit), disable pinch-zoom and right-click context menu, disable text selection/drag on game chrome. | game-programmer | 1.4, 2.1 |
| 2.3 | Add `electron-builder` (or equivalent) config for a Windows/macOS installer build. Placeholder app icon is fine for now — final icon comes from 2.4. | game-programmer | 2.1 |
| 2.4 | Produce app icon (all required sizes: .ico for Windows, .icns for macOS) and any Steam store-page capsule art, in the team's existing SVG/procedural style — reuse `assets/icons.svg` motifs (crown/skull) rather than inventing new art direction. | pixel-artist | — (parallel with 2.1–2.3) |
| 2.5 | Manual smoke test: launch the Electron build, play one full combat + reward + rest loop, confirm no console errors, confirm window resize doesn't break layout. | qa-tester | 2.1, 2.2 |

---

## Phase 3 — Mobile / Capacitor wrapper (skeleton this milestone, submission next milestone)

| # | Task | Owner | Depends on |
|---|---|---|---|
| 3.1 | Scaffold Capacitor config (`capacitor.config.json`) pointing `webDir` at the existing web root (or a synced copy — decide based on whether Capacitor's asset-copy step tolerates the repo's flat structure without a build step). Add `ios`/`android` platform folders via `npx cap add`. | game-programmer | — |
| 3.2 | Verify the inlined-icon-sprite approach (already solved for `file://` per the `index.html` comment) also resolves correctly under Capacitor's local web server scheme (`capacitor://` / `https://localhost`) — should just work since it's inline, but confirm, don't assume. | game-programmer | 3.1 |
| 3.3 | Apply the touch target + safe-area fixes from Phase 1/0 and confirm they render correctly in the Capacitor iOS/Android simulators specifically (simulator webview can differ subtly from desktop browser dev tools mobile emulation). | qa-tester | 1.3, 3.1 |
| 3.4 | Produce app icon set (iOS/Android required sizes) + launch splash screen, same style constraint as 2.4. | pixel-artist | — (parallel with 3.1–3.3) |
| 3.5 | **Explicitly out of scope for this milestone:** Apple Developer / Google Play account setup, code signing, store listing copy/screenshots, age rating questionnaires, TestFlight/internal-testing rollout. Flagged here so it isn't silently dropped — pick up as its own milestone once 3.1–3.4 prove the shell works. | — | flag only |

---

## Phase 4 — Cross-platform QA (after Phase 2, and after Phase 3 skeleton exists)

| # | Task | Owner | Depends on |
|---|---|---|---|
| 4.1 | Full regression of the existing vertical-slice combat loop (start → howto → battle → reward/rest → victory/defeat) inside the Electron build specifically — confirm nothing in `js/state.js`/`js/ui.js` assumed browser chrome (address bar, tab focus events, etc.) that Electron's frameless/windowed context changes. | qa-tester | Phase 2 |
| 4.2 | Input-method regression: mouse hover/click on desktop (Electron) vs. tap on mobile (Capacitor simulator) — confirm card selection, enemy targeting, and the "selected but not yet targeted" state all work with tap-only input (no hover fallback needed, since play already doesn't depend on hover per 0.1). | qa-tester | Phase 2, 3.1–3.3 |
| 4.3 | Window/viewport regression: Electron resizing (per 1.4/2.2) and mobile safe-area/orientation (per 0.4/1.3) — file bugs to game-programmer for anything broken, same as the existing QA report workflow. | qa-tester | 4.1 |
| 4.4 | Write findings to `docs/qa/` per the existing convention once there's a build to test against (no QA reports exist yet in this repo — this will be the first). | qa-tester | 4.1–4.3 |

---

## Open questions / blockers for CEO (not mine or any agent's to guess)

1. **Phasing approval**: does "Steam first, mobile skeleton in parallel, mobile
   submission as a follow-up milestone" match the revenue timeline you have in mind, or
   is simultaneous iOS/Android/Steam launch a hard requirement? This changes Phase
   3.5's priority significantly.
2. **Run persistence on mobile** (item 0.3): acceptable to lose an in-progress run if the
   OS kills the backgrounded app, or does that need to become a real feature (save
   state to disk) before mobile ships? This is scope-defining, not a detail.
3. **Steamworks features** (achievements/cloud save/overlay): confirmed out of scope for
   this milestone — flag if that's wrong.
4. **Platform accounts**: an Apple Developer Program membership ($99/yr) and a Google
   Play Console account (one-time $25) are prerequisites for even internal testing on
   real devices/TestFlight, separate from code work — these need to be started now if
   Phase 3.5 is expected to move quickly later, since Apple's review/enrollment can take
   days.

---

## Suggested execution order

1. Phase 0 (design decisions) — start immediately, short.
2. Phase 1 (web readiness) — parallel with Phase 0 where it doesn't depend on it (1.1,
   1.2, 1.4); 1.3 waits on 0.2/0.4.
3. Phase 2 (Electron/Steam) — start once 1.4 lands; 2.4 (art) can start immediately in
   parallel.
4. Phase 3 (Capacitor skeleton) — can start in parallel with Phase 2 once Phase 1 is
   done; 3.4 (art) in parallel.
5. Phase 4 (QA) — after Phase 2 fully, and after Phase 3.1–3.3 for the mobile-specific
   checks.
