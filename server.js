/**
 * Winner – backend-server
 * Servar statiska filer och API för spelare/matcher.
 * Spelare och matcher i MongoDB.
 */
require('dotenv').config();

/** Nödvändig konfiguration – appen startar inte utan dessa (se .env.example). */
const missingEnv = ['MONGO_URI', 'ADMIN_PASSWORD'].filter((key) => !(process.env[key] || '').trim());
if (missingEnv.length > 0) {
  console.error('Saknad konfiguration: ' + missingEnv.join(', ') + '.');
  console.error('Kopiera .env.example till .env och fyll i dina egna värden (se README).');
  process.exit(1);
}

const connectDB = require('./db');
connectDB();
const express = require('express');
const path = require('path');
const Match = require('./models/Match');
const Player = require('./models/Player');
const { generateTeams, STRATEGIES } = require('./lib/teamGenerator');

const app = express();
const PORT = process.env.PORT || 5000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
/** Planhyra per match i kr (används i betalningsöversikten). */
const MATCH_PRICE = Number(process.env.MATCH_PRICE) > 0 ? Number(process.env.MATCH_PRICE) : 550;

/** Session: spelare som anmält sig (in-memory). Genererade lag sparas tills session rensas. */
const sessionPlayerIds = new Set();
/** Genererade lag (spikade) – visas på startsidan. Null när ej genererat eller session rensad. */
let sessionGeneratedTeams = null;

app.use(express.json());

/** Läser spelare och matcher från MongoDB. Returnerar { players, matches } (samma API-struktur som tidigare). */
async function readData() {
  const [playerDocs, matchDocs] = await Promise.all([
    Player.find().sort({ id: 1 }).lean(),
    Match.find().sort({ _id: 1 }).lean()
  ]);
  return {
    players: playerDocs.map((p) => ({
      id: p.id,
      name: p.name,
      wins: p.wins ?? 0,
      losses: p.losses ?? 0,
      draws: p.draws ?? 0,
      prefixWinStreak: p.prefixWinStreak ?? 0
    })),
    matches: matchDocs.map((m) => {
      let dateIso = null;
      if (m.date) {
        const d = m.date instanceof Date ? m.date : new Date(m.date);
        if (!isNaN(d.getTime())) dateIso = d.toISOString();
      }
      if (!dateIso && m._id && typeof m._id.getTimestamp === 'function') {
        dateIso = m._id.getTimestamp().toISOString();
      }
      return {
        winnerIds: m.winnerIds || [],
        loserIds: m.loserIds || [],
        drawIds: m.drawIds || [],
        date: dateIso
      };
    })
  };
}

/** Beräknar vinster/förluster/oavgjort för en spelare utifrån matcher (utan den nya) */
function computedStatsFromMatches(playerId, matches) {
  let w = 0, l = 0, d = 0;
  for (const m of matches) {
    if ((m.drawIds || []).includes(playerId)) d++;
    else if ((m.winnerIds || []).includes(playerId)) w++;
    else if ((m.loserIds || []).includes(playerId)) l++;
  }
  return { w, l, d };
}

