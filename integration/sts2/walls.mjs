// Offline evaluation of STS2 runs by stretch of floors: per-stretch hazards with Wilson intervals, a
// continuous per-run score (floors cleared plus the share of the fatal fight's enemy HP removed), version
// comparisons on that score with a bootstrap interval, and a per-run line. Reads docs/progress/data.json for
// the run list and the private run logs for the fatal fights. No game, no runner.
//   npm run sts2:walls -- [--group strategist] [--by version|group] [--stretches 1-16,17,...] [--json]
//   npm run sts2:walls -- --score
//   npm run sts2:walls -- --compare --a "version=Strategist ..v3.17" --b "version=Strategist v3.18" [--from-floor 1]
//   npm run sts2:walls -- --run <run id | seed+version>
// Shared filters: --version, --group, --seeds, --mode, --since, --until, --exclude-issues.
import {readFileSync, existsSync} from 'node:fs';
import {createReadStream} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {logPaths, versionNumber} from './progress-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_STRETCHES = '1-16,17,18-32,33,34-47,48';
const DEFAULT_LABELS = ['Act 1', 'Act 1 boss', 'Act 2', 'Act 2 boss', 'Act 3', 'Act 3 boss'];
export const WIN_SCORE = 49;
// Some death effects replace an enemy's HP (and max HP) with a placeholder value; the enemy is dead.
const PLACEHOLDER_HP = 1e8;
const COMBAT = new Set(['monster', 'elite', 'boss']);
const FIGHT_TYPE = {monster: 'hallway', elite: 'elite', boss: 'boss'};

// ---- statistics

// Wilson score interval for k of n (95% by default).
export function wilson(k, n, z = 1.959964) {
 if (!n) return [0, 1];
 const p = k / n, z2 = z * z, d = 1 + z2 / n;
 const c = (p + z2 / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
 return [Math.max(0, c - h), Math.min(1, c + h)];
}

const LF = [0];
const logFact = n => { for (let i = LF.length; i <= n; i++) LF[i] = LF[i - 1] + Math.log(i); return LF[n]; };
// Two-sided Fisher exact p for [[a, b], [c, d]]: the sum of tables with the same margins no more likely than this one.
export function fisher(a, b, c, d) {
 const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
 const lp = x => logFact(r1) + logFact(r2) + logFact(c1) + logFact(n - c1) - logFact(n) - logFact(x) - logFact(r1 - x) - logFact(c1 - x) - logFact(r2 - c1 + x);
 const obs = lp(a);
 let p = 0;
 for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) { const l = lp(x); if (l <= obs + 1e-7) p += Math.exp(l); }
 return Math.min(1, p);
}

export function median(xs) {
 if (!xs.length) return null;
 const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
 return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
// Quantile by linear interpolation (type 7).
export function quantile(xs, q) {
 if (!xs.length) return null;
 const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i);
 return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}
// Seeded RNG (mulberry32) for the bootstrap.
export function rng(seed) {
 let t = seed >>> 0;
 return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
// Bootstrap 95% interval of mean(b) - mean(a), percentile method.
export function bootstrapDiff(a, b, {iters = 4000, seed = 1} = {}) {
 if (!a.length || !b.length) return null;
 const r = rng(seed), draw = xs => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]; return s / xs.length; };
 const ds = [];
 for (let i = 0; i < iters; i++) { const da = draw(a); ds.push(draw(b) - da); }
 return [quantile(ds, 0.025), quantile(ds, 0.975)];
}

// ---- runs and filters

const shortId = id => String(id ?? '').split(':').pop();
// A version's group: its own field, else from its name (Strategist ... or Jev ...).
export const groupOf = v => v.group ?? (/^Strategist\b/.test(v.name) ? 'strategist' : /^Jev\b/.test(v.name) ? 'jev' : null);

