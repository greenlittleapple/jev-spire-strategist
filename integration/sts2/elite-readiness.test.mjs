// Elite readiness (Acts 1 and 2): hallway form from the saved map history, the level at each act's
// limit, the elite_not_ready map rule in claude and jev_facts_v3 modes, and route_risk on risky.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hallwayForm,eliteReadiness,eliteBeforeRest,orderedOptionRoutes,ELITE_READY_LIMITS} from './route-facts.mjs';
import {eliteReadyConstraint,eliteLowHpConstraint,routeRisk,replanReason,requestStamp,stampPlan,strategistBrief,STRATEGIST_INSTRUCTIONS} from './strategy.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';

// A saved map history entry as the game writes it (fields the form reads, plus the room's type).
const room=(type,damage_taken,hp_healed,point=type)=>({map_point_type:point,rooms:[{room_type:type,turns_taken:3}],
 player_stats:[{current_hp:0,max_hp:0,damage_taken,hp_healed}]});
const ancient={map_point_type:'ancient',rooms:[{model_id:'EVENT.NEOW',room_type:'event',turns_taken:0}],player_stats:[{damage_taken:0,hp_healed:0}]};

test('hallway form is the mean net HP lost over the act\'s last three monster rooms',()=>{
 // Net losses 4, 6, 14 (an unknown room that was a fight counts), 0 (healing above damage is floored).
 const act1=[ancient,room('monster',10,6),room('monster',12,6),room('elite',30,6),room('monster',20,6,'unknown'),room('shop',0,0),room('monster',3,6)];
 assert.equal(hallwayForm([act1],1),(6+14+0)/3);
 assert.equal(hallwayForm([act1.slice(0,3)],1),5,'two rooms: their mean');
 assert.equal(hallwayForm([act1.slice(0,2)],1),null,'one hallway room is too few');
 assert.equal(hallwayForm([[ancient,room('elite',30,6),room('rest_site',0,20)]],1),null,'elites and rests are not hallway fights');
 assert.equal(hallwayForm(undefined,1),null,'no saved history');
 assert.equal(hallwayForm([act1],2),null,'the previous act\'s checkpoint at a new act\'s first map');
 assert.equal(hallwayForm([act1,[room('monster',9,0),room('monster',12,0)]],2),10.5,'only the current act counts');
});

const history=(act,losses)=>Array.from({length:act},(_,i)=>i===act-1?losses.map(n=>room('monster',n+6,6)):[room('monster',30,0),room('monster',30,0)]);
const readyState=({act=1,potions=2,losses=null})=>({state_type:'map',run:{live_id:'run-r',act,floor:act===1?6:23,ascension:0},
 player:{hp:60,max_hp:80,potions:Array.from({length:potions},(_,i)=>({name:'P'+i,slot:i})),max_potion_slots:3},
 ...(losses?{saved_run:{map_point_history:history(act,losses)}}:{})});

test('readiness levels at each act\'s limit',()=>{
 assert.deepEqual(ELITE_READY_LIMITS,{1:7,2:10});
 const level=o=>eliteReadiness(readyState(o)).level;
 // Act 1, limit 7: 6.7 is under, 7 is at it.
 assert.equal(level({potions:2,losses:[6,7,7]}),'ready');
 assert.equal(level({potions:2,losses:[7,7,7]}),'risky');
 assert.equal(level({potions:1,losses:[7,7,7]}),'not_ready');
 assert.equal(level({potions:1,losses:[6,7,7]}),'risky');
 assert.equal(level({potions:2}),'ready','no form yet: potions decide');
 assert.equal(level({potions:0}),'risky','no form yet is never not_ready');
 // Act 2, limit 10.
 assert.equal(level({act:2,potions:1,losses:[10,10]}),'not_ready');
 assert.equal(level({act:2,potions:1,losses:[9,10]}),'risky');
 assert.equal(level({act:2,potions:3,losses:[9,10]}),'ready');
 assert.equal(level({act:2,potions:3,losses:[10,10,10]}),'risky');
 assert.deepEqual(eliteReadiness(readyState({potions:1,losses:[6,7,8]})),{level:'not_ready',hallway_form:7,potions_held:1,act:1,act_limit:7});
 assert.equal(eliteReadiness(readyState({act:3,potions:0,losses:[30,30]})),null,'no check in Act 3');
});

