import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {replanReason,escalationReason,constrainCandidates,validatePlan,requestStamp,stampPlan,strategistBrief,strategyContext,STRATEGIST_INSTRUCTIONS,PLAN_SCHEMA} from './strategy.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const run=(floor=5,act=1)=>({live_id:'run-1',act,floor,ascension:0});
const relic={id:'BURNING_BLOOD',name:'Burning Blood',description:'Heal 6.'};
const shop=(gold=200)=>({state_type:'shop',run:run(),player:{character:'Ironclad',hp:50,max_hp:80,gold,max_energy:3,deck:[{name:'Strike',cost:'1',description:'Deal 6 damage.'},{name:'Strike',cost:'1',description:'Deal 6 damage.'}],relics:[relic],potions:[],status:[]},
 shop:{items:[{index:0,category:'card',price:76,is_stocked:true,can_afford:true,card_name:'Ashen Strike',card_description:'Deal 6.'},
  {index:1,category:'card',price:150,is_stocked:true,can_afford:true,card_name:'Big',card_description:'Deal 30.'},
  {index:2,category:'card_removal',price:75,is_stocked:true,can_afford:true}]}});
const boss=()=>({state_type:'boss',run:run(16),player:{hp:60,max_hp:80,gold:90,energy:3,max_energy:3,block:0,deck:[],relics:[relic],potions:[],status:[],
 hand:[{index:0,id:'STRIKE',name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'}]},
 battle:{round:1,turn:'player',is_play_phase:true,enemies:[{entity_id:'b',name:'Boss',hp:200,max_hp:200,block:0,status:[],intents:[{type:'Attack',label:'12',description:'Attack for 12.'}]}]}});
const plan=(extra={})=>({archetype:'Strength',summary:'Scale strength, block big hits.',priorities:['Preserve HP'],
 combat:{risk_tolerance:'low',potion_policy:'Save for boss',focus:'Kill attackers first',hallway_potion_below_hp_percent:100,potion_reserve:0},fight:{plan:'',target_priority:[]},
 card_reward:{desired:['draw'],avoid:['weak attacks'],skip_when:'No scaling'},shop:{gold_reserve:0,priorities:['Remove Strike']},
 route:'Elites while HP > 60%',route_path:[],elite_min_hp_percent:0,rest:'Upgrade unless below 50%',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const adopted=(state,candidates,reason,extra)=>stampPlan(plan(extra),requestStamp(state,candidates,reason));
const jev=(choice,confidence=.9)=>({model:'jev-test',answers:{move:{type:'choice',choice,confidence,probabilities:{[choice]:confidence}}},usage:{input_tokens:100,output_tokens:1}});

test('deterministic triggers fire on run, act, boss, HP, shop and relic events only',()=>{
 const s=shop(),c=decisionCandidates(s);
 assert.equal(replanReason(s,null),'run_start');
 const p=adopted(s,c,'run_start');
 assert.equal(replanReason(s,p),null);
 assert.equal(replanReason({...s,run:run(5,2)},p),'new_act');
 const b=boss();
 assert.equal(replanReason(b,p),'boss_start');
 assert.equal(replanReason(b,adopted(b,[],'boss_start')),null);
 assert.equal(replanReason({...b,battle:{...b.battle,round:2}},p),null);
 const low=boss();low.battle.round=3;low.player.hp=15;
 assert.equal(replanReason(low,p),'low_hp');
 assert.equal(replanReason(low,adopted(low,[],'low_hp')),null);
 const other={...shop(),run:run(6)};
 assert.equal(replanReason(other,p,c),'owned_screen','the strategist decides every shop');
 assert.equal(replanReason(other,p,c.slice(0,1)),null,'a single option needs no decision');
 assert.equal(replanReason(other,p,[],{ownScreens:false}),'rich_shop');
 assert.equal(replanReason({...other,player:{...other.player,gold:100}},p,[],{ownScreens:false}),null);
 const newRelic={...shop(100),state_type:'rewards',run:run(8)};newRelic.player.relics=[relic,{id:'VAJRA',name:'Vajra',description:'+1 Strength.'}];
 assert.equal(replanReason(newRelic,p),'new_relic');
 assert.equal(replanReason({...newRelic,run:run(7)},p),'new_relic','any new relic triggers, even soon after the last plan');
 assert.equal(replanReason({...newRelic,state_type:'monster'},p),null,'but not in combat');
});

test('escalation needs an important screen, low confidence and no plan for this screen',()=>{
 const s=shop(),c=decisionCandidates(s),p=adopted({...s,run:run(4)},c,'run_start');
 assert.equal(escalationReason(s,{confidence:.2},p,.35),'jev_uncertain');
 assert.equal(escalationReason(s,{confidence:.5},p,.35),null);
 assert.equal(escalationReason(s,{confidence:.2},adopted(s,c,'rich_shop'),.35),null);
 assert.equal(escalationReason(boss(),{confidence:.1},p,.35),null);
 assert.equal(escalationReason(s,{confidence:null},p,.35),null);
});

test('constrained mode enforces allowed options and gold reserve; advisory mode only informs',()=>{
 const s=shop(),c=decisionCandidates(s);
 const p=adopted(s,c,'rich_shop',{allowed_option_ids:['a2','a3']});
 // Owned screens take the first listed option still offered.
 assert.deepEqual(constrainCandidates(s,c,p),{candidates:[c[2]],constraint:{kind:'strategist_choice',removed:3,removed_ids:['a0','a1','a3'],remembered:false}});
 const rewards={...s,state_type:'rewards'},rp=adopted(rewards,c,'new_relic',{allowed_option_ids:['a2','a3']});
 assert.deepEqual(constrainCandidates(rewards,c,rp).candidates.map(x=>x.id),['a2','a3'],'other screens keep a filtered set');
 assert.equal(constrainCandidates(s,c,p,'advisory').candidates.length,4);
 assert.deepEqual(strategyContext(p,s).recommended_options,['Remove a card — 75 gold','Continue to the map']);
 // The same index with a different label is a different option.
 const relabeled=c.map(x=>x.id==='a2'?{...x,label:'Something else — 75 gold'}:x);
 assert.deepEqual(constrainCandidates(s,relabeled,p).candidates.map(x=>x.id),['a3'],'the next listed option is taken');
 const reserve=adopted({...s,run:run(4)},c,'run_start',{shop:{gold_reserve:150,priorities:[]}});
 assert.deepEqual(constrainCandidates(s,c,reserve).candidates.map(x=>x.id),['a3'],'every purchase would breach the reserve');
 const rich=shop(260);
 assert.deepEqual(constrainCandidates(rich,decisionCandidates(rich),reserve).candidates.map(x=>x.id),['a0','a2','a3']);
 assert.equal(constrainCandidates({...s,run:{...run(),live_id:'other'}},c,p).constraint,null);
});

test('plan validation rejects missing, extra and out-of-range fields',()=>{
 assert.deepEqual(validatePlan(plan()),[]);
 const {route,...missing}=plan();
 assert.match(validatePlan(missing).join(),/route is required/);
 assert.match(validatePlan({...plan(),extra:1}).join(),/extra is not allowed/);
 assert.match(validatePlan(plan({combat:{...plan().combat,risk_tolerance:'reckless'}})).join(),/one of/);
 assert.match(validatePlan(plan({replan_below_hp_percent:90})).join(),/10-60/);
 assert.match(validatePlan(plan({priorities:['a','b','c','d','e','f']})).join(),/at most 5/);
});

test('the strategist brief is compact run context without combat piles',()=>{
 const s=shop(),brief=strategistBrief(s,decisionCandidates(s),'rich_shop',null);
 assert.deepEqual(brief.deck,[{name:'Strike',cost:'1',description:'Deal 6 damage.',count:2}]);
 assert.equal(brief.current_options.length,4);
 const b=strategistBrief(boss(),[],'boss_start',{...plan(),run_id:'run-1'});
 assert.equal(b.current_options,undefined);assert.equal(b.enemies[0].name,'Boss');assert.equal(b.previous_plan.archetype,'Strength');
 const other=strategistBrief(boss(),[],'run_start',{...plan(),run_id:'another-run'});
 assert.equal(other.previous_plan,undefined,'a plan from another run is not shown');
 assert.ok(b.combat_state,'combat consults include the player side');assert.equal(JSON.stringify(b).includes('draw_pile":['),false,'pile contents stay out; counts only');
 const small=boss();small.player={...small.player,draw_pile:[{name:'Strike'},{name:'Expect a Fight'},{name:'Taunt'}]};
 assert.deepEqual(strategistBrief(small,[],'low_hp',{...plan(),run_id:'run-1'}).combat_state.draw_cards,['Expect a Fight','Strike','Taunt'],'a small draw pile is listed by name, sorted');
 small.player.draw_pile=Array.from({length:11},()=>({name:'Strike'}));
 assert.equal(strategistBrief(small,[],'low_hp',{...plan(),run_id:'run-1'}).combat_state.draw_cards,undefined,'large piles stay counts only');
});

async function withChannel(fn){
 const dir=await mkdtemp(join(tmpdir(),'jev-strategy-'));
 try{return await fn(fileChannel(dir),dir);}finally{await rm(dir,{recursive:true,force:true});}
}
// Plays the Claude session: answers the first request it sees.
function session(channel,makePlan){
 let stop=false;
 (async()=>{while(!stop){const r=await channel.pending();if(r){await channel.answer(r.id,makePlan(r));return;}await new Promise(x=>setTimeout(x,50));}})();
 return ()=>{stop=true;};
}

test('a request is pending until answered, and not once its answer is waiting or taken',()=>withChannel(async channel=>{
 const r=await channel.post({stamp:{reason:'x'}});
 assert.equal((await channel.pending()).id,r.id);
 await channel.answer(r.id,{});
 assert.equal(await channel.pending(),null,'answered, not yet taken');
 assert.equal((await channel.take(r.id)).id,r.id);
 assert.equal(await channel.pending(),null);assert.equal(await channel.current(),null);
}));

test('run start waits for the session plan, then Jev sees it and Claude-constrained options',()=>withChannel(async channel=>{
 const s=shop(),c=decisionCandidates(s),status=newStrategyStatus({enabled:true,waitMs:5000}),requests=[];
 status.ownScreens=false;
 const stop=session(channel,r=>plan({allowed_option_ids:['a0','a3'],option_note:'Buy Ashen Strike, then leave.'}));
 const result=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},
  ask:async q=>{requests.push(q);return jev('a0');}});
 stop();
 assert.equal(status.requests,1);assert.equal(status.answers,1);
 assert.equal(status.plan.reason,'run_start');assert.equal(status.plan.run_id,'run-1');
 assert.deepEqual(Object.keys(requests[0].questions.move.criteria),['a0','a3']);
 assert.equal(requests[0].state.run_strategy.current_screen_note,'Buy Ashen Strike, then leave.');
 assert.deepEqual(result.constraint,{kind:'allowed_options',removed:2,removed_ids:['a1','a2']});
 assert.deepEqual(result.strategyEvents.map(e=>e.kind),['strategy_request','strategy_adopted']);
 assert.equal(await channel.current(),null,'answered request is consumed');
}));

test('a single allowed option is taken without a Jev call',()=>withChannel(async channel=>{
 const s=shop(),c=decisionCandidates(s),status=newStrategyStatus({waitMs:5000});
 const stop=session(channel,()=>plan({allowed_option_ids:['a3']}));
 const result=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},ask:()=>assert.fail('No Jev call expected')});
 stop();
 assert.equal(result.decisionSource,'claude');assert.equal(result.answers.move.choice,'a3');
}));

