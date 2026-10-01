import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actionsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {isOwnedScreen,requestStamp,stampPlan,replanReason,constrainCandidates,screenKey,swapPending,swapClaim} from './strategy.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';

// JEV3 f23 (#16153), trimmed: every slot full, a Duplicator offered with gold and a card.
// Before: the strategist was asked about gold and the card only, then the proceed was "forced".
const screen=(potions,items)=>({state_type:'rewards',run:{live_id:'r',act:2,floor:23},player:{hp:40,max_hp:80,max_potion_slots:3,
 potions:potions.map(([name,slot])=>({name,slot}))},rewards:{can_proceed:true,items}});
const full=[['Strength Potion',0],['Speed Potion',1],['Explosive Ampoule',2]];
const dup=index=>({index,type:'potion',description:'Duplicator',potion_name:'Duplicator'});

test('the strategist can discard a held potion and then the offered one is claimed',()=>{
 const s=screen(full,[{index:0,type:'gold',description:'10 Gold'},dup(1)]);
 assert.equal(isOwnedScreen(s),true);
 const candidates=actionsFor(s,{potionSwaps:true});
 const discardSpeed=candidates.find(c=>c.command.action==='discard_potion'&&c.command.slot===1);
 assert.match(discardSpeed.label,/^Discard Speed Potion \(slot 1\) to make room for Duplicator$/);
 const gold=candidates.find(c=>c.label==='10 Gold');
 const plan=stampPlan({allowed_option_ids:[gold.id,discardSpeed.id]},requestStamp(s,candidates,'owned_screen'));
 const screenChoices={[screenKey(s)]:plan.allowed_options};
 assert.equal(replanReason(s,plan,candidates,{screenChoices}),null);
 assert.deepEqual(constrainCandidates(s,candidates,plan,'constrained',{screenChoices}).candidates.map(c=>c.command),[{action:'claim_reward',index:0}]);
 // Gold taken: the discard is next.
 const s2=screen(full,[dup(0)]),c2=actionsFor(s2,{potionSwaps:true});
 assert.deepEqual(constrainCandidates(s2,c2,plan,'constrained',{screenChoices}).candidates.map(c=>c.command),[{action:'discard_potion',slot:1}]);
 // After the discard the screen has a free slot: no longer owned, and the claim is the only option.
 const s3=screen([full[0],full[2]],[dup(0)]);
 assert.equal(isOwnedScreen(s3),false);
 assert.deepEqual(actionsFor(s3,{potionSwaps:true}).map(c=>c.command),[{action:'claim_reward',index:0}]);
});

test('declining the swap leaves the potion',()=>{
 const s=screen(full,[dup(0)]),candidates=actionsFor(s,{potionSwaps:true});
 assert.ok(candidates.length>1,'the strategist is asked, not a forced proceed');
 const leave=candidates.find(c=>c.command.action==='proceed');
 const plan=stampPlan({allowed_option_ids:[leave.id]},requestStamp(s,candidates,'owned_screen'));
 assert.deepEqual(constrainCandidates(s,candidates,plan,'constrained',{screenChoices:{[screenKey(s)]:plan.allowed_options}}).candidates.map(c=>c.command),[{action:'proceed'}]);
});

