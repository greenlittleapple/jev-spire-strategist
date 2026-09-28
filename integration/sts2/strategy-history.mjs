// Compact history of adopted Claude strategy answers for the dashboard.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';

export const HISTORY_LIMIT = 50;

// One adopted plan -> the fields a person scans: what triggered it, what was chosen, what Jev was told.
export function compactStrategy(event) {
 const p=event.plan??{};
 const screen=String(p.screen??'').split(':').pop()||null;
 return {
  time:event.time??p.answeredAt??null, request_id:event.request_id??p.request_id??null, reason:event.reason??p.reason??null,
  run_id:p.run_id??null, act:p.act??null, floor:p.floor??null, screen, hp_percent:p.hp_percent??null,
  summary:p.summary??'', archetype:p.archetype??'', option_note:p.option_note??'',
  chosen:p.recommended_options??[], encounter:p.encounter_key??null,
  fight:p.fight?.plan?{plan:p.fight.plan,target_priority:p.fight.target_priority??[]}:null,
  combat:p.combat??null, priorities:p.priorities??[], card_reward:p.card_reward??null, shop:p.shop??null,
  route:p.route??'', route_path:p.route_path??[], rest:p.rest??'',
 };
}

export function addToHistory(history,event) {
 if(event?.kind!=='strategy_adopted')return history;
 history.unshift(compactStrategy(event));
 history.length=Math.min(history.length,HISTORY_LIMIT);
 return history;
}

// Rebuilds the most recent entries from a run log (newest first).
export async function loadHistory(logFile,limit=HISTORY_LIMIT) {
 const found=[];
 try{
  for await(const line of createInterface({input:createReadStream(logFile)})){
   if(!line.includes('"kind":"strategy_adopted"'))continue;
   try{found.push(compactStrategy(JSON.parse(line)));}catch{}
   if(found.length>limit*4)found.splice(0,found.length-limit);
  }
 }catch{return [];}
 return found.slice(-limit).reverse();
}