test('uncertain Jev on a run-shaping screen escalates once and re-asks with the new plan',()=>withChannel(async channel=>{
 const s=shop(),c=decisionCandidates(s),status=newStrategyStatus({waitMs:5000,ownScreens:false});
 status.plan=adopted({...s,run:run(4),player:{...s.player,gold:100}},c,'run_start');
 const stop=session(channel,r=>{assert.equal(r.stamp.reason,'jev_uncertain');return plan({allowed_option_ids:['a2','a3']});});
 const asked=[];
 const result=await hierarchicalDeliberate({state:shop(120),candidates:decisionCandidates(shop(120)),strategist:{channel,status},
  ask:async q=>{asked.push(Object.keys(q.questions.move.criteria));return jev(asked.length===1?'a0':'a2',asked.length===1?.2:.8);}});
 stop();
 assert.deepEqual(asked,[['a0','a1','a2','a3'],['a2','a3']]);
 assert.equal(result.answers.move.choice,'a2');assert.equal(result.escalatedFrom.choice,'a0');
 assert.deepEqual(result.usage,{input_tokens:200,output_tokens:2});
}));

test('Claude strategy mode waits for the answer and never falls back to Jev',()=>withChannel(async channel=>{
 const s=shop(100),c=decisionCandidates(s),status=newStrategyStatus({ownScreens:false});
 let settled=false;
 const pending=hierarchicalDeliberate({state:s,candidates:c,strategist:{channel,status},ask:async()=>jev('a3')}).then(r=>{settled=true;return r;});
 await new Promise(r=>setTimeout(r,2500));
 assert.equal(settled,false,'still waiting for Claude');assert.equal(status.requests,1);
 const request=await channel.current();
 await channel.answer(request.id,plan());
 const result=await pending;
 assert.equal(status.plan.reason,'run_start');
 assert.deepEqual(result.strategyEvents.map(e=>e.kind),['strategy_request','strategy_adopted']);
}));

