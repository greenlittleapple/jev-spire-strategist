import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unmodeledNames,mechanicText,presentNames,fileMechanics,mechanicKey} from './mechanics.mjs';

test('unmodeled names come from forecast warnings and unmodeled cards',()=>{
 const n=unmodeledNames([{forecast:{warnings:['Unmodeled enemy power: Ravenous','Stops before unknown drawn cards; re-observe.'],notModeled:['Cascade+']}},{forecast:{warnings:['Unmodeled relic: Razor Tooth']}}]);
 assert.deepEqual([...n],[['Ravenous','enemy power'],['Cascade','card'],['Razor Tooth','relic']]);
 assert.equal(unmodeledNames([{forecast:{warnings:[],notModeled:['Strike','Bash+']}}]).size,0,'supported cards are not unknown');
});

test('text and presence are read from the state; notes persist across instances',async()=>{
 const state={player:{status:[],relics:[{name:'Razor Tooth',description:'Upgrade played cards.'}],hand:[{name:'Strike+'}]},battle:{enemies:[{name:'Corpse Slug',status:[{name:'Ravenous',description:'Eats the dead.'}]}]}};
 assert.equal(mechanicText(state,'Ravenous'),'Corpse Slug: Eats the dead.');
 assert.ok(presentNames(state).has('card: Strike')&&presentNames(state).has('relic: Razor Tooth')&&presentNames(state).has('enemy power: Ravenous'));
 const scales={player:{status:[{name:'Thorns'}]},battle:{enemies:[]}};
 assert.ok(presentNames(scales).has('player power: Thorns')&&!presentNames(scales).has('enemy power: Thorns'),'your Thorns is not the enemy note');
 const dir=await mkdtemp(join(tmpdir(),'jev-mech-'));
 try{await fileMechanics(dir).set('Ravenous','A survivor eats the dead: kill them together.',{},'enemy power');
  assert.equal((await fileMechanics(dir).all())[mechanicKey('enemy power','Ravenous')].note,'A survivor eats the dead: kill them together.');}
 finally{await rm(dir,{recursive:true,force:true});}
});
