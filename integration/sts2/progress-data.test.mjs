import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {logPaths, scoreLogged, versionFor, refreshRun, addRuns, addToolIssues, checkIssues, modCards, MOD_CARD_ISSUE, memoryIssues, versionNumber, STRATEGIST_MEMORY_ISSUE, SAME_SEED_ISSUE, seriesRows, winRate, winRateText, mixedCommitRows, mixedModRows, WIN_RATE_MIN} from './progress-data.mjs';

const version = (name, policy, mode, runs = []) => ({name, policy, group: mode === 'claude' ? 'strategist' : 'jev', mode, added: `${name} rules`, runs});
const dataOf = () => ({issues: [{id: 'crash', label: 'Crashed.', fixed: '-'}], versions: [
 version('Jev v1', 'jev-compact-v1', 'jev', [{run: '10', seed: null, result: 'lost', act: 1, floor: 17}]),
 version('Strategist v3.15', 'claude-strategy-v3', 'claude', [{run: '20', seed: 'JEV17', result: 'lost', act: 2, floor: 27, issues: ['crash']}]),
 version('Strategist v3.16', 'claude-strategy-v3', 'claude'),
]});
const scoredRun = (id, fields = {}) => ({id, run: `modded:profile1:${id}`, started: `2026-09-29T0${id.length}:00:00Z`, policy: 'claude-strategy-v3', modifiers: 'standard', ascension: 0,
 result: 'lost', act: 1, floor: 17, moves: 200, input_tokens: 1e6, seed: null, label: null, mode: 'claude', lab_commit: null, lab_dirty: null, ...fields});

test('the private directory comes from STS2_PRIVATE_DIR, and SPIRE_LOG_DIR still overrides the run logs', () => {
 assert.deepEqual(logPaths({STS2_PRIVATE_DIR: resolve('/p')}), {logDir: resolve('/p/runs'), seriesFile: resolve('/p/series.jsonl')});
 assert.equal(logPaths({STS2_PRIVATE_DIR: resolve('/p'), SPIRE_LOG_DIR: resolve('/logs')}).logDir, resolve('/logs'));
});

test('scored runs take the mode and lab commit from run_start, then the decisions and the series file, then the policy', () => {
 const decision = (id, policy, decisionMode, floor) => ({kind: 'decision', outcome: 'executed', time: `2026-09-29T00:0${floor}:00Z`, policy, ...(decisionMode ? {decisionMode} : {}),
  state: {state_type: 'map', run: {live_id: `modded:profile1:${id}`, act: 1, floor, ascension: 0}, player: {hp: 10}}});
 const events = [decision('1', 'jev-compact-v1', null, 1), decision('2', 'claude-strategy-v3', 'claude', 2), decision('3', 'claude-strategy-v3', 'claude', 3), decision('4', 'claude-strategy-v3', null, 4)];
 const series = [{run: 'modded:profile1:3', mode: 'claude', seed: 'JEV3', label: 'Strategist v3.16', lab_commit: 'bbb2222', lab_dirty: false},
  {run: 'modded:profile1:4', mode: 'claude', seed: 'JEV4', label: 'Strategist v3.16'}];
 const starts = [{kind: 'run_start', run: 'modded:profile1:2', lab_commit: 'aaa1111', lab_dirty: true, decision_mode: 'claude'}];
 const s = scoreLogged({events, series, starts});
 assert.deepEqual([...s.keys()], ['1', '2', '3', '4']);
 assert.deepEqual(['1', '2', '3', '4'].map(id => [s.get(id).mode, s.get(id).lab_commit, s.get(id).lab_dirty]),
  [['jev', null, null], ['claude', 'aaa1111', true], ['claude', 'bbb2222', false], ['claude', null, null]]);
 assert.equal(s.get('3').label, 'Strategist v3.16');
 assert.equal(s.get('1').result, 'in progress');
});

