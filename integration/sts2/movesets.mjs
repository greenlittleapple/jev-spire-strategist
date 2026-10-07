// Observed enemy move sequences: the intent each enemy showed on each round of recent
// fights, so the strategist sees a pattern ("r1 Debuff, r2 Attack 12, r3 Buff") and not
// only the current intent. Built from the run logs at startup and updated live.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';

const combat = new Set(['monster', 'elite', 'boss']);
// Up to FIGHTS_KEPT entries are kept per enemy so the seed boundary (seed-boundary.mjs) can skip some
// and still show the latest FIGHTS_PER_ENEMY.
const FIGHTS_PER_ENEMY = 3, FIGHTS_KEPT = 12, ROUNDS_PER_FIGHT = 12;

export const intentSummary = intents => (intents ?? []).map(i => [i.type ?? i.title, i.label].filter(Boolean).join(' ')).filter(Boolean).join(' + ') || '?';

// memory: {enemyName: [{fight, moves: {round: summary}}]} newest last. Returns true when it changed.
export function recordIntents(memory, state) {
 if (!combat.has(state?.state_type) || !state.battle?.round || state.battle.turn !== 'player') return false;
 const fight = `${state.run?.live_id}:${state.run?.act}:${state.run?.floor}`, round = state.battle.round;
 let changed = false;
 const seen = new Map();
 for (const e of state.battle.enemies ?? []) {
  if (!(e.hp > 0) || !e.name) continue;
  // Same-name enemies in one fight are told apart by entity id (order among the living shifts
  // when one dies); order is the fallback when ids are missing.
  const n = e.entity_id ?? (seen.get(e.name) ?? 0) + 1; seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  const list = memory[e.name] ??= [];
  let entry = list.find(x => x.fight === fight && x.slot === n);
  if (!entry) { entry = {fight, slot: n, moves: {}}; list.push(entry); if (list.length > FIGHTS_KEPT) list.shift(); }
  if (entry.moves[round] || round > ROUNDS_PER_FIGHT) continue;
  entry.moves[round] = intentSummary(e.intents); changed = true;
 }
 return changed;
}

// One line per recent fight, newest first: "r1 Debuff, r2 Attack 12, ...".
// entries: this enemy's entries to use (the seed boundary's kept ones), default all.
export function patternFor(memory, name, currentFight = null, entries = memory[name] ?? []) {
 return entries.filter(x => x.fight !== currentFight).slice(-FIGHTS_PER_ENEMY).reverse()
  .map(x => Object.entries(x.moves).sort(([a], [b]) => a - b).map(([r, m]) => `r${r} ${m}`).join(', '))
  .filter(Boolean);
}

export async function loadMovesets(logFile) {
 const memory = {};
 try {
  for await (const line of createInterface({input: createReadStream(logFile)})) {
   if (!line.includes('"kind":"decision"') || !/"state_type":"(monster|elite|boss)"/.test(line)) continue;
   try { recordIntents(memory, JSON.parse(line).state); } catch {}
  }
 } catch {}
 return memory;
}
