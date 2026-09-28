import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newCardStats,recordDecision,cardSummary,baseCard} from './card-stats.mjs';

const d=(floor,type,{state={},...extra})=>({kind:'decision',outcome:'executed',...extra,state:{state_type:type,run:{live_id:'r1',act:1,floor},battle:{round:1},...state}});
test('picks, later plays per fight and run depth are summarized per card',()=>{
 const s=newCardStats();
 recordDecision(s,d(3,'card_reward',{candidates:[{label:'Uppercut'},{label:'Twin Strike'},{label:'Skip'}],chosen:{label:'Uppercut'}}));
 recordDecision(s,d(2,'monster',{state:{player:{hand:[{index:0,name:'Uppercut'}]}},chosen:{command:{action:'play_card',card_index:0}},time:'a'}));
 recordDecision(s,d(4,'monster',{state:{player:{hand:[{index:0,name:'Uppercut+'}]}},chosen:{command:{action:'play_card',card_index:0}},time:'b'}));
 recordDecision(s,d(5,'elite',{state:{player:{hand:[{index:1,name:'Strike'}]}},chosen:{command:{action:'play_card',card_index:1}},time:'c'}));
 assert.deepEqual(cardSummary(s,'Uppercut'),{offered:1,picked:1,seeds:1,plays_per_fight_after_pick:0.5,floor_reached_when_picked:5});
 assert.deepEqual(cardSummary(s,'Twin Strike'),{offered:1,picked:0});
 assert.equal(cardSummary(s,'Skip'),null);
 assert.equal(baseCard('Juggernaut — 152 gold'),'Juggernaut');
});

test('shop purchases count as picks, the pick floor is excluded, and replays of a seed count once',()=>{
 const s=newCardStats({r1:'JEV1',r2:'JEV1',r3:'JEV2'});
 const at=(run,floor,type,extra)=>{const e=d(floor,type,extra);e.state.run.live_id=run;return e;};
 for(const run of ['r1','r2']){
  recordDecision(s,at(run,6,'shop',{state:{shop:{items:[{index:2,category:'card',card_name:'Pillage'}]}},chosen:{label:'Pillage — 50 gold',command:{action:'shop_purchase',index:2}}}));
  recordDecision(s,at(run,6,'monster',{state:{player:{hand:[{index:0,name:'Pillage'}]}},chosen:{command:{action:'play_card',card_index:0}},time:'x'}));
  recordDecision(s,at(run,7,'monster',{state:{player:{hand:[{index:0,name:'Pillage'}]}},chosen:{command:{action:'play_card',card_index:0}},time:'y'}));
 }
 recordDecision(s,at('r3',30,'shop',{state:{shop:{items:[{index:2,category:'card',card_name:'Pillage'}]}},chosen:{label:'Pillage — 50 gold',command:{action:'shop_purchase',index:2}}}));
 recordDecision(s,at('r3',31,'monster',{state:{player:{hand:[]}},chosen:{command:{action:'end_turn'}}}));
 assert.deepEqual(cardSummary(s,'Pillage'),{offered:3,picked:3,seeds:2,plays_per_fight_after_pick:0.5,floor_reached_when_picked:19});
});
