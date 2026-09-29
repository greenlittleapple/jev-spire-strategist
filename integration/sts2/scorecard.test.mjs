import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreRuns} from './scorecard.mjs';

const state=(floor,type,extra={})=>({state_type:type,run:{live_id:'r1',act:1,floor,ascension:0},
 player:{character:'Ironclad',hp:60,max_hp:80,gold:200,relics:[{},{}],potions:[{}]},saved_run:{modifiers:floor===1?[]:[{id:'MODIFIER.X'}]},...extra});
const decision=(s,label,action='x',usage=100)=>({kind:'decision',outcome:'executed',time:'t',state:s,policy:'jev-compact-v1',
 chosen:{label,command:{action}},usage:{input_tokens:usage},deliberation:{request_usage:[{input_tokens:usage}]}});
const boss=(round,hp)=>state(17,'boss',{battle:{round,enemies:[{name:'Boss',hp,max_hp:200},{name:'Add',hp:10,max_hp:20}]}});

test('scorecard reports boss progress, elite choices, hallway potions and a non-empty modifier',()=>{
 const map=state(5,'map',{map:{next_options:[{type:'Elite'},{type:'Monster'}]}});
 const [s]=scoreRuns([
  decision(state(1,'event'),'Start'),
  decision(state(3,'monster'),'Potion',"use_potion"),
  decision(map,'Travel to Monster'),
  decision(boss(1,200),'Strike'),decision(boss(4,50),'Strike'),
  {kind:'run_end',time:'t',state:{...boss(4,50),state_type:'game_over',player:{hp:0,relics:[],gold:9}}}]);
 assert.equal(s.modifiers,'X');assert.equal(s.result,'lost');
 assert.deepEqual(s.bosses.map(b=>[b.name,b.hp_removed_pct,b.killed,b.rounds]),[['Boss',75,false,4]]);
 assert.equal(s.elite_choices_offered,1);assert.equal(s.elite_choices_taken,0);
 assert.equal(s.potions_used_outside_elites_bosses,1);assert.equal(s.input_tokens,500);
});

test('a boss counts as killed when the run reaches a later floor',()=>{
 const [s]=scoreRuns([decision(boss(3,120),'Strike'),decision(state(18,'event'),'Go')]);
 assert.equal(s.bosses[0].killed,true);assert.equal(s.bosses[0].hp_removed_pct,100);
});

test('a run that reaches The Architect after the final boss is a win although it ends at 0 HP',()=>{
 const end={kind:'run_end',time:'t',state:{...state(48,'game_over'),player:{hp:0,relics:[],gold:9}}};
 const [won]=scoreRuns([decision(state(48,'rewards'),'Continue'),decision(state(48,'event',{event:{event_id:'THE_ARCHITECT'}}),'Proceed'),end]);
 assert.equal(won.result,'won');
 const [lost]=scoreRuns([decision(state(48,'boss',{battle:{round:3,enemies:[{name:'Boss',hp:50,max_hp:200}]}}),'Strike'),end]);
 assert.equal(lost.result,'lost');
});
