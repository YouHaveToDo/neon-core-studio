/* ARCANE LEDGER — the network<->engine glue for an in-progress PvP match
 * (online-pvp-plan.md task 4.7/4.8, spec-online-pvp.md §7-§8).
 *
 * js/match.js owns everything BEFORE the battle screen exists (deck choice,
 * room code, coin flip) and hands off to AL.startMatch() once a match is
 * confirmed to start. This file picks up from there: it is the ONLY module
 * that both touches js/ws.js's `Net` AND drives js/state.js's `AL` during a
 * live match, so the two stay in lockstep without either of THEM knowing
 * about the other.
 *
 * Two independent signal channels from the relay, per protocol.js's own
 * doc comment, and this file keeps them separate on purpose:
 *   1. `action` messages — opaque passthrough, client-to-client. This is how
 *      one client's local play (card played / turn ended / turn started)
 *      gets mirrored into the other client's `state.opponent`. Wired via
 *      AL.onAction() (outgoing) / AL.applyRemoteAction() (incoming).
 *   2. `turn_started` / `turn_timeout` — server-authoritative, ONLY for the
 *      24s clock (spec §7.3). These never mutate game state directly; they
 *      only drive the timer UI and, on a timeout naming ME, force the exact
 *      same local "cancel selected + discard hand + pass turn" AL.endTurn()
 *      already implements for a manual End Turn click.
 *
 * Turn-boundary bookkeeping (why both an `action` AND a server `end_turn`
 * message go out for a manual End Turn or an auto-ended turn, but only the
 * `action` goes out for a server-forced timeout or this client reconciling to
 * a turn_started broadcast it already received): js/state.js's endTurn()
 * takes a `notifyServer` flag and fires AL.onLocalTurnEnd() only when it's
 * true; see onLocalTurnEndNotify()/onManualEndTurnClick()/handleTurnTimeout()
 * below for which of endTurn()'s 4 callers pass which.
 *
 * Match end (4.8, spec §6.4): AL.onMatchEnd() fires only when THIS client
 * locally detects HP reaching 0 (spec's "즉시 판정" rule) — that's the
 * report_result trigger. The eventual match_ended broadcast (win/loss/
 * win_forfeit, possibly for a match this client never locally detected at
 * all, e.g. a forfeit) is applied via AL.endMatchByResult(), which is a safe
 * no-op-or-catch-up if we already got there ourselves.
 */
