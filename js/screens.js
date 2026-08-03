/* ARCANE LEDGER — single shared screen-visibility helper (plan.md 4.1/4.3).
 *
 * Before this task there were TWO independent "show one full-viewport
 * screen, hide the rest" implementations: ui.js's showScreen() only knew
 * about the 5 AL-driven screens (start/howto/battle/victory/defeat) and
 * left every other `.screen` node's hidden state untouched, while deck.js
 * had its own private showAppScreen() that correctly hid *every* `.screen`
 * node by id. That split was harmless while deck management was the only
 * non-AL screen reachable (nothing else could possibly be visible at the
 * same time), but this task adds THREE more independently-owned screens
 * (login, main menu, and the how-to-play screen's new pre-login entry
 * point) that all need to coexist correctly with both AL's screens and
 * deck.js's screens. A single shared helper is the minimum fix that keeps
 * "exactly one .screen visible at a time" true everywhere, so it now lives
 * here instead of being duplicated a third time.
 */
const Screens = (() => {
  function show(id) {
    document.querySelectorAll('.screen').forEach((node) => {
      node.classList.toggle('hidden', node.id !== id);
    });
  }
  return { show };
})();
