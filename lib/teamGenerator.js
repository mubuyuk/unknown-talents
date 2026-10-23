/**
 * Laggenerering – delar spelare i två lag enligt vald strategi.
 * generateTeams(players, strategy) → { teamA, teamB }
 * Strategier: "random" (implementerad), "wins", "winrate", "streak", "elo" (placeholders).
 */

const STRATEGIES = ['random', 'wins', 'winrate', 'streak', 'elo'];

/**
 * Slumpar ordning på en kopia av arrayen (Fisher–Yates).
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Delar spelare i två lag. Antalet kan vara ojämnt (t.ex. 6–6 för 12 spelare).
 * @param {Array<{id: number, name: string, ...}>} players – spelare att dela
 * @param {string} strategy – "random" | "wins" | "winrate" | "streak" | "elo"
 * @returns {{ teamA: typeof players, teamB: typeof players }}
 */
function generateTeams(players, strategy = 'random') {
  const s = (strategy && String(strategy).toLowerCase()) || 'random';
  if (!STRATEGIES.includes(s)) {
    throw new Error('Okänd strategi: ' + strategy);
  }
  if (!Array.isArray(players) || players.length < 2) {
    throw new Error('Minst 2 spelare krävs för laggenerering');
  }

  let ordered;
  switch (s) {
    case 'random':
      ordered = shuffle(players);
      break;
    case 'wins':
    case 'winrate':
    case 'streak':
    case 'elo':
      // Placeholder: använd random tills algoritmen implementeras
      ordered = shuffle(players);
      break;
    default:
      ordered = shuffle(players);
  }

  const half = Math.floor(ordered.length / 2);
  return {
    teamA: ordered.slice(0, half),
    teamB: ordered.slice(half)
  };
}

module.exports = { generateTeams, STRATEGIES };
