// Live engine forecasts. With SIM_FORECAST=live, each combat decision on the player's turn waits (up
// to SIM_TIMEOUT_MS) while a pool of headless workers (sim-pool.mjs) plays every candidate's line in
// the game's own engine; the engine's numbers then replace the planner's in the candidates' forecast,
// which is what Jev's request and the rules read. A candidate the engine could not cover (a skipped
// line, a card choice, a timeout, a worker error, a state mismatch) keeps the planner forecast
// unchanged, marked source 'planner' with the reason. A decision never fails or stalls because of
// the engine: every error falls back to the planner, and repeated worker failures turn live mode off
// for the session with one sim_status record, as in shadow mode.
import {existsSync} from 'node:fs';
import {SimClient, DEFAULT_SIM_EXE, simArgs} from './sim-client.mjs';
import {SimPool, workerCount, CHUNK_COST} from './sim-pool.mjs';
import {buildLines, aggregateForecast, candidateResults, stateDifferences, eligible, targetIds, enemyKey, pickForecast} from './sim-shadow.mjs';
import {runeRules} from './runes.mjs';
import {forecastPreference, SELECTION_KINDS, MAX_PLANS} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';

export const DEFAULT_TIMEOUT_MS = 4000;
// Every line takes at least 2 samples, so randomness the planner did not flag shows as spread; lines
// the planner stopped at a draw or random effect take 4 (sim-shadow.mjs samplesFor).
export const LIVE_MIN_SAMPLES = 2;
// Extra lines beyond the planner's selection (SIM_EXTRA_LINES), forecast by the engine and then pruned.
export const DEFAULT_EXTRA_LINES = 32;
// Consecutive decisions with a worker, load or replay failure before live mode turns off; and
// consecutive decisions that timed out with no engine line at all.
export const MAX_FAILURES = 3, MAX_EMPTY_TIMEOUTS = 5;

// Planner caveats about its own arithmetic. The engine runs the real code, so they no longer apply.
const PLANNER_ONLY = /^Unmodeled |may differ by 1\b/;
export const ENGINE_ASSUMPTION = 'Played in the game\'s own combat engine: this plan, then the end of the turn, the enemy turn and the start of the next turn. Hidden draws and random effects are re-randomized per sample, never read from the real seed.';

const alive = e => (e?.hp ?? 0) > 0;
const round3 = x => Math.round(x * 1000) / 1000;

// Enemies alive at the decision that the line killed, by the observed entity id (the planner's
// shape: {id, name, ...}). always: dead in every sample; rate: share of samples, for the others.
export function defeatedFrom(observed, loaded, samples) {
  const start = (loaded?.enemies ?? []).filter(alive), ok = (samples ?? []).filter(s => s.ok);
  const byKey = new Map((observed?.battle?.enemies ?? []).map(e => [String(enemyKey(e)), e]));
  const always = [], rate = {};
  for (const e of start) {
    const dead = ok.filter(s => { const x = (s.after_line?.enemies ?? []).find(y => String(enemyKey(y)) === String(enemyKey(e))); return x && !alive(x); }).length;
    if (!dead) continue;
    const seen = byKey.get(String(enemyKey(e)));
    const id = seen?.entity_id ?? e.entity_id;
    if (dead === ok.length) always.push({id, name: seen?.name ?? e.name, combat_id: e.combat_id ?? null});
    else rate[id] = round3(dead / ok.length);
  }
  return {always, rate};
}

// The engine's forecast for one candidate, built on its planner forecast: the planner's other fields
// stay where they still apply (boundary, incoming, lastingEffects, warnings), its "Unmodeled ..."
// and rounding caveats and notModeled go. quality exact only when two or more samples ran and all
// agree (aggregateForecast's exact); otherwise sampled. Spread:
// the mean, with min, max, survive_rate and, for enemies killed in some samples only, defeated_rate.
export function engineForecast(planner, agg, defeated) {
  const spread = Boolean(agg.min);
  const f = {...(planner ?? {}),
    damage: agg.damage, block: agg.block, hpLoss: agg.hpLoss, hpAfter: agg.hpAfter, survives: agg.survives,
    defeatedEnemies: (planner?.defeatedEnemies ?? []).filter(d => defeated.always.some(x => x.id === d.id))
      .concat(defeated.always.filter(x => !(planner?.defeatedEnemies ?? []).some(d => d.id === x.id))),
    energyLeft: agg.energyLeft, quality: agg.exact === true ? 'exact' : 'sampled', source: 'engine', samples: agg.samples,
    warnings: (planner?.warnings ?? []).filter(w => !PLANNER_ONLY.test(w)), notModeled: [], assumption: ENGINE_ASSUMPTION};
  delete f.fallback;
  if (spread) {
    const {defeatedEnemies: _a, ...min} = agg.min, {defeatedEnemies: _b, ...max} = agg.max;
    Object.assign(f, {min, max, survive_rate: agg.survive_rate});
    if (Object.keys(defeated.rate).length) f.defeated_rate = defeated.rate;
  }
  // The planner's combat_won boundary is its guess; the engine says whether the line ends the fight.
  if (agg.combat_won_rate === 1) f.boundary = 'combat_won';
  else if (f.boundary === 'combat_won') f.boundary = null;
  if (spread && agg.combat_won_rate > 0 && agg.combat_won_rate < 1) f.combat_won_rate = agg.combat_won_rate;
  return f;
}

