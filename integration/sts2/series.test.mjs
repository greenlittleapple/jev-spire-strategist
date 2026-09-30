import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs,planRuns,readiness,acquireLock,childStarter,runSeries} from './series.mjs';

const exists = p => stat(p).then(() => true, () => false);
const menu = {state_type:'menu', menu_screen:'main', options:['singleplayer','settings']};

// One fake HTTP server stands in for both the dashboard and the game bridge.
async function fakeWorld() {
 const w = {status:{mode:'paused', pending:null, uncertainAction:null, message:'Ready.', events:[]}, game:{...menu}, posts:[], statusReads:0, onStatus:null};
 const server = createServer((req, res) => {
  const send = body => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };
  if (req.method === 'POST') { w.posts.push(req.url); return send({ok:true}); }
  if (req.url === '/api/status') { w.statusReads++; w.onStatus?.(w); return send(w.status); }
  if (req.url === '/api/v1/singleplayer') return send(w.game);
  res.writeHead(404); res.end('{}');
 });
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 const base = `http://127.0.0.1:${server.address().port}`;
 const root = await mkdtemp(join(tmpdir(), 'sts2-series-'));
 w.options = {root, dashboard: base, bridge: base + '/api/v1/singleplayer', pollMs: 5};
 w.close = async () => { server.close(); await rm(root, {recursive: true, force: true}); };
 w.lines = []; w.options.print = line => w.lines.push(line);
 return w;
}
// Starts a run in the fake world the way start-run leaves it: game on floor 1, runner running.
function starter(w, {endAfter = 2, runner = 'running', message = 'Autoplay enabled', onStart} = {}) {
 let n = 0;
 return async ({mode, seed}) => {
  const run = `r${++n}`, s = {state_type:'map', run:{live_id:run, act:1, floor:1}, player:{hp:80}};
  w.game = s; Object.assign(w.status, {mode:runner, message, state:s, runId:run, events:[]});
  let reads = 0;
  w.onStatus = world => {
   if (world.status.mode !== 'running' || ++reads < endAfter) return;
   const end = {state_type:'game_over', run:{live_id:run, act:1, floor:17}, player:{hp:0}};
   Object.assign(world.status, {mode:'paused', message:'Run ended in defeat.', state:end, events:[{kind:'run_end', time:new Date().toISOString(), state:end}]});
   world.game = end; world.onStatus = null;
  };
  onStart?.(run);
  return {run, mode, seed, runner, message};
 };
}

test('arguments: seeds and one mode, or two arms that alternate their order per seed', () => {
 assert.deepEqual(parseArgs(['--seeds','JEV21,JEV22','--mode','claude']).arms, ['claude']);
 assert.throws(() => parseArgs(['--seeds','JEV21','--mode','claude','--arms','jev,claude']), /either --mode or --arms/);
 assert.throws(() => parseArgs(['--seeds','JEV-21','--mode','jev']), /letters and digits/);
 assert.throws(() => parseArgs(['--seeds','A1','--mode','nope']), /must be one of/);
 assert.deepEqual(planRuns(['A','B','C'], ['jev','claude']).map(r => `${r.seed}:${r.mode}`), ['A:jev','A:claude','B:claude','B:jev','C:jev','C:claude']);
 assert.deepEqual(planRuns(['A','B'], ['jev']).map(r => `${r.seed}:${r.mode}`), ['A:jev','B:jev']);
});

test('readiness mirrors start-run: paused runner, main or game-over menu, no saved run', () => {
 const paused = {mode:'paused'};
 assert.equal(readiness(paused, menu), null);
 assert.equal(readiness(paused, {state_type:'game_over'}), null);
 assert.match(readiness({mode:'running'}, menu), /paused/);
 assert.match(readiness({mode:'paused', pending:{}}, menu), /nothing pending/);
 assert.match(readiness(paused, {...menu, options:['continue','abandon_run']}), /saved run exists/);
 assert.match(readiness(paused, {state_type:'combat'}), /main or game-over/);
});

