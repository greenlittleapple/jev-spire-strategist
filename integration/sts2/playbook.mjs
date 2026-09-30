// Per-encounter fight plans written by the strategist and reused whenever the same
// encounter recurs, in this run or later ones. Keyed by the enemy names seen when the
// fight starts (summons later in the fight do not change the key).
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';

const combatScreens=new Set(['monster','elite','boss']);
const baseName=name=>String(name??'').replace(/\s*\(.*\)\s*$/,'').trim();
// Base names with counts, so a two-bug and a three-bug fight are different encounters: "Bowlbug x3".
export const encounterKey=enemies=>{
 const counts=new Map();
 for(const name of (enemies??[]).map(e=>baseName(e.name)).filter(Boolean))counts.set(name,(counts.get(name)??0)+1);
 return [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([n,c])=>c>1?`${n} x${c}`:n).join(' + ');
};
// The key used before counts were added; its plans stay available as a similar encounter.
export const legacyKey=key=>String(key??'').replace(/ x\d+/g,'');
export const fightId=s=>`${s.run?.live_id}:${s.run?.act}:${s.run?.floor}`;
// Only a consult at the start of a fight writes the encounter's saved plan. A fight plan from a
// consult during the fight (low_hp, unknown_mechanic, death_countdown) answered that turn's HP and
// hand, so it applies to the rest of that fight only (19 of 83 saved plans had been replaced that way).
export const FIGHT_START_REASONS=new Set(['new_encounter','review_encounter','elite_start','boss_start']);
// play_first names cards from the deck of the run that wrote it, so a saved plan from another run
// keeps its plan text and target_priority but not play_first.
export function planForRun(entry,runId){
 if(!entry?.play_first||(entry.run!=null&&entry.run===runId))return entry??null;
 const {play_first,...rest}=entry;return rest;
}
// The fight plan in force: one given during this fight (status.fightPlan, keyed by fight id), else
// the saved encounter plan as it applies to this run.
export function activeFightPlan(state,status,saved){
 const own=status?.fightPlan;
 if(own&&own.fight_id===fightId(state))return own;
 return planForRun(saved,state.run?.live_id);
}

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
 // Re-read when the file changes, so edits made while the runner is up are not overwritten.
 let cache=null,mtime=null;
 const load=async()=>{
  const now=await stat(path).then(s=>s.mtimeMs,()=>null);
  if(cache&&now===mtime)return cache;
  mtime=now;
  try{cache=JSON.parse(await readFile(path,'utf8'));}catch{cache={entries:{}};}
  cache.entries??={};
  return cache;
 };
 return {
  path,
  async get(key){return key?(await load()).entries[key]??null:null;},
  // A plan for the same enemies without counts (older entries), when this exact encounter has none.
  async similar(key){
   if(!key)return null;const book=await load(),legacy=legacyKey(key);
   return legacy!==key?book.entries[legacy]??null:null;
  },
  async set(key,fight,meta={}){
   if(!key||!fight?.plan)return;
   const book=await load();
   book.entries[key]={plan:fight.plan,target_priority:fight.target_priority??[],...(fight.play_first?.length?{play_first:fight.play_first}:{}),updatedAt:new Date().toISOString(),...meta};
   await mkdir(dir,{recursive:true});
   await writeFile(path+'.tmp',JSON.stringify(book,null,1));
   await rename(path+'.tmp',path);
   mtime=await stat(path).then(s=>s.mtimeMs,()=>null);
  },
  async all(){return (await load()).entries;},
 };
}
