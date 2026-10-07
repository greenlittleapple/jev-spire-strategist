import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wilson, fisher, median, quantile, bootstrapDiff, parseSeeds, parseVersions, parseFilter, parseStretches, loadRuns, selectRuns, wallTable,
 fightCollector, fightShare, runScore, scoreReport, compareArms, findRuns, runLine, groupOf, main, WIN_SCORE, DEFAULT_STRETCHES} from './walls.mjs';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('Wilson interval and Fisher exact p match known values', () => {
 const [lo, hi] = wilson(3, 10);
 close(lo, 0.1078); close(hi, 0.6032);
 close(wilson(0, 5)[1], 0.4345);
 assert.deepEqual(wilson(0, 0), [0, 1]);
 // R: fisher.test(matrix(c(1, 11, 9, 3), 2))$p.value = 0.002759; matrix(c(3, 1, 1, 3), 2) gives 0.4857.
 close(fisher(1, 9, 11, 3), 0.002759, 1e-6);
 close(fisher(3, 1, 1, 3), 0.485714, 1e-6);
 assert.equal(fisher(0, 0, 0, 0), 1);
});

test('median, quantile and a seeded bootstrap', () => {
 assert.equal(median([3, 1, 2]), 2);
 assert.equal(median([4, 1, 2, 3]), 2.5);
 assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
 const a = [10, 12, 11, 13, 9], b = [20, 22, 21, 23, 19];
 const ci = bootstrapDiff(a, b, {seed: 7});
 assert.deepEqual(ci, bootstrapDiff(a, b, {seed: 7}));
 assert.ok(ci[0] > 7 && ci[1] < 13 && ci[0] < 10 && ci[1] > 10);
 assert.equal(bootstrapDiff([], b), null);
});

const data = () => ({versions: [
 {name: 'Jev v3.3', policy: 'jev-compact-v3.3', group: 'jev', mode: 'jev_facts_v3', runs: [
  {run: '1790600000', seed: 'JEV21', result: 'lost', floor: 8}, {run: '1790600100', seed: 'JEV22', result: 'lost', floor: 17}]},
 {name: 'Strategist v3.5', policy: 'claude-strategy-v3', mode: 'claude', runs: [
  {run: '1790700000', seed: 'JEV3', result: 'lost', floor: 33}, {run: '1790700100', seed: 'JEV4', result: 'won', floor: 48}]},
 {name: 'Strategist v3.17', policy: 'claude-strategy-v3', group: 'strategist', mode: 'claude', runs: [
  {run: '1790800000', seed: 'JEV21', result: 'lost', floor: 17}, {run: '1790800100', seed: 'JEV22', result: 'abandoned', floor: 20, issues: ['crash']}]},
 {name: 'Strategist v3.18', policy: 'claude-strategy-v3', group: 'strategist', mode: 'claude', runs: [
  {run: '1790900000', seed: 'JEV21', result: 'lost', floor: 48}, {run: '1790900100', seed: 'JEV22', result: 'lost', floor: 24}, {run: '1790900200', seed: 'JEV23', result: 'won', floor: 48}]},
], excluded: [{run: '1790750000', reason: 'JEV20 (Strategist v3.17), abandoned at Act 1 floor 3 after 33 moves, when the code moved on'}]});

test('runs load with group, mode and excluded runs as unfinished', () => {
 const runs = loadRuns(data());
 assert.equal(runs.length, 10);
 assert.equal(groupOf({name: 'Strategist v3.5'}), 'strategist');
 const x = runs.find(r => r.run === '1790750000');
 assert.deepEqual([x.result, x.floor, x.seed, x.version, x.group], ['excluded', 3, 'JEV20', 'Strategist v3.17', 'strategist']);
});

