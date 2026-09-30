import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectSequence,unmodeledMechanics} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';

// Numbers below come from logged plays (run log, 2026-09-27 to 2026-09-30).
const card=(index,name,cost,type,description,target_type='AnyEnemy')=>({index,id:name.toUpperCase(),name,cost,type,description,can_play:true,target_type,keywords:[]});
const fight=(hand,{status=[],enemyStatus=[],energy=3,hp=200}={})=>({
 state_type:'elite',run:{live_id:'run',act:1,floor:14},
 player:{hp:60,max_hp:80,energy,block:0,hand,potions:[],status,relics:[],deck:[]},
 battle:{round:1,turn:'player',is_play_phase:true,enemies:[{entity_id:'e',name:'E',hp,max_hp:hp,block:0,status:enemyStatus,intents:[{type:'Attack',label:'10',description:'Attack for 10 damage.'}]}]}});
const slow=amount=>({name:'Slow',amount,description:'Whenever you play a card, this enemy receives 10% more damage from Attacks this turn.'});
const vulnerable={name:'Vulnerable',amount:2,description:'Receive 50% more damage from Attacks for 2 turns.'};
const strike=(i,n=6)=>card(i,'Strike','1','Attack',`Deal ${n} damage.`);
const defend=i=>card(i,'Defend','1','Skill','Gain 5 Block.','Self');

test('Slow multiplies attack damage by the cards already played this turn, rounded down',()=>{
 // JEV21 floor 14: Molten Fist 10 at Slow 10 dealt 11; Anger 6 at Slow 20 dealt 7.
 const fist=card(0,'Molten Fist','1','Attack','Deal 10 damage. If the enemy is Vulnerable, double its Vulnerable.');
 assert.equal(projectSequence(fight([fist],{enemyStatus:[slow(10)]}),['Molten Fist → E']).damage,11);
 assert.equal(projectSequence(fight([card(0,'Anger','0','Attack','Deal 6 damage. Add a copy of this card into your Discard Pile.')],{enemyStatus:[slow(20)]}),['Anger → E']).damage,7);
 // Vulnerable and Slow multiply before one rounding: Iron Wave 5 at Slow 20 dealt 9, Twin Strike 8 at Slow 20 dealt 28.
 assert.equal(projectSequence(fight([card(0,'Iron Wave','1','Attack','Gain 5 Block. Deal 5 damage.')],{enemyStatus:[slow(20),vulnerable]}),['Iron Wave → E']).damage,9);
 assert.equal(projectSequence(fight([card(0,'Twin Strike','1','Attack','Deal 8 damage twice.')],{enemyStatus:[slow(20),vulnerable]}),['Twin Strike → E']).damage,28);
 // Cards played in the plan raise Slow for later attacks; the attack itself does not count.
 const s=fight([defend(0),defend(1),strike(2)],{enemyStatus:[slow(0)]});
 assert.equal(projectSequence(s,['Strike → E']).damage,6);
 const late=projectSequence(s,['Defend','Defend','Strike → E']);
 assert.equal(late.damage,7);
 assert.ok(!late.warnings.some(w=>/Slow/.test(w)));assert.deepEqual(late.notModeled,[]);
 assert.equal(s.battle.enemies[0].status[0].amount,0,'the observed state is not changed');
});

test('Flutter halves attack damage and stops the plan when its last charge is removed',()=>{
 const flutter=n=>({name:'Flutter',amount:n,description:'Receives 50% less damage from Attacks. Deal attack damage 5 times to Stun it.'});
 // Thieving Hopper: Strike 6 on Vulnerable dealt 4, Pommel Strike 9 dealt 6.
 const s=fight([strike(0),card(1,'Pommel Strike','1','Attack','Deal 9 damage. Draw 1 card.')],{enemyStatus:[flutter(5),{...vulnerable,amount:1}]});
 assert.equal(projectSequence(s,['Strike → E']).damage,4);
 const last=projectSequence(fight([strike(0),strike(1)],{enemyStatus:[flutter(1)]}),['Strike → E']);
 assert.equal(last.damage,3);assert.equal(last.boundary,'enemy_stunned');
});