test('a run belongs to the version its series label names, else to the only version with its policy', () => {
 const data = dataOf();
 assert.equal(versionFor(data, {label: 'Strategist v3.16: late elite limit', policy: 'claude-strategy-v3'}).version.name, 'Strategist v3.16');
 assert.equal(versionFor(data, {label: 'Strategist v3.15', policy: 'claude-strategy-v3'}).version.name, 'Strategist v3.15');
 assert.equal(versionFor(data, {label: null, policy: 'jev-compact-v1'}).version.name, 'Jev v1');
 assert.match(versionFor(data, {label: 'eval v3.5 unseen JEV3', policy: 'claude-strategy-v3'}).reason, /2 versions share policy claude-strategy-v3/);
 assert.match(versionFor(data, {label: 'Strategist v3.17: new rule', policy: 'claude-strategy-v3'}).reason, /names Strategist v3\.17, which has no version/);
 assert.match(versionFor(data, {label: null, policy: 'jev-compact-v2+jev-compact-v3'}).reason, /no version has policy/);
 // "v3.1" must not match a label for v3.16.
 const d = dataOf(); d.versions.push(version('Strategist v3.1', 'claude-strategy-v3', 'claude'));
 assert.equal(versionFor(d, {label: 'Strategist v3.16', policy: 'claude-strategy-v3'}).version.name, 'Strategist v3.16');
});

test('--add lists new runs under their version in start order, skips runs without a move and reports the rest', () => {
 const data = dataOf();
 const scored = new Map([
  ['10', scoredRun('10', {policy: 'jev-compact-v1', mode: 'jev'})],
  ['31', scoredRun('31', {label: 'Strategist v3.16', seed: 'JEV20', result: 'in progress', floor: 3, started: '2026-09-29T20:30:00Z', lab_commit: 'c5ddfcc'})],
  ['30', scoredRun('30', {label: 'Strategist v3.16: limit', seed: 'JEV19', floor: 30, started: '2026-09-29T20:12:00Z'})],
  ['40', scoredRun('40', {moves: 0, label: 'Strategist v3.16'})],
  ['50', scoredRun('50', {modifiers: 'HEXTECH_MAYHEM_MODIFIER', policy: 'jev-visible-v24-hextech'})],
  ['60', scoredRun('60', {label: 'eval v3.5 unseen JEV3'})],
  ['70', scoredRun('70', {label: 'Strategist v3.16', ascension: 10})],
 ]);
 const out = addRuns(data, scored);
 assert.deepEqual(out.added.map(a => [a.run, a.version, a.result]), [['30', 'Strategist v3.16', 'lost'], ['31', 'Strategist v3.16', 'in progress']]);
 assert.deepEqual(out.skipped, ['40']);
 assert.deepEqual(out.unmatched.map(u => [u.run, u.reason]), [['50', 'run modifiers: HEXTECH_MAYHEM_MODIFIER'], ['60', '2 versions share policy claude-strategy-v3 and its series label names none'], ['70', 'Ascension 10']]);
 assert.deepEqual(data.versions[2].runs, [
  {run: '30', seed: 'JEV19', result: 'lost', act: 1, floor: 30, moves: 200, tokens: 1e6},
  {run: '31', seed: 'JEV20', result: 'in progress', act: 1, floor: 3, moves: 200, tokens: 1e6, lab_commit: 'c5ddfcc'}]);
 assert.equal(data.versions[0].runs.length, 1);
});

test('refreshing a run keeps its replay flag and issues, and stores the mode only where it differs from the version', () => {
 const v = version('Strategist v3.1', 'claude-strategy-v3', 'claude');
 const r = refreshRun(v, {run: '5', replay: true, issues: ['crash'], mode: 'old', lab_commit: 'old'}, scoredRun('5', {result: 'won', floor: 48, act: 3}));
 assert.deepEqual(r, {run: '5', replay: true, seed: null, result: 'won', act: 3, floor: 48, moves: 200, tokens: 1e6, issues: ['crash']});
 assert.equal(refreshRun(v, {run: '6'}, scoredRun('6', {mode: 'jev_facts', lab_dirty: true})).mode, 'jev_facts');
 assert.equal(refreshRun(v, {run: '6'}, scoredRun('6', {lab_dirty: true})).lab_dirty, true);
 assert.throws(() => refreshRun(v, {run: '7'}, undefined), /Run 7 is not in the logs/);
});

