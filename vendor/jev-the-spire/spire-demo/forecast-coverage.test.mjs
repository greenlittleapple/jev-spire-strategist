import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectSequence, planCandidates, unmodeledMechanics} from './planner.mjs';

// Mechanics added after ranking the unmodelled names in the run log by fights lost, elites and bosses.
// Numbers come from logged consecutive states (run log, 2026-09-27 to 2026-09-30).
const card=(index,name,cost,type,description,target_type='AnyEnemy')=>({index,id:name.toUpperCase(),name,cost,type,description,can_play:true,target_type,keywords:[]});
const enemy=(id,name,hp,{block=0,status=[],intents=[{type:'Attack',label:'10',description:'Attack for 10 damage.'}]}={})=>({entity_id:id,name,hp,max_hp:hp,block,status,intents});
const fight=(hand,enemies,{hp=60,max_hp=80,energy=3,block=0,status=[],relics=[]}={})=>({
 state_type:'elite',run:{live_id:'run',act:1,floor:14},
 player:{hp,max_hp,energy,block,hand,potions:[],status,relics,deck:[]},
 battle:{round:1,turn:'player',is_play_phase:true,enemies}});
const strike=(i,n=6)=>card(i,'Strike','1','Attack',`Deal ${n} damage.`);
const defend=i=>card(i,'Defend','1','Skill','Gain 5 Block.','Self');
const vulnerable={name:'Vulnerable',amount:2,description:'Receive 50% more damage from Attacks for 2 turns.'};
const relic=(id,name,description,counter=null)=>({id,name,description,counter,keywords:[]});

test('killing a Waterfall Giant stuns it: no damage this turn, its Steam Eruption comes next turn',()=>{
 // Logged: Strike killed the Giant at 2 HP; the next state showed it Stunned and the player took nothing that turn.
 const steam={name:'Steam Eruption',amount:42,description:'When killed, deals 42 damage at the end of your next turn.'};
 const s=fight([strike(0)],[enemy('g','Waterfall Giant',2,{status:[steam],intents:[{type:'Attack',label:'13'}]})],{hp:2,block:12});
 const f=projectSequence(s,['Strike → Waterfall Giant']);
 assert.equal(f.quality,'partial');assert.equal(f.hpLoss,0);assert.equal(f.survives,true);
 assert.equal(f.boundary,'death_effect');
 assert.ok(f.warnings.some(w=>/Waterfall Giant is stunned, not defeated: When killed, deals 42 damage/.test(w)));
 assert.deepEqual(unmodeledMechanics(s),[]);
});

test('a Decimillipede segment killed while another lives is out of this turn; killing every segment stays unknown',()=>{
 const reattach={name:'Reattach',amount:25,description:'If other segments are still alive, revives in 2 turns with 25 HP.'};
 const seg=(id,hp,label)=>enemy(id,id,hp,{status:[{...reattach}],intents:[{type:'Attack',label}]});
 const s=fight([strike(0),strike(1)],[seg('Front',6,'8'),seg('Back',30,'10')]);
 const one=projectSequence(s,['Strike → Front']);
 assert.equal(one.hpLoss,10);assert.equal(one.quality,'calculated');
 const both=projectSequence(fight([strike(0),strike(1)],[seg('Front',6,'8'),seg('Back',6,'10')]),['Strike → Front','Strike → Back']);
 assert.equal(both.hpLoss,null);
});

test('Red Skull adds its Strength when HP falls to half during the plan',()=>{
 // Logged: Bloodletting at 43 of 80 HP left 40 and raised Strength 2 to 5; Strike showed 8, then 11.
 const skull=relic('RED_SKULL','Red Skull','While your HP is at or below 50%, you have 3 additional Strength.');
 const blood=card(0,'Bloodletting','0','Skill','Lose 3 HP. Gain [ironclad_energy_icon.png][ironclad_energy_icon.png].','Self');
 const s=fight([blood,strike(1,8)],[enemy('e','E',100)],{hp:43,relics:[skull]});
 assert.equal(projectSequence(s,['Bloodletting','Strike → E']).damage,11);
 assert.equal(projectSequence({...s,player:{...s.player,hp:60}},['Bloodletting','Strike → E']).damage,8);
 // Already at half: the live Strength and card text include it.
 assert.equal(projectSequence({...s,player:{...s.player,hp:40}},['Bloodletting','Strike → E']).damage,8);
 assert.deepEqual(unmodeledMechanics(s),[]);
});

test('Nunchaku gives energy on the 10th Attack; a counter shown at 10 has already reset',()=>{
 // Logged: Strike (cost 1) at counter 9 with 1 energy left 1 energy.
 const nun=c=>relic('NUNCHAKU','Nunchaku','Every time you play 10 Attacks, gain [ironclad_energy_icon.png].',c);
 const s=c=>fight([strike(0)],[enemy('e','E',50)],{energy:1,relics:[nun(c)]});
 assert.equal(projectSequence(s(9),['Strike → E']).energyLeft,1);
 assert.equal(projectSequence(s(8),['Strike → E']).energyLeft,0);
 assert.equal(projectSequence(s(10),['Strike → E']).energyLeft,0);
 assert.ok(projectSequence(s(null),['Strike → E']).warnings.includes('Nunchaku counter unavailable: forecast omits its effect.'));
});