// A sample that ran has the player after the line, and after the enemy turn unless the fight ended.
const wellFormed = s => s.after_line?.player != null && Array.isArray(s.after_line.enemies)
  && (s.player_dead || s.combat_won || s.reason === 'combat_ended' || s.after_enemy_turn?.player != null);

export const plannerForecast = (planner, reason) => planner ? {...planner, source: 'planner', fallback: reason} : planner;

// Sets each candidate's forecast from the line results (ctx.results: line id -> worker result) or
// marks it planner with the reason. Returns {sources, fallback} by candidate id, in candidate order.
export function applyForecasts(state, candidates, ctx) {
  const lineOf = new Map();
  for (const [lineId, ids] of Object.entries(ctx.members ?? {})) for (const id of ids) lineOf.set(id, lineId);
  const skipped = new Map((ctx.skipped ?? []).map(s => [s.id, s.reason]));
  const sources = {}, fallback = {};
  for (const c of candidates) {
    if (!c.forecast) continue;
    const lineId = lineOf.get(c.id), res = lineId != null ? ctx.results?.get(lineId) : null;
    let reason = skipped.get(c.id) ?? null;
    if (res && ctx.loaded) {
      const samples = Array.isArray(res.samples) ? res.samples : [], bad = samples.find(s => !s?.ok || !wellFormed(s));
      if (samples.length && !bad) {
        c.forecast = engineForecast(c.forecast, aggregateForecast(ctx.loaded, samples), defeatedFrom(state, ctx.loaded, samples));
        sources[c.id] = 'engine'; continue;
      }
      reason = !bad ? 'no samples' : bad.ok ? 'malformed sample' : `sample stopped: ${bad.reason ?? 'error'}`;
    }
    reason ??= (lineId != null && ctx.failures?.get(lineId)) || ctx.reason || (ctx.timedOut ? 'timeout' : 'not simulated');
    c.forecast = plannerForecast(c.forecast, reason);
    sources[c.id] = 'planner'; fallback[c.id] = reason;
  }
  return {sources, fallback};
}

// Per-candidate aggregates for the record, as in shadow mode; malformed worker output is left out.
function recordResults(loaded, results, members) {
  if (!loaded) return {};
  try { return candidateResults(loaded, {results: [...results.values()].filter(r => Array.isArray(r?.samples) && r.samples.every(x => !x?.ok || wellFormed(x)))}, members); }
  catch { return {}; }
}

