/* ARCANE LEDGER — match history screen (plan.md Phase 5.1, spec §6.5).
 *
 * Same self-contained module shape as js/deck.js: own tiny piece of DOM,
 * shown/hidden via the shared Screens.show() helper, no participation in
 * AL.state/UI's battle render loop.
 *
 * The win/loss count header is NOT a separate fetched value -- spec §6.5
 * calls it "아래 리스트에서 계산되는 파생값" (a derived value from the list
 * below), and server/src/routes/matchHistory.js deliberately returns only
 * the list for that reason. This module tallies the response itself, which
 * also means the header reflects the same up-to-100 window as the list
 * (not an untracked lifetime total) -- consistent with spec's "범위: 최근
 * 100경기까지만" framing them as the same bounded view.
 */
const History = (() => {
  const el = {};

  function cache() {
    el.screen = document.getElementById('screen-match-history');
    el.status = document.getElementById('history-status');
    el.wins = document.getElementById('history-wins');
    el.losses = document.getElementById('history-losses');
    el.list = document.getElementById('history-list');
    el.btnBack = document.getElementById('btn-history-back');
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

  // spec §6.5: "승" / "패", with "기권승" shown as "승 (기권)" via a
  // secondary label inside the same gold chip -- no third color, matching
  // assets/mockups/screen-match-history.html's markup exactly.
  function buildResultChip(result) {
    const chip = document.createElement('span');
    if (result === 'loss') {
      chip.className = 'result-chip loss';
      chip.textContent = '패';
      return chip;
    }
    chip.className = 'result-chip win';
    chip.textContent = '승';
    if (result === 'win_forfeit') {
      const tag = document.createElement('span');
      tag.className = 'forfeit-tag';
      tag.textContent = '(기권)';
      chip.appendChild(tag);
    }
    return chip;
  }

  function renderHeader(matches) {
    let wins = 0;
    let losses = 0;
    matches.forEach((m) => {
      if (m.result === 'loss') losses += 1;
      else wins += 1; // 'win' or 'win_forfeit' both count as a win, per spec §6.5
    });
    el.wins.textContent = String(wins);
    el.losses.textContent = String(losses);
  }

  function renderList(matches) {
    el.list.innerHTML = '';
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '아직 플레이한 매치가 없습니다';
      el.list.appendChild(empty);
      return;
    }
    matches.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'history-row';

      row.appendChild(buildResultChip(m.result));

      const opponent = document.createElement('span');
      opponent.className = 'history-opponent';
      opponent.textContent = m.opponentDisplayName;
      row.appendChild(opponent);

      const date = document.createElement('span');
      date.className = 'history-date';
      date.textContent = m.playedAt;
      row.appendChild(date);

      el.list.appendChild(row);
    });
  }

  async function show() {
    Screens.show('screen-match-history');
    setStatus('불러오는 중...');
    el.list.innerHTML = '';
    el.wins.textContent = '0';
    el.losses.textContent = '0';
    try {
      const data = await API.matchHistory.list();
      setStatus(null);
      renderHeader(data.matches);
      renderList(data.matches);
    } catch (err) {
      const message = err instanceof API.ApiError && err.status === 401
        ? '세션이 만료되었습니다. 다시 로그인해주세요.'
        : `전적을 불러오지 못했습니다: ${err.message}`;
      setStatus(message);
    }
  }

  function init() {
    cache();
    el.btnBack.addEventListener('click', () => App.returnToMainMenu());
  }

  return { init, show };
})();
