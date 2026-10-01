import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, mkdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {SimClient, simArgs, workerEnv} from './sim-client.mjs';
import {simShadow, workerActions, buildLines, aggregateForecast, candidateResults, stateDifferences} from './sim-shadow.mjs';
import {compare, slimRecord, readRecords, report} from './sim-compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, 'fixtures/sim-stub-worker.mjs');
const client = (env = {}, opts = {}) => new SimClient({exe: process.execPath, args: [stub], env: {...process.env, ...env}, timeoutMs: 5000, ...opts});

// The worker's view of a fight: 40 HP, 3 energy, one enemy with 10 HP attacking for 8.
const workerState = (extra = {}) => ({round: 2, player: {hp: 40, max_hp: 80, block: 0, energy: 3, status: [],
  hand: [{id: 'STRIKE', name: 'Strike', upgraded: false, cost: 1}, {id: 'DEFEND', name: 'Defend', upgraded: false, cost: 1}, {id: 'WILD', name: 'Wild', upgraded: false, cost: 1}],
  draw_count: 5, discard_count: 0, exhaust_count: 0, potions: [{slot: 0, id: 'BLOCK_POTION', name: 'Block Potion'}]},
  enemies: [{entity_id: 'E_0', name: 'Enemy', hp: 10, max_hp: 30, block: 0, status: [], intents: [{type: 'Attack', damage: 8, hits: 1}]}], ...extra});
// The bridge's view of the same moment.
const bridgeState = () => ({state_type: 'monster', run: {live_id: 'run1', act: 1, floor: 3},
  player: {hp: 40, max_hp: 80, block: 0, energy: 3, known_draw_top: [{name: 'Strike'}],
    hand: ['Strike', 'Defend', 'Wild'].map((name, index) => ({name, index}))},
  battle: {round: 2, turn: 'player', is_play_phase: true, enemies: [{entity_id: 'E_0', name: 'Enemy', hp: 10}]}});
const step = command => ({label: command.action, command});
const strike = step({action: 'play_card', card_index: 0, target: 'E_0'});
const defend = step({action: 'play_card', card_index: 1});
const endTurn = step({action: 'end_turn'});
const candidates = [
  {id: 'p0', plan: [strike]},
  {id: 'p1', plan: [defend]},
  {id: 'p2', plan: [endTurn]},
  {id: 'p3', plan: [strike, endTurn]},
  {id: 'p4', plan: [step({action: 'discard_potion', slot: 0})]},
  {id: 'p5', plan: [step({action: 'play_card', card_index: 2, target: 'E_0'})]},
];

test('the client speaks JSON lines, matches ids and reports worker errors', async () => {
  const c = client();
  try {
    const pong = await c.request('ping');
    assert.deepEqual([pong.ok, pong.version], [true, 'stub-1']);
    assert.match(pong.id, /^r\d+$/);
    const [a, b] = await Promise.all([c.request('ping'), c.request('nope')]);
    assert.equal(a.ok, true); assert.equal(b.ok, false); assert.match(b.error, /unknown cmd/);
  } finally { await c.close(); }
});

test('a timed-out request rejects, and the next request restarts the worker', async () => {
  const c = client();
  try {
    await assert.rejects(c.request('hang', {}, {timeoutMs: 200}), /timed out after 200 ms on hang/);
    assert.equal((await c.request('ping')).ok, true);
    assert.equal(c.restarts, 1);
  } finally { await c.close(); }
});

test('a crash rejects the pending request; restarts stop at the limit', async () => {
  const c = client({}, {maxRestarts: 1});
  try {
    await assert.rejects(c.request('crash'), /exited \(3\)/);
    assert.equal((await c.request('ping')).ok, true);
    await assert.rejects(c.request('crash'), /exited/);
    await assert.rejects(c.request('ping'), /not restarting/);
  } finally { await c.close(); }
});

test('a missing executable rejects instead of throwing', async () => {
  const c = new SimClient({exe: join(here, 'fixtures/no-such-worker.exe'), args: [], timeoutMs: 2000, maxRestarts: 0});
  try { await assert.rejects(c.request('ping'), /failed to start|exited/); } finally { await c.close(); }
});

