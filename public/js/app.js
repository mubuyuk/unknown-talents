/**
 * Winner – frontend
 * Hämtar data, räknar statistik och ranking, hanterar admin.
 */

const API = '/api';

/** Sparat admin-lösenord (sessionStorage) */
function getAdminToken() {
  return sessionStorage.getItem('winner_admin');
}

function setAdminToken(token) {
  if (token) sessionStorage.setItem('winner_admin', token);
  else sessionStorage.removeItem('winner_admin');
}

/** Headers för admin-anrop */
function adminHeaders() {
  const token = getAdminToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };
}

/** Hämtar spelare och matcher från servern */
async function fetchStats() {
  const res = await fetch(API + '/stats');
  if (!res.ok) throw new Error('Kunde inte hämta data');
  return res.json();
}

/** Hämtar session: anmälda spelare samt genererade (spikade) lag */
async function fetchSession() {
  const res = await fetch(API + '/session');
  if (!res.ok) throw new Error('Kunde inte hämta session');
  const data = await res.json();
  return {
    playerIds: data.playerIds || [],
    generatedTeams: data.generatedTeams || null
  };
}

/**
 * Beräknar statistik per spelare.
 * Om spelaren har manuellt sparade wins/losses/draws används dessa; annars beräknas från matcher.
 * lastResults från matcher; streak/längsta vinststreak från matcher plus valfri prefixWinStreak (fiktiva vinster före historiken).
 */
function computeStats(players, matches) {
  const byId = {};
  const playerResults = {};
  players.forEach((p) => {
    playerResults[p.id] = [];
  });

  // Beräkna W/L/D från matcher (för spelare utan manuell statistik och för lastResults/streak)
  const computedFromMatches = {};
  players.forEach((p) => {
    computedFromMatches[p.id] = { wins: 0, losses: 0, draws: 0 };
  });
  matches.forEach((m) => {
    const winners = new Set(m.winnerIds || []);
    const losers = new Set(m.loserIds || []);
    const drawIds = new Set(m.drawIds || []);
    const isDraw = drawIds.size > 0;
    if (isDraw) {
      drawIds.forEach((id) => {
        if (computedFromMatches[id]) {
          computedFromMatches[id].draws++;
          playerResults[id].push('D');
        }
      });
    } else {
      players.forEach((p) => {
        if (winners.has(p.id)) {
          computedFromMatches[p.id].wins++;
          playerResults[p.id].push('W');
        } else if (losers.has(p.id)) {
          computedFromMatches[p.id].losses++;
          playerResults[p.id].push('L');
        }
      });
    }
  });

  // Slå ihop: använd manuell statistik om spelaren har den, annars från matcher
  players.forEach((p) => {
    const manual = typeof p.wins === 'number' || typeof p.losses === 'number' || typeof p.draws === 'number';
    const wins = manual ? (p.wins ?? 0) : computedFromMatches[p.id].wins;
    const losses = manual ? (p.losses ?? 0) : computedFromMatches[p.id].losses;
    const draws = manual ? (p.draws ?? 0) : computedFromMatches[p.id].draws;
    const matches = wins + losses + draws;
    const winPct = matches > 0 ? Math.round((wins / matches) * 100) : 0;
    const raw = playerResults[p.id];
    const prefix = Math.max(0, Math.floor(Number(p.prefixWinStreak)) || 0);
    const r = prefix > 0 ? [...Array(prefix).fill('W'), ...raw] : raw;
    let currentStreak = 0;
    let longestWinStreak = 0;
    if (r.length > 0) {
      const last = r[r.length - 1];
      if (last === 'W') {
        let c = 0;
        for (let i = r.length - 1; i >= 0 && r[i] === 'W'; i--) c++;
        currentStreak = c;
      } else if (last === 'L') {
        let c = 0;
        for (let i = r.length - 1; i >= 0 && r[i] === 'L'; i--) c++;
        currentStreak = -c;
      }
      let cur = 0;
      for (let i = 0; i < r.length; i++) {
        if (r[i] === 'W') {
          cur++;
          if (cur > longestWinStreak) longestWinStreak = cur;
        } else cur = 0;
      }
    }
    byId[p.id] = {
      wins,
      losses,
      draws,
      matches,
      winPct,
      currentStreak,
      lastResults: raw.slice(-3).reverse(),
      longestWinStreak,
    };
  });

  return byId;
}

/**
 * Sorterar spelare enligt ranking:
 * - Minst 5 matcher: sorteras först på vinstprocent (högst först), sedan matcher (fler först).
 * - Färre än 5 matcher: kommer efter, sorterade på matcher (fler först), sedan vinstprocent.
 */
function rankPlayers(players, statsById) {
  const withEnough = [];
  const notEnough = [];
  players.forEach((p) => {
    const s = statsById[p.id];
    if (s.matches >= 5) withEnough.push(p);
    else notEnough.push(p);
  });
  withEnough.sort((a, b) => {
    const sa = statsById[a.id];
    const sb = statsById[b.id];
    if (sb.winPct !== sa.winPct) return sb.winPct - sa.winPct;
    return sb.matches - sa.matches;
  });
  notEnough.sort((a, b) => {
    const sa = statsById[a.id];
    const sb = statsById[b.id];
    if (sb.matches !== sa.matches) return sb.matches - sa.matches;
    return sb.winPct - sa.winPct;
  });
  return [...withEnough, ...notEnough];
}

/**
 * Vid lika "poäng" (t.ex. flest vinster eller längsta vinststreak): högst vinstprocent,
 * därefter fler spelade matcher, därefter lägre spelar-id (stabilt).
 */
function pickPlayerAmongTiedMax(players, statsById, getMetric) {
  let maxMetric = -1;
  for (const p of players) {
    const m = getMetric(statsById[p.id]);
    if (m > maxMetric) maxMetric = m;
  }
  if (maxMetric <= 0) return { player: null, value: 0 };
  const tied = players.filter((p) => getMetric(statsById[p.id]) === maxMetric);
  tied.sort((a, b) => {
    const sa = statsById[a.id];
    const sb = statsById[b.id];
    if (sb.winPct !== sa.winPct) return sb.winPct - sa.winPct;
    if (sb.matches !== sa.matches) return sb.matches - sa.matches;
    return a.id - b.id;
  });
  return { player: tied[0], value: maxMetric };
}

