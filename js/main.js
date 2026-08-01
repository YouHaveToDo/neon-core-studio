/* ARCANE LEDGER — entry point. Wires buttons, boots the UI.
 *
 * NOTE (online-pvp-plan.md task 2.4): AL.startMatch() below with no lobby/
 * deck-select/network args is a TEMPORARY local smoke-test path only — it
 * defaults to a local coin flip and the same STARTER_DECK for both sides
 * (see js/state.js's startMatch doc comment). Real matches will go through
 * login -> deck select -> lobby (Phases 1, 3, 4) before ever calling this,
 * and the opponent side will only ever act via AL.applyRemoteAction() fed
 * by the relay (Phase 2.1-2.3), not by anything in this file.
 */

document.addEventListener('DOMContentLoaded', () => {
  UI.init();

  document.getElementById('btn-begin').addEventListener('click', () => AL.startMatch());
  document.getElementById('btn-howto').addEventListener('click', () => AL.openHowto());
  document.getElementById('btn-howto-close').addEventListener('click', () => AL.closeHowto());
  document.getElementById('btn-end-turn').addEventListener('click', () => AL.endTurn());
  document.getElementById('btn-restart-victory').addEventListener('click', () => AL.startMatch());
  document.getElementById('btn-restart-defeat').addEventListener('click', () => AL.startMatch());

  // Initial paint of the start screen (AL.state.screen === 'start').
  UI.render(AL.state);
});
