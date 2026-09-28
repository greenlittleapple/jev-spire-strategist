import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectSequence,decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {actionsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {includeHextechRules} from './runes.mjs';

const flying={id:'FLYING_KICK_RUNE',name:'Flying Kick',description:'After you deal damage, execute monsters below 18% (10 + 8% of your max HP) of their max HP and heal 10% of your max HP.'};
const grounded={id:'GROUNDED_RUNE',name:'Grounded',description:'At the end of your turn, double your Block.'};
function state(){return {state_type:'monster',run:{act:2,floor:21},
  player:{hp:50,max_hp:100,energy:3,block:0,status:[],relics:[],potions:[],deck:[],hand:[
    {index:0,name:'Strike',type:'Attack',cost:'1',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'},
    {index:1,name:'Defend',type:'Skill',cost:'1',description:'Gain 5 Block.',can_play:true,target_type:'Self'}]},
  battle:{turn:'player',is_play_phase:true,enemies:[{entity_id:'enemy',name:'Enemy',hp:23,max_hp:100,block:0,status:[],intents:[{type:'Attack',damage:12,label:'12',description:'Attack for 12 damage.'}]}]}};}

test('Flying Kick uses strict fractional threshold and heals on execution or normal kills',()=>{
  const s=state();s.player.relics=[flying];
  let f=projectSequence(s,['Strike → Enemy']);
  assert.equal(f.damage,23);assert.equal(f.incoming,0);assert.equal(f.hpAfter,60);
  assert.equal(f.runeEffects.events[0].executed,true);
  s.battle.enemies[0].hp=24;f=projectSequence(s,['Strike → Enemy']);
  assert.equal(f.damage,6);assert.equal(f.runeEffects.events.length,0);
  s.player.max_hp=86;s.battle.enemies[0].hp=22;f=projectSequence(s,['Strike → Enemy']);
  assert.equal(f.runeEffects.events[0].thresholdPercent,16.88);assert.equal(f.hpAfter,58);
  s.battle.enemies[0].hp=4;s.player.hp=84;f=projectSequence(s,['Strike → Enemy']);
  assert.equal(f.hpAfter,86);assert.equal(f.runeEffects.events[0].healed,2);
  s.player.max_hp=70;s.player.hp=50;s.battle.enemies[0].max_hp=250;s.battle.enemies[0].hp=45;
  f=projectSequence(s,['Strike → Enemy']);
  assert.equal(f.damage,6);assert.equal(f.runeEffects.events.length,0);
});
test('blocked hits cannot execute and retaliation/revival never claim certain rune survival',()=>{
  const s=state();s.player.relics=[flying];s.battle.enemies[0].hp=12;s.battle.enemies[0].block=9;
  assert.equal(projectSequence(s,['Strike → Enemy']).runeEffects.events.length,0);
  s.battle.enemies[0].block=0;s.player.hp=2;
  s.battle.enemies[0].status=[{name:'Thorns',amount:3,description:'Whenever this creature is attacked, deal 3 damage back to the attacker.'}];
  assert.equal(projectSequence(s,['Strike → Enemy']).survives,null);
  s.battle.enemies[0].status=[{name:'Revival',description:'This monster revives after being killed.'}];
  assert.equal(projectSequence(s,['Strike → Enemy']).hpAfter,null);
});
test('Grounded doubles current block and early Plating without applying Dexterity/Frail twice',()=>{
  const s=state();s.player.relics=[grounded];s.player.block=2;
  s.player.status=[{name:'Plating',amount:3},{name:'Dexterity',amount:4},{name:'Frail',amount:1}];
  const f=projectSequence(s,['Defend']);
  assert.equal(f.block,20);assert.equal(f.hpLoss,0);
  s.player.relics=[];assert.equal(projectSequence(s,['Defend']).block,10);
});
test('all unknown source-tagged rune, forge and global enemy effects keep every live action without invented forecasts',()=>{
  for(const kind of ['relic','power','enemy_hex']){
    const s=state();const effect={source_mod:'HextechRunes',id:'CUSTOM_NO_SUFFIX',name:'Custom effect',description:'After a card is played, change its cost.',counter:2,strength_tier:3};
    if(kind==='relic')s.player.relics=[effect];
    if(kind==='power')s.battle.enemies[0].status=[effect];
    if(kind==='enemy_hex')s.hextech={available:true,active_enemy_hexes:[effect]};
    const candidates=decisionCandidates(s);
    assert.deepEqual(candidates.map(c=>c.command),actionsFor(s).map(c=>c.command));
    assert.ok(candidates.every(c=>c.plan.length===1&&c.forecast.hpAfter===null&&c.forecast.quality==='unknown'));
    const projection=projectSequence(s,['Strike → Enemy']);
    assert.equal(projection.hpAfter,null);assert.equal(projection.incoming,null);assert.equal(projection.defeatedEnemies,null);
    const p=includeHextechRules({state:{state:s},questions:{move:{instructions:'Choose'}}});
    assert.equal(p.state.hextech_runes.runes[0].rule,effect.description);
    assert.equal(p.state.hextech_runes.runes[0].counter,2);
    assert.equal(p.state.hextech_runes.runes[0].strength_tier,3);
  }
});
test('duplicate rune instances and changed descriptions fall back instead of assuming the normal formula',()=>{
  const s=state();s.player.relics=[grounded,grounded];
  assert.ok(decisionCandidates(s).every(c=>c.forecast.quality==='unknown'));
  s.player.relics=[{...flying,description:'A different rule after a mod update.'}];
  assert.ok(decisionCandidates(s).every(c=>c.forecast.hpAfter===null));
});
