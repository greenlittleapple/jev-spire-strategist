// Compares the planner's forecast and the engine's shadow forecast (sim_forecast records) for the
// chosen candidate of each executed combat decision with what happened.
//   npm run sts2:sim-compare -- [--since ISO-time] [--json]
// HP after, HP lost and survival come from the first observation of a later round in the same
// fight (the start of the next turn, after the enemy turn); a run that ends at 0 HP first counts as
// 0 HP. Damage, Block, energy left and enemies defeated are measured only when the turn played
// exactly the chosen line and then ended, from the state at that end_turn decision. Enemies are
// matched by combat_id; the bridge lists living enemies only, so one that is missing counts as dead.
// Live mode (SIM_FORECAST=live): the chosen forecast is the engine's, so the planner's numbers come
// from the sim record. exact_match checks the one-sample lines (no draw or random effect) for equal
// damage, Block and HP after the enemy turn, and lists every mismatch.
// Logs are read from $STS2_PRIVATE_DIR/runs (default .private/sts2/runs), streamed line by line.
import {readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, dirname} from 'node:path';
import {FORECAST_FIELDS, workerActions, targetIds, enemyKey, pickForecast} from './sim-shadow.mjs';

const combat = new Set(['monster', 'elite', 'boss']);
// Screens that mean the fight is over; in-fight choice screens (hand_select) keep it open.
const after = new Set(['rewards', 'card_reward', 'map', 'event', 'rest_site', 'shop', 'treasure', 'game_over']);
const alive = e => (e?.hp ?? 0) > 0;
const pick = pickForecast;
// Fields whose engine forecast must equal the outcome exactly on a line with no draw or random effect.
export const EXACT_FIELDS = ['damage', 'block', 'hpAfter'];

// Keeps what the comparison reads. Other kinds give null.
export function slimRecord(e) {
  if (e.kind === 'run_end') return {kind: 'run_end', time: e.time, run: e.state?.run?.live_id ?? null, hp: e.state?.player?.hp ?? 0};
  // Shadow records count when ok; live records whenever they carry results (a timeout can leave some).
  // A live record keeps the planner's numbers for the candidates whose forecast the engine replaced.
  if (e.kind === 'sim_forecast') return (e.status === 'ok' || e.mode === 'live') && Object.keys(e.results ?? {}).length
    ? {kind: 'sim', time: e.time, run: e.run, decision: e.decision, started: e.decision_started ?? e.time, results: e.results, planner: e.planner ?? null, live: e.mode === 'live'} : null;
  if (e.kind !== 'decision') return null;
  // Enemies are keyed, and targets named, by combat_id: entity_ids shift when an enemy dies.
  const s = e.state ?? {}, p = s.player ?? {}, chosen = e.chosen, targets = targetIds(s.battle?.enemies);
  return {kind: 'decision', time: e.time, outcome: e.outcome ?? null, stateHash: e.stateHash ?? null,
    run: s.run?.live_id ?? null, act: s.run?.act ?? null, floor: s.run?.floor ?? null, combat: combat.has(s.state_type) && Boolean(s.battle), ended: after.has(s.state_type) || !s.battle,
    round: s.battle?.round ?? null, hp: p.hp ?? null, max_hp: p.max_hp ?? null, block: p.block ?? null, energy: p.energy ?? null,
    enemies: (s.battle?.enemies ?? []).map(x => ({id: String(enemyKey(x)), hp: x.hp ?? 0})),
    command: chosen?.command ?? null, step: chosen?.command ? workerActions([{command: chosen.command}], targets).actions?.[0] ?? null : null,
    chosenId: chosen?.id ?? null, plan: workerActions(chosen?.plan, targets).actions ?? null,
    // In live mode the chosen forecast is the engine's; the planner's numbers are in the sim record.
    source: chosen?.forecast?.source ?? null, planner: chosen?.forecast?.source === 'engine' ? null : pick(chosen?.forecast)};
}

const sameFight = (a, b) => a.run === b.run && a.act === b.act && a.floor === b.floor;