test('Kusarigama hits the only enemy on every 3rd Attack in a turn, without Vulnerable',()=>{
 // Logged: Iron Wave 5 at counter 2 took 40 to 29; Dismantle 32 on a Vulnerable enemy at counter 2 took 38.
 const kus=c=>relic('KUSARIGAMA','Kusarigama','Every time you play 3 Attacks in a single turn, deal 6 damage to a random enemy.',c);
 const wave=card(0,'Iron Wave','1','Attack','Gain 5 Block. Deal 5 damage.');
 assert.equal(projectSequence(fight([wave],[enemy('e','E',40)],{relics:[kus(2)]}),['Iron Wave → E']).damage,11);
 assert.equal(projectSequence(fight([strike(0,8)],[enemy('e','E',49,{status:[vulnerable]})],{relics:[kus(2)]}),['Strike → E']).damage,18);
 assert.equal(projectSequence(fight([wave],[enemy('e','E',40)],{relics:[kus(3)]}),['Iron Wave → E']).damage,5);
 assert.equal(projectSequence(fight([wave],[enemy('a','A',40),enemy('b','B',40)],{relics:[kus(2)]}),['Iron Wave → A']).boundary,'random');
});

test('Pen Nib doubles only the 10th Attack; at counter 9 the hand already shows double damage',()=>{
 // Logged: at counter 9 Molten Fist showed 20 (base 10) and dealt 20; at counter 10 Iron Wave showed its base 5.
 const nib=c=>relic('PEN_NIB','Pen Nib','Every 10th Attack you play deals double damage.',c);
 const s=fight([strike(0,20),strike(1,12)],[enemy('e','E',100)],{relics:[nib(9)]});
 assert.equal(projectSequence(s,['Strike → E']).damage,20);
 assert.equal(projectSequence(s,['Strike → E','Strike → E']).damage,26);
 assert.equal(projectSequence(fight([strike(0),strike(1)],[enemy('e','E',100)],{relics:[nib(8)]}),['Strike → E','Strike → E']).damage,18);
});

test('Velvet Choker stops card plays at its limit, counting cards played earlier this turn',()=>{
 const choker=c=>relic('VELVET_CHOKER','Velvet Choker','Gain [ironclad_energy_icon.png] at the start of each turn. You cannot play more than 6 cards per turn.',c);
 const s=fight([defend(0),defend(1)],[enemy('e','E',50)],{relics:[choker(5)]});
 assert.equal(projectSequence(s,['Defend']).block,5);
 assert.throws(()=>projectSequence(s,['Defend','Defend']),/Action not available: Defend/);
 assert.ok(planCandidates(s).every(c=>c.plan.filter(p=>p.label==='Defend').length<=1));
 assert.equal(projectSequence(fight([defend(0),defend(1)],[enemy('e','E',50)],{relics:[choker(4)]}),['Defend','Defend']).block,10);
});

test('Mangle lowers the target Strength this turn; the resulting enemy power is already in its intent',()=>{
 // Logged: Mangle 15 on a Vulnerable Slimed Berserker took 94 to 72; its Attack 20 showed 10 afterwards.
 const mangle=card(0,'Mangle','0','Attack','Deal 15 damage. Enemy loses 10 Strength this turn.');
 const s=fight([mangle],[enemy('b','Berserker',94,{status:[vulnerable],intents:[{type:'Attack',label:'20'}]})]);
 const f=projectSequence(s,['Mangle → Berserker']);
 assert.equal(f.damage,22);assert.equal(f.incoming,10);assert.equal(f.quality,'calculated');
 const after=fight([],[enemy('b','Berserker',72,{status:[{name:'Mangle',amount:10,description:'Lose 10 Strength until the end of this turn.'},{name:'Shackling Potion',amount:7,description:'Lose 7 Strength until the end of this turn.'}]})]);
 assert.deepEqual(unmodeledMechanics(after),[]);
});

test('Fight Me! hits twice before its Strength, and the enemy hits harder',()=>{
 // Logged: Vine Shambler 61 to 51, its 6x2 became 7x2, and Strike showed 6 then 9.
 const fm=card(0,'Fight Me!','2','Attack','Deal 5 damage twice. Gain 3 Strength. The enemy gains 1 Strength.');
 const s=fight([fm,strike(1)],[enemy('v','Vine Shambler',61,{intents:[{type:'Attack',label:'6x2 (12)'}]})]);
 const f=projectSequence(s,['Fight Me! → Vine Shambler']);
 assert.equal(f.damage,10);assert.equal(f.incoming,14);assert.equal(f.strengthGained,3);
 assert.equal(projectSequence(s,['Fight Me! → Vine Shambler','Strike → Vine Shambler']).damage,19);
});

