// Skipping a card screen does not necessarily remove its parent reward in STS2MCP.
// Track each skipped card reward by slot through later claims (a claim re-indexes the list below it),
// and match its descriptor too, so a changed or different reward in that slot stays available.
export function rewardState(state,events) {
 if(state.state_type!=='rewards')return state;
 const same=e=>e.state?.run?.act===state.run?.act&&e.state?.run?.floor===state.run?.floor;
 const executed=events.filter(e=>e.outcome==='executed'&&same(e)).reverse(); // events are newest first
 const key=x=>JSON.stringify({...x,index:undefined});
 let skipped=[];
 executed.forEach((e,i)=>{
  const a=e.chosen?.command;if(a?.action!=='claim_reward')return;
  const item=e.state?.rewards?.items?.find(x=>x.index===a.index),next=executed[i+1]?.chosen?.command?.action;
  if(item?.type==='card'&&next==='skip_card_reward'){if(!skipped.some(s=>s.index===a.index))skipped.push({index:a.index,key:key(item)});return;}
  // A claim removes its item unless it opened a card screen that was then skipped.
  if(item&&(item.type!=='card'||next==='select_card_reward'))skipped=skipped.filter(s=>s.index!==a.index).map(s=>s.index>a.index?{...s,index:s.index-1}:s);
 });
 return {...state,rewards:{...state.rewards,items:(state.rewards?.items??[]).filter(x=>!skipped.some(s=>s.index===x.index&&s.key===key(x)))}};
}

// Gold still unclaimed on the rewards screen a card reward was opened from. The card reward screen's
// state has no rewards list, so the brief's gold left it out (160 shown with 62 more unclaimed). Taken
// from the last executed claim on this floor that opened the card screen, without the item it claimed.
// events: the runner's decision records, newest first. Null when no such claim is found.
export function unclaimedGold(state,events) {
 const gold=items=>(items??[]).filter(i=>i?.type==='gold').reduce((n,i)=>n+(Number.isFinite(i.gold_amount)?i.gold_amount:Number(String(i.description??'').match(/(\d+)\s*Gold/i)?.[1]??0)),0);
 if(state.state_type==='rewards')return gold(state.rewards?.items);
 if(state.state_type!=='card_reward')return null;
 for(const e of events??[]){
  if(e.outcome!=='executed'||e.state?.run?.live_id!==state.run?.live_id||e.state?.run?.act!==state.run?.act||e.state?.run?.floor!==state.run?.floor)continue;
  if(e.state.state_type==='card_reward')continue;
  const claim=e.chosen?.command;
  if(e.state.state_type!=='rewards'||claim?.action!=='claim_reward')return null;
  return gold(e.state.rewards?.items?.filter(i=>i.index!==claim.index));
 }
 return null;
}
