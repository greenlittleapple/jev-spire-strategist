// Rule records: removed option IDs, lifts with a reason, the Regal Pillow heal, review forecasts
// and the majority rule for leaving a shop (jev-compact-v3.2).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {combatConstraints,constrainCandidates,restConstraint} from './strategy.mjs';
import {efficientDeliberate,majorityLeave} from './efficient-decisions.mjs';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {computedFacts,restHeal,FACTS_POLICY,FACTS_V3_POLICY,STRATEGY_FACTS_POLICY} from './route-facts.mjs';

const enemy=(entity_id,name,hp,status=[])=>({entity_id,name,hp,max_hp:100,status});
const fight=({type='monster',hp=60,enemies=[enemy('a','Leader',50)]}={})=>({state_type:type,run:{live_id:'run',act:1,floor:5},
 player:{hp,max_hp:80},battle:{round:2,enemies}});
const cand=(id,command,forecast={})=>({id,label:id,command,forecast:{quality:'partial',survives:true,defeatedEnemies:[],...forecast}});
const plan=combat=>({run_id:'run',combat:{risk_tolerance:'low',potion_policy:'',focus:'',hallway_potion_below_hp_percent:100,potion_reserve:0,...combat}});
const withPotions=(s,n)=>({...s,player:{...s.player,potions:Array.from({length:n},(_,i)=>({name:'P'+i,slot:i}))}});

test('each rule records the IDs it removed; a rule that fires records no lift',()=>{
 const cands=[cand('fatal',{action:'play_card',card_index:0},{survives:false}),cand('potion',{action:'use_potion',slot:0}),cand('end',{action:'end_turn'})];
 const r=combatConstraints(withPotions(fight({hp:60}),1),cands,plan({hallway_potion_below_hp_percent:50}));
 assert.deepEqual(r.rules.map(x=>[x.kind,x.removed_ids]),[['avoid_fatal',['fatal']],['hallway_potion',['potion']]]);
 assert.deepEqual(r.lifted,[]);
});

test('the potion reserve records a lift below the hallway floor and when every reserve-keeping line dies',()=>{
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'a'}),cand('potion',{action:'use_potion',slot:0}),cand('end',{action:'end_turn'})];
 const p=plan({potion_reserve:1,hallway_potion_below_hp_percent:40});
 const low=combatConstraints(withPotions(fight({type:'elite',hp:20}),1),cands,p);
 assert.deepEqual(low.lifted,[{kind:'potion_reserve',reason:'below_hallway_floor',would_remove:1,held:1,reserve:1,hp_percent:25,floor:40}]);
 assert.equal(low.candidates.length,3,'a lift changes nothing about the options');
 const dying=cands.map(c=>c.id==='potion'?c:{...c,forecast:{...c.forecast,survives:false}});
 assert.deepEqual(combatConstraints(withPotions(fight({type:'elite',hp:60}),1),dying,p).lifted.map(l=>[l.kind,l.reason]),[['potion_reserve','others_die']]);
 // Nothing to remove (a spare potion), so nothing to record.
 assert.deepEqual(combatConstraints(withPotions(fight({type:'elite',hp:20}),2),cands,p).lifted,[]);
 // Inactive in a boss fight: not a lift.
 assert.deepEqual(combatConstraints(withPotions(fight({type:'boss',hp:20}),1),cands,p).lifted,[]);
});

test('hallway and heal rules record a lift when every other line dies',()=>{
 const cands=[cand('potion',{action:'use_potion',slot:0}),cand('strike',{action:'play_card',card_index:1},{survives:false})];
 const r=combatConstraints(fight({hp:60}),cands,plan({hallway_potion_below_hp_percent:50}));
 assert.deepEqual(r.lifted.map(l=>[l.kind,l.reason,l.would_remove]),[['hallway_potion','others_die',1]]);
 const potion={name:'Blood Potion',description:'Heal for 20% of your Max HP.',slot:0};
 const s={...fight({type:'boss',hp:85}),player:{hp:85,max_hp:90,potions:[potion]}};
 const heal=combatConstraints(s,[cand('drink',{action:'use_potion',slot:0}),cand('end',{action:'end_turn'},{survives:false})],null);
 assert.deepEqual(heal.lifted.map(l=>[l.kind,l.reason]),[['heal_potion_waste','others_die']]);
});

