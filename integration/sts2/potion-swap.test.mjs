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
