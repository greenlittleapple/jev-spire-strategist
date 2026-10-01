import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {optionRoutes,orderedOptionRoutes,remainingRoute,distinctRoutes,computedFacts,withEliteChains,mapNodeKeys,eliteReadiness,rememberMap,travelledTo,currentMap} from './route-facts.mjs';
import {efficientQuestion,isForcedChoice} from './efficient-decisions.mjs';
import {replanReason,constrainCandidates,requestStamp,stampPlan,validatePlan,routeRisk,screenKey,strategistBrief,ELITE_CHAIN_MARGIN,STRATEGIST_INSTRUCTIONS} from './strategy.mjs';
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
// Two potions and no saved history: elite readiness is ready, so route_risk here is the HP check alone.
const mapState=(hp=80)=>({state_type:'map',run,map,player:{hp,max_hp:80,gold:120,potions:[{name:'Block Potion'},{name:'Fire Potion'}],max_potion_slots:3,relics:[],deck:[]}});
const plan=(extra={})=>({archetype:'x',summary:'x',priorities:[],combat:{risk_tolerance:'low',potion_policy:'x',focus:'x',hallway_potion_below_hp_percent:100,potion_reserve:0},fight:{plan:'',target_priority:[]},
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

test('at low HP, a route whose next node commits to an avoidable elite asks again',()=>{
 // The monster leads only to an elite; the shop reaches the rest site without one.
 const m={current_position:{col:0,row:0,type:'Ancient'},boss:{col:0,row:4,name:'Boss'},
  nodes:[node(0,0,'Ancient',[[0,1],[1,1]]),node(0,1,'Monster',[[0,2]]),node(1,1,'Shop',[[1,2]]),
   node(0,2,'Elite',[[0,3]]),node(1,2,'Unknown',[[0,3]]),node(0,3,'RestSite',[[0,4]]),node(0,4,'Boss')]};
 const opts=[
  {id:'a0',label:'Travel to Monster (column 0)',command:{action:'choose_map_node',index:0},details:{index:0,col:0,row:1,type:'Monster'}},
  {id:'a1',label:'Travel to Shop (column 1)',command:{action:'choose_map_node',index:1},details:{index:1,col:1,row:1,type:'Shop'}}];
 const at=hp=>({...mapState(hp),map:m,run:{...run,floor:2}});
 const routed=path=>({...stampPlan(plan({route_path:path}),requestStamp({...mapState(),map:m},opts,'route_plan',['0,0','0,1','1,1','0,2','1,2','0,3','0,4'])),elite_min_hp_percent:60});
 assert.equal(replanReason(at(40),routed(['0,1','0,2','0,3']),opts),'route_risk');
 assert.equal(replanReason(at(70),routed(['0,1','0,2','0,3']),opts),null,'HP at or above the threshold');
 assert.equal(replanReason(at(40),routed(['1,1','1,2','0,3']),opts),null,'the route avoids the elite');
 assert.equal(replanReason(at(40),{...routed(['0,1','0,2','0,3']),elite_min_hp_percent:0},opts),null,'0 turns it off');
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
  a0:{paths_to_boss:2,elites:0,max_elites_with_rest_before:0,min_elites_before_first_rest:0,rests_before_boss_rest:0,next_rest_in:3,next_elite_in:null,shops:'0-1',shop_in:2,example_routes:['M$R']},
  a1:{paths_to_boss:1,elites:1,max_elites_with_rest_before:0,min_elites_before_first_rest:1,rests_before_boss_rest:0,next_rest_in:3,next_elite_in:1,shops:0,shop_in:null,example_routes:['E?R']}});
 // A rest before an elite is credited; the pre-boss rest is not.
 const m2={...map,nodes:[node(0,0,'Ancient',[[0,1]]),node(0,1,'RestSite',[[0,2]]),node(0,2,'Elite',[[0,3]]),node(0,3,'RestSite',[[0,4]]),node(0,4,'Boss')]};
 const c2=[{id:'a0',command:{action:'choose_map_node',index:0},details:{col:0,row:1,type:'RestSite'}}];
 const r=orderedOptionRoutes(m2,c2).a0;
 assert.equal(r.max_elites_with_rest_before,1);assert.equal(r.rests_before_boss_rest,1);assert.equal(r.next_rest_in,1);assert.equal(r.next_elite_in,2);
 // The rest comes first, so the elite is avoidable before resting.
 assert.equal(r.min_elites_before_first_rest,0);
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
 assert.equal(request.state.policy,'jev-compact-v3.3');assert.ok(request.state.computed_facts.route_options.a0.example_routes);
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
  assert.equal(seen.brief.routes,undefined);assert.equal(seen.stamp.route_act,null);
  assert.equal(status.plan.route_act,null);
  assert.equal(replanReason(mapState(),status.plan,candidates),'route_plan','the first map screen still asks for a route');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a consult without routes keeps the route already chosen for this act',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-route-'));
 try{
  const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
  status.plan=stampPlan(plan({route_path:['1,1','1,2','0,3']}),requestStamp(mapState(),candidates,'route_plan',keys));
  const {current_position,...offMap}=map;
  const event={...mapState(),state_type:'event',map:offMap};
  const answer=(async()=>{for(;;){const r=await channel.current();if(r){await channel.answer(r.id,plan({route_path:['1,1','1,2','0,3']}));return r;}await new Promise(x=>setTimeout(x,50));}})();
  await hierarchicalDeliberate({state:event,candidates:[{id:'a0',command:{action:'choose_event_option',index:0},label:'A'},{id:'a1',command:{action:'choose_event_option',index:1},label:'B'}],
   strategist:{channel,status},ask:async()=>({answers:{move:{type:'choice',choice:'a0',confidence:0.9}},usage:{input_tokens:1}})});
  const seen=await answer;
  assert.equal(seen.brief.routes,undefined);assert.equal(seen.stamp.route_act,run.act);
  assert.equal(status.plan.route_act,run.act);
  assert.notEqual(replanReason(mapState(),status.plan,candidates),'route_plan','no new route request');
 }finally{await rm(dir,{recursive:true,force:true});}
});