// Engine pruning, when the engine covered the decision (status ok). The planner's selection rule,
// applied to engine forecasts: among multi-step lines with the same first action, keep the best by
// each selection score (attack, defense, conserve; forecastPreference); ties go to the earlier line.
// Only lines whose forecasts are both exact are compared: a sampled or planner forecast is never
// pruned and never prunes another. Single actions always stay, as in the planner. An extra line the
// engine did not cover is dropped, since only the planner would have judged it.
// Then the planner's cap: at most max(maxPlans, single actions) lines, filled in the planner's order:
// single actions, then per selection score and first action (in the singles' order) that action's
// best line on the score (the engine's best among exact lines; for an action with no exact line, its
// next kept line in candidate order), then any other kept line in candidate order. Lines past the cap
// are dropped (capped). The kept lines stay in candidate order.
export function enginePrune(candidates, {maxPlans = MAX_PLANS} = {}) {
  const exact = c => c.forecast?.source === 'engine' && c.forecast.quality === 'exact';
  const multi = c => (c.plan?.length ?? 0) > 1;
  const best = new Set(), groups = new Map();
  for (const c of candidates) if (multi(c) && exact(c)) {
    const k = JSON.stringify(c.command);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(c);
  }
  const bestFor = new Map();
  for (const [k, group] of groups) for (const kind of SELECTION_KINDS) {
    const top = group.reduce((a, c) => forecastPreference(c.forecast, c.plan, kind) > forecastPreference(a.forecast, a.plan, kind) ? c : a);
    best.add(top); bestFor.set(kind + '|' + k, top);
  }
  const survivors = [], removed = [], uncovered = [];
  for (const c of candidates) {
    if (c.extra && c.forecast?.source !== 'engine') uncovered.push(c.id);
    else if (multi(c) && exact(c) && !best.has(c)) removed.push(c.id);
    else survivors.push(c);
  }
  // The planner's order, then the cap.
  const singles = survivors.filter(c => !multi(c)), order = [...singles], placed = new Set(singles);
  const roots = [...new Set([...singles, ...survivors].map(c => JSON.stringify(c.command)))];
  for (const kind of SELECTION_KINDS) for (const k of roots) {
    const pick = bestFor.get(kind + '|' + k) ?? survivors.find(c => multi(c) && !placed.has(c) && !exact(c) && JSON.stringify(c.command) === k);
    if (pick && !placed.has(pick)) { order.push(pick); placed.add(pick); }
  }
  for (const c of survivors) if (!placed.has(c)) { order.push(c); placed.add(c); }
  const limit = Math.max(maxPlans, singles.length), within = new Set(order.slice(0, limit));
  const kept = survivors.filter(c => within.has(c)), capped = order.slice(limit).map(c => c.id);
  return {kept, removed, uncovered, capped,
    removed_planner: removed.filter(id => !candidates.find(c => c.id === id).extra),
    kept_extra: kept.filter(c => c.extra).map(c => c.id)};
}

const positiveInt = (text, fallback) => { const n = Number.parseInt(text ?? '', 10); return Number.isInteger(n) && n > 0 ? n : fallback; };

