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

function renderRanking(players, statsById, orderedPlayers) {
  const tbody = document.getElementById('ranking-body');
  tbody.innerHTML = '';

  const isAdmin = !!getAdminToken();
  const thAdmin = document.getElementById('th-admin');
  if (thAdmin) thAdmin.classList.toggle('hidden', !isAdmin);

  if (orderedPlayers.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="10" class="col-num">Inga spelare än. Logga in som admin och lägg till spelare.</td>';
    tbody.appendChild(tr);
    return;
  }

  // Highscore-ikoner: vid lika antal vinster / lika längsta streak → högst vinstprocent (o.s.v.)
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

  orderedPlayers.forEach((p, index) => {
    const s = statsById[p.id];
    const streakText = formatStreak(s.currentStreak);
    const lastThree = s.lastResults
      .map((r) => `<span class="${r === 'W' ? 'w' : r === 'L' ? 'l' : 'd'}">${r}</span>`)
      .join('');
    
    // Lägg till ikoner för highscore-spelare
    let nameDisplay = escapeHtml(p.name);
    if (mostWinsPlayer && p.id === mostWinsPlayer.id && mostWins > 0) {
      nameDisplay = '🏆 ' + nameDisplay;
    }
    if (longestStreakPlayer && p.id === longestStreakPlayer.id && longestStreak > 0) {
      nameDisplay = '⭐ ' + nameDisplay;
    }
    
    const tr = document.createElement('tr');
    const editCell = isAdmin
      ? `<td class="admin-col"><button type="button" class="btn btn-edit-stats" data-player-id="${p.id}" data-wins="${s.wins}" data-losses="${s.losses}" data-draws="${s.draws}" data-prefix-win-streak="${p.prefixWinStreak ?? 0}" title="Redigera statistik">✏️</button></td>`
      : '';
    tr.innerHTML =
      `<td class="col-rank">${index + 1}</td>` +
      `<td>${nameDisplay}</td>` +
      `<td class="col-num">${s.wins}</td>` +
      `<td class="col-num">${s.losses}</td>` +
      `<td class="col-num">${s.draws}</td>` +
      `<td class="col-num">${s.matches}</td>` +
      `<td class="col-num">${s.matches > 0 ? s.winPct + '%' : '–'}</td>` +
      `<td class="col-streak">${streakText}</td>` +
      `<td><div class="last-matches">${lastThree || '–'}</div></td>` +
      editCell;
    tbody.appendChild(tr);
  });

  // Klick på Redigera-statistik (delegerat)
  tbody.querySelectorAll('.btn-edit-stats').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-player-id');
      const wins = btn.getAttribute('data-wins') || '0';
      const losses = btn.getAttribute('data-losses') || '0';
      const draws = btn.getAttribute('data-draws') || '0';
      const prefix = btn.getAttribute('data-prefix-win-streak') || '0';
      document.getElementById('edit-stats-player-id').value = id;
      document.getElementById('edit-stats-wins').value = wins;
      document.getElementById('edit-stats-losses').value = losses;
      document.getElementById('edit-stats-draws').value = draws;
      document.getElementById('edit-stats-prefix-win-streak').value = prefix;
      document.getElementById('edit-stats-modal').classList.remove('hidden');
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Visar ett framgångsmeddelande (toast) */
function showSuccessMessage(message) {
  // Ta bort befintlig toast om den finns
  const existingToast = document.getElementById('toast-message');
  if (existingToast) {
    existingToast.remove();
  }
  
  const toast = document.createElement('div');
  toast.id = 'toast-message';
  toast.className = 'toast toast-success';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // Visa toast
  setTimeout(() => toast.classList.add('show'), 10);
  
  // Dölj och ta bort efter 3 sekunder
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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
    alert('Ingen match att redigera.');
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
      const winnerNames = (m.winnerIds || []).map((id) => nameById[id] || id).join(', ');
      const loserNames = (m.loserIds || []).map((id) => nameById[id] || id).join(', ');
      const drawNames = (m.drawIds || []).map((id) => nameById[id] || id).join(', ');
      let itemHtml;
      if (isDraw) {
        itemHtml =
          '<div class="match-history-item">' +
          '<div class="match-history-date">' + escapeHtml(formatMatchDate(m.date)) + '</div>' +
          '<div class="match-history-row match-history-draw">Oavgjort: ' + escapeHtml(drawNames || '–') + '</div>';
      } else {
        itemHtml =
          '<div class="match-history-item">' +
          '<div class="match-history-date">' + escapeHtml(formatMatchDate(m.date)) + '</div>' +
          '<div class="match-history-row match-history-winners">Vinnare: ' + escapeHtml(winnerNames || '–') + '</div>' +
          '<div class="match-history-row match-history-losers">Förlorare: ' + escapeHtml(loserNames || '–') + '</div>';
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

  if (total === 0) {
    listEl.innerHTML = '<p class="match-history-empty">Inga matcher spelade än.</p>';
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

function renderSession(players, session) {
  const container = document.getElementById('session-players');
  const countEl = document.getElementById('session-count');
  const readyBadge = document.getElementById('session-ready-badge');
  if (!container || !countEl) return;

  const ids = session.playerIds || [];
  const count = ids.length;
  countEl.textContent = count + ' / ' + MIN_PLAYERS_FOR_TEAMS + ' spelare anmälda';
  if (readyBadge) {
    readyBadge.classList.toggle('hidden', count < MIN_PLAYERS_FOR_TEAMS);
  }

  const teams = session.generatedTeams;
  if (teams) {
    const block = document.getElementById('teams-result');
    const listA = document.getElementById('team-a-list');
    const listB = document.getElementById('team-b-list');
    const strategyTitle = document.getElementById('teams-strategy-title');
    if (block && listA && listB) {
      listA.innerHTML = (teams.teamA || []).map((p) => '<li>' + escapeHtml(p.name) + '</li>').join('');
      listB.innerHTML = (teams.teamB || []).map((p) => '<li>' + escapeHtml(p.name) + '</li>').join('');
      if (strategyTitle) {
        strategyTitle.textContent = 'Strategi: ' + (teams.strategy || 'random');
      }
      block.classList.remove('hidden');
    }
  } else {
    const block = document.getElementById('teams-result');
    if (block) block.classList.add('hidden');
  }

  container.innerHTML = players
    .map(
      (p) =>
        `<label class="session-player-label"><input type="checkbox" class="session-join-cb" data-player-id="${p.id}" ${ids.includes(p.id) ? 'checked' : ''}> ${escapeHtml(p.name)}</label>`
    )
    .join('');

  container.querySelectorAll('.session-join-cb').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const playerId = parseInt(cb.dataset.playerId, 10);
      const url = cb.checked ? API + '/session/join' : API + '/session/leave';
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.playerIds) {
          countEl.textContent = data.playerIds.length + ' / ' + MIN_PLAYERS_FOR_TEAMS + ' spelare anmälda';
          const badge = document.getElementById('session-ready-badge');
          if (badge) badge.classList.toggle('hidden', data.playerIds.length < MIN_PLAYERS_FOR_TEAMS);
          if (getAdminToken()) {
            const session = await fetchSession();
            window._lastSession = session;
            updateAdminSessionUI(session);
          }
        }
      } catch (err) {
        cb.checked = !cb.checked;
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
    document.getElementById('ranking-body').innerHTML =
      '<tr><td colspan="10" class="col-num">Kunde inte ladda data. Kontrollera att servern körs.</td></tr>';
  }
}

function toggleAdminSection(show) {
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
    } else {
      alert(data.error || 'Felaktigt lösenord');
      document.getElementById('password').value = '';
    }
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert(data.error || 'Kunde inte spara');
    }
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert('Välj minst en spelare i matchen vid oavgjort.');
      return;
    }
  } else {
    winnerIds = Array.from(document.querySelectorAll('#winners-checkboxes input:checked'))
      .map((cb) => parseInt(cb.dataset.playerId, 10));
    loserIds = Array.from(document.querySelectorAll('#losers-checkboxes input:checked'))
      .map((cb) => parseInt(cb.dataset.playerId, 10));
    if (winnerIds.length === 0 || loserIds.length === 0) {
      alert('Välj minst en vinnare och minst en förlorare.');
      return;
    }
    const overlap = winnerIds.filter((id) => loserIds.includes(id));
    if (overlap.length > 0) {
      alert('En spelare kan inte vara både vinnare och förlorare.');
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
      alert(data.error || 'Kunde inte spara match');
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
    alert('Nätverksfel. Försök igen.');
  }
});