/** Formaterar streak: vinster med 🔥, förluster visas först från 3 st med 🥶 */
function formatStreak(currentStreak) {
  if (currentStreak === 0) return '–';
  if (currentStreak > 1) return currentStreak + ' 🔥';
  if (currentStreak >= -2) return '–';
  return currentStreak + ' 🥶';
}

/** Öppnar Redigera statistik för knappar med data-attribut (admin). */
function bindEditStatsButtons(container) {
  container.querySelectorAll('.btn-edit-stats').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('edit-stats-player-id').value = btn.getAttribute('data-player-id');
      document.getElementById('edit-stats-wins').value = btn.getAttribute('data-wins') || '0';
      document.getElementById('edit-stats-losses').value = btn.getAttribute('data-losses') || '0';
      document.getElementById('edit-stats-draws').value = btn.getAttribute('data-draws') || '0';
      document.getElementById('edit-stats-prefix-win-streak').value = btn.getAttribute('data-prefix-win-streak') || '0';
      document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
      document.getElementById('edit-stats-modal').classList.remove('hidden');
    });
  });
}

function editStatsButton(p, s, label) {
  return `<button type="button" class="btn btn-edit-stats" data-player-id="${p.id}" data-wins="${s.wins}" data-losses="${s.losses}" data-draws="${s.draws}" data-prefix-win-streak="${p.prefixWinStreak ?? 0}" title="Redigera statistik">${label}</button>`;
}

function lastResultsHtml(results) {
  return results.map((r) => `<span class="${r === 'W' ? 'w' : r === 'L' ? 'l' : 'd'}">${r}</span>`).join('');
}

function highscoreIds(players, statsById) {
  const most = pickPlayerAmongTiedMax(players, statsById, (s) => s.wins);
  const longest = pickPlayerAmongTiedMax(players, statsById, (s) => s.longestWinStreak || 0);
  return {
    mostWinsId: most.player && most.value > 0 ? most.player.id : null,
    longestStreakId: longest.player && longest.value > 0 ? longest.player.id : null
  };
}

function nameWithIcons(p, ids) {
  let icons = '';
  if (ids.longestStreakId === p.id) icons += '<span class="name-icon" title="Längsta vinststreak">⭐</span>';
  if (ids.mostWinsId === p.id) icons += '<span class="name-icon" title="Flest vinster">🏆</span>';
  return icons + '<span class="player-name">' + escapeHtml(p.name) + '</span>';
}

function renderRanking(players, statsById, orderedPlayers) {
  const list = document.getElementById('ranking-body');
  list.removeAttribute('aria-busy');
  window._lastStats = statsById;

  if (orderedPlayers.length === 0) {
    list.innerHTML = '<li class="rank-message empty-state">Inga spelare än. Logga in som admin och lägg till spelare.</li>';
    return;
  }

  const ids = highscoreIds(players, statsById);
  let dividerShown = false;
  list.innerHTML = orderedPlayers
    .map((p, index) => {
      const s = statsById[p.id];
      let divider = '';
      if (!dividerShown && s.matches < 5 && index > 0) {
        dividerShown = true;
        divider = '<li class="rank-divider" aria-hidden="true">Färre än 5 matcher</li>';
      }
      const streak = formatStreak(s.currentStreak);
      const form = s.lastResults.map((r) => `<span class="dot dot-${r.toLowerCase()}"></span>`).join('');
      const pos = index + 1;
      return (
        divider +
        `<li class="rank-item${pos <= 3 && s.matches >= 5 ? ' is-top is-top-' + pos : ''}" data-player-id="${p.id}" tabindex="0" role="button" aria-haspopup="dialog">` +
        `<span class="rank-pos">${pos}</span>` +
        '<span class="rank-main">' +
        `<span class="rank-name">${nameWithIcons(p, ids)}</span>` +
        `<span class="rank-sub">${s.matches} matcher · <b class="w">${s.wins}W</b> <b class="l">${s.losses}L</b> <b class="d">${s.draws}D</b></span>` +
        '</span>' +
        '<span class="rank-side">' +
        `<span class="rank-pct">${s.matches > 0 ? s.winPct + '<small>%</small>' : '–'}</span>` +
        `<span class="rank-meta">${streak !== '–' ? '<span class="rank-streak">' + streak + '</span>' : ''}<span class="rank-form" aria-label="Senaste ${s.lastResults.length}: ${s.lastResults.join(', ') || 'inga'}">${form}</span></span>` +
        '</span>' +
        '</li>'
      );
    })
    .join('');
}

/** Bottenark med all statistik för en spelare. */
function openPlayerSheet(playerId) {
  const data = window._lastData;
  const statsById = window._lastStats;
  if (!data || !statsById) return;
  const p = data.players.find((x) => x.id === playerId);
  const s = p && statsById[p.id];
  if (!s) return;
  const ids = highscoreIds(data.players, statsById);
  document.getElementById('player-sheet-title').innerHTML = nameWithIcons(p, ids);
  const body = document.getElementById('player-sheet-body');
  body.innerHTML =
    '<div class="sheet-hero">' +
    `<div><span class="sheet-big">${s.matches > 0 ? s.winPct + '%' : '–'}</span><span class="sheet-label">Vinst %</span></div>` +
    `<div><span class="sheet-big">${s.matches}</span><span class="sheet-label">Matcher</span></div>` +
    '</div>' +
    '<dl class="rank-details-grid">' +
    `<div><dt>Vinster</dt><dd class="w">${s.wins}</dd></div>` +
    `<div><dt>Förluster</dt><dd class="l">${s.losses}</dd></div>` +
    `<div><dt>Oavgjort</dt><dd class="d">${s.draws}</dd></div>` +
    `<div><dt>Streak</dt><dd>${formatStreak(s.currentStreak)}</dd></div>` +
    `<div><dt>Längsta vinststreak</dt><dd>${s.longestWinStreak || 0}</dd></div>` +
    `<div><dt>Senaste 3 <small>(nyast först)</small></dt><dd class="last-matches">${lastResultsHtml(s.lastResults) || '–'}</dd></div>` +
    '</dl>' +
    (getAdminToken() ? editStatsButton(p, s, '✏️ Redigera statistik') : '');
  bindEditStatsButtons(body);
  document.getElementById('player-sheet').classList.remove('hidden');
  document.getElementById('btn-close-player-sheet').focus();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Visar ett framgångsmeddelande (toast) */
/** Visar ett kort meddelande. type: 'success' | 'error' */
function showToast(message, type = 'success') {
  const region = document.getElementById('toast-region') || document.body;
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = '<span class="toast-icon" aria-hidden="true">' + (type === 'error' ? '!' : '✓') + '</span><span class="toast-text"></span>';
  toast.querySelector('.toast-text').textContent = message;
  let hidden = false;
  const hide = () => {
    if (hidden) return;
    hidden = true;
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  };
  toast.addEventListener('click', hide);
  region.appendChild(toast);
  while (region.children.length > 3) region.firstElementChild.remove();
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(hide, type === 'error' ? 6000 : 3000);
}

function showSuccessMessage(message) {
  showToast(message, 'success');
}

function showErrorMessage(message) {
  showToast(message, 'error');
}

function populatePlayerCheckboxes(players) {
  const winnersEl = document.getElementById('winners-checkboxes');
  const losersEl = document.getElementById('losers-checkboxes');
  const drawEl = document.getElementById('draw-checkboxes');
  if (!winnersEl || !losersEl || !drawEl) return;

  const makeLabel = (p, side) =>
    `<label><input type="checkbox" data-player-id="${p.id}" data-side="${side}"> ${escapeHtml(p.name)}</label>`;

  winnersEl.innerHTML = players.map((p) => makeLabel(p, 'winner')).join('');
  losersEl.innerHTML = players.map((p) => makeLabel(p, 'loser')).join('');
  drawEl.innerHTML = players.map((p) => makeLabel(p, 'draw')).join('');

  updateRegisterMatchSummary(players);
  winnersEl.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => updateRegisterMatchSummary(window._lastData?.players)));
  losersEl.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => updateRegisterMatchSummary(window._lastData?.players)));
  drawEl.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => updateRegisterMatchSummary(window._lastData?.players)));
}

