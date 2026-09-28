import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// A saved run is a room checkpoint, never an executable combat observation.
export function checkpointSummary(data, context) {
  if (!data || !Array.isArray(data.players) || !Number.isInteger(data.ascension)
      || !Number.isFinite(data.start_time)) throw Error('Unsupported STS2 save schema');
  if (context.start_time != null && data.start_time !== context.start_time)
    throw Error('Active run and saved checkpoint do not match');
  const stripIdentifiers = value => Array.isArray(value) ? value.map(stripIdentifiers)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['net_id', 'unique_id', 'platform_id', 'steam_id'].includes(key))
      .map(([key, item]) => [key, stripIdentifiers(item)])) : value;
  return {
    run_id: `${context.save_scope}:profile${context.profile_id}:${data.start_time}`,
    source: 'Active profile current_run.save; saved room checkpoint, not the live turn',
    ascension: data.ascension, current_act_index: data.current_act_index,
    start_time: data.start_time, save_time: data.save_time,
    schema_version: data.schema_version, game_mode: data.game_mode,
    visited_map_coords: data.visited_map_coords ?? [],
    events_seen: data.events_seen ?? [], modifiers: (data.modifiers ?? []).map(modifier=>({id:modifier.id})),
    map_point_history: stripIdentifiers(data.map_point_history ?? []),
    // Current deck, HP, relics and potions come from the live bridge, not this snapshot.
    limitation: 'Use live player, battle, room and map fields for all actions. Hidden RNG, future draws and unrevealed rooms are not supplied to Jev.',
  };
}

export async function readActiveCheckpoint(context, saveRoot) {
  if (!context?.is_in_progress) return { available: false, reason: 'No active run' };
  if (!context.save_path) return { available: false, reason: 'Active run has no saved checkpoint yet' };
  const root = await realpath(saveRoot);
  const file = await realpath(context.save_path);
  const rel = relative(root, file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')
      || basename(file) !== 'current_run.save') throw Error('Checkpoint is outside the STS2 save directory');
  const before = await stat(file);
  if (!before.isFile() || before.size > 4 * 1024 * 1024) throw Error('Invalid checkpoint size');
  const bytes = await readFile(file);
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('Checkpoint changed while reading');
  const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  return { available: true, path: file, sha256: createHash('sha256').update(bytes).digest('hex'),
    checkpoint: checkpointSummary(data, context), data };
}

export function attachCheckpoint(state, saved) {
  if (!state.run || !saved?.available) return state;
  const checkpoint = saved.checkpoint;
  // Hextech opens its act-start modal before the new act checkpoint is written.
  // The previous act's history is safe only for this modal and the exact same run.
  const priorActAtRuneSelection = state.state_type === 'hextech_rune'
    && state.run.act === checkpoint.current_act_index + 2;
  if (!state.run.live_id || state.run.live_id !== checkpoint.run_id
      || state.run.ascension !== checkpoint.ascension
      || (state.run.act !== checkpoint.current_act_index + 1 && !priorActAtRuneSelection))
    throw Error('Saved checkpoint does not match the live run; waiting for a fresh save');
  return { ...state, saved_run: { ...checkpoint,
    freshness: priorActAtRuneSelection ? 'Previous act checkpoint during Hextech rune selection; use live act and options' : 'Current act checkpoint' } };
}

export const defaultSaveRoot = () => resolve(process.env.APPDATA ?? '', 'SlayTheSpire2');