test('filters: version names and ranges, group, seeds, mode, issues, time', () => {
 const runs = loadRuns(data());
 const ids = f => selectRuns(runs, f).map(r => r.run).sort();
 assert.equal(ids({version: 'Strategist v3.18'}).length, 3);
 assert.equal(ids({version: 'Strategist ..v3.17'}).length, 5);
 assert.equal(ids({version: 'Strategist v3.6..'}).length, 6);
 assert.equal(ids({version: 'Jev v3.3,Strategist v3.5'}).length, 4);
 assert.equal(ids({group: 'jev'}).length, 2);
 assert.equal(ids({mode: 'claude'}).length, 8);
 assert.deepEqual(ids({seeds: 'JEV21-JEV22', group: 'strategist'}), ['1790800000', '1790800100', '1790900000', '1790900100']);
 assert.equal(ids({seeds: 'JEV3,JEV20-21'}).length, 5);
 assert.ok(parseSeeds('JEV21-25')('jev23'));
 assert.equal(parseSeeds('JEV21-25')(null), false);
 assert.equal(ids({excludeIssues: 'crash'}).length, 9);
 assert.deepEqual(ids({since: new Date(1790900000 * 1000).toISOString(), until: new Date(1790900150 * 1000).toISOString()}), ['1790900000', '1790900100']);
 assert.ok(parseVersions('Strategist v3..v3.17')('Strategist v3.9'));
 assert.ok(!parseVersions('Strategist v3..v3.17')('Strategist v2.1'));
 assert.deepEqual(parseFilter('version=Strategist v3.5,v3.6,group=strategist'), {version: 'Strategist v3.5,v3.6', group: 'strategist'});
 assert.throws(() => parseFilter('nonsense'));
});

test('stretch table: wins reach every stretch, unfinished runs count only in stretches got past whole', () => {
 const st = parseStretches();
 assert.deepEqual(st.map(s => s.label), ['Act 1', 'Act 1 boss', 'Act 2', 'Act 2 boss', 'Act 3', 'Act 3 boss']);
 const runs = [
  {result: 'lost', floor: 8}, {result: 'lost', floor: 17}, {result: 'won', floor: 48},
  {result: 'abandoned', floor: 17}, // got past Act 1 only
  {result: 'excluded', floor: 3}, // got past nothing
  {result: 'in progress', floor: 33}, // got past Act 1, its boss and Act 2
 ];
 const t = wallTable(runs, st);
 assert.deepEqual(t.map(r => [r.reached, r.died]), [[5, 1], [3, 1], [2, 0], [1, 0], [1, 0], [1, 0]]);
 close(t[0].hazard, 0.2); close(t[1].clear, 0.8 * 2 / 3);
 close(t.at(-1).clear, 0.8 * 2 / 3);
 assert.equal(parseStretches('1-10,11').at(-1).label, 'Floors 11');
 assert.throws(() => parseStretches('a-b'));
});

// Synthetic log events.
const ev = (id, floor, type, enemies, {hp = 50, potions = [], kind = 'decision', act = 1} = {}) => ({kind, time: '2026-10-01T00:00:00Z',
 state: {state_type: type, run: {live_id: `modded:profile1:${id}`, act, floor},
  player: {hp, max_hp: 80, potions: potions.map(name => ({name}))}, ...(enemies ? {battle: {round: 1, enemies: enemies.map(([entity_id, h, m]) => ({entity_id, name: entity_id.replace(/_\d+$/, ''), hp: h, max_hp: m}))}} : {})}});
const end = (id, floor) => ({kind: 'run_end', time: '2026-10-01T01:00:00Z', state: {state_type: 'game_over', run: {live_id: `modded:profile1:${id}`, act: 1, floor}, player: {hp: 0}}});
const collect = events => { const c = fightCollector(); events.forEach(c.add); return c.result(); };

