import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SimClient} from './sim-client.mjs';
import {SimPool, chunkLines, workerCount} from './sim-pool.mjs';
import {simLive, engineForecast, defeatedFrom, applyForecasts, MAX_FAILURES} from './sim-live.mjs';
import {buildLines, aggregateForecast} from './sim-shadow.mjs';
import {compare, slimRecord, report} from './sim-compare.mjs';
import {selectionState} from '../../vendor/jev-the-spire/spire-demo/selections.mjs';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {efficientQuestion} from './efficient-decisions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, 'fixtures/sim-stub-worker.mjs');
const stubClient = (env = {}) => () => new SimClient({exe: process.execPath, args: [stub], env: {...process.env, ...env}, timeoutMs: 5000});

// The same fight as sim-shadow.test.mjs: 40 HP, 3 energy, one enemy with 10 HP attacking for 8.
const workerState = () => ({round: 2, player: {hp: 40, max_hp: 80, block: 0, energy: 3, status: [],
  hand: ['STRIKE_IRONCLAD', 'DEFEND_IRONCLAD', 'WILD'].map(id => ({id, name: id, upgraded: false, cost: 1})),
  draw_count: 5, discard_count: 0, exhaust_count: 0, potions: [{slot: 0, id: 'BLOCK_POTION', name: 'BLOCK_POTION'}]},
  enemies: [{entity_id: 'E_0', combat_id: 1, name: 'Enemy', hp: 10, max_hp: 30, block: 0, status: [], intents: [{type: 'Attack', damage: 8, hits: 1}]}]});
const bridgeState = () => ({state_type: 'monster', run: {live_id: 'run1', act: 1, floor: 3},
  player: {hp: 40, max_hp: 80, block: 0, energy: 3, known_draw_top: [],
    hand: [['STRIKE_IRONCLAD', 'Strike'], ['DEFEND_IRONCLAD', 'Defend'], ['WILD', 'Wild']].map(([id, name], index) => ({id, name, index})),
    potions: [{slot: 0, id: 'BLOCK_POTION', name: 'Block Potion'}]},
  battle: {round: 2, turn: 'player', is_play_phase: true, enemies: [{entity_id: 'E_0', combat_id: 1, name: 'Enemy', hp: 10}]}});
const step = command => ({label: command.action, command});
const strike = step({action: 'play_card', card_index: 0, target: 'E_0'});
const defend = step({action: 'play_card', card_index: 1});
const wild = step({action: 'play_card', card_index: 2, target: 'E_0'});
const endTurn = step({action: 'end_turn'});
// Planner forecasts, deliberately off, with an Unmodeled warning the engine makes moot.
const planner = (extra = {}) => ({damage: 99, block: 99, hpLoss: 99, hpAfter: 1, survives: true, defeatedEnemies: [], energyLeft: 9, incoming: 8,
  quality: 'partial', boundary: null, notModeled: ['enemy power: Thing'], warnings: ['Unmodeled enemy power: Thing', 'Re-observe after Wild.'], assumption: 'planner', ...extra});
const candidates = () => [
  {id: 'p0', command: strike.command, plan: [strike], forecast: planner()},
  {id: 'p1', command: defend.command, plan: [defend], forecast: planner()},
  {id: 'p2', command: endTurn.command, plan: [endTurn], forecast: planner()},
  {id: 'p3', command: strike.command, plan: [strike, endTurn], forecast: planner()},
  {id: 'p4', command: {action: 'discard_potion', slot: 0}, plan: [step({action: 'discard_potion', slot: 0})], forecast: planner()},
  // The planner stopped this line at a random effect, so it gets 4 samples.
  {id: 'p5', command: wild.command, plan: [wild], forecast: planner({boundary: 'random'})},
];

async function withReplay(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sim-live-'));
  const replay = join(dir, 'replay.json');
  await writeFile(replay, JSON.stringify({state: workerState()}));
  try { return await fn(dir, replay); } finally { await rm(dir, {recursive: true, force: true}); }
}
const replayFetch = (path, status = 200) => async () => ({status, ok: status === 200,
  json: async () => status === 200 ? {status: 'ok', path, bytes: 10, round: 2, events: 5, game_actions: 3} : {error: 'no combat'}});