// The progress file's runs, each with its version's name, policy, group and mode. Runs listed in
// data.excluded join as "excluded" (unfinished) when their version and floor can be read from the reason.
export function loadRuns(data) {
 const runs = data.versions.flatMap(v => v.runs.map(r => ({...r, version: v.name, policy: v.policy, group: groupOf(v), mode: r.mode ?? v.mode ?? null})));
 for (const x of data.excluded ?? []) {
  const name = /\(((?:Jev|Strategist) v\d+(?:\.\d+)*)\)/.exec(x.reason ?? '')?.[1];
  const v = data.versions.find(v => v.name === name);
  if (!v) continue;
  const seed = /^(\S+) \(/.exec(x.reason)?.[1] ?? null, floor = +(/floor (\d+)/.exec(x.reason)?.[1] ?? NaN);
  runs.push({run: x.run, seed, result: 'excluded', floor: Number.isFinite(floor) ? floor : null, version: v.name, policy: v.policy, group: groupOf(v), mode: v.mode ?? null, excluded: x.reason});
 }
 return runs;
}

const died = r => r.result === 'lost';
const won = r => r.result === 'won';
// Finished: won or lost. Anything else (abandoned, stopped, excluded, in progress) is censored at its floor.
export const finished = r => died(r) || won(r);

// "JEV21-JEV25", "JEV21-25", "JEV3,JEV7" as a predicate on a seed.
export function parseSeeds(spec) {
 if (spec == null || spec === '') return null;
 const parts = String(spec).split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const m = s.match(/^([A-Za-z_]*)(\d+)\s*-\s*([A-Za-z_]*)(\d+)$/);
  if (m) return {prefix: m[1].toUpperCase(), lo: +m[2], hi: +m[4]};
  const one = s.match(/^([A-Za-z_]*)(\d+)$/);
  return one ? {prefix: one[1].toUpperCase(), lo: +one[2], hi: +one[2]} : {exact: s.toUpperCase()};
 });
 return seed => {
  if (seed == null) return false;
  const S = String(seed).toUpperCase(), m = S.match(/^([A-Z_]*)(\d+)$/);
  return parts.some(p => p.exact ? S === p.exact : !!m && m[1] === p.prefix && +m[2] >= p.lo && +m[2] <= p.hi);
 };
}

const cmpVersion = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
// A version filter: a comma list of names or ranges "Strategist v3..v3.17" / "Strategist ..v3.17" /
// "Strategist v3.5.." (same name prefix, inclusive bounds).
export function parseVersions(spec) {
 if (spec == null || spec === '') return null;
 const parts = String(spec).split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const m = s.match(/^(.*?)\s*v?(\d+(?:\.\d+)*)?\s*\.\.\s*v?(\d+(?:\.\d+)*)?$/);
  if (!m) return {name: s};
  return {prefix: m[1].trim(), lo: m[2] ? m[2].split('.').map(Number) : null, hi: m[3] ? m[3].split('.').map(Number) : null};
 });
 return name => parts.some(p => {
  if (p.name) return name === p.name;
  if (!name.startsWith(p.prefix + ' ')) return false;
  const n = versionNumber(name);
  return !!n && (!p.lo || cmpVersion(n, p.lo) >= 0) && (!p.hi || cmpVersion(n, p.hi) <= 0);
 });
}

// A run's start time in ms: the logged first event if known, else its id (Unix seconds).
export const runTime = (r, logs) => logs?.get(r.run)?.started ? Date.parse(logs.get(r.run).started) : /^\d{9,11}$/.test(r.run) ? +r.run * 1000 : NaN;
const listOf = x => x == null ? [] : Array.isArray(x) ? x.flatMap(listOf) : String(x).split(',').map(s => s.trim()).filter(Boolean);

// Filters: version (names or ranges), group, mode, policy, seeds, since/until (ISO), excludeIssues (list).
export function selectRuns(runs, f = {}, logs = new Map()) {
 const ver = parseVersions(f.version), seeds = parseSeeds(f.seeds), excl = new Set(listOf(f.excludeIssues));
 const since = f.since ? Date.parse(f.since) : null, until = f.until ? Date.parse(f.until) : null;
 return runs.filter(r => {
  if (ver && !ver(r.version)) return false;
  if (f.group && r.group !== f.group) return false;
  if (f.mode && r.mode !== f.mode) return false;
  if (f.policy && r.policy !== f.policy) return false;
  if (seeds && !seeds(r.seed)) return false;
  if ((r.issues ?? []).some(i => excl.has(i))) return false;
  if (since != null || until != null) {
   const t = runTime(r, logs);
   if (since != null && !(t >= since)) return false;
   if (until != null && !(t < until)) return false;
  }
  return true;
 });
}

