// Shadow-mode engine forecasts. With SIM_FORECAST=shadow, each combat decision on the player's turn
// also asks the headless worker (sim-client.mjs) to play the candidates' lines in the game's own
// engine, and logs the result as a separate sim_forecast record next to the decision. It never
// changes play: the runner does not wait for it, and while one forecast is running the next
// decision is skipped (and counted). If the worker or the bridge endpoint is missing, one sim_status
// record says why and shadow mode stays off for the session.
import {existsSync} from 'node:fs';
import {SimClient, DEFAULT_SIM_EXE, simArgs} from './sim-client.mjs';

export const SIM_SAMPLES = 4;
export const SIM_MAX_LINES = 40;
const combatTypes = new Set(['monster', 'elite', 'boss']);
// The forecast fields, named as in the planner's forecast() so the two compare directly.
export const FORECAST_FIELDS = ['damage', 'block', 'hpLoss', 'hpAfter', 'survives', 'defeatedEnemies', 'energyLeft'];
// A forecast's FORECAST_FIELDS, with the planner's list of defeated enemies as a count.
export const pickForecast = f => f ? Object.fromEntries(FORECAST_FIELDS.map(k => [k, k === 'defeatedEnemies' && Array.isArray(f[k]) ? f[k].length : f[k] ?? null])) : null;

// Lines take 4 samples when the planner's forecast stopped at a draw or a random effect, else 1.
export const SAMPLES_RANDOM = SIM_SAMPLES, SAMPLES_FIXED = 1;
const RANDOM_BOUNDARIES = new Set(['draw', 'random']);
export const samplesFor = candidate => RANDOM_BOUNDARIES.has(candidate?.forecast?.boundary) ? SAMPLES_RANDOM : SAMPLES_FIXED;

// Enemies are matched by combat_id, which is stable. entity_id is the bridge's number among the
// living, so it shifts when an enemy dies; a dead enemy in the worker is <MONSTER>_dead_<n>.
export const enemyKey = e => e?.combat_id ?? e?.entity_id;
// entity_id at the decision -> combat_id, for action targets. A plan's later steps name enemies as
// they were numbered at the decision, but the bridge and the worker renumber after a death; the
// worker's ResolveTarget also accepts the numeric combat id, which does not shift.
export function targetIds(enemies) {
  return new Map((enemies ?? []).filter(e => e?.entity_id != null && e.combat_id != null).map(e => [e.entity_id, String(e.combat_id)]));
}

// A candidate's plan as worker actions. A trailing end_turn is dropped: simulate ends the turn itself.
export function workerActions(plan, targets = null) {
  if (!Array.isArray(plan) || !plan.length) return {reason: 'no plan'};
  const actions = [], target = t => t == null ? null : targets?.get(t) ?? t;
  for (const [i, step] of plan.entries()) {
    const c = step?.command ?? {};
    if (c.action === 'play_card' && Number.isInteger(c.card_index)) actions.push({action: 'play_card', card_index: c.card_index, target: target(c.target)});
    else if (c.action === 'use_potion' && Number.isInteger(c.slot)) actions.push({action: 'use_potion', slot: c.slot, target: target(c.target)});
    else if (c.action === 'end_turn') { if (i !== plan.length - 1) return {reason: 'end_turn before the end of the plan'}; }
    else return {reason: `unsupported action: ${c.action ?? 'none'}`};
  }
  return {actions};
}

// Unique action sequences, at most maxLines. Plans that end the turn come first, then longer plans:
// they are full-turn outcomes, and single steps are often their prefixes. members maps each line id
// (its first candidate in that order) to every candidate with the same sequence; skipped lists
// candidates with no line and why.
const endsTurn = c => Array.isArray(c.plan) && c.plan.at(-1)?.command?.action === 'end_turn' ? 1 : 0;
// Each line has samples: the most any of its candidates needs.
export function buildLines(candidates, {maxLines = SIM_MAX_LINES, targets = null} = {}) {
  const lines = [], members = {}, skipped = [], byKey = new Map();
  const ordered = (candidates ?? []).toSorted((a, b) => endsTurn(b) - endsTurn(a) || (b.plan?.length ?? 0) - (a.plan?.length ?? 0));
  for (const c of ordered) {
    const {actions, reason} = workerActions(c.plan, targets);
    if (!actions) { skipped.push({id: c.id, reason}); continue; }
    const key = JSON.stringify(actions);
    if (byKey.has(key)) { const line = byKey.get(key); members[line.id].push(c.id); line.samples = Math.max(line.samples, samplesFor(c)); continue; }
    if (lines.length >= maxLines) { skipped.push({id: c.id, reason: 'line limit'}); continue; }
    const line = {id: c.id, actions, samples: samplesFor(c)};
    byKey.set(key, line); members[c.id] = [c.id]; lines.push(line);
  }
  return {lines, members, skipped};
}

