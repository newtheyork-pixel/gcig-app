export const ROLE_SHORT = {
  PortfolioManager: 'PM',
  SeniorPortfolioManager: 'Senior PM',
  Analyst: 'Analyst',
  SeniorAnalyst: 'Senior Analyst',
  JuniorAnalyst: 'Junior Analyst',
  CIO: 'CIO',
  DirectorOfResearch: 'Director of Research',
  President: 'President',
};

export function recordLine(person) {
  if (!person?.decided) {
    return person?.pitches
      ? `${person.pitches} pitch${person.pitches === 1 ? '' : 'es'} · no decision yet`
      : 'No pitches on file';
  }
  const pct = Math.round(person.hitRate * 100);
  return `${person.buys} of ${person.decided} voted yes · ${pct}%`;
}

export function formatClock(ms) {
  const safe = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Same walk as server buildOrder: odd rounds forward, even rounds
// reversed, unless the commissioner turned the snake off.
export function snakePreview(names, rounds, snake) {
  const rows = [];
  const n = Math.max(0, Number(rounds) || 0);
  for (let round = 1; round <= n; round++) {
    const forward = !snake || round % 2 === 1;
    rows.push({ round, names: forward ? [...names] : [...names].reverse() });
  }
  return rows;
}

export function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export const SOURCE = {
  board: 'Pick',
  admin: 'Assigned',
  queue: 'Queue',
  auto: 'Auto',
};
