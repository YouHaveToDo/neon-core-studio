/* ARCANE LEDGER — entry point + main menu + app-level auth gating.
 * (online-pvp-plan.md 4.1/4.3, spec-online-pvp.md §4)
 *
 * Per spec §4.3 there is no guest mode: on load this checks the session
 * (GET /api/auth/me) and shows either the login screen (js/auth.js) or the
 * main menu below -- nothing else is reachable until that resolves, except
 * How to Play, spec's one explicit pre-login exception.
 */

const App = (() => {
  const el = {};
  let account = null;
  // True while screen-howto was opened from the pre-login auth screen
  // (spec §4.3's "플레이 방법 보기" link) rather than from AL's own
  // mid-battle "?" button. Determines what closing it returns to -- see
  // closeHowto() below. AL.state is never touched on the pre-login path;
  // there is no match in progress for AL to track.
  let howtoOpenedFromLogin = false;

  function cache() {
    el.menuDisplayName = document.getElementById('main-menu-display-name');
    el.menuInkAmount = document.getElementById('main-menu-ink-amount');
    el.btnLogout = document.getElementById('btn-logout');
    el.btnMenuDeck = document.getElementById('btn-menu-deck');
    el.btnMenuShop = document.getElementById('btn-menu-shop');
    el.btnMenuHistory = document.getElementById('btn-menu-history');
    el.btnMenuPlay = document.getElementById('btn-menu-play');
    el.playGateHint = document.getElementById('play-gate-hint');
    el.btnPlayGateDeck = document.getElementById('btn-play-gate-deck');
    el.btnHowtoClose = document.getElementById('btn-howto-close');
  }

  // spec §6.1: "플레이" is disabled at the MAIN MENU level (not just gated
  // inside the deck-select screen) if the account has zero valid (20-30
  // card) deck slots -- refreshed every time the main menu is (re)shown,
  // since deck edits made in the meantime (js/deck.js) can flip this.
  async function refreshPlayGate() {
    try {
      const data = await API.decks.list();
      const hasValidDeck = data.slots.some((deck) => deck && deck.valid);
      el.btnMenuPlay.disabled = !hasValidDeck;
      el.playGateHint.classList.toggle('hidden', hasValidDeck);
    } catch (err) {
      // Network/session hiccup -- default to disabled rather than letting a
      // player into a flow that will just fail downstream.
      el.btnMenuPlay.disabled = true;
      el.playGateHint.classList.add('hidden');
    }
  }

  // docs/design/card-shop-currency-proposal.md §5/§7: main-menu Ink display,
  // refreshed on the same "every time the main menu is (re)shown" schedule
  // as refreshPlayGate() above -- a match's Ink award or a shop pull can
  // both change this while the player was on a different screen, so it must
  // re-fetch on return, not just once right after login.
  async function refreshInkBalance() {
    try {
      const data = await API.economy.get();
      el.menuInkAmount.textContent = String(data.inkBalance);
    } catch (err) {
      // Network/session hiccup -- leave whatever was last shown rather than
      // blocking the menu over a non-critical display value.
    }
  }

  function showMainMenu(acct) {
    account = acct;
    el.menuDisplayName.textContent = acct.displayName;
    Screens.show('screen-main-menu');
    refreshPlayGate();
    refreshInkBalance();
  }

  // Shared re-entry point for every "메인 메뉴로 돌아가기" action elsewhere in
  // the app (deck management's 뒤로, match flow's 뒤로, shop's 뒤로) so the
  // play-gate check + Ink balance above always rerun rather than only firing
  // right after login.
  function returnToMainMenu() {
    Screens.show('screen-main-menu');
    refreshPlayGate();
    refreshInkBalance();
  }

  async function handleLogout() {
    el.btnLogout.disabled = true;
    try {
      await API.auth.logout();
    } catch (err) {
      // Logout has no user-correctable failure mode (it's just "delete my
      // own session"). If the request itself fails (e.g. offline), still
      // drop to the login screen locally rather than trapping the player
      // behind a button that does nothing -- a stale server-side session
      // with no client using it is harmless, and the next authenticated
      // request would 401 anyway.
    }
    account = null;
    el.btnLogout.disabled = false;
    Auth.show();
  }

  // spec §4.3: How to Play is reachable before login. Bypasses AL entirely
  // (see field doc comment) -- just shows the same screen-howto markup
  // AL's mid-battle path uses, populating the demo card directly since
  // AL's own render pipeline never runs here.
  function openHowtoFromLogin() {
    howtoOpenedFromLogin = true;
    el.btnHowtoClose.textContent = '닫기';
    UI.ensureHowtoDemoCard();
    Screens.show('screen-howto');
  }

  // Single close handler for BOTH entry points (pre-login link and AL's
  // mid-battle "?" button), since they land on the exact same
  // #screen-howto markup and only differ in what "closing" should return
  // to.
  function closeHowto() {
    if (howtoOpenedFromLogin) {
      howtoOpenedFromLogin = false;
      Auth.show();
    } else {
      AL.closeHowto();
    }
  }

  // spec §4.2: "로그인 성공 후에는 로그아웃 전까지 별도 재인증 없이 ... 접근
  // 가능해야 한다" -- an existing session cookie must be honored on a fresh
  // page load (e.g. a reload), not just right after a login/signup call.
  async function checkSession() {
    try {
      const result = await API.auth.me();
      showMainMenu(result.account);
    } catch (err) {
      Auth.show();
    }
  }

  function init() {
    cache();
    Auth.init({ onAuthenticated: showMainMenu, onShowHowto: openHowtoFromLogin });
    Match.init();
    el.btnLogout.addEventListener('click', handleLogout);
    el.btnMenuDeck.addEventListener('click', () => Deck.showSlots());
    // 상점 (docs/design/card-shop-currency-proposal.md §6-§7, Phase 6/7) is
    // now real: js/shop.js.
    el.btnMenuShop.addEventListener('click', () => Shop.show());
    // 플레이 (plan.md 4.4-4.6, spec §6.1-§6.3) is now real: deck-select ->
    // lobby -> match start, js/match.js. Disabled state + hint text is
    // driven by refreshPlayGate() above, not a static "곧 제공" stub anymore.
    el.btnMenuPlay.addEventListener('click', () => Match.showDeckSelect(account));
    el.btnPlayGateDeck.addEventListener('click', () => Deck.showSlots());
    // 전적 (plan.md 5.1, spec §6.5) is now real: js/history.js.
    el.btnMenuHistory.addEventListener('click', () => History.show());
    el.btnHowtoClose.addEventListener('click', closeHowto);
    checkSession();
  }

  return { init, returnToMainMenu };
})();

