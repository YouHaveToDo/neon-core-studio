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

  // ---- last-match memory, for "다시 연습하기" (design doc §7.4) -----------
  // §7.4: restarting must NOT re-enter deck-select/lobby -- "이미 갖고 있는
  // 덱 정보로 즉시 재시작". Storing just the deck + opponent label (not the
  // full opts bag -- isFirstPlayer/turnSeconds/etc. are per-match or
  // test-only and must NOT be replayed identically on a restart) is enough
  // to call start() again from scratch, which itself does a fresh coin flip
  // exactly like a real new match would.
  let lastDeckIds = null;
  let lastOpponentName = null;

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

    // Match-end (design doc §7.3/§7.4): this module directly owns the
    // practice-distinct title/subtitle copy + button-set swap on top of the
    // shared victory/defeat screen js/ui.js already renders the real-PvP
    // default text into -- same "module reaches past its own screen into a
    // shared DOM node" pattern js/battle.js already uses for #turn-timer/
    // #disconnect-overlay above.
    el.victoryTitle = document.getElementById('victory-title');
    el.victorySubtitle = document.getElementById('victory-subtitle');
    el.defeatTitle = document.getElementById('defeat-title');
    el.defeatSubtitle = document.getElementById('defeat-subtitle');
    el.btnRestartVictory = document.getElementById('btn-restart-victory');
    el.btnRestartDefeat = document.getElementById('btn-restart-defeat');
    el.btnPracticeAgainVictory = document.getElementById('btn-practice-again-victory');
    el.btnPracticeAgainDefeat = document.getElementById('btn-practice-again-defeat');
    el.btnPracticeLobbyVictory = document.getElementById('btn-practice-lobby-victory');
    el.btnPracticeLobbyDefeat = document.getElementById('btn-practice-lobby-defeat');
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
    // Defense-in-depth guard (Minor finding #2, docs/qa/practice-mode-
    // milestone.md "Direction A"): a real PvP match is only ever reachable
    // through js/match.js's own room-list flow, whose UI synchronously
    // disables/hides every practice entry point the instant a real
    // room-join/match-start is in flight -- there is no ordinary click
    // sequence that reaches this function while Battle.isActive() is true.
    // QA's repro required a forced native .click() on an already-disabled
    // button (or a direct console call to this function), bypassing that UI
    // guard entirely -- reachable via devtools, not by any real player
    // action. Refusing to start here (rather than only relying on the UI
    // layer) closes that gap: a forced/adversarial Practice.start() call can
    // no longer silently overwrite a live real match's AL.state (opponent
    // name/HP/turn all got clobbered before this guard existed). Symmetric
    // half of this guard lives in js/match.js's onBothPresent()/
    // handleTurnStarted() (Practice.isActive() check), for the reverse
    // direction.
    if (typeof Battle !== 'undefined' && Battle.isActive()) return;

    opts = opts || {};
    active = true;
    currentTurnHandled = null;
    turnSeconds = typeof opts.turnSeconds === 'number' ? opts.turnSeconds : 24;
    stopPlayerTimer();

    const isFirstPlayer = typeof opts.isFirstPlayer === 'boolean' ? opts.isFirstPlayer : Math.random() < 0.5;
    const opponentName = opts.opponentName || '연습 상대';

    // §7.4 "다시 연습하기" memory -- see field doc comment above. Recorded on
    // every start() (not just the initial lobby-triggered one) so restart()
    // itself remains idempotent/repeatable.
    lastDeckIds = deckIds.slice();
    lastOpponentName = opponentName;

    brain = AI.createBrain(deckIds, {
      // js/ai.js's createBrain() documents `isFirstPlayer` as AI-relative
      // ("whether AL.startMatch() made the AI go first"), while the local
      // `isFirstPlayer` above is player-relative ("does the real, local
      // player go first" -- the exact same value AL.startMatch() takes).
      // The two are always opposite for a 1v1 match, so this must be
      // inverted here -- passing the un-inverted value silently disabled
      // the §3.3 turn-1 attack lock whenever the AI was genuinely first
      // (docs/qa/practice-mode-milestone.md, follow-up #3).
      isFirstPlayer: !isFirstPlayer,
      rng: opts.aiRng,
      pacingMs: opts.aiPacingMs,
      sleepFn: opts.aiSleepFn,
      maxIterations: opts.aiMaxIterations,
    });

    AL.startMatch({
      deck: deckIds,
      isFirstPlayer,
      opponentName,
      opponentDeckSize: deckIds.length,
    });
  }

  // "다시 연습하기" (design doc §7.4): restart immediately with the same
  // (mirrored) deck, no deck-select/lobby round-trip. A no-op if somehow
  // called before any practice match has ever started (defensive only --
  // the button that calls this is only ever visible once start() has
  // already run at least once).
  function restart() {
    if (!lastDeckIds) return;
    start(lastDeckIds, { opponentName: lastOpponentName });
  }

  // Mirrors js/battle.js's reset() -- called before a fresh match (다시
  // 연습하기 / 로비로 돌아가기) so no leftover timer/brain state bleeds into
  // the next match.
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
    // AL.startMatch() (real PvP AND practice alike) always routes through
    // 'howto'/'first' at the very start of a fresh match (js/state.js) --
    // that's the one state transition guaranteed to happen exactly once per
    // match regardless of which mode it is, so it's the right hook to clear
    // any practice-only match-end UI a PREVIOUS practice match may have left
    // behind (see resetMatchEndUI()'s doc comment). Deliberately NOT gated
    // on `active` -- a fresh REAL PvP match must clear this leftover state
    // too, and `active` is specifically about the AI-turn-loop/local-timer
    // machinery below, not this unrelated screen-hygiene concern.
    if (state.screen === 'howto' && state.howtoContext === 'first') resetMatchEndUI();

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
    checkTimerExpiry();
  }

  // Bug fix (Major, docs/qa/practice-mode-milestone.md finding #1): the
  // interval poll above is the only place expiry USED to get noticed, and
  // that's fragile against browser background-tab timer throttling -- Chrome
  // (and other browsers) deliberately delay/coalesce setInterval/setTimeout
  // callbacks for a backgrounded tab to save battery/CPU, so a 250ms poll can
  // simply not fire again for a long stretch (QA's diagnostic pointed at this
  // specifically -- other setTimeout-driven code on the same page, js/ai.js's
  // pacing, did NOT show the same failure rate, so this isn't a blanket
  // "whole page frozen" effect, it's specific to this interval's own
  // scheduling). Switching the interval itself to setTimeout wouldn't fix
  // this on its own -- a single deadline-based setTimeout is throttled by the
  // exact same background-tab policy as setInterval; neither primitive is
  // guaranteed to fire promptly while hidden.
  //
  // The actually-robust fix: pull the expiry CHECK (Date.now() >=
  // timerDeadline) out into its own function and also run it from
  // 'visibilitychange'/'focus' (see init() below), not just from the
  // interval tick. Those two events are NOT subject to the same throttling —
  // they fire the moment the tab genuinely regains visibility/focus, which is
  // a real user action, not a timer callback — so even if every single
  // interval tick was starved for the entire time the tab was backgrounded,
  // the instant the player switches back to this tab, this same
  // Date.now()-vs-deadline check runs immediately and catches an
  // already-passed deadline right then, rather than waiting for whatever the
  // interval's next (possibly still-delayed) tick happens to be. This is a
  // self-correcting check ("are we currently past the deadline?"), not a
  // "did the timer fire?" flag, so it's correct regardless of how many ticks
  // were missed or how the throttling happened to behave for a given trial —
  // which is what QA's own root-cause note flagged as the fix to look at, and
  // what QA's ~50%-failure-rate methodology (real Chromium tab-backgrounding,
  // not a fake clock) is the right way to verify against.
  function checkTimerExpiry() {
    if (timerDeadline != null && Date.now() >= timerDeadline) {
      stopPlayerTimer();
      onTimerExpire();
    }
  }

  // Catch-up handler for the two events above -- registered once in init().
  // Only meaningful on REGAINING visibility/focus (losing it is the moment
  // throttling can start, not the moment to check); checkTimerExpiry() itself
  // is a no-op if there's no active player-turn deadline right now, so this
  // is harmless to call unconditionally otherwise (e.g. during the AI's own
  // turn, or outside a practice match entirely).
  function handleVisibilityOrFocusRegain() {
    if (typeof document !== 'undefined' && document.hidden) return;
    tick();
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
  // Match end -- practice-distinct result screen (design doc §6.5/§7.2-§7.4)
  // ===========================================================================
  //
  // js/ui.js's renderMatchEnd() already painted the generic real-PvP text
  // ("승리!"/"패배" + opponent-name subtitle) into #victory-title/
  // #victory-subtitle/#defeat-title/#defeat-subtitle by the time this runs
  // (AL.state.matchResult drives that render on every emit(), and
  // winMatch()/loseMatch() call emit() BEFORE emitMatchEnd() -- see
  // js/state.js). This handler overwrites that same shared DOM with the
  // practice-specific copy + swaps which button row is visible, the same
  // "module reaches into shared match-end DOM it doesn't otherwise own"
  // pattern js/battle.js would use if real PvP needed anything screen-
  // specific here (it doesn't).
  //
  // Guarded on `active` exactly like every other handler in this file --
  // js/battle.js's own AL.onMatchEnd subscriber (onLocalMatchEnd) is
  // symmetrically guarded on ITS OWN `started` flag, and the two are
  // mutually exclusive per match (a match is either started via
  // Battle.start() from the real matchmaking flow, or via Practice.start()
  // from the lobby's practice entry point -- never both), so exactly one of
  // the two subscribers ever does anything for a given match end.
  function handlePracticeMatchEnd(result) {
    if (!active) return;
    showPracticeMatchEndButtons();

    const titleEl = result === 'win' ? el.victoryTitle : el.defeatTitle;
    const subtitleEl = result === 'win' ? el.victorySubtitle : el.defeatSubtitle;
    const label = result === 'win' ? '연습 승리' : '연습 패배';

    // §7.1: the "전적에 기록되지 않습니다" subcopy is unconditional (doesn't
    // depend on the Ink award below at all) -- set it immediately rather
    // than waiting on the network round-trip.
    if (subtitleEl) subtitleEl.textContent = '전적에 기록되지 않습니다';
    if (titleEl) titleEl.textContent = label;

    // §6.5: Ink is a real account currency, so the amount MUST come from the
    // server's response -- never assume/display the nominal full 4/1 amount
    // client-side (the daily cap in §6.1 can zero it out or partially award
    // it, e.g. 18/20 + a win only awards 2, not 4).
    API.economy.practiceResult(result).then((data) => {
      if (!titleEl) return;
      // §7.3's exact copy table, generalized to whatever amount the server
      // actually awarded (covers both the table's literal 4/1 rows and the
      // partial-award case the table doesn't spell out but the daily-cap
      // math in §6.1/§6.4 clearly implies can happen).
      titleEl.textContent = data.inkAwarded > 0
        ? `${label} · +${data.inkAwarded} 잉크`
        : `${label} · 오늘 연습 잉크 한도 도달(0 잉크)`;
    }).catch(() => {
      // Network/session hiccup reporting the result -- don't block
      // navigation over a non-critical display value (same "leave it
      // showing a sane default" philosophy as App.refreshInkBalance()'s own
      // catch), just flag that the Ink figure above couldn't be confirmed.
      if (subtitleEl) subtitleEl.textContent = '전적에 기록되지 않습니다 · 잉크 지급 확인 실패';
    });
  }

  // Swaps the real-PvP "다시 플레이" button out for the practice-mode pair
  // ("다시 연습하기" / "로비로 돌아가기", §7.4) on both the victory and defeat
  // screens -- "메인 메뉴" is untouched (same button, same handler, works
  // identically for both modes, see js/main.js).
  function showPracticeMatchEndButtons() {
    if (el.btnRestartVictory) el.btnRestartVictory.classList.add('hidden');
    if (el.btnRestartDefeat) el.btnRestartDefeat.classList.add('hidden');
    if (el.btnPracticeAgainVictory) el.btnPracticeAgainVictory.classList.remove('hidden');
    if (el.btnPracticeAgainDefeat) el.btnPracticeAgainDefeat.classList.remove('hidden');
    if (el.btnPracticeLobbyVictory) el.btnPracticeLobbyVictory.classList.remove('hidden');
    if (el.btnPracticeLobbyDefeat) el.btnPracticeLobbyDefeat.classList.remove('hidden');
  }

  // Restores the real-PvP default button set. Called at the start of EVERY
  // fresh match (see onStateChange's 'howto'/'first' hook above, unguarded
  // on `active`) so a practice match's button-swap never leaks into a
  // later real PvP match's end screen -- ui.js's own title/subtitle
  // rendering already self-corrects every match (it's driven straight off
  // AL.state.matchResult on every render), but button visibility is DOM
  // state nothing else ever resets, so this module (the only thing that
  // ever turns it on) is responsible for turning it back off too.
  function resetMatchEndUI() {
    if (el.btnRestartVictory) el.btnRestartVictory.classList.remove('hidden');
    if (el.btnRestartDefeat) el.btnRestartDefeat.classList.remove('hidden');
    if (el.btnPracticeAgainVictory) el.btnPracticeAgainVictory.classList.add('hidden');
    if (el.btnPracticeAgainDefeat) el.btnPracticeAgainDefeat.classList.add('hidden');
    if (el.btnPracticeLobbyVictory) el.btnPracticeLobbyVictory.classList.add('hidden');
    if (el.btnPracticeLobbyDefeat) el.btnPracticeLobbyDefeat.classList.add('hidden');
  }

  // ===========================================================================
  // Init
  // ===========================================================================

  // Registered once at app startup (mirrors Battle.init()'s shape) -- every
  // handler above already no-ops while `active` is false, so it's harmless
  // for this to be wired up permanently regardless of whether a practice
  // match is ever actually started.
  //
  // 'visibilitychange'/'focus' (fix for docs/qa/practice-mode-milestone.md
  // finding #1, see checkTimerExpiry()'s doc comment above): registered once
  // globally, same "wired up permanently, every handler no-ops when
  // irrelevant" pattern as everything else here -- handleVisibilityOrFocusRegain()
  // is a no-op whenever there's no live player-turn deadline (AI's turn, no
  // practice match at all, etc.), so this needs no active-match guard of its
  // own. No document in the Node vm test harness (see cache()'s doc comment)
  // -- guarded the same way.
  function init() {
    cache();
    AL.onChange(onStateChange);
    AL.onMatchEnd(handlePracticeMatchEnd);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityOrFocusRegain);
      window.addEventListener('focus', handleVisibilityOrFocusRegain);
    }
  }

  // Defense-in-depth guard (Minor finding #2, docs/qa/practice-mode-
  // milestone.md): exposes whether a practice match is currently live, so
  // js/match.js can refuse to let an abandoned-room's real-match traffic
  // (opponent_joined/turn_started) clobber this module's active AL.state --
  // see match.js's onBothPresent()/handleTurnStarted() doc comments for the
  // other half of this guard.
  function isActive() { return active; }

  return { init, start, stop, restart, isActive };
})();