const alive = e => (e?.hp ?? 0) > 0;
// One sample in the planner's terms. start is the worker's state at the decision.
export function sampleForecast(start, sample) {
  const line = sample.after_line, end = sample.player_dead ? null : (sample.after_enemy_turn ?? line);
  const startEnemies = (start.enemies ?? []).filter(alive);
  const after = e => (line?.enemies ?? []).find(x => enemyKey(x) === enemyKey(e));
  const hpAfter = sample.player_dead ? 0 : end?.player?.hp ?? null;
  const maxHpLost = end?.player?.max_hp != null ? Math.max(0, start.player.max_hp - end.player.max_hp) : 0;
  return {
    damage: startEnemies.reduce((n, e) => n + Math.max(0, e.hp - (after(e)?.hp ?? e.hp)), 0),
    block: line?.player?.block ?? null,
    hpLoss: hpAfter == null ? null : Math.max(0, start.player.hp - hpAfter) + maxHpLost,
    hpAfter,
    survives: !sample.player_dead && (hpAfter ?? 1) > 0,
    defeatedEnemies: startEnemies.filter(e => after(e) && !alive(after(e))).length,
    energyLeft: line?.player?.energy ?? null,
    combatWon: Boolean(sample.combat_won),
  };
}

const round3 = x => Math.round(x * 1000) / 1000;
// Mean of each field over the samples that ran, min and max where they differ, survive_rate, and
// exact:true when two or more samples ran and all agree (one sample shows no spread). survives is
// true or false only when all samples agree. A sample with reason "combat_ended" ran (ok:true): the
// combat ended partway through the line.
export function aggregateForecast(start, samples) {
  const ok = (samples ?? []).filter(s => s.ok), failed = (samples ?? []).filter(s => !s.ok);
  if (!ok.length) return {ok: false, stopped_at: failed[0]?.stopped_at ?? null, reason: failed[0]?.reason ?? 'no samples'};
  const per = ok.map(s => sampleForecast(start, s));
  const out = {}, min = {}, max = {};
  for (const f of FORECAST_FIELDS.filter(f => f !== 'survives')) {
    const values = per.map(p => p[f]);
    if (values.some(v => v == null)) { out[f] = null; continue; }
    const lo = Math.min(...values), hi = Math.max(...values);
    out[f] = round3(values.reduce((a, b) => a + b, 0) / values.length);
    if (lo !== hi) { min[f] = lo; max[f] = hi; }
  }
  const survived = per.filter(p => p.survives).length;
  out.survive_rate = round3(survived / per.length);
  out.survives = survived === per.length ? true : survived === 0 ? false : null;
  out.combat_won_rate = round3(per.filter(p => p.combatWon).length / per.length);
  out.samples = per.length;
  if (Object.keys(min).length) Object.assign(out, {min, max});
  if (failed.length) Object.assign(out, {failed: failed.length, stopped_at: failed[0].stopped_at ?? null, reason: failed[0].reason ?? null});
  const same = per.every(p => JSON.stringify(p) === JSON.stringify(per[0]));
  if (same && !failed.length && per.length > 1) out.exact = true;
  return out;
}

// Results per candidate id, duplicates sharing their line's forecast.
export function candidateResults(start, response, members) {
  const results = {};
  for (const r of response?.results ?? []) {
    const forecast = aggregateForecast(start, r.samples);
    for (const id of members[r.id] ?? [r.id]) results[id] = id === r.id ? forecast : {...forecast, same_as: r.id};
  }
  return results;
}

