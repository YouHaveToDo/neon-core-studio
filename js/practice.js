/* ARCANE LEDGER — local practice-match orchestration (docs/design/
 * practice-mode-proposal.md, Track A: AI engine + local timer only -- no
 * server/Ink/lobby-entry work, see this session's task scope).
 *
 * This is the local-only counterpart to js/battle.js: that file is the
 * "network<->engine glue" for a real PvP match (relay messages drive
 * state.opponent via AL.applyRemoteAction()); this file is the "AI<->engine
 * glue" for a practice match (js/ai.js's brain drives state.opponent via the
 * exact same AL.applyRemoteAction() pipeline, per the design doc §4.1
 * recommendation -- see js/ai.js's own file header for why that reuse is
 * safe/correct).
 *
 * Why reusing AL.onAction()/onMatchEnd()/onLocalTurnEnd() here is safe and
 * does NOT accidentally touch the network: js/battle.js's own subscribers to
 * those three buses (onLocalAction/onLocalMatchEnd/onLocalTurnEndNotify) are
 * all internally guarded on Battle's own module-local `started` flag, which
 * only Battle.start() ever sets true. A practice match never calls
 * Battle.start() (Match.js only calls it from the real matchmaking flow), so
 * every one of those handlers stays a no-op for the whole practice match --
 * nothing gets sent to Net, nothing reports a result, nothing asks the relay
 * to advance a timer that doesn't exist server-side for this mode. This file
 * doesn't need to duplicate that guard itself; it falls out of the existing
 * code for free.
 *
 * Disconnect/reconnect UI (design doc §1, §5.1's "이 모드에는 이 문제가
 * 구조적으로 성립하지 않는다"): this file never calls AL.setFrozen(true) and
 * never touches js/battle.js's disconnect overlay -- there is no
 * opponent_disconnected-equivalent event in this mode at all, so that UI
 * simply never has a reason to appear during a practice match. (Making sure
 * a STALE overlay from a previous real PvP match isn't still visible when a
 * practice match starts is an entry-flow concern for the lobby-integration
 * task, Track C, which doesn't exist yet -- out of scope here.)
 */
