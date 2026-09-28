import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actionsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {efficientDeliberate,efficientQuestion,isForcedChoice,summarizeHistory} from './efficient-decisions.mjs';

const card={index:0,id:'STRIKE',name:'Strike+',cost:'1',star_cost:'2',type:'Attack',description:'Deal 9 damage.',is_upgraded:true,can_play:true,target_type:'AnyEnemy',keywords:[{name:'Attached rule',description:'Retain this card; its first play gains 2 Block.'}]};
const state=()=>({state_type:'monster',run:{live_id:'test',act:1,floor:3,ascension:0},
 player:{hp:30,max_hp:80,energy:3,max_energy:3,block:0,hand:[card],deck:[card],draw_pile:[card,card],discard_pile:[card],exhaust_pile:[card],known_draw_top:[card],potions:[],status:[],relics:[{id:'CUSTOM_RUNE',name:'Custom rune',description:'First attack gains 3 Block.',counter:1,source_mod:'HextechRunes'}]},
 battle:{round:2,turn:'player',is_play_phase:true,enemies:[{entity_id:'e',name:'Enemy',hp:15,max_hp:30,block:0,status:[],intents:[{type:'Attack',label:'10',description:'Attack for 10 damage.'}]}]},
 hextech:{active_enemy_hexes:[{id:'HEX',name:'Enemy hex',description:'Gain 1/2/3 Strength.',strength_tier:2}]}});
const answer=(choice,confidence=.2)=>({model:'jev-test',answers:{move:{type:'choice',choice,confidence,probabilities:{[choice]:1}}},usage:{input_tokens:100,output_tokens:1}});
const expand=(request,value)=>value?.card_rule_ref?request.state.card_rule_references[value.card_rule_ref]:Array.isArray(value)?value.map(v=>expand(request,v)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(request,v)])):value;

test('only the actual sole legal action bypasses Jev and has no model confidence or token cost',async()=>{
 const s=state();s.player.hand=[];
 const candidates=decisionCandidates(s);
 assert.equal(candidates.length,1);
 const result=await efficientDeliberate({state:s,candidates,ask:()=>assert.fail('Forced move must not call API')});
 assert.equal(result.decisionSource,'forced');assert.equal(result.model,null);
 assert.equal(result.answers.move.confidence,null);assert.deepEqual(result.answers.move.probabilities,{});
 assert.deepEqual(result.usage,{input_tokens:0,output_tokens:0});
 assert.equal(isForcedChoice(s,[{...candidates[0],command:{action:'play_card',card_index:0}}]),false);
 const multiple=state();assert.equal(isForcedChoice(multiple,decisionCandidates(multiple).slice(0,1)),false);
});

test('one ordinary choice preserves all live actions, card/pile rules, known top and rune tiers',async()=>{
 const s=state(),before=structuredClone(s),candidates=decisionCandidates(s),requests=[];
 const result=await efficientDeliberate({state:s,candidates,ask:async request=>{requests.push(request);return answer(candidates[0].id,0);}});
 assert.equal(requests.length,1);assert.equal(result.deliberation.calls,1);assert.equal(result.deliberation.reviewReason,null);
 assert.deepEqual(Object.keys(requests[0].questions),['move']);
 assert.deepEqual(Object.keys(requests[0].questions.move.criteria),candidates.map(c=>c.id));
 const supplied=expand(requests[0],requests[0].state.state.player);
 for(const pile of ['hand','discard_pile','exhaust_pile','known_draw_top']){
  assert.equal(supplied[pile][0].star_cost,'2');assert.equal(supplied[pile][0].keywords[0].description,card.keywords[0].description);
 }
 assert.equal(supplied.draw_pile[0].copies,2);
 assert.equal(requests[0].state.hextech_runes.runes.find(r=>r.id==='HEX').strength_tier,2);
 assert.deepEqual(s,before);
});

test('filtered rewards, treasure and confirmation screens are not declared forced',async()=>{
 for(const s of [
  {state_type:'rewards',player:{potions:[]},rewards:{items:[{index:0,type:'relic',name:'Relic'}],can_proceed:true}},
  {state_type:'treasure',player:{},treasure:{relics:[{index:0,name:'Relic'}],can_proceed:true}},
  {state_type:'card_select',card_select:{cards:[],can_confirm:true,can_cancel:true}}
 ]){
  const candidates=actionsFor(s);assert.equal(candidates.length,1);assert.equal(isForcedChoice(s,candidates),false);
 }
 const s=state();s.player.hand=[{...card,target_type:'UnsupportedTarget'}];
 assert.equal(actionsFor(s).length,1);assert.equal(isForcedChoice(s,actionsFor(s)),false);
 const empty={state_type:'rewards',rewards:{items:[],can_proceed:true}};
 assert.equal(isForcedChoice(empty,actionsFor(empty)),true);
});