// A saved map history as the game logs it: acts of map points, each with per-player stats and rooms.
const point = (type, room, gained = []) => ({map_point_type: type, rooms: room ? [{model_id: room}] : [], player_stats: [{player_id: 1, cards_gained: gained.map(id => ({id}))}]});
const history = [[point('ancient', 'EVENT.NEOW', ['CARD.CLOUD-BLIZZARA']), point('monster', 'ENCOUNTER.X', ['CARD.PERFECTED_STRIKE'])],
 [point('shop', null, ['CARD.HORNET_MOD_CARD_HORNET_BEAST']), point('unknown', 'EVENT.COLORFUL_PHILOSOPHERS', ['CARD.HORNET_MOD_CARD_HORNET_BEAST', 'CARD.HORNET_MOD_CARD_HORNET_GEAR_BEE'])]];

test('mod cards are found in the saved map history with the floor and room where each first entered the deck', () => {
 assert.deepEqual(modCards(history), [{card: 'CARD.CLOUD-BLIZZARA', floor: 1, room: 'EVENT.NEOW'}, {card: 'CARD.HORNET_MOD_CARD_HORNET_BEAST', floor: 3, room: 'shop'},
  {card: 'CARD.HORNET_MOD_CARD_HORNET_GEAR_BEE', floor: 4, room: 'EVENT.COLORFUL_PHILOSOPHERS'}]);
 assert.deepEqual(modCards(undefined), []);
 assert.deepEqual(modCards([[{map_point_type: 'monster'}], [point('rest', null, ['CARD.CLOUDBURST'])]]), []);
});

test('scored runs carry the mod set hash and mod cards from the last logged history, and refresh tags or clears the issue', () => {
 const decision = (id, floor, h) => ({kind: 'decision', outcome: 'executed', time: `2026-09-29T00:0${floor}:00Z`, policy: 'claude-strategy-v3',
  state: {state_type: 'map', run: {live_id: `modded:profile1:${id}`, act: 1, floor, ascension: 0}, player: {hp: 10}, ...(h ? {saved_run: {map_point_history: h}} : {})}});
 const events = [decision('1', 1, [history[0].slice(0, 1)]), decision('1', 2, null), decision('2', 3, [history[0].slice(1)])];
 const s = scoreLogged({events, starts: [{kind: 'run_start', run: 'modded:profile1:1', mods_hash: 'abc123def456'}]});
 assert.deepEqual(s.get('1').mod_cards, [{card: 'CARD.CLOUD-BLIZZARA', floor: 1, room: 'EVENT.NEOW'}]);
 assert.equal(s.get('1').mods_hash, 'abc123def456');
 assert.deepEqual([s.get('2').mod_cards, s.get('2').mods_hash], [[], null]);
 const data = dataOf(), v = data.versions[1], r = v.runs[0];
 refreshRun(v, r, s.get('1'));
 assert.deepEqual([r.issues, r.mods_hash], [['crash', MOD_CARD_ISSUE.id], 'abc123def456']);
 refreshRun(v, r, s.get('1'));
 assert.deepEqual(r.issues, ['crash', MOD_CARD_ISSUE.id]);
 assert.throws(() => checkIssues(data), /unknown issue character-mod-cards/);
 addToolIssues(data); addToolIssues(data);
 assert.deepEqual(data.issues.map(i => i.id), ['crash', MOD_CARD_ISSUE.id]);
 checkIssues(data);
 // A run whose log shows no mod card loses the tag and keeps its other issues.
 refreshRun(v, r, {...s.get('2'), mod_cards: []});
 assert.deepEqual(r.issues, ['crash']);
 assert.equal(r.mods_hash, undefined);
 const clean = refreshRun(v, {run: '8', issues: [MOD_CARD_ISSUE.id]}, scoredRun('8', {mod_cards: []}));
 assert.equal(clean.issues, undefined);
});

test('an issue ID that data.issues lacks stops the render', () => {
 const data = dataOf();
 checkIssues(data);
 data.versions[0].runs[0].issues = ['gpu'];
 assert.throws(() => checkIssues(data), /Run 10 names unknown issue gpu/);
});

test('runs in another decision mode than their version form their own row', () => {
 const data = dataOf();
 data.versions[0].runs.push({run: '11', result: 'lost', floor: 14, mode: 'jev_facts'});
 data.versions[2].runs.push({run: '12', result: 'lost', floor: 3, mode: 'jev'});
 const rows = seriesRows(data);
 assert.deepEqual(rows.map(r => [r.name, r.runs.map(x => x.run)]),
  [['Jev v1', ['10']], ['Jev v1 (jev_facts)', ['11']], ['Strategist v3.15', ['20']], ['Strategist v3.16 (jev)', ['12']]]);
 assert.equal(rows[1].mode, 'jev_facts');
 assert.match(rows[1].added, /Played in jev_facts mode$/);
 // A version without runs keeps its row.
 assert.equal(seriesRows(dataOf()).at(-1).name, 'Strategist v3.16');
});