/** Validerar att data har korrekt struktur innan import */
function validateDataStructure(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Data måste vara ett objekt' };
  }
  
  if (!Array.isArray(data.players)) {
    return { valid: false, error: 'Data måste ha en players-array' };
  }
  
  if (!Array.isArray(data.matches)) {
    return { valid: false, error: 'Data måste ha en matches-array' };
  }
  
  // Validera varje spelare
  for (let i = 0; i < data.players.length; i++) {
    const p = data.players[i];
    if (!p || typeof p !== 'object') {
      return { valid: false, error: `Spelare ${i + 1} är inte ett objekt` };
    }
    if (typeof p.id !== 'number' || p.id < 1) {
      return { valid: false, error: `Spelare ${i + 1} har ogiltigt id` };
    }
    if (typeof p.name !== 'string' || !p.name.trim()) {
      return { valid: false, error: `Spelare ${i + 1} saknar namn` };
    }
    if (p.prefixWinStreak !== undefined && p.prefixWinStreak !== null) {
      const n = Number(p.prefixWinStreak);
      if (!Number.isInteger(n) || n < 0) {
        return { valid: false, error: `Spelare ${i + 1}: prefixWinStreak måste vara heltal ≥ 0` };
      }
    }
  }
  
  // Validera varje match
  for (let i = 0; i < data.matches.length; i++) {
    const m = data.matches[i];
    if (!m || typeof m !== 'object') {
      return { valid: false, error: `Match ${i + 1} är inte ett objekt` };
    }
    if (!Array.isArray(m.winnerIds)) {
      return { valid: false, error: `Match ${i + 1} saknar winnerIds-array` };
    }
    if (!Array.isArray(m.loserIds)) {
      return { valid: false, error: `Match ${i + 1} saknar loserIds-array` };
    }
    if (!Array.isArray(m.drawIds)) {
      return { valid: false, error: `Match ${i + 1} saknar drawIds-array` };
    }
    // Kontrollera att match är antingen oavgjort ELLER har vinnare+förlorare
    const hasDraws = m.drawIds.length > 0;
    const hasWinners = m.winnerIds.length > 0;
    const hasLosers = m.loserIds.length > 0;
    if (hasDraws && (hasWinners || hasLosers)) {
      return { valid: false, error: `Match ${i + 1}: oavgjort kan inte ha vinnare/förlorare` };
    }
    if (!hasDraws && (!hasWinners || !hasLosers)) {
      return { valid: false, error: `Match ${i + 1}: måste ha vinnare och förlorare, eller oavgjort` };
    }
  }
  
  return { valid: true };
}

/** Kontrollerar om request har rätt admin-lösenord */
function isAdmin(req) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const bodyPassword = req.body && req.body.password;
  const password = token || bodyPassword;
  return password === ADMIN_PASSWORD;
}

// —— API ——

/** POST /api/login – verifierar lösenord och returnerar success */
app.post('/api/login', (req, res) => {
  const password = req.body.password;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Felaktigt lösenord' });
  }
});

/** GET /api/verify – verifierar om token är giltig (admin) */
app.get('/api/verify', (req, res) => {
  if (isAdmin(req)) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Ogiltig token' });
  }
});

/** GET /api/stats – returnerar spelare och matcher (ingen auth) */
app.get('/api/stats', async (req, res) => {
  try {
    const data = await readData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte läsa data' });
  }
});

/** POST /api/players – lägg till spelare (admin) */
app.post('/api/players', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Namn krävs' });
  }
  try {
    const last = await Player.findOne().sort({ id: -1 }).select('id').lean();
    const maxId = last ? last.id : 0;
    const id = maxId + 1;
    await Player.create({ id, name, wins: 0, losses: 0, draws: 0 });
    res.json({ id, name });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte spara spelare' });
  }
});

/** DELETE /api/players/:id – ta bort spelare (admin) */
app.delete('/api/players/:id', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  const playerId = parseInt(req.params.id, 10);
  if (!playerId) {
    return res.status(400).json({ error: 'Ogiltigt spelar-ID' });
  }
  try {
    const result = await Player.deleteOne({ id: playerId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Spelare hittades inte' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte ta bort spelare' });
  }
});

