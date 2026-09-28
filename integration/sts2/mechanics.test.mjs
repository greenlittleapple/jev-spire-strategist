import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unmodeledNames,mechanicText,presentNames,fileMechanics} from './mechanics.mjs';

test('unmodeled names come from forecast warnings and unmodeled cards',()=>{
 const n=unmodeledNames([{forecast:{warnings:['Unmodeled enemy power: Ravenous','Stops before unknown drawn cards; re-observe.'],notModeled:['Cascade+']}},{forecast:{warnings:['Unmodeled relic: Razor Tooth']}}]);
 assert.deepEqual([...n],[['Ravenous','enemy power'],['Cascade','card'],['Razor Tooth','relic']]);
});

test('text and presence are read from the state; notes persist across instances',async()=>{
 const state={player:{status:[],relics:[{name:'Razor Tooth',description:'Upgrade played cards.'}],hand:[{name:'Strike+'}]},battle:{enemies:[{name:'Corpse Slug',status:[{name:'Ravenous',description:'Eats the dead.'}]}]}};
 assert.equal(mechanicText(state,'Ravenous'),'Corpse Slug: Eats the dead.');
 assert.ok(presentNames(state).has('Strike')&&presentNames(state).has('Razor Tooth'));
 const dir=await mkdtemp(join(tmpdir(),'jev-mech-'));
 try{await fileMechanics(dir).set('Ravenous','A survivor eats the dead: kill them together.');
  assert.equal((await fileMechanics(dir).all()).Ravenous.note,'A survivor eats the dead: kill them together.');}
 finally{await rm(dir,{recursive:true,force:true});}
});