// The runner's hook. decision() resolves within about SIM_TIMEOUT_MS and never rejects.
export function simLive({env = process.env, bridge = 'http://127.0.0.1:15526', log, fetchFn = globalThis.fetch, makeClient = null,
  exists = existsSync, random = Math.random, now = () => new Date(), timeouts = {}, chunkCost = CHUNK_COST} = {}) {
  const enabled = env.SIM_FORECAST === 'live';
  const size = workerCount(env.SIM_WORKERS), timeoutMs = positiveInt(env.SIM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const extraLines = env.SIM_EXTRA_LINES === '0' ? 0 : positiveInt(env.SIM_EXTRA_LINES, DEFAULT_EXTRA_LINES);
  const t = {replay: 3000, ping: 30000, load: 15000, simulate: 15000, ...timeouts};
  const stats = {decisions: 0, engine: 0, planner: 0, timeouts: 0, errors: 0};
  let off = !enabled, offReason = enabled ? null : 'SIM_FORECAST is not live', pool = null, ready = null, replay409 = 0, failStreak = 0, emptyTimeouts = 0;
  const record = async e => { try { await log?.(e); } catch {} };
  const turnOff = async reason => {
    if (off) return; off = true; offReason = reason;
    await record({kind: 'sim_status', mode: 'live', status: 'off', reason});
    try { await pool?.close(); } catch {}
  };

  async function prepare() {
    const exe = env.STS2_SIM_EXE || DEFAULT_SIM_EXE;
    let make = makeClient;
    if (!make) {
      if (!exists(exe)) return 'sim worker executable not found (set STS2_SIM_EXE or build integration/sts2-sim)';
      if (!env.STS2_GAME_DIR) return 'STS2_GAME_DIR is not set';
      let args; try { args = simArgs(env.STS2_SIM_ARGS); } catch { return 'STS2_SIM_ARGS is not valid'; }
      make = () => new SimClient({exe, args, env});
    }
    pool = new SimPool({size, makeClient: make, onEvent: e => { if (e.type === 'retired' && !off) record({kind: 'sim_status', mode: 'live', status: 'worker_retired', worker: e.worker, reason: e.reason}); }});
    const pong = await pool.start({timeoutMs: t.ping});
    if (!pong) return `sim worker ping failed: ${pool.retired[0]?.reason ?? 'no worker'}`;
    await record({kind: 'sim_status', mode: 'live', status: 'on', workers: pool.size, timeout_ms: timeoutMs, version: pong.version ?? null, game: pong.game ?? null});
    return null;
  }

  // Fills ctx as it goes; the caller reads it at the deadline. Decision-wide failures set ctx.reason.
  async function run(ctx, state, candidates) {
    ready ??= prepare();
    const why = await ready;
    if (why) { ctx.status = 'off'; ctx.reason = `sim off: ${why}`; await turnOff(why); return; }
    if (pool.dead) { ctx.status = 'off'; ctx.reason = 'sim off: no worker left'; await turnOff('every sim worker failed and could not be restarted'); return; }
    let response;
    const started = performance.now();
    try { response = await fetchFn(`${bridge}/api/v1/combat_replay`, {signal: AbortSignal.timeout(t.replay)}); }
    catch (error) { Object.assign(ctx, {status: 'replay_error', reason: 'replay error', error: error.message, failure: true}); return; }
    if (response.status === 404 || response.status === 405) {
      Object.assign(ctx, {status: 'off', reason: 'sim off: bridge has no combat_replay endpoint'});
      await turnOff(`bridge has no combat_replay endpoint (HTTP ${response.status}); install bridge 0.4.0-jev.2 or later`); return;
    }
    const body = await response.json().catch(() => null);
    if (response.status === 409) {
      Object.assign(ctx, {status: 'replay_unavailable', reason: 'replay unavailable', error: String(body?.error ?? 'HTTP 409').slice(0, 200)});
      if (++replay409 >= 3) await turnOff(`bridge returned 409 three times: ${ctx.error}`);
      return;
    }
    if (!response.ok || body?.status !== 'ok' || !body.path) { Object.assign(ctx, {status: 'replay_error', reason: 'replay error', error: `HTTP ${response.status}`, failure: true}); return; }
    replay409 = 0;
    ctx.timing.replay = Math.round(performance.now() - started);
    ctx.replay = {round: body.round ?? null, events: body.events ?? null, game_actions: body.game_actions ?? null, bytes: body.bytes ?? null};
    if (ctx.stopped) return;
    // The replay's file path is passed to the workers but never logged.
    const loadStart = performance.now();
    const loads = await pool.load(body.path, {timeoutMs: t.load});
    ctx.timing.load = Math.round(performance.now() - loadStart);
    ctx.timing.load_worker = loads.ok.map(l => l.response.ms ?? null);
    ctx.incremental = loads.ok.filter(l => l.response.incremental).length;
    if (!loads.ok.length) { Object.assign(ctx, {status: 'load_failed', reason: 'load failed', error: String(loads.errors[0] ?? '').slice(0, 300), failure: true}); return; }
    const matching = loads.ok.filter(l => !stateDifferences(state, l.response.state).length);
    if (!matching.length) {
      Object.assign(ctx, {status: 'state_mismatch', reason: 'state mismatch', differences: stateDifferences(state, loads.ok[0].response.state)}); return;
    }
    ctx.loaded = matching[0].response.state;
    ctx.workers = matching.length;
    if (ctx.stopped) return;
    ctx.seed = Math.floor(random() * 2 ** 31);
    ctx.knownTop = Array.isArray(state.player?.known_draw_top) ? state.player.known_draw_top.length : 0;
    const simStart = performance.now();
    await pool.simulate(matching.map(l => l.worker), ctx.lines, {seed: ctx.seed, knownTop: ctx.knownTop, timeoutMs: t.simulate, cost: chunkCost}, ctx);
    ctx.timing.simulate = Math.round(performance.now() - simStart);
    if (ctx.failures.size && [...ctx.failures.values()].some(r => /worker error|no worker/.test(r))) ctx.failure = true;
  }

  async function decide({state, candidates, decisionRef, plannerFields}) {
    stats.decisions++;
    const started = performance.now();
    const head = {kind: 'sim_forecast', mode: 'live', run: state.run?.live_id ?? null, act: state.run?.act ?? null, floor: state.run?.floor ?? null,
      round: state.battle?.round ?? null, decision: decisionRef ?? null, decision_started: now().toISOString()};
    const {lines, members, skipped} = buildLines(candidates, {maxLines: Infinity, targets: targetIds(state.battle?.enemies), minSamples: LIVE_MIN_SAMPLES});
    const ctx = {lines, members, skipped, plannerFields, timing: {}, results: new Map(), failures: new Map()};
    const runes = runeRules(state);
    if (off) Object.assign(ctx, {status: 'off', reason: `sim off: ${offReason}`});
    // The worker loads no mods, so Hextech runes and hexes would be missing from its numbers.
    else if (runes.length) Object.assign(ctx, {status: 'hextech', reason: 'Hextech runes active; the worker does not load mods'});
    else if (!lines.length) Object.assign(ctx, {status: 'no_lines', reason: 'no line'});
    else {
      let timer;
      const work = run(ctx, state, candidates).catch(error => Object.assign(ctx, {status: 'error', reason: 'sim error', error: error.message, failure: true}));
      ctx.timedOut = await Promise.race([work.then(() => false), new Promise(r => { timer = setTimeout(() => r(true), timeoutMs); })]);
      clearTimeout(timer);
      ctx.stopped = true;
    }
    // Results that arrive after this point are ignored.
    const results = new Map(ctx.results);
    const view = {...ctx, results};
    const {sources, fallback} = applyForecasts(state, candidates, view);
    const engine = Object.values(sources).filter(s => s === 'engine').length, planner = Object.values(sources).length - engine;
    stats.engine += engine; stats.planner += planner;
    const status = ctx.status ?? (ctx.timedOut ? (engine ? 'partial' : 'timeout') : 'ok');
    if (ctx.timedOut) stats.timeouts++;
    if (ctx.failure) stats.errors++;
    // The final set: engine-pruned when the engine covered the decision, else exactly the planner's.
    let final = candidates.filter(c => !c.extra), prune = null;
    if (status === 'ok') {
      const p = enginePrune(candidates);
      final = p.kept;
      prune = {removed: p.removed.length, removed_planner: p.removed_planner.length, kept_extra: p.kept_extra.length,
        extra_uncovered: p.uncovered.length, capped: p.capped.length, capped_ids: p.capped, extra_lines: candidates.filter(c => c.extra).length, removed_ids: p.removed, kept_extra_ids: p.kept_extra};
    }
    const ms = Math.round(performance.now() - started);
    const summary = {status, engine, planner, ms, candidates: final, prune: prune && {removed: prune.removed, kept_extra: prune.kept_extra, removed_planner: prune.removed_planner, capped: prune.capped}};
    if (!['off', 'hextech', 'no_lines'].includes(status)) {
      await record({...head, status, ...(ctx.error ? {error: ctx.error} : {}), ...(ctx.differences ? {differences: ctx.differences} : {}),
        seed: ctx.seed ?? null, known_top: ctx.knownTop ?? null, lines: lines.length, workers: ctx.workers ?? null, timeout_ms: timeoutMs,
        samples: Object.fromEntries(lines.map(l => [l.id, l.samples])), ms, timing: ctx.timing, incremental: ctx.incremental ?? null, replay: ctx.replay ?? null,
        skipped_lines: skipped, sources, fallback, prune,
        planner: Object.fromEntries(candidates.filter(c => sources[c.id] === 'engine').map(c => [c.id, ctx.plannerFields?.[c.id] ?? null])),
        results: recordResults(ctx.loaded, results, members)});
    }
    // Turning off: repeated worker or replay failures, or decisions that time out with nothing.
    failStreak = ctx.failure ? failStreak + 1 : 0;
    emptyTimeouts = ctx.timedOut && !engine ? emptyTimeouts + 1 : 0;
    if (!off && failStreak >= MAX_FAILURES) await turnOff(`${MAX_FAILURES} decisions in a row failed: ${ctx.error ?? ctx.reason}`);
    if (!off && emptyTimeouts >= MAX_EMPTY_TIMEOUTS) await turnOff(`${MAX_EMPTY_TIMEOUTS} decisions in a row timed out after ${timeoutMs} ms with no engine forecast`);
    return summary;
  }

  return {
    get enabled() { return !off; }, get offReason() { return offReason; }, get pool() { return pool; }, stats, timeoutMs, size,
    // Extra lines to ask the planner for (planCandidates extra); 0 when live mode is off.
    get extraLines() { return off ? 0 : extraLines; },
    // Sets the candidates' forecasts in place. Resolves with {status, engine, planner, ms, candidates,
    // prune}, candidates being the set to decide on, or null when live mode is not on or the decision
    // is not a combat decision on the player's turn (the caller then drops extra lines itself).
    async decision({state, candidates, decisionRef = null}) {
      if (!enabled || !eligible(state, candidates)) return null;
      // The planner's numbers, kept for the sim_forecast record before they are replaced.
      const plannerFields = Object.fromEntries(candidates.filter(c => c.forecast).map(c => [c.id, pickForecast(c.forecast)]));
      const originals = candidates.map(c => c.forecast);
      try { return await decide({state, candidates, decisionRef, plannerFields}); }
      catch (error) {
        // Never fail the decision: restore the planner forecasts, marked.
        candidates.forEach((c, i) => { c.forecast = plannerForecast(originals[i], 'sim error'); });
        stats.errors++;
        await record({kind: 'sim_forecast', mode: 'live', status: 'error', decision: decisionRef, error: String(error?.message ?? error).slice(0, 300)});
        const final = candidates.filter(c => !c.extra);
        return {status: 'error', engine: 0, planner: final.filter(c => c.forecast).length, ms: null, candidates: final, prune: null};
      }
    },
    async close() { off = true; try { await pool?.close(); } catch {} },
  };
}