const liveEnv = (extra = {}) => ({SIM_FORECAST: 'live', SIM_WORKERS: '2', SIM_TIMEOUT_MS: '4000', STS2_SIM_EXE: process.execPath, STS2_SIM_ARGS: JSON.stringify([stub]), STS2_GAME_DIR: 'game', ...extra});

// Wraps a client factory to count the lines each worker simulated.
function counting(make) {
  const lines = [];
  return {lines, make: i => {
    const c = make(i), request = c.request.bind(c);
    lines[i] = [];
    c.request = (cmd, payload, opts) => { if (cmd === 'simulate') lines[i].push(...payload.lines.map(l => l.id)); return request(cmd, payload, opts); };
    return c;
  }};
}

test('worker count and chunks', () => {
  assert.deepEqual([workerCount(undefined), workerCount('2'), workerCount('20'), workerCount('0'), workerCount('x')], [4, 2, 8, 4, 4]);
  const lines = [{id: 'a', samples: 1}, {id: 'b', samples: 4}, {id: 'c', samples: 1}, {id: 'd', samples: 1}, {id: 'e', samples: 1}, {id: 'f', samples: 1}];
  // One sample count per chunk, up to 4 line-samples, ordered by first line.
  assert.deepEqual(chunkLines(lines).map(c => [c.samples, c.lines.map(l => l.id).join('')]), [[1, 'acde'], [4, 'b'], [1, 'f']]);
  assert.deepEqual(chunkLines(lines, 1).map(c => c.lines.map(l => l.id).join('')), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('the pool loads every worker, splits the lines and merges every result', () => withReplay(async (dir, replay) => {
  const count = counting(stubClient());
  const pool = new SimPool({size: 2, makeClient: count.make});
  try {
    assert.equal((await pool.start()).version, 'stub-1');
    const loads = await pool.load(replay);
    assert.equal(loads.ok.length, 2);
    const {lines} = buildLines(candidates());
    const ctx = {};
    await pool.simulate(loads.ok.map(l => l.worker), lines, {seed: 7, cost: 1}, ctx);
    assert.deepEqual([...ctx.results.keys()].sort(), lines.map(l => l.id).sort());
    assert.equal(ctx.failures.size, 0);
    // Both workers took chunks, and no line ran twice.
    assert.ok(count.lines[0].length && count.lines[1].length, JSON.stringify(count.lines));
    assert.equal(count.lines.flat().length, lines.length);
  } finally { await pool.close(); }
}));

test('a worker that crashes mid-decision: its chunk moves to another worker and it is restarted', () => withReplay(async dir => {
  const replay = join(dir, 'replay.json');
  const flag = join(dir, 'crashed');
  const events = [];
  const pool = new SimPool({size: 2, makeClient: stubClient({STUB_CRASH_ONCE: flag}), onEvent: e => events.push(e)});
  try {
    await pool.start();
    const loads = await pool.load(replay);
    const {lines} = buildLines(candidates());
    const ctx = {};
    await pool.simulate(loads.ok.map(l => l.worker), lines, {seed: 7, cost: 1}, ctx);
    assert.equal(await readFile(flag, 'utf8'), 'crashed');
    assert.deepEqual([...ctx.results.keys()].sort(), lines.map(l => l.id).sort());
    assert.equal(pool.crashes, 1);
    assert.equal(events[0].type, 'worker_error');
    // The crashed worker is restarted in the background and loads again for the next decision.
    await Promise.all(pool.workers.map(w => w.restarting));
    assert.equal((await pool.load(replay)).ok.length, 2);
    assert.equal(pool.workers.reduce((n, w) => n + w.client.restarts, 0), 1);
  } finally { await pool.close(); }
}));

test('a worker that cannot be restarted is retired; with none left the pool is dead', async () => {
  const pool = new SimPool({size: 2, makeClient: () => new SimClient({exe: process.execPath, args: [stub], env: {...process.env, STUB_EXIT_AT_START: '1'}, maxRestarts: 0})});
  assert.equal(await pool.start({timeoutMs: 5000}), null);
  assert.equal(pool.dead, true);
  assert.equal(pool.retired.length, 2);
  await pool.close();
});

test('engine forecast mapping: exact values, spread as mean with range, survive rate and kills', () => {
  const start = workerState();
  const sample = (hp, enemyHp, dead = false) => ({ok: true, after_line: {player: {hp: 40, max_hp: 80, block: 0, energy: 2}, enemies: [{...start.enemies[0], hp: enemyHp}]},
    after_enemy_turn: dead ? null : {player: {hp, max_hp: 80, block: 0, energy: 3}, enemies: []}, player_dead: dead, combat_won: enemyHp === 0});
  // One sample: exact.
  const one = [sample(32, 4)];
  const exact = engineForecast(planner(), aggregateForecast(start, one), defeatedFrom(bridgeState(), start, one));
  assert.deepEqual([exact.damage, exact.block, exact.hpLoss, exact.hpAfter, exact.survives, exact.energyLeft, exact.defeatedEnemies, exact.quality, exact.source, exact.samples],
    [6, 0, 8, 32, true, 2, [], 'exact', 'engine', 1]);
  // Planner fields that still apply stay; its Unmodeled caveat and notModeled go.
  assert.deepEqual([exact.incoming, exact.warnings, exact.notModeled, exact.min, exact.survive_rate], [8, ['Re-observe after Wild.'], [], undefined, undefined]);
  // All samples equal: still exact.
  assert.equal(engineForecast(planner(), aggregateForecast(start, [sample(32, 4), sample(32, 4)]), {always: [], rate: {}}).quality, 'exact');
  // Spread: one sample kills the enemy, one dies, two survive at different HP.
  const spread = [sample(32, 0), sample(0, 4, true), sample(30, 4), sample(34, 4)];
  const s = engineForecast(planner({boundary: 'combat_won'}), aggregateForecast(start, spread), defeatedFrom(bridgeState(), start, spread));
  assert.equal(s.quality, 'sampled'); assert.equal(s.samples, 4);
  assert.equal(s.survives, null); assert.equal(s.survive_rate, 0.75);
  assert.equal(s.damage, 7); assert.deepEqual([s.min.damage, s.max.damage], [6, 10]);
  assert.deepEqual([s.min.hpAfter, s.max.hpAfter], [0, 34]);
  assert.deepEqual([s.defeatedEnemies, s.defeated_rate, s.min.defeatedEnemies], [[], {E_0: 0.25}, undefined]);
  // The planner said the line wins; the engine says it does in one sample of four.
  assert.deepEqual([s.boundary, s.combat_won_rate], [null, 0.25]);
  // A kill in every sample is listed in the planner's shape.
  const kill = [sample(40, 0)];
  const k = engineForecast(planner(), aggregateForecast(start, kill), defeatedFrom(bridgeState(), start, kill));
  assert.deepEqual([k.defeatedEnemies, k.boundary], [[{id: 'E_0', name: 'Enemy', combat_id: 1}], 'combat_won']);
  // No spread and no samples agreeing on death: survives false.
  assert.equal(engineForecast(planner(), aggregateForecast(start, [sample(0, 4, true)]), {always: [], rate: {}}).survives, false);
});

test('source marking: covered lines are engine, the rest planner with the reason, in candidate order', () => {
  const cs = candidates(), {lines, members, skipped} = buildLines(cs);
  const ok = id => ({id, samples: [{ok: true, after_line: {player: {hp: 40, max_hp: 80, block: 0, energy: 2}, enemies: [{entity_id: 'E_0', combat_id: 1, hp: 4}]},
    after_enemy_turn: {player: {hp: 32, max_hp: 80}, enemies: []}, player_dead: false}]});
  const results = new Map([['p3', ok('p3')], ['p1', {id: 'p1', samples: [{ok: false, reason: 'choice', stopped_at: 0}]}]]);
  const failures = new Map([['p2', 'worker error: Sim worker exited (3).']]);
  const out = applyForecasts(bridgeState(), cs, {members, skipped, results, failures, loaded: workerState(), timedOut: true});
  assert.deepEqual(Object.keys(out.sources), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(out.sources, {p0: 'engine', p1: 'planner', p2: 'planner', p3: 'engine', p4: 'planner', p5: 'planner'});
  assert.deepEqual(out.fallback, {p1: 'sample stopped: choice', p2: 'worker error: Sim worker exited (3).', p4: 'unsupported action: discard_potion', p5: 'timeout'});
  // A planner fallback keeps the planner forecast unchanged apart from the marking.
  assert.deepEqual(cs[4].forecast, {...planner(), source: 'planner', fallback: 'unsupported action: discard_potion'});
  assert.equal(cs[0].forecast.hpAfter, 32);
});

test('live mode: candidates carry engine forecasts and the record keeps the planner numbers', () => withReplay(async (dir, replay) => {
  const records = [];
  const live = simLive({env: {...process.env, ...liveEnv()}, log: async e => records.push(e), fetchFn: replayFetch(replay), random: () => 0.5});
  try {
    const cs = candidates();
    const summary = await live.decision({state: bridgeState(), candidates: cs, decisionRef: 'h1'});
    assert.deepEqual([summary.status, summary.engine, summary.planner], ['ok', 5, 1]);
    const by = Object.fromEntries(cs.map(c => [c.id, c.forecast]));
    assert.deepEqual([by.p3.damage, by.p3.hpAfter, by.p3.hpLoss, by.p3.survives, by.p3.quality, by.p3.source, by.p3.samples], [6, 32, 8, true, 'exact', 'engine', 1]);
    assert.deepEqual([by.p1.block, by.p1.hpLoss, by.p2.hpAfter, by.p2.energyLeft], [5, 3, 32, 3]);
    assert.equal(by.p5.quality, 'sampled'); assert.ok(by.p5.min.damage < by.p5.max.damage); assert.equal(by.p5.survive_rate, 1);
    assert.deepEqual([by.p4.source, by.p4.fallback, by.p4.damage], ['planner', 'unsupported action: discard_potion', 99]);
    const on = records.find(r => r.kind === 'sim_status');
    assert.deepEqual([on.status, on.workers, on.timeout_ms], ['on', 2, 4000]);
    const f = records.find(r => r.kind === 'sim_forecast');
    assert.deepEqual([f.mode, f.status, f.workers, f.lines], ['live', 'ok', 2, 4]);
    assert.deepEqual(f.sources, {p0: 'engine', p1: 'engine', p2: 'engine', p3: 'engine', p4: 'planner', p5: 'engine'});
    assert.equal(f.planner.p3.damage, 99); assert.equal(f.results.p3.damage, 6);
    assert.ok(!JSON.stringify(records).includes('replay.json'));
    // The next decision in the same fight reuses the warm pool.
    const again = await live.decision({state: bridgeState(), candidates: candidates(), decisionRef: 'h2'});
    assert.equal(again.engine, 5);
    assert.equal(records.filter(r => r.kind === 'sim_status').length, 1);
  } finally { await live.close(); }
}));

test('a timeout falls back to the planner without waiting for the worker; a slow pool gives partial results', () => withReplay(async (dir, replay) => {
  const records = [];
  const live = simLive({env: {...process.env, ...liveEnv({SIM_WORKERS: '1', SIM_TIMEOUT_MS: '300', STUB_DELAY_MS: '2000'})}, log: async e => records.push(e), fetchFn: replayFetch(replay)});
  try {
    const cs = candidates(), started = performance.now();
    const summary = await live.decision({state: bridgeState(), candidates: cs, decisionRef: 'h1'});
    assert.ok(performance.now() - started < 1500, `took ${performance.now() - started} ms`);
    assert.deepEqual([summary.status, summary.engine], ['timeout', 0]);
    assert.ok(cs.every(c => c.forecast.source === 'planner' && c.forecast.damage === 99));
    assert.equal(cs[3].forecast.fallback, 'timeout');
    assert.equal(records.find(r => r.kind === 'sim_forecast').status, 'timeout');
  } finally { await live.close(); }
  // Partial: one worker, one chunk per 400 ms, a 1.5 s budget: some lines finish, the rest time out.
  const live2 = simLive({env: {...process.env, ...liveEnv({SIM_WORKERS: '1', SIM_TIMEOUT_MS: '1500', STUB_DELAY_MS: '400'})}, log: async () => {}, fetchFn: replayFetch(replay), chunkCost: 1});
  try {
    const cs = candidates();
    const summary = await live2.decision({state: bridgeState(), candidates: cs, decisionRef: 'h1'});
    assert.equal(summary.status, 'partial', JSON.stringify(summary));
    assert.ok(cs.some(c => c.forecast.source === 'engine') && cs.some(c => c.forecast.fallback === 'timeout'));
  } finally { await live2.close(); }
}));

test('a decision never throws or stalls when the worker misbehaves, and repeated failures turn live mode off', () => withReplay(async (dir, replay) => {
  const loadOk = {ok: true, ms: 1, state: workerState()};
  const fakes = {
    throws: () => { throw Error('boom'); },
    garbage: cmd => cmd === 'simulate' ? Promise.resolve({ok: true, results: 42}) : Promise.resolve(cmd === 'load' ? loadOk : {ok: true}),
    malformed: cmd => cmd === 'simulate' ? Promise.resolve({ok: true, results: [{id: 'p3', samples: [{ok: true}]}, {id: 'p2', samples: 'x'}]}) : Promise.resolve(cmd === 'load' ? loadOk : {ok: true}),
    notOk: cmd => Promise.resolve(cmd === 'ping' ? {ok: true} : {ok: false, error: 'nope'}),
    hangs: cmd => cmd === 'ping' ? Promise.resolve({ok: true}) : new Promise(() => {}),
  };
  for (const [name, request] of Object.entries(fakes)) {
    const records = [];
    const live = simLive({env: liveEnv({SIM_TIMEOUT_MS: '300'}), log: async e => records.push(e), fetchFn: replayFetch(replay),
      makeClient: () => ({request: (cmd, ...rest) => request(cmd, ...rest), close: async () => {}})});
    try {
      for (let i = 0; i < MAX_FAILURES + 1; i++) {
        const cs = candidates();
        const summary = await live.decision({state: bridgeState(), candidates: cs, decisionRef: `h${i}`});
        assert.ok(summary, name);
        if (name === 'malformed') assert.deepEqual([cs[3].forecast.fallback, cs[2].forecast.fallback], ['malformed sample', 'no samples']);
        // Every candidate has a forecast; anything not engine is the planner's, unchanged.
        for (const c of cs) {
          assert.ok(['engine', 'planner'].includes(c.forecast.source), `${name}: ${JSON.stringify(c.forecast)}`);
          if (c.forecast.source === 'planner') assert.equal(c.forecast.damage, 99, name);
        }
      }
      if (['throws', 'notOk', 'garbage'].includes(name)) {
        assert.equal(live.enabled, false, `${name} should turn live mode off`);
        assert.equal(records.filter(r => r.kind === 'sim_status' && r.status === 'off').length, 1, name);
      }
    } finally { await live.close(); }
  }
  // A bridge that throws on fetch is a failure too.
  const live = simLive({env: liveEnv(), log: async () => {}, fetchFn: async () => { throw Error('ECONNREFUSED'); },
    makeClient: () => ({request: async () => ({ok: true}), close: async () => {}})});
  const cs = candidates();
  assert.equal((await live.decision({state: bridgeState(), candidates: cs})).status, 'replay_error');
  assert.equal(cs[0].forecast.fallback, 'replay error');
  await live.close();
}));

test('live mode is off unless SIM_FORECAST=live; Hextech runes and non-combat states keep the planner', () => withReplay(async (dir, replay) => {
  const cs = candidates();
  const off = simLive({env: {SIM_FORECAST: 'shadow'}, log: async () => {}, fetchFn: () => { throw Error('no fetch'); }});
  assert.equal(await off.decision({state: bridgeState(), candidates: cs}), null);
  assert.deepEqual(cs[0].forecast, planner());
  const records = [];
  const live = simLive({env: {...process.env, ...liveEnv()}, log: async e => records.push(e), fetchFn: replayFetch(replay)});
  try {
    assert.equal(await live.decision({state: {...bridgeState(), state_type: 'map'}, candidates: cs}), null);
    const runes = bridgeState(); runes.player.relics = [{id: 'GROUNDED_RUNE', name: 'Grounded'}];
    const summary = await live.decision({state: runes, candidates: cs});
    assert.deepEqual([summary.status, summary.engine], ['hextech', 0]);
    assert.match(cs[0].forecast.fallback, /Hextech/);
    assert.deepEqual(records, []);
  } finally { await live.close(); }
}));

test("Jev's request carries the engine values and the note only when a forecast is from the engine", () => {
  const state = selectionState(JSON.parse(readFileSync(new URL('./fixtures/elite-multi-hit.json', import.meta.url), 'utf8')));
  const cs = decisionCandidates(state);
  const plain = JSON.stringify(efficientQuestion(state, cs));
  assert.doesNotMatch(plain, /forecast_engine|"source":"engine"/);
  const c = cs.find(x => x.command.action === 'end_turn');
  c.forecast = engineForecast(c.forecast, {damage: 0, block: 13, hpLoss: 4, hpAfter: 61, survives: true, defeatedEnemies: 0, energyLeft: 3, samples: 1, survive_rate: 1, combat_won_rate: 0}, {always: [], rate: {}});
  const request = efficientQuestion(state, cs);
  assert.match(request.state.forecast_engine, /game's own combat code/);
  const details = JSON.parse(request.state.candidate_details[c.id]);
  const f = Object.fromEntries(Object.entries(details.forecast).map(([k, v]) => [k, v?.ref ? request.state.forecast_references[v.ref] : v]));
  assert.deepEqual([f.source, f.quality, f.hpLoss, f.hpAfter, f.block], ['engine', 'exact', 4, 61, 13]);
});

// Compare in live mode: the chosen forecast is the engine's; the planner's numbers are in the record.
const decisionRecord = (time, {round = 2, hp = 40, energy = 3, block = 0, enemyHp = 10, chosen, stateHash = null}) => ({
  time, kind: 'decision', outcome: 'executed', stateHash,
  state: {state_type: 'monster', run: {live_id: 'run1', act: 1, floor: 3}, player: {hp, max_hp: 80, block, energy},
    battle: {round, enemies: [{entity_id: 'E_0', combat_id: 1, hp: enemyHp}]}},
  chosen});

test('compare: live records, planner numbers from the sim record, and the exact-match rate with every mismatch', () => {
  const engineChoice = {id: 'p3', command: strike.command, plan: [strike, endTurn],
    forecast: {damage: 6, block: 0, hpLoss: 8, hpAfter: 32, survives: true, defeatedEnemies: [], energyLeft: 2, source: 'engine', quality: 'exact', samples: 1}};
  const log = [
    {time: '2026-10-01T00:00:00.9Z', kind: 'sim_forecast', mode: 'live', status: 'partial', run: 'run1', decision: 'h1', decision_started: '2026-10-01T00:00:00.5Z',
      planner: {p3: {damage: 6, block: 0, hpLoss: 6, hpAfter: 34, survives: true, defeatedEnemies: 0, energyLeft: 2}},
      results: {p3: {damage: 6, block: 0, hpLoss: 8, hpAfter: 32, survives: true, defeatedEnemies: 0, energyLeft: 2, samples: 1}}},
    decisionRecord('2026-10-01T00:00:01Z', {chosen: engineChoice, stateHash: 'h1'}),
    decisionRecord('2026-10-01T00:00:03Z', {energy: 2, enemyHp: 4, chosen: {id: 'p0', command: {action: 'end_turn'}, plan: [endTurn]}}),
    // The enemy hit for 9, not 8: the engine's HP after is one off.
    decisionRecord('2026-10-01T00:00:04Z', {round: 3, hp: 31, enemyHp: 4, chosen: {id: 'p0', command: {action: 'end_turn'}, plan: [endTurn]}}),
  ];
  const result = compare(log.map(slimRecord).filter(Boolean));
  assert.deepEqual([result.counts.compared, result.counts.engine, result.counts.followed], [1, 1, 1]);
  assert.equal(result.agreement.hpAfter.planner_vs_sim.rate, 0);
  const x = result.exact_match;
  assert.deepEqual([x.lines, x.fields.damage.rate, x.fields.block.rate, x.fields.hpAfter.rate, x.fields.hpAfter.engine], [1, 1, 1, 0, 1]);
  assert.deepEqual(x.mismatches.map(m => [m.field, m.sim, m.actual, m.planner, m.engine]), [['hpAfter', 32, 31, 34, true]]);
  assert.match(report(result), /Exact match[\s\S]*hpAfter\s+0\.0% of 1 \(1 used live\)[\s\S]*Mismatches \(1\)\nrun1 a1 f3 r2 p3 hpAfter: sim 32, actual 31, planner 34 \(live\)/);
});