test('forced transitions never consult Claude',()=>withChannel(async channel=>{
 const b=boss();b.player.hand=[];b.battle.round=2;
 const status=newStrategyStatus({waitMs:5000});
 const result=await hierarchicalDeliberate({state:b,candidates:decisionCandidates(b),strategist:{channel,status},ask:()=>assert.fail('forced')});
 assert.equal(result.decisionSource,'forced');assert.equal(status.requests,0);
}));

test('pausing during a wait cancels the decision',()=>withChannel(async channel=>{
 const s=shop(),status=newStrategyStatus({waitMs:5000});let calls=0;
 await assert.rejects(hierarchicalDeliberate({state:s,candidates:decisionCandidates(s),strategist:{channel,status},cancelled:()=>++calls>1,ask:()=>assert.fail()}),/cancelled/);
}));

test('the CLI validates plans and answers only the request that was read',()=>withChannel(async (channel,dir)=>{
 const cli=(...args)=>promisify(execFile)(process.execPath,[resolve(here,'strategy-cli.mjs'),...args],{env:{...process.env,STRATEGY_DIR:dir}});
 const s=shop(),c=decisionCandidates(s);
 const request=await channel.post({key:'k',brief:{},stamp:requestStamp(s,c,'rich_shop')});
 assert.match((await cli('wait')).stdout,new RegExp(request.id));
 assert.match((await cli('show')).stdout,/"brief"/);
 const file=join(dir,'plan.json');
 await writeFile(file,JSON.stringify(plan({allowed_option_ids:['a9']})));
 await assert.rejects(cli('answer',request.id,file),/a9 is not an option/);
 await writeFile(file,JSON.stringify(plan()));
 await assert.rejects(cli('answer','wrong-id',file),/replaced/);
 assert.match((await cli('answer',request.id,file)).stdout,/Delivered/);
 assert.equal((await channel.take(request.id)).plan.archetype,'Strength');
}));

