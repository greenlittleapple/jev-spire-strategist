import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsFor } from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import { decisionCandidates, decisionQuestion } from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {includeHextechRules} from './runes.mjs';
test('Hextech selection passes supplied IDs and exact rune identity to the game',()=>{
  const state={state_type:'hextech_rune',run:{act:1,floor:1,ascension:0},player:{deck:[],relics:[]},
    hextech_rune:{visible_text:['Choose a rune'],options:[{id:'rune:2',name:'Example rune',description:'Gain 1 Strength.',relic_id:'RUNE_EXAMPLE'}]}};
  const actions=actionsFor(state);
  assert.deepEqual(actions[0].command,{action:'hextech_select',option_id:'rune:2',relic_id:'RUNE_EXAMPLE'});
  const candidates=decisionCandidates(state);
  const q=decisionQuestion(state,candidates);
  assert.equal(Object.keys(q.questions.move.criteria).length,1);
  assert.equal(actionsFor({...state,hextech_rune:{options:[]}}).length,0);
});
test('player and enemy rerolls retain exact revisions and compete with choosing a rune',()=>{
  const state={state_type:'hextech_rune',player:{deck:[],relics:[]},hextech_rune:{
    golden_reroll:{active:true,shared_uses_remaining:1,upgraded_rarity:'Gold'},reroll_budget_remaining:10,
    pending_enemy_hexes:[{id:'HandOfBaron',description:'Enemy damage bonus',rerolls_remaining:1}],options:[
      {id:'rune:0',name:'Keep rune',description:'Gain Block.',relic_id:'GROUNDED_RUNE'},
      {id:'reroll:player:0',kind:'reroll_player',name:'Reroll player rune',description:'Consumes one reroll.',relic_id:'GROUNDED_RUNE',revision:'screen:player:0:1',rerolls_remaining:1},
      {id:'reroll:enemy:0',kind:'reroll_enemy',name:'Reroll enemy hex',description:'Unknown replacement.',revision:'screen:enemy:0:1',rerolls_remaining:1}
    ]}};
  const candidates=decisionCandidates(state);
  assert.equal(candidates.length,3);
  assert.deepEqual(candidates[1].command,{action:'hextech_select',option_id:'reroll:player:0',relic_id:'GROUNDED_RUNE',revision:'screen:player:0:1'});
  assert.deepEqual(candidates[2].command,{action:'hextech_select',option_id:'reroll:enemy:0',revision:'screen:enemy:0:1'});
  const request=includeHextechRules(decisionQuestion(state,candidates));
  assert.equal(request.state.hextech_reroll_review.golden_upgrade.shared_uses_remaining,1);
  assert.equal(request.state.hextech_reroll_review.pending_enemy_hexes[0].id,'HandOfBaron');
  assert.match(request.questions.move.instructions,/Compare available Hextech rerolls/);
});
