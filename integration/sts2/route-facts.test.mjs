import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {optionRoutes,remainingRoute,distinctRoutes,computedFacts} from './route-facts.mjs';
import {efficientQuestion} from './efficient-decisions.mjs';
import {replanReason,constrainCandidates,requestStamp,stampPlan,validatePlan} from './strategy.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';

// Row 0 start; two branches; they rejoin at a rest site before the boss.
//        (0,0) Ancient
//        /          \
//   (0,1) Monster   (1,1) Elite
//     |      \         |
//   (0,2) Shop (1,2) Unknown
//        \     /
//        (0,3) RestSite
//          |
//        (0,4) Boss
const node=(col,row,type,children=[])=>({col,row,type,children});
const map={current_position:{col:0,row:0,type:'Ancient'},boss:{col:0,row:4,name:'Boss'},
 nodes:[node(0,0,'Ancient',[[0,1],[1,1]]),node(0,1,'Monster',[[0,2],[1,2]]),node(1,1,'Elite',[[1,2]]),
  node(0,2,'Shop',[[0,3]]),node(1,2,'Unknown',[[0,3]]),node(0,3,'RestSite',[[0,4]]),node(0,4,'Boss')],
 next_options:[{index:0,col:0,row:1,type:'Monster'},{index:1,col:1,row:1,type:'Elite'}]};
const candidates=[
 {id:'a0',label:'Travel to Monster (column 0)',command:{action:'choose_map_node',index:0},details:{index:0,col:0,row:1,type:'Monster'}},
 {id:'a1',label:'Travel to Elite (column 1)',command:{action:'choose_map_node',index:1},details:{index:1,col:1,row:1,type:'Elite'}}];