// JEV22 (Strategist v3.17), floor 8 at the rest site on row 7: an elite on row 8 (floor 9) leads
// through a treasure to a second elite on row 10 (floor 11) with no rest site between them.
const jev22Map=(between='Treasure')=>({current_position:{col:4,row:7,type:'RestSite'},boss:{col:3,row:13,name:'Boss'},
 nodes:[node(4,7,'RestSite',[[4,8],[5,8]]),node(4,8,'Elite',between==='fork'?[[4,9],[3,9]]:[[4,9]]),node(5,8,'Unknown',[[5,9]]),
  node(4,9,'Treasure',[[3,10]]),node(3,9,'RestSite',[[3,10]]),node(5,9,'Monster',[[5,10]]),node(3,10,'Elite',[[3,11]]),node(5,10,'Monster',[[5,11]]),
  node(3,11,'Monster',[[3,12]]),node(5,11,'Monster',[[3,12]]),node(3,12,'RestSite',[[3,13]]),node(3,13,'Boss')],
 next_options:[{index:0,col:4,row:8,type:'Elite'},{index:1,col:5,row:8,type:'Unknown'}]});
const jev22Options=[
 {id:'a0',label:'Travel to Elite (column 4)',command:{action:'choose_map_node',index:0},details:{index:0,col:4,row:8,type:'Elite'}},
 {id:'a1',label:'Travel to Unknown (column 5)',command:{action:'choose_map_node',index:1},details:{index:1,col:5,row:8,type:'Unknown'}}];
const jev22Path=['4,8','4,9','3,10','3,11','3,12'];
const jev22State=(hp,m=jev22Map())=>({...mapState(hp),map:m,run:{...run,floor:8}});
const jev22Plan=(extra={})=>({...stampPlan(plan({route_path:jev22Path}),requestStamp({...jev22State(80),run:{...run,floor:1}},jev22Options,'route_plan',mapNodeKeys(jev22Map()))),elite_min_hp_percent:55,...extra});