// JEV21 f22: gold, a potion and a card with a full belt; the answer was the gold, then the card.
test('a listed claim still matches after an earlier claim re-indexes the rewards',()=>{
 const card=index=>({index,type:'card',description:'Add a card to your deck.'});
 const s=screen(full,[{index:0,type:'gold',description:'20 Gold'},dup(1),card(2)]),candidates=actionsFor(s,{potionSwaps:true});
 const pick=label=>candidates.find(c=>c.label===label).id;
 const plan=stampPlan({allowed_option_ids:[pick('20 Gold'),pick('Add a card to your deck.')]},requestStamp(s,candidates,'owned_screen'));
 const screenChoices={[screenKey(s)]:plan.allowed_options};
 // Gold taken: the card reward is now index 1 and is still the answer, with no new consult.
 const s2=screen(full,[dup(0),card(1)]),c2=actionsFor(s2,{potionSwaps:true});
 assert.equal(replanReason(s2,plan,c2,{screenChoices}),null);
 assert.deepEqual(constrainCandidates(s2,c2,plan,'constrained',{screenChoices}).candidates.map(c=>c.command),[{action:'claim_reward',index:1}]);
 // Two identical rewards are not guessed between: that asks again.
 const s3=screen(full,[card(0),card(1),dup(2)]),c3=actionsFor(s3,{potionSwaps:true});
 assert.equal(replanReason(s3,plan,c3,{screenChoices}),'owned_screen');
 // A claimed reward does not match a different one with another label or type.
 const s4=screen(full,[dup(0),{index:1,type:'gold',description:'30 Gold'}]),c4=actionsFor(s4,{potionSwaps:true});
 assert.equal(replanReason(s4,plan,c4,{screenChoices}),'owned_screen');
});

test('after the discard, a listed claim that moved is still the one kept',()=>{
 // JEV22 f6 order: gold, card, discard; here the discard came before the card.
 const card=index=>({index,type:'card',description:'Add a card to your deck.'});
 const s=screen(full,[{index:0,type:'gold',description:'18 Gold'},dup(1),card(2)]),candidates=actionsFor(s,{potionSwaps:true});
 const discard=candidates.find(c=>c.command.action==='discard_potion'&&c.command.slot===2);
 const plan=stampPlan({allowed_option_ids:[discard.id,candidates.find(c=>c.label==='Add a card to your deck.').id]},requestStamp(s,candidates,'owned_screen'));
 // Slot free, gold gone: the screen is no longer owned, and the listed card claim (now index 1) is kept.
 const s2={...screen([full[0],full[1]],[dup(0),card(1)])},c2=actionsFor(s2,{potionSwaps:true});
 assert.equal(isOwnedScreen(s2),false);
 assert.deepEqual(constrainCandidates(s2,c2,plan,'constrained').candidates.map(c=>c.command),[{action:'claim_reward',index:1}]);
});

