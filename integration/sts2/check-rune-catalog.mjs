import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {actionsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {efficientQuestion} from './efficient-decisions.mjs';

// Read-only coverage audit against the loaded registry. No inference or moves.
const catalog=process.argv[2]?JSON.parse(await readFile(process.argv[2],'utf8')):await(await fetch('http://127.0.0.1:15526/api/v1/hextech',{signal:AbortSignal.timeout(30000)})).json();
assert.equal(catalog.available,true);
const base={state_type:'monster',player:{hp:50,max_hp:80,energy:3,block:0,status:[],relics:[],potions:[],deck:[],
  hand:[{index:0,name:'Strike',type:'Attack',cost:'1',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'}]},
  battle:{turn:'player',is_play_phase:true,enemies:[{entity_id:'e',name:'Enemy',hp:30,max_hp:30,block:0,status:[],intents:[]}]}};
const counts={};
for(const group of ['runes','forges','enemy_hexes']){
  assert.ok(catalog[group]?.length>0,`${group} registry missing`);
  for(const item of catalog[group]){
    assert.ok(item.id && item.name && item.description,`Missing identity/rules for ${item.type??item.id}`);
    const state=structuredClone(base);
    const effect={...item,source_mod:'HextechRunes'};
    if(group==='enemy_hexes')state.hextech={available:true,active_enemy_hexes:[{...effect,strength_tier:2}]};
    else state.player.relics=[effect];
    const legal=actionsFor(state), candidates=decisionCandidates(state);
    for(const action of legal)assert.ok(candidates.some(c=>JSON.stringify(c.command)===JSON.stringify(action.command)),`Missing action for ${item.id}`);
    const request=efficientQuestion(state,candidates);
    assert.equal(request.state.hextech_runes.runes[0].rule,item.description);
    assert.match(request.questions.move.instructions,/Hextech rune rules/);
  }
  counts[group]=catalog[group].length;
}
const report={checkedAt:new Date().toISOString(),catalog_source:process.argv[2]??'Live installed game registry',counts,total:Object.values(counts).reduce((a,b)=>a+b,0),
  result:'All registered descriptions reach the compacted decision request and retain legal actions.',
  limitation:'This is catalog/rule-routing coverage, not an in-game simulation test of every effect.'};
await mkdir('.private/verification',{recursive:true});
await writeFile('.private/verification/hextech-coverage.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