test('score: fatal fight share across enemies, deaths and placeholder HP', () => {
 const {runs, phases} = collect([
  ev('1', 5, 'monster', [['A_0', 20, 20]]), ev('1', 5, 'monster', [['A_0', 0, 20]]),
  ev('1', 8, 'map', null),
  ev('1', 8, 'elite', [['B_0', 50, 50], ['C_0', 30, 30]], {hp: 40, potions: ['Fire Potion']}),
  ev('1', 8, 'hand_select', [['B_0', 40, 50], ['C_0', 30, 30]]),
  ev('1', 8, 'elite', [['B_0', 25, 50]], {hp: 3}), // C gone: dead
  end('1', 8),
  ev('2', 17, 'boss', [['GIANT_0', 240, 240]]), ev('2', 17, 'boss', [['GIANT_0', 999999999, 999999999]], {hp: 2}), end('2', 17),
 ]);
 const f = fightShare(runs.get('1').fight, phases);
 assert.equal(f.type, 'elite'); assert.equal(f.total_hp, 80); assert.equal(f.removed_hp, 55);
 assert.equal(f.entry_hp, 40); assert.deepEqual(f.entry_potions, ['Fire Potion']); assert.equal(f.name, 'B + C');
 const s = runScore({result: 'lost', floor: 8}, runs.get('1'), phases);
 close(s.score, 7 + 55 / 80);
 assert.equal(runScore({result: 'lost', floor: 17}, runs.get('2'), phases).score, 17);
 assert.equal(runScore({result: 'won', floor: 48}, runs.get('2'), phases).score, WIN_SCORE);
 assert.equal(runScore({result: 'abandoned', floor: 17}, runs.get('2'), phases).score, null);
});

test('score: a multi-phase boss counts every phase, including phases learned from other runs', () => {
 const {runs, phases} = collect([
  // Run 3 reaches all three phases and dies in the third with 80 of 300 left.
  ev('3', 43, 'boss', [['SUBJECT_0', 100, 100]], {act: 3}), ev('3', 43, 'boss', [['SUBJECT_0', 30, 100]], {act: 3}),
  ev('3', 43, 'boss', [], {act: 3}), ev('3', 43, 'boss', [['SUBJECT_0', 192, 200]], {act: 3}), ev('3', 43, 'boss', [['SUBJECT_0', 109, 200]], {act: 3}),
  ev('3', 43, 'boss', [['SUBJECT_0', 298, 300]], {act: 3}), ev('3', 43, 'boss', [['SUBJECT_0', 80, 300]], {act: 3}), end('3', 43),
  // Run 4 dies in the first phase with 40 of 100 left.
  ev('4', 43, 'boss', [['SUBJECT_0', 100, 100]], {act: 3}), ev('4', 43, 'boss', [['SUBJECT_0', 40, 100]], {act: 3}), end('4', 43),
 ]);
 assert.deepEqual(phases.get('SUBJECT'), [100, 200, 300]);
 const a = fightShare(runs.get('3').fight, phases);
 assert.equal(a.total_hp, 600); assert.equal(a.removed_hp, 520);
 const b = fightShare(runs.get('4').fight, phases);
 assert.equal(b.total_hp, 600); assert.equal(b.removed_hp, 60);
 // Without the learned phases the first-phase death would look like 60% of the fight.
 close(fightShare(runs.get('4').fight).share, 0.6);
});

test('score: a loss without a readable fatal fight has share null, counted as 0 and reported', () => {
 const {runs, phases} = collect([ev('5', 12, 'monster', [['A_0', 10, 20]]), ev('5', 13, 'event', null), end('5', 13)]);
 const s = runScore({result: 'lost', floor: 13}, runs.get('5'), phases);
 assert.deepEqual([s.score, s.share], [12, null]);
 assert.equal(runScore({result: 'lost', floor: 13}, undefined, phases).score, 12);
 const rep = scoreReport([{run: '5', result: 'lost', floor: 13}, {run: '6', result: 'won', floor: 48}, {run: '7', result: 'abandoned', floor: 9}], runs, phases);
 assert.deepEqual([rep.n, rep.unfinished, rep.deaths, rep.null_share, rep.median], [2, 1, 1, 1, 30.5]);
 assert.equal(rep.stretches.length, 1);
 assert.equal(rep.stretches[0].null_share, 1);
});

