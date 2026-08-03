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
    el.btnHowtoClose = document.getElementById('btn-howto-close');
  }

  function showMainMenu(acct) {
    account = acct;
    el.menuDisplayName.textContent = acct.displayName;
    Screens.show('screen-main-menu');
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
    el.btnLogout.addEventListener('click', handleLogout);
    el.btnMenuDeck.addEventListener('click', () => Deck.showSlots());
    // 전적 (#btn-menu-history) and 플레이 (#btn-menu-play) are disabled
    // "곧 제공" stub buttons in index.html for this session -- 전적 is
    // Phase 5 (match history screen), 플레이's real target (deck-select ->
    // lobby, spec §6.1-§6.2) is Phase 4.4+. Both are disabled rather than
    // routed to a placeholder screen (simpler, and the inline "곧 제공"
    // badge + title tooltip already makes the "not yet" state visible
    // rather than a silent dead click) -- nothing to wire for either.
    el.btnHowtoClose.addEventListener('click', closeHowto);
    checkSession();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  UI.init();
  Deck.init();
  App.init();

  // The "?" button only appears mid-battle (ui.js hides it otherwise) --
  // opens How to Play via AL's own state machine so it can return to
  // whatever battle screen was behind it, per docs/design/onboarding.md.
  document.getElementById('btn-howto').addEventListener('click', () => AL.openHowto());
  document.getElementById('btn-end-turn').addEventListener('click', () => AL.endTurn());
  document.getElementById('btn-restart-victory').addEventListener('click', () => AL.startMatch());
  document.getElementById('btn-restart-defeat').addEventListener('click', () => AL.startMatch());

  // NOTE (online-pvp-plan.md task 2.4): AL.startMatch() with no args is a
  // TEMPORARY local-battle-engine smoke-test path only (local coin flip,
  // STARTER_DECK for both sides -- see js/state.js's startMatch doc
  // comment). It is intentionally not wired to any menu button as of this
  // task: Phase 4.3 replaced the old single "Begin Run" entry point with
  // the real main menu above, and the real match flow (deck select -> lobby
  // -> battle, spec §6.1-§6.3) is Phase 4.4-4.7, not yet built. Still
  // reachable from a devtools console (`AL.startMatch()`) for engine-only
  // testing until that flow exists -- the victory/defeat restart buttons
  // wired just above call back into it for that same reason.

  // Initial paint of AL's own screens (state.screen defaults to 'start',
  // which no longer has a matching element -- this just hides every
  // .screen node harmlessly until App.init()'s session check above decides
  // whether to show the login screen or the main menu).
  UI.render(AL.state);
});
