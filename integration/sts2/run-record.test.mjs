import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile, mkdir, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {labGit, fileSha256, bridgeVersion, bridgeIdentity, fetchBridgeVersion, runSetup, runStartRecord, enabledMods} from './run-record.mjs';

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

const withGreeting = async (body, fn) => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/`); } finally { await new Promise(r => server.close(r)); }
};

test('bridge version is read from the root greeting message', () => {
  assert.equal(bridgeVersion('Hello from STS2 MCP v0.4.0'), '0.4.0');
  assert.equal(bridgeVersion('Hello from STS2 MCP v0.4.0-jev.1'), '0.4.0-jev.1');
  assert.equal(bridgeVersion(undefined), null);
  assert.equal(bridgeVersion('Hello'), null);
});

test('bridge identity: version, build and game from the new greeting', async () => {
  const build = '0123456789abcdef0123456789abcdef01234567';
  const greeting = {message: 'Hello from STS2 MCP v0.4.0-jev.1', status: 'ok', version: '0.4.0-jev.1', build, game: 'v0.111.0'};
  assert.deepEqual(await withGreeting(greeting, fetchBridgeVersion), {version: '0.4.0-jev.1', build, game: 'v0.111.0'});
  // A build without git information or a game without release_info.json sends explicit nulls.
  assert.deepEqual(await withGreeting({...greeting, build: null, game: null}, fetchBridgeVersion), {version: '0.4.0-jev.1', build: null, game: null});
  assert.deepEqual(bridgeIdentity({version: '0.4.0-jev.2', message: 'Hello from STS2 MCP v0.4.0-jev.1'}), {version: '0.4.0-jev.2', build: null, game: null});
});

test('bridge identity: the old greeting gives its version with null build and game; failures give null', async () => {
  assert.deepEqual(await withGreeting({message: 'Hello from STS2 MCP v0.4.0', status: 'ok'}, fetchBridgeVersion), {version: '0.4.0', build: null, game: null});
  assert.equal(await withGreeting({status: 'ok'}, fetchBridgeVersion), null);
  assert.equal(await withGreeting([], fetchBridgeVersion), null);
  assert.equal(bridgeIdentity(null), null);
  // A closed port answers at once; nothing listens on port 1.
  assert.equal(await fetchBridgeVersion('http://127.0.0.1:1/', 500), null);
});

test('run_start carries the commit, content, policy, caps and setup under fixed field names', () => {
  const state = {state_type: 'map', run: {live_id: 'r1', act: 1, floor: 1, ascension: 0},
    player: {character: 'Skin Title'},
    saved_run: {ascension: 0, game_mode: 'custom', modifiers: [{id: 'MOD.X'}]}};
  const save = {players: [{character_id: 'CHARACTER.IRONCLAD'}], rng: {seed: 'ABC123'}, game_mode: 'custom'};
  const record = runStartRecord({state, git: {lab_commit: 'f'.repeat(40), lab_dirty: false}, policy: 'claude-strategy-v3',
    decisionMode: 'claude', model: 'jev-1.13.0', bridge: {version: '0.4.0-jev.1', build: null, game: 'v0.111.0'}, content: {playbook: 'aa', mechanics: null},
    caps: {maxDecisions: 2000, maxInputTokens: 30000000}, save, mods: {mods: ['BaseLib'], mods_hash: 'abc'}});
  assert.deepEqual(record, {kind: 'run_start', run: 'r1', lab_commit: 'f'.repeat(40), lab_dirty: false,
    policy: 'claude-strategy-v3', decision_mode: 'claude', model: 'jev-1.13.0', bridge: {version: '0.4.0-jev.1', build: null, game: 'v0.111.0'},
    content: {playbook: 'aa', mechanics: null}, caps: {max_decisions: 2000, max_input_tokens: 30000000},
    setup: {character: 'Ironclad', ascension: 0, modifiers: ['MOD.X'], game_mode: 'custom', seed: 'ABC123'},
    mods: ['BaseLib'], mods_hash: 'abc', act: 1, floor: 1});
  // Without a save the setup falls back to the live run where it can, never to the displayed title.
  const bare = runStartRecord({state: {run: {live_id: 'r2', ascension: 0}}, git: {lab_commit: null, lab_dirty: null}});
  assert.deepEqual(bare.setup, {character: null, ascension: 0, modifiers: null, game_mode: null, seed: null});
  assert.equal(bare.mods, null);
  assert.deepEqual(runSetup(null, null), {character: null, ascension: null, modifiers: null, game_mode: null, seed: null});
});

test('enabled mods come from the newest profile settings.save, sorted, with no profile folder name; failures give null', async () => {
  const base = await mkdtemp(join(tmpdir(), 'run-record-mods-'));
  const profile = async (name, list, time) => {
    await mkdir(join(base, name));
    await writeFile(join(base, name, 'settings.save'), typeof list === 'string' ? list : JSON.stringify({mod_settings: {mod_list: list}}));
    await utimes(join(base, name, 'settings.save'), time, time);
  };
  try {
    assert.equal(await enabledMods(base), null);
    await profile('11111111111111111', [{id: 'Old', is_enabled: true}], 1000);
    await profile('22222222222222222', [{id: 'Zeta', is_enabled: true, source: 'steam_workshop'}, {id: 'HornetMod', is_enabled: false},
      {id: 'BaseLib', is_enabled: true}, {id: 'BaseLib', is_enabled: true, source: 'local'}, {is_enabled: true}], 2000);
    const mods = await enabledMods(base);
    assert.deepEqual(mods.mods, ['BaseLib', 'Zeta']);
    assert.match(mods.mods_hash, /^[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(mods), /2222|1111/);
    // The hash changes with the mod set and not with the order the file lists it in.
    await profile('33333333333333333', [{id: 'Zeta', is_enabled: true}, {id: 'BaseLib', is_enabled: true}], 3000);
    assert.equal((await enabledMods(base)).mods_hash, mods.mods_hash);
    await profile('44444444444444444', [{id: 'BaseLib', is_enabled: true}], 4000);
    assert.notEqual((await enabledMods(base)).mods_hash, mods.mods_hash);
    await profile('55555555555555555', '{not json', 5000);
    assert.equal(await enabledMods(base), null);
    await profile('66666666666666666', '﻿' + JSON.stringify({mod_settings: {mod_list: [{id: 'A', is_enabled: true}]}}), 6000);
    assert.deepEqual((await enabledMods(base)).mods, ['A']);
    assert.equal(await enabledMods(join(base, 'missing')), null);
    assert.equal(await enabledMods(null), null);
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('the runner logs run_start once per run before its first decision, and start-run records the commit', async () => {
  const server = await readFile(join(root, 'vendor/jev-the-spire/spire-demo/server.mjs'), 'utf8');
  // The record is built, its seed noted for the strategist's seed boundary, then logged.
  const start = server.indexOf('const startRecord = runStartRecord(');
  assert.ok(server.indexOf('await log(startRecord);', start) > start, 'the built record is logged');
  assert.ok(start > 0, 'server.mjs logs a run_start record');
  assert.ok(server.indexOf("kind: 'decision'", start) > start, 'run_start is logged before the decision record in step()');
  assert.match(server, /view\.runStartFor !== s\.run\.live_id/);
  assert.match(await readFile(join(root, 'integration/sts2/start-run.mjs'), 'utf8'), /\.\.\.labGit\(root\)/);
});
