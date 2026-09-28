import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {encounterKey,currentEncounter,filePlaybook} from './playbook.mjs';
import {replayTable,replayChoice} from './replay.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';
import {requestStamp,stampPlan} from './strategy.mjs';

const run=(floor=5)=>({live_id:'run-1',act:1,floor,ascension:0});
const plan=(extra={})=>({archetype:'x',summary:'x',priorities:[],combat:{risk_tolerance:'low',potion_policy:'',focus:'',hallway_potion_below_hp_percent:100},
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
const sessions=[];
async function withDir(fn){const dir=await mkdtemp(join(tmpdir(),'jev-pb-'));try{return await fn(dir);}finally{sessions.splice(0).forEach(s=>s());await rm(dir,{recursive:true,force:true});}}
function session(channel,makePlan,seen=[]){
 let stop=false;
 (async()=>{while(!stop){const r=await channel.current();if(r&&!(await channel.pendingAnswer())){seen.push(r);await channel.answer(r.id,makePlan(r));}await new Promise(x=>setTimeout(x,30));}})();
 const halt=()=>{stop=true;};sessions.push(halt);return halt;
}

test('encounter keys ignore order, duplicates and form suffixes, and stay fixed for the fight',()=>{
 assert.equal(encounterKey([{name:'Kin Follower'},{name:'Kin Priest'},{name:'Kin Follower'}]),'Kin Follower + Kin Priest');
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
 const result=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status,playbook},ask:async q=>{asked.push(q);return jev(Object.keys(q.questions.move.criteria)[0]);}});
 assert.equal(seen[0].stamp.reason,'new_encounter');assert.equal(seen[0].brief.encounter,'Leader + Minion');
 assert.deepEqual((await playbook.get('Leader + Minion')).target_priority,['Leader']);
 assert.deepEqual(asked[0].state.run_strategy.fight_plan,{plan:'Kill the Leader; minions leave.',target_priority:['Leader']});
 const kept=Object.keys(asked[0].questions.move.criteria).map(id=>c.find(x=>x.id===id));
 assert.ok(kept.every(x=>x.command.target!=='m'),'plays at the minion are removed');
 assert.ok(result.constraint.rules.some(r=>r.kind==='target_priority'));
 // The same encounter later (another floor) needs no request and still gets the plan.
 const later=fightState(1,9),before=seen.length;
 const again=[];
 await hierarchicalDeliberate({state:later,candidates:decisionCandidates(later),strategist:{channel,status,playbook},ask:async q=>{again.push(q);return jev(Object.keys(q.questions.move.criteria)[0]);}});
 assert.equal(seen.length,before);assert.equal(again[0].state.run_strategy.fight_plan.plan,'Kill the Leader; minions leave.');
 // A different encounter does not see it.
 const other=fightState(1,11);other.battle.enemies=[{entity_id:'x',name:'Other',hp:10,max_hp:10,block:0,status:[],intents:[]}];
 status.encountersAsked.push('run-1:1:11');
 const third=[];
 await hierarchicalDeliberate({state:other,candidates:decisionCandidates(other),strategist:{channel,status,playbook},ask:async q=>{third.push(q);return jev(Object.keys(q.questions.move.criteria)[0]);}});
 stop();
 assert.equal(third[0].state.run_strategy.fight_plan,undefined);
}));

test('Claude decides owned screens: an ordered shop list runs without Jev and without re-asking',()=>withDir(async dir=>{
 const channel=fileChannel(dir),status=newStrategyStatus({waitMs:5000}),seen=[];
 status.plan=stampPlan(plan(),requestStamp({...shop(),state_type:'event',run:run(1)},[],'run_start'));
 const s=shop(),c=decisionCandidates(s);
 const buy=c.find(x=>x.label.startsWith('Anger')).id,remove=c.find(x=>x.label.startsWith('Remove')).id,leave=c.find(x=>x.command.action==='proceed').id;
 const stop=session(channel,()=>plan({allowed_option_ids:[buy,remove,leave]}),seen);
 const first=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(seen[0].stamp.reason,'owned_screen');assert.equal(first.decisionSource,'claude');assert.equal(first.answers.move.choice,buy);
 const s2=shop(150,true),c2=decisionCandidates(s2);
 const second=await hierarchicalDeliberate({state:s2,candidates:c2,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
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
 const r=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},replay,ask:()=>assert.fail('no Jev call')});
 assert.equal(r.decisionSource,'replay');assert.equal(r.answers.move.choice,leave.id);assert.equal(status.requests,0);
 const other=shop(200,true);
 const d=await hierarchicalDeliberate({state:other,candidates:decisionCandidates(other),strategist:{channel,status},replay,ask:async q=>jev(Object.keys(q.questions.move.criteria)[0])});
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
 const r=await hierarchicalDeliberate({state:confirm,candidates:one,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(r.answers.move.choice,'a0');assert.equal(status.requests,0);
 const s=shop(),c=decisionCandidates(s),leave=c.find(x=>x.command.action==='proceed');
 status.screenChoices={[`run-1:1:6:shop`]:[JSON.stringify({command:leave.command,label:leave.label})]};
 const back=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(back.answers.move.choice,leave.id);assert.equal(status.requests,0,'the remembered list is reused');
}));
