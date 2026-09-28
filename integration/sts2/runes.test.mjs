import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deliberate} from '../../vendor/jev-the-spire/spire-demo/deliberation.mjs';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {includeHextechRules} from './runes.mjs';

const rune={id:'GROUNDED_RUNE',name:'Grounded',description:'At the end of your turn, double your Block.'};
test('rune rules survive both compacted Jev passes, including unknown equipped runes',async()=>{
  const state=JSON.parse(readFileSync(new URL('../../vendor/jev-the-spire/spire-demo/fixtures/beast-free.json',import.meta.url))).state;
  state.player.relics.push(rune,{id:'FUTURE_RUNE',name:'Future rune',description:'A newly supplied rule.'});
  const candidates=decisionCandidates(state);
  let calls=0;
  await deliberate({state,candidates,ask:async request=>{
    calls++;
    assert.equal(request.state.hextech_runes.runes[0].rule,rune.description);
    assert.equal(request.state.hextech_runes.runes[1].rule,'A newly supplied rule.');
    for(const question of Object.values(request.questions))assert.match(question.instructions,/equipped Hextech rune rules/);
    assert.deepEqual(Object.keys(request.questions.move.criteria),candidates.map(c=>c.id));
    return {answers:Object.fromEntries(Object.keys(request.questions).map(k=>[k,{type:'choice',choice:candidates[0].id}]))};
  }});
  assert.ok(calls>=2);
});
test('noncombat questions also retain rune synergy and plain runs remain untouched',()=>{
  for(const state_type of ['card_reward','shop','card_select','hextech_rune']){
    const request={state:{state:{state_type,player:{relics:[rune]}}},questions:{move:{instructions:'Choose'},synergy:{instructions:'Assess'}}};
    includeHextechRules(request);
    assert.equal(request.state.hextech_runes.runes[0].id,rune.id);
    assert.match(request.questions.synergy.instructions,/current deck/);
  }
  const plain={state:{state:{player:{relics:[]}}},questions:{move:{instructions:'Choose'}}};
  assert.deepEqual(includeHextechRules(structuredClone(plain)),plain);
});