function updateRegisterMatchSummary(players) {
  const nameById = {};
  (players || []).forEach((p) => { nameById[p.id] = p.name || '?'; });
  const isDraw = document.getElementById('match-draw')?.checked;
  const winnerCbs = document.querySelectorAll('#winners-checkboxes input:checked');
  const loserCbs = document.querySelectorAll('#losers-checkboxes input:checked');
  const drawCbs = document.querySelectorAll('#draw-checkboxes input:checked');
  const winIds = Array.from(winnerCbs).map((cb) => parseInt(cb.dataset.playerId, 10));
  const loseIds = Array.from(loserCbs).map((cb) => parseInt(cb.dataset.playerId, 10));
  const drawIds = Array.from(drawCbs).map((cb) => parseInt(cb.dataset.playerId, 10));
  const winNames = winIds.map((id) => nameById[id] || id).join(', ');
  const loseNames = loseIds.map((id) => nameById[id] || id).join(', ');
  const drawNames = drawIds.map((id) => nameById[id] || id).join(', ');

  const elW = document.getElementById('register-summary-winners');
  const elL = document.getElementById('register-summary-losers');
  const elD = document.getElementById('register-summary-draw');
  const rowW = document.getElementById('register-summary-winners-row');
  const rowL = document.getElementById('register-summary-losers-row');
  const rowD = document.getElementById('register-summary-draw-row');
  if (elW) elW.textContent = winIds.length + ' – ' + (winNames || '–');
  if (elL) elL.textContent = loseIds.length + ' – ' + (loseNames || '–');
  if (elD) elD.textContent = drawIds.length + ' – ' + (drawNames || '–');
  if (rowW) rowW.classList.toggle('hidden', !!isDraw);
  if (rowL) rowL.classList.toggle('hidden', !!isDraw);
  if (rowD) rowD.classList.toggle('hidden', !isDraw);
}

function fillEditLatestMatchForm(match, players) {
  const winnersEl = document.getElementById('edit-match-winners-checkboxes');
  const losersEl = document.getElementById('edit-match-losers-checkboxes');
  const drawEl = document.getElementById('edit-match-draw-checkboxes');
  const drawWrap = document.getElementById('edit-match-draw-wrap');
  const teamsWrap = document.getElementById('edit-match-teams-wrap');
  if (!winnersEl || !losersEl || !drawEl || !drawWrap || !teamsWrap) return;

  const winnerIds = new Set(match.winnerIds || []);
  const loserIds = new Set(match.loserIds || []);
  const drawIds = new Set(match.drawIds || []);
  const isDraw = drawIds.size > 0;

  const makeLabel = (p, side, checked) =>
    `<label><input type="checkbox" data-player-id="${p.id}" data-side="${side}" ${checked ? ' checked' : ''}> ${escapeHtml(p.name)}</label>`;

  winnersEl.innerHTML = (players || []).map((p) => makeLabel(p, 'winner', winnerIds.has(p.id))).join('');
  losersEl.innerHTML = (players || []).map((p) => makeLabel(p, 'loser', loserIds.has(p.id))).join('');
  drawEl.innerHTML = (players || []).map((p) => makeLabel(p, 'draw', drawIds.has(p.id))).join('');

  drawWrap.classList.toggle('hidden', !isDraw);
  teamsWrap.classList.toggle('hidden', isDraw);
}

function openEditLatestMatchModal() {
  const data = window._lastData;
  if (!data || !data.matches || data.matches.length === 0) {
    showErrorMessage('Ingen match att redigera.');
    return;
  }
  const sorted = (data.matches || []).filter((m) => m.date).sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  const latest = sorted[0];
  if (!latest) return;
  fillEditLatestMatchForm(latest, data.players);
  document.getElementById('edit-latest-match-modal').classList.remove('hidden');
}

