// Start a new single-player run from the main or game-over menu and hand it to the
// paused runner in a chosen decision mode. Records the run in .private/sts2/series.jsonl.
//   node integration/sts2/start-run.mjs --mode jev_facts_v3 --seed ABC123 [--character IRONCLAD] [--label name] [--replay-from RUN]
// --replay-from takes the non-combat choices of an earlier run on the same seed wherever the
// game offers exactly the same options (integration/sts2/replay.mjs); combat is never replayed.
// Seeds are required so decision modes can be compared on identical games. Runs use the
// game's custom mode and are refused unless it shows ascension 0 and no modifiers.
// It never abandons a run in progress. The record also carries the lab commit (lab_commit, lab_dirty).
import {appendFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {labGit} from './run-record.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BRIDGE = 'http://127.0.0.1:15526/api/v1/singleplayer';
const DASH = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
const MODES = ['jev','jev_facts','jev_facts_v3','claude'];
const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const mode = arg('mode'), seed = arg('seed'), character = arg('character') ?? 'IRONCLAD', label = arg('label') ?? null, replayFrom = arg('replay-from') ?? null;
if (!MODES.includes(mode)) throw Error(`--mode must be one of ${MODES.join(', ')}`);
if (!seed || !/^[A-Za-z0-9]{1,20}$/.test(seed)) throw Error('--seed is required (letters and digits, up to 20).');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function game(command) {
 const response = await fetch(BRIDGE, command ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(command)} : {});
 const data = await response.json();
 if (!response.ok || data.status === 'error' || data.error) throw Error(`Game: ${data.error ?? data.message ?? response.status}`);
 return data;
}
async function dash(path, post=false) {
 const response = await fetch(DASH + path, {method: post ? 'POST' : 'GET', headers: post ? {'X-Spire-Control':'1'} : {}});
 const data = await response.json();
 if (!response.ok) throw Error(`Dashboard ${path}: ${data.error ?? response.status}`);
 return data;
}
async function select(option, extra={}, wait=2500) { const r = await game({action:'menu_select', option, ...extra}); await sleep(wait); return r; }
const optionNames = s => (s.options ?? []).map(o => typeof o === 'string' ? o : o.name);

const status = await dash('/api/status');
if (status.mode !== 'paused' || status.pending || status.uncertainAction) throw Error('Pause the runner and let pending work finish first.');
let s = await game();
if (s.state_type === 'game_over') { await select('main_menu', {}, 4000); s = await game(); }
if (s.state_type !== 'menu' || s.menu_screen !== 'main') throw Error(`Start from the main menu (now: ${s.state_type}/${s.menu_screen ?? ''}).`);
if (optionNames(s).includes('abandon_run') || optionNames(s).includes('continue')) throw Error('A saved run exists. Finish or abandon it deliberately first.');
await select('singleplayer');
await select('custom', {}, 3000);
s = await game();
if (s.menu_screen !== 'custom_run') throw Error(`Expected the custom run screen, got ${s.menu_screen}. Is the custom-run bridge installed?`);
if (s.custom_run.modifiers.length) throw Error(`Custom run has modifiers selected: ${s.custom_run.modifiers.join(', ')}. Clear them in the game.`);
if (s.custom_run.ascension !== 0) throw Error(`Custom run ascension is ${s.custom_run.ascension}; set it to 0 in the game.`);
await select(character);
const embark = await select('embark', {seed}, 8000);
if (embark.seed?.toUpperCase() !== seed.toUpperCase()) throw Error(`Bridge did not confirm the seed: ${JSON.stringify(embark)}`);
s = await game();
if (!s.run?.live_id || s.run.floor > 1) throw Error(`Run did not start cleanly: ${JSON.stringify(s.run)}`);
// Replay applies only to this new run; without the flag any earlier replay is cleared.
const replayPath = resolve(root, '.private/sts2/replay.json');
if (replayFrom) await writeFile(replayPath, JSON.stringify({source_run: replayFrom, target_run: s.run.live_id}));
else await rm(replayPath, {force: true});
await dash(`/api/mode/${mode}`, true);
// The first Autoplay acknowledges the new run identity; the second starts play.
for (let i = 0; i < 3 && (await dash('/api/status')).mode !== 'running'; i++) { await dash('/api/run', true); await sleep(6000); }
const after = await dash('/api/status');
const record = {time:new Date().toISOString(), run:s.run.live_id, mode, seed:embark.seed, custom:true, character, ascension:s.run.ascension, label, replay_from:replayFrom, ...labGit(root)};
await mkdir(resolve(root, '.private/sts2'), {recursive:true});
await appendFile(resolve(root, '.private/sts2/series.jsonl'), JSON.stringify(record) + '\n');
console.log(JSON.stringify({...record, runner:after.mode, message:after.message}));
