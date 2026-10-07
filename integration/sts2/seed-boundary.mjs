// Seed boundary for the strategist's memory of earlier runs (v3.19). Enemies' later moves partly
// follow the seed (rounds 2+: 87% move agreement on one seed against 77% across seeds), so a run on a
// replayed seed must not see that seed's earlier runs: seen_pattern, encounter results and the
// review_encounter check, card past_runs, and a saved fight plan written on the current seed skip
// runs on that seed. Mechanic notes are game rules, not a fight, and are not filtered.
// Entries from the current run itself are always kept. An entry whose run has no known seed is kept
// and counted as unknown, so the decision record shows how much memory the boundary could not check.
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname,resolve} from 'node:path';

export const normSeed = seed => seed == null || seed === '' ? null : String(seed).toUpperCase();
// Moveset entries are keyed by fight id `${live_id}:${act}:${floor}`; live ids contain colons.
export const fightRun = fight => fight == null ? null : String(fight).split(':').slice(0, -2).join(':') || null;

// {runId: seed} from series.jsonl rows (start-run) and run_start records (the save's rng seed).
export function addSeriesSeeds(seeds, text) {
 for (const line of String(text ?? '').split(/\r?\n/).filter(Boolean)) {
  try { const s = JSON.parse(line); if (s.run && s.seed) seeds[s.run] = normSeed(s.seed); } catch {}
 }
 return seeds;
}
export function recordRunSeed(seeds, record) {
 const seed = normSeed(record?.setup?.seed);
 if (record?.kind === 'run_start' && record.run && seed) seeds[record.run] = seed;
}
export const seriesPath = logFile => resolve(dirname(logFile), '../series.jsonl');
export async function loadSeriesSeeds(logFile, seeds = {}) {
 return addSeriesSeeds(seeds, await readFile(seriesPath(logFile), 'utf8').catch(() => ''));
}
export async function loadRunSeeds(logFile) {
 const seeds = {};
 try {
  for await (const line of createInterface({input: createReadStream(logFile)})) {
   if (!line.includes('"kind":"run_start"')) continue;
   try { recordRunSeed(seeds, JSON.parse(line)); } catch {}
  }
 } catch {}
 // A run_start record (the save's own seed) wins over the series row.
 return {...await loadSeriesSeeds(logFile), ...seeds};
}

// The boundary for one run. active is false when the current run's seed is unknown: nothing is removed.
// check(run) is 'keep' (other seed or this run), 'same' (removed) or 'unknown' (kept, counted).
export function seedBoundary(runSeeds, runId) {
 const seed = normSeed(runSeeds?.[runId]);
 const check = run => {
  if (!seed || run === runId) return 'keep';
  const other = run == null ? null : normSeed(runSeeds?.[run]);
  return !other ? 'unknown' : other === seed ? 'same' : 'keep';
 };
 return {run: runId ?? null, seed, active: Boolean(seed), check, keep: run => check(run) !== 'same'};
}

const KINDS = ['patterns', 'encounter_results', 'card_stats', 'plans'];
export function newBoundaryRecord(boundary) {
 return {seed: boundary.seed, active: boundary.active,
  removed: Object.fromEntries(KINDS.map(k => [k, 0])), unknown_seed: Object.fromEntries(KINDS.map(k => [k, 0]))};
}
// Counts entries by verdict into the record under kind; returns the kept ones.
export function bound(record, boundary, kind, entries, runOf) {
 const kept = [];
 for (const e of entries) {
  const v = boundary.check(runOf(e));
  if (v === 'same') record.removed[kind]++;
  else { if (v === 'unknown') record.unknown_seed[kind]++; kept.push(e); }
 }
 return kept;
}