test('strategist routes list elite chains by floor, with floor = map row + the act offset',()=>{
 const routes=withEliteChains(distinctRoutes(jev22Map(),{col:4,row:7}),8);
 assert.equal(routes.floor_offset,1,'Act 1: Neow is floor 1 on row 0, so row 8 is floor 9');
 const chained=routes.routes.find(r=>r.rooms.startsWith('ETE'));
 assert.deepEqual(chained.elite_chains,[[9,11]]);
 assert.equal(routes.routes.find(r=>r.rooms.startsWith('?')).elite_chains,undefined,'routes without a chain carry no field');
 assert.match(routes.elite_chain_note,/no rest site between/);
 // Act 2 starts at floor 18 on row 0: the same rows are floors 26 and 28.
 assert.deepEqual(withEliteChains(distinctRoutes(jev22Map(),{col:4,row:7}),25).routes.find(r=>r.rooms.startsWith('ETE')).elite_chains,[[26,28]]);
 // A rest site between the elites breaks the chain; three elites in a row are two chains.
 const m={current_position:{col:0,row:0},nodes:[node(0,0,'Ancient',[[0,1]]),node(0,1,'Elite',[[0,2]]),node(0,2,'RestSite',[[0,3]]),node(0,3,'Elite',[[0,4]]),
  node(0,4,'Elite',[[0,5]]),node(0,5,'Shop',[[0,6]]),node(0,6,'Elite',[[0,7]]),node(0,7,'Boss')]};
 assert.deepEqual(withEliteChains(distinctRoutes(m,m.current_position),1).routes[0].elite_chains,[[4,5],[5,7]]);
 assert.equal(withEliteChains(null,1),null);
});

test('route_risk asks at a branch that commits to an elite chain unless HP covers one elite fight more',()=>{
 const p=jev22Plan();
 // JEV22: 61/80 (76%) with elite_min_hp_percent 55; the old check needed HP below 55.
 assert.equal(replanReason(jev22State(61),p,jev22Options),'route_risk');
 const risk=routeRisk(jev22State(61),p,jev22Options);
 assert.equal(risk.kind,'elite_chain');assert.equal(risk.needs_hp_percent,55+ELITE_CHAIN_MARGIN);
 assert.deepEqual(risk.elite_chain,{floors:[9,11],nodes:['4,8','3,10'],rooms_between:'T'});
 assert.deepEqual(risk.next,[{option:'a0',node:'4,8',type:'Elite',floor:9}]);
 assert.equal(replanReason(jev22State(66),p,jev22Options),null,'83% is at least 55 + 26');
 assert.equal(replanReason(jev22State(61),{...p,elite_min_hp_percent:0},jev22Options),null,'0 turns it off');
 assert.equal(replanReason(jev22State(61),{...p,elite_min_hp_percent:40},jev22Options),null,'a lowered minimum keeps the route');
 assert.equal(replanReason(jev22State(61),{...p,route_path:['5,8','5,9','5,10']},jev22Options),null,'the route avoids the chain');
 // A rest site reachable between the elites: the branch does not commit to the chain.
 assert.equal(replanReason(jev22State(61,jev22Map('fork')),p,jev22Options),null);
 // Below the minimum the elite check applies and still reports the chain.
 const low=routeRisk(jev22State(40),p,jev22Options);
 assert.equal(low.kind,'elite');assert.deepEqual(low.elite_chain.floors,[9,11]);
 // The answer's own screen does not ask again.
 assert.equal(replanReason(jev22State(61),{...p,screen:screenKey(jev22State(61))},jev22Options),null);
});

test('route_risk never fires on a single-option map move',()=>{
 // After the floor-9 elite JEV22 had one option on each move (treasure, then the elite) at 45% HP.
 const p=jev22Plan(),m=jev22Map();
 const one={...jev22State(36,{...m,current_position:{col:4,row:9,type:'Treasure'},next_options:[{index:0,col:3,row:10,type:'Elite'}]}),run:{...run,floor:10}};
 const only=[{id:'a0',label:'Travel to Elite (column 3)',command:{action:'choose_map_node',index:0},details:{index:0,col:3,row:10,type:'Elite'}}];
 assert.equal(routeRisk(one,p,only),null);assert.equal(replanReason(one,p,only),null);
 assert.equal(replanReason(jev22State(61),p,[jev22Options[0]]),null,'a branch point needs two map options');
 assert.equal(isForcedChoice(one,only),true,'the runner does not evaluate triggers for it at all');
});