// Differences between the observed decision state and the worker's loaded state that would make the
// card indexes or entity ids mean something else (a replay written after the next action, say).
// Cards and potions are compared by the bridge's ids: the worker has no localization, so its names
// are lookup keys.
export function stateDifferences(observed, loaded) {
  const diffs = [], p = observed?.player ?? {}, q = loaded?.player ?? {};
  if (observed?.battle?.round != null && loaded?.round != null && observed.battle.round !== loaded.round) diffs.push('round');
  for (const k of ['hp', 'energy', 'block']) if (p[k] != null && q[k] != null && p[k] !== q[k]) diffs.push(`player.${k}`);
  const hand = h => JSON.stringify((h ?? []).map(c => c.id ?? null));
  if (hand(p.hand) !== hand(q.hand)) diffs.push('hand');
  const potions = list => JSON.stringify((list ?? []).filter(x => x?.id).map(x => [x.slot, x.id]).sort((a, b) => a[0] - b[0]));
  if (potions(p.potions) !== potions(q.potions)) diffs.push('potions');
  const enemies = list => JSON.stringify((list ?? []).filter(alive).map(e => [String(enemyKey(e)), e.hp]).sort());
  if (enemies(observed?.battle?.enemies) !== enemies(loaded?.enemies)) diffs.push('enemies');
  return diffs;
}

export function eligible(state, candidates) {
  return combatTypes.has(state?.state_type) && state?.battle?.turn === 'player' && state?.battle?.is_play_phase !== false
    && (candidates ?? []).some(c => Array.isArray(c.plan));
}

