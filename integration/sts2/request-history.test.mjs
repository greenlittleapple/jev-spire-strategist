import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compactRequest} from '../../vendor/jev-the-spire/spire-demo/compact-request.mjs';

test('history compaction preserves every floor, unknown mod field and falsy value without changing live state',()=>{
 const history=Array.from({length:50},(_,floor)=>({map_point_type:'monster',player_stats:[{current_hp:80-floor,gold_spent:0,was_picked:false,mod_rule:{s:7,v:[null,0,false,''],unknown:'kept'}}],rooms:[{model_id:'ENCOUNTER.EXAMPLE',turns_taken:3}]}));
 const payload={state:{state:{saved_run:{map_point_history:history},player:{hand:[{id:'live:0'}]},hextech:{active_enemy_hexes:[{description:'Exact rule'}]}}},questions:{move:{criteria:{play:null,end:null}}}};
 const result=compactRequest(payload),encoded=result.state.state.saved_run.map_point_history;
 const decode=value=>{
  if(Array.isArray(value))return value.map(decode);
  if(!value||typeof value!=='object')return value;
  const [schema]=Object.keys(value);
  return Object.fromEntries(encoded.schemas[Number(schema.slice(1))].map((key,i)=>[key,decode(value[schema][i])]));
 };
 assert.deepEqual(decode(encoded.acts),history);
 assert.ok(JSON.stringify(encoded).length<JSON.stringify(history).length);
 assert.deepEqual(result.state.state.player,payload.state.state.player);
 assert.deepEqual(result.state.state.hextech,payload.state.state.hextech);
 assert.deepEqual(Object.keys(result.questions.move.criteria),['play','end']);
 assert.ok(Array.isArray(payload.state.state.saved_run.map_point_history));
 assert.deepEqual(compactRequest(result),result);
});
