import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectSequence, markHitsThisTurn, markLampUsed, noteDebuffCard} from './planner.mjs';
// Fixture: Strike "Deal 9 damage. Replay 1.", two Defends, Battle Trance; Seapunk 27 HP attacking for 12.
const state=()=>JSON.parse(readFileSync(new URL('./fixtures/replay-strike.json',import.meta.url))).state;
const power=(name,amount,description)=>({name,amount,description,type:'Buff'});
const strike='Strike → Seapunk';

test('Hardened Shell amount is the HP the enemy can still lose this turn',()=>{
 const s=state();s.battle.enemies[0].status=[power('Hardened Shell',5,'Seapunk cannot lose more than 20 HP each turn.')];
 const f=projectSequence(s,[strike]);
 assert.equal(f.damage,5);assert.ok(!f.warnings.some(w=>/Hardened|not observed|Unmodeled enemy/.test(w)));
});

test('Skittish gives Block after the first attack hit each turn, not after a turn already hit',()=>{
 const s=state();s.battle.enemies[0].status=[power('Skittish',6,'The first time Seapunk is hit each turn, it gains 6 Block.')];
 assert.equal(projectSequence(s,[strike]).damage,9+3,'the replayed hit meets 6 Block');
 const hitAlready=structuredClone(s);hitAlready.battle.enemies[0].hit_this_turn=true;
 assert.equal(projectSequence(hitAlready,[strike]).damage,18);
});

test('the turn tracker marks an enemy hit once its HP fell or Block rose this turn',()=>{
 const memory={},s=state();
 assert.equal(markHitsThisTurn(memory,s).battle.enemies[0].hit_this_turn,undefined);
 const later=structuredClone(s);later.battle.enemies[0].hp-=9;later.battle.enemies[0].block=6;
 assert.equal(markHitsThisTurn(memory,later).battle.enemies[0].hit_this_turn,true);
 const next=structuredClone(later);next.battle.round+=1;
 assert.equal(markHitsThisTurn(memory,next).battle.enemies[0].hit_this_turn,undefined,'a new round starts over');
});

test('Cloak Clasp adds 1 Block per card left in hand at end of turn',()=>{
 const s=state();assert.equal(projectSequence(s,[]).hpLoss,12);
 s.player.relics.push({id:'CLOAK_CLASP',name:'Cloak Clasp',description:'At the end of your turn, gain 1 Block for each card in your Hand.'});
 const f=projectSequence(s,[]);assert.equal(f.hpLoss,8);assert.ok(!f.warnings.some(w=>/Cloak Clasp/.test(w)));
 assert.equal(projectSequence(s,['Defend']).hpLoss,12-5-3,'one fewer card after playing Defend');
});

test('Letter Opener deals 5 to all enemies on the third Skill of the turn',()=>{
 const s=state();s.player.relics.push({id:'LETTER_OPENER',name:'Letter Opener',counter:2,description:'Every time you play 3 Skills in a single turn, deal 5 damage to ALL enemies.'});
 assert.equal(projectSequence(s,['Defend']).damage,5);
 s.player.relics.at(-1).counter=0;assert.equal(projectSequence(s,['Defend']).damage,0);
});

test('relics with no in-turn effect add no warning',()=>{
 const s=state();s.player.relics.push({id:'BOWLER_HAT',name:'Bowler Hat'},{id:'ODDLY_SMOOTH_STONE',name:'Oddly Smooth Stone'});
 assert.ok(!projectSequence(s,[]).warnings.some(w=>/Bowler|Smooth/.test(w)));
});

test('Unsettling Lamp doubles the first debuff of the combat once the runner says it is unused',()=>{
 const s=state();s.player.hand[1]={...s.player.hand[1],name:'Bash',type:'Attack',target_type:'AnyEnemy',cost:'2',description:'Deal 8 damage. Apply 2 Vulnerable.'};
 s.player.relics.push({id:'UNSETTLING_LAMP',name:'Unsettling Lamp',counter:null});
 s.player.lamp_used=false;
 const after=(st)=>{const e=projectSequence(st,['Bash → Seapunk']);return e;};
 assert.ok(!after(s).warnings.some(w=>/Lamp/.test(w)));
 const unknown=structuredClone(s);delete unknown.player.lamp_used;
 assert.ok(after(unknown).warnings.some(w=>/Lamp.*unknown/.test(w)));
});

test('the lamp tracker marks the fight once a debuffing card is played',()=>{
 const mem={},s=state();s.player.relics.push({id:'UNSETTLING_LAMP',name:'Unsettling Lamp'});
 assert.equal(markLampUsed(mem,s).player.lamp_used,false);
 s.player.hand[0].description='Apply 2 Weak.';noteDebuffCard(mem,s,{command:{action:'play_card',card_index:s.player.hand[0].index}});
 assert.equal(markLampUsed(mem,s).player.lamp_used,true);
});

test('Smoggy allows one Skill per turn within a plan',()=>{
 const s=state();s.player.energy=3;s.player.status=[{name:'Smoggy',amount:1,description:'You can only play 1 Skill per turn.'}];
 assert.throws(()=>projectSequence(s,['Defend','Defend']),/not available/);
 assert.equal(projectSequence(s,['Defend']).hpLoss,7);
});

test('end-of-turn debuff damage counts as blockable damage, Constrict only while its source lives',()=>{
 const s=state();s.player.status=[{name:'Disintegration',amount:6,type:'Debuff',description:'At the end of your turn, take 6 damage.'}];
 assert.equal(projectSequence(s,[]).hpLoss,18);
 assert.equal(projectSequence(s,['Defend']).hpLoss,13);
 const c=state();c.player.status=[{name:'Constrict',amount:3,type:'Debuff',description:'While the Slithering Strangler is alive, at the end of your turn, take 3 damage.'}];
 assert.equal(projectSequence(c,[]).hpLoss,12,'no Strangler in this fight');
 c.battle.enemies[0].name='Slithering Strangler';assert.equal(projectSequence(c,[]).hpLoss,15);
});

test('an active Regen heals at the end of the turn before the attack',()=>{
 const s=state();s.player.hp=60;s.player.status=[{name:'Regen',amount:5,type:'Buff',description:'At the end of your turn, heal 5 HP.'}];
 const f=projectSequence(s,[]);assert.equal(f.hpLoss,7);assert.equal(f.hpAfter,53);
 s.player.hp=s.player.max_hp;assert.equal(projectSequence(s,[]).hpLoss,12,'no heal above max HP');
});

test('an active Colossus is already in the displayed intent of a Vulnerable enemy',()=>{
 const s=state();s.player.status=[{name:'Colossus',amount:1,type:'Buff',description:'You receive 50% less damage from Vulnerable enemies this turn.'}];
 s.battle.enemies[0].status=[{name:'Vulnerable',amount:2,type:'Debuff',description:'Receive 50% more damage.'}];
 assert.equal(projectSequence(s,[]).hpLoss,12,'the shown 12 already includes the halving');
 const fresh=state();fresh.player.status=[{name:'Colossus',amount:1,type:'Buff',description:'You receive 50% less damage from Vulnerable enemies this turn.'}];
 fresh.battle.enemies[0].status=[];fresh.player.hand[1]={...fresh.player.hand[1],name:'Bash',type:'Attack',target_type:'AnyEnemy',cost:'2',description:'Deal 8 damage. Apply 2 Vulnerable.'};fresh.player.energy=2;
 assert.equal(projectSequence(fresh,['Bash → Seapunk']).hpLoss,6,'made Vulnerable in the plan: halve');
});