// "version=Strategist v3.18" or "group=strategist,seeds=JEV21-JEV25" as a filter object (commas inside a value are kept).
export function parseFilter(spec) {
 const keys = {'exclude-issues': 'excludeIssues'};
 const out = {};
 for (const part of String(spec).split(/,(?=\s*[a-z-]+=)/)) {
  const m = part.match(/^\s*([a-z-]+)=(.*)$/);
  if (!m) throw new Error(`Bad filter "${part}" (want key=value).`);
  out[keys[m[1]] ?? m[1]] = m[2].trim();
 }
 return out;
}

// ---- stretch table

export function parseStretches(spec = DEFAULT_STRETCHES) {
 const list = String(spec).split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const m = s.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) throw new Error(`Bad stretch "${s}".`);
  return {from: +m[1], to: +(m[2] ?? m[1]), floors: s};
 });
 const labelled = String(spec) === DEFAULT_STRETCHES;
 return list.map((b, i) => ({...b, label: labelled ? DEFAULT_LABELS[i] : `Floors ${b.floors}`}));
}

// Per stretch: runs that reached its first floor (a win reaches every stretch; an unfinished run counts only in
// stretches it got past whole), those that died in it, the hazard with its Wilson interval, and the running
// product of (1 - hazard), the estimated rate of getting through (after the last stretch, the win rate).
export function wallTable(runs, stretches = parseStretches()) {
 let clear = 1;
 return stretches.map(b => {
  const reached = runs.filter(r => won(r) || (r.floor >= b.from && (died(r) || r.floor > b.to))).length;
  const dead = runs.filter(r => died(r) && r.floor >= b.from && r.floor <= b.to).length;
  const hazard = reached ? dead / reached : null;
  if (hazard != null) clear *= 1 - hazard;
  return {stretch: b.label, floors: b.floors, from: b.from, to: b.to, reached, died: dead, hazard, ci: wilson(dead, reached), clear: reached ? clear : null};
 });
}

// ---- fights from the logs

// Collects, per run, its first event time, its last floor, and its last fight (the combat states of the last
// floor with a battle), plus the phase sequence of every enemy seen in any fight. Feed events with add().
export function fightCollector() {
 const runs = new Map(), phases = new Map();
 const add = e => {
  const s = e.state, id = shortId(s?.run?.live_id);
  if (!id) return;
  const r = runs.get(id) ?? runs.set(id, {id, started: e.time ?? null, floor: null, act: null, fight: null, ended: false}).get(id);
  r.floor = s.run.floor ?? r.floor; r.act = s.run.act ?? r.act;
  if (e.kind === 'run_end') { r.ended = true; return; }
  if (!s.battle || !Array.isArray(s.battle.enemies)) return;
  const floor = s.run.floor;
  if (!r.fight || r.fight.floor !== floor || r.fight.act !== s.run.act) r.fight = {floor, act: s.run.act, type: null, states: []};
  if (COMBAT.has(s.state_type)) r.fight.type ??= FIGHT_TYPE[s.state_type];
  r.fight.states.push({round: s.battle.round ?? null, hp: s.player?.hp ?? null, max_hp: s.player?.max_hp ?? null,
   potions: (s.player?.potions ?? []).filter(Boolean).map(p => p.name ?? p.id),
   enemies: s.battle.enemies.map(x => ({id: x.entity_id ?? x.name, name: x.name, hp: x.hp, max_hp: x.max_hp}))});
 };
 const result = () => {
  for (const r of runs.values()) if (r.fight) for (const [base, seq] of enemyPhases(r.fight)) if (seq.length > (phases.get(base)?.length ?? 0)) phases.set(base, seq);
  return {runs, phases};
 };
 return {add, result};
}
// The kind of entity an enemy is, across fights: its entity id without the instance number.
const baseOf = id => String(id).replace(/_\d+$/, '');

