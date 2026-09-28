// Start a new single-player run from the main or game-over menu and hand it to the
// paused runner in a chosen decision mode. Records the run in .private/sts2/series.jsonl.
//   node integration/sts2/start-run.mjs --mode jev_facts_v3 [--seed ABC123] [--character IRONCLAD] [--label name]
// A seed uses the game's custom mode (no modifiers are selected); without one it is a standard run.
// It never abandons a run in progress.
import {appendFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BRIDGE = 'http://127.0.0.1:15526/api/v1/singleplayer';
const DASH = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
const MODES = ['jev','jev_facts','jev_facts_v3','claude'];
const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const mode = arg('mode'), seed = arg('seed'), character = arg('character') ?? 'IRONCLAD', label = arg('label') ?? null;
if (!MODES.includes(mode)) throw Error(`--mode must be one of ${MODES.join(', ')}`);
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
await select(seed ? 'custom' : 'standard', {}, 3000);
s = await game();
if (s.menu_screen !== 'character_select') throw Error(`Expected character select, got ${s.menu_screen}: ${JSON.stringify(optionNames(s))}`);
await select(character);
await select('embark', seed ? {seed} : {}, 8000);
s = await game();
if (!s.run?.live_id || s.run.floor > 1) throw Error(`Run did not start cleanly: ${JSON.stringify(s.run)}`);
await dash(`/api/mode/${mode}`, true);
// The first Autoplay acknowledges the new run identity; the second starts play.
for (let i = 0; i < 3 && (await dash('/api/status')).mode !== 'running'; i++) { await dash('/api/run', true); await sleep(6000); }
const after = await dash('/api/status');
const record = {time:new Date().toISOString(), run:s.run.live_id, mode, seed:seed ?? null, custom:Boolean(seed), character, ascension:s.run.ascension, label};
await mkdir(resolve(root, '.private/sts2'), {recursive:true});
await appendFile(resolve(root, '.private/sts2/series.jsonl'), JSON.stringify(record) + '\n');
console.log(JSON.stringify({...record, runner:after.mode, message:after.message}));
