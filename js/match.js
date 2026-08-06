/* ARCANE LEDGER — deck-select -> lobby (open room list) -> match-start flow
 * (spec-online-pvp.md §6.1-§6.3, §6.2 2026-08 revision: room-code create/join
 * replaced with open room-list matchmaking).
 *
 * Self-contained module, same shape as js/deck.js/js/auth.js (own DOM cache
 * + state + event wiring, reached only via Screens.show()). Talks to the
 * relay through js/ws.js (Net) for room create/join/match-start, and to the
 * REST room-list endpoint through js/api.js (API.rooms.list()) for browsing
 * open rooms -- see server/src/routes/rooms.js for why that's REST, not a
 * WS message (the room-list screen needs to poll BEFORE this client has
 * created or joined any room, i.e. before there's a room/WS session context
 * to hang a message off of; REST needs no such context, just the existing
 * session cookie every other authenticated GET already uses).
 *
 * This file owns everything BEFORE the battle screen exists (deck choice,
 * room list/create/join, coin flip); it does not touch AL.state directly
 * beyond the one handoff call to AL.startMatch(). Everything that happens
 * DURING the match (in-battle action relay, the 24s timer, disconnect/
 * forfeit, match-end) is js/battle.js's job -- handleTurnStarted() below
 * calls Battle.start() as its very last step, the exact moment ownership of
 * the live match passes from this file to that one.
 *
 * "다시 플레이" (spec §6.4's match-end screen) re-enters this same module via
 * playAgain(), reusing the account this file already holds from the match
 * that just ended.
 *
 * ---- Coin-flip / first-player determination (spec §6.3 step 1) ----
 * protocol.js's start_match doc comment states the coin flip itself, and
 * both clients AGREEING on its result, is a client-side concern -- the
 * relay only accepts whatever `firstAccountId` arrives first and broadcasts
 * TURN_STARTED with that value to both sides. That broadcast is what this
 * file treats as authoritative for `isFirstPlayer` (both clients compare
 * `turn_started.activeAccountId` against their OWN account id, never a
 * locally-guessed value) -- so the two clients can never end up disagreeing
 * about who went first, no matter how the firstAccountId in the outgoing
 * start_match message was chosen.
 *
 * Choosing that value is a real gap, though: NONE of the relay's messages
 * (room_created/room_joined/opponent_joined/opponent_reconnected) ever
 * expose the OPPONENT's accountId to a client -- only their displayName.
 * That means a client can only ever legally reference its OWN accountId in
 * `firstAccountId`; it has no way to name the other player even if the coin
 * flip "picked" them. Design used here to work around that (rather than
 * reaching for the opaque `action` relay to smuggle accountIds across, which
 * would work but adds a hidden handshake before the real match-flow
 * messages even start): a deterministic function of the room's internal id
 * (known identically, verbatim, by both clients -- the host generated/
 * received it from ROOM_CREATED, the guest received the exact same string
 * from the room-list response and echoed it back in room_join) decides
 * whether the HOST or the GUEST goes first. Each client only ever sends
 * start_match naming itself, and only when that deterministic function says
 * IT is the winner -- so across the two clients, start_match is sent from
 * exactly one side, no accountId exchange required, no race. The room id
 * itself is generated server-side via crypto.randomInt (server/src/ws/
 * rooms.js) and is not chosen or predictable by either client ahead of
 * time, so the derived host-vs-guest outcome is effectively a random 50/50
 * per match even though the function computing it is pure/deterministic.
 * Flagged in the task report as a protocol gap worth a real fix (e.g. the
 * relay including a stable opponent identifier in its messages) rather than
 * a permanent solution -- this is a working MVP substitute that needed no
 * server changes, per this session's scope boundary.
 */