/** PATCH /api/players/:id/stats – sätt vinster/förluster/oavgjort manuellt (admin) */
app.patch('/api/players/:id/stats', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  const playerId = parseInt(req.params.id, 10);
  if (!playerId) {
    return res.status(400).json({ error: 'Ogiltigt spelar-ID' });
  }
  const wins = req.body.wins !== undefined ? Math.max(0, Math.floor(Number(req.body.wins))) : undefined;
  const losses = req.body.losses !== undefined ? Math.max(0, Math.floor(Number(req.body.losses))) : undefined;
  const draws = req.body.draws !== undefined ? Math.max(0, Math.floor(Number(req.body.draws))) : undefined;
  const prefixWinStreak =
    req.body.prefixWinStreak !== undefined ? Math.max(0, Math.floor(Number(req.body.prefixWinStreak))) : undefined;
  if (wins === undefined && losses === undefined && draws === undefined && prefixWinStreak === undefined) {
    return res.status(400).json({ error: 'Ange minst ett av wins, losses, draws, prefixWinStreak' });
  }
  try {
    const player = await Player.findOne({ id: playerId }).lean();
    if (!player) {
      return res.status(404).json({ error: 'Spelare hittades inte' });
    }
    const update = {};
    if (wins !== undefined) update.wins = wins;
    if (losses !== undefined) update.losses = losses;
    if (draws !== undefined) update.draws = draws;
    if (prefixWinStreak !== undefined) update.prefixWinStreak = prefixWinStreak;
    await Player.updateOne({ id: playerId }, { $set: update });
    const updated = await Player.findOne({ id: playerId }).lean();
    res.json({
      id: updated.id,
      name: updated.name,
      wins: updated.wins ?? 0,
      losses: updated.losses ?? 0,
      draws: updated.draws ?? 0,
      prefixWinStreak: updated.prefixWinStreak ?? 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte spara statistik' });
  }
});

/** POST /api/matches – registrera match (admin). Oavgjort = winnerIds/loserIds tomma, drawIds ifyllda. */
app.post('/api/matches', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  const winnerIds = Array.isArray(req.body.winnerIds) ? req.body.winnerIds : [];
  const loserIds = Array.isArray(req.body.loserIds) ? req.body.loserIds : [];
  const drawIds = Array.isArray(req.body.drawIds) ? req.body.drawIds : [];
  const isDraw = drawIds.length > 0;
  if (isDraw) {
    if (winnerIds.length > 0 || loserIds.length > 0) {
      return res.status(400).json({ error: 'Vid oavgjort ska endast drawIds anges' });
    }
    if (drawIds.length === 0) {
      return res.status(400).json({ error: 'Välj minst en spelare vid oavgjort' });
    }
  } else {
    if (winnerIds.length === 0 || loserIds.length === 0) {
      return res.status(400).json({ error: 'Välj minst en vinnare och minst en förlorare' });
    }
  }
  try {
    const data = await readData();
    const match = { winnerIds, loserIds, drawIds, date: new Date() };
    const updatePlayer = (id, type) => {
      const player = data.players.find((p) => p.id === id);
      if (!player) return;
      const computed = computedStatsFromMatches(id, data.matches);
      if (type === 'win') player.wins = (player.wins ?? computed.w) + 1;
      else if (type === 'loss') player.losses = (player.losses ?? computed.l) + 1;
      else if (type === 'draw') player.draws = (player.draws ?? computed.d) + 1;
    };
    if (drawIds.length > 0) {
      drawIds.forEach((id) => updatePlayer(id, 'draw'));
    } else {
      winnerIds.forEach((id) => updatePlayer(id, 'win'));
      loserIds.forEach((id) => updatePlayer(id, 'loss'));
    }
    await Match.create(match);
    for (const p of data.players) {
      await Player.updateOne(
        { id: p.id },
        { $set: { wins: p.wins ?? 0, losses: p.losses ?? 0, draws: p.draws ?? 0 } }
      );
    }
    res.json(match);
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte spara match' });
  }
});

