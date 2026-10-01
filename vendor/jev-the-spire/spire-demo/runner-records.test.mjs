import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PAUSE_REASONS, pauseRecord, timeoutMessage, operatorCancel, writeDispatchMarker, PRE_ENQUEUE_REJECTION } from './runner-records.mjs';

// server.mjs is read as text: importing it starts a runner.
const server = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');

test('a timeout names the call that timed out; other errors pass through', () => {
  const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(timeoutMessage(timedOut, 'Game state read timed out').message, 'Game state read timed out');
  const other = Error('fetch failed');
  assert.equal(timeoutMessage(other, 'Jev request timed out'), other);
  assert.match(server, /'Game state read timed out'/);
  assert.match(server, /timeoutMessage\(error,'Jev request timed out'\)/);
});

test('a failed dispatch-marker write logs not_sent and clears the uncertain action', async () => {
  const records = [], view = {};
  const log = async e => { records.push(e); if (e.kind === 'dispatch') throw Error('EPERM: rename'); };
  const marker = { command: { action: 'end_turn' }, stateHash: 'h', time: 't' };
  await assert.rejects(writeDispatchMarker(log, view, marker), /EPERM/);
  assert.equal(view.uncertainAction, null);
  assert.deepEqual(records.map(e => e.outcome), ['pending', 'not_sent']);
  assert.equal(records[1].message, 'EPERM: rename');
  const ok = [], v2 = {};
  await writeDispatchMarker(async e => { ok.push(e); }, v2, marker);
  assert.deepEqual(v2.uncertainAction, marker);assert.deepEqual(ok, [{ kind: 'dispatch', outcome: 'pending', ...marker }]);
});

test('an operator pause during a decision is a pause record, not an error', () => {
  assert.equal(operatorCancel(Error('Decision cancelled.'), true), true);
  assert.equal(operatorCancel(Error('Decision cancelled.'), false), false);
  assert.equal(operatorCancel(Error('Game state read timed out'), true), false);
  assert.deepEqual(pauseRecord('operator', 'Paused.', { stage: 'Waiting for the strategist' }), { kind: 'pause', reason: 'operator', message: 'Paused.', stage: 'Waiting for the strategist' });
  const pause = server.slice(server.indexOf("req.url === '/api/pause'"), server.indexOf("req.url.startsWith('/api/mode/')"));
  assert.match(pause, /'operator'/);
  assert.match(server, /if \(operatorCancel\(error, token !== generation\)\) return;/);
});

test('every stop in step() names a pause reason or has its own record', () => {
  const body = server.slice(server.indexOf('async function step('), server.indexOf('// Sequential runner'));
  const calls = [...body.matchAll(/stop\(([^;]*?)\);/g)].map(m => m[1]);
  assert.ok(calls.length >= 7);
  for (const call of calls) {
    const reason = call.match(/, (null|'(\w+)'|s\.state_type)$/);
    assert.ok(reason, `stop call without a reason: ${call}`);
    if (reason[2]) assert.ok(PAUSE_REASONS.includes(reason[2]), reason[2]);
  }
  assert.match(server, /await stop\('Stopped', 'shutdown'\)/);
});

test('the runner logs strategy events as they happen and records rule and screen-choice fields', () => {
  assert.match(server, /hierarchicalDeliberate\)\(\{state:planningState,candidates:actions,onEvent,/);
  assert.match(server, /if \(!logged\.has\(strategyEvent\)\) await onEvent\(strategyEvent\)/);
  assert.match(server, /rule:result\.rule\?\?null, screenChoice:result\.screenChoice\?\?null/);
  assert.match(server, /await writeDispatchMarker\(log, view,/);
});

test('bridge errors returned before enqueueing are game_rejected dispatches, not uncertain actions', () => {
  // JEV23 floor 5: a second choose_map_node from a stale map state while traveling to the shop.
  for (const message of ['Map screen is not open', 'card_index 7 out of range (5 cards)', 'Not in play phase - cannot act during enemy turn'])
    assert.match(message, PRE_ENQUEUE_REJECTION);
  for (const message of ['Map node index 3 out of range', 'Rewards screen is not open', 'fetch failed', 'Map screen is not open yet'])
    assert.doesNotMatch(message, PRE_ENQUEUE_REJECTION);
  const handler = server.slice(server.indexOf("gameRequest('/api/v1/singleplayer', chosen.command)"));
  assert.match(handler.slice(0, 600), /if \(PRE_ENQUEUE_REJECTION\.test\(error\.message\)\) \{/);
  assert.match(handler.slice(0, 900), /outcome: 'game_rejected'/);
});