// —— Lägg till spelare ——
document.getElementById('btn-add-player').addEventListener('click', async () => {
  const input = document.getElementById('new-player-name');
  const name = (input.value || '').trim();
  if (!name) {
    alert('Ange ett namn.');
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
      alert(data.error || 'Kunde inte lägga till spelare');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    input.value = '';
    await loadAndRender();
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
  }
});

// —— Ta bort spelare ——
document.getElementById('btn-delete-player').addEventListener('click', async () => {
  const select = document.getElementById('player-to-delete');
  const playerId = select.value;
  if (!playerId) {
    alert('Välj en spelare att ta bort.');
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
      alert(data.error || 'Kunde inte ta bort spelare');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    select.value = '';
    await loadAndRender();
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert(msg);
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
    alert('Nätverksfel. Försök igen.');
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
      alert('Ogiltig JSON-fil: ' + err.message);
      return;
    }
    const res = await fetch(API + '/import', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(data),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(result.error || 'Kunde inte importera');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    showSuccessMessage(`Data importerad! ${result.playersCount || 0} spelare, ${result.matchesCount || 0} matcher.`);
    await loadAndRender();
  } catch (err) {
    alert('Nätverksfel eller fel vid läsning av fil. Försök igen.');
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
      alert(data.error || 'Kunde inte rensa statistik');
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
    alert('Nätverksfel. Försök igen.');
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
      alert(data.error || 'Kunde inte återställa matcher');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      } else if (res.status === 404) {
        alert('Ingen backup att återställa. Matcherna är redan borta.');
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
    alert('Nätverksfel. Försök igen.');
  }
});