/** PATCH /api/matches/latest – redigera senaste matchen (admin). Behåll typ (oavgjort vs vinst/förlust). Uppdaterar statistik. */
app.patch('/api/matches/latest', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  const winnerIds = Array.isArray(req.body.winnerIds) ? req.body.winnerIds.map(Number).filter(Number.isInteger) : [];
  const loserIds = Array.isArray(req.body.loserIds) ? req.body.loserIds.map(Number).filter(Number.isInteger) : [];
  const drawIds = Array.isArray(req.body.drawIds) ? req.body.drawIds.map(Number).filter(Number.isInteger) : [];
  const newIsDraw = drawIds.length > 0;

  const latest = await Match.findOne().sort({ _id: -1 }).lean();
  if (!latest) {
    return res.status(404).json({ error: 'Ingen match att redigera' });
  }
  const oldWinnerIds = latest.winnerIds || [];
  const oldLoserIds = latest.loserIds || [];
  const oldDrawIds = latest.drawIds || [];
  const oldIsDraw = oldDrawIds.length > 0;

  if (oldIsDraw !== newIsDraw) {
    return res.status(400).json({
      error: newIsDraw
        ? 'Senaste matchen är inte oavgjord. Du kan bara ändra vilka spelare som deltog, inte göra den till oavgjort.'
        : 'Senaste matchen är oavgjord. Du kan bara ändra vilka spelare som deltog i oavgjorten.'
    });
  }
  if (newIsDraw) {
    if (drawIds.length === 0) {
      return res.status(400).json({ error: 'Välj minst en spelare i oavgjorten' });
    }
  } else {
    if (winnerIds.length === 0 || loserIds.length === 0) {
      return res.status(400).json({ error: 'Välj minst en vinnare och minst en förlorare' });
    }
    const overlap = winnerIds.filter((id) => loserIds.includes(id));
    if (overlap.length > 0) {
      return res.status(400).json({ error: 'Samma spelare kan inte vara både vinnare och förlorare' });
    }
  }

  try {
    for (const id of oldWinnerIds) {
      await Player.updateOne({ id }, { $inc: { wins: -1 } });
    }
    for (const id of oldLoserIds) {
      await Player.updateOne({ id }, { $inc: { losses: -1 } });
    }
    for (const id of oldDrawIds) {
      await Player.updateOne({ id }, { $inc: { draws: -1 } });
    }

    await Match.updateOne(
      { _id: latest._id },
      { $set: { winnerIds: newIsDraw ? [] : winnerIds, loserIds: newIsDraw ? [] : loserIds, drawIds: newIsDraw ? drawIds : [] } }
    );

    if (newIsDraw) {
      for (const id of drawIds) {
        await Player.updateOne({ id }, { $inc: { draws: 1 } });
      }
    } else {
      for (const id of winnerIds) {
        await Player.updateOne({ id }, { $inc: { wins: 1 } });
      }
      for (const id of loserIds) {
        await Player.updateOne({ id }, { $inc: { losses: 1 } });
      }
    }

    const updated = await Match.findById(latest._id).lean();
    res.json({
      ok: true,
      match: {
        winnerIds: updated.winnerIds || [],
        loserIds: updated.loserIds || [],
        drawIds: updated.drawIds || [],
        date: (() => {
          if (updated.date) {
            const d = updated.date instanceof Date ? updated.date : new Date(updated.date);
            if (!isNaN(d.getTime())) return d.toISOString();
          }
          return updated._id && typeof updated._id.getTimestamp === 'function'
            ? updated._id.getTimestamp().toISOString()
            : null;
        })()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Kunde inte uppdatera match' });
  }
});

/** DELETE /api/matches/latest – ta bort senaste matchen och återför spelarstatistik (admin). */
app.delete('/api/matches/latest', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  try {
    const latest = await Match.findOne().sort({ _id: -1 }).lean();
    if (!latest) {
      return res.status(404).json({ error: 'Ingen match att radera' });
    }
    for (const id of latest.winnerIds || []) {
      await Player.updateOne({ id }, { $inc: { wins: -1 } });
    }
    for (const id of latest.loserIds || []) {
      await Player.updateOne({ id }, { $inc: { losses: -1 } });
    }
    for (const id of latest.drawIds || []) {
      await Player.updateOne({ id }, { $inc: { draws: -1 } });
    }
    await Match.deleteOne({ _id: latest._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Kunde inte radera match' });
  }
});

/** POST /api/matches/clear – rensa alla matcher och statistik (admin). Sparar backup för ångra. */
app.post('/api/matches/clear', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  try {
    const data = await readData();
    const backup = {
      matches: data.matches.map((m) => ({
        winnerIds: m.winnerIds || [],
        loserIds: m.loserIds || [],
        drawIds: m.drawIds || [],
        ...(m.date ? { date: m.date } : {})
      })),
      playersStats: data.players.map((p) => ({
        id: p.id,
        wins: p.wins,
        losses: p.losses,
        draws: p.draws,
        prefixWinStreak: p.prefixWinStreak ?? 0
      })),
      timestamp: Date.now()
    };
    if (!global.matchBackup) global.matchBackup = {};
    global.matchBackup[req.headers.authorization?.slice(7) || 'default'] = backup;

    await Match.deleteMany({});
    await Player.updateMany({}, { $set: { wins: 0, losses: 0, draws: 0 } });
    res.json({ ok: true, matchesCleared: backup.matches.length });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte rensa statistik' });
  }
});

/** POST /api/matches/restore – återställ matcher och statistik från backup (admin) */
app.post('/api/matches/restore', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  try {
    const token = req.headers.authorization?.slice(7) || 'default';
    const backup = global.matchBackup?.[token];
    if (!backup) {
      return res.status(404).json({ error: 'Ingen backup att återställa' });
    }
    if (backup.matches && backup.matches.length > 0) {
      await Match.insertMany(backup.matches);
    }
    if (backup.playersStats && backup.playersStats.length > 0) {
      for (const ps of backup.playersStats) {
        await Player.updateOne(
          { id: ps.id },
          {
            $set: {
              wins: ps.wins ?? 0,
              losses: ps.losses ?? 0,
              draws: ps.draws ?? 0,
              prefixWinStreak: ps.prefixWinStreak ?? 0
            }
          }
        );
      }
    }
    delete global.matchBackup[token];
    res.json({ ok: true, matchesRestored: backup.matches.length });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte återställa statistik' });
  }
});

/** GET /api/export – exportera backup som JSON (admin). Returnerar JSON; klienten triggar nedladdning. */
app.get('/api/export', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  try {
    const data = await readData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte exportera data' });
  }
});

