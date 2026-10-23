/**
 * Frivillig demodata – lägger in påhittade spelare och några matcher.
 * Körs uttryckligen med: npm run seed:demo
 * Avbryter om databasen redan innehåller spelare eller matcher, så befintlig data rörs aldrig.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../db');
const Match = require('../models/Match');
const Player = require('../models/Player');

const DEMO_NAMES = [
  'Demo Alfa', 'Demo Bravo', 'Demo Charlie', 'Demo Delta', 'Demo Eko', 'Demo Foxtrot',
  'Demo Golf', 'Demo Hotell', 'Demo India', 'Demo Juliett', 'Demo Kilo', 'Demo Lima'
];

const DEMO_MATCHES = [
  { winnerIds: [1, 2, 3, 4, 5, 6], loserIds: [7, 8, 9, 10, 11, 12], drawIds: [] },
  { winnerIds: [1, 3, 5, 7, 9, 11], loserIds: [2, 4, 6, 8, 10, 12], drawIds: [] },
  { winnerIds: [], loserIds: [], drawIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  { winnerIds: [2, 4, 6, 8, 10, 12], loserIds: [1, 3, 5, 7, 9, 11], drawIds: [] }
];

async function seed() {
  await connectDB();
  const [playerCount, matchCount] = await Promise.all([Player.countDocuments(), Match.countDocuments()]);
  if (playerCount > 0 || matchCount > 0) {
    console.error(
      `Avbryter: databasen innehåller redan data (${playerCount} spelare, ${matchCount} matcher). ` +
        'Demodata läggs bara in i en tom databas.'
    );
    process.exitCode = 1;
    return;
  }

  const players = DEMO_NAMES.map((name, i) => ({ id: i + 1, name, wins: 0, losses: 0, draws: 0 }));
  const byId = new Map(players.map((p) => [p.id, p]));
  const start = Date.now() - DEMO_MATCHES.length * 7 * 24 * 60 * 60 * 1000;
  const matches = DEMO_MATCHES.map((m, i) => {
    m.winnerIds.forEach((id) => byId.get(id).wins++);
    m.loserIds.forEach((id) => byId.get(id).losses++);
    m.drawIds.forEach((id) => byId.get(id).draws++);
    return { ...m, date: new Date(start + i * 7 * 24 * 60 * 60 * 1000) };
  });

  await Player.insertMany(players);
  await Match.insertMany(matches);
  console.log(`Demodata inlagd: ${players.length} påhittade spelare och ${matches.length} matcher.`);
}

seed()
  .catch((err) => {
    console.error('Kunde inte lägga in demodata:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
