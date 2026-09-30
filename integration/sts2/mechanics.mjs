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
   // A power named after a potion the forecast models is that potion's own effect
   // (JEV22: "enemy power: Shackling Potion", the Strength it takes away this turn).
   if(m&&!(m[1]!=='relic'&&supportedPotions.has(m[2].trim().toLowerCase())))names.set(m[2].trim(),m[1]);
  }
  // notModeled names the card a line stopped on; a supported card there stopped for another reason
  // (an enemy power already flagged above), so only unsupported cards count.
  for(const n of c.forecast?.notModeled??[]){const name=String(n??'').replace(/\+$/,'');if(name&&!supportedCards.has(name.toLowerCase())&&!supportedPotions.has(name.toLowerCase()))names.set(name,'card');}
 }
 return names;
}

// The player's own cards (every pile) and potions, by lower-case name, with the card type.
const lc=x=>String(x?.name??'').replace(/\+$/,'').toLowerCase();
function ownItems(state) {
 const p=state?.player??{},cards=new Map();
 for(const c of [...(p.deck??[]),...(p.hand??[]),...(p.draw_pile??[]),...(p.discard_pile??[]),...(p.exhaust_pile??[])])if(lc(c))cards.set(lc(c),c.type??null);
 return {cards,potions:new Set((p.potions??[]).map(lc).filter(Boolean))};
}

// Mechanics to ask the strategist about in this fight, as [name, kind]: unmodeled, without a saved
// note, and not the effect of the player's own card or potion. A power named after one of your cards
// or potions is that item's effect (JEV21: "player power: The Bomb" after the card had been explained;
// JEV22: "enemy power: Shackling Potion"). It counts as known when the item is modeled or explained;
// otherwise the item itself is asked about, as a card, so one note covers both. An enemy power named
// after a Power card in your deck is not treated as yours (enemies can have Barricade too).
// One entry per name.
export function unknownMechanics(state,candidates,known={}) {
 const {cards,potions}=ownItems(state);
 const noted=(kind,n)=>Boolean(known[mechanicKey(kind,n)]||known[mechanicKey('any',n)]);
 const out=new Map();
 for(const [name,kind] of unmodeledNames(candidates)){
  const l=name.toLowerCase();
  const potion=potions.has(l)||supportedPotions.has(l);
  const card=cards.has(l)&&!(kind==='enemy power'&&cards.get(l)==='Power');
  if(kind.endsWith('power')&&(potion||card)){
   if((potion&&supportedPotions.has(l))||(card&&supportedCards.has(l))||noted('card',name))continue;
   if(!out.has(name))out.set(name,'card');
   continue;
  }
  if(!noted(kind,name)&&!out.has(name))out.set(name,kind);
 }
 return [...out];
}

// Names not yet asked about in this fight: each name is asked at most once per fight, and a
// mechanic that first appears later in the fight is still asked. asked holds "fight|name" entries.
export const mechanicsToAsk=(unknown,asked,fight)=>unknown.filter(([name])=>!asked.includes(`${fight}|${name}`));

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