/** GET /api/admin/payments-summary – summering av planhyror per spelare (admin) */
app.get('/api/admin/payments-summary', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  try {
    const data = await readData();
    const playersById = new Map();
    for (const p of data.players) {
      playersById.set(p.id, p);
    }
    const totalsByPlayerId = new Map();
    let totalAmount = 0;
    let matchCount = 0;

    for (const m of data.matches) {
      const isDraw = (m.drawIds || []).length > 0;
      const payerIds = isDraw ? (m.drawIds || []) : (m.loserIds || []);
      if (!payerIds || payerIds.length === 0) continue;
      const perPlayer = MATCH_PRICE / payerIds.length;
      matchCount += 1;
      totalAmount += MATCH_PRICE;
      for (const id of payerIds) {
        const current = totalsByPlayerId.get(id) || { id, amount: 0, matches: 0 };
        current.amount += perPlayer;
        current.matches += 1;
        totalsByPlayerId.set(id, current);
      }
    }

    const players = Array.from(totalsByPlayerId.values())
      .map((row) => {
        const p = playersById.get(row.id);
        return {
          id: row.id,
          name: p ? p.name : 'Okänd spelare',
          amount: Number(row.amount.toFixed(2)),
          matches: row.matches
        };
      })
      .sort((a, b) => (b.amount - a.amount) || a.name.localeCompare(b.name, 'sv'));

    res.json({
      pricePerMatch: MATCH_PRICE,
      matchCount,
      totalAmount: Number(totalAmount.toFixed(2)),
      players
    });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte beräkna betalningssammanfattning' });
  }
});