test('compare: per-arm hazards and scores, bootstrap interval and Fisher p per stretch', () => {
 const runs = loadRuns(data());
 const c = compareArms(runs, new Map(), new Map(), parseFilter('version=Strategist ..v3.17'), parseFilter('version=Strategist v3.18'), {seed: 3, iters: 500});
 assert.equal(c.a.n, 3); assert.equal(c.a.unfinished, 2); assert.equal(c.b.n, 3);
 // A scores: 32, 49, 16 (no logs: shares null); B: 47, 23, 49.
 close(c.a.mean, 97 / 3); close(c.b.mean, 119 / 3); close(c.diff, 22 / 3);
 assert.ok(c.diff_ci[0] < c.diff && c.diff < c.diff_ci[1]);
 assert.equal(c.a.null_share, 2);
 assert.equal(c.walls.length, 6);
 assert.deepEqual([c.walls[1].a.reached, c.walls[1].a.died], [4, 1]);
 assert.ok(c.walls.every(w => w.p == null || (w.p >= 0 && w.p <= 1)));
 const late = compareArms(runs, new Map(), new Map(), {group: 'strategist'}, {group: 'jev'}, {fromFloor: 18, iters: 100});
 assert.equal(late.walls[0].stretch, 'Act 2');
 assert.equal(late.b.early, 2); assert.equal(late.b.n, 0);
});

test('run lookup by id or seed+version, and the run line', () => {
 const runs = loadRuns(data());
 assert.equal(findRuns(runs, 'JEV22+Strategist v3.18')[0].run, '1790900100');
 assert.equal(findRuns(runs, 'jev22@Strategist v3.18').length, 1);
 assert.equal(findRuns(runs, '1790600000')[0].version, 'Jev v3.3');
 const {runs: logs, phases} = collect([ev('1790900100', 24, 'elite', [['D_0', 50, 100]], {hp: 21, potions: ['Block Potion']}), end('1790900100', 24)]);
 const line = runLine(findRuns(runs, '1790900100')[0], logs.get('1790900100'), phases);
 assert.equal(line.score, 23.5);
 assert.deepEqual(line.fatal_fight, {name: 'D', type: 'elite', floor: 24, share: 0.5, entry_hp: 21, entry_max_hp: 80, potions: ['Block Potion']});
});

test('CLI reads the progress file and logs and prints tables, compare and run lines', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'sts2-walls-'));
 try {
  mkdirSync(join(dir, 'runs'));
  const lines = [ev('1790900100', 24, 'elite', [['D_0', 50, 100]], {hp: 21}), end('1790900100', 24), {kind: 'strategy_request'}];
  writeFileSync(join(dir, 'runs', 'a.jsonl'), lines.map(l => JSON.stringify(l)).join('\r\n') + '\r\n');
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data()));
  const run = async args => { const out = []; const code = await main([...args, '--data', join(dir, 'data.json')], {log: x => out.push(x), err: x => out.push(x), env: {STS2_PRIVATE_DIR: dir}}); return {code, text: out.join('\n')}; };
  let r = await run(['--group', 'strategist']);
  assert.equal(r.code, 0); assert.match(r.text, /Act 1 boss\s+17/); assert.match(r.text, /8 runs/);
  r = await run(['--by', 'version', '--json']);
  assert.equal(JSON.parse(r.text).groups.length, 4);
  r = await run(['--compare', '--a', 'version=Strategist v3.17', '--b', 'version=Strategist v3.18']);
  assert.equal(r.code, 0); assert.match(r.text, /B - A mean/);
  r = await run(['--run', 'JEV22+Strategist v3.18']);
  assert.match(r.text, /score 23\.50 \| fatal D \(elite, f24\) 50% removed \| entered at 21\/80 HP with 0 potions/);
  r = await run(['--score', '--seeds', 'JEV22']);
  assert.match(r.text, /deaths have no readable fatal fight/);
  assert.equal((await run(['--version', 'Nope v1'])).code, 1);
 } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the default stretches cover the 48 floors of three acts', () => {
 const st = parseStretches(DEFAULT_STRETCHES);
 assert.equal(st[0].from, 1); assert.equal(st.at(-1).to, 48);
 st.slice(1).forEach((s, i) => assert.equal(s.from, st[i].to + 1));
});
