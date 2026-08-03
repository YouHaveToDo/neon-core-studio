/* ARCANE LEDGER — deck-select -> lobby -> match-start flow
 * (plan.md 4.4/4.5/4.6, spec-online-pvp.md §6.1-§6.3).
 *
 * Self-contained module, same shape as js/deck.js/js/auth.js (own DOM cache
 * + state + event wiring, reached only via Screens.show()). Talks to the
 * relay through js/ws.js (Net) and, once a match is confirmed to start,
 * hands off to js/state.js's AL.startMatch() -- this file owns everything
 * BEFORE the battle screen exists (deck choice, room code, coin flip); it
 * does not touch AL.state directly beyond that one handoff call, and does
 * not implement any in-battle networking (applyRemoteAction wiring is
 * Phase 4.7, explicitly out of scope here).
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
 * messages even start): a deterministic function of the room code (known
 * identically, verbatim, by both clients -- the host generated/received it
 * from ROOM_CREATED, the guest typed the same string in to join) decides
 * whether the HOST or the GUEST goes first. Each client only ever sends
 * start_match naming itself, and only when that deterministic function says
 * IT is the winner -- so across the two clients, start_match is sent from
 * exactly one side, no accountId exchange required, no race. The room code
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
  let roomCode = null;
  let opponentDisplayName = null;
  let matchStarting = false; // guards double-handling of turn_started
  let netHandlersRegistered = false;
  let copyResetTimer = null;

  function cache() {
    el.deckSelectScreen = document.getElementById('screen-deck-select');
    el.deckSelectStatus = document.getElementById('deck-select-status');
    el.deckSelectList = document.getElementById('deck-select-list');
    el.btnDeckSelectBack = document.getElementById('btn-deck-select-back');

    el.lobbyScreen = document.getElementById('screen-lobby');
    el.roomLabelTop = document.getElementById('room-label');

    el.panelSelect = document.getElementById('lobby-panel-select');
    el.btnLobbyCreate = document.getElementById('btn-lobby-create');
    el.btnLobbyShowJoin = document.getElementById('btn-lobby-show-join');
    el.btnLobbyBackToDeck = document.getElementById('btn-lobby-back-to-deck');

    el.panelCreate = document.getElementById('lobby-panel-create');
    el.lobbyCode = document.getElementById('lobby-code');
    el.btnLobbyCopy = document.getElementById('btn-lobby-copy');
    el.lobbyCreateStatus = document.getElementById('lobby-create-status');
    el.btnLobbyCreateBack = document.getElementById('btn-lobby-create-back');

    el.panelJoin = document.getElementById('lobby-panel-join');
    el.lobbyJoinForm = document.getElementById('lobby-join-form');
    el.lobbyJoinInput = document.getElementById('lobby-join-input');
    el.btnLobbyJoinSubmit = document.getElementById('btn-lobby-join-submit');
    el.lobbyJoinError = document.getElementById('lobby-join-error');
    el.lobbyJoinStatus = document.getElementById('lobby-join-status');
    el.btnLobbyJoinBack = document.getElementById('btn-lobby-join-back');
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
    showLobbySelect();
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
  // Lobby (spec §6.2)
  // ===========================================================================

  function showLobbySelect() {
    resetLobbyLocalState();
    Screens.show('screen-lobby');
    setLobbyPanel('select');
  }

  function resetLobbyLocalState() {
    isHost = false;
    roomCode = null;
    opponentDisplayName = null;
    matchStarting = false;
    el.roomLabelTop.textContent = '';
    el.lobbyJoinInput.value = '';
    el.btnLobbyJoinSubmit.disabled = true;
    setJoinError(null);
    setJoinConnecting(false);
    setCreateStatusWaiting();
  }

  function setLobbyPanel(name) {
    el.panelSelect.classList.toggle('hidden', name !== 'select');
    el.panelCreate.classList.toggle('hidden', name !== 'create');
    el.panelJoin.classList.toggle('hidden', name !== 'join');
  }

  async function ensureConnected() {
    await Net.connect();
    if (!netHandlersRegistered) {
      registerNetHandlers();
      netHandlersRegistered = true;
    }
  }

  // ---- 방 만들기 -------------------------------------------------------------
  async function onCreateRoomClick() {
    setLobbyPanel('create');
    setCreateStatusWaiting();
    el.lobbyCode.textContent = '......';
    try {
      await ensureConnected();
      Net.send('room_create');
    } catch (err) {
      setCreateStatusError(err.message);
    }
  }

  function setCreateStatusWaiting() {
    el.lobbyCreateStatus.innerHTML = '<span class="spinner"></span>상대를 기다리는 중...';
  }

  function setCreateStatusError(message) {
    el.lobbyCreateStatus.innerHTML = `<span class="lobby-inline-error">${escapeHtml(message)}</span>`;
  }

  function setOpponentFound(containerEl, name) {
    containerEl.classList.remove('hidden');
    containerEl.innerHTML =
      `<span class="opponent-found"><svg class="icon"><use href="#icon-crown"></use></svg>${escapeHtml(name)} 님이 입장했습니다</span>` +
      `<div class="lobby-waiting" style="margin-top:8px;"><span class="spinner"></span>매치를 준비하는 중...</div>`;
  }

  function onCopyClick() {
    if (!roomCode) return;
    const done = () => {
      el.btnLobbyCopy.classList.add('copied');
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => el.btnLobbyCopy.classList.remove('copied'), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(roomCode).then(done).catch(() => fallbackCopy(roomCode, done));
    } else {
      fallbackCopy(roomCode, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (err) { /* ignore -- no copy UX feedback if this also fails */ }
    document.body.removeChild(ta);
  }

  // ---- 코드로 참가하기 ---------------------------------------------------------
  function onShowJoinClick() {
    setLobbyPanel('join');
    el.lobbyJoinInput.value = '';
    el.btnLobbyJoinSubmit.disabled = true;
    setJoinError(null);
    setJoinConnecting(false);
    el.lobbyJoinInput.focus();
  }

  function onJoinInput() {
    el.lobbyJoinInput.value = el.lobbyJoinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    el.btnLobbyJoinSubmit.disabled = el.lobbyJoinInput.value.length !== 6;
  }

  function setJoinError(message) {
    if (!message) {
      el.lobbyJoinError.classList.add('hidden');
      el.lobbyJoinError.textContent = '';
      return;
    }
    el.lobbyJoinError.classList.remove('hidden');
    el.lobbyJoinError.textContent = message;
  }

  function setJoinConnecting(connecting) {
    el.lobbyJoinStatus.classList.toggle('hidden', !connecting);
    el.lobbyJoinInput.disabled = connecting;
    el.btnLobbyJoinSubmit.disabled = connecting || el.lobbyJoinInput.value.length !== 6;
  }

  async function onJoinSubmit() {
    const code = el.lobbyJoinInput.value;
    if (code.length !== 6) return;
    setJoinError(null);
    setJoinConnecting(true);
    try {
      await ensureConnected();
      Net.send('room_join', { code });
    } catch (err) {
      setJoinConnecting(false);
      setJoinError(err.message);
    }
  }

  // ---- back navigation --------------------------------------------------------
  function onBackFromSubPanel() {
    if (roomCode && Net.isConnected()) Net.send('leave_room');
    isHost = false;
    roomCode = null;
    opponentDisplayName = null;
    el.roomLabelTop.textContent = '';
    setLobbyPanel('select');
  }

  function onBackFromSelect() {
    Net.close();
    resetLobbyLocalState();
    Screens.show('screen-deck-select');
  }

  // ===========================================================================
  // Relay message handling
  // ===========================================================================

  function registerNetHandlers() {
    Net.on('room_created', (msg) => {
      isHost = true;
      roomCode = msg.code;
      el.lobbyCode.textContent = roomCode;
      el.roomLabelTop.textContent = `방 ${roomCode}`;
      setCreateStatusWaiting();
    });

    Net.on('room_joined', (msg) => {
      isHost = false;
      roomCode = msg.code;
      el.roomLabelTop.textContent = `방 ${roomCode}`;
      // Lock the form (success either way -- we're in the room now) without
      // going through setJoinConnecting(false), which HIDES the status
      // container (correct for the error-retry path, wrong here: we're
      // about to write the opponent-found line into that same container).
      el.lobbyJoinInput.disabled = true;
      el.btnLobbyJoinSubmit.disabled = true;
      if (msg.opponent) {
        onBothPresent(msg.opponent.displayName, el.lobbyJoinStatus);
      } else {
        // Shouldn't happen in the create-then-join ordering the relay
        // enforces (a room can't exist without its creator still connected,
        // per server/src/ws/rooms.js), but stay in a sane "connected, no
        // opponent yet" state rather than assuming a match can start.
        el.lobbyJoinStatus.classList.remove('hidden');
        el.lobbyJoinStatus.innerHTML = '<span class="spinner"></span>상대를 기다리는 중...';
      }
    });

    Net.on('opponent_joined', (msg) => {
      onBothPresent(msg.opponent.displayName, el.lobbyCreateStatus);
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
      // do anything further with the socket anyway (Phase 4.7 scope).
      if (matchStarting) return;
      if (!el.lobbyScreen.classList.contains('hidden')) {
        setCreateStatusError('서버와의 연결이 끊어졌습니다.');
        setJoinConnecting(false);
        setJoinError('서버와의 연결이 끊어졌습니다.');
      }
    });
  }

  function handleRelayError(msg) {
    if (!el.panelJoin.classList.contains('hidden')) {
      setJoinConnecting(false);
      setJoinError(msg.message);
      return;
    }
    if (!el.panelCreate.classList.contains('hidden')) {
      setCreateStatusError(msg.message);
      return;
    }
    // Select panel or elsewhere -- no dedicated slot for this, but don't
    // fail silently.
    window.alert(msg.message);
  }

  // Deterministic room-code hash -> 'host' or 'guest' goes first. See the
  // file header for why this exists instead of naming the opponent's
  // accountId directly.
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

  function onBothPresent(displayName, statusEl) {
    opponentDisplayName = displayName;
    setOpponentFound(statusEl, displayName);

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

    const isFirstPlayer = msg.activeAccountId === account.id;
    const deckIds = expandDeck(selectedDeck.cards);

    // NOTE (protocol gap, flagged in the task report): the relay has no
    // message carrying the opponent's real deck size, so
    // opponentDeckSize is left unset here and js/state.js's startMatch()
    // falls back to using OUR OWN deck length as a placeholder for the
    // opponent's public deck-count display (spec §7.2). That placeholder is
    // wrong whenever the two decks differ in size -- a real fix needs a
    // protocol addition (e.g. start_match or a dedicated message carrying
    // deck size), which is server work out of this session's scope.
    AL.startMatch({
      deck: deckIds,
      isFirstPlayer,
      opponentName: opponentDisplayName,
    });
  }

  function init() {
    cache();
    el.btnDeckSelectBack.addEventListener('click', () => App.returnToMainMenu());

    el.btnLobbyCreate.addEventListener('click', onCreateRoomClick);
    el.btnLobbyShowJoin.addEventListener('click', onShowJoinClick);
    el.btnLobbyBackToDeck.addEventListener('click', onBackFromSelect);

    el.btnLobbyCopy.addEventListener('click', onCopyClick);
    el.btnLobbyCreateBack.addEventListener('click', onBackFromSubPanel);

    el.lobbyJoinInput.addEventListener('input', onJoinInput);
    el.lobbyJoinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !el.btnLobbyJoinSubmit.disabled) onJoinSubmit();
    });
    el.btnLobbyJoinSubmit.addEventListener('click', onJoinSubmit);
    el.btnLobbyJoinBack.addEventListener('click', onBackFromSubPanel);
  }

  return { init, showDeckSelect };
})();