test('route_risk briefs carry the chain; Jev-only requests are unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-route-'));
 try{
  const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
  status.plan=jev22Plan();
  const answer=(async()=>{for(;;){const r=await channel.current();if(r){await channel.answer(r.id,plan({route_path:['5,8','5,9','5,10'],elite_min_hp_percent:55}));return r;}await new Promise(x=>setTimeout(x,50));}})();
  await hierarchicalDeliberate({state:jev22State(61),candidates:jev22Options,strategist:{channel,status},ask:()=>assert.fail('the route leaves one option')});
  const seen=await answer;
  assert.equal(seen.brief.trigger,'route_risk');
  assert.deepEqual(seen.brief.route_risk.elite_chain.floors,[9,11]);
  assert.deepEqual(seen.brief.routes.routes.find(r=>r.rooms.startsWith('ETE')).elite_chains,[[9,11]]);
 }finally{await rm(dir,{recursive:true,force:true});}
 // Jev modes: the same map screen sends the facts the unchanged fact builders give, with no chain fields.
 for(const factsVersion of [2,3]){
  let request;
  await hierarchicalDeliberate({state:jev22State(61),candidates:jev22Options,factsVersion,
   ask:async q=>{request=q;return {model:'t',answers:{move:{type:'choice',choice:'a1',confidence:.9,probabilities:{a1:.9}}},usage:{input_tokens:1,output_tokens:1}};}});
  assert.deepEqual(request.state.computed_facts,computedFacts(jev22State(61),jev22Options,null,{version:factsVersion,readiness:factsVersion===3?eliteReadiness(jev22State(61)):null}));
  assert.deepEqual(request.state.computed_facts.route_options,factsVersion===3?orderedOptionRoutes(jev22Map(),jev22Options):optionRoutes(jev22Map(),jev22Options));
  assert.doesNotMatch(JSON.stringify(request),/elite_chain|floor_offset/);
 }
});

test('the route instructions give the elite chain evidence and the route_risk margin',()=>{
 const route=STRATEGIST_INSTRUCTIONS.split(/\r?\n/).find(l=>l.startsWith('- route:'));
 assert.match(route,/elite_chains/);assert.match(route,/JEV22/);assert.match(route,/2 of 69 logged elite fights/);
 assert.ok(route.includes(`elite_min_hp_percent + ${ELITE_CHAIN_MARGIN}`));
});

// JEV22 (Strategist v3.18), Act 2: the new_act request came on the act's opening event, and its brief
// already listed the routes. The answer had route_path [], the act counted as routed and route_plan never
// fired. An act is routed only by a non-empty route_path from listed routes, or by a route request on a map screen.
const act2=(floor=18)=>({...run,act:2,floor});
const act2Map=(extra={})=>({...mapState(),run:act2(),...extra});
const act2Event=()=>({...act2Map(),state_type:'event',event:{event_name:'Orobas',options:[]}});
const eventOptions=[{id:'a0',command:{action:'choose_event_option',index:0},label:'A'},{id:'a1',command:{action:'choose_event_option',index:1},label:'B'}];
const act1Routed=()=>stampPlan(plan({route_path:['1,1','1,2','0,3']}),requestStamp(mapState(),candidates,'route_plan',keys));

test('a new_act answer with routes listed and route_path [] leaves the act unrouted, so route_plan fires on its first map screen',()=>{
 const stamp=requestStamp(act2Event(),eventOptions,'new_act',keys,{routesShown:true,routeAct:null});
 const unrouted=stampPlan(plan(),stamp);
 assert.equal(unrouted.route_act,null);
 assert.equal(replanReason(act2Map(),unrouted,candidates),'route_plan');
 // A non-empty route_path from the listed routes routes the act.
 const routed=stampPlan(plan({route_path:['0,1','0,2','0,3']}),stamp);
 assert.equal(routed.route_act,2);
 assert.equal(replanReason(act2Map({run:act2(19)}),routed,candidates),null);
 // Without listed routes, a carried route_path does not route a new act.
 assert.equal(stampPlan(plan({route_path:['0,1']}),requestStamp(act2Event(),eventOptions,'new_act',keys,{routesShown:false})).route_act,null);
});

