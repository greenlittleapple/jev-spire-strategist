import {test} from 'node:test';
import assert from 'node:assert/strict';
import {visibleState,deckSnapshot} from '../../vendor/jev-the-spire/spire-demo/encounters.mjs';
import {compactRequest} from '../../vendor/jev-the-spire/spire-demo/compact-request.mjs';
import {selectionState} from '../../vendor/jev-the-spire/spire-demo/selections.mjs';
import {deliberate} from '../../vendor/jev-the-spire/spire-demo/deliberation.mjs';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {includePileKnowledge} from './piles.mjs';

const card=(name,star_cost='2')=>({id:name.toUpperCase(),name,cost:'0',star_cost,type:'Skill',is_upgraded:true,description:'Put a card from your discard pile on top of your draw pile.',keywords:[{name:'Enchanted',description:'Retain. Gain 2 Block when played.'}]});
test('unordered pile inventories preserve live rules and multiplicity; known top stays ordered',()=>{
 const a=card('A'),b=card('B'),a2=card('A','3');
 const state={player:{draw_pile:[b,a,a,a2],discard_pile:[a,b],exhaust_pile:[a],known_draw_top:[b,a],deck:[a,a,a2]}};
 const visible=visibleState(state);
 assert.equal(visible.player.draw_pile[0].name,'A');
 assert.deepEqual(visible.player.known_draw_top,[b,a]);
 const req={state:{state:visible,deck:deckSnapshot(visible)},questions:{move:{criteria:{a:null,b:null},instructions:'Choose'}}};
 const out=includePileKnowledge(compactRequest(req));
 const expand=value=>value?.card_rule_ref?out.state.card_rule_references[value.card_rule_ref]:Array.isArray(value)?value.map(expand):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(v)])):value;
 const unpacked=expand(out);
 assert.deepEqual(unpacked.state.state.player.draw_pile,[{...a,copies:2},{...a2,copies:1},{...b,copies:1}]);
 assert.deepEqual(unpacked.state.state.player.known_draw_top,[b,a]);
 assert.equal(out.state.deck.cards.length,2);
 assert.equal(unpacked.state.state.player.exhaust_pile[0].keywords[0].description,a.keywords[0].description);
 assert.match(out.questions.move.instructions,/exhausted cards do not return/);
 assert.deepEqual(compactRequest(compactRequest(req)),compactRequest(req));
 assert.deepEqual(state.player.draw_pile,[b,a,a,a2]);
});

test('selection origin follows the executed source card, never a different run or room',()=>{
 const run={live_id:'run:1',act:1,floor:2};
 const prior={kind:'decision',outcome:'executed',state:{run,player:{hand:[{...card('Headbutt'),index:2}]}},chosen:{command:{action:'play_card',card_index:2}}};
 const grid={state_type:'card_select',run,card_select:{prompt:'Choose a card to put on top of your draw pile.',cards:[{...card('Bash'),index:0}],can_confirm:false}};
 assert.equal(selectionState(grid,[prior]).selection_origin.name,'Headbutt');
 for(const event of [{...prior,outcome:'preview'},{...prior,state:{...prior.state,run:{...run,live_id:'run:2'}}},{...prior,state:{...prior.state,run:{...run,floor:3}}}])assert.equal(selectionState(grid,[event]).selection_origin,undefined);
});

test('both Jev decision stages include piles, known top, selection purpose and every live option',async()=>{
 const a=card('Anger'),b=card('Bash');
 const state={state_type:'card_select',run:{act:1,floor:2},player:{hp:60,max_hp:80,energy:1,deck:[a,b],relics:[],draw_pile:[a,b],discard_pile:[a,b],exhaust_pile:[],known_draw_top:[b]},selection_origin:{name:'Headbutt',description:'Put a card from your discard pile on top of your draw pile.'},card_select:{prompt:'Choose a card to put on top of your draw pile.',cards:[{...a,index:0},{...b,index:1}],can_confirm:false}};
 const candidates=decisionCandidates(state),requests=[];
 await deliberate({state,candidates,ask:async payload=>{requests.push(payload);return {answers:Object.fromEntries(Object.entries(payload.questions).map(([id,q])=>[id,{type:'choice',choice:Object.keys(q.criteria)[0],confidence:.6}])),usage:{input_tokens:1,output_tokens:1}};}});
 assert.equal(requests.length,2);
 for(const request of requests){
  assert.deepEqual(Object.keys(request.questions.move.criteria),candidates.map(c=>c.id));
  assert.deepEqual(request.state.state.player.known_draw_top,[b]);
  assert.equal(request.state.state.selection_origin.name,'Headbutt');
  for(const q of Object.values(request.questions))assert.match(q.instructions,/top-deck\/return-to-hand\/discard\/exhaust/);
 }
});