// Each enemy's phases in a fight: a max HP change (not to the placeholder) with HP going up starts a new
// phase (a multi-phase boss such as Test Subject goes 100, 200, 300); otherwise it adjusts the current one.
// Returns Map base id -> [phase max HP] for the longest sequence seen.
export function enemyPhases(fight) {
 const out = new Map();
 for (const [, e] of fightEnemies(fight)) if (e.phases.length > (out.get(e.base)?.length ?? 0)) out.set(e.base, e.phases.map(p => p.max));
 return out;
}
function fightEnemies(fight) {
 const ents = new Map();
 for (const st of fight.states) {
  for (const x of st.enemies) {
   let e = ents.get(x.id);
   if (!e) { e = {id: x.id, base: baseOf(x.id), name: x.name, phases: [], dead: false, hp: null}; ents.set(x.id, e); }
   if (x.hp >= PLACEHOLDER_HP || x.max_hp >= PLACEHOLDER_HP) { e.dead = true; continue; }
   const cur = e.phases.at(-1);
   if (!cur) e.phases.push({max: x.max_hp});
   else if (x.max_hp !== cur.max) { if (e.dead || x.hp > (e.hp ?? 0)) e.phases.push({max: x.max_hp}); else cur.max = x.max_hp; }
   e.hp = x.hp; e.dead = x.hp <= 0; e.name = x.name;
  }
 }
 const last = fight.states.at(-1), present = new Set(last ? last.enemies.filter(x => x.hp > 0 && x.hp < PLACEHOLDER_HP && x.max_hp < PLACEHOLDER_HP).map(x => x.id) : []);
 for (const e of ents.values()) e.alive = present.has(e.id) && !e.dead;
 return ents;
}

// The share of a fight's total enemy HP removed (0 to 1). Total: every enemy seen, each phase's max HP, plus
// later phases known from other fights (`phases`, base id -> [max HP]) that this fight never reached. An
// enemy still present in the last state has (max - hp) of its current phase removed; one gone, at 0 HP or at
// the placeholder HP is dead. Also the fight's name (enemy names, largest first) and the HP and potions entering it.
export function fightShare(fight, phases = new Map()) {
 if (!fight?.states?.length) return null;
 let total = 0, removed = 0;
 const ents = [...fightEnemies(fight).values()];
 for (const e of ents) {
  const seen = e.phases.map(p => p.max), known = phases.get(e.base) ?? [];
  const extra = known.length > seen.length && known.slice(0, seen.length).every((m, i) => m === seen[i]) ? known.slice(seen.length) : [];
  const all = seen.reduce((a, b) => a + b, 0) + extra.reduce((a, b) => a + b, 0);
  total += all;
  const done = seen.slice(0, -1).reduce((a, b) => a + b, 0), cur = seen.at(-1) ?? 0;
  removed += done + (e.alive ? Math.max(0, cur - Math.max(0, e.hp)) : cur);
 }
 const first = fight.states[0];
 const name = [...new Map(ents.map(e => [e.name, Math.max(0, ...e.phases.map(p => p.max))])).entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).join(' + ');
 return {floor: fight.floor, act: fight.act, type: fight.type ?? 'other', name, share: total ? Math.min(1, removed / total) : null,
  total_hp: total, removed_hp: removed, entry_hp: first.hp, entry_max_hp: first.max_hp, entry_potions: first.potions};
}

// A run's score: floors cleared plus the share of the fatal fight's enemy HP removed. A win scores 49. A loss
// whose last logged fight is not on its final floor (or has no log) has share null, counted as 0. Unfinished runs: null.
export function runScore(run, log, phases) {
 if (won(run)) return {score: WIN_SCORE, share: null, fight: null, logged: !!log};
 if (!died(run)) return {score: null, share: null, fight: null, logged: !!log};
 const f = log?.fight && log.fight.floor === run.floor ? fightShare(log.fight, phases) : null;
 const share = f?.share ?? null;
 return {score: run.floor - 1 + (share ?? 0), share, fight: f, logged: !!log};
}

