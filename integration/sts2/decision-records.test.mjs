// What the runner's decision and strategy records say: when a request is logged, and which
// decision source a move gets (rule, filtered, claude with its screen choice).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {requestStamp,stampPlan} from './strategy.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';

const run=(floor=5)=>({live_id:'run-1',act:1,floor,ascension:0});
const relic={id:'BURNING_BLOOD',name:'Burning Blood',description:'Heal 6.'};
const items=()=>[{index:0,category:'card',price:76,is_stocked:true,can_afford:true,card_name:'Ashen Strike',card_description:'Deal 6.'},
 {index:1,category:'card',price:150,is_stocked:true,can_afford:true,card_name:'Big',card_description:'Deal 30.'},
 {index:3,category:'relic',price:150,is_stocked:true,can_afford:true,relic_id:'VAJRA',relic_name:'Vajra',relic_description:'+1 Strength.'}];
const shop=({relics=[relic],stock=items()}={})=>({state_type:'shop',run:run(),player:{character:'Ironclad',hp:50,max_hp:80,gold:400,max_energy:3,
 deck:[{name:'Strike',cost:'1',description:'Deal 6 damage.'}],relics,potions:[],status:[]},shop:{items:stock}});
const plan=(extra={})=>({archetype:'Strength',summary:'Scale strength.',priorities:['Preserve HP'],
 combat:{risk_tolerance:'low',potion_policy:'Save for boss',focus:'',hallway_potion_below_hp_percent:50,potion_reserve:0},fight:{plan:'',target_priority:[]},
 card_reward:{desired:[],avoid:[],skip_when:''},shop:{gold_reserve:0,priorities:[]},
 route:'',route_path:[],elite_min_hp_percent:0,rest:'',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const idOf=(c,action,index)=>c.find(x=>x.command.action===action&&(index==null||x.command.index===index)).id;

async function withChannel(fn){
 const dir=await mkdtemp(join(tmpdir(),'jev-records-'));
 try{return await fn(fileChannel(dir));}finally{await rm(dir,{recursive:true,force:true});}
}
function session(channel,makePlan){
 let stop=false;
 (async()=>{while(!stop){const r=await channel.pending();if(r){await channel.answer(r.id,makePlan(r));return;}await new Promise(x=>setTimeout(x,50));}})();
 return ()=>{stop=true;};
}

test('a strategy request is logged when posted, with its brief, even if the wait is cancelled',()=>withChannel(async channel=>{
 const s=shop(),status=newStrategyStatus({waitMs:5000}),seen=[];let calls=0;
 await assert.rejects(hierarchicalDeliberate({state:s,candidates:decisionCandidates(s),strategist:{channel,status},onEvent:e=>{seen.push(e);},
  cancelled:()=>++calls>1,ask:()=>assert.fail('no Jev call')}),/cancelled/);
 const posted=await channel.current();
 assert.equal(seen.length,1);
 const [q]=seen;
 assert.equal(q.kind,'strategy_request');assert.equal(q.request_id,posted.id);assert.equal(q.createdAt,posted.createdAt);
 assert.equal(q.reason,'run_start');assert.equal(q.key,posted.key);assert.equal(q.run_id,'run-1');
 assert.deepEqual([q.state_type,q.act,q.floor],['shop',1,5]);
 assert.deepEqual(JSON.parse(JSON.stringify(q.brief)),posted.brief,'the brief the strategist is shown');
}));

test('an adoption records the request time and the answer time, and each event reaches onEvent once',()=>withChannel(async channel=>{
 const s=shop(),c=decisionCandidates(s),status=newStrategyStatus({waitMs:5000}),seen=[];
 const stop=session(channel,()=>plan({allowed_option_ids:[idOf(c,'shop_purchase',0)]}));
 const result=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},onEvent:async e=>{seen.push(e);},ask:()=>assert.fail('no Jev call')});
 stop();
 assert.deepEqual(seen.map(e=>e.kind),['strategy_request','strategy_adopted']);
 assert.deepEqual(result.strategyEvents,seen);
 const [q,a]=seen;
 assert.equal(a.requestCreatedAt,q.createdAt);assert.equal(a.answeredAt,status.plan.answeredAt);
 assert.ok(Date.parse(a.answeredAt)>=Date.parse(q.createdAt));
}));

test('a strategist screen choice records whether it came from this consult or a remembered answer',()=>withChannel(async channel=>{
 const s=shop(),c=decisionCandidates(s),status=newStrategyStatus({waitMs:5000});
 const stop=session(channel,()=>plan({allowed_option_ids:[idOf(c,'shop_purchase',0)]}));
 const first=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 stop();
 assert.equal(first.decisionSource,'claude');assert.equal(first.constraint.kind,'strategist_choice');
 assert.deepEqual(first.screenChoice,{source:'consult',floor:5,request_id:status.plan.request_id});
 const again=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},cancelled:()=>true,ask:()=>assert.fail('no Jev call')});
 assert.equal(again.decisionSource,'claude');
 assert.deepEqual(again.screenChoice,{source:'remembered',floor:5,request_id:status.plan.request_id});
}));