const Match = (() => {
  const el = {};
  let account = null;

  // ---- deck select state (§6.1) --------------------------------------------
  let slots = [null, null, null];
  let selectedDeck = null; // { slot, name, cards: {cardId:count}, total, valid }

  // ---- lobby / relay state (§6.2-§6.3) --------------------------------------
  let isHost = false;
  let roomCode = null; // relay's internal room id -- never shown to the player (spec §6.2.4)
  let opponentDisplayName = null;
  let opponentDeckSize = null; // real opponent deck size relayed by the server (QA finding #3) -- null until OPPONENT_JOINED/ROOM_JOINED reports it
  let matchStarting = false; // guards double-handling of turn_started
  let netHandlersRegistered = false;

  // ---- room list (spec §6.2.1-§6.2.6) ----------------------------------------
  let pollTimer = null;
  let joining = false; // true while a room_join request for a clicked row is in flight
  let pendingAction = null; // 'create' | 'join' | null -- which outgoing relay request an 'error' reply should be attributed to
  let toastTimer = null;

  function cache() {
    el.deckSelectScreen = document.getElementById('screen-deck-select');
    el.deckSelectStatus = document.getElementById('deck-select-status');
    el.deckSelectList = document.getElementById('deck-select-list');
    el.btnDeckSelectBack = document.getElementById('btn-deck-select-back');

    el.lobbyScreen = document.getElementById('screen-lobby');
    // Shared topbar slot (ui.js repurposes it as a turn indicator mid-battle).
    // Nothing in the lobby writes a room identifier into it anymore (spec
    // §6.2.4: no human-facing code exists to show) -- only defensively
    // cleared here in case a previous session ever left stale text in it.
    el.roomLabelTop = document.getElementById('room-label');

    el.roomListBody = document.getElementById('room-list-body');
    el.btnLobbyBackToDeck = document.getElementById('btn-lobby-back-to-deck');
    el.btnLobbyRefresh = document.getElementById('btn-lobby-refresh');
    el.btnLobbyCreate = document.getElementById('btn-lobby-create');
    el.lobbyToast = document.getElementById('lobby-toast');
    el.lobbyToastText = document.getElementById('lobby-toast-text');
    el.roomListLoading = document.getElementById('room-list-loading');
    el.roomList = document.getElementById('room-list');
    el.roomListEmpty = document.getElementById('room-list-empty');
    el.btnLobbyCreateEmpty = document.getElementById('btn-lobby-create-empty');
    el.roomListError = document.getElementById('room-list-error');
    el.btnLobbyRetry = document.getElementById('btn-lobby-retry');

    el.lobbyPanelWaiting = document.getElementById('lobby-panel-waiting');
    el.lobbyWaitingTitle = document.getElementById('lobby-waiting-title');
    el.lobbyWaitingSubtitle = document.getElementById('lobby-waiting-subtitle');
    el.lobbyWaitingStatus = document.getElementById('lobby-waiting-status');
    el.btnLobbyWaitingBack = document.getElementById('btn-lobby-waiting-back');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===========================================================================
  // Deck select (spec §6.1)
  // ===========================================================================

  async function showDeckSelect(acct) {
    account = acct;
    selectedDeck = null;
    Screens.show('screen-deck-select');
    el.deckSelectList.innerHTML = '';
    setDeckSelectStatus('불러오는 중...');
    try {
      const data = await API.decks.list();
      slots = data.slots;
      setDeckSelectStatus(null);
      renderDeckSelectList();
    } catch (err) {
      const message = err instanceof API.ApiError && err.status === 401
        ? '세션이 만료되었습니다. 다시 로그인해주세요.'
        : `덱 목록을 불러오지 못했습니다: ${err.message}`;
      setDeckSelectStatus(message);
    }
  }

  function setDeckSelectStatus(message) {
    if (!message) {
      el.deckSelectStatus.classList.add('hidden');
      el.deckSelectStatus.textContent = '';
      return;
    }
    el.deckSelectStatus.classList.remove('hidden');
    el.deckSelectStatus.textContent = message;
  }

  // Same tile shape as deck.js's slot list (css/pvp-components.css
  // .deck-slot-tile), but selection-only: no edit/delete actions, and only
  // valid (20-30 card) decks are clickable -- invalid/empty slots render
  // disabled with the same "미완성" badge deck.js already uses (spec §6.1:
  // reuse the exact same validity check/badge deck.js's slot list shows).
  function renderDeckSelectList() {
    el.deckSelectList.innerHTML = '';
    for (let slot = 1; slot <= 3; slot++) {
      const deck = slots[slot - 1];
      const tile = document.createElement('div');
      tile.className = 'deck-slot-tile deck-select-tile';

      if (!deck) {
        tile.classList.add('invalid');
        tile.innerHTML = `<div class="slot-name">슬롯 ${slot}</div><div class="slot-count">비어 있음</div>`;
        el.deckSelectList.appendChild(tile);
        continue;
      }

      if (!deck.valid) {
        tile.classList.add('invalid');
        const badge = document.createElement('span');
        badge.className = 'badge-incomplete';
        badge.textContent = '미완성';
        tile.appendChild(badge);
      } else {
        tile.classList.add('selectable');
        tile.addEventListener('click', () => chooseDeck(slot, deck));
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'slot-name';
      nameEl.textContent = deck.name;
      tile.appendChild(nameEl);

      const countEl = document.createElement('div');
      countEl.className = 'slot-count';
      countEl.textContent = `${deck.total}/30장`;
      tile.appendChild(countEl);

      el.deckSelectList.appendChild(tile);
    }
  }

  function chooseDeck(slot, deck) {
    selectedDeck = deck;
    showRoomList();
  }

  function expandDeck(cardsMap) {
    const ids = [];
    Object.keys(cardsMap || {}).forEach((cardId) => {
      const n = cardsMap[cardId] || 0;
      for (let i = 0; i < n; i++) ids.push(cardId);
    });
    return ids;
  }

  // ===========================================================================
  // Lobby: open room list (spec §6.2, 2026-08 revision)
  // ===========================================================================

  function showRoomList() {
    resetLobbyLocalState();
    Screens.show('screen-lobby');
    setLobbyPanel('list');
    el.roomListLoading.classList.remove('hidden');
    el.roomListEmpty.classList.add('hidden');
    el.roomListError.classList.add('hidden');
    el.roomList.innerHTML = '';
    fetchRooms();
    startPolling();
  }

  function resetLobbyLocalState() {
    stopPolling();
    isHost = false;
    roomCode = null;
    opponentDisplayName = null;
    opponentDeckSize = null;
    matchStarting = false;
    joining = false;
    pendingAction = null;
    el.roomLabelTop.textContent = '';
    hideToast();
    setRoomListInteractive(true);
  }

  function setLobbyPanel(name) {
    el.roomListBody.classList.toggle('hidden', name !== 'list');
    el.lobbyPanelWaiting.classList.toggle('hidden', name !== 'waiting');
  }

  async function ensureConnected() {
    await Net.connect();
    if (!netHandlersRegistered) {
      registerNetHandlers();
      netHandlersRegistered = true;
    }
  }

  // ---- polling (spec §6.2.3: 3s interval + manual refresh, no push) ---------
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(fetchRooms, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // .refreshing spins the refresh icon (css/pvp-components.css) for both the
  // manual-click and the 3s-auto-poll case, and also for the §6.2.6 auto-
  // refresh right after a rejected join -- same request either way, just
  // different triggers, so one visual cue covers all of them.
  async function fetchRooms() {
    el.btnLobbyRefresh.classList.add('refreshing');
    try {
      const data = await API.rooms.list();
      renderRoomList(data.rooms || []);
    } catch (err) {
      showRoomListErrorState();
    } finally {
      el.btnLobbyRefresh.classList.remove('refreshing');
    }
  }

  function formatRelativeTime(createdAtMs) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
    if (elapsedSec < 60) return `${elapsedSec}초 전`;
    const elapsedMin = Math.floor(elapsedSec / 60);
    return `${elapsedMin}분 전`;
  }

  // spec §6.2.2: only host display name + relative wait time per row, newest
  // first (server already sorts descending -- see rooms.js's listOpenRooms()).
  // spec §6.2.5: empty state is visually distinct from the network-error
  // state (§6.2.5's last paragraph) -- both go through this same render path
  // by first clearing whichever of the two was showing before.
  // Markup per row (.room-host/.room-wait/.room-row-arrow + icon-chevron-
  // right) lifted from assets/mockups/screen-lobby.html -- the chevron is
  // hidden until hover/focus (pure CSS) as the only affordance hinting a row
  // is clickable at all.
  function renderRoomList(rooms) {
    el.roomListLoading.classList.add('hidden');
    el.roomListError.classList.add('hidden');
    el.roomList.innerHTML = '';

    if (!rooms.length) {
      el.roomListEmpty.classList.remove('hidden');
      return;
    }
    el.roomListEmpty.classList.add('hidden');

    rooms.forEach((room) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'room-row';
      row.innerHTML =
        `<span class="room-host">${escapeHtml(room.hostDisplayName)}</span>` +
        `<span class="room-wait">${formatRelativeTime(room.createdAt)}</span>` +
        `<svg class="room-row-arrow"><use href="#icon-chevron-right"></use></svg>`;
      row.addEventListener('click', () => onRoomRowClick(room.id));
      el.roomList.appendChild(row);
    });
  }

  function showRoomListErrorState() {
    el.roomListLoading.classList.add('hidden');
    el.roomList.innerHTML = '';
    el.roomListEmpty.classList.add('hidden');
    el.roomListError.classList.remove('hidden');
  }

  function setRoomListInteractive(enabled) {
    el.roomList.classList.toggle('room-list-busy', !enabled);
    el.btnLobbyCreate.disabled = !enabled;
  }

  function showToast(message) {
    el.lobbyToastText.textContent = message;
    el.lobbyToast.classList.remove('hidden');
    clearTimeout(toastTimer);
    // spec §6.2.6 step 2: "약 2~3초 후 자동으로 사라짐".
    toastTimer = setTimeout(hideToast, 2500);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    el.lobbyToast.classList.add('hidden');
    el.lobbyToastText.textContent = '';
  }

  // ---- 방 만들기 (spec §6.2.1 step 2) -----------------------------------------
  async function onCreateRoomClick() {
    stopPolling();
    pendingAction = 'create';
    el.lobbyWaitingTitle.textContent = '방 만들기';
    el.lobbyWaitingSubtitle.textContent = '상대를 기다리는 중...';
    el.btnLobbyWaitingBack.classList.remove('hidden'); // host can cancel the wait
    setLobbyPanel('waiting');
    setWaitingStatusWaiting();
    try {
      await ensureConnected();
      // deckSize (QA finding #3): the opponent's client relays this straight
      // back to us as opponent.deckSize once they join -- see
      // registerNetHandlers()'s opponent_joined handling below.
      Net.send('room_create', { deckSize: selectedDeck.total });
    } catch (err) {
      pendingAction = null;
      setWaitingStatusError(err.message);
    }
  }

  function setWaitingStatusWaiting() {
    el.lobbyWaitingStatus.innerHTML = '<span class="spinner"></span>상대를 기다리는 중...';
  }

  function setWaitingStatusError(message) {
    el.lobbyWaitingStatus.innerHTML = `<span style="color:var(--crimson); font-size:11.5px;">${escapeHtml(message)}</span>`;
  }

  // Shared "matched!" flash (assets/mockups/screen-lobby.html's own note:
  // the SAME .opponent-found component is reused for both the host, who
  // sees it once someone joins their room, and the joiner, who sees it the
  // instant their own room_join succeeds -- only the wording differs).
  function setWaitingOpponentFound(name, joinerPerspective) {
    const text = joinerPerspective ? `${escapeHtml(name)} 님과 매칭되었습니다` : `${escapeHtml(name)} 님이 입장했습니다`;
    el.lobbyWaitingStatus.innerHTML =
      `<span class="opponent-found"><svg class="icon"><use href="#icon-crown"></use></svg>${text}</span>` +
      `<div class="lobby-waiting" style="margin-top:8px;"><span class="spinner"></span>매치를 준비하는 중...</div>`;
  }

  // ---- 방 목록에서 행 클릭 = 즉시 참가 시도 (spec §6.2.1 step 3) ------------------
  async function onRoomRowClick(roomId) {
    if (joining) return;
    joining = true;
    pendingAction = 'join';
    setRoomListInteractive(false);
    hideToast();
    try {
      await ensureConnected();
      Net.send('room_join', { code: roomId, deckSize: selectedDeck.total });
    } catch (err) {
      joining = false;
      pendingAction = null;
      setRoomListInteractive(true);
      showToast(err.message || '방에 참가하지 못했습니다');
    }
  }

  // ---- back navigation --------------------------------------------------------
  function onBackFromWaiting() {
    if (roomCode && Net.isConnected()) Net.send('leave_room');
    isHost = false;
    roomCode = null;
    opponentDisplayName = null;
    pendingAction = null;
    el.roomLabelTop.textContent = '';
    setLobbyPanel('list');
    fetchRooms();
    startPolling();
  }

  function onBackFromList() {
    stopPolling();
    Net.close();
    resetLobbyLocalState();
    Screens.show('screen-deck-select');
  }

  // ===========================================================================
  // Relay message handling
  // ===========================================================================

  function registerNetHandlers() {
    Net.on('room_created', (msg) => {
      pendingAction = null;
      isHost = true;
      roomCode = msg.code;
      setWaitingStatusWaiting();
    });

    Net.on('opponent_joined', (msg) => {
      setWaitingOpponentFound(msg.opponent.displayName, false);
      onBothPresent(msg.opponent.displayName, msg.opponent.deckSize);
    });

    // Fires when THIS client's own room_join succeeds -- the relay
    // guarantees a room only ever appears in the list (and is therefore only
    // ever clickable) while its host is still connected, so `msg.opponent`
    // here should always be present; the null branch is defensive only.
    // spec §6.2.1 step 3: "성공하면 화면에 호스트의 표시 이름이 나타나고
    // 자동으로 매치 시작 시퀀스로 전환된다" -- flashes the same shared
    // .opponent-found "matched!" panel the host uses (assets/mockups/
    // screen-lobby.html's own note on reusing that pattern for the joiner),
    // then Battle.start() takes over moments later via turn_started.
    Net.on('room_joined', (msg) => {
      joining = false;
      pendingAction = null;
      setRoomListInteractive(true);
      isHost = false;
      roomCode = msg.code;
      stopPolling();
      if (msg.opponent) {
        el.lobbyWaitingTitle.textContent = '매치 참가';
        el.lobbyWaitingSubtitle.textContent = '';
        el.btnLobbyWaitingBack.classList.add('hidden'); // already resolved -- nothing left to cancel
        setLobbyPanel('waiting');
        setWaitingOpponentFound(msg.opponent.displayName, true);
        onBothPresent(msg.opponent.displayName, msg.opponent.deckSize);
      } else {
        startPolling();
        showToast('방을 찾을 수 없습니다. 다시 시도해주세요.');
      }
    });

    Net.on('turn_started', (msg) => {
      handleTurnStarted(msg);
    });

    Net.on('error', (msg) => {
      handleRelayError(msg);
    });

    Net.onClose(() => {
      // Only worth surfacing if we were still mid-lobby (not yet handed off
      // to AL.startMatch) -- once a match has started this session doesn't
      // do anything further with the socket anyway.
      if (matchStarting) return;
      if (el.lobbyScreen.classList.contains('hidden')) return;
      if (!el.lobbyPanelWaiting.classList.contains('hidden')) {
        setWaitingStatusError('서버와의 연결이 끊어졌습니다.');
        return;
      }
      if (joining) {
        joining = false;
        pendingAction = null;
        setRoomListInteractive(true);
        showToast('서버와의 연결이 끊어졌습니다.');
      }
    });
  }

  // spec §6.2.6: a join rejected by the server (room already full, or
  // cancelled/gone) is the fill-race case -- stay on the list screen, show
  // the exact inline toast wording the spec specifies, and auto-refresh the
  // list immediately so the stale row is gone before the player can click it
  // again. Room-create failures get their own (rarer) error surface in the
  // waiting panel instead, since that's a different pending action.
  function handleRelayError(msg) {
    if (pendingAction === 'join') {
      pendingAction = null;
      joining = false;
      setRoomListInteractive(true);
      showToast('이미 다른 플레이어가 참가한 방입니다');
      fetchRooms();
      return;
    }
    if (pendingAction === 'create') {
      pendingAction = null;
      setWaitingStatusError(msg.message);
      return;
    }
    // Shouldn't normally happen at this stage of the flow, but don't fail
    // silently on an unexpected relay error.
    window.alert(msg.message);
  }

  // Deterministic room-id hash -> 'host' or 'guest' goes first. See the file
  // header for why this exists instead of naming the opponent's accountId
  // directly.
  function hashRoomCode(code) {
    let h = 0;
    for (let i = 0; i < code.length; i++) {
      h = (h * 31 + code.charCodeAt(i)) | 0;
    }
    return h;
  }

  function hostGoesFirst() {
    return (Math.abs(hashRoomCode(roomCode)) % 2) === 0;
  }

  function onBothPresent(displayName, deckSize) {
    opponentDisplayName = displayName;
    opponentDeckSize = typeof deckSize === 'number' ? deckSize : null;

    const iAmFirst = isHost ? hostGoesFirst() : !hostGoesFirst();
    if (iAmFirst) {
      Net.send('start_match', { firstAccountId: account.id });
    }
    // Else: wait for the other client's start_match to produce the
    // TURN_STARTED broadcast below -- never send our own guess.
  }

  function handleTurnStarted(msg) {
    if (matchStarting) return; // idempotent guard -- server already dedupes start_match, this just prevents a second AL.startMatch() call client-side
    if (!selectedDeck) return; // defensive -- shouldn't fire before a deck was chosen
    matchStarting = true;
    stopPolling();

    const isFirstPlayer = msg.activeAccountId === account.id;
    const deckIds = expandDeck(selectedDeck.cards);

    // opponentDeckSize (QA finding #3, docs/qa/online-pvp-milestone.md): the
    // relay now carries the opponent's real deck size on room_joined/
    // opponent_joined (server/src/ws/protocol.js), captured above in
    // onBothPresent(). Passed straight through here so js/state.js's
    // startMatch() sizes state.opponent's public deck-count display (spec
    // §7.2) correctly instead of falling back to our own deck's length.
    AL.startMatch({
      deck: deckIds,
      isFirstPlayer,
      opponentName: opponentDisplayName,
      opponentDeckSize,
      // Cosmetic-only opponent bust variant (art-direction.md §8.5 rev.4) --
      // seeded from the room id (known identically by both clients, same
      // source hashRoomCode() already uses for the first-player coin flip)
      // purely so a match "feels" consistent, not because it needs to be
      // deterministic for any gameplay reason.
      opponentPortrait: ['a', 'b', 'c'][Math.abs(hashRoomCode(roomCode)) % 3],
    });

    // Hand off to js/battle.js (plan.md 4.7) for everything that happens
    // DURING the match: peer-to-peer action relay, the 24s timer, disconnect/
    // forfeit, match-end. msg.deadline is turn 1's server-stamped deadline --
    // see Battle.start()'s doc comment for why it's passed explicitly here
    // rather than relying on Battle's own turn_started listener to catch
    // this exact first message.
    Battle.start(account.id, msg.deadline);
  }

  // "다시 플레이" (spec §6.4): return to deck-select to start a genuinely
  // fresh match, reusing the account this module already has from the match
  // that just ended (showDeckSelect() stores it) rather than needing the
  // caller to pass it again.
  function playAgain() {
    if (!account) return;
    showDeckSelect(account);
  }

  function init() {
    cache();
    el.btnDeckSelectBack.addEventListener('click', () => App.returnToMainMenu());

    el.btnLobbyCreate.addEventListener('click', onCreateRoomClick);
    el.btnLobbyCreateEmpty.addEventListener('click', onCreateRoomClick);
    el.btnLobbyBackToDeck.addEventListener('click', onBackFromList);
    el.btnLobbyRefresh.addEventListener('click', fetchRooms);
    el.btnLobbyRetry.addEventListener('click', fetchRooms);

    el.btnLobbyWaitingBack.addEventListener('click', onBackFromWaiting);
  }

  return { init, showDeckSelect, playAgain };
})();