test(`a win rate needs ${WIN_RATE_MIN} finished runs of one version and mode that record no two different lab commits`, () => {
 const runs = (n, extra = {}) => Array.from({length: n}, (_, i) => ({run: String(i), result: i < 2 ? 'won' : 'lost', floor: i < 2 ? 48 : 17 + i, ...extra}));
 const row = r => ({name: 'Strategist v4', mode: 'claude', runs: r});
 assert.equal(winRate(row(runs(4))), null);
 assert.equal(winRate(row([...runs(4), {run: 'x', result: 'in progress', floor: 5}])), null);
 const w = winRate(row(runs(5)));
 assert.deepEqual(w, {won: 2, of: 5, median_floor: 21});
 assert.equal(winRateText(w), '2 of 5 won, median floor 21');
 // Runs without a recorded commit count alongside one commit; two different commits don't.
 const one = runs(5); one[0].lab_commit = 'aaa1111'; one[3].lab_commit = 'aaa1111';
 assert.equal(winRate(row(one)).of, 5);
 one[4].lab_commit = 'bbb2222';
 assert.equal(winRate(row(one)), null);
 assert.deepEqual(mixedCommitRows({versions: [{...row(one), runs: one}]}), [{name: 'Strategist v4', commits: ['aaa1111', 'bbb2222']}]);
 const modes = runs(5); modes[0].mode = 'jev';
 assert.equal(winRate(row(modes)), null);
});

