const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema(
  {
    winnerIds: { type: [Number], default: [] },
    loserIds: { type: [Number], default: [] },
    drawIds: { type: [Number], default: [] },
    /** När matchen registrerades (backup/import). Äldre dokument saknar fält → datum härleds från _id. */
    date: { type: Date, default: null }
  },
  { collection: 'player-stats' }
);

module.exports = mongoose.model('Match', matchSchema);
