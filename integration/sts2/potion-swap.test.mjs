import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actionsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {isOwnedScreen,requestStamp,stampPlan,replanReason,constrainCandidates,screenKey} from './strategy.mjs';

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