// Act 1 map from row 5 (floor 6): a0 is a monster before an elite, a1 a monster before an unknown,
// a2 an elite, a3 a monster that can go either way. Every path meets the rest site on row 8.
const node=(col,row,type,children=[])=>({col,row,type,children});
const map={current_position:{col:1,row:5,type:'Monster'},boss:{col:0,row:9,name:'Boss'},
 nodes:[node(1,5,'Monster',[[0,6],[1,6],[2,6],[3,6]]),node(0,6,'Monster',[[0,7]]),node(1,6,'Monster',[[1,7]]),node(2,6,'Elite',[[1,7]]),node(3,6,'Monster',[[0,7],[1,7]]),
  node(0,7,'Elite',[[0,8]]),node(1,7,'Unknown',[[0,8]]),node(0,8,'RestSite',[[0,9]]),node(0,9,'Boss')],
 next_options:[[0,6,'Monster'],[1,6,'Monster'],[2,6,'Elite'],[3,6,'Monster']].map(([col,row,type],index)=>({index,col,row,type}))};
const options=map.next_options.map(o=>({id:'a'+o.index,label:`Travel to ${o.type} (column ${o.col})`,command:{action:'choose_map_node',index:o.index},details:o}));
const mapState=o=>({...readyState(o),map,player:{...readyState(o).player,gold:50,relics:[],deck:[]}});
const notReady=()=>mapState({potions:1,losses:[8,9,7]});

test('committing to an elite before the next rest site is the v3 route fact',()=>{
 const commits=eliteBeforeRest(map),facts=orderedOptionRoutes(map,options);
 for(const c of options)assert.equal(commits(`${c.details.col},${c.details.row}`),facts[c.id].min_elites_before_first_rest>=1,c.id);
 assert.deepEqual(options.filter(c=>commits(`${c.details.col},${c.details.row}`)).map(c=>c.id),['a0','a2']);
});

test('elite_not_ready removes the committing options and logs the readiness numbers',()=>{
 const r=eliteReadyConstraint(notReady(),options);
 assert.deepEqual(r.candidates.map(c=>c.id),['a1','a3']);
 assert.deepEqual(r.constraint,{kind:'elite_not_ready',removed:2,removed_ids:['a0','a2'],form:8,potions:1,act:1,limit:7});
 assert.equal(eliteReadyConstraint(mapState({potions:1,losses:[6,7,7]}),options),null,'risky removes nothing');
 assert.equal(eliteReadyConstraint(notReady(),[options[0],options[2]]),null,'not when it would leave no option');
 assert.equal(eliteReadyConstraint({...notReady(),run:{...notReady().run,act:3}},options),null,'not in Act 3');
});

const jevAnswer=(seen,choice)=>async q=>{seen.push(q);return {model:'t',answers:{move:{type:'choice',choice,confidence:.9,probabilities:{[choice]:.9}}},usage:{input_tokens:1,output_tokens:1}};};
const offered=q=>JSON.stringify(q).match(/"a\d"/g)?.map(s=>s.slice(1,-1)).filter((v,i,a)=>a.indexOf(v)===i).sort();

test('jev_facts_v3 applies the rule and shows readiness in the facts; other Jev modes do not',async()=>{
 const seen=[];
 const result=await hierarchicalDeliberate({state:notReady(),candidates:options,factsVersion:3,ask:jevAnswer(seen,'a1')});
 assert.deepEqual(result.constraint,{kind:'elite_not_ready',removed:2,removed_ids:['a0','a2'],form:8,potions:1,act:1,limit:7});
 assert.deepEqual(offered(seen[0]),['a1','a3']);
 const facts=seen[0].state.computed_facts;
 assert.deepEqual(Object.keys(facts.route_options).sort(),['a1','a3']);
 assert.equal(facts.elite_readiness.level,'not_ready');assert.equal(facts.elite_readiness.hallway_form,8);
 assert.equal(facts.elite_readiness.act_limit,7);assert.match(facts.elite_readiness.note,/removes map options/);
 // A single option left is the rule's move.
 const one=await hierarchicalDeliberate({state:notReady(),candidates:options.slice(0,2),factsVersion:3,ask:()=>assert.fail('no Jev call')});
 assert.equal(one.decisionSource,'rule');assert.equal(one.rule,'elite_not_ready');assert.equal(one.answers.move.choice,'a1');
 // Ready: nothing removed, readiness still shown.
 const ready=[];
 const r2=await hierarchicalDeliberate({state:mapState({potions:2,losses:[1,2]}),candidates:options,factsVersion:3,ask:jevAnswer(ready,'a0')});
 assert.equal(r2.constraint,undefined);assert.equal(ready[0].state.computed_facts.elite_readiness.level,'ready');
 // jev_facts (v2) and jev: no rule, no readiness.
 for(const factsVersion of [0,2]){
  const asked=[];
  const r=await hierarchicalDeliberate({state:notReady(),candidates:options,factsVersion,ask:jevAnswer(asked,'a0')});
  assert.equal(r.constraint,undefined);assert.deepEqual(offered(asked[0]),['a0','a1','a2','a3']);
  assert.doesNotMatch(JSON.stringify(asked[0]),/elite_readiness/);
 }
});

