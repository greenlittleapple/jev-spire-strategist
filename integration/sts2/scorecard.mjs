// Per-run scorecard from the private decision logs. Floor reached saturates while
// runs die at the same boss, so this also reports boss progress and resource use.
//   node integration/sts2/scorecard.mjs [--json] [--since ISO-time]
// Logs are read from $STS2_PRIVATE_DIR/runs (default .private/sts2/runs).
import {readFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';

const combat = new Set(['monster','elite','boss']);
// Some death effects replace the boss with a placeholder HP value.
const PLACEHOLDER_HP = 1e8;
// Jev has no temperature or seed and identical calls vary by about 0.03, so an answer whose top two
// probabilities are closer than this could flip on a repeat call.
export const NEAR_TIE = 0.10;
export function nearTie(answer) {
 const p = Object.values(answer?.probabilities ?? {}).filter(Number.isFinite).sort((a,b) => b - a);
 return p.length >= 2 ? p[0] - p[1] < NEAR_TIE : null;
}
const median = a => { if (!a.length) return null; const s = [...a].sort((x,y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };

export function scoreRuns(events, series=[]) {
 const started = new Map(series.map(r => [r.run, r]));
 const runs = new Map();
 // Strategist requests are logged just before the decision that posted them; that decision
 // started latencyMs before its own record, which dates the request and names its run.
 // An answer is adopted when its plan is stamped (plan.createdAt).
 let unplaced = [];
 const requests = new Map(), adopted = [];
 const get = (id, time) => { const r = runs.get(id) ?? {id, first:time, last:time, decisions:[], end:null, requests:0, answers:0, answer_ms:[]}; runs.set(id, r); return r; };
 for (const e of events) {
  if (e.kind === 'strategy_request') { unplaced.push(e); continue; }
  if (e.kind === 'strategy_adopted') { adopted.push(e); continue; }
  const id = e.state?.run?.live_id;
  if (!id) continue;
  if (e.kind === 'decision' && unplaced.length) {
   const start = Date.parse(e.time) - (e.latencyMs ?? 0);
   for (const q of unplaced) { requests.set(q.request_id, {run:id, start}); get(id, e.time).requests++; }
   unplaced = [];
  }
  const r = get(id, e.time);
  r.last = e.time;
  if (e.kind === 'decision') r.decisions.push(e);
  if (e.kind === 'run_end') r.end = e;
 }
 for (const a of adopted) {
  const q = requests.get(a.request_id), r = runs.get(a.plan?.run_id ?? q?.run);
  if (!r) continue;
  r.answers++;
  const ms = Date.parse(a.plan?.createdAt ?? a.time) - (q?.start ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) r.answer_ms.push(ms);
 }
 return [...runs.values()].map(r => ({...score(r), seed: started.get(r.id)?.seed ?? null, series_mode: started.get(r.id)?.mode ?? null, label: started.get(r.id)?.label ?? null}));
}

function score(r) {
 const executed = r.decisions.filter(e => e.outcome === 'executed');
 const states = executed.map(e => e.state);
 const last = r.end?.state ?? states.at(-1);
 const modifiers = states.map(s => s.saved_run?.modifiers).find(m => m?.length) ?? [];
 const requests = r.decisions.flatMap(e => e.deliberation?.request_usage ?? []);
 // Older policies logged only per-decision usage.
 const tokens = r.decisions.reduce((n,e) => n + (e.usage?.input_tokens ?? 0), 0);
 const bosses = [];
 for (const e of executed.filter(e => e.state.state_type === 'boss')) {
  const key = `${e.state.run.act}:${e.state.run.floor}`;
  let b = bosses.find(x => x.key === key);
  if (!b) {
   const main = [...e.state.battle.enemies].sort((a,b) => b.max_hp - a.max_hp)[0];
   b = {key, act:e.state.run.act, floor:e.state.run.floor, name:main.name, max_hp:main.max_hp,
    entry_hp:`${e.state.player.hp}/${e.state.player.max_hp}`, gold_at_entry:e.state.player.gold ?? null, potions_at_entry:e.state.player.potions?.length ?? 0, min_hp:main.hp, killed:false, rounds:0};
   bosses.push(b);
  }
  b.rounds = Math.max(b.rounds, e.state.battle.round);
  for (const x of e.state.battle.enemies.filter(x => x.name === b.name)) {
   if (x.hp >= PLACEHOLDER_HP || x.hp <= 0) b.killed = true; else b.min_hp = Math.min(b.min_hp, x.hp);
  }
 }

 // The killing blow is usually not observed; reaching a later floor proves it.
 // A later floor or act, or a reward screen on the boss floor, proves it (the next act's first
 // screens can still report the boss floor).
 for (const b of bosses) if ((last?.run?.floor ?? 0) > b.floor || (last?.run?.act ?? 0) > b.act
  || states.some(s => s.run?.floor === b.floor && s.run?.act === b.act && ['rewards','card_reward'].includes(s.state_type))) b.killed = true;
 for (const b of bosses) { b.hp_removed_pct = b.killed ? 100 : Math.round(100 * (1 - b.min_hp / b.max_hp)); delete b.key; delete b.min_hp; }
 const potions = executed.filter(e => e.chosen?.command?.action === 'use_potion')
  .map(e => `${e.state.state_type}@f${e.state.run.floor}`);
 const elites = new Set(executed.filter(e => e.state.state_type === 'elite').map(e => e.state.run.floor));
 const eliteOffers = executed.filter(e => e.state.state_type === 'map' && e.state.map?.next_options?.some(o => o.type === 'Elite') && e.state.map.next_options.length > 1);
 // Enforced rules: decisions where each removed options, and where it left a single option
 // (the move was then taken without asking Jev). Jev was only asked about the options left,
 // so whether Jev would have picked a removed option is not known.
 const rules = {};
 for (const e of executed) {
  const c = e.strategyConstraint; if (!c) continue;
  const forced = e.decisionSource === "claude" && combat.has(e.state.state_type);
  for (const k of (c.rules ?? [c]).filter(x => (x.removed ?? 1) > 0).map(x => x.kind)) {
   const n = rules[k] ??= {fired: 0, forced: 0}; n.fired++; if (forced) n.forced++;
  }
 }
 const policies = [...new Set(r.decisions.map(e => e.policy).filter(Boolean))];
 // Near ties among decisions Jev answered (not forced, single-option, strategist or replayed moves).
 const asked = executed.filter(e => ['jev', undefined, null].includes(e.decisionSource) && nearTie(e.answer) != null);
 const ties = list => ({decisions: list.length, near_ties: list.filter(e => nearTie(e.answer)).length});
 const tie = {all: ties(asked), combat: ties(asked.filter(e => combat.has(e.state.state_type))), other: ties(asked.filter(e => !combat.has(e.state.state_type)))};
 return {
  run: r.id, started: r.first, policy: policies.join('+') || null,
  modifiers: modifiers.map(m => m.id.replace(/^MODIFIER\./,'')).join(',') || 'standard',
  character: states[0]?.player?.character ?? null, ascension: last?.run?.ascension ?? null,
  // The Architect event follows the final boss, and the game then ends the run at 0 HP.
  result: !r.end ? 'in progress' : (r.end.state?.player?.hp ?? 0) > 0
   || states.some(s => s.state_type === 'event' && s.event?.event_id === 'THE_ARCHITECT') ? 'won' : 'lost',
  act: last?.run?.act, floor: last?.run?.floor, bosses,
  elites_fought: elites.size, elite_choices_taken: eliteOffers.filter(e => /Elite/.test(e.chosen.label)).length, elite_choices_offered: eliteOffers.length,
  relics_end: last?.player?.relics?.length ?? null, gold_end: last?.player?.gold ?? null,
  potions_used: potions, potions_used_outside_elites_bosses: potions.filter(p => p.startsWith('monster')).length,
  moves: executed.length, jev_requests: requests.length, input_tokens: tokens,
  rules,
  claude_consults: r.decisions.filter(e => e.decisionSource === 'claude').length,
  near_ties: Object.fromEntries(Object.entries(tie).map(([k,v]) => [k, {...v, share: v.decisions ? Math.round(100 * v.near_ties / v.decisions) / 100 : null}])),
  strategist: r.requests || r.answers ? {requests: r.requests, answers: r.answers, median_answer_s: r.answer_ms.length ? Math.round(median(r.answer_ms) / 100) / 10 : null} : null,
 };
}

const pct = x => x == null ? '-' : Math.round(100 * x) + '%';
function table(rows) {
 const line = s => {
  const boss = s.bosses.map(b => `${b.name} ${b.killed ? 'killed' : b.hp_removed_pct + '%'} (entry ${b.entry_hp}, ${b.potions_at_entry} pot, ${b.gold_at_entry}g, ${b.rounds}r)`).join('; ') || '-';
  return [s.run.split(':').pop(), s.modifiers + (s.seed ? ` seed ${s.seed}` : ''), s.policy, s.result, `A${s.ascension} act ${s.act} f${s.floor}`, boss,
   `elites ${s.elites_fought} (chose ${s.elite_choices_taken}/${s.elite_choices_offered})`, `relics ${s.relics_end}`, `gold ${s.gold_end}`,
   `potions ${s.potions_used.length} (${s.potions_used_outside_elites_bosses} hallway)`, `${s.moves} moves`, `rules ${Object.entries(s.rules).map(([k,v]) => `${k} ${v.fired}${v.forced ? `/${v.forced} forced` : ""}`).join(", ") || "-"}`, `${(s.input_tokens/1e6).toFixed(2)}M tok`,
   `near ties ${pct(s.near_ties.all.share)} (combat ${pct(s.near_ties.combat.share)}, other ${pct(s.near_ties.other.share)}) of ${s.near_ties.all.decisions}`,
   s.strategist ? `strategist ${s.strategist.requests} req, ${s.strategist.answers} ans, median ${s.strategist.median_answer_s ?? '-'}s` : 'no strategist'].join(' | ');
 };
 return rows.map(line).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
 const dir = process.env.STS2_PRIVATE_DIR ? resolve(process.env.STS2_PRIVATE_DIR, 'runs') : process.env.SPIRE_LOG_DIR ?? resolve(root, '.private/sts2/runs');
 const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : null;
 const events = [];
 for (const f of (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort())
  // Streamed: the log passes the ~512 MB string limit. Decisions, run ends and strategist records are scored.
  for await (const line of createInterface({input: createReadStream(resolve(dir, f))})) {
   const kind = line.match(/"kind":"(\w+)"/)?.[1];
   if (!['decision', 'run_end', 'strategy_request', 'strategy_adopted'].includes(kind)) continue;
   const e = JSON.parse(line); delete e.candidates; delete e.memory;
   if (kind === 'strategy_adopted') e.plan = {run_id: e.plan?.run_id, createdAt: e.plan?.createdAt};
   events.push(e);
  }
 const seriesFile = resolve(dir, '../series.jsonl');
 const series = (await readFile(seriesFile, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
 const rows = scoreRuns(events, series).filter(s => (!since || s.started >= since) && (s.moves >= 5 || process.argv.includes('--all')));
 console.log(process.argv.includes('--json') ? JSON.stringify(rows, null, 1) : table(rows));
}