// What happened after decision i: {hpAfter, hpLoss, survives} and, when the line was followed,
// {damage, block, energyLeft, defeatedEnemies}. Fields not measured are absent.
export function actualAfter(records, i) {
  const d = records[i], out = {followed: false};
  for (let j = i + 1; j < records.length; j++) {
    const r = records[j];
    if (r.run !== d.run) continue;
    if (r.kind === 'run_end') { if (r.hp <= 0) Object.assign(out, {hpAfter: 0, hpLoss: d.hp, survives: false}); break; }
    if (r.kind !== 'decision') continue;
    if (r.ended || !sameFight(r, d)) { out.survives = true; out.fightEnded = true; break; }
    if (r.round > d.round) {
      Object.assign(out, {hpAfter: r.hp, hpLoss: Math.max(0, d.hp - r.hp) + Math.max(0, (d.max_hp ?? 0) - (r.max_hp ?? d.max_hp ?? 0)), survives: r.hp > 0});
      break;
    }
  }
  // The executed commands of this turn from this decision on, up to its end_turn.
  if (d.plan) {
    const played = [];
    for (let j = i; j < records.length; j++) {
      const r = records[j];
      if (r.kind !== 'decision' || r.run !== d.run) continue;
      if (!sameFight(r, d) || r.round !== d.round) break;
      if (r.outcome !== 'executed') continue;
      if (r.command?.action === 'end_turn') {
        if (JSON.stringify(played) === JSON.stringify(d.plan)) {
          // The bridge lists living enemies only: one missing at the end of the line died there.
          const hpAt = id => r.enemies.find(e => e.id === id)?.hp ?? 0;
          const start = d.enemies.filter(alive);
          Object.assign(out, {followed: true, block: r.block, energyLeft: r.energy,
            damage: start.reduce((n, e) => n + Math.max(0, e.hp - hpAt(e.id)), 0),
            defeatedEnemies: start.filter(e => hpAt(e.id) <= 0).length});
        }
        break;
      }
      played.push(r.step);
      if (played.length > d.plan.length) break;
    }
  }
  return out;
}

const agrees = (a, b) => typeof a === 'boolean' || typeof b === 'boolean' ? a === b : Math.abs(a - b) <= 0.5;
const PAIRS = [['planner', 'actual'], ['sim', 'actual'], ['planner', 'sim']];

export function compare(records, {since = null} = {}) {
  const sims = new Map();
  for (const r of records) if (r.kind === 'sim') { const k = `${r.run}|${r.decision}`; (sims.get(k) ?? sims.set(k, []).get(k)).push(r); }
  const rows = [], counts = {decisions: 0, with_sim: 0, chosen_not_simulated: 0, followed: 0};
  records.forEach((d, i) => {
    if (d.kind !== 'decision' || !d.combat || d.outcome !== 'executed' || (since && d.time < since)) return;
    counts.decisions++;
    const sim = (sims.get(`${d.run}|${d.stateHash}`) ?? []).filter(s => !d.time || s.started <= d.time).at(-1);
    if (!sim) return;
    counts.with_sim++;
    const forecast = sim.results[d.chosenId];
    if (!forecast || forecast.ok === false) { counts.chosen_not_simulated++; return; }
    const actual = actualAfter(records, i);
    if (actual.followed) counts.followed++;
    rows.push({run: d.run, act: d.act, floor: d.floor, round: d.round, time: d.time, chosen: d.chosenId, planner: d.planner ?? sim.planner?.[d.chosenId] ?? {}, sim: forecast, actual,
      exact: forecast.exact === true, fixed: forecast.samples === 1, engine: d.source === 'engine'});
  });
  const agreement = {};
  for (const f of FORECAST_FIELDS) {
    agreement[f] = {};
    for (const [a, b] of PAIRS) {
      let n = 0, agree = 0;
      for (const r of rows) { const x = r[a][f], y = r[b][f]; if (x == null || y == null) continue; n++; if (agrees(x, y)) agree++; }
      agreement[f][`${a}_vs_${b}`] = {n, agree, rate: n ? Math.round(agree / n * 1000) / 1000 : null};
    }
  }
  const gaps = [];
  for (const r of rows) for (const f of FORECAST_FIELDS) {
    const v = {planner: r.planner[f], sim: r.sim[f], actual: r.actual[f]};
    let gap = 0;
    for (const [a, b] of PAIRS) {
      if (v[a] == null || v[b] == null || agrees(v[a], v[b])) continue;
      gap = Math.max(gap, typeof v[a] === 'boolean' || typeof v[b] === 'boolean' ? 1000 : Math.abs(v[a] - v[b]));
    }
    if (gap) gaps.push({run: r.run, act: r.act, floor: r.floor, round: r.round, time: r.time, field: f, ...v, gap});
  }
  gaps.sort((a, b) => b.gap - a.gap);
  return {counts: {...counts, compared: rows.length, exact: rows.filter(r => r.exact).length, engine: rows.filter(r => r.engine).length},
    agreement, disagreements: gaps.slice(0, 20), exact_match: exactMatch(rows)};
}