test('play_first and countdown_escape record why they stepped aside',()=>{
 const st={...fight({type:'boss'}),player:{hp:40,max_hp:80,energy:4,hand:[{index:0,name:'Juggernaut',cost:'2',can_play:true,description:'x'},{index:1,name:'Uppercut+',cost:'2',can_play:true,description:'y'}]}};
 const fp={plan:'x',target_priority:[],play_first:['Juggernaut']};
 const lines=[cand('jug',{action:'play_card',card_index:0},{hpLoss:27}),cand('upper',{action:'play_card',card_index:1,target:'a'},{hpLoss:3}),cand('end',{action:'end_turn'},{hpLoss:30})];
 assert.deepEqual(combatConstraints(st,lines,plan({}),fp).lifted,[{kind:'play_first',reason:'costly',would_remove:2,best_forced_hp_loss:27,best_hp_loss:3}]);
 const boss=enemy('b','The Insatiable',149,[{name:'Sandpit',amount:3,description:'In 3 turns, you will be eaten and die.'}]);
 const st2={...fight({type:'boss',enemies:[boss]}),player:{hp:13,max_hp:91,energy:3,hand:[
  {index:0,name:'Frantic Escape',cost:'3',can_play:true,description:'Get farther away. Increase Sandpit by 1.'},
  {index:1,name:'Defend',cost:'1',can_play:true,description:'Gain 6 Block.'}]}};
 const cands=[cand('escape',{action:'play_card',card_index:0},{quality:'unknown',survives:null,hpLoss:null}),
  cand('block',{action:'play_card',card_index:1},{hpLoss:10}),cand('end',{action:'end_turn'},{hpLoss:28,survives:false})];
 const r=combatConstraints(st2,cands,plan({}),{plan:'x',target_priority:[],play_first:['Frantic Escape']});
 assert.deepEqual(r.lifted.map(l=>[l.kind,l.reason]),[['countdown_escape','forced_line_dies'],['play_first','forced_line_dies']]);
 assert.equal(r.candidates.length,2,'only avoid_fatal removed End turn');
});

test('a rule that would remove every option records no_option_left',()=>{
 // Every option is pure block on a turn with nothing incoming, and End turn was already removed.
 const block=i=>({id:'b'+i,label:'b'+i,command:{action:'play_card',card_index:i},details:{type:'Skill',description:'Gain 5 Block.'},forecast:{hpLoss:0,quality:'partial',survives:true}});
 const s=fight();s.player.hand=[];s.player.status=[];s.player.relics=[];
 const end={id:'end',label:'end',command:{action:'end_turn'},forecast:{hpLoss:0,quality:'partial',survives:false}};
 const r=combatConstraints(s,[block(0),block(1),end],null);
 assert.deepEqual(r.rules.map(x=>x.kind),['avoid_fatal']);
 assert.deepEqual(r.lifted,[{kind:'block_not_needed',reason:'no_option_left',would_remove:2}]);
 assert.equal(r.candidates.length,2);
});

test('constrained mode logs a combat record for lifts alone, and marks remembered strategist answers',()=>{
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'a'}),cand('potion',{action:'use_potion',slot:0}),cand('end',{action:'end_turn'})];
 const out=constrainCandidates(withPotions(fight({type:'elite',hp:20}),1),cands,plan({potion_reserve:1,hallway_potion_below_hp_percent:40}));
 assert.deepEqual([out.candidates.length,out.constraint.kind,out.constraint.rules,out.constraint.removed,out.constraint.lifted[0].reason],[3,'combat',[],0,'below_hallway_floor']);
 assert.equal(constrainCandidates(fight(),cands,plan({})).constraint,null,'no rule, no lift: no record');
});

test('the rest heal counts the Regal Pillow bonus',()=>{
 assert.equal(restHeal('Heal for 30% of your Max HP (25).\n+15 HP from Regal Pillow.'),40);
 assert.equal(restHeal('Heal for 30% of your Max HP (24).'),24);
 assert.equal(restHeal(undefined),null);
 const cands=[{id:'rest',label:'Rest',details:{id:'HEAL',description:'Heal for 30% of your Max HP (25).\n+15 HP from Regal Pillow.'}},{id:'smith',label:'Smith',details:{id:'SMITH',is_enabled:true}}];
 // 18 missing: the base 25 wastes 7, the full 40 wastes 22 (at least half).
 const at=hp=>({state_type:'rest_site',player:{hp,max_hp:80},rest_site:{options:cands.map(c=>c.details)}});
 assert.deepEqual(restConstraint(at(62),cands).constraint,{kind:'rest_waste',heal:40,wasted:22,removed:1,removed_ids:['rest']});
 assert.deepEqual(computedFacts(at(62),cands,null,{version:3}).rest,{missing_hp:18,rest_heals:40,heal_wasted:22});
 assert.deepEqual(computedFacts(at(62),cands,null).rest,{missing_hp:18,rest_heals:25,heal_wasted:7},'v2 facts are unchanged');
});

const answer=(choice,probabilities)=>({model:'t',usage:{input_tokens:1,output_tokens:1},answers:{move:{type:'choice',choice,confidence:null,probabilities}}});

