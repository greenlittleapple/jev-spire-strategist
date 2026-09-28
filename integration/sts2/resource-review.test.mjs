import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {reviewReason} from './efficient-decisions.mjs';
import {hierarchicalDeliberate} from './hierarchical.mjs';

const run={live_id:'r',act:1,floor:5,ascension:0};
const potion={command:{action:'use_potion',slot:0},label:'Block Potion'};
const fight=type=>({state_type:type,run,player:{hp:80,max_hp:80,gold:0,potions:[{}],max_potion_slots:3}});

test('potion review fires only for normal fights and only when enabled',()=>{
 assert.match(reviewReason(fight('monster'),[],potion,{resourceReviews:true}),/normal \(non-elite, non-boss\) fight/);
 assert.equal(reviewReason(fight('monster'),[],potion),null,'off in v1/v2');
 assert.equal(reviewReason(fight('elite'),[],potion,{resourceReviews:true}),null);
 assert.equal(reviewReason(fight('boss'),[],potion,{resourceReviews:true}),null);
 assert.equal(reviewReason(fight('monster'),[],{command:{action:'play_card'}},{resourceReviews:true}),null);
});

const shop=(gold,items,potions=[])=>({state_type:'shop',run,player:{hp:50,max_hp:80,gold,potions,max_potion_slots:2,relics:[],deck:[],status:[]},shop:{items}});
const card={index:0,category:'card',price:60,is_stocked:true,can_afford:true,card_name:'Cleave',card_description:'Deal 8 to ALL.'};
const removal={index:1,category:'card_removal',price:75,is_stocked:true,can_afford:true};
const pot={index:2,category:'potion',price:50,is_stocked:true,can_afford:true,potion_name:'Block Potion',potion_description:'Gain 12 Block.'};
const leave=s=>decisionCandidates(s).find(c=>c.command.action==='proceed');

test('shop review fires when leaving with 100+ gold and an affordable removal or usable potion',()=>{
 const r=(s)=>reviewReason(s,decisionCandidates(s),leave(s),{resourceReviews:true});
 assert.match(r(shop(150,[card,removal])),/Leaving the shop with 150 gold/);
 assert.match(r(shop(150,[pot])),/Leaving the shop/);
 assert.equal(r(shop(150,[pot],[{},{}])),null,'potion slots full');
 assert.equal(r(shop(150,[card])),null,'cards alone are a deck judgment');
 assert.equal(r(shop(90,[removal])),null,'under 100 gold');
 assert.equal(reviewReason(shop(150,[removal]),decisionCandidates(shop(150,[removal])),leave(shop(150,[removal]))),null,'off in v1/v2');
});

test('v3 asks Jev a second time when it leaves a rich shop; v2 does not',async()=>{
 for(const [factsVersion,expected] of [[3,2],[2,1]]){
  const s=shop(150,[card,removal]),candidates=decisionCandidates(s),requests=[];
  const id=leave(s).id;
  const result=await hierarchicalDeliberate({state:s,candidates,factsVersion,
   ask:async q=>{requests.push(q);return {model:'t',answers:{move:{type:'choice',choice:id,confidence:.6,probabilities:{[id]:.6}}},usage:{input_tokens:10,output_tokens:1}};}});
  assert.equal(requests.length,expected,`facts v${factsVersion}`);
  if(expected===2){assert.match(requests[1].state.proposed_action.reason_for_review,/Leaving the shop/);assert.equal(result.deliberation.calls,2);}
 }
});