document.addEventListener('DOMContentLoaded', () => {
  UI.init();
  Deck.init();
  History.init();
  Shop.init();
  Battle.init();
  Practice.init();
  App.init();

  // The "?" button only appears mid-battle (ui.js hides it otherwise) --
  // opens How to Play via AL's own state machine so it can return to
  // whatever battle screen was behind it, per docs/design/onboarding.md.
  document.getElementById('btn-howto').addEventListener('click', () => AL.openHowto());
  // #btn-end-turn's real click handler (AL.endTurn() + the relay's end_turn
  // message) is wired inside Battle.init() instead -- js/battle.js is the
  // module that actually knows when a manual end-turn also needs a network
  // side effect (plan.md 4.7, spec §7.3).

  // Match-end buttons (plan.md 4.8, spec §6.4): "다시 플레이" returns to the
  // deck-select screen to start a genuinely fresh match (§6.1) -- spec never
  // asks for a "rematch this exact opponent" shortcut, just "다시 플레이 →
  // 덱 선택 화면으로 복귀". "메인 메뉴" returns to the post-login landing
  // screen. Both first reset js/battle.js's per-match timers/overlay state
  // (and, defensively, js/practice.js's -- harmless no-op whenever the match
  // that just ended wasn't a practice one) so nothing from the just-finished
  // match leaks into the next one.
  function playAgain() { Battle.reset(); Practice.stop(); Match.playAgain(); }
  // "메인 메뉴" is the SAME button/handler for both a real-PvP and a
  // practice match end (docs/design/practice-mode-proposal.md §7.4's third
  // button) -- App.returnToMainMenu() already re-fetches the Ink balance
  // (refreshInkBalance(), see js/main.js above) every time it's called, so a
  // practice match's Ink award is reflected on the main menu with no
  // separate wiring needed here.
  function backToMainMenu() { Battle.reset(); Practice.stop(); App.returnToMainMenu(); }
  document.getElementById('btn-restart-victory').addEventListener('click', playAgain);
  document.getElementById('btn-restart-defeat').addEventListener('click', playAgain);
  document.getElementById('btn-mainmenu-victory').addEventListener('click', backToMainMenu);
  document.getElementById('btn-mainmenu-defeat').addEventListener('click', backToMainMenu);

  // Practice-mode-only match-end buttons (docs/design/practice-mode-
  // proposal.md §7.4) -- only ever visible when js/practice.js's own
  // handlePracticeMatchEnd() showed them for a practice match that just
  // ended (see that file). "다시 연습하기" restarts immediately with the
  // same mirrored deck (Practice.restart(), no deck-select/lobby detour);
  // "로비로 돌아가기" re-enters the room list directly (Match.returnToLobby(),
  // skipping deck-select same as "다시 연습하기" skips it) in case a real
  // opponent has opened a room in the meantime.
  function practiceAgain() { Battle.reset(); Practice.restart(); }
  function practiceReturnToLobby() { Battle.reset(); Practice.stop(); Match.returnToLobby(); }
  document.getElementById('btn-practice-again-victory').addEventListener('click', practiceAgain);
  document.getElementById('btn-practice-again-defeat').addEventListener('click', practiceAgain);
  document.getElementById('btn-practice-lobby-victory').addEventListener('click', practiceReturnToLobby);
  document.getElementById('btn-practice-lobby-defeat').addEventListener('click', practiceReturnToLobby);

  // Initial paint of AL's own screens (state.screen defaults to 'start',
  // which no longer has a matching element -- this just hides every
  // .screen node harmlessly until App.init()'s session check above decides
  // whether to show the login screen or the main menu).
  UI.render(AL.state);
});