function populatePlayerDeleteSelect(players) {
  const select = document.getElementById('player-to-delete');
  if (!select) return;
  
  select.innerHTML = '<option value="">Välj spelare...</option>' +
    players.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

function toggleDrawMatchUI(isDraw) {
  document.getElementById('match-teams').classList.toggle('hidden', isDraw);
  document.getElementById('match-draw-teams').classList.toggle('hidden', !isDraw);
  if (!isDraw) {
    document.querySelectorAll('#draw-checkboxes input').forEach((cb) => (cb.checked = false));
  } else {
    document.querySelectorAll('#winners-checkboxes input, #losers-checkboxes input').forEach((cb) => (cb.checked = false));
  }
}

function renderHighscore(players, statsById) {
  const { player: mostWinsPlayer, value: mostWins } = pickPlayerAmongTiedMax(
    players,
    statsById,
    (s) => s.wins
  );
  const { player: longestStreakPlayer, value: longestStreak } = pickPlayerAmongTiedMax(
    players,
    statsById,
    (s) => s.longestWinStreak || 0
  );

  // Rendera flest vinster
  const mostWinsEl = document.getElementById('most-wins');
  if (mostWinsPlayer && mostWins > 0) {
    mostWinsEl.innerHTML =
      `<span class="highscore-name">🏆 ${escapeHtml(mostWinsPlayer.name)}</span>` +
      `<span class="highscore-count"> x <span class="highscore-number">${mostWins}</span></span>`;
  } else {
    mostWinsEl.textContent = 'Ingen data än';
  }

  // Rendera längsta streak
  const longestStreakEl = document.getElementById('longest-streak');
  if (longestStreakPlayer && longestStreak > 0) {
    longestStreakEl.innerHTML =
      `<span class="highscore-name">⭐ ${escapeHtml(longestStreakPlayer.name)}</span>` +
      `<span class="highscore-count"> x <span class="highscore-number">${longestStreak}</span></span>`;
  } else {
    longestStreakEl.textContent = 'Ingen data än';
  }
}

function renderSeasonInfo(matches) {
  const currentYear = new Date().getFullYear();
  const seasonEl = document.getElementById('season-year');
  const matchesEl = document.getElementById('matches-count');
  
  if (seasonEl) {
    seasonEl.textContent = currentYear;
  }
  
  if (matchesEl) {
    matchesEl.textContent = matches.length;
  }
}

const INITIAL_MATCH_HISTORY = 3;
const MATCH_HISTORY_MORE = 5;

function formatMatchDate(isoString) {
  if (!isoString) return '–';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '–';
  const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function renderMatchHistory(players, matches) {
  const listEl = document.getElementById('match-history-list');
  const moreBtn = document.getElementById('match-history-more');
  if (!listEl) return;

  const nameById = {};
  (players || []).forEach((p) => { nameById[p.id] = p.name || '?'; });

  const sorted = (matches || [])
    .filter((m) => m.date)
    .sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  const total = sorted.length;

  let visibleCount = window._matchHistoryVisible != null ? window._matchHistoryVisible : INITIAL_MATCH_HISTORY;
  const toShow = sorted.slice(0, visibleCount);
  const isAdmin = !!getAdminToken();

  listEl.innerHTML = toShow
    .map((m, index) => {
      const isDraw = (m.drawIds || []).length > 0;
      const chips = (ids) => (ids || []).map((id) => '<span class="chip">' + escapeHtml(String(nameById[id] || id)) + '</span>').join('');
      let itemHtml;
      if (isDraw) {
        itemHtml =
          '<div class="match-history-item">' +
          '<div class="match-history-date">' + escapeHtml(formatMatchDate(m.date)) + '</div>' +
          '<div class="match-history-row match-history-draw"><span class="result-label">Oavgjort</span><span class="chips">' + (chips(m.drawIds) || '–') + '</span></div>';
      } else {
        itemHtml =
          '<div class="match-history-item">' +
          '<div class="match-history-date">' + escapeHtml(formatMatchDate(m.date)) + '</div>' +
          '<div class="match-history-row match-history-winners"><span class="result-label">Vinst</span><span class="chips">' + (chips(m.winnerIds) || '–') + '</span></div>' +
          '<div class="match-history-row match-history-losers"><span class="result-label">Förlust</span><span class="chips">' + (chips(m.loserIds) || '–') + '</span></div>';
      }
      if (index === 0 && isAdmin) {
        itemHtml +=
          '<div class="match-history-item-actions">' +
          '<button type="button" class="btn btn-secondary btn-edit-latest-match">Redigera</button>' +
          '<button type="button" class="btn btn-danger btn-delete-latest-match">Radera senaste</button>' +
          '</div>';
      }
      itemHtml += '</div>';
      return itemHtml;
    })
    .join('');

  listEl.removeAttribute('aria-busy');
  if (total === 0) {
    listEl.innerHTML = '<p class="match-history-empty empty-state">Inga matcher spelade än.</p>';
  }

  const countEl = document.getElementById('match-history-count');
  if (countEl) {
    countEl.textContent = total > 0 ? 'Visar ' + toShow.length + ' av ' + total + ' matcher' : '';
    countEl.classList.toggle('hidden', total === 0);
  }

  if (moreBtn) {
    moreBtn.classList.toggle('hidden', total <= INITIAL_MATCH_HISTORY || visibleCount >= total);
    moreBtn.textContent = visibleCount >= total ? 'Visa fler matcher' : 'Visa fler matcher';
    window._matchHistoryVisible = visibleCount;
  }
}

async function renderPaymentsSummary() {
  const body = document.getElementById('payments-body');
  const totalEl = document.getElementById('payments-total-amount');
  const matchCountEl = document.getElementById('payments-match-count');
  const priceEl = document.getElementById('payments-price');
  if (!body || !totalEl || !matchCountEl) return;
  try {
    const res = await fetch(API + '/admin/payments-summary', { headers: adminHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    const matchCount = data.matchCount || 0;
    const totalAmount = data.totalAmount || 0;
    if (priceEl && data.pricePerMatch != null) priceEl.textContent = data.pricePerMatch.toString();
    matchCountEl.textContent = matchCount.toString();
    totalEl.textContent = totalAmount.toFixed(2).replace('.', ',') + ' kr';
    const rows = (data.players || []).slice(0, 7).map(
      (p) =>
        '<tr>' +
        '<td>' + escapeHtml(p.name || '?') + '</td>' +
        '<td class="col-num">' + (p.matches || 0) + '</td>' +
        '<td class="col-num">' + (p.amount != null ? p.amount.toFixed(2).replace('.', ',') + ' kr' : '0,00 kr') + '</td>' +
        '</tr>'
    );
    body.innerHTML = rows.join('') || '<tr><td colspan="3">Inga betalningar än.</td></tr>';
  } catch (err) {
    // Tyst fel – betalningspanelen är extra-info för admin
  }
}

function showMoreMatchHistory() {
  const cur = window._matchHistoryVisible != null ? window._matchHistoryVisible : INITIAL_MATCH_HISTORY;
  window._matchHistoryVisible = cur + MATCH_HISTORY_MORE;
  if (window._lastData) {
    renderMatchHistory(window._lastData.players, window._lastData.matches);
  }
}

const MIN_PLAYERS_FOR_TEAMS = 10;

function updateSessionCount(count) {
  const countEl = document.getElementById('session-count');
  if (countEl) countEl.textContent = count + ' / ' + MIN_PLAYERS_FOR_TEAMS + ' spelare anmälda';
  const badge = document.getElementById('session-ready-badge');
  if (badge) badge.classList.toggle('hidden', count < MIN_PLAYERS_FOR_TEAMS);
  const bar = document.getElementById('session-progress-bar');
  if (bar) {
    bar.style.width = Math.min(100, (count / MIN_PLAYERS_FOR_TEAMS) * 100) + '%';
    bar.classList.toggle('is-ready', count >= MIN_PLAYERS_FOR_TEAMS);
  }
  const tabBadge = document.getElementById('tab-session-count');
  if (tabBadge) {
    tabBadge.textContent = count + '/' + MIN_PLAYERS_FOR_TEAMS;
    tabBadge.classList.toggle('is-ready', count >= MIN_PLAYERS_FOR_TEAMS);
  }
}

function sessionPlayerInner(p) {
  const initials = String(p.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return '<span class="avatar" aria-hidden="true">' + escapeHtml(initials) + '</span>' +
    '<span class="session-name">' + escapeHtml(p.name) + '</span>' +
    '<span class="session-check" aria-hidden="true"></span>';
}

function renderSession(players, session) {
  const container = document.getElementById('session-players');
  if (!container) return;

  const ids = session.playerIds || [];
  updateSessionCount(ids.length);

  const teams = session.generatedTeams;
  const block = document.getElementById('teams-result');
  if (teams && block) {
    const listA = document.getElementById('team-a-list');
    const listB = document.getElementById('team-b-list');
    const strategyTitle = document.getElementById('teams-strategy-title');
    listA.innerHTML = (teams.teamA || []).map((p) => '<li>' + escapeHtml(p.name) + '</li>').join('');
    listB.innerHTML = (teams.teamB || []).map((p) => '<li>' + escapeHtml(p.name) + '</li>').join('');
    if (strategyTitle) strategyTitle.textContent = 'Strategi: ' + (teams.strategy || 'random');
    block.classList.remove('hidden');
  } else if (block) {
    block.classList.add('hidden');
  }

  container.removeAttribute('aria-busy');
  if (players.length === 0) {
    container.innerHTML = '<p class="empty-state">Inga spelare än. Admin lägger till spelare.</p>';
    return;
  }
  container.innerHTML = players
    .map((p) => {
      const joined = ids.includes(p.id);
      return (
        `<label class="session-player${joined ? ' is-selected' : ''}">` +
        `<input type="checkbox" class="session-join-cb visually-hidden" data-player-id="${p.id}" ${joined ? 'checked' : ''}>` +
        sessionPlayerInner(p) +
        '</label>'
      );
    })
    .join('');

  container.querySelectorAll('.session-join-cb').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const row = cb.closest('.session-player');
      const playerId = parseInt(cb.dataset.playerId, 10);
      const joining = cb.checked;
      row.classList.toggle('is-selected', joining);
      row.classList.add('is-pending');
      cb.disabled = true;
      try {
        const res = await fetch(joining ? API + '/session/join' : API + '/session/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.playerIds) throw new Error(data.error || 'Anmälan sparades inte. Försök igen.');
        updateSessionCount(data.playerIds.length);
        if (window._lastSession) window._lastSession.playerIds = data.playerIds;
        if (getAdminToken()) {
          const fresh = await fetchSession();
          window._lastSession = fresh;
          updateAdminSessionUI(fresh);
        }
      } catch (err) {
        cb.checked = !joining;
        row.classList.toggle('is-selected', !joining);
        showErrorMessage(err instanceof TypeError ? 'Nätverksfel – anmälan sparades inte. Försök igen.' : err.message);
      } finally {
        row.classList.remove('is-pending');
        cb.disabled = false;
      }
    });
  });
}

function updateAdminSessionUI(session) {
  const count = (session.playerIds || []).length;
  const hasGenerated = !!(session.generatedTeams && session.generatedTeams.teamA);

  const btnGenerate = document.getElementById('btn-admin-generate-teams');
  const registerBlock = document.getElementById('admin-register-result');

  if (btnGenerate) btnGenerate.disabled = count < MIN_PLAYERS_FOR_TEAMS;
  const hint = document.getElementById('generate-hint');
  if (hint) {
    const missing = MIN_PLAYERS_FOR_TEAMS - count;
    hint.textContent = missing > 0 ? `Minst ${MIN_PLAYERS_FOR_TEAMS} anmälda krävs – ${missing} till.` : '';
  }
  if (registerBlock) registerBlock.classList.toggle('hidden', !hasGenerated);
}

async function loadAndRender() {
  try {
    const [data, session] = await Promise.all([fetchStats(), fetchSession()]);
    window._matchHistoryVisible = INITIAL_MATCH_HISTORY;
    const statsById = computeStats(data.players, data.matches);
    const ordered = rankPlayers(data.players, statsById);
    renderRanking(data.players, statsById, ordered);
    renderHighscore(data.players, statsById);
    renderSeasonInfo(data.matches);
    renderMatchHistory(data.players, data.matches);
    renderSession(data.players, session);
    if (getAdminToken()) {
      await renderPaymentsSummary();
    }
    if (getAdminToken()) updateAdminSessionUI(session);
    populatePlayerCheckboxes(data.players);
    populatePlayerDeleteSelect(data.players);
    window._lastData = data;
    window._lastSession = session;
  } catch (err) {
    console.error(err);
    renderLoadError();
  }
}

function renderLoadError() {
  const body = document.getElementById('ranking-body');
  const msg =
    '<div class="load-error"><p>Kunde inte ladda data. Kontrollera anslutningen och försök igen.</p>' +
    '<button type="button" class="btn btn-primary" data-retry>Försök igen</button></div>';
  body.innerHTML = body.tagName === 'TBODY' ? '<tr><td colspan="11">' + msg + '</td></tr>' : '<li class="rank-message">' + msg + '</li>';
  body.removeAttribute('aria-busy');
  showErrorMessage('Kunde inte ladda data.');
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-retry]')) loadAndRender();
});

