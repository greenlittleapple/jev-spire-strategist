import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {labGit, fileSha256, bridgeVersion, fetchBridgeVersion, runSetup, runStartRecord} from './run-record.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('lab commit comes from git, and is null outside a checkout', async () => {
  const here = labGit(root);
  assert.match(here.lab_commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof here.lab_dirty, 'boolean');
  const dir = await mkdtemp(join(tmpdir(), 'run-record-'));
  try {
    // A temporary folder may sit inside some other checkout; only a missing repository must give nulls.
    const outside = labGit(join(dir, 'missing'));
    assert.deepEqual(outside, {lab_commit: null, lab_dirty: null});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('content hashes are SHA-256 of the file, null when absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'run-record-'));
  try {
    await writeFile(join(dir, 'playbook.json'), '{"a":1}');
    assert.equal(await fileSha256(join(dir, 'playbook.json')), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
    assert.equal(await fileSha256(join(dir, 'mechanics.json')), null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('bridge version is read from the root greeting, null on failure', async () => {
  assert.equal(bridgeVersion('Hello from STS2 MCP v0.4.0'), '0.4.0');
  assert.equal(bridgeVersion(undefined), null);
  assert.equal(bridgeVersion('Hello'), null);
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({message: 'Hello from STS2 MCP v0.4.0', status: 'ok'})); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await fetchBridgeVersion(`http://127.0.0.1:${server.address().port}/`), '0.4.0');
  } finally { await new Promise(r => server.close(r)); }
  // A closed port answers at once; nothing listens on port 1.
  assert.equal(await fetchBridgeVersion('http://127.0.0.1:1/', 500), null);
});

test('run_start carries the commit, content, policy, caps and setup under fixed field names', () => {
  const state = {state_type: 'map', run: {live_id: 'r1', act: 1, floor: 1, ascension: 0},
    player: {character: 'Skin Title'},
    saved_run: {ascension: 0, game_mode: 'custom', modifiers: [{id: 'MOD.X'}]}};
  const save = {players: [{character_id: 'CHARACTER.IRONCLAD'}], rng: {seed: 'ABC123'}, game_mode: 'custom'};
  const record = runStartRecord({state, git: {lab_commit: 'f'.repeat(40), lab_dirty: false}, policy: 'claude-strategy-v3',
    decisionMode: 'claude', model: 'jev-1.13.0', bridge: '0.4.0', content: {playbook: 'aa', mechanics: null},
    caps: {maxDecisions: 2000, maxInputTokens: 30000000}, save});
  assert.deepEqual(record, {kind: 'run_start', run: 'r1', lab_commit: 'f'.repeat(40), lab_dirty: false,
    policy: 'claude-strategy-v3', decision_mode: 'claude', model: 'jev-1.13.0', bridge: '0.4.0',
    content: {playbook: 'aa', mechanics: null}, caps: {max_decisions: 2000, max_input_tokens: 30000000},
    setup: {character: 'Ironclad', ascension: 0, modifiers: ['MOD.X'], game_mode: 'custom', seed: 'ABC123'},
    act: 1, floor: 1});
  // Without a save the setup falls back to the live run where it can, never to the displayed title.
  const bare = runStartRecord({state: {run: {live_id: 'r2', ascension: 0}}, git: {lab_commit: null, lab_dirty: null}});
  assert.deepEqual(bare.setup, {character: null, ascension: 0, modifiers: null, game_mode: null, seed: null});
  assert.deepEqual(runSetup(null, null), {character: null, ascension: null, modifiers: null, game_mode: null, seed: null});
});

test('the runner logs run_start once per run before its first decision, and start-run records the commit', async () => {
  const server = await readFile(join(root, 'vendor/jev-the-spire/spire-demo/server.mjs'), 'utf8');
  const start = server.indexOf('await log(runStartRecord(');
  assert.ok(start > 0, 'server.mjs logs a run_start record');
  assert.ok(server.indexOf("kind: 'decision'", start) > start, 'run_start is logged before the decision record in step()');
  assert.match(server, /view\.runStartFor !== s\.run\.live_id/);
  assert.match(await readFile(join(root, 'integration/sts2/start-run.mjs'), 'utf8'), /\.\.\.labGit\(root\)/);
});