// The runner's hook. log is the runner's async log function; decision() returns at once.
export function simShadow({env = process.env, bridge = 'http://127.0.0.1:15526', log, fetchFn = globalThis.fetch, client = null,
  exists = existsSync, random = Math.random, now = () => new Date(), timeouts = {}} = {}) {
  const enabled = env.SIM_FORECAST === 'shadow';
  const stats = {started: 0, logged: 0, busySkips: 0, errors: 0};
  const t = {replay: 5000, ping: 30000, load: 30000, simulate: 60000, ...timeouts};
  let off = !enabled, offReason = enabled ? null : 'SIM_FORECAST is not shadow', busy = false, ready = null, replay409 = 0, sim = client;
  const record = async e => { try { await log?.(e); } catch {} };
  const turnOff = async reason => {
    if (off) return; off = true; offReason = reason;
    await record({kind: 'sim_status', status: 'off', reason});
    try { await sim?.close(); } catch {}
  };

  // Started on the first eligible decision, so a runner without the worker starts as before.
  async function prepare() {
    const exe = env.STS2_SIM_EXE || DEFAULT_SIM_EXE;
    if (!client) {
      if (!exists(exe)) return 'sim worker executable not found (set STS2_SIM_EXE or build integration/sts2-sim)';
      if (!env.STS2_GAME_DIR) return 'STS2_GAME_DIR is not set';
      let args; try { args = simArgs(env.STS2_SIM_ARGS); } catch { return 'STS2_SIM_ARGS is not valid'; }
      sim = new SimClient({exe, args, env});
    }
    try {
      const pong = await sim.request('ping', {}, {timeoutMs: t.ping});
      if (!pong?.ok) return `sim worker ping failed: ${pong?.error ?? 'not ok'}`;
      await record({kind: 'sim_status', status: 'on', version: pong.version ?? null, game: pong.game ?? null});
    } catch (error) { return `sim worker ping failed: ${error.message}`; }
    return null;
  }

  async function run({state, candidates, decisionRef, startedAt}) {
    const started = performance.now();
    ready ??= prepare();
    const why = await ready;
    if (why) { await turnOff(why); return; }
    const head = {kind: 'sim_forecast', run: state.run?.live_id ?? null, act: state.run?.act ?? null, floor: state.run?.floor ?? null,
      round: state.battle?.round ?? null, decision: decisionRef, decision_started: startedAt};
    const {lines, members, skipped} = buildLines(candidates, {targets: targetIds(state.battle?.enemies)});
    const skippedLines = skipped.length ? skipped : [];
    if (!lines.length) { await record({...head, status: 'no_lines', skipped_lines: skippedLines}); return; }
    let response;
    try { response = await fetchFn(`${bridge}/api/v1/combat_replay`, {signal: AbortSignal.timeout(t.replay)}); }
    catch (error) { stats.errors++; await record({...head, status: 'replay_error', error: error.message}); return; }
    if (response.status === 404 || response.status === 405) { await turnOff(`bridge has no combat_replay endpoint (HTTP ${response.status}); install bridge 0.4.0-jev.2 or later`); return; }
    const body = await response.json().catch(() => null);
    if (response.status === 409) {
      // No combat in progress, or replay recording is off. Three in a row means recording is off.
      if (++replay409 >= 3) { await turnOff(`bridge returned 409 three times: ${String(body?.error ?? '').slice(0, 200)}`); return; }
      await record({...head, status: 'replay_unavailable', error: String(body?.error ?? 'HTTP 409').slice(0, 200)}); return;
    }
    if (!response.ok || body?.status !== 'ok' || !body.path) { stats.errors++; await record({...head, status: 'replay_error', error: `HTTP ${response.status}`}); return; }
    replay409 = 0;
    const replayMs = Math.round(performance.now() - started);
    const replayInfo = {round: body.round ?? null, events: body.events ?? null, game_actions: body.game_actions ?? null, bytes: body.bytes ?? null};
    try {
      // The replay's file path is passed to the worker but never logged.
      const loaded = await sim.request('load', {replay: body.path}, {timeoutMs: t.load});
      if (!loaded.ok) { stats.errors++; await record({...head, status: 'load_failed', error: String(loaded.error ?? '').slice(0, 300), replay: replayInfo}); return; }
      const diffs = stateDifferences(state, loaded.state);
      if (diffs.length) { await record({...head, status: 'state_mismatch', differences: diffs, replay: replayInfo, load_ms: loaded.ms ?? null}); return; }
      const seed = Math.floor(random() * 2 ** 31);
      const knownTop = Array.isArray(state.player?.known_draw_top) ? state.player.known_draw_top.length : 0;
      // samples is one number per request, so lines are sent in one request per sample count.
      const simulated = {results: [], ms: 0};
      for (const n of [...new Set(lines.map(l => l.samples))].sort((a, b) => a - b)) {
        const group = lines.filter(l => l.samples === n).map(({id, actions}) => ({id, actions}));
        const r = await sim.request('simulate', {lines: group, end_turn: true, samples: n, seed, known_top: knownTop}, {timeoutMs: t.simulate});
        if (!r.ok) { stats.errors++; await record({...head, status: 'simulate_failed', seed, error: String(r.error ?? '').slice(0, 300)}); return; }
        simulated.results.push(...r.results); simulated.ms += r.ms ?? 0;
      }
      await record({...head, status: 'ok', seed, samples: Object.fromEntries(lines.map(l => [l.id, l.samples])), known_top: knownTop, lines: lines.length,
        ms: Math.round(performance.now() - started), timing: {replay: replayMs, load: loaded.ms ?? null, simulate: simulated.ms},
        busy_skips: stats.busySkips, replay: replayInfo, skipped_lines: skippedLines,
        results: candidateResults(loaded.state, simulated, members)});
      stats.logged++;
    } catch (error) {
      stats.errors++;
      // A worker that cannot be restarted ends shadow mode; a single crash or timeout is logged.
      if (/not restarting|failed to start/.test(error.message)) await turnOff(error.message);
      else await record({...head, status: 'worker_error', error: error.message});
    }
  }

  return {
    get enabled() { return !off; }, get offReason() { return offReason; }, get busy() { return busy; }, stats,
    // Starts a shadow forecast for this decision and returns at once. The promise is for tests.
    decision({state, candidates, decisionRef}) {
      if (off || !eligible(state, candidates)) return null;
      if (busy) { stats.busySkips++; return null; }
      busy = true; stats.started++;
      return run({state, candidates, decisionRef, startedAt: now().toISOString()})
        .catch(async error => { stats.errors++; await record({kind: 'sim_forecast', status: 'error', decision: decisionRef, error: error.message}); })
        .finally(() => { busy = false; });
    },
    async close() { off = true; try { await sim?.close(); } catch {} },
  };
}