test('Tender lowers Strength after each play, extra plays included',()=>{
 // Hunter Killer: One-Two Punch replay of Molten Fist dealt 10 then 9.
 const tender={name:'Tender',amount:0,description:'Whenever you play a card, lose 1 Strength and 1 Dexterity this turn.'};
 const s=fight([card(0,'Molten Fist','1','Attack','Deal 10 damage. If the enemy is Vulnerable, double its Vulnerable.')],{status:[tender,{name:'One-Two Punch',amount:1}]});
 assert.equal(projectSequence(s,['Molten Fist → E']).damage,19);
 assert.equal(projectSequence(fight([defend(0),defend(1)],{status:[tender]}),['Defend','Defend']).block,9);
});

test('Duplication plays the next card twice and Vigor applies to the first Attack only',()=>{
 // Waterfall Giant: Strike 9 with Duplication dealt 18.
 assert.equal(projectSequence(fight([strike(0,9)],{status:[{name:'Duplication',amount:1}]}),['Strike → E']).damage,18);
 // Every Attack shows Vigor 4 in its text (Strike 13 = 6 + 3 Strength + 4 Vigor).
 const vigor=fight([strike(0,13),strike(1,13)],{status:[{name:'Vigor',amount:4},{name:'Strength',amount:3}]});
 assert.equal(projectSequence(vigor,['Strike → E','Strike → E']).damage,22);
});

test('Expect a Fight gives energy only from its Sown sentence and adds block for Strength gained in the plan',()=>{
 const eaf=text=>card(0,'Expect a Fight','3','Skill',text,'Self');
 const plain='Gain 15 Block. Gains 5 additional Block for each Strength you have.';
 // Logged: 3 energy, two Attacks in hand, the game showed 0 energy after the play (old forecast: 2).
 const f=projectSequence(fight([eaf(plain),strike(1),strike(2)]),['Expect a Fight']);
 assert.equal(f.energyLeft,0);assert.equal(f.block,15);
 assert.equal(projectSequence(fight([eaf(plain+' Gain [ironclad_energy_icon.png].'),strike(1)]),['Expect a Fight']).energyLeft,1);
 const inflame=card(1,'Inflame','1','Power','Gain 2 Strength.','Self');
 assert.equal(projectSequence(fight([eaf(plain),inflame],{energy:4}),['Inflame','Expect a Fight']).block,25);
});

test('powers the forecast does not cover are listed in notModeled with their kind',()=>{
 const s=fight([strike(0)],{status:[{name:'Hex',amount:1,description:'While Spectral Knight is alive, ALL your cards are Ethereal.'}],
  enemyStatus:[{name:'Steam Eruption',amount:15,description:'When killed, deals 15 damage at the end of your next turn.'},slow(0)]});
 s.player.relics=[{id:'PENDULUM',name:'Pendulum',description:'Something new.'}];
 assert.deepEqual(unmodeledMechanics(s),[{kind:'player power',name:'Hex'},{kind:'enemy power',name:'Steam Eruption'},{kind:'relic',name:'Pendulum'}]);
 const f=projectSequence(s,['Strike → E']);
 assert.deepEqual(f.notModeled,['player power: Hex','enemy power: Steam Eruption','relic: Pendulum']);
 assert.equal(f.quality,'partial');
 assert.ok(f.warnings.includes('Unmodeled enemy power: Steam Eruption'));
 // Powers with no effect before the enemy attacks this turn are not flagged.
 const quiet=fight([strike(0)],{status:[{name:'Pyre',amount:1},{name:'No Draw',amount:1}],enemyStatus:[{name:'Ritual',amount:2}]});
 assert.deepEqual(unmodeledMechanics(quiet),[]);
});
