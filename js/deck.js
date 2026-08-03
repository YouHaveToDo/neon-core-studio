/* ARCANE LEDGER — deck management screens (plan.md Phase 3.1/3.2, spec §5.4-§5.5).
 *
 * Self-contained module (own state + rendering + event wiring), separate
 * from the AL/UI battle-engine pair: deck management has nothing to do with
 * AL.state (battle state) and doesn't need to participate in AL.onChange's
 * render loop, so it manages its own small piece of DOM independently, only
 * ever showing/hiding whole <section class="screen"> elements via the
 * shared `Screens.show()` helper (js/screens.js).
 *
 * As of plan.md 4.1, real login/signup UI exists (js/auth.js) and the app
 * gates entry on it (js/main.js) -- every screen in this file is reached
 * only after a session cookie already exists, so the 401 fallback message
 * below is now just defense in depth (e.g. a session expiring mid-visit),
 * not the expected common case it was before this task.
 */
const Deck = (() => {
  const DECK_MIN_SIZE = 20;
  const DECK_MAX_SIZE = 30;
  const MAX_COPIES_PER_CARD = 3;

  // Pool display order per spec §5.5: "정렬은 타입별: Attack -> Skill ->
  // Power, 기존 GDD §6.2 순서 그대로". CARD_DEFS (js/data.js) is a single
  // object whose keys are already in GDD §6.2 order; grouping by type with
  // a stable sort preserves that relative order within each group, which is
  // exactly the mockup's Attack(6)/Skill(5)/Power(3) sequence.
  const TYPE_ORDER = { attack: 0, skill: 1, power: 2 };
  const CARD_POOL_ORDER = Object.keys(CARD_DEFS).sort(
    (a, b) => TYPE_ORDER[CARD_DEFS[a].type] - TYPE_ORDER[CARD_DEFS[b].type]
  );

  const el = {};
  const state = {
    slots: [null, null, null], // index 0 = slot 1, ...
    editing: null, // { slot, name, cards: {cardId: count} } while the editor screen is open
    loadError: null,
  };

  let nameSaveTimer = null;

  function cache() {
    el.slotsScreen = document.getElementById('screen-deck-slots');
    el.slotsList = document.getElementById('deck-slots-list');
    el.slotsStatus = document.getElementById('deck-slots-status');
    el.btnSlotsBack = document.getElementById('btn-deck-slots-back');

    el.editorScreen = document.getElementById('screen-deck-editor');
    el.editorNameInput = document.getElementById('deck-editor-name-input');
    el.editorCounter = document.getElementById('deck-editor-counter');
    el.editorHint = document.getElementById('deck-editor-hint');
    el.editorError = document.getElementById('deck-editor-error');
    el.poolGrid = document.getElementById('deck-editor-pool-grid');
    el.deckList = document.getElementById('deck-editor-decklist');
    el.deckListLabel = document.getElementById('deck-editor-decklist-label');
    el.btnEditorDone = document.getElementById('btn-deck-editor-done');

    el.modalRoot = document.getElementById('modal-root');
    el.modalBody = document.getElementById('modal-body');
  }

  // ---- helpers ------------------------------------------------------------
  function deckTotal(cards) {
    return Object.values(cards).reduce((sum, n) => sum + n, 0);
  }

  function typeColorVar(type) {
    if (type === 'attack') return '--crimson';
    if (type === 'skill') return '--steel';
    return '--gold';
  }

  function typeIcon(type) {
    if (type === 'attack') return 'icon-sword';
    if (type === 'skill') return 'icon-shield';
    return 'icon-crown';
  }

  // Builds the browsing-area card node -- same visual component as the
  // battle hand (css .card.type-*), independent copy of ui.js's
  // buildCardNode since that helper lives inside UI's closure and isn't
  // exported. Kept deliberately minimal (no selection/afford state -- the
  // pool card is never "selected" the way a hand card is).
  function buildPoolCardNode(cardId) {
    const card = CARD_DEFS[cardId];
    const node = document.createElement('div');
    node.className = `card type-${card.type}`;
    node.innerHTML = `
      <div class="card-cost">${card.cost}</div>
      <div class="card-icon-chip"><svg><use href="#${typeIcon(card.type)}"></use></svg></div>
      <div class="card-name">${card.name}</div>
      <hr class="card-divider" />
      <div class="card-text">${card.text}</div>
    `;
    return node;
  }

  function normalizeDeck(raw) {
    // Server response already carries total/valid (server/src/routes/decks.js
    // serializeDeck) -- trust it rather than recomputing, so the two never
    // disagree.
    return raw;
  }

  // ---- slot list screen (§5.4) --------------------------------------------
  async function showSlots() {
    state.editing = null;
    Screens.show('screen-deck-slots');
    el.slotsList.innerHTML = '';
    setSlotsStatus('불러오는 중...');
    try {
      const data = await API.decks.list();
      state.slots = data.slots;
      state.loadError = null;
      setSlotsStatus(null);
      renderSlotList();
    } catch (err) {
      state.loadError = err;
      const message = err instanceof API.ApiError && err.status === 401
        ? '세션이 만료되었습니다. 다시 로그인해주세요.'
        : `덱 목록을 불러오지 못했습니다: ${err.message}`;
      setSlotsStatus(message);
    }
  }

  function setSlotsStatus(message) {
    if (!message) {
      el.slotsStatus.classList.add('hidden');
      el.slotsStatus.textContent = '';
      return;
    }
    el.slotsStatus.classList.remove('hidden');
    el.slotsStatus.textContent = message;
  }

  function renderSlotList() {
    el.slotsList.innerHTML = '';
    for (let slot = 1; slot <= 3; slot++) {
      const deck = state.slots[slot - 1];
      const tile = document.createElement('div');

      if (deck) {
        tile.className = 'deck-slot-tile';
        if (!deck.valid) {
          const badge = document.createElement('span');
          badge.className = 'badge-incomplete';
          badge.textContent = '미완성';
          tile.appendChild(badge);
        }
        const nameEl = document.createElement('div');
        nameEl.className = 'slot-name';
        nameEl.textContent = deck.name;
        tile.appendChild(nameEl);

        const countEl = document.createElement('div');
        countEl.className = 'slot-count';
        countEl.textContent = `${deck.total}/${DECK_MAX_SIZE}장`;
        tile.appendChild(countEl);

        const actions = document.createElement('div');
        actions.className = 'slot-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-secondary';
        editBtn.textContent = '편집';
        editBtn.addEventListener('click', () => openEditor(slot));
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-secondary';
        deleteBtn.textContent = '삭제';
        deleteBtn.addEventListener('click', () => openDeleteConfirm(slot, deck.name));
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        tile.appendChild(actions);
      } else {
        tile.className = 'deck-slot-tile empty';
        tile.innerHTML = `<span class="plus">+</span><span>새 덱 만들기</span>`;
        tile.addEventListener('click', () => openNewDeckModal(slot));
      }

      el.slotsList.appendChild(tile);
    }
  }

  // ---- new-deck-name modal (§5.3, entered from an empty slot tile) --------
  function openNewDeckModal(slot) {
    el.modalBody.innerHTML = `
      <h2>새 덱 만들기</h2>
      <p class="subtitle">슬롯 ${slot}</p>
      <div class="field">
        <input type="text" id="new-deck-name-input" class="deck-name-input" maxlength="20" placeholder="덱 이름 (선택)" />
      </div>
      <p id="new-deck-modal-error" class="editor-hint hidden"></p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="new-deck-cancel">취소</button>
        <button class="btn btn-primary" id="new-deck-create">만들기</button>
      </div>
    `;
    el.modalRoot.classList.remove('hidden');
    const input = document.getElementById('new-deck-name-input');
    input.focus();
    document.getElementById('new-deck-cancel').addEventListener('click', closeModal);
    document.getElementById('new-deck-create').addEventListener('click', () => createNewDeck(slot, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createNewDeck(slot, input.value);
    });
  }

  async function createNewDeck(slot, rawName) {
    const btn = document.getElementById('new-deck-create');
    if (btn) btn.disabled = true;
    try {
      const result = await API.decks.save(slot, { name: rawName, cards: {} });
      state.slots[slot - 1] = normalizeDeck(result);
      closeModal();
      openEditor(slot);
    } catch (err) {
      const errorEl = document.getElementById('new-deck-modal-error');
      if (errorEl) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
      }
      if (btn) btn.disabled = false;
    }
  }

  // ---- delete confirm modal (§5.4) ----------------------------------------
  function openDeleteConfirm(slot, name) {
    el.modalBody.innerHTML = `
      <h2>이 덱을 삭제하시겠습니까?</h2>
      <p class="subtitle">"${escapeHtml(name)}" — 되돌릴 수 없습니다.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="delete-cancel">취소</button>
        <button class="btn btn-delete" id="delete-confirm">삭제</button>
      </div>
    `;
    el.modalRoot.classList.remove('hidden');
    document.getElementById('delete-cancel').addEventListener('click', closeModal);
    document.getElementById('delete-confirm').addEventListener('click', () => confirmDelete(slot));
  }

  async function confirmDelete(slot) {
    const btn = document.getElementById('delete-confirm');
    if (btn) btn.disabled = true;
    try {
      await API.decks.remove(slot);
      state.slots[slot - 1] = null;
      closeModal();
      renderSlotList();
    } catch (err) {
      if (btn) btn.disabled = false;
      // Deletion failing is rare (network/auth only, no validation to fail
      // on) -- surface it plainly rather than building dedicated UI for it.
      window.alert(`삭제하지 못했습니다: ${err.message}`);
    }
  }

  function closeModal() {
    el.modalRoot.classList.add('hidden');
    el.modalBody.innerHTML = '';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- editor screen (§5.5) ------------------------------------------------
  function openEditor(slot) {
    const existing = state.slots[slot - 1];
    state.editing = {
      slot,
      name: existing ? existing.name : `덱 ${slot}`,
      cards: existing ? { ...existing.cards } : {},
    };
    Screens.show('screen-deck-editor');
    setEditorError(null);
    renderEditor();
    el.editorNameInput.focus();
  }

  function setEditorError(message) {
    if (!message) {
      el.editorError.classList.add('hidden');
      el.editorError.textContent = '';
      return;
    }
    el.editorError.classList.remove('hidden');
    el.editorError.textContent = message;
  }

  function renderEditor() {
    const editing = state.editing;
    if (!editing) return;

    el.editorNameInput.value = editing.name;

    const total = deckTotal(editing.cards);
    el.editorCounter.textContent = `덱: ${total}/${DECK_MAX_SIZE} (최소 ${DECK_MIN_SIZE})`;
    el.editorCounter.classList.toggle('invalid', total < DECK_MIN_SIZE);
    el.editorHint.classList.toggle('hidden', total >= DECK_MIN_SIZE);
    el.deckListLabel.textContent = `이 덱 (${total}장)`;

    renderPoolGrid(editing.cards, total);
    renderDeckList(editing.cards);
  }

  function renderPoolGrid(cards, total) {
    el.poolGrid.innerHTML = '';
    CARD_POOL_ORDER.forEach((cardId) => {
      const card = CARD_DEFS[cardId];
      const count = cards[cardId] || 0;
      const maxedOut = count >= MAX_COPIES_PER_CARD || total >= DECK_MAX_SIZE;

      const wrap = document.createElement('div');
      wrap.className = 'pool-card-wrap' + (maxedOut ? ' maxed' : '');
      wrap.appendChild(buildPoolCardNode(cardId));

      const badge = document.createElement('span');
      badge.className = 'pool-count-badge' + (count >= MAX_COPIES_PER_CARD ? ' full' : '');
      badge.style.setProperty('--card-type-color', `var(${typeColorVar(card.type)})`);
      badge.textContent = `${count}/${MAX_COPIES_PER_CARD}`;
      wrap.appendChild(badge);

      if (!maxedOut) {
        wrap.addEventListener('click', () => addCard(cardId));
      }
      el.poolGrid.appendChild(wrap);
    });
  }

  function renderDeckList(cards) {
    el.deckList.innerHTML = '';
    const ids = CARD_POOL_ORDER.filter((id) => (cards[id] || 0) > 0);
    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'deck-list-row';
      empty.textContent = '카드 풀에서 카드를 선택해 덱에 추가하세요.';
      el.deckList.appendChild(empty);
      return;
    }
    ids.forEach((cardId) => {
      const card = CARD_DEFS[cardId];
      const qty = cards[cardId];
      const row = document.createElement('div');
      row.className = 'deck-list-row';

      const cost = document.createElement('span');
      cost.className = 'row-cost';
      cost.style.setProperty('--card-type-color', `var(${typeColorVar(card.type)})`);
      cost.textContent = card.cost;

      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = card.name;

      const qtyEl = document.createElement('span');
      qtyEl.className = 'row-qty';
      qtyEl.textContent = `×${qty}`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'row-remove';
      removeBtn.innerHTML = '&minus;';
      removeBtn.addEventListener('click', () => removeCard(cardId));

      row.appendChild(cost);
      row.appendChild(name);
      row.appendChild(qtyEl);
      row.appendChild(removeBtn);
      el.deckList.appendChild(row);
    });
  }

  // Every click persists immediately (spec §5.5: no save/undo button).
  // Optimistic update: mutate + re-render local state first for instant
  // feedback, then persist; roll back + surface an error if the request
  // fails (e.g. session expired mid-edit).
  async function addCard(cardId) {
    const editing = state.editing;
    const count = editing.cards[cardId] || 0;
    const total = deckTotal(editing.cards);
    if (count >= MAX_COPIES_PER_CARD || total >= DECK_MAX_SIZE) return; // defense in depth; UI already disables this tile

    const prevCards = { ...editing.cards };
    editing.cards[cardId] = count + 1;
    renderEditor();
    try {
      await persistEditing();
      setEditorError(null);
    } catch (err) {
      editing.cards = prevCards;
      renderEditor();
      setEditorError(err.message);
    }
  }

  async function removeCard(cardId) {
    const editing = state.editing;
    const count = editing.cards[cardId] || 0;
    if (count <= 0) return;

    const prevCards = { ...editing.cards };
    if (count <= 1) delete editing.cards[cardId];
    else editing.cards[cardId] = count - 1;
    renderEditor();
    try {
      await persistEditing();
      setEditorError(null);
    } catch (err) {
      editing.cards = prevCards;
      renderEditor();
      setEditorError(err.message);
    }
  }

  async function persistEditing() {
    const editing = state.editing;
    const result = await API.decks.save(editing.slot, { name: editing.name, cards: editing.cards });
    const normalized = normalizeDeck(result);
    state.slots[editing.slot - 1] = normalized;
    // The server may have applied its own default/truncation to the name
    // (empty -> "덱 N", >20 chars truncated) -- reflect that back so the
    // input always shows what's actually saved.
    editing.name = normalized.name;
    el.editorNameInput.value = normalized.name;
  }

  function onNameInput(e) {
    state.editing.name = e.target.value;
    clearTimeout(nameSaveTimer);
    // spec §5.3 literally says "입력 즉시 반영" (save the instant you type),
    // but firing a network request per keystroke is wasteful and racy
    // (out-of-order responses could clobber a later keystroke's save) --
    // debouncing is a judgment call noted in the report, backstopped by an
    // immediate flush on blur (onNameBlur) so nothing is lost if the field
    // loses focus before the debounce timer fires.
    nameSaveTimer = setTimeout(() => {
      persistEditing().catch((err) => setEditorError(err.message));
    }, 400);
  }

  function onNameBlur() {
    clearTimeout(nameSaveTimer);
    persistEditing().catch((err) => setEditorError(err.message));
  }

  async function onDone() {
    clearTimeout(nameSaveTimer);
    if (state.editing) {
      try {
        await persistEditing();
      } catch (err) {
        // Don't trap the player on the editor screen over a transient save
        // failure on the way out -- the last successful edit is already
        // persisted server-side; only the most recent (in-flight) one may
        // be lost. Surfacing via alert since there's no screen left to show
        // an inline error on after navigating away.
        window.alert(`마지막 변경사항을 저장하지 못했습니다: ${err.message}`);
      }
    }
    state.editing = null;
    renderSlotList();
    Screens.show('screen-deck-slots');
  }

  function init() {
    cache();
    el.btnSlotsBack.addEventListener('click', () => Screens.show('screen-main-menu'));
    el.btnEditorDone.addEventListener('click', onDone);
    el.editorNameInput.addEventListener('input', onNameInput);
    el.editorNameInput.addEventListener('blur', onNameBlur);
    el.modalRoot.addEventListener('click', (e) => {
      if (e.target === el.modalRoot) closeModal(); // click on backdrop
    });
  }

  return { init, showSlots };
})();