const Practice = (() => {
  const el = {};
  let active = false;
  let brain = null;
  let currentTurnHandled = null; // last state.turn value this module already reacted to, for edge-detection (see onStateChange)
  let turnSeconds = 24; // §5.1: same 24s duration as real PvP's server timer, just client-local here -- overridable via start()'s opts for tests only

  // ---- local player-turn timer (design doc §5) ------------------------------
  let timerDeadline = null;
  let timerIntervalHandle = null;

  function cache() {
    // No DOM in the Node vm test harness (server/scripts/practice-mode-ai-test.js)
    // -- every element lookup below is optional and every render function
    // guards on the element actually being present, so this module works
    // identically with or without a real document.
    if (typeof document === 'undefined') return;
    el.turnTimer = document.getElementById('turn-timer');
    el.turnTimerLabel = document.getElementById('turn-timer-label');
    el.turnTimerValue = document.getElementById('turn-timer-value');
    el.endTurnCol = document.getElementById('end-turn-col');
    el.opponentMetaRow = document.getElementById('opponent-meta-row');
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  // deckIds: the player's real chosen deck (design doc §2 -- mirrored as-is
  // to the AI, see js/ai.js's createBrain()).
  // opts:
  //   isFirstPlayer -- coin flip result, same shape AL.startMatch() takes.
  //                    Left undefined falls back to a local 50/50, same as
  //                    AL.startMatch() itself does for its own devtools path.
  //   opponentName  -- defaults to the design doc's fixed practice-opponent
  //                    label (§1: "상대 패널에는 실제 상대의 표시 이름 대신
  //                    고정 라벨이 뜬다").
  //   turnSeconds/pacingMs/aiRng/aiSleepFn/aiMaxIterations -- test-only
  //    overrides, never used by the real (not-yet-built) lobby entry point.
  function start(deckIds, opts) {
    opts = opts || {};
    active = true;
    currentTurnHandled = null;
    turnSeconds = typeof opts.turnSeconds === 'number' ? opts.turnSeconds : 24;
    stopPlayerTimer();

    const isFirstPlayer = typeof opts.isFirstPlayer === 'boolean' ? opts.isFirstPlayer : Math.random() < 0.5;

    brain = AI.createBrain(deckIds, {
      isFirstPlayer,
      rng: opts.aiRng,
      pacingMs: opts.aiPacingMs,
      sleepFn: opts.aiSleepFn,
      maxIterations: opts.aiMaxIterations,
    });

    AL.startMatch({
      deck: deckIds,
      isFirstPlayer,
      opponentName: opts.opponentName || '연습 상대',
      opponentDeckSize: deckIds.length,
    });
  }

  // Mirrors js/battle.js's reset() -- called before a fresh match (다시
  // 연습하기 / 로비로 돌아가기, once Track C wires those buttons) so no
  // leftover timer/brain state bleeds into the next match.
  function stop() {
    active = false;
    brain = null;
    currentTurnHandled = null;
    stopPlayerTimer();
  }

  // ===========================================================================
  // Turn-boundary dispatch
  // ===========================================================================

  // Fires on every AL state change. Only reacts the FIRST time it sees a
  // given state.turn value (currentTurnHandled edge-detect) -- both because
  // resolveCard()/applyRemoteCardPlay() legitimately re-emit many times per
  // turn without the turn boundary actually changing, and because the AI's
  // own turn-start/playTurn calls below synchronously trigger further emit()
  // calls (applyRemoteAction -> emit()) that must NOT re-enter this same
  // branch while the AI's turn is already in progress.
  function onStateChange(state) {
    if (!active) return;
    if (state.screen !== 'battle') { stopPlayerTimer(); return; }
    if (state.matchResult) { stopPlayerTimer(); return; }
    if (currentTurnHandled === state.turn) return;
    currentTurnHandled = state.turn;

    if (state.turn === 'opponent') {
      stopPlayerTimer();
      runAiTurn();
    } else {
      startPlayerTimer();
    }
  }

  async function runAiTurn() {
    if (!brain) return;
    brain.onTurnStart(AL);
    if (AL.state.screen !== 'battle' || AL.state.turn !== 'opponent') return; // defensive -- a bare turn-start reset shouldn't itself end the match
    await brain.playTurn(AL);
  }

  // ===========================================================================
  // Local player-turn timer (design doc §5.1)
  // ===========================================================================

  function startPlayerTimer() {
    timerDeadline = Date.now() + turnSeconds * 1000;
    ensureTimerInterval();
    renderTimerTick();
  }

  function stopPlayerTimer() {
    timerDeadline = null;
    if (timerIntervalHandle) { clearInterval(timerIntervalHandle); timerIntervalHandle = null; }
  }

  function ensureTimerInterval() {
    if (timerIntervalHandle) return;
    timerIntervalHandle = setInterval(tick, 250);
  }

  function tick() {
    renderTimerTick();
    if (timerDeadline != null && Date.now() >= timerDeadline) {
      stopPlayerTimer();
      onTimerExpire();
    }
  }

  // §5.1: "카운트다운이 0에 도달하면 ... 서버가 turn_timeout을 보냈을 때와
  // 동일한 클라이언트 쪽 후속 처리를 로컬에서 직접 호출한다." That
  // consequence is exactly AL.endTurn() (cancel any unresolved selection --
  // already handled inside endTurn() itself --, discard the rest of the
  // hand, pass the turn) -- js/battle.js's own handleTurnTimeout() calls the
  // identical function for the real-PvP case. notifyServer's default value
  // (true) is inert here either way: emitLocalTurnEnd() -> Battle's
  // onLocalTurnEndNotify() no-ops whenever Battle.start() was never called
  // for this match (see file header) -- passing false would be equally
  // correct but is left at the default since it plainly cannot matter in
  // this mode.
  function onTimerExpire() {
    if (!active) return;
    if (AL.state.screen !== 'battle' || AL.state.turn !== 'player' || AL.state.frozen) return;
    AL.endTurn();
  }

  // ===========================================================================
  // Timer UI (reuses the exact #turn-timer markup/positions js/battle.js
  // drives for real PvP -- design doc §5: "adapting this pattern for local-
  // only use, not building a new timer UI from scratch")
  // ===========================================================================

  function renderTimerTick() {
    if (!el.turnTimer || !active) return;
    positionTimer();
    if (timerDeadline == null) return;
    const remainingMs = timerDeadline - Date.now();
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    el.turnTimerValue.textContent = String(seconds).padStart(2, '0');
    el.turnTimerLabel.textContent = AL.state.turn === 'player' ? 'Your Turn' : 'Opponent';
    el.turnTimer.classList.toggle('urgent', seconds <= 10);
  }

  function positionTimer() {
    if (!el.turnTimer) return;
    const target = AL.state.turn === 'player' ? el.endTurnCol : el.opponentMetaRow;
    if (target && el.turnTimer.parentElement !== target) target.appendChild(el.turnTimer);
  }

  // ===========================================================================
  // Init
  // ===========================================================================

  // Registered once at app startup (mirrors Battle.init()'s shape) -- every
  // handler above already no-ops while `active` is false, so it's harmless
  // for this to be wired up permanently regardless of whether a practice
  // match is ever actually started.
  function init() {
    cache();
    AL.onChange(onStateChange);
  }

  return { init, start, stop };
})();