test('a win rate also needs no two finished runs with different mod sets, and mixed rows are listed for a warning', () => {
 const runs = Array.from({length: 5}, (_, i) => ({run: String(i), result: 'lost', floor: 17 + i}));
 const row = r => ({name: 'Jev v4', mode: 'jev', runs: r});
 // Runs without a recorded mod set count alongside one mod set; two different mod sets don't.
 runs[0].mods_hash = 'aaaaaaaaaaaa'; runs[2].mods_hash = 'aaaaaaaaaaaa';
 assert.equal(winRate(row(runs)).of, 5);
 assert.deepEqual(mixedModRows({versions: [{...row(runs)}]}), []);
 runs[4].mods_hash = 'bbbbbbbbbbbb';
 assert.equal(winRate(row(runs)), null);
 assert.deepEqual(mixedModRows({versions: [{...row(runs)}]}), [{name: 'Jev v4', mods: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']}]);
});

test('--add leaves out runs listed in data.excluded and reports them', () => {
 const data = {...dataOf(), excluded: [{run: '31', reason: 'abandoned at floor 3 when the code changed'}]};
 const out = addRuns(data, new Map([['31', scoredRun('31', {label: 'Strategist v3.16', seed: 'JEV20', result: 'in progress', floor: 3})],
  ['30', scoredRun('30', {label: 'Strategist v3.16', seed: 'JEV19', floor: 30})]]));
 assert.deepEqual(out.added.map(a => a.run), ['30']);
 assert.deepEqual(out.excluded, [{run: '31', reason: 'abandoned at floor 3 when the code changed'}]);
 assert.deepEqual(data.versions[2].runs.map(r => r.run), ['30']);
});

test('strategist-memory tags every claude-mode run before Strategist v3.17, and never a Jev-only run', () => {
 assert.deepEqual([versionNumber('Strategist v3.17'), versionNumber('Jev v3'), versionNumber('Strategist v2.1')], [[3, 17], [3], [2, 1]]);
 const run = (id, seed) => ({run: id, seed, result: 'lost', floor: 17});
 const data = {issues: [{id: 'crash', label: 'Crashed.', fixed: '-'}], versions: [
  version('Jev v1', 'jev-compact-v1', 'jev', [run('1', null)]),
  version('Strategist v2', 'claude-strategy-v2', 'claude', [run('2', 'JEV1')]),
  version('Strategist v3.16', 'claude-strategy-v3', 'claude', [{...run('3', 'JEV2'), issues: ['crash']}, {...run('4', 'JEV3'), mode: 'jev_facts_v3'}]),
  version('Strategist v3.17', 'claude-strategy-v3', 'claude', [run('5', 'JEV4')]),
  version('Jev v3.2', 'jev-compact-v3.2', 'jev_facts_v3', [run('6', 'JEV5')]),
 ]};
 const scored = new Map(['1', '2', '3', '4', '5', '6'].map((id, i) => [id, scoredRun(id, {seed: data.versions.flatMap(v => v.runs)[i].seed, started: `2026-09-29T0${i}:00:00Z`})]));
 memoryIssues(data, scored); memoryIssues(data, scored);
 assert.deepEqual(data.versions.flatMap(v => v.runs.map(r => [r.run, r.issues])),
  [['1', undefined], ['2', ['strategist-memory']], ['3', ['crash', 'strategist-memory']], ['4', undefined], ['5', undefined], ['6', undefined]]);
 addToolIssues(data); checkIssues(data);
 assert.deepEqual(data.issues.map(i => i.id), ['crash', STRATEGIST_MEMORY_ISSUE.id]);
});

test('same-seed-history tags claude-mode runs from v3.1 to before v3.19 on a seed an earlier logged run played', () => {
 const run = (id, seed, mode) => ({run: id, seed, result: 'lost', floor: 17, ...(mode ? {mode} : {})});
 const data = {issues: [], versions: [
  version('Strategist v3', 'claude-strategy-v3', 'claude', [run('1', 'JEV1')]),
  version('Strategist v3.1', 'claude-strategy-v3', 'claude', [run('2', 'JEV1')]),
  version('Jev v3.2', 'jev-compact-v3.2', 'jev_facts_v3', [run('3', 'JEV21'), run('4', 'JEV21')]),
  version('Strategist v3.18', 'claude-strategy-v3', 'claude', [run('5', 'JEV21'), run('6', 'JEV22'), run('7', 'JEV21', 'jev_facts_v3')]),
  version('Strategist v3.19', 'claude-strategy-v3', 'claude', [run('8', 'JEV21')]),
 ]};
 // Start order: 1 (JEV1 v3, before the bound), 2, 3, 4, 5, 6, 7, 8; run 9 is a logged run on JEV22 that
 // started after run 6 and isn't listed, so it doesn't count as earlier.
 const seeds = {1: 'JEV1', 2: 'JEV1', 3: 'JEV21', 4: 'JEV21', 5: 'JEV21', 6: 'JEV22', 7: 'JEV21', 8: 'JEV21', 9: 'JEV22'};
 const scored = new Map(Object.entries(seeds).map(([id, seed]) => [id, scoredRun(id, {seed, started: `2026-09-30T0${id}:00:00Z`})]));
 // An earlier JEV1 run (v2.1, say) doesn't tag v3, which is before the bound.
 scored.set('x', scoredRun('x', {seed: 'JEV1', started: '2026-09-29T00:00:00Z'}));
 memoryIssues(data, scored);
 assert.deepEqual(data.versions.flatMap(v => v.runs.filter(r => r.issues).map(r => [r.run, r.issues])),
  [['1', ['strategist-memory']], ['2', ['strategist-memory', 'same-seed-history']], ['5', ['same-seed-history']]]);
 scored.delete('x');
 // An earlier run on the seed, even one left out of the data, tags it; the tag is recomputed on each refresh.
 scored.set('0', scoredRun('0', {seed: 'JEV22', started: '2026-09-29T00:00:00Z'}));
 memoryIssues(data, scored);
 assert.deepEqual(data.versions[3].runs.map(r => r.issues), [['same-seed-history'], ['same-seed-history'], undefined]);
 scored.delete('0'); scored.delete('1');
 memoryIssues(data, scored);
 assert.deepEqual(data.versions.flatMap(v => v.runs.filter(r => r.issues?.includes(SAME_SEED_ISSUE.id)).map(r => r.run)), ['5']);
 addToolIssues(data);
 assert.deepEqual(data.issues.map(i => i.id), [STRATEGIST_MEMORY_ISSUE.id, SAME_SEED_ISSUE.id]);
 // A stored entry takes the tool's current text.
 data.issues[1].fixed = '-'; addToolIssues(data);
 assert.deepEqual(data.issues[1], SAME_SEED_ISSUE);
});
