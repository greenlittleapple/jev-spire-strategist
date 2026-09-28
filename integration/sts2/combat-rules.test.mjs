import {test} from 'node:test';
import assert from 'node:assert/strict';
import {combatConstraints,constrainCandidates,validatePlan} from './strategy.mjs';

const enemy=(entity_id,name,hp,status=[])=>({entity_id,name,hp,max_hp:100,status});
const fight=({type='monster',hp=60,enemies=[enemy('a','Leader',50)]}={})=>({state_type:type,run:{live_id:'run',act:1,floor:5},
 player:{hp,max_hp:80},battle:{round:2,enemies}});
const cand=(id,command,forecast={},plan)=>({id,label:id,command,forecast:{quality:'partial',survives:true,defeatedEnemies:[],...forecast},...(plan?{plan}:{})});
const ids=r=>r.candidates.map(c=>c.id);
const plan=combat=>({run_id:'run',combat:{risk_tolerance:'low',potion_policy:'',focus:'',hallway_potion_below_hp_percent:100,focus_enemy:'',...combat}});

test('plays forecast to be fatal are removed only when another play survives',()=>{
 const cands=[cand('defend',{action:'play_card',card_index:0},{survives:false}),cand('beckon',{action:'play_card',card_index:1}),cand('end',{action:'end_turn'},{survives:false})];
 const r=combatConstraints(fight({type:'boss'}),cands,null);
 assert.deepEqual(ids(r),['beckon']);assert.equal(r.rules[0].kind,'avoid_fatal');
 const allDie=cands.map(c=>({...c,forecast:{...c.forecast,survives:false}}));
 assert.equal(combatConstraints(fight(),allDie,null).candidates.length,3,'nothing is removed when every play dies');
 const unknown=[cand('x',{action:'play_card',card_index:0},{survives:false}),cand('y',{action:'play_card',card_index:1},{survives:null,quality:'unknown'})];
 assert.equal(combatConstraints(fight(),unknown,null).candidates.length,2,'an unknown forecast is not a survivor');
});

test('hallway potions wait until HP falls below the plan floor, unless everything else dies',()=>{
 const cands=[cand('potion',{action:'use_potion',slot:0}),cand('later',{action:'play_card',card_index:0},{},[{command:{action:'play_card',card_index:0}},{command:{action:'use_potion',slot:0}}]),cand('strike',{action:'play_card',card_index:1})];
 const p=plan({hallway_potion_below_hp_percent:50});
 assert.deepEqual(ids(combatConstraints(fight({hp:60}),cands,p)),['strike']);
 assert.equal(combatConstraints(fight({hp:30}),cands,p).candidates.length,3,'below the floor');
 assert.equal(combatConstraints(fight({type:'elite',hp:80}),cands,p).candidates.length,3,'elites and bosses are unaffected');
 const desperate=[cands[0],cand('strike',{action:'play_card',card_index:1},{survives:false})];
 assert.deepEqual(ids(combatConstraints(fight({hp:60}),desperate,p)),['potion'],'the fatal rule keeps the surviving potion');
 assert.equal(combatConstraints(fight({hp:60}),cands,plan({})).candidates.length,3,'100 means no limit');
});

test('focus enemy removes single-target plays at others unless they kill',()=>{
 const enemies=[enemy('q','Queen',300),enemy('m','Torch Head Amalgam',150,[{name:'Minion'}]),enemy('s','Small Minion',5,[{name:'Minion'}])];
 const cands=[cand('hitQueen',{action:'play_card',card_index:0,target:'q'}),cand('hitMinion',{action:'play_card',card_index:1,target:'m'}),
  cand('killSmall',{action:'play_card',card_index:2,target:'s'},{defeatedEnemies:[{id:'s'}]}),cand('aoe',{action:'play_card',card_index:3}),cand('end',{action:'end_turn'})];
 const r=combatConstraints(fight({type:'boss',enemies}),cands,plan({focus_enemy:'queen'}));
 assert.deepEqual(ids(r),['hitQueen','killSmall','aoe','end']);assert.equal(r.rules[0].enemy,'Queen');
 const gone=[enemy('q','Queen',0),enemies[1]];
 assert.equal(combatConstraints(fight({type:'boss',enemies:gone}),cands,plan({focus_enemy:'queen'})).candidates.length,5,'no focus once it is dead');
});

test('combat rules apply only in constrained mode for the plan run, and plans validate the floor',()=>{
 const cands=[cand('potion',{action:'use_potion',slot:0}),cand('strike',{action:'play_card',card_index:1})];
 const p=plan({hallway_potion_below_hp_percent:50});
 assert.equal(constrainCandidates(fight(),cands,p).constraint.kind,'combat');
 assert.equal(constrainCandidates(fight(),cands,p,'advisory').candidates.length,2);
 assert.equal(constrainCandidates(fight(),cands,{...p,run_id:'other'}).candidates.length,2);
 const full={archetype:'x',summary:'x',priorities:[],combat:{...p.combat,hallway_potion_below_hp_percent:120},card_reward:{desired:[],avoid:[],skip_when:''},
  shop:{gold_reserve:0,priorities:[]},route:'',route_path:[],elite_min_hp_percent:0,rest:'',replan_below_hp_percent:25,allowed_option_ids:[],option_note:''};
 assert.match(validatePlan(full).join(),/hallway_potion_below_hp_percent must be 0-100/);
});