// —— Dark mode ——
function getTheme() {
  return localStorage.getItem('unknown-talents-theme') || 'light';
}

function setTheme(theme) {
  localStorage.setItem('unknown-talents-theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) {
    themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

function toggleTheme() {
  const currentTheme = getTheme();
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

// Initiera tema vid laddning
setTheme(getTheme());

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
      alert(data.error || 'Kunde inte generera lag');
    }
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert(data.error || 'Kunde inte rensa');
    }
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert(data.error || 'Kunde inte registrera');
    }
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert(data.error || 'Kunde inte registrera');
    }
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert(data.error || 'Kunde inte exportera betalningar');
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
    alert('Nätverksfel. Försök igen.');
  }
});

// —— Matchanmälan accordion ——
document.getElementById('session-toggle').addEventListener('click', () => {
  const toggle = document.getElementById('session-toggle');
  const content = document.getElementById('session-content');
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', !isExpanded);
  content.classList.toggle('hidden', isExpanded);
});

// —— Info accordion (endast på startsidan; döljs när admin är inloggad) ——
document.getElementById('match-history-toggle').addEventListener('click', () => {
  const toggle = document.getElementById('match-history-toggle');
  const content = document.getElementById('match-history-content');
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', !isExpanded);
  content.classList.toggle('hidden', isExpanded);
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
    alert('Ingen match att radera.');
    return;
  }
  const sorted = (data.matches || []).filter((m) => m.date).sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  if (sorted.length === 0) {
    alert('Ingen match att radera.');
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
      alert(result.error || 'Kunde inte radera match');
      if (res.status === 401) {
        setAdminToken(null);
        toggleAdminSection(false);
      }
      return;
    }
    await loadAndRender();
    showSuccessMessage('Senaste matchen är borttagen. Statistik uppdaterad.');
  } catch (err) {
    alert('Nätverksfel. Försök igen.');
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
      alert('Välj minst en spelare i matchen vid oavgjort.');
      return;
    }
  } else {
    winnerIds = Array.from(document.querySelectorAll('#edit-match-winners-checkboxes input:checked')).map((cb) => parseInt(cb.dataset.playerId, 10));
    loserIds = Array.from(document.querySelectorAll('#edit-match-losers-checkboxes input:checked')).map((cb) => parseInt(cb.dataset.playerId, 10));
    if (winnerIds.length === 0 || loserIds.length === 0) {
      alert('Välj minst en vinnare och minst en förlorare.');
      return;
    }
    const overlap = winnerIds.filter((id) => loserIds.includes(id));
    if (overlap.length > 0) {
      alert('En spelare kan inte vara både vinnare och förlorare.');
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
      alert(result.error || 'Kunde inte uppdatera match');
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
    alert('Nätverksfel. Försök igen.');
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

// Start
loadAndRender();