const dist = xs => xs.length ? {n: xs.length, min: Math.min(...xs), q1: quantile(xs, 0.25), median: quantile(xs, 0.5), q3: quantile(xs, 0.75), max: Math.max(...xs)} : null;
export function scoreReport(runs, logs, phases, stretches = parseStretches()) {
 const scored = runs.filter(finished).map(r => ({run: r.run, version: r.version, seed: r.seed, floor: r.floor, died: died(r), ...runScore(r, logs.get(r.run), phases)}));
 const deaths = scored.filter(s => s.died), scores = scored.map(s => s.score);
 const byStretch = stretches.map(b => {
  const xs = deaths.filter(s => s.floor >= b.from && s.floor <= b.to);
  return {stretch: b.label, deaths: xs.length, null_share: xs.filter(s => s.share == null).length, share: dist(xs.map(s => s.share).filter(x => x != null))};
 }).filter(x => x.deaths);
 return {n: scored.length, unfinished: runs.length - scored.length, median: median(scores), mean: mean(scores), score_dist: dist(scores),
  deaths: deaths.length, null_share: deaths.filter(s => s.share == null).length, stretches: byStretch,
  scored: scored.map(({fight, logged, ...s}) => ({...s, fight: fight ? `${fight.name} (${fight.type}, f${fight.floor})` : null}))};
}

// ---- compare

// Two arms (filters on top of the shared selection), each conditioned on reaching fromFloor: stretch hazards,
// score median and mean, the difference in mean score (b - a) with a bootstrap interval, and a Fisher p per
// stretch. Runs lost before fromFloor are left out and reported; unfinished runs count in the hazards only
// for stretches they got past, and have no score.
export function compareArms(runs, logs, phases, fa, fb, {fromFloor = 1, stretches = parseStretches(), seed = 1, iters = 4000} = {}) {
 const arm = f => {
  const sel = selectRuns(runs, f, logs), all = sel.filter(finished);
  const early = all.filter(r => died(r) && r.floor < fromFloor).length;
  const kept = sel.filter(r => won(r) || r.floor >= fromFloor);
  const ms = kept.filter(finished).map(r => runScore(r, logs.get(r.run), phases)), scores = ms.map(m => m.score);
  const deaths = kept.filter(died).length;
  return {filter: f, total: sel.length, unfinished: sel.length - all.length, early, n: kept.filter(finished).length, deaths,
   null_share: ms.filter(m => m.score !== WIN_SCORE && m.share == null).length, scores, median: median(scores), mean: mean(scores),
   walls: wallTable(kept, stretches.filter(b => b.to >= fromFloor))};
 };
 const A = arm(fa), B = arm(fb);
 const walls = A.walls.map((w, i) => {
  const v = B.walls[i];
  return {stretch: w.stretch, a: w, b: v, p: w.reached || v.reached ? fisher(w.died, w.reached - w.died, v.died, v.reached - v.died) : null};
 });
 const strip = ({scores, ...x}) => x;
 return {from_floor: fromFloor, a: strip(A), b: strip(B), diff: A.mean != null && B.mean != null ? B.mean - A.mean : null,
  diff_ci: bootstrapDiff(A.scores, B.scores, {seed, iters}), walls};
}

// ---- run line

// Runs matching "<run id>" or "<seed>+<version>" (also "<seed>@<version>").
export function findRuns(runs, spec) {
 const m = String(spec).match(/^([^+@]+)[+@](.+)$/);
 if (m) return runs.filter(r => String(r.seed).toUpperCase() === m[1].trim().toUpperCase() && r.version === m[2].trim());
 return runs.filter(r => r.run === String(spec).trim());
}
export function runLine(run, log, phases) {
 const s = runScore(run, log, phases);
 const f = s.fight ?? (log?.fight ? fightShare(log.fight, phases) : null);
 return {run: run.run, version: run.version, seed: run.seed ?? null, result: run.result, act: run.act ?? log?.act ?? null, floor: run.floor, score: s.score, share: s.share,
  fatal_fight: f && (s.fight || !finished(run)) ? {name: f.name, type: f.type, floor: f.floor, share: f.share, entry_hp: f.entry_hp, entry_max_hp: f.entry_max_hp, potions: f.entry_potions} : null};
}

// ---- logs

// Streams decision and run_end events from every run log (only runs in `want`, a Set of run ids, when given).
export async function readFights({logDir} = logPaths(), want = null) {
 const c = fightCollector();
 for (const f of (await readdir(logDir)).filter(f => f.endsWith('.jsonl')).sort())
  for await (const line of createInterface({input: createReadStream(resolve(logDir, f))})) {
   if (!line.includes('"kind":"decision"') && !line.includes('"kind":"run_end"')) continue;
   if (want) { const id = line.match(/"live_id":"(?:[^"]*:)?(\d+)"/)?.[1]; if (!id || !want.has(id)) continue; }
   c.add(JSON.parse(line));
  }
 return c.result();
}

