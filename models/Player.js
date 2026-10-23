const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  /** Antal raka vinster direkt före första sparade matchen (streak räknas vidare automatiskt från matcher). */
  prefixWinStreak: { type: Number, default: 0 }
});

module.exports = mongoose.model('Player', playerSchema);