// JEV22 f6 (v3.18): the strategist discarded Swift Potion for Flex Potion; with the slot free the screen went
// back to Jev, which claimed the card first. The next decision after a discard now claims the potion.
const card=index=>({index,type:'card',description:'Add a card to your deck.'});
const noConsult={current:async()=>null,take:async()=>null,post:async()=>assert.fail('no consult')};
const fullPlan=extra=>({archetype:'',summary:'',priorities:[],combat:{risk_tolerance:'low',potion_policy:'',focus:'',hallway_potion_below_hp_percent:50,potion_reserve:0},
 fight:{plan:'',target_priority:[]},card_reward:{desired:[],avoid:[],skip_when:''},shop:{gold_reserve:0,priorities:[]},route:'',route_path:[],
 elite_min_hp_percent:0,rest:'',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const swapStatus=(s,candidates,ids)=>{
 const status=newStrategyStatus({waitMs:5000});
 status.plan=stampPlan(fullPlan({allowed_option_ids:ids}),requestStamp(s,candidates,'owned_screen'));
 status.screenChoices={[screenKey(s)]:status.plan.allowed_options};status.screenChoiceGiven={[screenKey(s)]:{request_id:null,floor:23}};
 return status;
};

test('the claim a discard made room for is matched by type and label after re-indexing',()=>{
 const s=screen(full,[dup(0),card(1)]),discard=actionsFor(s,{potionSwaps:true}).find(c=>c.command.action==='discard_potion'&&c.command.slot===1);
 const pending=swapPending(s,discard);
 assert.deepEqual(pending,{screen:screenKey(s),type:'potion',label:'Duplicator',discarded:'Speed Potion'});
 const after=screen([full[0],full[2]],[card(0),dup(1)]),c=actionsFor(after,{potionSwaps:true});
 assert.deepEqual(swapClaim(after,c,pending)?.command,{action:'claim_reward',index:1});
 // Another potion with a different label, another floor, or a claim that is gone: no follow-through.
 const other={index:1,type:'potion',description:'Fire Potion',potion_name:'Fire Potion'};
 assert.equal(swapClaim(screen([full[0],full[2]],[card(0),other]),actionsFor(screen([full[0],full[2]],[card(0),other])),pending),null);
 const later={...after,run:{...after.run,floor:24}};
 assert.equal(swapClaim(later,actionsFor(later),pending),null);
 assert.equal(swapClaim(screen([full[0],full[2]],[card(0)]),actionsFor(screen([full[0],full[2]],[card(0)])),pending),null);
 assert.equal(swapPending(s,c.find(x=>x.command.action==='claim_reward')),null);
});

test('after a strategist discard the next decision claims the potion as a rule, before the listed card',async()=>{
 const s=screen(full,[dup(0),card(1)]),c=actionsFor(s,{potionSwaps:true});
 const discard=c.find(x=>x.command.action==='discard_potion'&&x.command.slot===1),take=c.find(x=>x.label==='Add a card to your deck.');
 const status=swapStatus(s,c,[discard.id,take.id]);
 const first=await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel:noConsult,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(first.decisionSource,'claude');assert.equal(first.answers.move.choice,discard.id);
 assert.equal(status.potionSwap.label,'Duplicator');
 // Slot free and the card listed first: without the follow-through the plan's list keeps the card claim.
 const after=screen([full[0],full[2]],[card(0),dup(1)]),c2=actionsFor(after,{potionSwaps:true});
 const second=await hierarchicalDeliberate({state:after,candidates:c2,strategist:{channel:noConsult,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(second.decisionSource,'rule');assert.equal(second.rule,'potion_swap_claim');
 assert.deepEqual(c2.find(x=>x.id===second.answers.move.choice).command,{action:'claim_reward',index:1});
 assert.deepEqual(second.constraint,{kind:'potion_swap_claim',removed:1,removed_ids:[c2.find(x=>x.label==='Add a card to your deck.').id],discarded:'Speed Potion'});
 // The claim was taken: the belt is full again, nothing is pending, and the plan's card claim follows.
 const done=screen(full,[card(0),{index:1,type:'gold',description:'5 Gold'}]),c3=actionsFor(done,{potionSwaps:true});
 const third=await hierarchicalDeliberate({state:done,candidates:c3,strategist:{channel:noConsult,status},ask:()=>assert.fail('no Jev call')});
 assert.equal(third.decisionSource,'claude');assert.deepEqual(c3.find(x=>x.id===third.answers.move.choice).command,{action:'claim_reward',index:0});
 assert.equal(status.potionSwap,null);
});

test('a potion no longer listed after the discard falls through to normal play',async()=>{
 const s=screen(full,[dup(0),card(1)]),c=actionsFor(s,{potionSwaps:true});
 const discard=c.find(x=>x.command.action==='discard_potion'&&x.command.slot===1),take=c.find(x=>x.label==='Add a card to your deck.');
 const status=swapStatus(s,c,[discard.id,take.id]);
 await hierarchicalDeliberate({state:s,candidates:c,strategist:{channel:noConsult,status},ask:()=>assert.fail('no Jev call')});
 const gone=screen([full[0],full[2]],[card(0),{index:1,type:'gold',description:'5 Gold'}]),c2=actionsFor(gone,{potionSwaps:true});
 const next=await hierarchicalDeliberate({state:gone,candidates:c2,strategist:{channel:noConsult,status},ask:()=>assert.fail('no Jev call')});
 assert.notEqual(next.decisionSource,'rule');
 assert.deepEqual(c2.find(x=>x.id===next.answers.move.choice).command,{action:'claim_reward',index:0});
 assert.equal(status.potionSwap,null);
});