test('worker arguments and environment', () => {
  assert.deepEqual(simArgs(undefined), ['serve']);
  assert.deepEqual(simArgs('serve --quiet'), ['serve', '--quiet']);
  assert.deepEqual(simArgs('["a b", "c"]'), ['a b', 'c']);
  const env = workerEnv({STS2_GAME_DIR: 'g', PATH: 'p', TYPESAFE_API_KEY: 'x', GAME_BRIDGE_TOKEN: 'y'});
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'STS2_GAME_DIR']);
});

test('plans become worker actions; duplicates share a line and others are skipped with a reason', () => {
  assert.deepEqual(workerActions([strike, endTurn]).actions, [{action: 'play_card', card_index: 0, target: 'E_0'}]);
  assert.deepEqual(workerActions([defend]).actions, [{action: 'play_card', card_index: 1, target: null}]);
  assert.deepEqual(workerActions([step({action: 'use_potion', slot: 1})]).actions, [{action: 'use_potion', slot: 1, target: null}]);
  assert.deepEqual(workerActions([endTurn]).actions, []);
  assert.match(workerActions([endTurn, strike]).reason, /end_turn before/);
  assert.match(workerActions(undefined).reason, /no plan/);
  const {lines, members, skipped} = buildLines(candidates);
  assert.deepEqual(lines.map(l => l.id), ['p0', 'p1', 'p2', 'p5']);
  assert.deepEqual(members.p0, ['p0', 'p3']);
  assert.deepEqual(skipped, [{id: 'p4', reason: 'unsupported action: discard_potion'}]);
  const many = Array.from({length: 45}, (_, i) => ({id: `q${i}`, plan: [step({action: 'play_card', card_index: i})]}));
  const capped = buildLines(many);
  assert.equal(capped.lines.length, 40);
  assert.deepEqual(capped.skipped.map(s => s.reason), Array(5).fill('line limit'));
});

test('samples map to the planner forecast fields with mean, range, survive rate and exact', () => {
  const start = workerState();
  const sample = (enemyHp, playerHp, extra = {}) => ({ok: true, after_line: {...start, player: {...start.player, block: 5, energy: 1}, enemies: [{...start.enemies[0], hp: enemyHp}]},
    after_enemy_turn: {...start, player: {...start.player, hp: playerHp}}, player_dead: playerHp <= 0, combat_won: false, ...extra});
  const exact = aggregateForecast(start, [sample(4, 37), sample(4, 37)]);
  assert.deepEqual(exact, {damage: 6, block: 5, hpLoss: 3, hpAfter: 37, defeatedEnemies: 0, energyLeft: 1, survive_rate: 1, survives: true, combat_won_rate: 0, samples: 2, exact: true});
  const spread = aggregateForecast(start, [sample(4, 37), sample(5, 0), {ok: false, stopped_at: 1, reason: 'choice'}]);
  assert.equal(spread.damage, 5.5); assert.deepEqual([spread.min.damage, spread.max.damage], [5, 6]);
  assert.equal(spread.survive_rate, 0.5); assert.equal(spread.survives, null); assert.equal(spread.hpLoss, 21.5);
  assert.deepEqual([spread.failed, spread.reason, spread.exact], [1, 'choice', undefined]);
  const won = aggregateForecast(start, [{ok: true, after_line: {...start, enemies: [{...start.enemies[0], hp: 0}]}, after_enemy_turn: null, player_dead: false, combat_won: true}]);
  assert.deepEqual([won.defeatedEnemies, won.hpAfter, won.hpLoss, won.survives, won.combat_won_rate], [1, 40, 0, true, 1]);
  assert.deepEqual(aggregateForecast(start, [{ok: false, stopped_at: 0, reason: 'illegal'}]), {ok: false, stopped_at: 0, reason: 'illegal'});
  const results = candidateResults(start, {results: [{id: 'p0', samples: [sample(4, 37)]}]}, {p0: ['p0', 'p3']});
  assert.equal(results.p3.same_as, 'p0'); assert.equal(results.p0.same_as, undefined);
});

