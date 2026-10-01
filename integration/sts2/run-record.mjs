// The run_start record: what a run was played under (lab commit, strategy content, policy, model,
// bridge, limits and game setup), logged once per run so progress rows made under different code
// or content can be told apart. Every lookup here returns null on failure; none stops the runner.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {characterName} from './character.mjs';

// The lab checkout's commit and whether it has uncommitted changes. docs/ is left out of the dirty
// check: the progress chart data there is regenerated between runs and does not change play.
export function labGit(dir) {
 const git = args => execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true}).trim();
 let lab_commit = null, lab_dirty = null;
 try { lab_commit = git(['rev-parse', 'HEAD']); } catch { return {lab_commit, lab_dirty}; }
 if (!/^[0-9a-f]{40}$/.test(lab_commit)) return {lab_commit: null, lab_dirty};
 try { lab_dirty = git(['status', '--porcelain', '--', '.', ':(exclude)docs']).length > 0; } catch {}
 return {lab_commit, lab_dirty};
}

export async function fileSha256(path) {
 try { return createHash('sha256').update(await readFile(path)).digest('hex'); } catch { return null; }
}

// The bridge's root endpoint. Since 0.4.0-jev.1 it answers {message, status, version, build, game}:
// the lab's bridge version, the source commit the DLL was built from, and the game's release version.
// Older builds answer only "Hello from STS2 MCP v0.4.0", so version comes from the message and
// build and game are null.
export const bridgeVersion = message => String(message ?? '').match(/\bv(\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?)(?![0-9A-Za-z.-])/)?.[1] ?? null;
const text = value => typeof value === 'string' && value ? value : null;
export function bridgeIdentity(greeting) {
 const version = text(greeting?.version) ?? bridgeVersion(greeting?.message);
 return version ? {version, build: text(greeting?.build), game: text(greeting?.game)} : null;
}
export async function fetchBridgeVersion(url, timeoutMs = 1500) {
 try { return bridgeIdentity(await (await fetch(url, {signal: AbortSignal.timeout(timeoutMs)})).json()); } catch { return null; }
}

// The enabled gameplay mods from the game's settings.save, read at each run start since the mod list
// can change between runs. The profile folder under steam/ is named by the Steam ID, which must stay
// out of the log, so only mod IDs and their hash are returned. With several profiles the most recently
// written settings.save is used.
const settingsBase = () => process.env.APPDATA ? join(process.env.APPDATA, 'SlayTheSpire2', 'steam') : null;
export async function enabledMods(base = settingsBase()) {
 try {
  let newest = null;
  for (const d of await readdir(base, {withFileTypes: true})) {
   if (!d.isDirectory()) continue;
   const file = join(base, d.name, 'settings.save'), mtime = (await stat(file).catch(() => null))?.mtimeMs;
   if (mtime != null && !(newest?.mtime >= mtime)) newest = {file, mtime};
  }
  const list = newest && JSON.parse((await readFile(newest.file, 'utf8')).replace(/^\uFEFF/, ''))?.mod_settings?.mod_list;
  if (!Array.isArray(list)) return null;
  const mods = [...new Set(list.filter(m => m?.is_enabled === true && typeof m.id === 'string').map(m => m.id))].sort();
  return {mods, mods_hash: createHash('sha256').update(mods.join('\n')).digest('hex').slice(0, 12)};
 } catch { return null; }
}

// Game setup from the live state and the raw save. The character comes from the save's
// character_id, since a skin mod can replace the displayed title; the seed is the save's rng seed.
export function runSetup(state, save) {
 const saved = state?.saved_run ?? {}, players = save?.players;
 const modifiers = saved.modifiers ?? save?.modifiers;
 return {
  character: Array.isArray(players) && players.length === 1 ? characterName(players[0].character_id) : null,
  ascension: saved.ascension ?? state?.run?.ascension ?? null,
  modifiers: Array.isArray(modifiers) ? modifiers.map(m => m?.id ?? m) : null,
  game_mode: saved.game_mode ?? save?.game_mode ?? null,
  seed: save?.rng?.seed ?? null,
 };
}

export function runStartRecord({state, git, policy, decisionMode, model, bridge = null, content = {}, caps, save = null, mods = null}) {
 return {kind: 'run_start', run: state?.run?.live_id ?? null,
  lab_commit: git?.lab_commit ?? null, lab_dirty: git?.lab_dirty ?? null,
  policy: policy ?? null, decision_mode: decisionMode ?? null, model: model ?? null, bridge,
  content: {playbook: content.playbook ?? null, mechanics: content.mechanics ?? null},
  caps: {max_decisions: caps?.maxDecisions ?? null, max_input_tokens: caps?.maxInputTokens ?? null},
  setup: runSetup(state, save), mods: mods?.mods ?? null, mods_hash: mods?.mods_hash ?? null,
  // Where the runner first played the run: act 1 floor 1 for a new run, later if the runner
  // picked up a run already in progress.
  act: state?.run?.act ?? null, floor: state?.run?.floor ?? null};
}
