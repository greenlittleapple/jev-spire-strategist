// The run_start record: what a run was played under (lab commit, strategy content, policy, model,
// bridge, limits and game setup), logged once per run so progress rows made under different code
// or content can be told apart. Every lookup here returns null on failure; none stops the runner.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
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

// The bridge's root endpoint answers "Hello from STS2 MCP v0.4.0".
export const bridgeVersion = message => String(message ?? '').match(/\bv(\d+(?:\.\d+)+)\b/)?.[1] ?? null;
export async function fetchBridgeVersion(url, timeoutMs = 1500) {
 try { return bridgeVersion((await (await fetch(url, {signal: AbortSignal.timeout(timeoutMs)})).json()).message); } catch { return null; }
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

export function runStartRecord({state, git, policy, decisionMode, model, bridge = null, content = {}, caps, save = null}) {
 return {kind: 'run_start', run: state?.run?.live_id ?? null,
  lab_commit: git?.lab_commit ?? null, lab_dirty: git?.lab_dirty ?? null,
  policy: policy ?? null, decision_mode: decisionMode ?? null, model: model ?? null, bridge,
  content: {playbook: content.playbook ?? null, mechanics: content.mechanics ?? null},
  caps: {max_decisions: caps?.maxDecisions ?? null, max_input_tokens: caps?.maxInputTokens ?? null},
  setup: runSetup(state, save),
  // Where the runner first played the run: act 1 floor 1 for a new run, later if the runner
  // picked up a run already in progress.
  act: state?.run?.act ?? null, floor: state?.run?.floor ?? null};
}