// Lines simulated with one sample (the planner found no draw or random effect): the engine's damage,
// Block and HP after the enemy turn against the outcome, compared for equality. Every mismatch is
// listed. engine counts the rows whose forecast Jev used (live mode).
export function exactMatch(rows) {
  const fixed = rows.filter(r => r.fixed), fields = {}, mismatches = [];
  for (const f of EXACT_FIELDS) {
    let n = 0, match = 0, engine = 0;
    for (const r of fixed) {
      const x = r.sim[f], y = r.actual[f];
      if (x == null || y == null) continue;
      n++; if (r.engine) engine++;
      if (x === y) match++;
      else mismatches.push({run: r.run, act: r.act, floor: r.floor, round: r.round, time: r.time, chosen: r.chosen, field: f, sim: x, actual: y, planner: r.planner[f] ?? null, engine: r.engine});
    }
    fields[f] = {n, match, engine, rate: n ? Math.round(match / n * 1000) / 1000 : null};
  }
  return {lines: fixed.length, fields, mismatches};
}

export function report(result) {
  const c = result.counts, out = [];
  out.push(`Executed combat decisions: ${c.decisions}; with a sim forecast: ${c.with_sim}; chosen line compared: ${c.compared} (exact ${c.exact}); chosen line not simulated: ${c.chosen_not_simulated}; line followed to end_turn: ${c.followed}`);
  out.push('', 'Agreement (numbers within 0.5): planner vs actual | sim vs actual | planner vs sim');
  const cell = x => x.n ? `${(x.rate * 100).toFixed(1)}% of ${x.n}` : '-';
  for (const [f, a] of Object.entries(result.agreement))
    out.push(`${f.padEnd(16)} ${cell(a.planner_vs_actual).padEnd(16)} ${cell(a.sim_vs_actual).padEnd(16)} ${cell(a.planner_vs_sim)}`);
  if (result.disagreements.length) out.push('', 'Largest disagreements');
  for (const g of result.disagreements)
    out.push(`${g.run} a${g.act} f${g.floor} r${g.round} ${g.field}: planner ${g.planner}, sim ${g.sim}, actual ${g.actual ?? '-'}`);
  const x = result.exact_match;
  if (x) {
    out.push('', `Exact match, lines with no draw or random effect (${x.lines} lines; target 100%): sim equal to actual`);
    for (const [f, a] of Object.entries(x.fields)) out.push(`${f.padEnd(16)} ${a.n ? `${(a.rate * 100).toFixed(1)}% of ${a.n} (${a.engine} used live)` : '-'}`);
    if (x.mismatches.length) out.push('', `Mismatches (${x.mismatches.length})`);
    for (const m of x.mismatches)
      out.push(`${m.run} a${m.act} f${m.floor} r${m.round} ${m.chosen} ${m.field}: sim ${m.sim}, actual ${m.actual}, planner ${m.planner ?? '-'}${m.engine ? ' (live)' : ''}`);
  }
  return out.join('\n');
}

// Streams the logs; records older than since are skipped before parsing (each line starts with its time).
export async function readRecords(dir, {since = null} = {}) {
  const records = [];
  for (const f of (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort())
    for await (const line of createInterface({input: createReadStream(resolve(dir, f)), crlfDelay: Infinity})) {
      if (!/"kind":"(?:decision|sim_forecast|run_end)"/.test(line)) continue;
      const time = line.match(/^\{"time":"([^"]+)"/)?.[1];
      if (since && time && time < since) continue;
      try { const r = slimRecord(JSON.parse(line)); if (r) records.push(r); } catch {}
    }
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = process.env.STS2_PRIVATE_DIR ? resolve(process.env.STS2_PRIVATE_DIR, 'runs') : process.env.SPIRE_LOG_DIR ?? resolve(root, '.private/sts2/runs');
  const arg = k => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null;
  const since = arg('--since');
  const result = compare(await readRecords(dir, {since}), {since});
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 1) : report(result));
}
