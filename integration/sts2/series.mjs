// Unattended series: start seeded runs one after another and log one line per finished run.
//   node integration/sts2/series.mjs --seeds JEV21,JEV22 --mode jev_facts_v3 [--label text] [--character IRONCLAD]
//   node integration/sts2/series.mjs --seeds JEV21,JEV22 --arms jev_facts_v3,claude [--label text]
// With --arms every seed is played once per arm and the first arm alternates per seed
// (JEV21: A then B, JEV22: B then A, ...), so both arms see the same games in balanced order.
// Each run is started by start-run.mjs as a child process, which keeps its own checks and its
// record in .private/sts2/series.jsonl. The series waits for start-run's preconditions, never
// presses Autoplay itself, and waits while the runner pauses on its own. It never abandons a run
// or touches the save. `touch .private/sts2/stop-series` stops it after the current run.
// One series at a time: .private/sts2/series.lock holds the pid; --clear-stale-lock removes a
// lock whose process is gone.
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {appendFile,mkdir,open,readFile,rm,stat} from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
export const MODES = ['jev','jev_facts','jev_facts_v3','claude'];
const SEED = /^[A-Za-z0-9]{1,20}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = path => stat(path).then(() => true, () => false);

export function parseArgs(argv) {
 const flags = {};
 for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) throw Error(`Unexpected argument ${argv[i]}`);
  const name = argv[i].slice(2);
  if (name === 'clear-stale-lock') flags[name] = true; else flags[name] = argv[++i];
 }
 const seeds = (flags.seeds ?? '').split(',').map(s => s.trim()).filter(Boolean);
 if (!seeds.length) throw Error('--seeds is required (comma-separated, e.g. JEV21,JEV22).');
 for (const seed of seeds) if (!SEED.test(seed)) throw Error(`Seed ${seed} must be letters and digits, up to 20.`);
 if (flags.mode && flags.arms) throw Error('Give either --mode or --arms, not both.');
 const arms = flags.arms ? flags.arms.split(',').map(s => s.trim()) : flags.mode ? [flags.mode] : [];
 if (!arms.length) throw Error('--mode or --arms is required.');
 if (flags.arms && (arms.length !== 2 || arms[0] === arms[1])) throw Error('--arms takes two different modes, e.g. jev_facts_v3,claude.');
 for (const mode of arms) if (!MODES.includes(mode)) throw Error(`Mode ${mode} must be one of ${MODES.join(', ')}.`);
 return {seeds, arms, label: flags.label ?? null, character: flags.character ?? null, clearStaleLock: Boolean(flags['clear-stale-lock'])};
}

// One run per seed, or with two arms one run per seed and arm, the first arm alternating per seed.
export const planRuns = (seeds, arms) => seeds.flatMap((seed, i) =>
 (arms.length === 2 && i % 2 ? [arms[1], arms[0]] : arms).map(mode => ({seed, mode})));

