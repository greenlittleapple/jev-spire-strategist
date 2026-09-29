import test from 'node:test';
import assert from 'node:assert/strict';
import {paceGroups, progressTable, compactJson, progressSvg, paceSvg} from './progress-chart.mjs';

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
