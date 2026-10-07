// Seed boundary (v3.19): the strategist's memory of earlier runs skips runs on the current run's seed.
import {test as nodeTest,afterEach} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';
import {requestStamp,stampPlan} from './strategy.mjs';
import {filePlaybook} from './playbook.mjs';
import {mechanicKey} from './mechanics.mjs';
import {newCardStats,recordDecision,cardSummary,cardRuns} from './card-stats.mjs';
import {encounterResults,planNeedsReview} from './fight-results.mjs';
import {patternFor} from './movesets.mjs';
import {seedBoundary,fightRun,addSeriesSeeds,recordRunSeed,loadRunSeeds,newBoundaryRecord,bound} from './seed-boundary.mjs';

const test=(name,fn)=>nodeTest(name,{timeout:30000},fn);
// run-cur is on JEV21; run-a is an earlier JEV21 run, run-b a JEV22 run, run-x a run with no known seed.
const SEEDS={'run-cur':'JEV21','run-a':'jev21','run-b':'JEV22'};
const plan=(extra={})=>({archetype:'x',summary:'x',priorities:[],combat:{risk_tolerance:'low',potion_policy:'',focus:'',hallway_potion_below_hp_percent:100,potion_reserve:0},
 fight:{plan:'',target_priority:[]},card_reward:{desired:[],avoid:[],skip_when:''},shop:{gold_reserve:0,priorities:[]},route:'',route_path:[],
 elite_min_hp_percent:0,rest:'',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const run=(floor=5,live_id='run-cur')=>({live_id,act:1,floor,ascension:0});
const strike=index=>({index,id:'STRIKE',name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'});
const fightState=({status=[]}={})=>({state_type:'monster',run:run(),player:{hp:70,max_hp:80,energy:3,block:0,gold:50,deck:[],relics:[],potions:[],status:[],hand:[strike(0),strike(1)]},
 battle:{round:1,turn:'player',is_play_phase:true,enemies:[{entity_id:'l',name:'Leader',hp:60,max_hp:60,block:0,status,intents:[{type:'Attack',label:'5',description:'Attack for 5.'}]}]}});
const jev=choice=>({model:'t',answers:{move:{type:'choice',choice,confidence:.9,probabilities:{[choice]:.9}}},usage:{input_tokens:1,output_tokens:1}});
const ask=asked=>async q=>{asked.push(q);return jev(Object.keys(q.questions.move.criteria)[0]);};

let halts=[];
afterEach(async()=>{for(const h of halts.splice(0))await h();});
async function withDir(fn){const dir=await mkdtemp(join(tmpdir(),'jev-seed-'));try{return await fn(dir);}finally{for(const h of halts.splice(0))await h();await rm(dir,{recursive:true,force:true});}}
// Answers every request with makePlan(request) and keeps the requests in seen.
function session(channel,makePlan,seen){
 const c=new AbortController();
 const done=(async()=>{while(!c.signal.aborted){
  try{const r=await channel.pending();if(r){seen.push(r);await channel.answer(r.id,makePlan(r));}}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)&&!/was replaced by/.test(e.message))throw e;}
  await delay(30,undefined,{signal:c.signal}).catch(()=>{});}})();
 halts.push(async()=>{c.abort();await done;});
}
const result=(run,{won=true,hp_end=60,time='2026-10-02T00:00:00Z'}={})=>({key:'Leader',fight:'1:3',run,kind:'monster',time,hp_start:70,max_hp:80,rounds:3,hp_last:hp_end,hp_end,won});
const moves=(run,label)=>({fight:`${run}:1:3`,slot:'l',moves:{1:`Attack ${label}`,2:'Buff'}});
// A playbook entry written by run with updatedAt.
const writeBook=async(dir,entries)=>{await writeFile(join(dir,'playbook.json'),JSON.stringify({entries}));return filePlaybook(dir);};
const saved=(run,text,updatedAt='2026-10-01T00:00:00Z')=>({plan:text,target_priority:['Leader'],updatedAt,source:'new_encounter',run,floor:3});
const startedStatus=()=>{const s=newStrategyStatus({waitMs:5000});s.plan=stampPlan(plan(),requestStamp({...fightState(),state_type:'event'},[],'run_start'));return s;};

test('seeds come from series rows and run_start records; each entry is kept, removed or unknown',async()=>{
 const seeds=addSeriesSeeds({},'{"run":"r1","seed":"jev21"}\r\n{"run":"r2","seed":"JEV22"}\r\nnot json\r\n');
 recordRunSeed(seeds,{kind:'run_start',run:'r3',setup:{seed:'JEV23'}});
 recordRunSeed(seeds,{kind:'run_start',run:'r4',setup:{seed:null}});
 assert.deepEqual(seeds,{r1:'JEV21',r2:'JEV22',r3:'JEV23'});
 assert.equal(fightRun('modded:profile1:1790:2:17'),'modded:profile1:1790');
 const b=seedBoundary(SEEDS,'run-cur');
 assert.deepEqual(['run-cur','run-a','run-b','run-x',null].map(b.check),['keep','same','keep','unknown','unknown']);
 assert.equal(seedBoundary(SEEDS,'run-new').active,false,'an unknown current seed removes nothing');
 assert.equal(seedBoundary(SEEDS,'run-new').check('run-a'),'keep');
 await withDir(async dir=>{
  await mkdir(join(dir,'runs'));await writeFile(join(dir,'series.jsonl'),'{"run":"s1","seed":"JEV1"}\r\n{"run":"s2","seed":"JEV2"}\r\n');
  const log=join(dir,'runs','log.jsonl');
  await writeFile(log,[{kind:'run_start',run:'s2',setup:{seed:'JEV9'}},{kind:'decision',state:{}}].map(x=>JSON.stringify(x)).join('\r\n'));
  assert.deepEqual(await loadRunSeeds(log),{s1:'JEV1',s2:'JEV9'},'the run_start seed wins');
 });
});

test('each memory kind keeps only other-seed entries and counts unknown-seed ones',()=>{
 const b=seedBoundary(SEEDS,'run-cur'),rec=newBoundaryRecord(b);
 // Patterns: the same-seed fight is skipped, this run's own fight is kept.
 const movesets={Leader:[moves('run-b','6'),moves('run-a','7'),moves('run-x','8'),moves('run-cur','9')]};
 const kept=bound(rec,b,'patterns',movesets.Leader,x=>fightRun(x.fight));
 assert.deepEqual(patternFor(movesets,'Leader',null,kept),['r1 Attack 9, r2 Buff','r1 Attack 8, r2 Buff','r1 Attack 6, r2 Buff']);
 // Encounter results.
 const memory={encounters:{Leader:[result('run-b'),result('run-a',{won:false,hp_end:0}),result('run-x')]}};
 bound(rec,b,'encounter_results',memory.encounters.Leader,f=>f.run);
 const shown=encounterResults(memory,'Leader',null,f=>b.keep(f.run));
 assert.equal(shown.fights,2);assert.equal(shown.wins,2);
 // Card stats: a JEV21 run's offers and picks are not counted.
 const stats=newCardStats(SEEDS);
 const reward=(runId,chosen)=>({kind:'decision',outcome:'executed',time:'t',state:{state_type:'card_reward',run:run(2,runId)},
  candidates:[{label:'Stomp'},{label:'Anger'}],chosen:{label:chosen}});
 recordDecision(stats,reward('run-a','Stomp'));recordDecision(stats,reward('run-a','Stomp'));
 recordDecision(stats,reward('run-b','Anger'));recordDecision(stats,reward('run-x','Stomp'));
 assert.deepEqual(cardSummary(stats,'Stomp'),{offered:4,picked:3,seeds:2,floor_reached_when_picked:2},'without the boundary');
 bound(rec,b,'card_stats',cardRuns(stats,'Stomp'),([id])=>id);
 assert.deepEqual(cardSummary(stats,'Stomp',b.keep),{offered:2,picked:1,seeds:1,floor_reached_when_picked:2});
 assert.deepEqual(cardSummary(stats,'Stomp',()=>true),cardSummary(stats,'Stomp'),'per-run counts add up to the totals');
 // Plans.
 assert.deepEqual(bound(rec,b,'plans',[saved('run-a','x')],e=>e.run),[]);
 assert.equal(bound(rec,b,'plans',[saved(undefined,'y')],e=>e.run).length,1);
 assert.deepEqual(rec,{seed:'JEV21',active:true,removed:{patterns:1,encounter_results:1,card_stats:1,plans:1},unknown_seed:{patterns:1,encounter_results:1,card_stats:1,plans:1}});
});

test('review_encounter does not fire from same-seed results, and does from other-seed ones',()=>{
 const b=seedBoundary(SEEDS,'run-cur'),keep=f=>b.keep(f.run),p=saved('run-b','Kill it');
 const same={encounters:{Leader:[result('run-a',{won:false,hp_end:0})]}},other={encounters:{Leader:[result('run-b',{won:false,hp_end:0})]}};
 assert.equal(planNeedsReview(same,'Leader',p),true,'without the boundary');
 assert.equal(planNeedsReview(same,'Leader',p,keep),false);
 assert.equal(planNeedsReview(other,'Leader',p,keep),true);
});

test('in a fight, the brief skips same-seed memory, a same-seed plan is not offered, and the request records the counts',()=>withDir(async dir=>{
 const channel=fileChannel(dir),seen=[],asked=[];
 const playbook=await writeBook(dir,{Leader:saved('run-a','Same-seed plan')});
 const status=startedStatus();
 session(channel,()=>plan(),seen);
 const s=fightState();
 const strategist={channel,status,playbook,runSeeds:{...SEEDS},
  movesets:{Leader:[moves('run-b','6'),moves('run-a','7'),moves('run-x','8')]},
  fightResults:{open:{},encounters:{Leader:[result('run-b'),result('run-a',{won:false,hp_end:0})]}}};
 await hierarchicalDeliberate({state:s,candidates:decisionCandidates(s),strategist,ask:ask(asked)});
 const r=seen[0];
 assert.equal(r.stamp.reason,'new_encounter','a same-seed saved plan counts as no plan');
 assert.equal(r.brief.saved_fight_plan,undefined);
 assert.deepEqual(r.brief.enemies[0].seen_pattern,['r1 Attack 8, r2 Buff','r1 Attack 6, r2 Buff']);
 assert.equal(r.brief.encounter_results.fights,1);assert.equal(r.brief.encounter_results.wins,1);
 assert.equal(asked[0].state.run_strategy?.fight_plan,undefined,'the same-seed plan is not used');
}));

test('the strategy_request event records the removal counts',()=>withDir(async dir=>{
 const channel=fileChannel(dir),seen=[],events=[];
 const playbook=await writeBook(dir,{Leader:saved('run-a','Same-seed plan')});
 session(channel,()=>plan(),seen);
 const s=fightState();
 await hierarchicalDeliberate({state:s,candidates:decisionCandidates(s),ask:ask([]),onEvent:e=>{events.push(e);},
  strategist:{channel,status:startedStatus(),playbook,runSeeds:{...SEEDS},movesets:{Leader:[moves('run-a','7'),moves('run-x','8')]},
   fightResults:{open:{},encounters:{Leader:[result('run-a'),result('run-a'),result('run-b')]}}}});
 const request=events.find(e=>e.kind==='strategy_request');
 assert.deepEqual(request.memory_boundary,{seed:'JEV21',active:true,removed:{patterns:1,encounter_results:2,card_stats:0,plans:1},
  unknown_seed:{patterns:1,encounter_results:0,card_stats:0,plans:0}});
}));

test('an other-seed or unknown-seed saved plan is still used, and mechanic notes saved on the same seed are unchanged',()=>withDir(async dir=>{
 const channel=fileChannel(dir),seen=[];
 session(channel,()=>plan(),seen);
 const s=fightState({status:[{name:'Minion',amount:1,description:'Minions abandon combat without their leader.'}]});
 // A mechanic note saved during a same-seed run still reaches Jev.
 const note={name:'Minion',note:'Minions flee when the leader dies.',kind:'enemy power',run:'run-a',floor:3};
 const mechanics={all:async()=>({[mechanicKey('enemy power','Minion')]:note}),set:async()=>{}};
 const play=async entries=>{const asked=[],playbook=await writeBook(dir,entries);
  await hierarchicalDeliberate({state:s,candidates:decisionCandidates(s),ask:ask(asked),
   strategist:{channel,status:startedStatus(),playbook,mechanics,runSeeds:{...SEEDS},fightResults:{open:{},encounters:{}}}});
  return asked[0].state.run_strategy;};
 const other=await play({Leader:saved('run-b','Other-seed plan')});
 assert.equal(seen.length,0,'no request: the saved plan stands and the mechanic is known');
 assert.equal(other.fight_plan.plan,'Other-seed plan');
 assert.deepEqual(other.mechanics,[{name:'Minion',note:note.note}]);
 const unknown=await play({Leader:saved(undefined,'Unknown-seed plan')});
 assert.equal(unknown.fight_plan.plan,'Unknown-seed plan','an unknown-seed plan is kept');
}));

test('in a fight, same-seed losses after a saved plan do not ask for review_encounter; other-seed losses do',()=>withDir(async dir=>{
 const channel=fileChannel(dir),seen=[];
 session(channel,()=>plan(),seen);
 const s=fightState();
 const play=async loser=>{const playbook=await writeBook(dir,{Leader:saved('run-b','Other-seed plan')});
  await hierarchicalDeliberate({state:s,candidates:decisionCandidates(s),ask:ask([]),
   strategist:{channel,status:startedStatus(),playbook,runSeeds:{...SEEDS},fightResults:{open:{},encounters:{Leader:[result(loser,{won:false,hp_end:0})]}}}});};
 await play('run-a');
 assert.equal(seen.length,0,'a same-seed loss does not trigger a review');
 await play('run-b');
 assert.deepEqual(seen.map(r=>r.stamp.reason),['review_encounter']);
}));

test('shop card options show past_runs from other-seed runs only',()=>withDir(async dir=>{
 const channel=fileChannel(dir),seen=[];
 session(channel,()=>plan(),seen);
 const stats=newCardStats(SEEDS);
 const buy=runId=>({kind:'decision',outcome:'executed',time:'t',state:{state_type:'card_reward',run:run(2,runId)},candidates:[{label:'Stomp'}],chosen:{label:'Stomp'}});
 for(const r of ['run-a','run-a','run-b','run-x'])recordDecision(stats,buy(r));
 const s={state_type:'shop',run:run(6),player:{hp:60,max_hp:80,gold:200,deck:[],relics:[],potions:[],status:[]},shop:{items:[
  {index:0,category:'card',price:70,is_stocked:true,can_afford:true,card_name:'Stomp',card_type:'Attack',card_description:'Deal 12 damage to ALL enemies.',keywords:[]}]}};
 const events=[];
 await hierarchicalDeliberate({state:s,candidates:decisionCandidates(s),ask:ask([]),onEvent:e=>{events.push(e);},
  strategist:{channel,status:startedStatus(),runSeeds:{...SEEDS},cardStats:stats}});
 const stomp=seen[0].brief.current_options.find(o=>/Stomp/.test(o.label));
 assert.deepEqual(stomp.past_runs,{offered:2,picked:2,seeds:2,floor_reached_when_picked:2});
 assert.deepEqual(events.find(e=>e.kind==='strategy_request').memory_boundary.removed.card_stats,1);
 assert.deepEqual(events.find(e=>e.kind==='strategy_request').memory_boundary.unknown_seed.card_stats,1);
}));
