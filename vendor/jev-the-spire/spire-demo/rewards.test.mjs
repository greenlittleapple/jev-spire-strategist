import {test} from 'node:test';import assert from 'node:assert/strict';
import {rewardState} from './rewards.mjs';import {actionsFor} from './actions.mjs';
const s={state_type:'rewards',run:{act:1,floor:14},rewards:{can_proceed:true,items:[{index:0,type:'card',description:'Add a card to your deck.'}]}};
const e=(action,state=s,args={})=>({outcome:'executed',state,chosen:{command:{action,...args}}});
test('successful skip leaves the reward behind and permits proceeding instead of reopening it',()=>{
 const history=[e('skip_card_reward',{...s,state_type:'card_reward'}),e('claim_reward',s,{index:0})];
 assert.deepEqual(actionsFor(rewardState(s,history)).map(x=>x.command.action),['proceed']);assert.equal(s.rewards.items.length,1);
});
test('preview, another floor, and changed reward never suppress an available reward',()=>{
 const claim=e('claim_reward',s,{index:0}),skip=e('skip_card_reward');
 for(const history of [[{...skip,outcome:'preview'},claim],[{...skip,state:{...s,run:{act:1,floor:13}}},claim]])assert.equal(rewardState(s,history).rewards.items.length,1);
 const changed={...s,rewards:{...s.rewards,items:[{index:0,type:'card',description:'Different reward'}]}};
 assert.equal(rewardState(changed,[skip,claim]).rewards.items.length,1);
});
test('other reward types remain collectable after skipping cards',()=>{
 const withGold={...s,rewards:{...s.rewards,items:[...s.rewards.items,{index:1,type:'gold'}]}};
 assert.deepEqual(rewardState(withGold,[e('skip_card_reward'),e('claim_reward',s,{index:0})]).rewards.items,[{index:1,type:'gold'}]);
});
test('a skipped card stays skipped after later claims re-index the list',()=>{
 const card={type:'card',description:'Add a card to your deck.'};
 const at=(items)=>({...s,rewards:{can_proceed:true,items:items.map((x,index)=>({...x,index}))}});
 const s0=at([{type:'gold'},{type:'potion'},card,card]);
 const s1=at([{type:'gold'},{type:'potion'},card]); // first card taken
 const s2=at([{type:'potion'},card]); // gold claimed
 const history=[e('claim_reward',s1,{index:0}),e('skip_card_reward'),e('claim_reward',s1,{index:2}),e('select_card_reward'),e('claim_reward',s0,{index:2})];
 assert.deepEqual(rewardState(s2,history).rewards.items.map(x=>x.type),['potion']);
 const s3=at([card]);
 assert.deepEqual(rewardState(s3,[e('claim_reward',s2,{index:0}),...history]).rewards.items,[]);
});
test('with two identical card rewards, skipping the second leaves the first offered',()=>{
 const card={type:'card',description:'Add a card to your deck.'};
 const two={...s,rewards:{can_proceed:true,items:[{...card,index:0},{...card,index:1}]}};
 assert.deepEqual(rewardState(two,[e('skip_card_reward'),e('claim_reward',two,{index:1})]).rewards.items.map(x=>x.index),[0]);
});