export function isAlive(pid) {
 try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function acquireLock(path, {clearStale = false} = {}) {
 await mkdir(dirname(path), {recursive: true});
 for (;;) {
  try {
   const handle = await open(path, 'wx');
   await handle.writeFile(JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
   await handle.close();
   return;
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const held = JSON.parse(await readFile(path, 'utf8').catch(() => 'null') || 'null');
  if (held?.pid && isAlive(held.pid)) throw Error(`Another series is running (pid ${held.pid}, started ${held.startedAt}).`);
  if (!clearStale) throw Error(`A series lock remains from pid ${held?.pid ?? 'unknown'} (started ${held?.startedAt ?? 'unknown'}), which is no longer running. Rerun with --clear-stale-lock to remove it.`);
  console.log(`Removing the stale series lock from pid ${held?.pid ?? 'unknown'}.`);
  await rm(path, {force: true}); clearStale = false;
 }
}

export async function releaseLock(path) {
 const held = JSON.parse(await readFile(path, 'utf8').catch(() => 'null') || 'null');
 if (held?.pid === process.pid) await rm(path, {force: true});
}

// Starts one run through start-run.mjs and returns its record (the last JSON line it prints).
export function childStarter(script = resolve(here, 'start-run.mjs'), env = process.env) {
 return ({mode, seed, label, character}) => new Promise((done, fail) => {
  const args = [script, '--mode', mode, '--seed', seed];
  if (label) args.push('--label', label);
  if (character) args.push('--character', character);
  const child = spawn(process.execPath, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
  child.on('error', fail);
  child.on('close', code => {
   const line = out.trim().split('\n').at(-1) ?? '';
   if (code !== 0) return fail(Error(`start-run exited with code ${code}: ${(err.trim().split('\n').find(l => /Error/.test(l)) ?? err.trim()).slice(0, 400)}`));
   try { done(JSON.parse(line)); } catch { fail(Error(`start-run printed no run record: ${line.slice(0, 200)}`)); }
  });
 });
}

async function getJson(url, headers = {}) {
 const response = await fetch(url, {headers, signal: AbortSignal.timeout(10000)});
 const data = await response.json();
 if (!response.ok) throw Error(data.error ?? `HTTP ${response.status}`);
 return data;
}
const optionNames = s => (s.options ?? []).map(o => typeof o === 'string' ? o : o.name);

// The same conditions start-run.mjs checks before touching the menus.
export function readiness(status, game) {
 if (status.mode !== 'paused' || status.pending || status.uncertainAction) return 'Waiting for the runner to be paused with nothing pending.';
 if (game.state_type === 'game_over') return null;
 if (game.state_type !== 'menu' || game.menu_screen !== 'main') return `Waiting for the main or game-over menu (now: ${game.state_type}/${game.menu_screen ?? ''}).`;
 if (optionNames(game).includes('abandon_run') || optionNames(game).includes('continue')) return 'A saved run exists. Finish or abandon it deliberately in the game; the series will not.';
 return null;
}

const resultOf = (message, state) => /victory/i.test(message ?? '') ? 'victory' : /defeat/i.test(message ?? '') || state?.player?.hp <= 0 ? 'defeat' : 'ended (verify in game)';

export async function runSeries(options) {
 const {seeds, arms, label = null, character = null, clearStaleLock = false,
  root = resolve(here, '../..'), dashboard = `http://127.0.0.1:${process.env.PORT ?? 4317}`,
  bridge = 'http://127.0.0.1:15526/api/v1/singleplayer', startRun = childStarter(),
  pollMs = 5000, print = line => console.log(line)} = options;
 const dir = resolve(root, '.private/sts2');
 const lockPath = resolve(dir, 'series.lock'), stopPath = resolve(dir, 'stop-series'), logPath = resolve(dir, 'series-runs.log');
 const say = text => print(`[series ${new Date().toISOString()}] ${text}`);
 await acquireLock(lockPath, {clearStale: clearStaleLock});
 const results = [];
 try {
  const plan = planRuns(seeds, arms);
  say(`${plan.length} run(s): ${plan.map(r => `${r.seed}:${r.mode}`).join(', ')}. Stop after the current run with: touch .private/sts2/stop-series`);
  if (arms.includes('claude')) say('Claude mode: a strategist session must be answering requests (npm run sts2:strategy -- wait | show | answer; brief in docs/STS2-STRATEGIST.md). Starting the series does not start one.');
  let last = '';
  const note = text => { if (text !== last) say(last = text); };
  const status = () => getJson(dashboard + '/api/status');
  const game = () => getJson(bridge);
  for (const [index, {seed, mode}] of plan.entries()) {
   // Wait for start-run's preconditions; the stop file is honored while no run is in progress.
   for (;;) {
    if (await exists(stopPath)) {
     await rm(stopPath, {force: true});
     say(`Stop file found; removed it and stopped before run ${index + 1} of ${plan.length}.`);
     return {results, stopped: true};
    }
    let reason;
    try { reason = readiness(await status(), await game()); }
    catch (error) { reason = `Dashboard or game bridge unavailable: ${error.message}`; }
    if (!reason) break;
    note(reason); await sleep(pollMs);
   }
   say(`Starting run ${index + 1} of ${plan.length}: seed ${seed}, mode ${mode}.`);
   const startedAt = new Date().toISOString();
   let record;
   try { record = await startRun({mode, seed, label, character}); }
   catch (error) { say(`start-run failed, so the series stops here. ${error.message}`); throw error; }
   const run = record.run;
   say(`Run ${run} started; runner ${record.runner ?? 'unknown'}${record.message ? `: ${record.message}` : ''}`);
   last = '';
   // Wait for this run's run_end record. While the runner is paused by itself, print its message
   // and keep waiting; only the operator resumes it.
   let ended = null, lastState = null;
   for (;;) {
    let s = null;
    try { s = await status(); } catch (error) { note(`Dashboard unavailable: ${error.message}`); }
    if (s) {
     if (s.state?.run?.live_id === run) lastState = s.state;
     const end = (s.events ?? []).find(e => e.kind === 'run_end' && (e.state?.run?.live_id ? e.state.run.live_id === run : s.runId === run && e.time >= startedAt));
     if (end) { ended = {state: end.state, result: resultOf(/^Run ended/.test(s.message) ? s.message : '', end.state), source: 'run_end'}; break; }
     if (s.mode === 'paused') {
      // A game-over screen for this run that the runner did not log (the operator finished it by hand).
      let g = null; try { g = await game(); } catch {}
      if (g?.state_type === 'game_over' && g.run?.live_id === run) { ended = {state: g, result: resultOf('', g), source: 'game_over screen, no run_end record'}; break; }
      if (g?.state_type === 'menu' && g.menu_screen === 'main') { ended = {state: lastState, result: 'left without run_end (check the game)', source: 'menu', halt: true}; break; }
      note(`Runner paused: ${s.message ?? '(no message)'} Waiting; the series will not press Autoplay.`);
     } else if (last.startsWith('Runner paused') || last.startsWith('Dashboard')) note('Runner is running again.');
    }
    await sleep(pollMs);
   }
   const act = ended.state?.run?.act ?? lastState?.run?.act ?? '?', floor = ended.state?.run?.floor ?? lastState?.run?.floor ?? '?';
   const line = [new Date().toISOString(), `seed=${seed}`, `mode=${mode}`, `run=${run}`, `result=${ended.result}`, `act=${act}`, `floor=${floor}`, ...(label ? [`label=${JSON.stringify(label)}`] : [])].join(' ');
   await appendFile(logPath, line + '\n');
   print(line);
   results.push({seed, mode, run, result: ended.result, act, floor, source: ended.source});
   last = '';
   if (ended.halt) { say('The run left the game without a run_end record, so the series stops here.'); return {results, stopped: true}; }
  }
  if (await exists(stopPath)) { await rm(stopPath, {force: true}); say('Stop file found after the last run; removed it.'); }
  say(`Series finished: ${results.length} run(s). Next: add them to the progress data and run the rules audit.`);
  return {results, stopped: false};
 } finally { await releaseLock(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 let options;
 try { options = parseArgs(process.argv.slice(2)); }
 catch (error) { console.error(error.message); process.exit(2); }
 const lock = resolve(here, '../../.private/sts2/series.lock');
 // Ctrl+C ends the series only; a run in progress stays under the runner.
 process.once('SIGINT', async () => { await releaseLock(lock); console.log('Series interrupted. A run in progress continues under the runner.'); process.exit(130); });
 try { await runSeries(options); }
 catch (error) { console.error(error.message); process.exitCode = 1; }
}
