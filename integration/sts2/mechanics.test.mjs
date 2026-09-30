import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unmodeledNames,unknownMechanics,mechanicsToAsk,mechanicText,presentNames,fileMechanics,mechanicKey} from './mechanics.mjs';

test('unmodeled names come from forecast warnings and unmodeled cards',()=>{
 const n=unmodeledNames([{forecast:{warnings:['Unmodeled enemy power: Ravenous','Stops before unknown drawn cards; re-observe.'],notModeled:['Cascade+']}},{forecast:{warnings:['Unmodeled relic: Razor Tooth']}}]);
 assert.deepEqual([...n],[['Ravenous','enemy power'],['Cascade','card'],['Razor Tooth','relic']]);
 assert.equal(unmodeledNames([{forecast:{warnings:[],notModeled:['Strike','Bash+']}}]).size,0,'supported cards are not unknown');
 const typed=unmodeledNames([{forecast:{warnings:[],notModeled:['enemy power: Ravenous','relic: Pendulum','enemy power: Shackling Potion','Cascade+']}}]);
 assert.deepEqual([...typed],[['Ravenous','enemy power'],['Pendulum','relic'],['Cascade','card']],"typed notModeled entries keep their kind; a modelled potion's own effect is left out");
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

const warn=(...w)=>[{forecast:{warnings:w.map(x=>'Unmodeled '+x)}}];
const fighter=(deck,potions=[])=>({player:{deck:deck.map(([name,type])=>({name,type})),potions:potions.map(name=>({name})),status:[]},battle:{enemies:[]}});

test('effects of your own cards and potions are not unknown mechanics',()=>{
 // JEV22 f7: the Strength loss from our Shackling Potion (already drunk) showed as an enemy power.
 assert.deepEqual(unknownMechanics(fighter([['Strike','Attack']]),warn('enemy power: Shackling Potion')),[]);
 assert.equal(unmodeledNames(warn('enemy power: Shackling Potion')).size,0,'dropped at the source too');
 // JEV21: The Bomb was explained as a card on f2, then asked again as a player power on f7.
 const bomb=fighter([['The Bomb','Skill']]);
 assert.deepEqual(unknownMechanics(bomb,warn('player power: The Bomb'),{[mechanicKey('card','The Bomb')]:{name:'The Bomb',kind:'card'}}),[]);
 // Unexplained, the card is asked about once (as a card), so its note covers the power too.
 assert.deepEqual(unknownMechanics(bomb,[{forecast:{warnings:['Unmodeled player power: The Bomb'],notModeled:['The Bomb']}}]),[['The Bomb','card']]);
 // A modeled card's power (Flame Barrier, Setup Strike's temporary Strength) is known; an unmodeled one
 // with a card note (Mangle's Strength loss on the enemy) is known too.
 assert.deepEqual(unknownMechanics(fighter([['Flame Barrier','Skill'],['Setup Strike','Attack']]),warn('player power: Flame Barrier','player power: Setup Strike')),[]);
 assert.deepEqual(unknownMechanics(fighter([['Mangle','Attack']]),warn('enemy power: Mangle'),{[mechanicKey('card','Mangle')]:{}}),[]);
});

test('genuine unknown enemy powers are still asked',()=>{
 // Not in the deck, or an enemy power sharing a Power card's name: still the enemy's.
 assert.deepEqual(unknownMechanics(fighter([['Strike','Attack']]),warn('enemy power: Ravenous')),[['Ravenous','enemy power']]);
 assert.deepEqual(unknownMechanics(fighter([['Barricade','Power']]),warn('enemy power: Barricade')),[['Barricade','enemy power']]);
 // Thorns on an enemy and your own Thorns keep separate notes.
 assert.deepEqual(unknownMechanics(fighter([]),warn('enemy power: Thorns'),{[mechanicKey('player power','Thorns')]:{}}),[['Thorns','enemy power']]);
 assert.deepEqual(unknownMechanics(fighter([]),warn('enemy power: Thorns'),{[mechanicKey('enemy power','Thorns')]:{}}),[]);
});

test('each name is asked at most once per fight',()=>{
 const unknown=[['Tainted','player power'],['Slow','enemy power']];
 assert.deepEqual(mechanicsToAsk(unknown,['r:2:27|Tainted'],'r:2:27'),[['Slow','enemy power']]);
 assert.deepEqual(mechanicsToAsk(unknown,['r:2:27|Tainted'],'r:2:28'),unknown,'another fight asks again');
});
