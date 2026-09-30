import {test} from 'node:test';
import assert from 'node:assert/strict';
import {candidateNames,makeGlossary} from './glossary.mjs';

const catalog={'metamorphosis':{name:'Metamorphosis',item_type:'card',description:'Add 3 random Attacks into your Draw Pile.'},
 'red skull':{name:'Red Skull',item_type:'relic',description:'While your HP is at or below 50%, you have 3 additional Strength.'},
 'chosen cheese':{name:'The Chosen Cheese',item_type:'relic',description:'At the end of combat, gain 1 Max HP.'},
 'red':{name:'Red Mask',item_type:'relic',description:'fuzzy'}};
const lookup=async name=>{const k=name.toLowerCase().replace(/^the /,'');return catalog[k]?[catalog[k]]:[catalog.red];};

test('names inside option text are found, keywords are not',()=>{
 assert.deepEqual(candidateNames('Heal 25 HP. Add Metamorphosis to your Deck.'),['Metamorphosis']);
 assert.deepEqual(candidateNames('Lose 14 HP. Obtain the Chosen Cheese.'),['Chosen Cheese']);
 assert.deepEqual(candidateNames('Gain 5 Block. Apply 1 Vulnerable.'),[]);
});

test('missing option descriptions are filled and mentioned items are explained, exact matches only',async()=>{
 const brief={deck:[{name:'Strike'}],relics:[],current_options:[
  {id:'a0',label:'Red Skull — 189 gold'},{id:'a1',label:'Weak Potion — 51 gold'},
  {id:'a2',label:'Let It In',description:'Heal 25 HP. Add Metamorphosis to your Deck.'},
  {id:'a3',label:'Search',description:'Lose 14 HP. Obtain the Chosen Cheese.'}]};
 await makeGlossary(lookup)(brief);
 assert.match(brief.current_options[0].description,/3 additional Strength/);assert.equal(brief.current_options[0].item_type,'relic');
 assert.equal(brief.current_options[1].description,undefined,'a fuzzy match is not used');
 assert.deepEqual(brief.glossary.map(g=>g.name),['Metamorphosis','The Chosen Cheese']);
});

test('lookup failures leave the brief usable',async()=>{
 const brief={current_options:[{id:'a0',label:'Red Skull — 189 gold'}]};
 await makeGlossary(async()=>{throw Error('bridge down');})(brief);
 assert.equal(brief.current_options[0].description,undefined);assert.equal(brief.glossary,undefined);
});