/** GET /api/admin/payments-export – exportera betalningar som CSV (admin) */
app.get('/api/admin/payments-export', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  try {
    const data = await readData();
    const playersById = new Map();
    for (const p of data.players) {
      playersById.set(p.id, p);
    }
    const rows = [];

    for (const m of data.matches) {
      const isDraw = (m.drawIds || []).length > 0;
      const payerIds = isDraw ? (m.drawIds || []) : (m.loserIds || []);
      if (!payerIds || payerIds.length === 0) continue;
      const perPlayer = MATCH_PRICE / payerIds.length;
      const amount = Number(perPlayer.toFixed(2));
      const date = m.date || '';
      for (const id of payerIds) {
        const player = playersById.get(id);
        rows.push({
          date,
          playerId: id,
          playerName: player ? player.name : 'Okänd spelare',
          amount
        });
      }
    }

    let csv = 'Datum;Spelare;SpelarID;Belopp\n';
    csv += rows
      .map((r) =>
        [
          r.date,
          `"${String(r.playerName).replace(/"/g, '""')}"`,
          r.playerId,
          r.amount.toString().replace('.', ',')
        ].join(';')
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte exportera betalningar' });
  }
});

/** POST /api/import – importera JSON-backup (admin)
 * Accepterar antingen JSON-objekt i body eller JSON som text-sträng i body.data
 */
app.post('/api/import', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }

  let importedData;
  try {
    if (req.body.data && typeof req.body.data === 'string') {
      importedData = JSON.parse(req.body.data);
    } else {
      importedData = req.body;
    }
    if (!importedData || typeof importedData !== 'object') {
      return res.status(400).json({ error: 'Ogiltig JSON-data' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Kunde inte parsa JSON: ' + err.message });
  }

  const validation = validateDataStructure(importedData);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validering misslyckades: ' + validation.error });
  }

  try {
    let currentBackup = null;
    try {
      currentBackup = await readData();
    } catch (err) {
      console.warn('Kunde inte läsa befintlig data för backup:', err.message);
    }

    await Player.deleteMany({});
    const playerDocs = (importedData.players || []).map((p) => ({
      id: p.id,
      name: p.name || '',
      wins: p.wins ?? 0,
      losses: p.losses ?? 0,
      draws: p.draws ?? 0,
      prefixWinStreak: Math.max(0, Math.floor(Number(p.prefixWinStreak)) || 0)
    }));
    if (playerDocs.length > 0) await Player.insertMany(playerDocs);
    await Match.deleteMany({});
    if (importedData.matches && importedData.matches.length > 0) {
      const docs = importedData.matches.map((m) => {
        const doc = {
          winnerIds: m.winnerIds || [],
          loserIds: m.loserIds || [],
          drawIds: m.drawIds || []
        };
        if (m.date != null && m.date !== '') {
          const d = new Date(m.date);
          if (!isNaN(d.getTime())) doc.date = d;
        }
        return doc;
      });
      await Match.insertMany(docs);
    }

    res.json({
      ok: true,
      message: 'Data importerad framgångsrikt',
      playersCount: importedData.players.length,
      matchesCount: (importedData.matches || []).length,
      hadBackup: currentBackup !== null
    });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte importera data: ' + err.message });
  }
});

// —— Session (matchanmälan) ——

const MIN_PLAYERS_FOR_TEAMS = 10;

/** GET /api/session – returnerar anmälda spelare samt genererade (spikade) lag */
app.get('/api/session', (req, res) => {
  res.json({
    playerIds: Array.from(sessionPlayerIds),
    generatedTeams: sessionGeneratedTeams
  });
});

/** POST /api/session/join – anmäl spelare till session */
app.post('/api/session/join', (req, res) => {
  const playerId = req.body.playerId != null ? Number(req.body.playerId) : NaN;
  if (!Number.isInteger(playerId) || playerId < 1) {
    return res.status(400).json({ error: 'Ogiltigt spelar-ID' });
  }
  sessionPlayerIds.add(playerId);
  res.json({ ok: true, playerIds: Array.from(sessionPlayerIds) });
});