test('the loaded state must match the observed decision state', () => {
  assert.deepEqual(stateDifferences(bridgeState(), workerState()), []);
  const moved = workerState(); moved.player.hand.shift(); moved.player.energy = 2;
  assert.deepEqual(stateDifferences(bridgeState(), moved), ['player.energy', 'hand']);
  const upgraded = bridgeState(); upgraded.player.hand[0].name = 'Strike+';
  assert.deepEqual(stateDifferences(upgraded, workerState()), []);
});

async function withReplay(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sim-shadow-'));
  const replay = join(dir, 'replay.json');
  await writeFile(replay, JSON.stringify({state: workerState()}));
  try { return await fn(dir, replay); } finally { await rm(dir, {recursive: true, force: true}); }
}
const replayFetch = (path, status = 200) => async () => ({status, ok: status === 200,
  json: async () => status === 200 ? {status: 'ok', path, bytes: 10, round: 2, events: 5, game_actions: 3, seed: 'S', floor: 3} : {error: 'no combat'}});
const shadowEnv = {SIM_FORECAST: 'shadow', STS2_SIM_EXE: process.execPath, STS2_SIM_ARGS: JSON.stringify([stub]), STS2_GAME_DIR: 'game'};

test('shadow mode is off unless SIM_FORECAST=shadow', () => {
  const records = [];
  const s = simShadow({env: {}, log: async e => records.push(e), fetchFn: () => { throw Error('no fetch'); }});
  assert.equal(s.enabled, false);
  assert.equal(s.decision({state: bridgeState(), candidates}), null);
  assert.deepEqual(records, []);
});

test('a shadow forecast is logged per decision without the replay path, with a logged seed', () => withReplay(async (dir, replay) => {
  const records = [];
  const s = simShadow({env: {...process.env, ...shadowEnv}, log: async e => records.push(e), fetchFn: replayFetch(replay), random: () => 0.5});
  try {
    const running = s.decision({state: bridgeState(), candidates, decisionRef: 'hash1'});
    assert.ok(running);
    // A decision while the first is running is skipped and counted.
    assert.equal(s.decision({state: bridgeState(), candidates, decisionRef: 'hash2'}), null);
    assert.equal(s.stats.busySkips, 1);
    await running;
    const on = records.find(r => r.kind === 'sim_status');
    assert.deepEqual([on.status, on.version], ['on', 'stub-1']);
    const f = records.find(r => r.kind === 'sim_forecast');
    assert.equal(f.status, 'ok', JSON.stringify(f));
    assert.deepEqual([f.run, f.act, f.floor, f.round, f.decision, f.seed, f.samples, f.known_top, f.lines], ['run1', 1, 3, 2, 'hash1', 2 ** 30, 4, 1, 4]);
    assert.ok(!JSON.stringify(records).includes(replay) && !JSON.stringify(records).includes('replay.json'));
    assert.deepEqual(f.skipped_lines, [{id: 'p4', reason: 'unsupported action: discard_potion'}]);
    assert.deepEqual([f.results.p0.damage, f.results.p0.hpAfter, f.results.p0.exact], [6, 32, true]);
    assert.equal(f.results.p3.same_as, 'p0');
    assert.deepEqual([f.results.p1.block, f.results.p1.hpLoss], [5, 3]);
    assert.deepEqual([f.results.p2.hpAfter, f.results.p2.energyLeft], [32, 3]);
    // Wild deals 4 to 6 depending on the sample: a distribution, not exact.
    assert.equal(f.results.p5.exact, undefined); assert.ok(f.results.p5.min.damage < f.results.p5.max.damage);
    assert.equal(f.busy_skips, 1);
  } finally { await s.close(); }
}));

test('an older bridge without the endpoint turns shadow mode off with one record', () => withReplay(async (dir, replay) => {
  for (const status of [404, 405]) {
    const records = [];
    const s = simShadow({env: {...process.env, ...shadowEnv}, log: async e => records.push(e), fetchFn: replayFetch(replay, status)});
    await s.decision({state: bridgeState(), candidates, decisionRef: 'h'});
    const off = records.filter(r => r.status === 'off');
    assert.equal(off.length, 1); assert.match(off[0].reason, new RegExp(`HTTP ${status}`));
    assert.equal(s.enabled, false);
    assert.equal(s.decision({state: bridgeState(), candidates, decisionRef: 'h2'}), null);
    await s.close();
  }
}));