const Battle = (() => {
  const el = {};
  let myAccountId = null;
  let started = false;
  let resultReported = false;
  let matchEnded = false;

  // AL.applyRemoteAction() is a silent no-op while state.screen !== 'battle'
  // (js/state.js) -- which is true for a few real-world seconds right after
  // match start, since AL.startMatch() always routes through the "How to
  // Play" overlay first (docs/design/onboarding.md, shown once
  // automatically). If the FIRST player dismisses their own overlay quickly
  // and plays a card before the SECOND player has dismissed theirs, that
  // action would otherwise just vanish -- a real, timing-dependent desync,
  // not a hypothetical one (a player who reads the tutorial slowly is enough
  // to trigger it). Buffer here instead of dropping, flush once this
  // client's own screen reaches 'battle' (see the AL.onChange hookup in
  // init() below).
  let pendingActions = [];

  // ---- turn timer (spec §7.3) ------------------------------------------
  let timerDeadline = null;
  let timerIntervalHandle = null;

  // ---- disconnect / forfeit (spec §8) ------------------------------------
  let disconnectedAt = null;
  let disconnectIntervalHandle = null;

  const DISCONNECT_GRACE_MS = 45000; // spec §8.1 -- display-only; the server is the real authority on the actual auto-forfeit
  const CLAIM_FORFEIT_FLOOR_MS = 10000; // spec §8.2 -- same: just gates the button so the UI doesn't invite a doomed request

  function cache() {
    el.turnTimer = document.getElementById('turn-timer');
    el.turnTimerLabel = document.getElementById('turn-timer-label');
    el.turnTimerValue = document.getElementById('turn-timer-value');
    el.endTurnCol = document.getElementById('end-turn-col');
    el.opponentMetaRow = document.getElementById('opponent-meta-row');
    el.btnEndTurn = document.getElementById('btn-end-turn');

    el.disconnectOverlay = document.getElementById('disconnect-overlay');
    el.disconnectTimerText = document.getElementById('disconnect-timer');
    el.btnClaimForfeit = document.getElementById('btn-claim-forfeit');
    el.claimForfeitHint = document.getElementById('claim-forfeit-hint');
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  // Called by js/match.js right after AL.startMatch() -- accountId is this
  // client's OWN account id (js/match.js already has it from the session),
  // used only to tell turn_timeout/report messages apart ("is this timeout
  // naming ME?"), never sent anywhere itself. initialDeadline is the SAME
  // turn_started.deadline js/match.js just used to decide who goes first --
  // passed explicitly rather than relying on this module's own 'turn_started'
  // listener to catch it, because registration order isn't guaranteed to put
  // js/match.js's handler (which flips `started` true via this call) before
  // this module's own handler for that exact first message; `started` is
  // false until this function runs, so a same-tick handler ordering race
  // would otherwise silently drop turn 1's timer value.
  function start(accountId, initialDeadline) {
    myAccountId = accountId;
    started = true;
    resultReported = false;
    matchEnded = false;
    timerDeadline = initialDeadline || null;
    disconnectedAt = null;
    pendingActions = [];
    hideDisconnectOverlay();
    stopDisconnectInterval();
    ensureTimerInterval();
    renderTimerTick();
  }

  // Called before a fresh match flow begins (다시 플레이 / 메인 메뉴 from the
  // match-end screen, spec §6.4) so no leftover interval/overlay state from
  // the finished match bleeds into the next one.
  function reset() {
    started = false;
    myAccountId = null;
    resultReported = false;
    matchEnded = false;
    timerDeadline = null;
    disconnectedAt = null;
    pendingActions = [];
    stopTimerInterval();
    stopDisconnectInterval();
    hideDisconnectOverlay();
  }

  // ===========================================================================
  // Outgoing: local AL actions -> relay
  // ===========================================================================

  // AL.onAction() fires for exactly the 3 action shapes applyRemoteAction()
  // understands (playCard/endTurn/turnStart) -- see js/state.js's onAction
  // doc comment for which local functions emit each one and why that's
  // always the right moment to broadcast.
  function onLocalAction(type, payload) {
    if (!started || !Net.isConnected()) return;
    Net.send('action', { payload: Object.assign({ type }, payload) });
  }

  // Fires only for a LOCAL win/loss detection (AL.onMatchEnd, from
  // winMatch()/loseMatch()) -- guarded so this client only ever reports
  // once, even if e.g. a stray double-render somehow re-ran the win check.
  function onLocalMatchEnd(result) {
    if (!started || resultReported) return;
    resultReported = true;
    Net.send('report_result', { result });
  }

  // Manual "End Turn" click. AL.endTurn() (defaulting notifyServer=true, see
  // its doc comment in js/state.js) sends BOTH the peer-to-peer `action` (via
  // onLocalAction above, so the opponent's state.opponent mirrors the
  // discard/turn-pass) AND fires AL.onLocalTurnEnd() -> onLocalTurnEndNotify()
  // below, which is what actually hands the 24s clock to the opponent
  // server-side via the dedicated `end_turn` relay message (protocol.js: "the
  // dedicated turn-boundary signal ... instead of opaque `action`
  // inspection"). Contrast with handleTurnTimeout() below, which explicitly
  // passes notifyServer=false -- the server already advanced the turn itself
  // when it fired turn_timeout, so a second end_turn here would just bounce
  // off as NOT_YOUR_TURN. maybeAutoEndTurn() (js/state.js) is the third
  // caller and, like this one, leaves notifyServer at its default true --
  // this is also the fix for the production bug where an auto-ended turn
  // flipped the client-side turn label instantly but left the server's own
  // timer counting down from the stale previous deadline until it separately
  // timed out on its own.
  function onManualEndTurnClick() {
    if (AL.state.turn !== 'player' || AL.state.turnBusy || AL.state.frozen) return;
    AL.endTurn();
  }

  // AL.onLocalTurnEnd() fires exactly for the turn-ends the server doesn't
  // already know about (manual click, maybeAutoEndTurn()'s auto-end) -- see
  // js/state.js's emitLocalTurnEnd()/endTurn() doc comments. This is the
  // single call site for the dedicated `end_turn` relay message; onLocalAction
  // above (wired to AL.onAction) stays responsible for the separate opaque
  // peer `action` message on every turn-end regardless of cause.
  function onLocalTurnEndNotify() {
    if (!started || !Net.isConnected()) return;
    Net.send('end_turn');
  }

  function onClaimForfeitClick() {
    if (el.btnClaimForfeit.disabled) return;
    Net.send('claim_forfeit');
  }

  // ===========================================================================
  // Incoming: relay -> AL / UI
  // ===========================================================================

  function handleAction(msg) {
    if (!started) return;
    // See the pendingActions doc comment above -- don't lose an action that
    // arrives before THIS client's own screen has reached 'battle' (still on
    // the auto-shown How to Play overlay). applyRemoteAction() would just
    // silently no-op on it otherwise (js/state.js: it only acts while
    // state.screen === 'battle').
    if (AL.state.screen !== 'battle') {
      pendingActions.push(msg.payload);
      return;
    }
    AL.applyRemoteAction(msg.payload);
  }

  // Replays any actions buffered by handleAction() above, in the order they
  // arrived, the moment this client's own screen reaches 'battle' (i.e. the
  // local player just dismissed their copy of the How to Play overlay).
  function flushPendingActions() {
    if (!pendingActions.length) return;
    const queue = pendingActions;
    pendingActions = [];
    queue.forEach((payload) => AL.applyRemoteAction(payload));
  }

  // QA finding #1 fix (docs/qa/online-pvp-milestone.md, the Blocker): this
  // used to ONLY update the timer's numbers. That left the actual
  // turn-boundary state transition (whose turn it really is, hand
  // discard/draw) depending entirely on the peer `action` channel's
  // endTurn/turnStart messages -- sent by the ACTIVE player's own client,
  // which a frozen/unresponsive client, or one still parked on the
  // How-to-Play overlay, never sends. turn_started is the server's own
  // authoritative "whose turn is it NOW" broadcast and is guaranteed to
  // reach BOTH clients regardless of what the other one's JS is doing --
  // reconcileMyTurnStart()/reconcileOpponentTurnStart() (js/state.js) make
  // it actually drive the real game state, not just the countdown display.
  // Both are idempotent no-ops if local state already agrees (whichever of
  // "the real peer action" or "this server broadcast" arrives first for a
  // given turn boundary just wins), and deliberately run regardless of
  // AL.state.screen -- a frozen or How-to-Play-stuck client isn't
  // necessarily looking at the battle screen right now, but the underlying
  // state transition must still happen.
  function handleTurnStarted(msg) {
    if (!started) return;
    timerDeadline = msg.deadline;
    ensureTimerInterval();
    renderTimerTick();
    if (msg.activeAccountId === myAccountId) {
      AL.reconcileMyTurnStart();
    } else {
      AL.reconcileOpponentTurnStart();
    }
  }

  // Server fired this because the ACTIVE player's 24s ran out with no
  // end_turn. Only the client whose OWN turn timed out has anything to do --
  // the other client just observes the normal turn-pass once that client's
  // resulting 'endTurn' action arrives over the peer channel (or, per the
  // fix above, once the server's own turn_started broadcast reconciles it
  // regardless). spec §7.3 steps 1-2 (cancel unresolved selected card with
  // no mana spent, discard the rest of the hand, pass the turn) are EXACTLY
  // what AL.endTurn() already does (see js/state.js) -- a timeout is handled
  // identically to a manual End Turn click, just without also sending
  // end_turn to the server (which already moved on by itself). Deliberately
  // NOT gated on AL.state.screen anymore (QA's Repro B: a player who leaves
  // How-to-Play open past their own timeout used to keep their turn
  // indefinitely, since this whole handler used to no-op while off the
  // battle screen) -- discarding a hand and passing a turn is a state
  // operation, independent of what's currently on screen; the player simply
  // won't SEE the result until they return to battle, same as any other
  // state change while a sub-screen is open.
  function handleTurnTimeout(msg) {
    if (!started || msg.accountId !== myAccountId) return;
    if (AL.state.turn !== 'player' || AL.state.frozen) return; // defensive -- shouldn't happen if the server and this client agree on whose turn it is
    AL.endTurn(false); // notifyServer=false -- the server already advanced its own clock to fire this timeout, see js/state.js's endTurn() doc comment
  }

  function handleOpponentDisconnected(msg) {
    if (!started) return;
    disconnectedAt = typeof msg.disconnectedAt === 'number' ? msg.disconnectedAt : Date.now();
    AL.setFrozen(true);
    showDisconnectOverlay();
    ensureDisconnectInterval();
  }

  function handleOpponentReconnected() {
    if (!started) return;
    disconnectedAt = null;
    AL.setFrozen(false);
    hideDisconnectOverlay();
    stopDisconnectInterval();
  }

  function handleMatchEnded(msg) {
    if (!started || matchEnded) return;
    matchEnded = true;
    AL.setFrozen(false);
    hideDisconnectOverlay();
    stopDisconnectInterval();
    stopTimerInterval();
    AL.endMatchByResult(msg.result);
  }

  function handleError(msg) {
    // CLAIM_TOO_EARLY shouldn't normally surface (the button stays disabled
    // client-side until the same 10s floor the server enforces), but the
    // server is the real authority -- surface anything unexpected rather
    // than fail silently on a click that looked like it should have worked.
    if (msg.code === 'CLAIM_TOO_EARLY' || msg.code === 'OPPONENT_UNAVAILABLE') {
      window.alert(msg.message);
    }
  }

  // ===========================================================================
  // Turn timer UI (spec §7.3)
  // ===========================================================================

  function ensureTimerInterval() {
    if (timerIntervalHandle) return;
    timerIntervalHandle = setInterval(renderTimerTick, 250);
  }
  function stopTimerInterval() {
    if (timerIntervalHandle) { clearInterval(timerIntervalHandle); timerIntervalHandle = null; }
  }

  function renderTimerTick() {
    if (!started || AL.state.screen !== 'battle') return;
    positionTimer();
    if (timerDeadline == null) return;
    const remainingMs = timerDeadline - Date.now();
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    el.turnTimerValue.textContent = String(seconds).padStart(2, '0');
    el.turnTimerLabel.textContent = AL.state.turn === 'player' ? 'Your Turn' : 'Opponent';
    el.turnTimer.classList.toggle('urgent', seconds <= 10);
  }

  // Relocates the single shared #turn-timer node between the two positions
  // the mockup shows (next to End Turn during my turn, inside the opponent
  // panel during theirs) -- spec §7.3: "타이머가 활성 플레이어 쪽 컨트롤 옆에
  // 붙어 다닌다". appendChild on a node already in the DOM just moves it
  // (same technique js/ui.js's renderHand uses for hand cards).
  function positionTimer() {
    if (!el.turnTimer) return;
    const target = AL.state.turn === 'player' ? el.endTurnCol : el.opponentMetaRow;
    if (target && el.turnTimer.parentElement !== target) target.appendChild(el.turnTimer);
  }

  // ===========================================================================
  // Disconnect overlay UI (spec §8.2)
  // ===========================================================================

  function showDisconnectOverlay() {
    el.disconnectOverlay.classList.remove('hidden');
    renderDisconnectTick();
  }
  function hideDisconnectOverlay() {
    el.disconnectOverlay.classList.add('hidden');
  }
  function ensureDisconnectInterval() {
    if (disconnectIntervalHandle) return;
    disconnectIntervalHandle = setInterval(renderDisconnectTick, 250);
  }
  function stopDisconnectInterval() {
    if (disconnectIntervalHandle) { clearInterval(disconnectIntervalHandle); disconnectIntervalHandle = null; }
  }

  function renderDisconnectTick() {
    if (disconnectedAt == null) return;
    const elapsed = Date.now() - disconnectedAt;
    const remainingSec = Math.max(0, Math.ceil((DISCONNECT_GRACE_MS - elapsed) / 1000));
    el.disconnectTimerText.textContent = `남은 시간: ${remainingSec}초`;

    const claimReady = elapsed >= CLAIM_FORFEIT_FLOOR_MS;
    el.btnClaimForfeit.disabled = !claimReady;
    el.claimForfeitHint.textContent = claimReady
      ? ''
      : `${Math.ceil((CLAIM_FORFEIT_FLOOR_MS - elapsed) / 1000)}초 후 기권승 처리가 가능합니다`;
  }

  // ===========================================================================
  // Init
  // ===========================================================================

  function init() {
    cache();

    AL.onAction(onLocalAction);
    AL.onMatchEnd(onLocalMatchEnd);
    AL.onLocalTurnEnd(onLocalTurnEndNotify);
    // Flush any action buffered by handleAction() the instant this client's
    // own screen reaches 'battle' -- see pendingActions' doc comment. Runs on
    // every state change (cheap: just a length check in the common case),
    // not just screen transitions, since AL doesn't expose a dedicated
    // "screen changed to X" event.
    AL.onChange((state) => { if (state.screen === 'battle') flushPendingActions(); });

    Net.on('action', handleAction);
    Net.on('turn_started', handleTurnStarted);
    Net.on('turn_timeout', handleTurnTimeout);
    Net.on('opponent_disconnected', handleOpponentDisconnected);
    Net.on('opponent_reconnected', handleOpponentReconnected);
    Net.on('match_ended', handleMatchEnded);
    Net.on('error', handleError);

    el.btnEndTurn.addEventListener('click', onManualEndTurnClick);
    el.btnClaimForfeit.addEventListener('click', onClaimForfeitClick);
  }

  // Defense-in-depth guard (Minor finding #2, docs/qa/practice-mode-
  // milestone.md): exposes whether a real PvP match is currently live, so
  // js/practice.js's start() can refuse to run (and clobber AL.state) while
  // one is -- see that function's doc comment for the other half of this
  // guard.
  function isActive() { return started; }

  return { init, start, reset, isActive };
})();
