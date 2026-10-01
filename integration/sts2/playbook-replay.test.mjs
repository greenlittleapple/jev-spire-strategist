import {test as nodeTest,afterEach,after} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {encounterKey,currentEncounter,filePlaybook,planForRun} from './playbook.mjs';
import {cleanPlaybook,report} from './playbook-clean.mjs';
import {replayTable,replayChoice} from './replay.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';
import {requestStamp,stampPlan} from './strategy.mjs';

const run=(floor=5)=>({live_id:'run-1',act:1,floor,ascension:0});
const plan=(extra={})=>({archetype:'x',summary:'x',priorities:[],combat:{risk_tolerance:'low',potion_policy:'',focus:'',hallway_potion_below_hp_percent:100,potion_reserve:0},
 fight:{plan:'',target_priority:[]},card_reward:{desired:[],avoid:[],skip_when:''},shop:{gold_reserve:0,priorities:[]},route:'',route_path:[],
 elite_min_hp_percent:0,rest:'',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const strike=(index,target)=>({index,id:'STRIKE',name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'});
const fightState=(round=1,floor=5,type='monster')=>({state_type:type,run:run(floor),player:{hp:70,max_hp:80,energy:3,block:0,gold:50,deck:[],relics:[],potions:[],status:[],
 hand:[strike(0),strike(1)]},battle:{round,turn:'player',is_play_phase:true,enemies:[
  {entity_id:'l',name:'Leader',hp:60,max_hp:60,block:0,status:[],intents:[{type:'Attack',label:'5',description:'Attack for 5.'}]},
  {entity_id:'m',name:'Minion (Small)',hp:30,max_hp:30,block:0,status:[{name:'Minion',amount:1,description:'Minions abandon combat without their leader.'}],intents:[]}]}});
const shop=(gold=200,removed=false)=>({state_type:'shop',run:run(6),player:{hp:60,max_hp:80,gold,deck:[],relics:[],potions:[],status:[]},
 shop:{items:[...(removed?[]:[{index:0,category:'card',price:50,is_stocked:true,can_afford:true,card_name:'Anger',card_description:'Deal 6.'}]),
  {index:2,category:'card_removal',price:75,is_stocked:true,can_afford:gold>=75}]}});
const jev=choice=>({model:'t',answers:{move:{type:'choice',choice,confidence:.9,probabilities:{[choice]:.9}}},usage:{input_tokens:1,output_tokens:1}});
// Strategist sessions answer requests in the background. Each test's sessions are stopped when it ends
// (withDir, afterEach, after), and a strategist wait in hierarchicalDeliberate is cancelled with them, so
// a failed or unanswered request fails the test instead of leaving the file running.
const sessions=[];
let testRun=new AbortController();
const cancelled=()=>testRun.signal.aborted;
const haltAll=async()=>{const errors=(await Promise.all(sessions.splice(0).map(s=>s()))).filter(Boolean);if(errors.length)throw errors[0];};
afterEach(async()=>{testRun.abort();try{await haltAll();}finally{testRun=new AbortController();}});
after(async()=>{testRun.abort();await haltAll().catch(()=>{});});
// A test that waits too long fails; afterEach then cancels its strategist wait.
const test=(name,fn)=>nodeTest(name,{timeout:30000},fn);
async function withDir(fn){const dir=await mkdtemp(join(tmpdir(),'jev-pb-'));try{return await fn(dir);}finally{try{await haltAll();}finally{await rm(dir,{recursive:true,force:true});}}}
// Windows can refuse a read while the runner side renames request.json or answer.json into place; those
// reads are retried. Any other error stops the session and cancels the strategist wait, and is reported.
const RETRY=new Set(['EPERM','EACCES','EBUSY']);
function session(channel,makePlan,seen=[]){
 const controller=new AbortController(),{signal}=controller;
 let failure=null;
 // The loop is awaited on halt, so the directory is never removed while an answer is being written.
 const done=(async()=>{
  while(!signal.aborted){
   try{const r=await channel.pending();if(r){seen.push(r);await channel.answer(r.id,makePlan(r));}}
   catch(error){if(!RETRY.has(error.code)&&!/was replaced by/.test(error.message)){failure=error;testRun.abort();return;}}
   await delay(30,undefined,{signal}).catch(()=>{});
  }
 })();
 const halt=async()=>{controller.abort();await done;return failure;};sessions.push(halt);return halt;
}

test('encounter keys ignore order and form suffixes, count duplicates, and stay fixed for the fight',()=>{
 assert.equal(encounterKey([{name:'Kin Follower'},{name:'Kin Priest'},{name:'Kin Follower'}]),'Kin Follower x2 + Kin Priest','duplicates are counted');
 assert.equal(encounterKey([{name:'Bowlbug (Rock)'},{name:'Bowlbug (Nectar)'},{name:'Bowlbug (Silk)'}]),'Bowlbug x3');
 assert.equal(encounterKey([{name:'Bowlbug (Rock)'}]),'Bowlbug');
 const fights={},s=fightState();
 assert.equal(currentEncounter(s,fights),'Leader + Minion');
 s.battle.enemies.push({name:'Summoned'});
 assert.equal(currentEncounter(s,fights),'Leader + Minion','summons do not change the key');
 assert.equal(currentEncounter({state_type:'map',run:run()},fights),null);
});

test('a new hallway encounter asks for a fight plan once; the saved plan is reused, scoped and enforced',()=>withDir(async dir=>{
 const channel=fileChannel(dir),playbook=filePlaybook(dir),status=newStrategyStatus({waitMs:5000}),seen=[];
 status.plan=stampPlan(plan(),requestStamp({...fightState(),state_type:'event'},[],'run_start'));
 const stop=session(channel,()=>plan({fight:{plan:'Kill the Leader; minions leave.',target_priority:['Leader']}}),seen);
 const s=fightState(),c=decisionCandidates(s),asked=[];
 const result=await hierarchicalDeliberate({cancelled,state:s,candidates:c,strategist:{channel,status,playbook},ask:async q=>{asked.push(q);return jev(Object.keys(q.questions.move.criteria)[0]);}});
 assert.equal(seen[0].stamp.reason,'new_encounter');assert.equal(seen[0].brief.encounter,'Leader + Minion');
 assert.deepEqual((await playbook.get('Leader + Minion')).target_priority,['Leader']);
 assert.deepEqual(asked[0].state.run_strategy.fight_plan,{plan:'Kill the Leader; minions leave.',target_priority:['Leader']});
 const kept=Object.keys(asked[0].questions.move.criteria).map(id=>c.find(x=>x.id===id));
 assert.ok(kept.every(x=>x.command.target!=='m'),'plays at the minion are removed');
 assert.ok(result.constraint.rules.some(r=>r.kind==='target_priority'));
 // The same encounter later (another floor) needs no request and still gets the plan.
 const later=fightState(1,9),before=seen.length;
 const again=[];
 await hierarchicalDeliberate({cancelled,state:later,candidates:decisionCandidates(later),strategist:{channel,status,playbook},ask:async q=>{again.push(q);return jev(Object.keys(q.questions.move.criteria)[0]);}});
 assert.equal(seen.length,before);assert.equal(again[0].state.run_strategy.fight_plan.plan,'Kill the Leader; minions leave.');
 // A different encounter does not see it.
 const other=fightState(1,11);other.battle.enemies=[{entity_id:'x',name:'Other',hp:10,max_hp:10,block:0,status:[],intents:[]}];
 status.encountersAsked.push('run-1:1:11');
 const third=[];
 await hierarchicalDeliberate({cancelled,state:other,candidates:decisionCandidates(other),strategist:{channel,status,playbook},ask:async q=>{third.push(q);return jev(Object.keys(q.questions.move.criteria)[0]);}});
 stop();
 assert.equal(third[0].state.run_strategy.fight_plan,undefined);
}));

test('Claude decides owned screens: an ordered shop list runs without Jev and without re-asking',()=>withDir(async dir=>{
 const channel=fileChannel(dir),status=newStrategyStatus({waitMs:5000}),seen=[];
 status.plan=stampPlan(plan(),requestStamp({...shop(),state_type:'event',run:run(1)},[],'run_start'));
 const s=shop(),c=decisionCandidates(s);
 const buy=c.find(x=>x.label.startsWith('Anger')).id,remove=c.find(x=>x.label.startsWith('Remove')).id,leave=c.find(x=>x.command.action==='proceed').id;
 const stop=session(channel,()=>plan({allowed_option_ids:[buy,remove,leave]}),seen);
 const first=await hierarchicalDeliberate({cancelled,state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(seen[0].stamp.reason,'owned_screen');assert.equal(first.decisionSource,'claude');assert.equal(first.answers.move.choice,buy);
 const s2=shop(150,true),c2=decisionCandidates(s2);
 const second=await hierarchicalDeliberate({cancelled,state:s2,candidates:c2,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 stop();
 assert.equal(seen.length,1,'the list covers the next purchase');
 assert.equal(c2.find(x=>x.id===second.answers.move.choice).label.startsWith('Remove'),true);
}));

test('replay takes the reference choice for identical options and reports divergence once',()=>{
 const s=shop(),c=decisionCandidates(s),removeLabel=c.find(x=>x.label.startsWith('Remove')).label;
 const table=replayTable([{kind:'decision',state:s,candidates:c,chosen:{label:removeLabel}},{kind:'decision',state:fightState(),candidates:[{label:'x'}],chosen:{label:'x'}}]);
 assert.equal(Object.keys(table).length,1,'combat is never recorded');
 const replay={source:'ref',table,used:{},diverged:new Set()};
 assert.equal(replayChoice(replay,s,c).label,removeLabel);
 const changed=shop(200,true);
 assert.equal(replayChoice(replay,changed,decisionCandidates(changed)),null);
});

test('a replayed owned screen skips the strategist; a changed one is logged as divergence',()=>withDir(async dir=>{
 const channel=fileChannel(dir),status=newStrategyStatus({waitMs:300});
 status.plan=stampPlan(plan(),requestStamp({...shop(),state_type:'event',run:run(1)},[],'run_start'));
 const s=shop(),c=decisionCandidates(s),leave=c.find(x=>x.command.action==='proceed');
 const replay={source:'ref',table:replayTable([{kind:'decision',state:s,candidates:c,chosen:{label:leave.label}}]),used:{},diverged:new Set()};
 const r=await hierarchicalDeliberate({cancelled,state:s,candidates:c,strategist:{channel,status},replay,ask:()=>assert.fail('no Jev call')});
 assert.equal(r.decisionSource,'replay');assert.equal(r.answers.move.choice,leave.id);assert.equal(status.requests,0);
 const other=shop(200,true),oc=decisionCandidates(other);
 session(channel,()=>plan({allowed_option_ids:[oc.find(x=>x.command.action==='proceed').id]}));
 const d=await hierarchicalDeliberate({cancelled,state:other,candidates:oc,strategist:{channel,status},replay,ask:async q=>jev(Object.keys(q.questions.move.criteria)[0])});
 assert.ok(d.strategyEvents.some(e=>e.kind==='replay_diverged'));
}));

test('target selectors pick live enemies by HP, attack or a forecast kill',async()=>{
 const {resolveTarget,combatConstraints}=await import('./strategy.mjs');
 const rat=(id,hp,label,title='Aggressive')=>({entity_id:id,name:'Two-Tailed Rat',hp,max_hp:20,block:0,status:[],intents:[{title,label}]});
 const rats=[rat('a',20,'8'),rat('b',10,'3x2 (6)'),rat('c',5,'','Strategic')];
 assert.equal(resolveTarget('biggest_attack',rats).entity_id,'a');
 assert.equal(resolveTarget('lowest_hp',rats).entity_id,'c');
 assert.equal(resolveTarget('can_kill',rats,[{forecast:{defeatedEnemies:[{id:'b'}]}}]).entity_id,'b');
 assert.equal(resolveTarget('can_kill',rats,[]),null,'no kill available falls through');
 const hit=id=>({id:'hit'+id,label:'Strike',command:{action:'play_card',card_index:0,target:id},forecast:{survives:true,defeatedEnemies:[]}});
 const state={state_type:'monster',run:{live_id:'r'},player:{hp:50,max_hp:80},battle:{enemies:rats}};
 const r=combatConstraints(state,[hit('a'),hit('b'),hit('c')],{combat:{}},{plan:'x',target_priority:['can_kill','biggest_attack']});
 assert.deepEqual(r.candidates.map(c=>c.id),['hita'],'no kill available, so the biggest attacker is the focus');
});

test('owned screens: a confirmation is taken without asking, and a revisited shop reuses its list',()=>withDir(async dir=>{
 const channel=fileChannel(dir),status=newStrategyStatus({waitMs:300});
 status.plan=stampPlan(plan(),requestStamp({...shop(),state_type:'event',run:run(1)},[],'run_start'));
 const confirm={state_type:'card_select',run:run(6),player:{hp:60,max_hp:80,gold:100,deck:[],relics:[],potions:[],status:[]}};
 const one=[{id:'a0',label:'Confirm selected cards',command:{action:'confirm_selection'}}];
 const r=await hierarchicalDeliberate({cancelled,state:confirm,candidates:one,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(r.answers.move.choice,'a0');assert.equal(status.requests,0);
 const s=shop(),c=decisionCandidates(s),leave=c.find(x=>x.command.action==='proceed');
 status.screenChoices={[`run-1:1:6:shop`]:[JSON.stringify({command:leave.command,label:leave.label})]};
 const back=await hierarchicalDeliberate({cancelled,state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(back.answers.move.choice,leave.id);assert.equal(status.requests,0,'the remembered list is reused');
}));

test('a plan saved under the old uncounted key is offered as similar, not as the exact plan',async()=>{
 const {filePlaybook}=await import('./playbook.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'jev-pb-'));
 try{
  const book=filePlaybook(dir);await book.set('Bowlbug',{plan:'old plan',target_priority:[]});
  assert.equal(await book.get('Bowlbug x3'),null);
  assert.equal((await book.similar('Bowlbug x3')).plan,'old plan');
  assert.equal(await book.similar('Bowlbug'),null,'no similar plan for an uncounted key');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a saved fight plan keeps play_first, which the combat rules read from the playbook',async()=>{
 const {filePlaybook}=await import('./playbook.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'jev-pb-'));
 try{
  const book=filePlaybook(dir);
  await book.set('Sandpit x1',{plan:'escape',target_priority:[],play_first:['Struggle']});
  assert.deepEqual((await book.get('Sandpit x1')).play_first,['Struggle']);
  await book.set('Bowlbug x1',{plan:'hit',target_priority:[]});
  assert.equal('play_first' in await book.get('Bowlbug x1'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const pick=q=>jev(Object.keys(q.questions.move.criteria)[0]);
test('a fight plan from a mid-fight consult applies to that fight only and is not saved',()=>withDir(async dir=>{
 const channel=fileChannel(dir),playbook=filePlaybook(dir),status=newStrategyStatus({waitMs:5000}),seen=[],events=[];
 await playbook.set('Leader + Minion',{plan:'Kill the Leader.',target_priority:['Leader']},{source:'new_encounter',run:'run-1',floor:3});
 status.plan=stampPlan(plan(),requestStamp(fightState(),[],'new_encounter'));
 session(channel,()=>plan({fight:{plan:'Block everything this turn.',target_priority:[],play_first:['Strike']}}),seen);
 const s=fightState(2);s.player.hp=10;
 const asked=[];
 await hierarchicalDeliberate({cancelled,state:s,candidates:decisionCandidates(s),onEvent:e=>events.push(e),strategist:{channel,status,playbook},ask:async q=>{asked.push(q);return pick(q);}});
 assert.equal(seen[0].stamp.reason,'low_hp');
 assert.equal(asked[0].state.run_strategy.fight_plan.plan,'Block everything this turn.','Jev gets the mid-fight plan now');
 assert.equal(events.find(e=>e.kind==='strategy_adopted').fight_scope,'this_fight');
 const saved=await playbook.get('Leader + Minion');
 assert.equal(saved.plan,'Kill the Leader.');assert.equal(saved.source,'new_encounter');assert.equal('play_first' in saved,false);
 assert.deepEqual(status.fightPlan.play_first,['Strike']);
 // Later in the same fight the plan still applies, with its play_first enforced.
 const next=fightState(3);next.player.hp=10;const again=[];
 const r=await hierarchicalDeliberate({cancelled,state:next,candidates:decisionCandidates(next),strategist:{channel,status,playbook},ask:async q=>{again.push(q);return pick(q);}});
 assert.equal(seen.length,1,'no new consult');
 assert.equal(again[0].state.run_strategy.fight_plan.plan,'Block everything this turn.');
 assert.ok(r.constraint.rules.some(x=>x.kind==='play_first'));
 // The next fight with the same enemies gets the saved plan.
 const later=fightState(1,9),third=[];
 await hierarchicalDeliberate({cancelled,state:later,candidates:decisionCandidates(later),strategist:{channel,status,playbook},ask:async q=>{third.push(q);return pick(q);}});
 assert.equal(third[0].state.run_strategy.fight_plan.plan,'Kill the Leader.');
}));

test('play_first carries only within the run that saved it; a fight-start answer saves and ends a mid-fight plan',()=>withDir(async dir=>{
 const channel=fileChannel(dir),playbook=filePlaybook(dir),status=newStrategyStatus({waitMs:5000}),seen=[];
 await playbook.set('Leader + Minion',{plan:'Kill the Leader.',target_priority:[],play_first:['Strike']},{source:'elite_start',run:'run-0',floor:6});
 assert.equal(planForRun(await playbook.get('Leader + Minion'),'run-0').play_first[0],'Strike');
 assert.equal('play_first' in planForRun(await playbook.get('Leader + Minion'),'run-1'),false);
 status.plan=stampPlan(plan(),requestStamp({...fightState(),state_type:'event'},[],'run_start'));
 // A normal fight in another run: plan text only, play_first is not enforced.
 const s=fightState(),asked=[];
 const r=await hierarchicalDeliberate({cancelled,state:s,candidates:decisionCandidates(s),strategist:{channel,status,playbook},ask:async q=>{asked.push(q);return pick(q);}});
 assert.equal(asked[0].state.run_strategy.fight_plan.plan,'Kill the Leader.');
 assert.ok(!r.constraint?.rules?.some(x=>x.kind==='play_first'));
 // An elite start is shown the saved plan without play_first and answers with its own, which is saved for this run.
 status.fightPlan={fight_id:'run-1:1:7',encounter:'Leader + Minion',plan:'stale',target_priority:[],source:'low_hp'};
 session(channel,()=>plan({fight:{plan:'Strike the Leader first.',target_priority:['Leader'],play_first:['Strike']}}),seen);
 const e=fightState(1,7,'elite'),second=[];
 const r2=await hierarchicalDeliberate({cancelled,state:e,candidates:decisionCandidates(e),strategist:{channel,status,playbook},ask:async q=>{second.push(q);return pick(q);}});
 assert.equal(seen[0].stamp.reason,'elite_start');
 assert.equal(seen[0].brief.saved_fight_plan.plan,'Kill the Leader.');assert.equal('play_first' in seen[0].brief.saved_fight_plan,false);
 assert.equal(seen[0].brief.current_fight_plan.plan,'stale','a mid-fight plan of this fight is shown');
 assert.equal(status.fightPlan,null);
 const saved=await playbook.get('Leader + Minion');
 assert.equal(saved.run,'run-1');assert.deepEqual(saved.play_first,['Strike']);
 assert.equal(second[0].state.run_strategy.fight_plan.plan,'Strike the Leader first.');
 assert.ok(r2.constraint.rules.some(x=>x.kind==='play_first'));
}));

test('playbook-clean removes entries saved by mid-fight consults and keeps the rest',()=>{
 const book={entries:{A:{plan:'a',source:'new_encounter'},B:{plan:'b',source:'low_hp',play_first:['Strike'],floor:15},C:{plan:'c',source:'unknown_mechanic'},
  D:{plan:'d',source:'death_countdown'},E:{plan:'e',source:'post_run_review'},F:{plan:'f',source:'boss_start',play_first:['Bash']}}};
 const r=cleanPlaybook(book);
 assert.deepEqual(r.removed.map(x=>x.key),['B','C','D']);
 assert.deepEqual(Object.keys(r.book.entries),['A','E','F']);
 assert.deepEqual(r.other,[{key:'E',source:'post_run_review'}]);
 assert.equal(Object.keys(book.entries).length,6,'the input is not changed');
 assert.match(report(r,{path:'playbook.json',write:false}),/6 entries, 3 saved by a mid-fight consult would be removed[\s\S]*- B \(low_hp, floor 15, play_first Strike\): b/);
});