test('only a concrete risky choice gets one additional review, with all alternatives retained',async()=>{
 const s=state(),candidates=decisionCandidates(s),end=candidates.find(c=>c.command.action==='end_turn');let calls=0;
 const result=await efficientDeliberate({state:s,candidates,ask:async request=>{
  calls++;assert.deepEqual(Object.keys(request.questions.move.criteria),candidates.map(c=>c.id));
  if(calls===2){assert.equal(request.state.proposed_action.id,end.id);assert.match(request.state.proposed_action.reason_for_review,/Ending/);}
  return answer(calls===1?end.id:candidates[0].id);
 }});
 assert.equal(calls,2);assert.equal(result.deliberation.changed,true);assert.equal(result.usage.input_tokens,200);
 assert.equal(result.deliberation.request_usage.length,2);
});

test('known lethal forecasts trigger a bounded review; invalid first or reviewed IDs fail closed',async()=>{
 const s=state(),candidates=decisionCandidates(s);candidates[0].forecast={survives:false};let calls=0;
 const result=await efficientDeliberate({state:s,candidates,ask:async()=>{calls++;return answer(candidates[0].id);}});
 assert.equal(calls,2);assert.match(result.deliberation.reviewReason,/lethal/);
 await assert.rejects(efficientDeliberate({state:s,candidates,ask:async()=>answer('invented')}),/invalid action/);
 calls=0;await assert.rejects(efficientDeliberate({state:s,candidates,ask:async()=>answer(++calls===1?candidates[0].id:'invented')}),/invalid action/);
});

test('saved history is bounded by act totals and three rooms without changing the local source',()=>{
 const saved={run_id:'test',freshness:'Current act checkpoint',modifiers:[{id:'Hextech'}],map_point_history:[Array.from({length:40},(_,i)=>({map_point_type:'monster',rooms:[{model_id:'Enemy'+i,room_type:'monster',turns_taken:3}],player_stats:[{current_hp:70-i,max_hp:80,current_gold:i,damage_taken:1,hp_healed:2,gold_spent:3,card_choices:[{rejected:'historical-offer'}]}]}))]};
 const original=structuredClone(saved),summary=summarizeHistory(saved);
 assert.equal(summary.run_id,'test');assert.equal(summary.history_summary.by_act[0].rooms,40);
 assert.equal(summary.history_summary.by_act[0].damage_taken,40);assert.equal(summary.history_summary.by_act[0].combat_turns,120);
 assert.equal(summary.history_summary.recent_rooms.length,3);assert.equal(summary.history_summary.recent_rooms[2].rooms[0].model_id,'Enemy39');
 assert.equal(JSON.stringify(summary).includes('historical-offer'),false);assert.deepEqual(saved,original);
 const s=state();s.saved_run=saved;const q=efficientQuestion(s,decisionCandidates(s));
 assert.equal(q.state.state.saved_run.map_point_history,undefined);assert.equal(q.state.state.saved_run.history_summary.by_act[0].rooms,40);
});

test('rune rerolls and card-selection purpose remain available without routine second passes',async()=>{
 const s=state();delete s.battle;s.state_type='hextech_rune';s.hextech_rune={golden_reroll:{active:true},pending_enemy_hexes:[{description:'Bad enemy rule'}],reroll_budget_remaining:4,options:[{id:'rune:0',name:'Keep',description:'Gain Block.',relic_id:'BLOCK_RUNE'},{id:'reroll:player:0',name:'Reroll',kind:'reroll_player',revision:'screen:0',rerolls_remaining:1}]};
 const candidates=actionsFor(s);let calls=0;
 await efficientDeliberate({state:s,candidates,ask:async q=>{calls++;assert.equal(q.state.hextech_reroll_review.golden_upgrade.active,true);assert.deepEqual(Object.keys(q.questions.move.criteria),candidates.map(c=>c.id));return answer(candidates[1].id);}});
 assert.equal(calls,1);
 s.state_type='card_select';s.selection_origin={name:'Headbutt',description:'Put a card on top.'};s.card_select={prompt:'Choose a card to put on top of your draw pile.',cards:[{...card,index:0},{...card,index:1}],can_confirm:false};
 const q=efficientQuestion(s,actionsFor(s));assert.equal(q.state.state.selection_origin.name,'Headbutt');assert.match(q.questions.move.instructions,/selection_origin/);
});
