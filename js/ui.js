/* ARCANE LEDGER — rendering. Reads AL.state and updates the DOM; never
 * mutates game state directly (that's state.js's job via user actions).
 *
 * ---- PvP restructure note (online-pvp-plan.md task 2.4) ----
 * The opponent panel below is a functional placeholder only — it reads the
 * new mirrored `state.opponent` shape (HP/mana/block/deck+discard/hand
 * counts + display name) instead of the old scripted-enemy portrait/intent
 * layout, which no longer applies to a real player opponent (spec-online-
 * pvp.md §7.2, §9). The actual visual redesign (opponent player-panel
 * layout, card-back art) is explicitly flagged as art debt for Phase 4.9 —
 * this task (2.4) only had to keep the state-reading side from crashing
 * against the new shape, not produce final visuals.
 */

const UI = (() => {
  const el = {};

  // Keyed reconciliation cache for the hand: state.player.handKeys[i] -> the
  // DOM node currently representing that card instance. Reused across
  // renders so existing cards are never destroyed/recreated (which used to
  // wipe out hover state and made a draw-in animation impossible) — only
  // genuinely new keys get a new node + the draw-in animation; keys that
  // vanished (played/discarded) get their node removed.
  const handNodes = new Map();
  let newDrawBatch = 0; // stagger counter, reset each renderHand() call

  function cache() {
    el.roomLabel = document.getElementById('room-label');

    el.btnHowtoTop = document.getElementById('btn-howto');
    el.howtoCardSlot = document.getElementById('howto-card-slot');
    el.btnHowtoClose = document.getElementById('btn-howto-close');

    el.opponentArea = document.getElementById('opponent-area');
    el.opponentName = document.getElementById('opponent-name');
    el.opponentHpFill = document.getElementById('opponent-hp-fill');
    el.opponentHpText = document.getElementById('opponent-hp-text');
    el.opponentBlockWrap = document.getElementById('opponent-block-wrap');
    el.opponentBlockText = document.getElementById('opponent-block-text');
    el.opponentManaGauge = document.getElementById('opponent-mana-gauge');
    el.opponentDrawCount = document.getElementById('opponent-draw-count');
    el.opponentDiscardCount = document.getElementById('opponent-discard-count');
    el.opponentHandCount = document.getElementById('opponent-hand-count');

    el.dmgLayer = document.getElementById('dmg-popup-layer');

    el.playerHpText = document.getElementById('player-hp-text');
    el.playerBlockWrap = document.getElementById('player-block-wrap');
    el.playerBlockText = document.getElementById('player-block-text');
    el.manaGauge = document.getElementById('mana-gauge');
    el.drawCount = document.getElementById('draw-count');
    el.discardCount = document.getElementById('discard-count');

    el.handArea = document.getElementById('hand-area');
    el.btnEndTurn = document.getElementById('btn-end-turn');
  }

  // `name` is one of AL.state.screen's values ('start'|'howto'|'battle'|
  // 'victory'|'defeat'); the corresponding element id is always
  // `screen-${name}`. Delegates to the shared Screens helper (js/screens.js)
  // so this never disagrees with deck.js/auth.js/main.js about what else on
  // the page needs to be hidden at the same time.
  function showScreen(name) {
    Screens.show('screen-' + name);
  }

  function render(state) {
    showScreen(state.screen);

    // room-label (topbar) is repurposed as a turn indicator now that there
    // is no more dungeon room sequence to label (spec §2).
    el.roomLabel.textContent = state.screen === 'battle'
      ? (state.turn === 'player' ? '내 턴' : '상대 턴')
      : '';

    // Outside of battle (and the how-to overlay, which can be reopened mid-
    // match and must return to an untouched hand) the hand cache is stale
    // by definition — drop both the DOM nodes and the reconciliation map so
    // the next match's fresh card keys can never collide with leftovers.
    if (state.screen !== 'battle' && state.screen !== 'howto' && handNodes.size > 0) {
      handNodes.clear();
      el.handArea.innerHTML = '';
    }

    // The ? (how-to-play) button only makes sense mid-match, reopened from
    // the battle screen per docs/design/onboarding.md section 3.
    el.btnHowtoTop.classList.toggle('hidden', state.screen !== 'battle');

    if (state.screen === 'howto') renderHowto(state);
    if (state.screen === 'battle') renderBattle(state);
  }

  // ---- Battle -------------------------------------------------------
  function renderBattle(state) {
    const opp = state.opponent;
    el.opponentName.textContent = opp.name || '상대';

    const hpPct = Math.max(0, (opp.hp / opp.maxHp) * 100);
    el.opponentHpFill.style.width = hpPct + '%';
    el.opponentHpText.textContent = `${opp.hp} / ${opp.maxHp}`;

    if (opp.block > 0) {
      el.opponentBlockWrap.classList.remove('hidden');
      el.opponentBlockText.textContent = opp.block;
    } else {
      el.opponentBlockWrap.classList.add('hidden');
    }

    renderMana(el.opponentManaGauge, opp.mana, opp.maxMana);
    el.opponentDrawCount.textContent = opp.drawPile.length;
    el.opponentDiscardCount.textContent = opp.discardPile.length;
    el.opponentHandCount.textContent = opp.hand.length;

    el.playerHpText.textContent = `${state.player.hp} / ${state.player.maxHp}`;
    if (state.player.block > 0) {
      el.playerBlockWrap.classList.remove('hidden');
      el.playerBlockText.textContent = state.player.block;
    } else {
      el.playerBlockWrap.classList.add('hidden');
    }

    renderMana(el.manaGauge, state.player.mana, state.player.maxMana);
    el.drawCount.textContent = state.player.drawPile.length;
    el.discardCount.textContent = state.player.discardPile.length;

    renderHand(state);

    el.btnEndTurn.disabled = state.turn !== 'player' || !!state.turnBusy;
  }

  function renderMana(gaugeEl, mana, maxMana) {
    if (!gaugeEl) return;
    gaugeEl.innerHTML = '';
    for (let i = 0; i < maxMana; i++) {
      const drop = document.createElement('span');
      drop.className = 'mana-drop ' + (i < mana ? 'filled' : 'empty');
      drop.innerHTML = `<svg viewBox="0 0 24 24"><use href="#icon-mana"></use></svg>`;
      gaugeEl.appendChild(drop);
    }
  }

  function typeIcon(type) {
    if (type === 'attack') return 'icon-sword';
    if (type === 'skill') return 'icon-shield';
    return 'icon-crown';
  }

  function buildCardNode(cardId, opts) {
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
    if (opts && opts.affordable === false) node.classList.add('unaffordable');
    if (opts && opts.selected) node.classList.add('selected');
    return node;
  }

  // Keyed reconciliation: state.player.hand/handKeys are index-matched
  // arrays (see js/state.js). A card instance keeps the same key for as
  // long as it stays in hand, so its DOM node — and any CSS animation/hover
  // state on it — survives re-renders untouched. Only keys that are new
  // this render get a freshly created node (and the draw-in animation);
  // only keys that disappeared get their node removed. Existing cards are
  // never rebuilt.
  function renderHand(state) {
    const hand = state.player.hand;
    const handKeys = state.player.handKeys;
    const currentKeys = new Set(handKeys);

    for (const [key, node] of handNodes) {
      if (!currentKeys.has(key)) {
        node.remove();
        handNodes.delete(key);
      }
    }

    newDrawBatch = 0;
    hand.forEach((cardId, i) => {
      const key = handKeys[i];
      const affordable = AL.canPlay(i);
      let node = handNodes.get(key);

      if (!node) {
        node = buildCardNode(cardId, {});
        node.dataset.key = key;
        handNodes.set(key, node);
        applyDrawInAnimation(node, newDrawBatch);
        newDrawBatch++;
      }

      node.dataset.index = i;
      node.classList.toggle('unaffordable', !affordable);
      node.classList.toggle('selected', state.selected === i);
      // appendChild on a node already in the DOM just relocates it — this
      // walks the whole hand in array order so the final DOM order always
      // matches state.player.hand, without ever detaching+recreating a node
      // that didn't move (browsers don't reset element state on relocation).
      el.handArea.appendChild(node);
    });
  }

  function applyDrawInAnimation(node, batchIndex) {
    node.classList.add('card-draw-in');
    node.style.setProperty('--draw-delay', (batchIndex * 70) + 'ms');
    node.addEventListener('animationend', () => {
      node.classList.remove('card-draw-in');
      node.style.removeProperty('--draw-delay');
    }, { once: true });
  }

  function onHandAreaClick(evt) {
    const cardEl = evt.target.closest('.card');
    if (!cardEl || cardEl.parentElement !== el.handArea) return;
    const index = Number(cardEl.dataset.index);
    if (Number.isNaN(index)) return;
    onHandCardClick(index, cardEl);
  }

  function onHandCardClick(index, node) {
    const state = AL.state;
    const cardId = state.player.hand[index];
    if (!cardId) return;
    const card = CARD_DEFS[cardId];

    if (card.target === 'self') {
      if (node) { node.classList.remove('card-draw-in'); node.classList.add('playing'); }
      setTimeout(() => AL.selectCard(index), 240);
    } else {
      // targeted card: just toggle target-selection state, no delay needed
      AL.selectCard(index);
    }
  }

  function onOpponentClick() {
    const state = AL.state;
    if (state.selected === null || state.turn !== 'player' || state.turnBusy) return;
    const node = el.handArea.querySelector(`[data-index="${state.selected}"]`);
    if (node) { node.classList.remove('card-draw-in'); node.classList.add('playing'); }
    setTimeout(() => AL.targetOpponent(), 240);
  }

  // ---- How to Play (docs/design/onboarding.md) ---------------------------
  // Split out from renderHowto() (plan.md 4.1) so the pre-login "플레이 방법
  // 보기" entry point (spec §4.3, wired in main.js) can populate the demo
  // card without going through AL's render pipeline at all -- that path
  // never touches AL.state, since How to Play is the one screen explicitly
  // reachable before login.
  function ensureHowtoDemoCard() {
    if (!el.howtoCardSlot.firstChild) {
      // Reuse the same card-rendering logic as the hand so the example is a
      // real, in-sync DOM element, not a static mockup.
      const demoCard = buildCardNode('strike', {});
      el.howtoCardSlot.appendChild(demoCard);
    }
  }

  function renderHowto(state) {
    el.btnHowtoClose.textContent = state.howtoContext === 'first' ? '시작하기' : '닫기';
    ensureHowtoDemoCard();
  }

  // ---- FX (damage numbers, shake, heal) ---------------------------------
  function anchorFor(side) {
    return side === 'opponent' ? el.opponentHpText : el.playerHpText;
  }

  function spawnPopup(side, text, cls) {
    if (!el.dmgLayer) return;
    const anchor = anchorFor(side);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const layerRect = el.dmgLayer.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'dmg-popup ' + (cls || '');
    node.textContent = text;
    node.style.left = (rect.left - layerRect.left + rect.width / 2) + 'px';
    node.style.top = (rect.top - layerRect.top) + 'px';
    el.dmgLayer.appendChild(node);
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 1000);
  }

  function handleFx(name, payload) {
    const side = payload.side || 'player';
    if (name === 'damage') {
      if (payload.amount > 0) {
        spawnPopup(side, '-' + payload.amount, '');
      } else if (payload.blocked > 0) {
        spawnPopup(side, 'Blocked', 'block-pop');
      }
    } else if (name === 'block') {
      spawnPopup(side, '+' + payload.amount + ' Block', 'block-pop');
    } else if (name === 'heal') {
      spawnPopup(side, '+' + payload.amount, 'heal');
    }
  }

  function init() {
    cache();
    el.opponentArea.addEventListener('click', onOpponentClick);
    // Delegated (not per-card) listener: card nodes are now reused across
    // renders by renderHand(), so a single listener on the container avoids
    // ever having to attach/detach handlers as nodes come and go.
    el.handArea.addEventListener('click', onHandAreaClick);
    AL.onChange(render);
    AL.onFx(handleFx);
  }

  return { init, render, ensureHowtoDemoCard };
})();
