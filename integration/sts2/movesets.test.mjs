import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recordIntents,patternFor,intentSummary} from './movesets.mjs';

const state=(floor,round,enemies)=>({state_type:'boss',run:{live_id:'r',act:1,floor},battle:{round,turn:'player',enemies}});
const fysh=(label,type='Attack')=>({name:'Soul Fysh',hp:100,intents:[{type,label}]});

test('intents are recorded once per round per fight and shown newest fight first',()=>{
 const m={};
 recordIntents(m,state(17,1,[fysh('2','StatusCard')]));recordIntents(m,state(17,1,[fysh('99')]));recordIntents(m,state(17,2,[fysh('16')]));
 recordIntents(m,state(34,1,[fysh('3','StatusCard')]));
 assert.deepEqual(patternFor(m,'Soul Fysh'),['r1 StatusCard 3','r1 StatusCard 2, r2 Attack 16']);
 assert.equal(intentSummary([{type:'Attack',label:'11'},{type:'Heal'}]),'Attack 11 + Heal');
});

test('same-name enemies in one fight are kept apart and only the last three fights are kept',()=>{
 const m={};
 recordIntents(m,state(5,1,[{name:'Bug',hp:5,intents:[{type:'Attack',label:'3'}]},{name:'Bug',hp:5,intents:[{type:'Buff'}]}]));
 assert.equal(patternFor(m,'Bug').length,2);
 for(const f of [6,7,8])recordIntents(m,state(f,1,[{name:'Bug',hp:5,intents:[{type:'Buff'}]}]));
 assert.equal(m.Bug.length,3);
 assert.equal(recordIntents({},{...state(9,1,[]),battle:{round:1,turn:'enemy',enemies:[]}}),false,'enemy turns are not recorded');
});
