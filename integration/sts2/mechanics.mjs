// Mechanics the forecast does not model, explained once by the strategist and kept across runs
// (.private/sts2/strategy/mechanics.json). Explanations are shown to Jev whenever the item is present.
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';

// Names the forecasts flag as unmodeled ("Unmodeled enemy power: Ravenous") or could not play.
export function unmodeledNames(candidates) {
 const names=new Map();
 for(const c of candidates??[]){
  for(const w of c.forecast?.warnings??[]){
   const m=String(w).match(/^Unmodeled (enemy power|player power|relic): (.+)$/);
   if(m)names.set(m[2].trim(),m[1]);
  }
  for(const n of c.forecast?.notModeled??[])if(n)names.set(String(n).replace(/\+$/,''),'card');
 }
 return names;
}

// The visible text of a named power, relic or card in this state.
export function mechanicText(state,name) {
 const same=x=>String(x?.name??'').replace(/\+$/,'').toLowerCase()===name.toLowerCase();
 const all=[...(state.player?.status??[]),...(state.player?.relics??[]),...(state.player?.hand??[]),
  ...(state.battle?.enemies??[]).flatMap(e=>(e.status??[]).map(p=>({...p,owner:e.name})))];
 const hit=all.find(same);
 return hit?(hit.owner?hit.owner+': ':'')+(hit.description??''):'';
}

// Names present in a state (powers, relics, hand cards), for showing saved explanations.
export function presentNames(state) {
 return new Set([...(state.player?.status??[]),...(state.player?.relics??[]),...(state.player?.hand??[]),
  ...(state.battle?.enemies??[]).flatMap(e=>e.status??[])].map(x=>String(x?.name??'').replace(/\+$/,'')).filter(Boolean));
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
  async set(name,note,meta={}){
   if(!name||!note)return;
   const book=await load();
   book.entries[name]={note,updatedAt:new Date().toISOString(),...meta};
   await mkdir(dir,{recursive:true});
   await writeFile(path+'.tmp',JSON.stringify(book,null,1));
   await rename(path+'.tmp',path);
   mtime=await stat(path).then(s=>s.mtimeMs,()=>null);
  },
 };
}
