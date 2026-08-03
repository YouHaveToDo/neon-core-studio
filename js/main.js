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
    el.btnLogout = document.getElementById('btn-logout');
    el.btnMenuDeck = document.getElementById('btn-menu-deck');
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

  function showMainMenu(acct) {
    account = acct;
    el.menuDisplayName.textContent = acct.displayName;
    Screens.show('screen-main-menu');
    refreshPlayGate();
  }

  // Shared re-entry point for every "메인 메뉴로 돌아가기" action elsewhere in
  // the app (deck management's 뒤로, match flow's 뒤로) so the play-gate
  // check above always reruns rather than only firing right after login.
  function returnToMainMenu() {
    Screens.show('screen-main-menu');
    refreshPlayGate();
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
    // 플레이 (plan.md 4.4-4.6, spec §6.1-§6.3) is now real: deck-select ->
    // lobby -> match start, js/match.js. Disabled state + hint text is
    // driven by refreshPlayGate() above, not a static "곧 제공" stub anymore.
    el.btnMenuPlay.addEventListener('click', () => Match.showDeckSelect(account));
    el.btnPlayGateDeck.addEventListener('click', () => Deck.showSlots());
    // 전적 (#btn-menu-history) is still a disabled "곧 제공" stub -- Phase 5
    // (match history screen), not in this session's scope.
    el.btnHowtoClose.addEventListener('click', closeHowto);
    checkSession();
  }

  return { init, returnToMainMenu };
})();

document.addEventListener('DOMContentLoaded', () => {
  UI.init();
  Deck.init();
  Battle.init();
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
  // so nothing from the just-finished match leaks into the next one.
  function playAgain() { Battle.reset(); Match.playAgain(); }
  function backToMainMenu() { Battle.reset(); App.returnToMainMenu(); }
  document.getElementById('btn-restart-victory').addEventListener('click', playAgain);
  document.getElementById('btn-restart-defeat').addEventListener('click', playAgain);
  document.getElementById('btn-mainmenu-victory').addEventListener('click', backToMainMenu);
  document.getElementById('btn-mainmenu-defeat').addEventListener('click', backToMainMenu);

  // Initial paint of AL's own screens (state.screen defaults to 'start',
  // which no longer has a matching element -- this just hides every
  // .screen node harmlessly until App.init()'s session check above decides
  // whether to show the login screen or the main menu).
  UI.render(AL.state);
});