const plan=(extra={})=>({archetype:'x',summary:'x',priorities:[],combat:{risk_tolerance:'low',potion_policy:'x',focus:'x',hallway_potion_below_hp_percent:100,potion_reserve:0},
 fight:{plan:'',target_priority:[]},card_reward:{desired:[],avoid:[],skip_when:''},shop:{gold_reserve:0,priorities:[]},route:'x',route_path:[],elite_min_hp_percent:0,
 rest:'x',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const keys=map.nodes.map(n=>`${n.col},${n.row}`);
const routed=(state,path,extra={})=>({...stampPlan(plan({route_path:path}),requestStamp({...state,run:{...state.run,floor:1}},options,'route_plan',keys)),...extra});
const answerWith=(channel,p)=>(async()=>{for(;;){const r=await channel.current();if(r){await channel.answer(r.id,p);return r;}await new Promise(x=>setTimeout(x,50));}})();

test('claude mode: not_ready breaks a route through the elite, and the strategist routes again',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-ready-'));
 try{
  const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
  status.plan=routed(notReady(),['0,6','0,7','0,8']);
  const answer=answerWith(channel,plan({route_path:['1,6','1,7','0,8']}));
  const result=await hierarchicalDeliberate({state:notReady(),candidates:options,strategist:{channel,status},ask:()=>assert.fail('the route leaves one option')});
  const seen=await answer;
  assert.equal(seen.stamp.reason,'route_off');
  assert.deepEqual(seen.brief.current_options.map(o=>o.id),['a1','a3']);
  assert.equal(seen.brief.routes.elite_readiness.level,'not_ready');
  assert.equal(result.decisionSource,'claude');assert.equal(result.answers.move.choice,'a1');
  assert.deepEqual(result.constraint.rules,[{kind:'elite_not_ready',removed:2,removed_ids:['a0','a2'],form:8,potions:1,act:1,limit:7},
   {kind:'route',removed:1,removed_ids:['a3']}]);
  assert.equal(result.constraint.kind,'route');assert.deepEqual(result.constraint.removed_ids,['a0','a2','a3']);
 }finally{await rm(dir,{recursive:true,force:true});}
 // With no route on the map the rule alone is the constraint, and a lone option left is a rule move.
 const status=newStrategyStatus({enabled:true});
 status.plan={...routed(notReady(),[]),screen:'other'};
 const one=await hierarchicalDeliberate({state:notReady(),candidates:options.slice(0,2),strategist:{channel:{current:async()=>null},status},ask:()=>assert.fail('no Jev call')});
 assert.equal(one.decisionSource,'rule');assert.equal(one.rule,'elite_not_ready');assert.equal(one.constraint.kind,'elite_not_ready');
});

test('claude mode: a risky elite on the path asks route_risk once, with the readiness in the brief',async()=>{
 const risky=mapState({potions:1,losses:[2,3]}),through=routed(risky,['0,6','0,7','0,8']);
 assert.equal(replanReason(risky,through,options),'route_risk');
 const risk=routeRisk(risky,through,options);
 assert.equal(risk.kind,'elite_readiness');
 assert.deepEqual(risk.next,[{option:'a0',node:'0,6',type:'Monster',floor:7}]);
 assert.deepEqual(risk.elite_readiness,{level:'risky',hallway_form:2.5,potions_held:1,act:1,act_limit:7,elite:{node:'0,7',floor:8}});
 assert.equal(replanReason(risky,{...through,readiness_asked:['0,7']},options),null,'asked once per elite');
 assert.equal(replanReason(mapState({potions:2,losses:[2,3]}),through,options),null,'ready');
 assert.equal(replanReason(risky,routed(risky,['1,6','1,7','0,8']),options),null,'the path does not commit');
 assert.equal(replanReason(risky,through,[options[0],options[2]]),null,'no option avoids an elite');
 // The HP check still fires on its own terms and carries the readiness too.
 const low=routeRisk({...risky,player:{...risky.player,hp:30}},{...through,elite_min_hp_percent:60},options);
 assert.equal(low.kind,'elite');assert.equal(low.elite_readiness.level,'risky');
 // The brief's routes and route_risk show the numbers; the stamp records the elite as asked.
 const brief=strategistBrief(risky,options,'route_risk',through,{routes:{from:'1,5',routes:[]}});
 assert.equal(brief.route_risk.kind,'elite_readiness');assert.equal(brief.routes.elite_readiness.potions_held,1);
 const dir=await mkdtemp(join(tmpdir(),'jev-ready-'));
 try{
  const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
  status.plan=through;
  const answer=answerWith(channel,plan({route_path:['0,6','0,7','0,8']}));
  const result=await hierarchicalDeliberate({state:risky,candidates:options,strategist:{channel,status},ask:()=>assert.fail('the route leaves one option')});
  const seen=await answer;
  assert.equal(seen.stamp.reason,'route_risk');assert.deepEqual(seen.stamp.readiness_asked,['0,7']);
  assert.equal(seen.brief.route_risk.elite_readiness.hallway_form,2.5);
  assert.equal(result.answers.move.choice,'a0');assert.deepEqual(status.plan.readiness_asked,['0,7']);
  // The next branch toward the same elite does not ask again.
  assert.equal(replanReason({...risky,run:{...risky.run,floor:7}},status.plan,options),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the strategist instructions say code removes not_ready elites and risky ones are the strategist\'s call',()=>{
 const line=STRATEGIST_INSTRUCTIONS.split(/\r?\n/).find(l=>l.startsWith('Elite readiness'));
 assert.match(line,/not_ready/);assert.match(line,/code removes/);assert.match(line,/risky elite is your call/);
});

// elite_low_hp: route_risk's HP check needs a route_path. JEV22 (Strategist v3.18) answered route_path []
// for Act 2 and Jev routed into an elite at 26% HP with no potions. With Jev routing and HP below the
// plan's elite_min_hp_percent, code removes the options that commit to an elite before the next rest.
const ready=()=>mapState({potions:2,losses:[1,2]});
const jevRouting=(state,extra={})=>({...routed(state,[]),elite_min_hp_percent:80,screen:'other',...extra});
test('elite_low_hp removes elite-committing options below elite_min_hp_percent when Jev routes',()=>{
 const r=eliteLowHpConstraint(ready(),options,jevRouting(ready()));
 assert.deepEqual(r.candidates.map(c=>c.id),['a1','a3']);
 assert.deepEqual(r.constraint,{kind:'elite_low_hp',removed:2,removed_ids:['a0','a2'],hp_percent:75,elite_min_hp_percent:80});
 assert.equal(eliteLowHpConstraint(ready(),options,jevRouting(ready(),{elite_min_hp_percent:75})),null,'HP at the value');
 assert.equal(eliteLowHpConstraint(ready(),options,jevRouting(ready(),{elite_min_hp_percent:0})),null,'0 turns it off');
 assert.equal(eliteLowHpConstraint(ready(),[options[0],options[2]],jevRouting(ready())),null,'not when it would leave no option');
 assert.equal(eliteLowHpConstraint(ready(),options,{...routed(ready(),['0,6','0,7','0,8']),elite_min_hp_percent:80}),null,'a route in force uses route_risk instead');
});

test('claude mode: elite_low_hp is a rule; with elite_not_ready the readiness rule removes first',async()=>{
 const status=newStrategyStatus({enabled:true}),channel={current:async()=>null};
 status.plan=jevRouting(ready());
 const seen=[];
 const result=await hierarchicalDeliberate({state:ready(),candidates:options,strategist:{channel,status},ask:jevAnswer(seen,'a1')});
 assert.deepEqual(result.constraint,{kind:'elite_low_hp',removed:2,removed_ids:['a0','a2'],hp_percent:75,elite_min_hp_percent:80});
 const one=await hierarchicalDeliberate({state:ready(),candidates:options.slice(0,3),strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(one.decisionSource,'rule');assert.equal(one.rule,'elite_low_hp');assert.equal(one.answers.move.choice,'a1');
 // not_ready already removed the same options: one rule record, not two.
 status.plan=jevRouting(notReady());
 const both=await hierarchicalDeliberate({state:notReady(),candidates:options,strategist:{channel,status},ask:jevAnswer([],'a1')});
 assert.equal(both.constraint.kind,'elite_not_ready');assert.deepEqual(both.constraint.removed_ids,['a0','a2']);
 // Not in jev_facts_v3 (no plan).
 const jevOnly=await hierarchicalDeliberate({state:ready(),candidates:options,factsVersion:3,ask:jevAnswer([],'a0')});
 assert.equal(jevOnly.constraint,undefined);
});

test('the strategist instructions describe elite_low_hp under elite_min_hp_percent',()=>{
 const line=STRATEGIST_INSTRUCTIONS.split(/\r?\n/).find(l=>l.startsWith('- elite_min_hp_percent'));
 assert.match(line,/route_path \[\] \(Jev routing\)/);assert.match(line,/elite_low_hp/);
});