test('new_act on the map screen with route_path [] asks route_plan on that same screen; a route request routes the act',()=>{
 const onMap=stampPlan(plan(),requestStamp(act2Map(),candidates,'new_act',keys));
 assert.equal(onMap.route_act,null);assert.equal(onMap.screen,screenKey(act2Map()));
 assert.equal(replanReason(act2Map(),onMap,candidates),'route_plan');
 // route_plan answered [] (Jev routes) counts as routed: no further route request this act.
 const jevRoutes=stampPlan(plan(),requestStamp(act2Map(),candidates,'route_plan',keys));
 assert.equal(jevRoutes.route_act,2);
 assert.equal(replanReason(act2Map(),jevRoutes,candidates),null);
 assert.equal(replanReason(act2Map({run:act2(19)}),jevRoutes,candidates),null);
});

test('the runner asks route_plan after a new_act answered on the opening event with routes listed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-route-'));
 try{
  const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
  status.plan=act1Routed();
  const answer=(async()=>{for(;;){const r=await channel.current();if(r){await channel.answer(r.id,plan());return r;}await new Promise(x=>setTimeout(x,50));}})();
  await hierarchicalDeliberate({state:act2Event(),candidates:eventOptions,strategist:{channel,status},
   ask:async()=>({answers:{move:{type:'choice',choice:'a0',confidence:0.9}},usage:{input_tokens:1}})});
  const seen=await answer;
  assert.equal(seen.stamp.reason,'new_act');assert.ok(seen.brief.routes,'the opening event brief lists the routes');
  assert.equal(seen.stamp.route_act,null,'Act 1 routing does not carry into Act 2');
  assert.equal(status.plan.route_act,null);
  assert.equal(replanReason(act2Map(),status.plan,candidates),'route_plan');
 }finally{await rm(dir,{recursive:true,force:true});}
});

// JEV22 (Strategist v3.18), floor 2 card reward: the brief's routes had floor_offset 2 and elite chains
// one floor late. The runner remembered the node travelled to (2,1), then a map screen shown during the
// travel still had the node just left (3,0) as current_position and replaced it.
const jev22Act1=JSON.parse(readFileSync(new URL('./fixtures/jev22-act1-map.json',import.meta.url),'utf8')).map;
test('a stale map screen during travel does not move the remembered node back; off-map floors stay right',()=>{
 const live={live_id:'run-jev22',act:1,floor:1,ascension:0};
 const atMap={state_type:'map',run:live,map:jev22Act1};
 let memory=rememberMap(null,atMap);
 assert.deepEqual(memory.position,{col:3,row:0,type:'Ancient'});
 memory=travelledTo(memory,atMap,{command:{action:'choose_map_node',index:0},details:{index:0,col:2,row:1,type:'Monster'}});
 memory=rememberMap(memory,atMap);
 assert.deepEqual(memory.position,{col:2,row:1,type:'Monster'},'the stale map keeps the node travelled to');
 const reward={state_type:'card_reward',run:{...live,floor:2},player:{hp:80,max_hp:80,gold:99,potions:[],relics:[],deck:[]}};
 const {map:m,position}=currentMap(reward,memory);
 const routes=strategistBrief(reward,[],'owned_screen',null,{routes:distinctRoutes(m,position)}).routes;
 assert.equal(routes.from,'2,1');assert.equal(routes.floor_offset,1);
 const chains=r=>[...new Set(r.routes.filter(x=>x.elite_chains).map(x=>JSON.stringify(x.elite_chains)))];
 // The same chain floors as the floor 1 route_plan brief, which listed [9,11] and [11,14].
 assert.deepEqual(chains(routes),['[[11,14]]']);
 assert.deepEqual(chains(withEliteChains(distinctRoutes(jev22Act1,jev22Act1.current_position),1)),['[[9,11]]','[[11,14]]']);
 // The logged brief: from the stale node, every floor one too high.
 assert.deepEqual(chains(withEliteChains(distinctRoutes(jev22Act1,{col:3,row:0}),2)),['[[10,12]]','[[12,15]]']);
 // A new act's map replaces the memory; a later map screen moves it forward.
 assert.deepEqual(rememberMap(memory,{...atMap,run:{...live,act:2,floor:18}}).position,{col:3,row:0,type:'Ancient'});
 assert.deepEqual(rememberMap(memory,{...atMap,run:{...live,floor:3},map:{...jev22Act1,current_position:{col:1,row:2,type:'Monster'}}}).position,{col:1,row:2,type:'Monster'});
});