test('a combat rule that leaves one option is labeled rule with its name, not claude',async()=>{
 const state={state_type:'monster',run:run(6),player:{character:'Ironclad',hp:60,max_hp:80,energy:3,max_energy:3,block:0,gold:50,deck:[],relics:[relic],
  potions:[{slot:0,id:'FIRE',name:'Fire Potion',description:'Deal 20 damage.',can_use_in_combat:true}],status:[],
  hand:[{index:0,id:'STRIKE',name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'}]},
  battle:{round:2,turn:'player',is_play_phase:true,enemies:[{entity_id:'e',name:'Slime',hp:20,max_hp:20,block:0,status:[],intents:[]}]}};
 const forecast={quality:'partial',survives:true,defeatedEnemies:[]};
 const candidates=[{id:'potion',label:'Fire Potion',command:{action:'use_potion',slot:0},forecast},
  {id:'strike',label:'Strike',command:{action:'play_card',card_index:0},forecast}];
 const status=newStrategyStatus({waitMs:5000});
 status.plan=stampPlan(plan(),requestStamp(state,candidates,'run_start'));
 const channel={current:async()=>null,take:async()=>null,post:async()=>assert.fail('no consult')};
 const result=await hierarchicalDeliberate({state,candidates,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(result.decisionSource,'rule');assert.equal(result.rule,'hallway_potion');
 assert.equal(result.answers.move.choice,'strike');assert.equal(result.constraint.kind,'combat');
});

test('one candidate on an owned screen from the runner filter is filtered, not forced',async()=>{
 const s=shop(),c=decisionCandidates(s).filter(x=>x.command.action==='proceed');
 assert.equal(c.length,1);
 const status=newStrategyStatus({waitMs:5000});status.plan=stampPlan(plan(),requestStamp(s,c,'run_start'));
 const channel={current:async()=>null,take:async()=>null,post:async()=>assert.fail('no consult')};
 const result=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(result.decisionSource,'filtered');
});

test('a relic bought from the strategist list does not trigger new_relic; another new relic does',()=>withChannel(async channel=>{
 const s=shop(),c=decisionCandidates(s),status=newStrategyStatus({waitMs:5000});
 const stop=session(channel,()=>plan({allowed_option_ids:[idOf(c,'shop_purchase',3),idOf(c,'shop_purchase',0)]}));
 const bought=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 stop();
 assert.equal(c.find(x=>x.id===bought.answers.move.choice).command.index,3);
 const vajra={id:'VAJRA',name:'Vajra',description:'+1 Strength.'};
 const after=shop({relics:[relic,vajra],stock:items().filter(i=>i.index!==3)}),ca=decisionCandidates(after);
 const requests=status.requests;
 const next=await hierarchicalDeliberate({state:after,candidates:ca,strategist:{channel,status},cancelled:()=>true,ask:()=>assert.fail('no Jev call')});
 assert.equal(status.requests,requests,'no new_relic consult');
 assert.equal(ca.find(x=>x.id===next.answers.move.choice).command.index,0,'the list continues');
 assert.ok(status.plan.relic_ids.includes('VAJRA'));
 // A relic from somewhere else still asks.
 const other=shop({relics:[relic,vajra,{id:'ANCHOR',name:'Anchor',description:'Block.'}],stock:items().filter(i=>i.index!==3)});
 await assert.rejects(hierarchicalDeliberate({state:other,candidates:decisionCandidates(other),strategist:{channel,status},cancelled:()=>true,ask:()=>assert.fail('no Jev call')}),/cancelled/);
 assert.equal((await channel.current()).stamp.reason,'new_relic');
}));

test('a combat rule that only records a lift does not claim a lone option; it stays single_option with the lift kept',async()=>{
 const state={state_type:'elite',run:run(6),player:{character:'Ironclad',hp:20,max_hp:80,energy:3,max_energy:3,block:0,gold:50,deck:[],relics:[relic],
  potions:[{slot:0,id:'FIRE',name:'Fire Potion',description:'Deal 20 damage.',can_use_in_combat:true}],status:[],hand:[]},
  battle:{round:2,turn:'player',is_play_phase:true,enemies:[{entity_id:'e',name:'Slime',hp:20,max_hp:20,block:0,status:[],intents:[]}]}};
 const candidates=[{id:'potion',label:'Fire Potion',command:{action:'use_potion',slot:0},forecast:{quality:'partial',survives:true,defeatedEnemies:[]}}];
 const status=newStrategyStatus({waitMs:5000});
 status.plan=stampPlan(plan({combat:{...plan().combat,potion_reserve:1,hallway_potion_below_hp_percent:40}}),requestStamp(state,candidates,'run_start'));
 const channel={current:async()=>null,take:async()=>null,post:async()=>assert.fail('no consult')};
 const result=await hierarchicalDeliberate({state,candidates,strategist:{channel,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(result.decisionSource,'single_option');
 assert.equal(result.constraint?.removed,0);assert.equal(result.constraint?.lifted?.[0]?.reason,'below_hallway_floor');
});