import {strategistBrief} from './strategy.mjs';
test('briefs keep relic, potion and event relic descriptions, keywords and the combat hand',()=>{
 const state={state_type:'shop',run:{live_id:'r',act:2,floor:22},player:{hp:50,max_hp:80,gold:300,deck:[],relics:[],potions:[]}};
 const candidates=[
  {id:'a0',label:'Red Skull — 189 gold',details:{category:'relic',relic_name:'Red Skull',relic_description:'While your HP is at or below 50%, you have 3 additional Strength.',keywords:[{name:'Strength',description:'Adds damage.'}]}},
  {id:'a1',label:'Weak Potion — 51 gold',details:{category:'potion',potion_name:'Weak Potion',potion_description:'Apply 3 Weak.'}},
  {id:'a2',label:'Block Potion',details:{type:'potion',description:'Block Potion'}}];
 const b=strategistBrief(state,candidates,'owned_screen',null);
 assert.match(b.current_options[0].description,/3 additional Strength/);
 assert.equal(b.current_options[1].description,'Apply 3 Weak.');
 assert.equal(b.current_options[2].description,undefined,'a description that only repeats the label is dropped');
 assert.deepEqual(b.keywords,{Strength:'Adds damage.'});
 const event={...state,state_type:'event'};
 const e=strategistBrief(event,[{id:'a0',label:'Neow',details:{description:'Gain a relic.',relic_name:'Neow Bones',relic_description:'Upon pickup, gain 2 relics.'}}],'owned_screen',null);
 assert.equal(e.current_options[0].description,'Gain a relic. Neow Bones: Upon pickup, gain 2 relics.');
 const fight={state_type:'elite',run:state.run,player:{...state.player,energy:3,max_energy:3,block:4,status:[{name:'Strength',amount:2,description:'x'}],
  hand:[{name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.'}],draw_pile_count:10},battle:{round:2,enemies:[]}};
 const c=strategistBrief(fight,[],'elite_start',null);
 assert.equal(c.combat_state.energy,3);assert.equal(c.combat_state.hand[0].name,'Strike');assert.equal(c.combat_state.status[0].name,'Strength');
});

test('event briefs carry the event name and page text',()=>{
 const state={state_type:'event',run:{live_id:'r',act:2,floor:21},player:{hp:50,max_hp:80,deck:[],relics:[],potions:[]},
  event:{event_name:'Room Full of Cheese',body:'Cheese everywhere.',options:[]}};
 const b=strategistBrief(state,[{id:'a0',label:'Gorge',details:{description:'Choose 2 of 8 random Common cards.'}}],'owned_screen',null);
 assert.deepEqual(b.event,{name:'Room Full of Cheese',text:'Cheese everywhere.'});
});

// JEV21 f27: a Vital Spark fight turned every Defend into "Gain 5 Block. Gain 2 Tainted." and the
// bridge's keyword only repeated the name; Tainted was undefined until an unknown_mechanic request.
const tainted={name:'Tainted',description:'Gain 2 Tainted when played.'};
const defend={name:'Defend',type:'Skill',cost:'1',description:'Gain 5 Block. Gain 2 Tainted.',keywords:[tainted,{name:'Block',description:'Until next turn, prevents damage.'}]};
test('keywords in deck and hand card text are defined, in combat too',()=>{
 const state={state_type:'map',run:{live_id:'r',act:2,floor:26},player:{hp:50,max_hp:80,deck:[defend,{name:'Bash',description:'Apply 2 Vulnerable.',keywords:[{name:'Vulnerable',description:'Takes 50% more damage.'}]}],relics:[],potions:[]}};
 assert.deepEqual(strategistBrief(state,[],'route_plan',null).keywords,{Tainted:tainted.description,Block:'Until next turn, prevents damage.',Vulnerable:'Takes 50% more damage.'});
 // With the power on you, its text defines a keyword that only repeats its name.
 const fight={...state,state_type:'elite',player:{...state.player,deck:[],hand:[defend],status:[{name:'Tainted',amount:2,description:'Take 2 additional damage from Attacks this turn.'}]},battle:{round:2,enemies:[]}};
 assert.equal(strategistBrief(fight,[],'unknown_mechanic',null).keywords.Tainted,'Take 2 additional damage from Attacks this turn.');
});

test('the glossary defines a keyword that repeats its name from a power seen earlier or the lookup',async()=>{
 const glossary=makeGlossary(async name=>name==='Vulnerable'?[{name:'Vulnerable',item_type:'card',description:'wrong kind'}]:[]);
 const later={deck:[],relics:[],keywords:{Tainted:tainted.description,Block:'Until next turn, prevents damage.'}};
 await glossary({deck:[],relics:[],combat_state:{status:[{name:'Tainted',amount:2,description:'Take 2 additional damage from Attacks this turn.'}]}});
 await glossary(later);
 assert.equal(later.keywords.Tainted,'Take 2 additional damage from Attacks this turn.');
 assert.equal(later.keywords.Block,'Until next turn, prevents damage.','a real definition is kept');
 const unseen={deck:[],relics:[],keywords:{Dazed:'Dazed. Unplayable.'}};
 await makeGlossary(async()=>[])(unseen);
 assert.equal(unseen.keywords.Dazed,'Dazed. Unplayable.','with nothing better the bridge text stays');
 // Not seen this session: the strategist's saved note for the power defines it.
 const fresh={deck:[],relics:[],keywords:{Tainted:tainted.description}};
 await makeGlossary(async()=>[],{notes:{all:async()=>({'player power: Tainted':{name:'Tainted',kind:'player power',note:'Each stack adds 1 damage to every enemy attack hit this turn.'}})}})(fresh);
 assert.equal(fresh.keywords.Tainted,'Each stack adds 1 damage to every enemy attack hit this turn.');
});