test('every run-shaping screen type is owned, independent of Jev confidence',async()=>{
 const {OWNED_SCREENS,isOwnedScreen}=await import('./strategy.mjs');
 for(const t of ['card_reward','shop','fake_merchant','event','rest_site','treasure','hextech_rune','card_select','bundle_select','relic_select','crystal_sphere'])assert.ok(OWNED_SCREENS.has(t),t);
 assert.equal(isOwnedScreen({state_type:'card_select',battle:{}}),false,'in-combat card choices stay with Jev');
});

test('reward screens are owned only for a potion swap',async()=>{
 const {isOwnedScreen}=await import('./strategy.mjs');
 const rewards=(potions,items)=>({state_type:'rewards',player:{potions:Array(potions).fill({name:'P'}),max_potion_slots:3},rewards:{items}});
 assert.equal(isOwnedScreen(rewards(3,[{type:'potion',description:'Fire Potion'}])),true);
 assert.equal(isOwnedScreen(rewards(2,[{type:'potion',description:'Fire Potion'}])),false,'a free slot needs no decision');
 assert.equal(isOwnedScreen(rewards(3,[{type:'gold',description:'17 Gold'}])),false);
});

test('an answered event option does not carry to a later page whose same-named option costs more',()=>{
 const page=dmg=>({state_type:'event',run:{live_id:'run-1',act:1,floor:4},player:{hp:60,max_hp:82},
  event:{event_id:'ABYSSAL_BATHS',body:'x',options:[]}});
 const cands=dmg=>[{id:'a0',label:'Linger',command:{action:'choose_event_option',index:0},details:{title:'Linger',description:`Gain 2 Max HP. Take ${dmg} damage.`}},
  {id:'a1',label:'Exit Baths',command:{action:'choose_event_option',index:1},details:{title:'Exit Baths',description:''}}];
 const base={...plan(),run_id:'run-1',allowed_option_ids:['a0']};
 const stamped=stampPlan(base,requestStamp(page(4),cands(4),'owned_screen'));
 const first=constrainCandidates(page(4),cands(4),stamped);
 assert.equal(first.constraint?.kind,'strategist_choice');
 const later=constrainCandidates(page(12),cands(12),stamped);
 assert.notEqual(later.constraint?.kind,'strategist_choice','Linger at 12 damage is a new choice');
 assert.equal(replanReason(page(12),stamped,cands(12)),'owned_screen');
});