test('Omnislice splashes the damage dealt to every other enemy, through their block',()=>{
 // Logged: 8 on a Vulnerable Snapping Jaxfruit took 23 to 11 and the Flyconid 48 to 36;
 // Omnislice+ 11 took a Bowlbug 40 to 29, the other Bowlbug 43 to 32 and a beetle's 15 block to 4.
 const omni=n=>card(0,'Omnislice','0','Attack',`Deal ${n} damage. Damage ALL other enemies equal to the damage dealt.`);
 assert.equal(projectSequence(fight([omni(8)],[enemy('j','Jaxfruit',23,{status:[vulnerable]}),enemy('f','Flyconid',48)]),['Omnislice → Jaxfruit']).damage,24);
 const f=projectSequence(fight([omni(11)],[enemy('r','Rock',40),enemy('s','Silk',43),enemy('b','Beetle',86,{block:15})]),['Omnislice → Rock']);
 assert.equal(f.damage,22);assert.ok(!f.warnings.some(w=>/Omnislice/.test(w)));
});

test('Fisticuffs gains block equal to the damage dealt, block-absorbed damage and Vulnerable included',()=>{
 // Logged: 7 into a Louse Progenitor's 14 block gave 7 Block; 14 on a Vulnerable Knowledge Demon gave 21.
 const fist=n=>card(0,'Fisticuffs','1','Attack',`Deal ${n} damage. Gain Block equal to damage dealt.`);
 assert.equal(projectSequence(fight([fist(7)],[enemy('l','Louse',118,{block:14})]),['Fisticuffs → Louse']).block,7);
 assert.equal(projectSequence(fight([fist(14)],[enemy('k','Demon',319,{status:[vulnerable]})]),['Fisticuffs → Demon']).block,21);
 const kill=projectSequence(fight([fist(14)],[enemy('k','Demon',5)]),['Fisticuffs → Demon']);
 assert.equal(kill.block,5);assert.ok(kill.warnings.some(w=>/Fisticuffs kill/.test(w)));
});

test('Second Wind exhausts every non-Attack in hand for block each',()=>{
 // Logged: Second Wind+ with one Power beside it gave 7 Block and left only the Attacks.
 const wind=card(0,'Second Wind','1','Skill','Exhaust all non-Attack cards in your Hand. Gain 7 Block for each card Exhausted.','Self');
 const power=card(1,'Juggling','1','Power','Add 1 copy of the third Attack you play each turn into your Hand.','Self');
 const s=fight([wind,power,strike(2),defend(3)],[enemy('e','E',50)]);
 assert.equal(projectSequence(s,['Second Wind']).block,14);
 assert.equal(projectSequence(fight([wind,strike(1)],[enemy('e','E',50)]),['Second Wind']).block,0);
});

test('plain damage and block cards, later-only powers, and cards that need a fresh look',()=>{
 const s=fight([card(0,'Blizzara','1','Attack','Deal 8 damage.  Gain 5 Block.'),card(1,'Thrumming Hatchet','1','Attack','Deal 11 damage. At the start of your next turn, return this to your Hand.'),
  card(2,'Demon Form','3','Power','At the start of your turn, gain 3 Strength.','Self'),card(3,'Primal Force','0','Skill','Transform all Attacks in your Hand into Giant Rock.','Self'),
  card(4,"Neow's Fury",'1','Attack','Deal 10 damage. Put up to 2 cards from your Discard Pile into your Hand. Exhaust.')],[enemy('e','E',100)],{energy:5});
 const b=projectSequence(s,['Blizzara → E','Thrumming Hatchet → E']);
 assert.equal(b.damage,19);assert.equal(b.block,5);assert.equal(b.notModeled.length,0);
 const d=projectSequence(s,['Demon Form']);assert.equal(d.energyLeft,2);assert.ok(d.warnings.some(w=>/starts later/.test(w)));
 assert.equal(projectSequence(s,['Primal Force']).boundary,'transform');
 const n=projectSequence(s,["Neow's Fury → E"]);assert.equal(n.damage,10);assert.equal(n.boundary,'selection');
});

test('enemy Thorns text is a known retaliation; relics with nothing to do within a turn are not flagged',()=>{
 // Logged: Thrumming Hatchet into a Spiny Toad with Thorns 5 took 5 of the player's 5 Block.
 const thorns={name:'Thorns',amount:5,description:'When hit by an attack, deal 5 damage back.'};
 const s=fight([strike(0,11)],[enemy('t','Spiny Toad',100,{status:[thorns]})],{block:5});
 const f=projectSequence(s,['Strike → Spiny Toad']);
 assert.equal(f.quality,'calculated');assert.equal(f.block,0);assert.equal(f.retaliationEvents.length,1);
 // Strike Dummy is already in the shown damage (logged: Strike showed 9 with no Strength and dealt 9).
 const quiet=['STRIKE_DUMMY','BAG_OF_MARBLES','PENDULUM','WINGED_BOOTS','SOZU','BRIMSTONE','SAI'].map(id=>relic(id,id,'Start of turn or outside combat.'));
 assert.deepEqual(unmodeledMechanics(fight([],[enemy('e','E',10)],{relics:quiet})),[]);
});
