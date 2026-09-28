import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {orderReviewReason,reviewReason} from './efficient-decisions.mjs';

const card=(index,name,cost,type,description,target_type='AnyEnemy')=>({index,id:name.toUpperCase(),name,cost,type,description,can_play:true,target_type,keywords:[]});
const fight=(hand,{status=[],enemyStatus=[{name:'Vulnerable',amount:2,description:'Receive 50% more damage from Attacks.'}],round=2}={})=>({
 state_type:'monster',run:{live_id:'run',act:1,floor:3},
 player:{hp:50,max_hp:80,energy:3,block:0,hand,potions:[],status,relics:[],deck:[]},
 battle:{round,turn:'player',is_play_phase:true,enemies:[{entity_id:'e',name:'E',hp:200,max_hp:200,block:0,status:enemyStatus,intents:[{type:'Attack',label:'10',description:'Attack for 10 damage.'}]}]}});
const cruelty=card(0,'Cruelty','1','Power','Vulnerable enemies take an additional 25% damage.','Self');
const strike=i=>card(i,'Strike','1','Attack','Deal 6 damage.');
const big=i=>card(i,'Strike','1','Attack','Deal 20 damage.');
const byLabel=(cands,label)=>cands.find(c=>c.label===label);

test('Cruelty is forecast, so playing it before attacks shows more damage',()=>{
 const cands=decisionCandidates(fight([cruelty,strike(1),strike(2)]));
 assert.equal(byLabel(cands,'Cruelty → Strike → E → Strike → E').forecast.damage,20);
 assert.equal(byLabel(cands,'Strike → E → Strike → E').forecast.damage,18);
 assert.deepEqual(byLabel(cands,'Cruelty').forecast.lastingEffects,['Cruelty: Vulnerable enemies take an additional 25% damage.']);
 // An active Cruelty power (amount is the percent) applies to every attack.
 const active=decisionCandidates(fight([strike(0)],{status:[{name:'Cruelty',amount:25,description:'x'}]}));
 assert.equal(byLabel(active,'Strike → E').forecast.damage,10);
});

test('common cards are modeled or name what is missing',()=>{
 const hand=[card(0,'Bloodletting','0','Skill','Lose 3 HP. Gain [ironclad_energy_icon.png][ironclad_energy_icon.png].','Self'),
  card(1,'Spite','1','Attack','Deal 5 damage. If you lost HP this turn, hits 2 times.'),
  card(2,'True Grit','1','Skill','Gain 7 Block. Exhaust 1 card at random.','Self')];
 const cands=decisionCandidates(fight(hand,{enemyStatus:[]}));
 assert.equal(byLabel(cands,'Bloodletting → Spite → E').forecast.damage,10,'Spite hits twice after HP loss this turn');
 assert.equal(byLabel(cands,'Spite → E').forecast.damage,5);
 assert.match(byLabel(cands,'Spite → E').forecast.warnings.join(),/may hit twice/);
 assert.equal(byLabel(cands,'True Grit').forecast.block,7);
 const unknown=decisionCandidates(fight([card(0,'Mystery','1','Skill','Do something new.','Self')]));
 assert.deepEqual(byLabel(unknown,'Mystery').forecast.notModeled,['Mystery']);
});

test('an attack chosen before setup that forecasts more damage is reviewed once per turn',()=>{
 const s=fight([cruelty,big(1),big(2)]),cands=decisionCandidates(s);
 const attack=cands.find(c=>c.command.card_index===1);
 assert.match(orderReviewReason(s,cands,attack),/Cruelty first \(up to 70 .*line \(65\)/);
 assert.equal(orderReviewReason(s,cands,attack),null,'already reviewed this turn');
 const next={...s,battle:{...s.battle,round:3}};
 assert.ok(reviewReason(next,cands,attack,{resourceReviews:true}),'v3 reviews include card order');
 assert.equal(reviewReason({...s,battle:{...s.battle,round:4}},cands,attack),null,'v1 and v2 are unchanged');
 assert.equal(orderReviewReason({...s,battle:{...s.battle,round:5}},cands,cands.find(c=>c.command.card_index===0)),null,'setup first needs no review');
 const noGain=fight([cruelty,big(1)],{enemyStatus:[],round:6}),c2=decisionCandidates(noGain);
 assert.equal(orderReviewReason(noGain,c2,c2.find(c=>c.command.card_index===1)),null,'no review without a damage gain');
});

test('Thrash, Fiend Fire, Cinder, Evil Eye and Body Slam are forecast',()=>{
 const beckon=i=>card(i,'Beckon','1','Status','At the end of your turn, if this is in your Hand,  lose 6 HP.','None');
 const thrash=card(1,'Thrash','1','Attack','Deal 4 damage twice. Exhaust a random Attack in your Hand and add its damage to this card.');
 const breakthrough=card(2,'Breakthrough','1','Attack','Lose 1 HP. Deal 9 damage to ALL enemies.','AllEnemies');
 // Soul Fysh round 12: playing Thrash first burns the Strike; Strike first is lethal.
 const s=fight([beckon(0),thrash,breakthrough,beckon(3),strike(4)]);s.battle.enemies[0].hp=30;
 const cands=decisionCandidates(s);
 const lethal=byLabel(cands,'Strike → E → Breakthrough → Thrash → E');
 assert.equal(lethal.forecast.boundary,'combat_won');assert.equal(lethal.forecast.survives,true);
 assert.equal(byLabel(cands,'Thrash → E').forecast.damage,12);
 const ff=card(1,'Fiend Fire','2','Attack','Exhaust your Hand. Deal 7 damage for each card Exhausted. Exhaust.');
 const f2=byLabel(decisionCandidates(fight([beckon(0),ff,strike(2),strike(3)],{enemyStatus:[]})),'Fiend Fire → E').forecast;
 assert.equal(f2.damage,21);assert.equal(f2.endTurnCardHpLoss,0,'the Beckon was exhausted');
 const eye=card(2,'Evil Eye','1','Skill','Gain 8 Block. Gain another 8 Block if you have Exhausted a card this turn.','Self');
 const cinder=card(1,'Cinder','2','Attack','Deal 18 damage. Exhaust 1 card at random.');
 const c3=decisionCandidates(fight([beckon(0),cinder,eye],{enemyStatus:[]}));
 assert.equal(byLabel(c3,'Evil Eye').forecast.block,8);
 assert.equal(byLabel(c3,'Cinder → E').forecast.boundary,'random','two different cards could be exhausted');
 const slam=card(1,'Body Slam','1','Attack','Deal damage equal to your Block. (Deals 3 damage)');
 const s4=fight([card(0,'Defend','1','Skill','Gain 5 Block.','Self'),slam],{enemyStatus:[]});s4.player.block=3;
 assert.equal(byLabel(decisionCandidates(s4),'Defend → Body Slam → E').forecast.damage,8);
});

test('Shackling Potion lowers each forecast enemy hit',()=>{
 const s=fight([strike(0)],{enemyStatus:[]});
 s.battle.enemies[0].intents=[{type:'Attack',label:'9x2',description:'Attack for 9 damage 2 times.'}];
 s.player.potions=[{slot:0,name:'Shackling Potion',description:'ALL enemies lose 7 Strength this turn.',target_type:'AllEnemies',can_use_in_combat:true}];
 const c=decisionCandidates(s).find(x=>x.command.action==='use_potion');
 assert.ok(c,'potion is offered');assert.equal(c.forecast.incoming,4);
});