test('the CLI reports a replaced request, no pending request and invalid JSON in one line',()=>withChannel(async (channel,dir)=>{
 const cli=(...args)=>promisify(execFile)(process.execPath,[resolve(here,'strategy-cli.mjs'),...args],{env:{...process.env,STRATEGY_DIR:dir}});
 const failure=args=>cli(...args).then(()=>assert.fail('expected exit 1'),e=>{assert.equal(e.code,1);return e.stderr.trim();});
 const file=join(dir,'plan.json');
 await writeFile(file,JSON.stringify(plan()));
 assert.equal(await failure(['answer','r1',file]),'No strategy request is pending.');
 const s=shop(),request=await channel.post({key:'k',brief:{},stamp:requestStamp(s,decisionCandidates(s),'owned_screen')});
 assert.equal(await failure(['answer','old-id',file]),`Request old-id was replaced by ${request.id}; read it with "show" and answer that one.`);
 await writeFile(file,'{"archetype":');
 assert.match(await failure(['answer',request.id,file]),/^\S*plan\.json is not valid JSON: [^\n]+$/);
 assert.equal(await failure(['answer',request.id,join(dir,'missing.json')]),`Cannot read ${join(dir,'missing.json')}: ENOENT`);
}));

test('the strategist instructions name every plan field and the enforced combat rules',()=>{
 for(const field of Object.keys(PLAN_SCHEMA.properties))assert.match(STRATEGIST_INSTRUCTIONS,new RegExp(`\\b${field}\\b`,'i'),field);
 assert.match(STRATEGIST_INSTRUCTIONS,/- summary: the run plan in one or two sentences/);
 for(const rule of ['heal_potion_waste','idle_potion','countdown_escape'])assert.ok(STRATEGIST_INSTRUCTIONS.includes(rule),rule);
 assert.match(STRATEGIST_INSTRUCTIONS,/play_first[^\n]*saved with the fight plan[^\n]*It yields when/);
 assert.match(STRATEGIST_INSTRUCTIONS,/not to kill an enemy, or to hold back in any way, must say when to stop/);
 // The late Act 1 elite rule names rests_before_boss_rest by its value in the four losses (0).
 assert.match(STRATEGIST_INSTRUCTIONS,/rests_before_boss_rest[^\n]*with 0, take an optional Act 1 elite only near full HP; with 1 or more, the elite is fine/);
 assert.doesNotMatch(STRATEGIST_INSTRUCTIONS,/jev_uncertain/,'jev_uncertain never fires in combat');
});
