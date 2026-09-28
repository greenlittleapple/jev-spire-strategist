import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, validateConfig } from '../dist/config.js';
import { validateObservation } from '../dist/contracts.js';
import { DemoAdapter } from '../dist/adapters/demo.js';
import { BridgeAdapter } from '../dist/adapters/bridge.js';
import { JevDecisions, MockDecisions } from '../dist/decisions.js';
import { run } from '../dist/engine.js';
import { writeReport } from '../dist/report.js';

const baseline = await loadConfig('config/demo.json');
const config = { ...baseline, minIntervalMs: 0 };
const decision = (action, confidence = 1) => ({ action, confidence, probabilities: {}, model: 'test', inputTokens: 0 });
test('full observable cycle wins with five legal actions and fresh observations', async () => {
  const events = [];
  const result = await run(new DemoAdapter(), new MockDecisions(), config, e => events.push(e));
  assert.equal(result.reason, 'won'); assert.equal(result.steps, 5);
  assert.equal(result.calls, 4); assert.equal(result.inputTokens, 0);
  assert.equal(events.filter(e => e.type === 'observation').at(-1).observation.status, 'won');
});
test('unknown decision is never executed', async () => {
  const a = new DemoAdapter();
  const result = await run(a, { choose: async () => decision('delete_everything') }, config);
  assert.equal(result.reason, 'illegal_decision'); assert.equal((await a.observe()).revision, '0');
});
test('low and malformed confidence both stop before execution', async () => {
  for (const confidence of [0.2, NaN, 1.1]) {
    const result = await run(new DemoAdapter(), { choose: async () => decision('workshop', confidence) }, config);
    assert.equal(result.reason, 'low_confidence'); assert.equal(result.steps, 0);
  }
});
test('state changes while inference runs reject stale decision', async () => {
  const a = new DemoAdapter();
  const result = await run(a, { choose: async () => {
    await a.execute('exit', '0', 'other-operator'); return decision('workshop');
  } }, config);
  assert.equal(result.reason, 'stale_observation'); assert.equal(result.steps, 0);
});
test('deterministic single action does not call inference', async () => {
  let done = false;
  const a = { id: 'single', observe: async () => ({ revision: '0', progressKey: 'one', state: {}, status: done ? 'won' : 'running',
    actions: [{ id: 'finish', description: 'finish', facts: {} }] }), execute: async () => { done = true; }, close: async () => {} };
  const result = await run(a, { choose: async () => { throw Error('must not call'); } }, config);
  assert.equal(result.reason, 'won'); assert.equal(result.calls, 0);
});
test('call and step bounds stop at the configured limit', async () => {
  const callBound = await run(new DemoAdapter(), new MockDecisions(), { ...config, maxCalls: 1 });
  assert.equal(callBound.reason, 'call_limit'); assert.equal(callBound.calls, 1);
  const stepBound = await run(new DemoAdapter(), new MockDecisions(), { ...config, maxSteps: 1 });
  assert.equal(stepBound.reason, 'step_limit'); assert.equal(stepBound.steps, 1);
});
test('oversized requests never reach the decision provider', async () => {
  let called = false;
  const result = await run(new DemoAdapter(), { choose: async () => { called = true; } }, { ...config, maxRequestBytes: 1 });
  assert.equal(result.reason, 'request_size_limit'); assert.equal(called, false);
});
test('semantic loop stops despite incrementing revision', async () => {
  const result = await run(new DemoAdapter(), { choose: async o => decision(o.actions.some(a => a.id === 'exit') ? 'exit' : 'hall') }, config);
  assert.equal(result.reason, 'repeated_state'); assert.ok(result.steps < config.maxSteps);
});
test('timeout aborts pending inference and closes adapter', async () => {
  const a = new DemoAdapter(); let closed = false;
  a.close = async () => { closed = true; };
  const result = await run(a, { choose: async (o, goal, signal) => { await delay(10000, null, { signal }); return decision('workshop'); } },
    { ...config, maxSeconds: 1 });
  assert.equal(result.reason, 'time_limit'); assert.equal(result.steps, 0); assert.equal(closed, true);
});
test('user cancellation is distinct from timeout', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await run(new DemoAdapter(), new MockDecisions(), config, () => {}, controller.signal);
  assert.equal(result.reason, 'stopped'); assert.equal(result.calls, 0);
});
test('official SDK sends expected Jev contract and reads usage without a live key', async () => {
  let recorded;
  const provider = new JevDecisions('jev-1.13.0', 'test-only-not-a-real-key', { fetch: async (url, init) => {
    recorded = { url, request: JSON.parse(init.body) };
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { action: {
      type: 'choice', choice: 'workshop', confidence: 0.92, probabilities: { workshop: 0.92, exit: 0.08 }
    } }, usage: { input_tokens: 123, output_tokens: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const result = await provider.choose(await new DemoAdapter().observe(), config.objective, new AbortController().signal);
  assert.equal(recorded.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(recorded.request.questions.action.type, 'choice');
  assert.deepEqual(Object.keys(recorded.request.questions.action.criteria), ['workshop', 'exit']);
  assert.equal(result.action, 'workshop'); assert.equal(result.inputTokens, 123);
});
test('SDK errors are not retried and never become game actions', async () => {
  let calls = 0;
  const p = new JevDecisions('jev-1.13.0', 'test-only', { fetch: async () => {
    calls++; return new Response('unavailable', { status: 503 });
  } });
  const result = await run(new DemoAdapter(), p, config);
  assert.equal(result.reason, 'error'); assert.equal(result.steps, 0); assert.equal(calls, 1);
});
test('adapter rejects stale action and safely deduplicates action identifiers', async () => {
  const a = new DemoAdapter();
  await a.execute('workshop', '0', 'unique-action');
  await a.execute('workshop', '0', 'unique-action');
  assert.equal((await a.observe()).revision, '1');
  await assert.rejects(a.execute('hall', '0', 'different-action'), /Stale/);
});
test('real loopback bridge completes the same observe-act cycle', async () => {
  const demo = new DemoAdapter(); const token = 'local-test-token'; const actions = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      if (req.url === '/observe' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await demo.observe())); return;
      }
      if (req.url === '/act' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); actions.push(body);
        await demo.execute(body.action, body.expectedRevision, body.actionId); res.writeHead(204).end(); return;
      }
      res.writeHead(404).end();
    } catch { res.writeHead(409).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const bridge = new BridgeAdapter(`http://127.0.0.1:${server.address().port}`, token);
    const result = await run(bridge, new MockDecisions(), config);
    assert.equal(result.reason, 'won'); assert.equal(actions.length, 5);
    assert.equal(new Set(actions.map(a => a.actionId)).size, 5);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('bad configuration and remote bridge addresses fail closed', () => {
  assert.throws(() => validateConfig({ ...config, maxSteps: NaN }));
  assert.throws(() => validateConfig({ ...config, adapter: 'bridge' }));
  assert.throws(() => new BridgeAdapter('https://example.com', 'token'));
  assert.throws(() => new BridgeAdapter('http://127.0.0.1:8791', ''));
  assert.throws(() => validateObservation({ revision: '1', progressKey: 'x', state: {}, status: 'running', actions: [
    { id: 'same', description: '', facts: {} }, { id: 'same', description: '', facts: {} }
  ] }));
});
test('concurrent demo actions with the same revision have one winner', async () => {
  const a = new DemoAdapter();
  const results = await Promise.allSettled([a.execute('workshop', '0', 'a'), a.execute('exit', '0', 'b')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await a.observe()).revision, '1');
});
test('queued bridge execution is unconfirmed and not retried', async () => {
  const demo = new DemoAdapter(); let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/observe') { res.end(JSON.stringify(await demo.observe())); }
    else { requests++; res.writeHead(202).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await run(new BridgeAdapter(`http://127.0.0.1:${server.address().port}`, 'test'), new MockDecisions(), config);
    assert.equal(result.reason, 'error'); assert.equal(result.steps, 0);
    assert.equal(result.unconfirmedAction.action, 'workshop'); assert.equal(requests, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('report retains uncertain dispatch IDs and escapes observation content', async () => {
  await mkdir('runs', { recursive: true });
  const dir = await mkdtemp(join('runs', 'report-test-'));
  const events = [
    { type: 'start', adapter: 'test', config },
    { type: 'observation', observation: { state: '<script>alert(1)</script>' } },
    { type: 'action_intent', action: 'workshop', actionId: 'uncertain-id' },
    { type: 'summary', reason: 'error', steps: 0, calls: 1, inputTokens: 0, elapsedMs: 1,
      unconfirmedAction: { action: 'workshop', actionId: 'uncertain-id' } }
  ];
  await writeFile(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
  await writeReport(dir);
  const html = await readFile(join(dir, 'report.html'), 'utf8');
  assert.match(html, /Unconfirmed dispatch/); assert.match(html, /uncertain-id/);
  assert.match(html, /action_intent/); assert.doesNotMatch(html, /<script>/);
});
