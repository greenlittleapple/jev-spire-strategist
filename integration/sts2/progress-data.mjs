// Progress data: which logged runs belong to which version, their results from the logs, known
// issues, and when a row has enough comparable runs for a win rate. Used by progress-chart.mjs.
import {readFile, readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scoreRuns} from './scorecard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const shortId = id => String(id ?? '').split(':').pop();

// The private directory: STS2_PRIVATE_DIR, else .private/sts2 in this checkout. SPIRE_LOG_DIR still
// overrides the run log directory alone.
export function logPaths(env = process.env) {
 const dir = env.STS2_PRIVATE_DIR ?? resolve(root, '.private/sts2');
 return {logDir: env.SPIRE_LOG_DIR ?? resolve(dir, 'runs'), seriesFile: resolve(dir, 'series.jsonl')};
}

// Decisions, run ends and run_start records from every run log, streamed (the log outgrows the
// largest string readFile can return), and the seeded-run series file.
export async function readLogs({logDir, seriesFile} = logPaths()) {
 const events = [], starts = [];
 for (const f of (await readdir(logDir)).filter(f => f.endsWith('.jsonl')).sort())
  for await (const line of createInterface({input: createReadStream(resolve(logDir, f))})) {
   if (line.includes('"kind":"run_start"')) { starts.push(JSON.parse(line)); continue; }
   if (!line.includes('"kind":"decision"') && !line.includes('"kind":"run_end"')) continue;
   const e = JSON.parse(line); delete e.candidates; delete e.memory; events.push(e);
  }
 const series = (await readFile(seriesFile, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
 return {events, series, starts};
}

// The decision mode a policy runs under, for runs logged before decisions recorded their mode.
// jev_facts_v3 has logged jev-compact-v3, v3.1 and (with the shop majority rule) v3.2.
const POLICY_MODES = {'jev-compact-v1': 'jev', 'jev-compact-v2': 'jev_facts', 'jev-compact-v3': 'jev_facts_v3', 'jev-compact-v3.1': 'jev_facts_v3', 'jev-compact-v3.2': 'jev_facts_v3'};
const policyMode = p => POLICY_MODES[p] ?? (/^claude-strategy-/.test(p ?? '') ? 'claude' : null);

// Scored runs keyed by short run ID, with the fields the progress data needs: the decision mode (run_start,
// else the decisions' own, else the series entry, else the policy's) and the lab commit when one was recorded
// (run_start, else the series entry).
export function scoreLogged({events, series = [], starts = []}) {
 const modes = new Map();
 for (const e of events) {
  const id = shortId(e.state?.run?.live_id);
  if (e.kind === 'decision' && id && e.decisionMode) (modes.get(id) ?? modes.set(id, new Set()).get(id)).add(e.decisionMode);
 }
 const startOf = new Map(starts.map(s => [shortId(s.run), s])), seriesOf = new Map(series.map(s => [shortId(s.run), s]));
 return new Map(scoreRuns(events, series).map(s => {
  const id = shortId(s.run), start = startOf.get(id), entry = seriesOf.get(id);
  const logged = [...(modes.get(id) ?? [])];
  const mode = start?.decision_mode ?? (logged.length ? logged.join('+') : entry?.mode ?? policyMode(s.policy));
  const commit = start?.lab_commit ?? entry?.lab_commit ?? null, dirty = start?.lab_dirty ?? entry?.lab_dirty ?? null;
  return [id, {...s, id, mode, lab_commit: commit, lab_dirty: dirty}];
 }));
}

// The version a logged run belongs to: the one whose name starts its series label ("Strategist v3.16: ..."),
// else the only version with its policy. Returns {version} or {reason}.
export function versionFor(data, s) {
 const named = /^((?:Jev|Strategist) v\d+(?:\.\d+)*)(?::|$)/.exec(s.label ?? '')?.[1];
 if (named) {
  const v = data.versions.find(v => v.name === named);
  return v ? {version: v} : {reason: `its series label names ${named}, which has no version in data.json yet`};
 }
 const byPolicy = data.versions.filter(v => v.policy === s.policy);
 if (byPolicy.length === 1) return {version: byPolicy[0]};
 return {reason: byPolicy.length ? `${byPolicy.length} versions share policy ${s.policy} and its series label names none`
  : `no version has policy ${s.policy ?? '(none)'}`};
}

// A listed run's fields from its scored row. A run whose log has no result stays "in progress" until
// --refresh finds one. The mode is stored only where it differs from the version's; the lab commit only
// when one was recorded. replay and issues are kept.
export function refreshRun(v, r, s) {
 if (!s) throw Error(`Run ${r.run} is not in the logs`);
 Object.assign(r, {seed: s.seed, result: s.result, act: s.act, floor: s.floor, moves: s.moves, tokens: s.input_tokens});
 if (s.mode && s.mode !== v.mode) r.mode = s.mode; else delete r.mode;
 if (s.lab_commit) r.lab_commit = s.lab_commit; else delete r.lab_commit;
 if (s.lab_dirty) r.lab_dirty = true; else delete r.lab_dirty;
 if (r.issues) { const issues = r.issues; delete r.issues; r.issues = issues; }
 return r;
}

// npm run sts2:progress -- --add: every scored run not yet in data, under its version, in start order.
// Runs where the runner made no move are skipped; runs listed in data.excluded ({run, reason}: left out on
// purpose, such as a run abandoned when the code changed), runs with a run modifier or above Ascension 0,
// and runs whose version can't be determined, are reported and left out. Mutates data.
export function addRuns(data, scored) {
 const listed = new Set(data.versions.flatMap(v => v.runs.map(r => r.run)));
 const excluded = new Map((data.excluded ?? []).map(x => [x.run, x.reason]));
 const out = {added: [], skipped: [], excluded: [], unmatched: []};
 for (const s of [...scored.values()].sort((a, b) => String(a.started).localeCompare(String(b.started)))) {
  if (listed.has(s.id)) continue;
  if (excluded.has(s.id)) { out.excluded.push({run: s.id, reason: excluded.get(s.id)}); continue; }
  if (!s.moves) { out.skipped.push(s.id); continue; }
  if (s.modifiers && s.modifiers !== 'standard') { out.unmatched.push({run: s.id, label: s.label, reason: `run modifiers: ${s.modifiers}`}); continue; }
  if (s.ascension != null && s.ascension !== 0) { out.unmatched.push({run: s.id, label: s.label, reason: `Ascension ${s.ascension}`}); continue; }
  const {version, reason} = versionFor(data, s);
  if (!version) { out.unmatched.push({run: s.id, label: s.label, policy: s.policy, reason}); continue; }
  version.runs.push(refreshRun(version, {run: s.id}, s));
  out.added.push({run: s.id, seed: s.seed, version: version.name, result: s.result, floor: s.floor});
 }
 return out;
}

// Every issue ID a run names must be in data.issues.
export function checkIssues(data) {
 const known = new Set((data.issues ?? []).map(i => i.id));
 for (const v of data.versions) for (const r of v.runs) for (const id of r.issues ?? [])
  if (!known.has(id)) throw Error(`Run ${r.run} names unknown issue ${id}; add it to issues.`);
}

// Chart and table rows: one per version, plus "<version> (<mode>)" for a version's runs in another decision
// mode than the version's own. A version whose runs are all in another mode has no empty base row.
export function seriesRows(data) {
 return data.versions.flatMap(v => {
  const modeOf = r => r.mode ?? v.mode;
  const others = [...new Set(v.runs.map(modeOf))].filter(m => m !== v.mode).sort();
  const base = {...v, runs: v.runs.filter(r => modeOf(r) === v.mode)};
  const extra = others.map(mode => ({...v, name: `${v.name} (${mode})`, added: `${v.added}. Played in ${mode} mode`, mode, runs: v.runs.filter(r => modeOf(r) === mode)}));
  return [...(base.runs.length || !extra.length ? [base] : []), ...extra];
 });
}

export const finishedRuns = row => row.runs.filter(r => r.floor != null && r.result !== 'in progress');
const commitsOf = runs => [...new Set(runs.map(r => r.lab_commit).filter(Boolean))];

// A win rate needs WIN_RATE_MIN finished runs of one version in one decision mode, with no two recording
// different lab commits (runs from before commits were recorded count). Returns {won, of, median_floor} or null.
export const WIN_RATE_MIN = 5;
export function winRate(row) {
 const done = finishedRuns(row);
 if (done.length < WIN_RATE_MIN || new Set(done.map(r => r.mode ?? row.mode)).size > 1 || commitsOf(done).length > 1) return null;
 return {won: done.filter(r => r.result === 'won').length, of: done.length, median_floor: median(done.map(r => r.floor))};
}
export const winRateText = w => `${w.won} of ${w.of} won, median floor ${w.median_floor}`;

// Rows whose runs record more than one lab commit, for --refresh to warn about.
export const mixedCommitRows = data => seriesRows(data).map(row => ({name: row.name, commits: commitsOf(row.runs)})).filter(x => x.commits.length > 1);