// ---- text output

const pct = x => x == null ? '-' : `${(100 * x).toFixed(0)}%`;
const f2 = x => x == null ? '-' : x.toFixed(2);
const pad = rows => {
 const w = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
 return rows.map(r => r.map((c, i) => i ? String(c).padStart(w[i]) : String(c).padEnd(w[i])).join('  ')).join('\n');
};
export const formatWalls = rows => pad([['stretch', 'floors', 'reached', 'died', 'hazard', '95% CI', 'through'],
 ...rows.map(r => [r.stretch, r.floors, r.reached, r.died, pct(r.hazard), r.reached ? `${pct(r.ci[0])}-${pct(r.ci[1])}` : '-', pct(r.clear)])]);
function formatBy(key, groups) {
 const cols = groups[0]?.rows.map(r => r.stretch) ?? [];
 return pad([[key, 'n', ...cols, 'win est'], ...groups.map(g => [g.key, g.n, ...g.rows.map(r => r.reached ? `${r.died}/${r.reached}` : '-'), pct(g.rows.filter(r => r.clear != null).at(-1)?.clear)])]);
}
const fd = d => d ? `${f2(d.min)} ${f2(d.q1)} ${f2(d.median)} ${f2(d.q3)} ${f2(d.max)} (n ${d.n})` : '-';
function formatScore(rep) {
 return [`Score (floors cleared + fatal-fight HP share; a win scores ${WIN_SCORE}): median ${f2(rep.median)}, mean ${f2(rep.mean)} over ${rep.n} finished runs (${rep.unfinished} unfinished left out); `
  + `${rep.null_share} of ${rep.deaths} deaths have no readable fatal fight (share null, counted as 0).`,
  `Score distribution (min q1 median q3 max): ${fd(rep.score_dist)}`, '', 'Fatal-fight share removed (min q1 median q3 max) by stretch with deaths:',
  pad([['stretch', 'deaths', 'null', 'share'], ...rep.stretches.map(r => [r.stretch, r.deaths, r.null_share, fd(r.share)])])].join('\n');
}
function formatCompare(c) {
 const fl = f => Object.entries(f).map(([k, v]) => `${k}=${v}`).join(',');
 const cell = w => w.reached ? `${w.died}/${w.reached} ${pct(w.hazard)}` : '-';
 const fp = p => p == null ? '-' : p < 0.001 ? p.toExponential(1) : p.toFixed(3);
 const ci = c.diff_ci ? `${f2(c.diff_ci[0])} to ${f2(c.diff_ci[1])}` : '-';
 return [`Compare${c.from_floor > 1 ? ` from floor ${c.from_floor}` : ''}. A: ${fl(c.a.filter)} (${c.a.n} finished runs). B: ${fl(c.b.filter)} (${c.b.n} finished runs).`,
  ...(c.from_floor > 1 ? [`Lost before floor ${c.from_floor}, left out: A ${c.a.early}, B ${c.b.early}.`] : []),
  `Unfinished runs (hazards only, no score): A ${c.a.unfinished}, B ${c.b.unfinished}. Deaths without a readable fatal fight (share counted as 0): A ${c.a.null_share}/${c.a.deaths}, B ${c.b.null_share}/${c.b.deaths}.`,
  `Score: A median ${f2(c.a.median)} mean ${f2(c.a.mean)}; B median ${f2(c.b.median)} mean ${f2(c.b.mean)}; B - A mean ${f2(c.diff)} (bootstrap 95% ${ci}).`,
  pad([['stretch', 'A died/reached', 'B died/reached', 'Fisher p'], ...c.walls.map(w => [w.stretch, cell(w.a), cell(w.b), fp(w.p)])])].join('\n');
}
const formatRun = l => [l.run, l.version, `seed ${l.seed ?? '-'}`, l.result, `floor ${l.floor ?? '-'}`, `score ${f2(l.score)}`,
 l.fatal_fight ? `${l.result === 'lost' ? 'fatal' : 'last fight'} ${l.fatal_fight.name} (${l.fatal_fight.type}, f${l.fatal_fight.floor}) ${pct(l.fatal_fight.share)} removed` : `fatal ${l.result === 'won' ? '-' : 'not found'}`,
 l.fatal_fight ? `entered at ${l.fatal_fight.entry_hp}/${l.fatal_fight.entry_max_hp} HP with ${l.fatal_fight.potions.length} potions${l.fatal_fight.potions.length ? ` (${l.fatal_fight.potions.join(', ')})` : ''}` : null].filter(Boolean).join(' | ');

