import test from 'node:test';
import assert from 'node:assert/strict';
import {paceGroups, progressTable, compactJson, progressSvg, paceSvg, readmeSummary} from './progress-chart.mjs';

const moves = (run, seconds, {ready = false, policy = 'jev-compact-v1'} = {}) => seconds.map(s => ({kind: 'decision', outcome: 'executed', policy,
 time: new Date(Date.UTC(2026, 8, 28) + s * 1000).toISOString(), state: {run: {live_id: run}, ...(ready ? {ready: true} : {})}}));

test('pace groups runs by how the runner waited and leaves out pauses and short runs', () => {
 const events = [
  ...moves('a', [0, 0.5, 1, 1.6, 2.2], {ready: true}),
  ...moves('b', [0, 2, 4, 7, 10, 1000]),
  ...moves('c', [0, 3, 6, 9, 12], {policy: 'jev-visible-v23-retaliation'}),
  ...moves('d', [0, 1, 2]),
  {kind: 'decision', outcome: 'stale', time: new Date().toISOString(), state: {run: {live_id: 'a'}, ready: true}},
 ];
 assert.deepEqual(paceGroups(events), {
  ready: {runs: 1, moves: 5, median_s: 0.55},
  fixed: {runs: 1, moves: 6, median_s: 2.5},
  imported: {runs: 1, moves: 5, median_s: 3},
 });
});

const data = {game: 'Test <game>', bosses: [{floor: 17, label: 'Act 1 boss'}, {floor: 48, label: 'Act 3 boss'}],
 groups: [{id: 'jev', label: 'Jev only'}, {id: 'strategist', label: 'Jev + Claude strategist'}],
 versions: [
  {name: 'Jev v1', policy: 'jev-compact-v1', group: 'jev', added: 'One question', runs: [{run: '1', seed: null, result: 'lost', floor: 17}]},
  {name: 'Strategist v3', policy: 'claude-strategy-v3', group: 'strategist', added: 'Owned screens',
   runs: [{run: '2', seed: 'JEV1', result: 'won', floor: 48, replay: true}, {run: '3', seed: 'JEV2', result: 'in progress', floor: 30}]},
 ],
 notes: ['No run has won yet.'],
 pace: {about: 'Median', groups: [{id: 'fixed', label: 'Fixed', detail: 'waits', runs: 2, moves: 1200, median_s: 2.45}, {id: 'ready', label: 'Ready', detail: 'flag', runs: 1, moves: 300, median_s: 0.63}]}};

test('the README table lists every run, with seeds, replays and runs in progress', () => {
 assert.equal(progressTable(data), ['| Version | Final floor of each run | What it added |', '|---|---|---|',
  '| Jev v1 (`jev-compact-v1`) | 17 | One question |',
  '| Strategist v3 (`claude-strategy-v3`) | **JEV1: won (floor 48)** (replay), JEV2: in progress (floor 30) | Owned screens |'].join('\n'));
});

test('charts escape text, plot only finished runs and emphasize wins', () => {
 const svg = progressSvg(data, {surface: '#fff', text: '#000', secondary: '#333', muted: '#888', grid: '#eee', axis: '#ccc', track: 0.35, series: ['#00f', '#f80'], good: '#0a0', goodText: '#060'});
 assert.match(svg, /Test &lt;game&gt;/);
 assert.match(svg, />48<\/tspan><tspan fill="#060"> ✓ won</);
 assert.equal(svg.match(/<circle [^>]*r="4.5" fill="#00f"/g).length, 1);
 assert.equal(svg.match(/<circle [^>]*r="6.5" fill="#0a0"/g).length, 1);
 assert.doesNotMatch(svg + paceSvg(data, {surface: '#fff', text: '#000', secondary: '#333', muted: '#888', grid: '#eee', axis: '#ccc', series: ['#00f']}), /NaN|undefined/);
});

test('compact JSON keeps the data and puts each run on one line', () => {
 const text = compactJson(data);
 assert.deepEqual(JSON.parse(text), data);
 assert.match(text, /\n {4}\{"run": "1", "seed": null, "result": "lost", "floor": 17\},?\n/);
});

