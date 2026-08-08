/* ARCANE LEDGER — shop screen (docs/design/card-shop-currency-proposal.md
 * §6-§7, Phase 6/7 of the card-shop-currency milestone).
 *
 * Same self-contained screen-module shape as js/deck.js/js/history.js: own
 * tiny piece of DOM, shown/hidden via Screens.show(), fetches its own data
 * on open, wires its own buttons. Backend (server/src/routes/economy.js,
 * Phase 4) and the pull mechanic itself are already correct and tested
 * (server/scripts/pull-smoke-test.js) -- this module is purely the client
 * wiring: GET /api/economy on open, POST /api/economy/pull on the button
 * click, and rendering all 3 documented pull responses (success / 400
 * insufficient_ink / 409 collection_complete).
 */
const Shop = (() => {
  const MAX_COPIES_PER_CARD = 3;

  const el = {};
  const state = {
    balance: 0,
    owned: {}, // { cardId: ownedCount }, from GET/POST /api/economy(/pull)
    // True once at least one card has been revealed since the shop screen
    // was last opened -- lets render() tell apart "opened already complete,
    // nothing to show in the reveal stage" (mockup's static 3rd state, no
    // .shop-pull-section at all) from "just completed the set with a live
    // pull in this session" (the last-pulled card should stay visible next
    // to the completion banner -- see pvp-components.css's "6.x shop /
    // gacha" comment on .shop-complete-banner). Reset to false on every
    // show().
    hasRevealed: false,
  };

  function cache() {
    el.status = document.getElementById('shop-status');
    el.error = document.getElementById('shop-error');
    el.inkAmount = document.getElementById('shop-ink-amount');
    el.pullSection = document.getElementById('shop-pull-section');
    el.revealStage = document.getElementById('shop-reveal-stage');
    el.revealFront = document.getElementById('shop-reveal-front');
    el.captionTitle = document.getElementById('shop-caption-title');
    el.captionSub = document.getElementById('shop-caption-sub');
    el.btnPull = document.getElementById('btn-shop-pull');
    el.pullBtnLabel = document.getElementById('shop-pull-btn-label');
    el.completeBanner = document.getElementById('shop-complete-banner');
    el.progressLabel = document.getElementById('shop-progress-label');
    el.poolGrid = document.getElementById('shop-pool-grid');
    el.btnBack = document.getElementById('btn-shop-back');
  }

  // ---- small render helpers (deliberately duplicated from js/deck.js's
  // typeColorVar/typeIcon/buildPoolCardNode rather than exported from that
  // module's closure -- same "self-contained module" tradeoff deck.js's own
  // header comment already documents for its copy of ui.js's buildCardNode).
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

  function buildCardNode(cardId) {
    const card = cardDefById(cardId);
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

  function isComplete() {
    return EXPANSION_POOL.every((id) => (state.owned[id] || 0) >= MAX_COPIES_PER_CARD);
  }

  function setStatus(message) {
    if (!message) {
      el.status.classList.add('hidden');
      el.status.textContent = '';
      return;
    }
    el.status.classList.remove('hidden');
    el.status.textContent = message;
  }

  function setError(message) {
    if (!message) {
      el.error.classList.add('hidden');
      el.error.textContent = '';
      return;
    }
    el.error.classList.remove('hidden');
    el.error.textContent = message;
  }

  // §7: same progress tiles as the deck editor's pool grid (locked/partial/
  // full), restricted to just the 8 expansion-pool ids (§6.1: the shop only
  // ever sells the expansion pool, core cards aren't shown here) -- read
  // only, no click-to-add behavior (that's the deck editor's job).
  function renderPoolGrid() {
    el.poolGrid.innerHTML = '';
    EXPANSION_POOL.forEach((cardId) => {
      const card = cardDefById(cardId);
      const count = state.owned[cardId] || 0;
      const locked = count === 0;

      const wrap = document.createElement('div');
      wrap.className = 'pool-card-wrap' + (locked ? ' locked' : (count >= MAX_COPIES_PER_CARD ? ' maxed' : ''));
      wrap.appendChild(buildCardNode(cardId));

      if (locked) {
        const lockBadge = document.createElement('span');
        lockBadge.className = 'pool-lock-badge';
        lockBadge.innerHTML = '<svg><use href="#icon-lock"></use></svg>';
        wrap.appendChild(lockBadge);
      } else {
        const badge = document.createElement('span');
        badge.className = 'pool-count-badge' + (count >= MAX_COPIES_PER_CARD ? ' full' : '');
        badge.style.setProperty('--card-type-color', `var(${typeColorVar(card.type)})`);
        badge.textContent = `${count}/${MAX_COPIES_PER_CARD}`;
        wrap.appendChild(badge);
      }

      el.poolGrid.appendChild(wrap);
    });
  }

  function render() {
    el.inkAmount.textContent = String(state.balance);

    const ownedTypes = EXPANSION_POOL.filter((id) => (state.owned[id] || 0) >= MAX_COPIES_PER_CARD).length;
    el.progressLabel.textContent = `확장 카드 진행 · ${ownedTypes}/${EXPANSION_POOL.length}종 완료`;
    renderPoolGrid();

    const complete = isComplete();
    el.completeBanner.classList.toggle('hidden', !complete);
    // §6.2's last paragraph: once the pool is fully owned, the pull button
    // is gone -- but if this completion was JUST reached by a live pull in
    // this session, keep the reveal stage/caption showing the last card the
    // player got (pvp-components.css's .shop-complete-banner comment) rather
    // than yanking it away the instant the set completes.
    el.pullSection.classList.toggle('hidden', complete && !state.hasRevealed);
    el.btnPull.classList.toggle('hidden', complete);
  }

  // ---- reveal stage -------------------------------------------------------
  function resetRevealStage() {
    // Force the flip back to the card-back face with no transition replay
    // (only relevant if the player pulled at least once, then somehow got
    // back here without a full page reload -- App.returnToMainMenu ->
    // Shop.show() again). Removing the class is enough; the CSS transition
    // only fires on user-visible pulls going forward.
    el.revealStage.classList.remove('revealed');
    el.revealFront.innerHTML = '';
    el.captionTitle.textContent = '뽑기 버튼을 눌러 카드를 획득하세요';
    el.captionSub.textContent = '가방(bag) 방식 — 이번 사이클에서 아직 3장 미만인 카드 중 하나가 나옵니다';
    el.pullBtnLabel.textContent = '뽑기';
  }

  function revealCard(cardId, ownedCount) {
    const card = cardDefById(cardId);
    el.revealFront.innerHTML = '';
    el.revealFront.appendChild(buildCardNode(cardId));
    // Force the flip transition to replay even on a second/third pull in the
    // same session: toggling the same class twice in a row (already
    // 'revealed' -> stays 'revealed') wouldn't retrigger anything, since the
    // transform is already at its end state. Removing the class, forcing a
    // reflow, then re-adding it is the standard CSS-transition-replay
    // pattern for exactly this case.
    el.revealStage.classList.remove('revealed');
    void el.revealStage.offsetWidth; // force reflow
    el.revealStage.classList.add('revealed');

    el.captionTitle.textContent = '카드를 획득했습니다!';
    el.captionSub.textContent = `${card.name} · ${ownedCount}/${MAX_COPIES_PER_CARD} 보유`;
    el.pullBtnLabel.textContent = '한 번 더 뽑기';
  }

  // ---- pull ---------------------------------------------------------------
  async function onPull() {
    el.btnPull.disabled = true;
    setError(null);
    try {
      const data = await API.economy.pull();
      state.balance = data.inkBalance;
      state.owned = data.expansionCards || {};
      state.hasRevealed = true;
      revealCard(data.cardId, state.owned[data.cardId] || 0);
      render();
    } catch (err) {
      if (err instanceof API.ApiError && err.status === 400 && err.data && err.data.error === 'insufficient_ink') {
        // §6.1: pull cost is a flat 50 Ink -- server's message already spells
        // out the exact shortfall ("잉크가 부족합니다 (필요 50, 보유 X)"), no
        // need to reconstruct it client-side.
        setError(err.data.message || '잉크가 부족합니다.');
        if (typeof err.data.inkBalance === 'number') {
          state.balance = err.data.inkBalance;
          el.inkAmount.textContent = String(state.balance);
        }
      } else if (err instanceof API.ApiError && err.status === 409 && err.data && err.data.error === 'collection_complete') {
        // Defensive per the task brief: the pull button is already hidden
        // once isComplete() is true, so this should only ever be reachable
        // via a race (e.g. two tabs pulling the last card at once). Server
        // is the authority -- resync ownership from its response and
        // re-render rather than trusting the client's stale state.
        state.owned = err.data.expansionCards || state.owned;
        render();
      } else {
        setError(`뽑기에 실패했습니다: ${err.message}`);
      }
    } finally {
      // Leave the button hidden (not just disabled) if the pull just
      // completed the set -- render() above already applied that via
      // isComplete(). Otherwise always re-enable.
      if (!isComplete()) el.btnPull.disabled = false;
    }
  }

  // ---- screen entry ---------------------------------------------------------
  async function show() {
    Screens.show('screen-shop');
    state.hasRevealed = false;
    resetRevealStage();
    setError(null);
    setStatus('불러오는 중...');
    try {
      const data = await API.economy.get();
      state.balance = data.inkBalance;
      state.owned = data.expansionCards || {};
      setStatus(null);
      render();
    } catch (err) {
      const message = err instanceof API.ApiError && err.status === 401
        ? '세션이 만료되었습니다. 다시 로그인해주세요.'
        : `상점 정보를 불러오지 못했습니다: ${err.message}`;
      setStatus(message);
    }
  }

  function init() {
    cache();
    el.btnPull.addEventListener('click', onPull);
    el.btnBack.addEventListener('click', () => App.returnToMainMenu());
  }

  return { init, show };
})();