// ---- CLI

const OPTIONS = {
 version: {type: 'string'}, group: {type: 'string'}, mode: {type: 'string'}, seeds: {type: 'string'}, since: {type: 'string'}, until: {type: 'string'},
 'exclude-issues': {type: 'string'}, data: {type: 'string'}, stretches: {type: 'string'}, by: {type: 'string'},
 score: {type: 'boolean'}, compare: {type: 'boolean'}, a: {type: 'string'}, b: {type: 'string'}, 'from-floor': {type: 'string'}, seed: {type: 'string'},
 run: {type: 'string'}, json: {type: 'boolean'},
};
export async function main(argv = process.argv.slice(2), {log = console.log, err = console.error, env = process.env} = {}) {
 const {values: o} = parseArgs({args: argv, options: OPTIONS, allowPositionals: false});
 const data = JSON.parse(readFileSync(o.data ? resolve(o.data) : join(ROOT, 'docs/progress/data.json'), 'utf8'));
 const all = loadRuns(data);
 const filters = {version: o.version, group: o.group, mode: o.mode, seeds: o.seeds, since: o.since, until: o.until, excludeIssues: o['exclude-issues']};
 const stretches = parseStretches(o.stretches ?? DEFAULT_STRETCHES);
 const out = (json, text) => log(o.json ? JSON.stringify(json, null, 1) : text);
 const needLogs = o.score || o.compare || o.run || o.since || o.until;
 let logs = new Map(), phases = new Map();
 if (needLogs) {
  const paths = logPaths(env);
  if (!existsSync(paths.logDir)) { err('No run logs folder; set STS2_PRIVATE_DIR.'); return 2; }
  ({runs: logs, phases} = await readFights(paths));
 }
 if (o.run) {
  const found = findRuns(all, o.run);
  if (!found.length) { err(`No run ${o.run} in the progress file.`); return 1; }
  const lines = found.map(r => runLine(r, logs.get(r.run), phases));
  out(lines, lines.map(formatRun).join('\n'));
  return 0;
 }
 const sel = selectRuns(all, filters, logs);
 const tagged = {};
 for (const r of sel) for (const i of r.issues ?? []) tagged[i] = (tagged[i] ?? 0) + 1;
 const unfinished = sel.filter(r => !finished(r)).length;
 const head = `${sel.length} runs (${Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'all'}), ${sel.filter(won).length} won, ${unfinished} unfinished; issue tags included: ${Object.entries(tagged).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`;
 if (!sel.length) { err(head); return 1; }
 if (o.compare) {
  if (!o.a || !o.b) { err('--compare needs --a and --b filters.'); return 1; }
  const c = compareArms(sel, logs, phases, parseFilter(o.a), parseFilter(o.b), {fromFloor: +(o['from-floor'] ?? 1), stretches, seed: +(o.seed ?? 1)});
  out({selection: sel.length, ...c}, `${head}\n${formatCompare(c)}`);
  return 0;
 }
 if (o.score) {
  const rep = scoreReport(sel, logs, phases, stretches);
  out({selection: sel.length, ...rep}, `${head}\n${formatScore(rep)}`);
  return 0;
 }
 if (o.by) {
  if (!['version', 'group'].includes(o.by)) { err('--by takes version or group.'); return 1; }
  const order = [...new Set(all.map(r => r[o.by]))];
  const groups = order.filter(k => sel.some(r => r[o.by] === k)).map(k => { const rs = sel.filter(r => r[o.by] === k); return {key: k ?? '-', n: rs.length, rows: wallTable(rs, stretches)}; });
  out({selection: sel.length, groups}, `${head}\n${formatBy(o.by, groups)}\n\nAll:\n${formatWalls(wallTable(sel, stretches))}`);
  return 0;
 }
 const rows = wallTable(sel, stretches);
 out({selection: sel.length, rows}, `${head}\n${formatWalls(rows)}`);
 return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try { process.exitCode = await main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