const run={live_id:'run-1',act:1,floor:1,ascension:0};
const mapState=(hp=80)=>({state_type:'map',run,map,player:{hp,max_hp:80,gold:120,potions:[{name:'Block Potion'}],max_potion_slots:3,relics:[],deck:[]}});
const plan=(extra={})=>({archetype:'x',summary:'x',priorities:[],combat:{risk_tolerance:'low',potion_policy:'x',focus:'x',hallway_potion_below_hp_percent:100},fight:{plan:'',target_priority:[]},
 card_reward:{desired:[],avoid:[],skip_when:''},shop:{gold_reserve:0,priorities:[]},route:'x',route_path:[],elite_min_hp_percent:0,
 rest:'x',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const keys=['0,0','0,1','1,1','0,2','1,2','0,3','0,4'];

test('route summaries count every path to the boss per option',()=>{
 assert.deepEqual(optionRoutes(map,candidates),{
  a0:{paths_to_boss:2,elites:0,rests:1,shops:'0-1',unknowns:'0-1',monsters:1,treasures:0},
  a1:{paths_to_boss:1,elites:1,rests:1,shops:0,unknowns:1,monsters:0,treasures:0}});
 const ahead=remainingRoute(map,{col:0,row:1});
 assert.equal(ahead.paths_to_boss,2);assert.equal(ahead.floors_to_boss,3);assert.equal(ahead.shops,'0-1');
 const routes=distinctRoutes(map,map.current_position);
 assert.deepEqual(routes.routes.map(r=>r.rooms),['M$RB','E?RB','M?RB']);
 assert.deepEqual(routes.routes[1].nodes,['1,1','1,2','0,3','0,4']);
 assert.equal(routes.total_paths,3);
});

test('rest, potion and gold facts use the game\'s own heal amount and the remembered map',()=>{
 const rest={state_type:'rest_site',run,player:{hp:72,max_hp:80,gold:159,potions:[],max_potion_slots:3},
  rest_site:{options:[{id:'HEAL',name:'Rest',description:'Heal for 30% of your Max HP (24).'},{id:'SMITH',name:'Smith'}]}};
 const facts=computedFacts(rest,[],{runId:'run-1',act:1,map,position:{col:0,row:1}});
 assert.deepEqual(facts.rest,{missing_hp:8,rest_heals:24,heal_wasted:16});
 assert.deepEqual(facts.gold,{gold:159,shops_ahead_this_act:'0-1'});
 assert.equal(facts.potions.floors_to_boss,3);
 assert.equal(computedFacts(rest,[],{runId:'other',act:1,map,position:{col:0,row:1}}).route_ahead,undefined,'another run\'s map is ignored');
});

test('Jev receives facts only in the facts policy',()=>{
 const s=mapState(),facts=computedFacts(s,candidates,null);
 assert.ok(facts.route_options.a1);
 const withFacts=efficientQuestion(s,candidates,{},null,facts),without=efficientQuestion(s,candidates,{});
 assert.equal(withFacts.state.policy,'jev-compact-v2');assert.equal(without.state.policy,'jev-compact-v1');
 assert.deepEqual(withFacts.state.computed_facts.route_options,facts.route_options);
 assert.equal(without.state.computed_facts,undefined);
 assert.match(withFacts.questions.move.instructions,/computed_facts/);
 assert.doesNotMatch(without.questions.move.instructions,/computed_facts/);
});

test('the first map screen of an act asks for a route; the route then constrains map moves',()=>{
 const s=mapState(),before=stampPlan(plan(),requestStamp({...s,state_type:'event'},[],'run_start'));
 assert.equal(replanReason(s,before,candidates),'route_plan');
 const routed=stampPlan(plan({route_path:['1,1','1,2','0,3']}),requestStamp(s,candidates,'route_plan',keys));
 assert.equal(routed.route_act,1);
 const next={...s,run:{...run,floor:2}};
 assert.equal(replanReason(next,routed,candidates),null);
 const c=constrainCandidates(next,candidates,routed);
 assert.deepEqual(c.candidates.map(x=>x.id),['a1']);assert.equal(c.constraint.kind,'route');
 assert.equal(constrainCandidates(next,candidates,routed,'advisory').candidates.length,2);
 assert.equal(replanReason(next,{...routed,route_path:['9,9']},candidates),'route_off');
 const risky={...routed,elite_min_hp_percent:60};
 assert.equal(replanReason({...next,player:{...next.player,hp:40}},risky,candidates),'route_risk');
 assert.equal(replanReason({...next,player:{...next.player,hp:70}},risky,candidates),null);
});

test('route plans are validated against the act map',()=>{
 assert.deepEqual(validatePlan(plan({route_path:['1,1']})),[]);
 assert.match(validatePlan(plan({route_path:['a-b']})).join(),/col,row/);
 assert.match(validatePlan(plan({elite_min_hp_percent:120})).join(),/0-100/);
});

test('strategy mode sends the route list and a single routed option moves without Jev',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-route-'));
 try{
  const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
  status.plan=stampPlan(plan(),requestStamp({...mapState(),state_type:'event'},[],'run_start'));
  let seen;
  const answer=(async()=>{for(;;){const r=await channel.current();if(r){seen=r;await channel.answer(r.id,plan({route_path:['1,1','1,2','0,3']}));return;}await new Promise(x=>setTimeout(x,50));}})();
  const result=await hierarchicalDeliberate({state:mapState(),candidates,strategist:{channel,status},ask:()=>assert.fail('route move needs no Jev call')});
  await answer;
  assert.equal(seen.stamp.reason,'route_plan');
  assert.deepEqual(seen.brief.routes.routes.map(r=>r.rooms),['M$RB','E?RB','M?RB']);
  assert.ok(seen.brief.facts.route_options);
  assert.deepEqual(seen.stamp.route_nodes,keys);
  assert.equal(result.decisionSource,'claude');assert.equal(result.answers.move.choice,'a1');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the facts policy passes facts to Jev without a strategist',async()=>{
 let request;
 await hierarchicalDeliberate({state:mapState(),candidates,withFacts:true,
  ask:async q=>{request=q;return {model:'t',answers:{move:{type:'choice',choice:'a1',confidence:.9,probabilities:{a1:.9}}},usage:{input_tokens:1,output_tokens:1}};}});
 assert.equal(request.state.policy,'jev-compact-v2');assert.ok(request.state.computed_facts.route_options);
});

test('kill-cost facts put on-death damage against current HP',()=>{
 const giant=(hp,amount)=>({state_type:'boss',run,player:{hp,max_hp:80,potions:[]},battle:{round:9,enemies:[
  {name:'Waterfall Giant',hp:59,max_hp:240,status:[{name:'Steam Eruption',amount,description:`When killed, deals ${amount} damage at the end of your next turn.`}]},
  {name:'Minion',hp:5,max_hp:5,status:[{name:'Rage',description:'Gains Strength.'}]},
  {name:'Eye with Teeth',hp:20,max_hp:20,status:[{name:'Revive',description:'When this dies, it revives next turn at full HP.'}]}]}});
 const k=computedFacts(giant(27,36),[],null).death_effects;
 assert.deepEqual(k.effects.map(e=>[e.enemy,e.damage]),[['Waterfall Giant',36]]);
 assert.equal(k.known_damage_total,36);assert.equal(k.exceeds_current_hp,true);
 assert.equal(computedFacts(giant(65,21),[],null).death_effects.exceeds_current_hp,false);
 const dead=giant(27,36);dead.battle.enemies[0].hp=999999999;
 assert.equal(computedFacts(dead,[],null).death_effects,undefined,'placeholder HP after death is ignored');
});

test('v3 route facts are order-aware and exclude the rest before the boss',async()=>{
 const {orderedOptionRoutes}=await import('./route-facts.mjs');
 assert.deepEqual(orderedOptionRoutes(map,candidates),{
  a0:{paths_to_boss:2,elites:0,max_elites_with_rest_before:0,rests_before_boss_rest:0,next_rest_in:3,next_elite_in:null,shops:'0-1',shop_in:2,example_routes:['M$R']},
  a1:{paths_to_boss:1,elites:1,max_elites_with_rest_before:0,rests_before_boss_rest:0,next_rest_in:3,next_elite_in:1,shops:0,shop_in:null,example_routes:['E?R']}});
 // A rest before an elite is credited; the pre-boss rest is not.
 const m2={...map,nodes:[node(0,0,'Ancient',[[0,1]]),node(0,1,'RestSite',[[0,2]]),node(0,2,'Elite',[[0,3]]),node(0,3,'RestSite',[[0,4]]),node(0,4,'Boss')]};
 const c2=[{id:'a0',command:{action:'choose_map_node',index:0},details:{col:0,row:1,type:'RestSite'}}];
 const r=orderedOptionRoutes(m2,c2).a0;
 assert.equal(r.max_elites_with_rest_before,1);assert.equal(r.rests_before_boss_rest,1);assert.equal(r.next_rest_in,1);assert.equal(r.next_elite_in,2);
});

test('v2 facts are unchanged; v3 is used only when requested and labels its policy',async()=>{
 const s=mapState();
 assert.deepEqual(computedFacts(s,candidates,null).route_options,optionRoutes(map,candidates));
 assert.equal(computedFacts(s,candidates,null).route_note,undefined);
 const v3=computedFacts(s,candidates,null,{version:3});
 assert.ok(v3.route_options.a1.example_routes);assert.match(v3.route_note,/right before its boss/);
 let request;
 await hierarchicalDeliberate({state:s,candidates,factsVersion:3,
  ask:async q=>{request=q;return {model:'t',answers:{move:{type:'choice',choice:'a1',confidence:.9,probabilities:{a1:.9}}},usage:{input_tokens:1,output_tokens:1}};}});
 assert.equal(request.state.policy,'jev-compact-v3.1');assert.ok(request.state.computed_facts.route_options.a0.example_routes);
});

test('a consult off the map does not count as having seen the act routes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-route-'));
 try{
  const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
  // The act's opening event: the map is loaded but the player is not on it yet.
  const {current_position,...offMap}=map;
  const event={...mapState(),state_type:'event',map:offMap};
  const answer=(async()=>{for(;;){const r=await channel.current();if(r){await channel.answer(r.id,plan());return r;}await new Promise(x=>setTimeout(x,50));}})();
  await hierarchicalDeliberate({state:event,candidates:[{id:'a0',command:{action:'choose_event_option',index:0},label:'A'},{id:'a1',command:{action:'choose_event_option',index:1},label:'B'}],
   strategist:{channel,status},ask:async()=>({answers:{move:{type:'choice',choice:'a0',confidence:0.9}},usage:{input_tokens:1}})});
  const seen=await answer;
  assert.equal(seen.brief.routes,undefined);assert.deepEqual(seen.stamp.route_nodes,[]);
  assert.equal(status.plan.route_act,null);
  assert.equal(replanReason(mapState(),status.plan,candidates),'route_plan','the first map screen still asks for a route');
 }finally{await rm(dir,{recursive:true,force:true});}
});
