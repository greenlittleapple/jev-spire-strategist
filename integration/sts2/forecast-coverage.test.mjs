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