test('the README summary counts wins, final-boss runs and token ranges from the data', () => {
 const d = structuredClone(data);
 d.versions[0].runs[0].tokens = 1.5e6; d.versions[1].runs[0].tokens = 3e6; d.versions[1].runs[1].tokens = 9e6;
 const {results, cost} = readmeSummary(d);
 assert.equal(results, '**Results so far** (Ironclad, Ascension 0, standard runs): 1 win, by Strategist v3 on seed JEV1. '
  + 'Of the 1 finished strategist run, 1 reached the final boss on floor 48. Jev alone got no further than floor 17 in 1 run.');
 assert.match(cost, /^Jev used 1\.5 to 1\.5 million input tokens per Jev-only run and 3\.0 to 3\.0 million with the strategist, about \$0\.06 to \$0\.13 per run/);
});

const theme = {surface: '#fff', text: '#000', secondary: '#333', muted: '#888', grid: '#eee', axis: '#ccc', track: 0.35, series: ['#00f', '#f80'], good: '#0a0', goodText: '#060'};
const withIssues = () => {
 const d = structuredClone(data);
 d.issues = [{id: 'parse', label: 'Intents were not parsed.', fixed: 'abc1234'}, {id: 'crash', label: 'The game crashed.', fixed: '-'}, {id: 'unused', label: 'Unused.', fixed: '-'}];
 d.versions[0].runs[0].issues = ['parse'];
 d.versions[1].runs[0].issues = ['parse', 'crash'];
 return d;
};

test('the README table marks runs with known issues and explains the letters used under it', () => {
 const lines = progressTable(withIssues()).split('\n');
 assert.equal(lines[2], '| Jev v1 (`jev-compact-v1`) | 17<sup>a</sup> | One question |');
 assert.equal(lines[3], '| Strategist v3 (`claude-strategy-v3`) | **JEV1: won (floor 48)** (replay)<sup>a,b</sup>, JEV2: in progress (floor 30) | Owned screens |');
 assert.deepEqual(lines.slice(4), ['', '- <sup>a</sup> Intents were not parsed. Fixed in abc1234.', '- <sup>b</sup> The game crashed.']);
 assert.equal(progressTable(data).split('\n').length, 4);
 // A fix made outside the code, such as a settings change, reads as a phrase.
 const d = withIssues(); d.issues[1].fixed = 'mods disabled on 2026-09-30';
 assert.equal(progressTable(d).split('\n').at(-1), '- <sup>b</sup> The game crashed. Fixed: mods disabled on 2026-09-30.');
});

test('an unknown issue ID stops the render', () => {
 const d = withIssues(); d.versions[0].runs[0].issues = ['gpu'];
 assert.throws(() => progressTable(d), /unknown issue gpu/);
 assert.throws(() => progressSvg(d, theme), /unknown issue gpu/);
});

test('the chart draws runs with known issues as hollow dots in the group colour and says so', () => {
 const svg = progressSvg(withIssues(), theme);
 assert.match(svg, /Hollow dots: runs affected by a known issue/);
 assert.equal(svg.match(/<circle [^>]*r="3.5" fill="#fff" stroke="#00f"/g).length, 1);
 assert.equal(svg.match(/<circle [^>]*r="5.5" fill="#fff" stroke="#0a0"/g).length, 1);
 assert.doesNotMatch(progressSvg(data, theme), /Hollow dots/);
});

test('a row with enough comparable finished runs shows its win rate in the table and the chart', () => {
 const d = structuredClone(data);
 d.versions[0].mode = 'jev';
 d.versions[0].runs = [17, 17, 28, 48, 14].map((floor, i) => ({run: String(i), seed: null, result: floor === 48 ? 'won' : 'lost', floor}));
 assert.match(progressTable(d).split('\n')[2], /^\| Jev v1 \(`jev-compact-v1`\) \| \*\*1 of 5 won, median floor 17\*\*: 17, 17, 28, \*\*won \(floor 48\)\*\*, 14 \|/);
 assert.match(progressSvg(d, theme), /> · 1 of 5 won, median floor 17<\/tspan>/);
 d.versions[0].runs.pop();
 assert.match(progressTable(d).split('\n')[2], /^\| Jev v1 \(`jev-compact-v1`\) \| 17, 17, 28/);
});

test('compact JSON keeps a run with issues on one line', () => {
 const d = withIssues(), text = compactJson(d);
 assert.deepEqual(JSON.parse(text), d);
 assert.match(text, /\n {4}\{"run": "1", "seed": null, "result": "lost", "floor": 17, "issues": \["parse"\]\},?\n/);
 assert.match(text, /\n {2}\{"id": "crash", "label": "The game crashed.", "fixed": "-"\},?\n/);
 assert.match(text, /"notes": \[\n {2}"No run has won yet."\n \]/);
});