const strike={index:0,id:'STRIKE',name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'};
const combat=()=>({state_type:'monster',run:{live_id:'test',act:1,floor:3,ascension:0},
 player:{hp:30,max_hp:80,energy:3,max_energy:3,block:0,hand:[strike],deck:[strike],draw_pile:[strike],discard_pile:[],exhaust_pile:[],potions:[],status:[],relics:[]},
 battle:{round:2,turn:'player',is_play_phase:true,enemies:[{entity_id:'e',name:'Enemy',hp:15,max_hp:30,block:0,status:[],intents:[{type:'Attack',label:'10',description:'Attack for 10 damage.'}]}]}});

test('a review records the first and final picks with their forecasts',async()=>{
 const s=combat(),cands=decisionCandidates(s),end=cands.find(c=>c.command.action==='end_turn'),first=cands.find(c=>c!==end);
 first.forecast={survives:false,hpLoss:30,quality:'partial'};
 let n=0;
 const r=await efficientDeliberate({state:s,candidates:cands,ask:async()=>answer(++n===1?first.id:end.id,{[first.id]:.6,[end.id]:.4})});
 assert.match(r.deliberation.reviewReason,/lethal/);
 assert.deepEqual(r.deliberation.review.initial,{id:first.id,label:first.label,hp_loss:30,quality:'partial',survives:false});
 assert.equal(r.deliberation.review.final.id,end.id);assert.deepEqual(Object.keys(r.deliberation.review.final),['id','label','hp_loss','quality','survives']);
 assert.equal(r.deliberation.override,undefined);
});

const shop=(gold=150,potions=0)=>({state_type:'shop',run:{live_id:'run',act:1,floor:8},player:{hp:50,max_hp:80,gold,potions:Array(potions).fill({}),max_potion_slots:3},shop:{items:[]}});
const item=(id,price,extra={})=>({id,label:id,command:{action:'shop_purchase',index:Number(id.slice(1))},details:{price,is_stocked:true,can_afford:true,category:'card',...extra}});
const leave={id:'leave',label:'Continue to the map',command:{action:'proceed'},details:{}};
const offers=[item('i0',50),item('i1',75,{category:'card_removal'}),item('i2',200),item('i3',48,{category:'potion'}),leave];

test('the majority rule buys the most probable affordable purchase when leaving has under half the probability',()=>{
 const p={i0:.2,i1:.15,i2:.3,i3:.05,leave:.3};
 assert.deepEqual(majorityLeave(shop(),offers,{choice:'leave',probabilities:p}),
  {choice:'i0',record:{kind:'majority_leave',p_leave:.3,jev_choice:'leave',chosen:'i0',p_chosen:.2,price:50,gold:150}});
 assert.equal(majorityLeave(shop(),offers,{choice:'leave',probabilities:{...p,leave:.5,i2:.1}}),null,'0.5 stands');
 assert.equal(majorityLeave(shop(),offers,{choice:'i2',probabilities:p}),null,'only a leave is overridden');
 assert.equal(majorityLeave(shop(40),offers,{choice:'leave',probabilities:p}),null,'nothing affordable');
 assert.equal(majorityLeave(shop(60,3),offers,{choice:'leave',probabilities:{i3:.4,i0:.1,leave:.3}}).choice,'i0','no potion with full slots');
 assert.equal(majorityLeave({...shop(),state_type:'card_reward'},offers,{choice:'leave',probabilities:p}),null);
});

const shopState=items=>({state_type:'shop',run:{live_id:'r',act:1,floor:5,ascension:0},player:{hp:50,max_hp:80,gold:150,potions:[],max_potion_slots:2,relics:[],deck:[],status:[]},shop:{items}});
const card={index:0,category:'card',price:60,is_stocked:true,can_afford:true,card_name:'Cleave',card_description:'Deal 8 to ALL.'};
const removal={index:1,category:'card_removal',price:75,is_stocked:true,can_afford:true};

test('only jev_facts_v3 (jev-compact-v3.2) applies the majority rule, after the shop review',async()=>{
 const s=shopState([card,removal]),cands=decisionCandidates(s);
 const id=pred=>cands.find(pred).id,buy=id(c=>c.details?.category==='card'),rem=id(c=>c.details?.category==='card_removal'),out=id(c=>c.command.action==='proceed');
 const p={[buy]:.4,[rem]:.25,[out]:.35};
 const run=async opts=>{let calls=0;const r=await efficientDeliberate({state:s,candidates:cands,facts:{note:'x'},resourceReviews:true,...opts,
  ask:async()=>{calls++;return answer(out,p);}});return {r,calls};};
 const {r,calls}=await run({factsPolicy:FACTS_V3_POLICY});
 assert.equal(calls,2,'the shop review runs first');
 assert.equal(r.answers.move.choice,buy);assert.equal(r.answers.move.jev_choice,out);assert.deepEqual(r.answers.move.probabilities,p);
 assert.deepEqual(r.deliberation.override,{kind:'majority_leave',p_leave:.35,jev_choice:out,chosen:buy,p_chosen:.4,price:60,gold:150});
 assert.equal(r.deliberation.version,'jev-compact-v3.2');assert.equal(r.deliberation.changed,false);
 for(const opts of [{factsPolicy:STRATEGY_FACTS_POLICY},{factsPolicy:FACTS_POLICY,resourceReviews:false},{factsPolicy:FACTS_V3_POLICY,strategy:{summary:'x'}},{facts:null,resourceReviews:false}]){
  const {r}=await run(opts);
  assert.equal(r.answers.move.choice,out,JSON.stringify(opts));assert.equal(r.deliberation.override,undefined);
  if(!opts.resourceReviews&&opts.resourceReviews!==undefined)assert.equal(r.deliberation.review,undefined,'no review, no record');
 }
});
