// Per-encounter fight plans written by the strategist and reused whenever the same
// encounter recurs, in this run or later ones. Keyed by the enemy names seen when the
// fight starts (summons later in the fight do not change the key).
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';

const combatScreens=new Set(['monster','elite','boss']);
const baseName=name=>String(name??'').replace(/\s*\(.*\)\s*$/,'').trim();
export const encounterKey=enemies=>[...new Set((enemies??[]).map(e=>baseName(e.name)).filter(Boolean))].sort().join(' + ');
export const fightId=s=>`${s.run?.live_id}:${s.run?.act}:${s.run?.floor}`;

// The encounter key of the current fight, fixed at the first combat observation.
export function currentEncounter(state,fights) {
 if(!combatScreens.has(state.state_type)||!state.battle)return null;
 const id=fightId(state);
 if(!fights[id]){
  fights[id]=encounterKey(state.battle.enemies);
  const ids=Object.keys(fights);
  if(ids.length>100)delete fights[ids[0]];
 }
 return fights[id];
}

export function filePlaybook(dir) {
 const path=join(dir,'playbook.json');
 let cache=null;
 const load=async()=>{
  if(cache)return cache;
  try{cache=JSON.parse(await readFile(path,'utf8'));}catch{cache={entries:{}};}
  cache.entries??={};
  return cache;
 };
 return {
  path,
  async get(key){return key?(await load()).entries[key]??null:null;},
  async set(key,fight,meta={}){
   if(!key||!fight?.plan)return;
   const book=await load();
   book.entries[key]={plan:fight.plan,target_priority:fight.target_priority??[],updatedAt:new Date().toISOString(),...meta};
   await mkdir(dir,{recursive:true});
   await writeFile(path+'.tmp',JSON.stringify(book,null,1));
   await rename(path+'.tmp',path);
  },
  async all(){return (await load()).entries;},
 };
}
