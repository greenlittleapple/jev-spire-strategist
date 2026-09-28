import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repeatableDialogue} from './dialogue.mjs';
test('only acknowledged and bounded ancient dialogue can repeat an identical state',()=>{
  const s={state_type:'event',event:{in_dialogue:true},run:{live_id:'r1',floor:1}};
  const a=[{command:{action:'advance_dialogue'}}];
  const event={kind:'decision',outcome:'executed',chosen:a[0],state:s};
  assert.equal(repeatableDialogue(s,a,[event]),true);
  assert.equal(repeatableDialogue(s,a,[{...event,outcome:'pending'}]),false);
  assert.equal(repeatableDialogue(s,a,Array(12).fill(event)),false);
  assert.equal(repeatableDialogue({...s,run:{live_id:'r2',floor:1}},a,[event]),false);
  assert.equal(repeatableDialogue(s,[{command:{action:'play_card'}}],[event]),false);
  assert.equal(repeatableDialogue({...s,event:{in_dialogue:false}},a,[event]),false);
});
