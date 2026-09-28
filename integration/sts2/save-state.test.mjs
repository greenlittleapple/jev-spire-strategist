import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkpointSummary, readActiveCheckpoint, attachCheckpoint } from './save-state.mjs';

const save = { schema_version:20, start_time:123, ascension:0, current_act_index:0,
  players:[{current_hp:80, net_id:'private'}], rng:{seed:'hidden'},modifiers:[{id:'HEXTECH',props:{future_rolls:'hidden-mod-data'}}],
  map_point_history:[[{players:[{net_id:'private',damage_taken:3}]}]] };
const context = { is_in_progress:true, start_time:123, save_scope:'modded', profile_id:1 };
test('saved checkpoint supplies history without substituting stale combat or revealing RNG', () => {
  const checkpoint = checkpointSummary(save, context);
  assert.equal(checkpoint.run_id, 'modded:profile1:123');
  assert.equal(JSON.stringify(checkpoint).includes('private'), false);
  assert.equal(checkpoint.rng, undefined);
  assert.deepEqual(checkpoint.modifiers,[{id:'HEXTECH'}]);
  const live = {run:{ascension:0,act:1,live_id:'modded:profile1:123'},player:{hp:42,hand:[{name:'Bash'}]},battle:{round:3}};
  const joined = attachCheckpoint(live, {available:true,checkpoint});
  assert.equal(joined.player.hp, 42);
  assert.equal(joined.battle.round, 3);
  assert.equal(joined.saved_run.map_point_history[0][0].players[0].damage_taken,3);
});
test('cross-run and wrong-act checkpoints fail closed', () => {
  assert.throws(() => checkpointSummary(save, {...context,start_time:999}), /do not match/);
  assert.throws(() => attachCheckpoint({run:{ascension:10,act:1}},
    {available:true,checkpoint:checkpointSummary(save,context)}), /does not match/);
  assert.throws(() => checkpointSummary({},context), /schema/);
  assert.throws(() => attachCheckpoint({run:{ascension:0,act:1,live_id:'modded:profile1:999'}},
    {available:true,checkpoint:checkpointSummary(save,context)}), /does not match/);
  assert.throws(() => attachCheckpoint({run:{ascension:0,act:2,live_id:'modded:profile1:123'}},
    {available:true,checkpoint:checkpointSummary(save,context)}), /does not match/);
});
test('Hextech act-start modal accepts only the same run one act behind', () => {
  const saved = {available:true,checkpoint:checkpointSummary(save,context)};
  const live = {state_type:'hextech_rune',run:{ascension:0,act:2,live_id:'modded:profile1:123'},
    hextech_rune:{options:[{id:'rune:0'}]},player:{hp:83}};
  const joined = attachCheckpoint(live,saved);
  assert.equal(joined.run.act,2);
  assert.equal(joined.saved_run.current_act_index,0);
  assert.match(joined.saved_run.freshness,/Previous act/);
  assert.strictEqual(joined.hextech_rune,live.hextech_rune);
  for (const patch of [{act:3},{ascension:10},{live_id:'modded:profile1:999'}])
    assert.throws(()=>attachCheckpoint({...live,run:{...live.run,...patch}},saved),/does not match/);
  assert.throws(()=>attachCheckpoint({...live,state_type:'monster'},saved),/does not match/);
});
test('reads the entire active save and rejects paths outside the game saves', async () => {
  const root = await mkdtemp(join(tmpdir(),'jev-save-'));
  try {
    await mkdir(join(root,'inside'));
    const file = join(root,'inside','current_run.save');
    await writeFile(file,JSON.stringify(save));
    const read = await readActiveCheckpoint({...context,save_path:file},join(root,'inside'));
    assert.deepEqual(read.data,save);
    assert.match(read.sha256,/^[a-f0-9]{64}$/);
    await assert.rejects(readActiveCheckpoint({...context,save_path:file},join(root,'inside','..','outside')),/ENOENT/);
    await mkdir(join(root,'outside'));
    await assert.rejects(readActiveCheckpoint({...context,save_path:file},join(root,'outside')),/outside/);
    assert.equal((await readActiveCheckpoint(null,root)).available,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
