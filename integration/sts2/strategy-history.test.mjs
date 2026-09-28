import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compactStrategy,addToHistory,loadHistory} from './strategy-history.mjs';

const adopted=(n,extra={})=>({kind:'strategy_adopted',time:`2026-09-28T19:0${n}:00Z`,reason:'owned_screen',request_id:'r'+n,
 plan:{run_id:'run',act:1,floor:n,screen:`run:1:${n}:card_reward`,summary:'s'+n,option_note:'note',recommended_options:['Uppercut'],fight:{plan:'',target_priority:[]},...extra}});

test('adopted plans become compact history entries, newest first and capped',async()=>{
 const h=compactStrategy(adopted(3,{encounter_key:'Phantasmal Gardener',fight:{plan:'Pop Skittish first',target_priority:['biggest_attack']}}));
 assert.equal(h.screen,'card_reward');assert.deepEqual(h.chosen,['Uppercut']);
 assert.deepEqual(h.fight,{plan:'Pop Skittish first',target_priority:['biggest_attack']});assert.equal(h.encounter,'Phantasmal Gardener');
 assert.equal(compactStrategy(adopted(1)).fight,null,'an empty fight plan is omitted');
 const list=[];addToHistory(list,adopted(1));addToHistory(list,{kind:'decision'});addToHistory(list,adopted(2));
 assert.deepEqual(list.map(x=>x.floor),[2,1]);
 const dir=await mkdtemp(join(tmpdir(),'jev-hist-'));
 try{
  const file=join(dir,'log.jsonl');
  await writeFile(file,[adopted(1),{kind:'decision'},adopted(2),adopted(3)].map(x=>JSON.stringify(x)).join('\n')+'\n');
  assert.deepEqual((await loadHistory(file,2)).map(x=>x.floor),[3,2]);
  assert.deepEqual(await loadHistory(join(dir,'missing.jsonl')),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
