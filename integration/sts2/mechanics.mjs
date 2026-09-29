// Mechanics the forecast does not model, explained once by the strategist and kept across runs
// (.private/sts2/strategy/mechanics.json). Explanations are shown to Jev whenever the item is present.
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {supportedCards,supportedPotions} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';

// Entries are keyed by kind and name ("enemy power: Thorns"), so an enemy's Thorns and your own
// Thorns (from Bronze Scales) keep separate notes. Kind "any" matches the name in every kind.
export const mechanicKey=(kind,name)=>`${kind}: ${name}`;

// Names the forecasts flag as unmodeled ("Unmodeled enemy power: Ravenous") or could not play.
export function unmodeledNames(candidates) {
 const names=new Map();
 for(const c of candidates??[]){
  for(const w of c.forecast?.warnings??[]){
   const m=String(w).match(/^Unmodeled (enemy power|player power|relic): (.+)$/);
   if(m)names.set(m[2].trim(),m[1]);
  }
  // notModeled names the card a line stopped on; a supported card there stopped for another reason
  // (an enemy power already flagged above), so only unsupported cards count.
  for(const n of c.forecast?.notModeled??[]){const name=String(n??'').replace(/\+$/,'');if(name&&!supportedCards.has(name.toLowerCase())&&!supportedPotions.has(name.toLowerCase()))names.set(name,'card');}
 }
 return names;
}

// The visible text of a named power, relic or card in this state.
export function mechanicText(state,name) {
 const same=x=>String(x?.name??'').replace(/\+$/,'').toLowerCase()===name.toLowerCase();
 const all=[...(state.player?.status??[]),...(state.player?.relics??[]),...(state.player?.hand??[]),...(state.player?.potions??[]),
  ...(state.battle?.enemies??[]).flatMap(e=>(e.status??[]).map(p=>({...p,owner:e.name})))];
 const hit=all.find(same);
 return hit?(hit.owner?hit.owner+': ':'')+(hit.description??''):'';
}

// Keys of the mechanics present in a state (powers, relics, hand cards, potions), for showing saved explanations.
export function presentNames(state) {
 const clean=x=>String(x?.name??'').replace(/\+$/,'');
 const groups=[['player power',state.player?.status],['relic',state.player?.relics],['card',state.player?.hand],['card',state.player?.potions],
  ['enemy power',(state.battle?.enemies??[]).flatMap(e=>e.status??[])]];
 const keys=new Set();
 for(const [kind,list] of groups)for(const x of list??[]){const n=clean(x);if(n){keys.add(mechanicKey(kind,n));keys.add(mechanicKey('any',n));}}
 return keys;
}

export function fileMechanics(dir) {
 const path=join(dir,'mechanics.json');
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
  async all(){return (await load()).entries;},
  async set(name,note,meta={},kind='any'){
   if(!name||!note)return;
   const book=await load();
   book.entries[mechanicKey(kind,name)]={name,kind,note,updatedAt:new Date().toISOString(),...meta};
   await mkdir(dir,{recursive:true});
   await writeFile(path+'.tmp',JSON.stringify(book,null,1));
   await rename(path+'.tmp',path);
   mtime=await stat(path).then(s=>s.mtimeMs,()=>null);
  },
 };
}