test('a two-seed series starts each run after the previous one ends and logs one line per run', async () => {
 const w = await fakeWorld();
 try {
  w.game = {...menu, options:['continue']}; // a saved run at first: the series waits
  const started = [];
  const start = starter(w, {onStart: run => started.push(run)});
  const waitThenClear = setTimeout(() => { w.game = {...menu}; }, 40);
  const {results, stopped} = await runSeries({...w.options, seeds:['JEV21','JEV22'], arms:['jev_facts_v3'], label:'test series', startRun:async a => start(a)});
  clearTimeout(waitThenClear);
  assert.equal(stopped, false);
  assert.deepEqual(results.map(r => [r.seed, r.mode, r.run, r.result, r.act, r.floor]), [['JEV21','jev_facts_v3','r1','defeat',1,17], ['JEV22','jev_facts_v3','r2','defeat',1,17]]);
  const log = (await readFile(join(w.options.root, '.private/sts2/series-runs.log'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 2);
  assert.match(log[0], /seed=JEV21 mode=jev_facts_v3 run=r1 result=defeat act=1 floor=17 label="test series"$/);
  assert.ok(w.lines.some(l => /saved run exists/.test(l)));
  assert.deepEqual(w.posts, []);
  assert.equal(await exists(join(w.options.root, '.private/sts2/series.lock')), false);
 } finally { await w.close(); }
});

test('the stop file ends the series after the current run and is removed', async () => {
 const w = await fakeWorld();
 try {
  const stopFile = join(w.options.root, '.private/sts2/stop-series');
  const start = starter(w, {onStart: () => writeFile(stopFile, '')});
  await mkdir(join(w.options.root, '.private/sts2'), {recursive: true});
  const {results, stopped} = await runSeries({...w.options, seeds:['JEV21','JEV22','JEV23'], arms:['jev','claude'], startRun:start});
  assert.equal(stopped, true);
  assert.deepEqual(results.map(r => `${r.seed}:${r.mode}`), ['JEV21:jev']);
  assert.equal(await exists(stopFile), false);
  assert.ok(w.lines.some(l => /Stop file found; removed it and stopped before run 2 of 6/.test(l)));
  assert.ok(w.lines.some(l => /strategist session must be answering/.test(l)));
 } finally { await w.close(); }
});

test('a runner that pauses by itself is waited on, never resumed by the series', async () => {
 const w = await fakeWorld();
 try {
  const start = starter(w, {runner:'paused', message:'Action timed out. Inspect the game and acknowledge it before resuming.'});
  let pausedReads = 0;
  const run = async a => {
   const record = await start(a); w.status.uncertainAction = {action:'play_card'};
   const ending = w.onStatus;
   // The operator acknowledges and resumes after a while; the run then ends normally.
   w.onStatus = world => {
    if (world.status.mode === 'paused' && ++pausedReads === 6) Object.assign(world.status, {mode:'running', uncertainAction:null, message:'Autoplay enabled'});
    if (world.status.mode === 'running') ending(world);
   };
   return record;
  };
  const {results} = await runSeries({...w.options, seeds:['JEV21'], arms:['jev'], startRun:run});
  assert.equal(results[0].result, 'defeat');
  assert.ok(pausedReads >= 6);
  assert.equal(w.lines.filter(l => /Runner paused: Action timed out/.test(l)).length, 1);
  assert.ok(w.lines.some(l => /Runner is running again/.test(l)));
  assert.deepEqual(w.posts, []);
 } finally { await w.close(); }
});

test('one series at a time: a live lock refuses, a stale one is reported and cleared only on request', async () => {
 const root = await mkdtemp(join(tmpdir(), 'sts2-lock-'));
 try {
  const lock = join(root, 'series.lock');
  await writeFile(lock, JSON.stringify({pid: process.pid, startedAt: 'earlier'}));
  await assert.rejects(acquireLock(lock, {clearStale: true}), /Another series is running \(pid \d+/);
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(lock, JSON.stringify({pid: gone, startedAt: 'earlier'}));
  await assert.rejects(acquireLock(lock), /no longer running. Rerun with --clear-stale-lock/);
  await acquireLock(lock, {clearStale: true});
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
 } finally { await rm(root, {recursive: true, force: true}); }
});

test('the child starter passes the run arguments to start-run and reads its record', async () => {
 const root = await mkdtemp(join(tmpdir(), 'sts2-child-'));
 try {
  const script = join(root, 'stub.mjs');
  await writeFile(script, "const a=process.argv.slice(2);if(a.includes('FAIL'))throw Error('Start from the main menu');console.log('menu');console.log(JSON.stringify({run:'r9',args:a}));");
  const record = await childStarter(script)({mode:'claude', seed:'JEV21', label:'v3', character:null});
  assert.deepEqual(record, {run:'r9', args:['--mode','claude','--seed','JEV21','--label','v3']});
  await assert.rejects(childStarter(script)({mode:'jev', seed:'FAIL'}), /start-run exited with code 1: .*Start from the main menu/);
 } finally { await rm(root, {recursive: true, force: true}); }
});

test('a run that leaves the game without a run_end record is logged and stops the series', async () => {
 const w = await fakeWorld();
 try {
  const start = starter(w, {runner:'paused', message:'Unknown screen; paused.'});
  const run = async a => { const r = await start(a); let reads = 0; w.onStatus = () => { if (++reads === 3) w.game = {...menu}; }; return r; };
  const {results, stopped} = await runSeries({...w.options, seeds:['JEV21','JEV22'], arms:['jev'], startRun:run});
  assert.equal(stopped, true);
  assert.deepEqual(results.map(r => [r.run, r.result, r.floor]), [['r1', 'left without run_end (check the game)', 1]]);
  assert.deepEqual(w.posts, []);
 } finally { await w.close(); }
});