/** POST /api/session/leave – avanmäl spelare från session */
app.post('/api/session/leave', (req, res) => {
  const playerId = req.body.playerId != null ? Number(req.body.playerId) : NaN;
  if (!Number.isInteger(playerId) || playerId < 1) {
    return res.status(400).json({ error: 'Ogiltigt spelar-ID' });
  }
  sessionPlayerIds.delete(playerId);
  res.json({ ok: true, playerIds: Array.from(sessionPlayerIds) });
});

/** POST /api/session/clear – rensa session (admin). Rensar anmälningar och lag. */
app.post('/api/session/clear', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  sessionPlayerIds.clear();
  sessionGeneratedTeams = null;
  res.json({ ok: true, playerIds: [] });
});

/** POST /api/session/generate-teams – generera två lag (admin). Lag sparas som spikade tills session rensas. */
app.post('/api/session/generate-teams', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  const strategy = (req.body.strategy && String(req.body.strategy).toLowerCase()) || 'random';
  if (!STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: 'Okänd strategi. Giltiga: ' + STRATEGIES.join(', ') });
  }
  try {
    const data = await readData();
    const sessionPlayers = data.players.filter((p) => sessionPlayerIds.has(p.id));
    if (sessionPlayers.length < MIN_PLAYERS_FOR_TEAMS) {
      return res.status(400).json({
        error: `Minst ${MIN_PLAYERS_FOR_TEAMS} spelare krävs. Anmälda: ${sessionPlayers.length}.`
      });
    }
    const { teamA, teamB } = generateTeams(sessionPlayers, strategy);
    sessionGeneratedTeams = { teamA, teamB, strategy };
    res.json({ teamA, teamB, strategy });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Kunde inte generera lag' });
  }
});

/** POST /api/session/register-result – registrera vinnande lag, skapa match, uppdatera statistik, rensa session (admin) */
app.post('/api/session/register-result', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Kräver inloggning' });
  }
  const winner = (req.body.winner && String(req.body.winner).toUpperCase()) === 'B' ? 'B' : 'A';
  if (!sessionGeneratedTeams) {
    return res.status(400).json({ error: 'Inga genererade lag. Generera lag först och registrera sedan resultat.' });
  }
  const { teamA, teamB } = sessionGeneratedTeams;
  const winnerIds = winner === 'A' ? teamA.map((p) => p.id) : teamB.map((p) => p.id);
  const loserIds = winner === 'A' ? teamB.map((p) => p.id) : teamA.map((p) => p.id);
  try {
    const data = await readData();
    const match = { winnerIds, loserIds, drawIds: [] };
    const updatePlayer = (id, type) => {
      const player = data.players.find((p) => p.id === id);
      if (!player) return;
      const computed = computedStatsFromMatches(id, data.matches);
      if (type === 'win') player.wins = (player.wins ?? computed.w) + 1;
      else if (type === 'loss') player.losses = (player.losses ?? computed.l) + 1;
    };
    winnerIds.forEach((id) => updatePlayer(id, 'win'));
    loserIds.forEach((id) => updatePlayer(id, 'loss'));
    await Match.create(match);
    for (const p of data.players) {
      await Player.updateOne(
        { id: p.id },
        { $set: { wins: p.wins ?? 0, losses: p.losses ?? 0, draws: p.draws ?? 0 } }
      );
    }
    sessionPlayerIds.clear();
    sessionGeneratedTeams = null;
    res.json({ ok: true, match });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Kunde inte registrera resultat' });
  }
});

/** GET /api/session/strategies – lista tillgängliga strategier */
app.get('/api/session/strategies', (req, res) => {
  res.json({ strategies: STRATEGIES });
});

// Statiska filer (efter API så att /api/* inte serverar index.html)
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('Winner körs på http://localhost:' + PORT);
});