const VIEWS = ['tabell', 'anmalan', 'historik', 'admin'];

function showView(name) {
  if (!VIEWS.includes(name) || (name === 'admin' && !getAdminToken())) name = 'tabell';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  document.querySelectorAll('.view-tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  });
  document.body.dataset.view = name;
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
}

document.querySelectorAll('.view-tab').forEach((t) => {
  t.addEventListener('click', () => showView(t.dataset.view));
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.view-tab')].filter((x) => x.offsetParent);
    const next = tabs[(tabs.indexOf(t) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    showView(next.dataset.view);
  });
});
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
showView(location.hash.slice(1) || 'tabell');

function toggleAdminSection(show) {
  document.body.classList.toggle('is-admin', !!show);
  if (!show && document.body.dataset.view === 'admin') showView('tabell');
  const section = document.getElementById('admin-section');
  const logoutBtn = document.getElementById('btn-logout');
  const adminBtn = document.getElementById('btn-admin');
  const infoSection = document.getElementById('info-section');
  if (show) {
    section.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    adminBtn.classList.add('hidden');
    if (infoSection) infoSection.classList.add('hidden');
  } else {
    section.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    adminBtn.classList.remove('hidden');
    if (infoSection) infoSection.classList.remove('hidden');
  }
}

// —— Login ——
document.getElementById('btn-admin').addEventListener('click', () => {
  document.getElementById('login-modal').classList.remove('hidden');
  document.getElementById('password').focus();
});

document.getElementById('btn-close-login').addEventListener('click', () => {
  document.getElementById('login-modal').classList.add('hidden');
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password').value;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  
  submitBtn.disabled = true;
  submitBtn.textContent = 'Loggar in...';
  
  try {
    const res = await fetch(API + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    
    if (res.ok && data.ok) {
      setAdminToken(password);
      document.getElementById('login-modal').classList.add('hidden');
      document.getElementById('password').value = '';
      toggleAdminSection(true);
      loadAndRender();
      showSuccessMessage('Inloggad som admin');
    } else {
      showErrorMessage(data.error || 'Felaktigt lösenord');
      document.getElementById('password').value = '';
    }
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

// Logga ut
document.getElementById('btn-logout').addEventListener('click', () => {
  setAdminToken(null);
  toggleAdminSection(false);
  loadAndRender();
});

// —— Redigera statistik (admin) ——
document.getElementById('btn-close-edit-stats').addEventListener('click', () => {
  document.getElementById('edit-stats-modal').classList.add('hidden');
});

document.getElementById('edit-stats-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const playerId = document.getElementById('edit-stats-player-id').value;
  const wins = parseInt(document.getElementById('edit-stats-wins').value, 10) || 0;
  const losses = parseInt(document.getElementById('edit-stats-losses').value, 10) || 0;
  const draws = parseInt(document.getElementById('edit-stats-draws').value, 10) || 0;
  const prefixWinStreak = parseInt(document.getElementById('edit-stats-prefix-win-streak').value, 10) || 0;
  if (!playerId) return;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sparar...';
  try {
    const res = await fetch(API + '/players/' + playerId + '/stats', {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ wins, losses, draws, prefixWinStreak }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      document.getElementById('edit-stats-modal').classList.add('hidden');
      showSuccessMessage('Statistik sparad');
      loadAndRender();
    } else {
      showErrorMessage(data.error || 'Kunde inte spara');
    }
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

// Vid laddning: verifiera token och visa admin-sektion om giltig
async function checkAuthOnLoad() {
  const token = getAdminToken();
  if (!token) {
    toggleAdminSection(false);
    return;
  }
  try {
    const res = await fetch(API + '/verify', {
      method: 'GET',
      headers: adminHeaders(),
    });
    if (res.ok) {
      toggleAdminSection(true);
      if (location.hash === '#admin') showView('admin');
      loadAndRender();
    } else {
      setAdminToken(null);
      toggleAdminSection(false);
    }
  } catch (err) {
    setAdminToken(null);
    toggleAdminSection(false);
  }
}

checkAuthOnLoad();

// —— Oavgjort-checkbox: visa/dölj vinnare/förlorare vs spelare i matchen ——
document.getElementById('match-draw').addEventListener('change', (e) => {
  toggleDrawMatchUI(e.target.checked);
  updateRegisterMatchSummary(window._lastData?.players);
});

// —— Spara match ——
document.getElementById('btn-save-match').addEventListener('click', async () => {
  const isDraw = document.getElementById('match-draw').checked;
  let winnerIds = [];
  let loserIds = [];
  let drawIds = [];

  if (isDraw) {
    drawIds = Array.from(document.querySelectorAll('#draw-checkboxes input:checked'))
      .map((cb) => parseInt(cb.dataset.playerId, 10));
    if (drawIds.length === 0) {
      showErrorMessage('Välj minst en spelare i matchen vid oavgjort.');
      return;
    }
  } else {
    winnerIds = Array.from(document.querySelectorAll('#winners-checkboxes input:checked'))
      .map((cb) => parseInt(cb.dataset.playerId, 10));
    loserIds = Array.from(document.querySelectorAll('#losers-checkboxes input:checked'))
      .map((cb) => parseInt(cb.dataset.playerId, 10));
    if (winnerIds.length === 0 || loserIds.length === 0) {
      showErrorMessage('Välj minst en vinnare och minst en förlorare.');
      return;
    }
    const overlap = winnerIds.filter((id) => loserIds.includes(id));
    if (overlap.length > 0) {
      showErrorMessage('En spelare kan inte vara både vinnare och förlorare.');
      return;
    }
  }

  try {
    const res = await fetch(API + '/matches', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ winnerIds, loserIds, drawIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(data.error || 'Kunde inte spara match');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    await loadAndRender();
    document.getElementById('match-draw').checked = false;
    toggleDrawMatchUI(false);
    document.querySelectorAll('#winners-checkboxes input, #losers-checkboxes input, #draw-checkboxes input').forEach((cb) => (cb.checked = false));
    
    // Visa bekräftelse
    showSuccessMessage('Match sparad!');
    const saveBtn = document.getElementById('btn-save-match');
    const originalText = saveBtn.textContent;
    saveBtn.textContent = '✓ Sparad!';
    saveBtn.classList.add('btn-success');
    setTimeout(() => {
      saveBtn.textContent = originalText;
      saveBtn.classList.remove('btn-success');
    }, 2000);
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

// —— Lägg till spelare ——
document.getElementById('btn-add-player').addEventListener('click', async () => {
  const input = document.getElementById('new-player-name');
  const name = (input.value || '').trim();
  if (!name) {
    showErrorMessage('Ange ett namn.');
    return;
  }
  try {
    const res = await fetch(API + '/players', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(data.error || 'Kunde inte lägga till spelare');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    input.value = '';
    await loadAndRender();
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

// —— Ta bort spelare ——
document.getElementById('btn-delete-player').addEventListener('click', async () => {
  const select = document.getElementById('player-to-delete');
  const playerId = select.value;
  if (!playerId) {
    showErrorMessage('Välj en spelare att ta bort.');
    return;
  }
  
  const playerName = select.options[select.selectedIndex].text;
  if (!confirm(`Är du säker på att du vill ta bort "${playerName}"?\n\nAlla matcher där spelaren deltog behålls, men spelaren kommer inte längre synas i tabellen.`)) {
    return;
  }
  
  try {
    const res = await fetch(API + '/players/' + playerId, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(data.error || 'Kunde inte ta bort spelare');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    select.value = '';
    await loadAndRender();
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

// —— Export & Import (backup) ——
document.getElementById('btn-export-stats').addEventListener('click', async () => {
  const btn = document.getElementById('btn-export-stats');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporterar...';
  try {
    const res = await fetch(API + '/export', {
      method: 'GET',
      headers: adminHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = 'Kunde inte exportera';
      try {
        const data = JSON.parse(text);
        if (data && data.error) msg = data.error;
      } catch (_) {
        if (text) msg = msg + ' (status ' + res.status + ')';
      }
      showErrorMessage(msg);
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stats-backup-' + new Date().toISOString().split('T')[0] + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showSuccessMessage('Data exporterad! Filen laddades ner.');
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.getElementById('btn-import-stats').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const btn = document.getElementById('btn-import-stats');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Importerar...';
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      showErrorMessage('Ogiltig JSON-fil: ' + err.message);
      return;
    }
    const res = await fetch(API + '/import', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(data),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(result.error || 'Kunde inte importera');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    showSuccessMessage(`Data importerad! ${result.playersCount || 0} spelare, ${result.matchesCount || 0} matcher.`);
    await loadAndRender();
  } catch (err) {
    showErrorMessage('Nätverksfel eller fel vid läsning av fil. Försök igen.');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    input.value = '';
  }
});

// —— Rensa statistik ——
document.getElementById('btn-clear-stats').addEventListener('click', async () => {
  if (!confirm('⚠️ ÄR DU SÄKER?\n\nDetta kommer att ta bort ALLA matcher och återställa statistiken.\n\nSpelare behålls men alla matchresultat försvinner.\n\nDu kan ångra detta direkt efteråt med "Ångra rensning"-knappen.')) {
    return;
  }
  
  // Ytterligare bekräftelse
  if (!confirm('Sista varningen: Detta tar bort ALLA matcher. Fortsätt?')) {
    return;
  }
  
  try {
    const res = await fetch(API + '/matches/clear', {
      method: 'POST',
      headers: adminHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(data.error || 'Kunde inte rensa statistik');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    
    await loadAndRender();
    showSuccessMessage(`Statistik rensad! ${data.matchesCleared || 0} matcher borttagna.`);
    
    // Visa ångra-knappen
    document.getElementById('btn-clear-stats').classList.add('hidden');
    document.getElementById('btn-undo-clear').classList.remove('hidden');
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

// —— Ångra rensning ——
document.getElementById('btn-undo-clear').addEventListener('click', async () => {
  if (!confirm('Återställa alla matcher från backup?')) {
    return;
  }
  
  try {
    const res = await fetch(API + '/matches/restore', {
      method: 'POST',
      headers: adminHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(data.error || 'Kunde inte återställa matcher');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      } else if (res.status === 404) {
        showErrorMessage('Ingen backup att återställa. Matcherna är redan borta.');
        document.getElementById('btn-clear-stats').classList.remove('hidden');
        document.getElementById('btn-undo-clear').classList.add('hidden');
      }
      return;
    }
    
    await loadAndRender();
    showSuccessMessage(`Matcher återställda! ${data.matchesRestored || 0} matcher återställda.`);
    
    // Dölj ångra-knappen
    document.getElementById('btn-clear-stats').classList.remove('hidden');
    document.getElementById('btn-undo-clear').classList.add('hidden');
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

// —— Dark mode ——
function getTheme() {
  let stored = null;
  try { stored = localStorage.getItem('unknown-talents-theme'); } catch (e) {}
  return stored || document.documentElement.getAttribute('data-theme') || 'light';
}

function setTheme(theme, persist = true) {
  if (persist) {
    try { localStorage.setItem('unknown-talents-theme', theme); } catch (e) {}
  }
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--header-bg').trim() || '#ebeae7');
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) {
    themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
    themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Byt till ljust läge' : 'Byt till mörkt läge');
  }
}

function toggleTheme() {
  const currentTheme = getTheme();
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

// Initiera tema vid laddning
setTheme(getTheme(), false);

document.getElementById('btn-theme').addEventListener('click', toggleTheme);

// —— Admin: Session & lag ——
document.getElementById('btn-admin-generate-teams').addEventListener('click', async () => {
  const strategy = document.getElementById('admin-session-strategy').value || 'random';
  const btn = document.getElementById('btn-admin-generate-teams');
  btn.disabled = true;
  btn.textContent = 'Genererar...';
  try {
    const res = await fetch(API + '/session/generate-teams', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ strategy }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.teamA && data.teamB) {
      window._lastSession = { ...window._lastSession, generatedTeams: { teamA: data.teamA, teamB: data.teamB, strategy: data.strategy } };
      renderSession(window._lastData?.players || [], window._lastSession);
      updateAdminSessionUI(window._lastSession);
      showSuccessMessage('Lag genererade!');
    } else {
      showErrorMessage(data.error || 'Kunde inte generera lag');
    }
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  } finally {
    btn.disabled = (window._lastSession?.playerIds?.length || 0) < MIN_PLAYERS_FOR_TEAMS;
    btn.textContent = 'Generera lag';
  }
});

document.getElementById('btn-admin-clear-session').addEventListener('click', async () => {
  try {
    const res = await fetch(API + '/session/clear', { method: 'POST', headers: adminHeaders() });
    if (res.ok) {
      const session = await fetchSession();
      window._lastSession = session;
      renderSession(window._lastData?.players || [], session);
      updateAdminSessionUI(session);
      document.getElementById('teams-result').classList.add('hidden');
      showSuccessMessage('Session rensad');
    } else {
      const data = await res.json().catch(() => ({}));
      showErrorMessage(data.error || 'Kunde inte rensa');
    }
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

function registerSessionResult(winner) {
  return fetch(API + '/session/register-result', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ winner }),
  });
}

const SESSION_RESULT_TOAST = 'Match sparad! Statistik uppdaterad. Sessionen är klar.';

document.getElementById('btn-register-team-a-won').addEventListener('click', async () => {
  try {
    const res = await registerSessionResult('A');
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showSuccessMessage(SESSION_RESULT_TOAST);
      await loadAndRender();
    } else {
      showErrorMessage(data.error || 'Kunde inte registrera');
    }
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

document.getElementById('btn-register-team-b-won').addEventListener('click', async () => {
  try {
    const res = await registerSessionResult('B');
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showSuccessMessage(SESSION_RESULT_TOAST);
      await loadAndRender();
    } else {
      showErrorMessage(data.error || 'Kunde inte registrera');
    }
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

// —— Admin: Avgifter & betalningar ——
document.getElementById('btn-payments-export')?.addEventListener('click', async () => {
  try {
    const res = await fetch(API + '/admin/payments-export', {
      method: 'GET',
      headers: adminHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showErrorMessage(data.error || 'Kunde inte exportera betalningar');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'payments.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

document.getElementById('match-history-more').addEventListener('click', () => {
  showMoreMatchHistory();
});

// Redigera / radera senaste match – klick på knappar i matchhistoriken (admin)
document.getElementById('match-history-list')?.addEventListener('click', (e) => {
  if (e.target.closest('.btn-edit-latest-match')) openEditLatestMatchModal();
  if (e.target.closest('.btn-delete-latest-match')) deleteLatestMatch();
});

async function deleteLatestMatch() {
  const data = window._lastData;
  if (!data || !data.matches || data.matches.length === 0) {
    showErrorMessage('Ingen match att radera.');
    return;
  }
  const sorted = (data.matches || []).filter((m) => m.date).sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  if (sorted.length === 0) {
    showErrorMessage('Ingen match att radera.');
    return;
  }
  if (
    !confirm(
      'Ta bort den senast registrerade matchen?\n\nStatistik (vinster/förluster/oavgjort) och matchhistorik uppdateras för alla berörda spelare.\n\nDetta kan inte ångras här (använd backup/import om du behöver).'
    )
  ) {
    return;
  }
  try {
    const res = await fetch(API + '/matches/latest', {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(result.error || 'Kunde inte radera match');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    await loadAndRender();
    showSuccessMessage('Senaste matchen är borttagen. Statistik uppdaterad.');
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
}

document.getElementById('edit-latest-match-close')?.addEventListener('click', () => {
  document.getElementById('edit-latest-match-modal').classList.add('hidden');
});

document.getElementById('edit-latest-match-save')?.addEventListener('click', async () => {
  const data = window._lastData;
  if (!data || !data.matches || data.matches.length === 0) return;
  const sorted = (data.matches || []).filter((m) => m.date).sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  const latest = sorted[0];
  if (!latest) return;
  const isDraw = (latest.drawIds || []).length > 0;
  let winnerIds = [];
  let loserIds = [];
  let drawIds = [];
  if (isDraw) {
    drawIds = Array.from(document.querySelectorAll('#edit-match-draw-checkboxes input:checked')).map((cb) => parseInt(cb.dataset.playerId, 10));
    if (drawIds.length === 0) {
      showErrorMessage('Välj minst en spelare i matchen vid oavgjort.');
      return;
    }
  } else {
    winnerIds = Array.from(document.querySelectorAll('#edit-match-winners-checkboxes input:checked')).map((cb) => parseInt(cb.dataset.playerId, 10));
    loserIds = Array.from(document.querySelectorAll('#edit-match-losers-checkboxes input:checked')).map((cb) => parseInt(cb.dataset.playerId, 10));
    if (winnerIds.length === 0 || loserIds.length === 0) {
      showErrorMessage('Välj minst en vinnare och minst en förlorare.');
      return;
    }
    const overlap = winnerIds.filter((id) => loserIds.includes(id));
    if (overlap.length > 0) {
      showErrorMessage('En spelare kan inte vara både vinnare och förlorare.');
      return;
    }
  }
  try {
    const res = await fetch(API + '/matches/latest', {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ winnerIds, loserIds, drawIds }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      showErrorMessage(result.error || 'Kunde inte uppdatera match');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    document.getElementById('edit-latest-match-modal').classList.add('hidden');
    await loadAndRender();
    showSuccessMessage('Senaste matchen är uppdaterad.');
  } catch (err) {
    showErrorMessage('Nätverksfel. Försök igen.');
  }
});

document.getElementById('info-toggle').addEventListener('click', () => {
  const toggle = document.getElementById('info-toggle');
  const content = document.getElementById('info-content');
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true';

  toggle.setAttribute('aria-expanded', !isExpanded);
  if (isExpanded) {
    content.classList.add('hidden');
  } else {
    content.classList.remove('hidden');
  }
});

// —— Admin-accordions ——
document.querySelectorAll('.admin-accordion-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';
    const contentId = btn.id + '-content';
    const content = document.getElementById(contentId);
    if (!content) return;
    btn.setAttribute('aria-expanded', !isExpanded);
    content.classList.toggle('hidden', isExpanded);
  });
});

// —— Modaler: Esc och klick utanför stänger ——
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach((m) => m.classList.add('hidden'));
});
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.add('hidden');
  });
});

// —— Ranking: tryck på spelare öppnar bottenark ——
document.getElementById('ranking-body').addEventListener('click', (e) => {
  const item = e.target.closest('.rank-item[data-player-id]');
  if (item) openPlayerSheet(parseInt(item.dataset.playerId, 10));
});
document.getElementById('ranking-body').addEventListener('keydown', (e) => {
  const item = e.target.closest('.rank-item[data-player-id]');
  if (item && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openPlayerSheet(parseInt(item.dataset.playerId, 10));
  }
});
document.getElementById('btn-close-player-sheet').addEventListener('click', () => {
  document.getElementById('player-sheet').classList.add('hidden');
});

// Start
loadAndRender();