test('a missing executable, a missing game folder or a failed ping turns shadow mode off', async () => {
  const cases = [
    [{...shadowEnv, STS2_SIM_EXE: join(here, 'fixtures/no-such-worker.exe')}, /executable not found/],
    [{...shadowEnv, STS2_GAME_DIR: ''}, /STS2_GAME_DIR/],
    [{...shadowEnv, STUB_PING_FAIL: '1'}, /ping failed: stub ping failure/],
    [{...shadowEnv, STUB_EXIT_AT_START: '1'}, /ping failed: Sim worker exited/],
  ];
  for (const [env, why] of cases) {
    const records = [];
    const s = simShadow({env: {...process.env, ...env}, log: async e => records.push(e), fetchFn: () => { throw Error('not reached'); }});
    await s.decision({state: bridgeState(), candidates, decisionRef: 'h'});
    assert.deepEqual(records.map(r => [r.kind, r.status]), [['sim_status', 'off']]);
    assert.match(records[0].reason, why);
    await s.close();
  }
});

test('a 409 is logged per decision and three in a row turn shadow mode off', () => withReplay(async (dir, replay) => {
  const records = [];
  const s = simShadow({env: {...process.env, ...shadowEnv}, log: async e => records.push(e), fetchFn: replayFetch(replay, 409)});
  try {
    for (let i = 0; i < 3; i++) await s.decision({state: bridgeState(), candidates, decisionRef: `h${i}`});
    assert.deepEqual(records.filter(r => r.kind === 'sim_forecast').map(r => r.status), ['replay_unavailable', 'replay_unavailable']);
    assert.equal(records.at(-1).status, 'off'); assert.equal(s.enabled, false);
  } finally { await s.close(); }
}));

test('a state mismatch skips the simulation; non-combat and enemy-turn states are ignored', () => withReplay(async (dir, replay) => {
  const records = [];
  const s = simShadow({env: {...process.env, ...shadowEnv}, log: async e => records.push(e), fetchFn: replayFetch(replay)});
  try {
    const later = bridgeState(); later.player.energy = 2;
    await s.decision({state: later, candidates, decisionRef: 'h'});
    const f = records.find(r => r.kind === 'sim_forecast');
    assert.deepEqual([f.status, f.differences], ['state_mismatch', ['player.energy']]);
    assert.equal(s.decision({state: {...bridgeState(), state_type: 'map'}, candidates}), null);
    assert.equal(s.decision({state: {...bridgeState(), battle: {...bridgeState().battle, turn: 'enemy'}}, candidates}), null);
  } finally { await s.close(); }
}));

// Compare: one fight, round 2 then round 3.
const decisionRecord = (time, {round = 2, hp = 40, energy = 3, block = 0, enemyHp = 10, chosen, outcome = 'executed', stateHash = null, type = 'monster'}) => ({
  time, kind: 'decision', outcome, stateHash,
  state: {state_type: type, run: {live_id: 'run1', act: 1, floor: 3}, player: {hp, max_hp: 80, block, energy},
    battle: type === 'map' ? undefined : {round, enemies: [{entity_id: 'E_0', hp: enemyHp}]}},
  chosen});
const plannerChoice = {id: 'p3', command: strike.command, plan: [strike, endTurn],
  forecast: {damage: 6, block: 0, hpLoss: 8, hpAfter: 32, survives: true, defeatedEnemies: [], energyLeft: 2}};

function compareLog() {
  return [
    decisionRecord('2026-10-01T00:00:01Z', {chosen: plannerChoice, stateHash: 'h1'}),
    {time: '2026-10-01T00:00:02Z', kind: 'sim_forecast', status: 'ok', run: 'run1', decision: 'h1', decision_started: '2026-10-01T00:00:00.5Z',
      results: {p3: {damage: 6, block: 0, hpLoss: 6, hpAfter: 34, survives: true, defeatedEnemies: 0, energyLeft: 2, exact: true}}},
    decisionRecord('2026-10-01T00:00:03Z', {energy: 2, enemyHp: 4, chosen: {id: 'p0', command: {action: 'end_turn'}, plan: [endTurn]}}),
    decisionRecord('2026-10-01T00:00:04Z', {round: 3, hp: 34, enemyHp: 4, chosen: {id: 'p0', command: {action: 'end_turn'}, plan: [endTurn]}}),
  ];
}

test('compare joins sim forecasts to decisions and measures the next turn', () => {
  const records = compareLog().map(slimRecord);
  const result = compare(records);
  assert.deepEqual(result.counts, {decisions: 3, with_sim: 1, chosen_not_simulated: 0, followed: 1, compared: 1, exact: 1});
  const a = result.agreement;
  assert.deepEqual([a.hpAfter.planner_vs_actual.rate, a.hpAfter.sim_vs_actual.rate, a.hpAfter.planner_vs_sim.rate], [0, 1, 0]);
  assert.deepEqual([a.damage.planner_vs_actual.rate, a.damage.sim_vs_actual.rate], [1, 1]);
  assert.equal(a.defeatedEnemies.planner_vs_sim.rate, 1);
  assert.deepEqual(result.disagreements.map(d => [d.field, d.planner, d.sim, d.actual, d.round, d.floor]), [['hpLoss', 8, 6, 6, 2, 3], ['hpAfter', 32, 34, 34, 2, 3]]);
  assert.match(report(result), /hpAfter\s+0\.0% of 1\s+100\.0% of 1/);
});

test('compare: a line not followed measures HP only; a death counts as 0 HP; a sim for a later decision does not join', () => {
  const log = compareLog();
  log[2] = decisionRecord('2026-10-01T00:00:03Z', {energy: 2, enemyHp: 4, chosen: {id: 'p1', command: defend.command, plan: [defend]}});
  log.splice(3, 1, {time: '2026-10-01T00:00:05Z', kind: 'run_end', state: {run: {live_id: 'run1'}, player: {hp: 0}}});
  const result = compare(log.map(slimRecord));
  assert.equal(result.counts.followed, 0);
  assert.deepEqual([result.agreement.damage.sim_vs_actual.n, result.agreement.survives.sim_vs_actual.agree], [0, 0]);
  assert.equal(result.agreement.hpAfter.planner_vs_actual.n, 1);
  const late = compareLog(); late[1].decision_started = '2026-10-01T00:00:09Z';
  assert.equal(compare(late.map(slimRecord)).counts.with_sim, 0);
});

test('readRecords streams CRLF logs and applies --since before parsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-compare-'));
  try {
    const lines = compareLog().map(r => JSON.stringify(r));
    await writeFile(join(dir, 'a.jsonl'), [JSON.stringify({time: '2026-09-01T00:00:00Z', kind: 'decision', state: {}}), ...lines, '{"time":"x","kind":"pause"}'].join('\r\n') + '\r\n');
    const records = await readRecords(dir, {since: '2026-10-01'});
    assert.deepEqual(records.map(r => r.kind), ['decision', 'sim', 'decision', 'decision']);
    assert.equal(compare(records).counts.compared, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the npm script runs the compare tool on a log folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-cli-'));
  try {
    await mkdir(join(dir, 'runs'));
    await writeFile(join(dir, 'runs/a.jsonl'), compareLog().map(r => JSON.stringify(r)).join('\n') + '\n');
    const out = execFileSync(process.execPath, [join(here, 'sim-compare.mjs'), '--since', '2026-10-01', '--json'], {env: {...process.env, STS2_PRIVATE_DIR: dir}, encoding: 'utf8'});
    assert.equal(JSON.parse(out).counts.compared, 1);
    const pkg = JSON.parse((await readFile(resolve(here, '../../package.json'), 'utf8')).replace(/\r\n/g, '\n'));
    assert.equal(pkg.scripts['sts2:sim-compare'], 'node integration/sts2/sim-compare.mjs');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
