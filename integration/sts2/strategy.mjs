// Event-triggered hierarchical control: Claude (the operator's Claude Code session)
// writes a persistent run strategy on a few deterministic triggers; Jev makes
// every ordinary decision with it.
import {summarizeHistory} from './efficient-decisions.mjs';
import {runeRules} from './runes.mjs';
import {nodeKey} from './route-facts.mjs';

export const STRATEGY_POLICY = 'claude-strategy-v2.1';
const combatScreens = new Set(['monster','elite','boss']);
// Run-shaping screens where an unsure Jev answer is worth a Claude consult.
export const IMPORTANT_SCREENS = new Set(['card_reward','shop','hextech_rune','rest_site']);

const text = {type:'string'};
const list = {type:'array',items:text};
export const PLAN_SCHEMA = {
 type:'object',additionalProperties:false,
 required:['archetype','summary','priorities','combat','card_reward','shop','route','route_path','elite_min_hp_percent','rest','replan_below_hp_percent','allowed_option_ids','option_note'],
 properties:{
  archetype:text, summary:text, priorities:list,
  combat:{type:'object',additionalProperties:false,required:['risk_tolerance','potion_policy','focus','hallway_potion_below_hp_percent','focus_enemy'],
   properties:{risk_tolerance:{type:'string',enum:['low','medium','high']},potion_policy:text,focus:text,
    hallway_potion_below_hp_percent:{type:'integer'},focus_enemy:text}},
  card_reward:{type:'object',additionalProperties:false,required:['desired','avoid','skip_when'],
   properties:{desired:list,avoid:list,skip_when:text}},
  shop:{type:'object',additionalProperties:false,required:['gold_reserve','priorities'],
   properties:{gold_reserve:{type:'integer'},priorities:list}},
  route:text, route_path:list, elite_min_hp_percent:{type:'integer'}, rest:text,
  replan_below_hp_percent:{type:'integer'},
  allowed_option_ids:list, option_note:text
 }
};

export const STRATEGIST_INSTRUCTIONS = `You are the strategist for an automated Slay the Spire 2 player (modded: Hextech Runes and other mods are active; their rules are in the state). A fast, cheap model (Jev) makes every individual decision; you are consulted only on specific triggers, so your plan must stay useful for many later decisions without you.

Write a compact, persistent run strategy grounded in the actual deck, relics, runes, HP, gold and act. Keep every string short and concrete. Priorities: at most 5, most important first. Do not invent hidden information (future card offers, unrevealed rooms, enemy moves not shown).

Fields:
- combat: risk tolerance, when potions should be spent, and what to focus (for a boss or elite trigger, a concrete plan for this fight from the visible enemies, intents and powers). Two combat rules are enforced by code and persist until you change them:
  - hallway_potion_below_hp_percent: in normal (non-elite, non-boss) fights, potions are removed from Jev's options while HP is at or above this percentage (100 = no limit, 0 = never in hallways). They stay available when every option without a potion is forecast to die.
  - focus_enemy: the name of a visible enemy whose death matters most (e.g. a leader whose minions leave when it dies), or "". While it and another enemy are alive, single-target plays aimed at other enemies are removed unless they kill that enemy. Area attacks and self-target cards are unaffected. Use only when you are sure.
  Code also removes plays forecast to be fatal when another play is forecast to survive.
- card_reward: the kinds of cards the deck needs, what to avoid, and when to skip.
- shop.gold_reserve: gold to keep unspent for a concrete later need; 0 if none. Purchases that would drop gold below it are removed from Jev's options, so be deliberate.
- route: map-route policy in words for the rest of the act (used when the planned path cannot be followed).
- route_path: when the brief includes routes, the node IDs ("col,row") of the path you choose, in order, copied from one listed route (you may stop before the boss). Jev's map options are limited to the next node on this path. Use [] to leave routing to Jev.
- elite_min_hp_percent: if HP is below this percentage when the next node on route_path is an elite, you are consulted again before entering it (0 = never).
- rest: rest-site policy (heal versus upgrade). The facts field gives exact heal and waste; route and gold counts are also exact.
- replan_below_hp_percent: HP percentage at which you want to be consulted again (10-60; 25 is typical).
- allowed_option_ids: only for a non-combat screen whose current_options you were shown. List the IDs Jev may choose from (one ID means that choice is taken directly; include every option you consider reasonable). Use [] in combat, when no options are shown, or to leave the choice fully to Jev.
- option_note: one sentence on the current screen, or "".`;

const pct = p => p?.max_hp ? Math.round(100*p.hp/p.max_hp) : null;
export const screenKey = s => `${s.run?.live_id}:${s.run?.act}:${s.run?.floor}:${s.state_type}`;
// Label is included: after a reroll or purchase an index can name a different option.
const optionKey = c => JSON.stringify({command:c.command,label:c.label});
const relicIds = s => (s.player?.relics ?? []).map(r => r.id).sort();

function deckSummary(deck=[]) {
 const byName=new Map();
 for(const c of deck){
  const key=`${c.name}|${c.cost}|${c.description}`;
  const row=byName.get(key)??{name:c.name,cost:c.cost,...(c.star_cost!=null?{star_cost:c.star_cost}:{}),...(c.type?{type:c.type}:{}),description:c.description,count:0};
  row.count++;byName.set(key,row);
 }
 return [...byName.values()];
}

// Compact, stable projection for the strategist. Current combat hands and piles
// are left to Jev; the strategist needs the run's shape.
export function strategistBrief(state,candidates,reason,previous,{routes=null,facts=null}={}) {
 const p=state.player??{};
 const brief={
  trigger:reason,
  run:{...state.run,character:p.character},
  player:{hp:p.hp,max_hp:p.max_hp,gold:p.gold,max_energy:p.max_energy,
   potions:(p.potions??[]).map(({name,description})=>({name,description})),max_potion_slots:p.max_potion_slots},
  deck:deckSummary(p.deck),
  relics:(p.relics??[]).map(({name,description,counter})=>({name,description,...(counter!=null?{counter}:{})})),
  active_rune_rules:runeRules(state).map(({name,description,owner,kind,tier,counter})=>({name,description,owner,kind,...(tier!=null?{tier}:{}),...(counter!=null?{counter}:{})})),
  history:summarizeHistory(state.saved_run)?.history_summary ?? null,
  screen:state.state_type,
 };
 if(state.battle)brief.enemies=state.battle.enemies.map(({name,hp,max_hp,block,status,intents})=>({name,hp,max_hp,block,
  status:(status??[]).map(({name,amount,description})=>({name,amount,description})),intents:(intents??[]).map(({title,label,description})=>({title,label,description}))}));
 if(routes)brief.routes=routes;
 if(facts)brief.facts=facts;
 if(!combatScreens.has(state.state_type))brief.current_options=candidates.map(c=>({id:c.id,label:c.label,
  ...(c.details?.description??c.details?.card_description?{description:c.details.description??c.details.card_description}:{})}));
 if(previous)brief.previous_plan=planFields(previous);
 return brief;
}

export function planFields(plan) {
 if(!plan)return null;
 const {archetype,summary,priorities,combat,card_reward,shop,route,route_path,elite_min_hp_percent,rest,replan_below_hp_percent}=plan;
 return {archetype,summary,priorities,combat,card_reward,shop,route,route_path,elite_min_hp_percent,rest,replan_below_hp_percent};
}

// Deterministic triggers evaluated before Jev. Returns a reason or null.
const routeOptions=(candidates,plan)=>candidates.filter(c=>c.command?.action==='choose_map_node'&&c.details?.col!=null&&plan.route_path.includes(nodeKey(c.details)));

export function replanReason(state,plan,candidates=[]) {
 const run=state.run;
 if(!run?.live_id)return null;
 if(!plan||plan.run_id!==run.live_id)return 'run_start';
 if(plan.act!==run.act)return 'new_act';
 if(['boss','elite'].includes(state.state_type)&&state.battle?.round===1&&plan.encounter!==screenKey(state))
  return `${state.state_type}_start`;
 const threshold=Math.min(60,Math.max(10,plan.replan_below_hp_percent||25)),hp=pct(state.player);
 if(hp!=null&&hp<threshold&&(plan.hp_percent??100)>=threshold)return 'low_hp';
 if(state.state_type==='shop'&&(state.player?.gold??0)>=150&&plan.screen!==screenKey(state))return 'rich_shop';
 if(state.state_type==='map'&&state.map?.nodes?.length&&plan.screen!==screenKey(state)){
  // The first map screen of an act is where the whole route is visible.
  if(plan.route_act!==run.act)return 'route_plan';
  if(plan.route_path?.length){
   const next=routeOptions(candidates,plan);
   if(!next.length)return 'route_off';
   if(next.some(c=>c.details.type==='Elite')&&hp!=null&&hp<(plan.elite_min_hp_percent??0))return 'route_risk';
  }
 }
 // Relic/rune pickups change strategy; batch them rather than replanning per pickup.
 if(run.floor-plan.floor>=3&&relicIds(state).some(id=>!plan.relic_ids?.includes(id)))return 'new_relic';
 return null;
}

// Importance x uncertainty: only run-shaping screens, only once per screen.
export function escalationReason(state,answer,plan,threshold) {
 if(!IMPORTANT_SCREENS.has(state.state_type)||plan?.screen===screenKey(state))return null;
 if(typeof answer?.confidence!=='number'||answer.confidence>=threshold)return null;
 return 'jev_uncertain';
}

// Captured when the request is made, so a late answer only constrains its own screen.
export function requestStamp(state,candidates,reason,routeNodes=[]) {
 // route_act marks that the strategist saw this act's routes.
 return {route_nodes:routeNodes,route_act:routeNodes.length?state.run.act:null,run_id:state.run.live_id,act:state.run.act,floor:state.run.floor,reason,
  hp_percent:pct(state.player),relic_ids:relicIds(state),screen:screenKey(state),
  encounter:combatScreens.has(state.state_type)?screenKey(state):null,
  option_keys:combatScreens.has(state.state_type)?{}:Object.fromEntries(candidates.map(c=>[c.id,optionKey(c)]))};
}

export function stampPlan(plan,stamp,meta={}) {
 const {option_keys,route_nodes,...fields}=stamp;
 const allowed=plan.allowed_option_ids.filter(id=>option_keys[id]);
 return {...plan,...fields,allowed_options:allowed.map(id=>option_keys[id]),
  recommended_options:allowed.map(id=>JSON.parse(option_keys[id]).label),
  createdAt:new Date().toISOString(),...meta};
}

// Minimal validator for PLAN_SCHEMA's subset of JSON Schema.
export function validatePlan(value,schema=PLAN_SCHEMA,path='plan') {
 const errors=[];
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))return [path+' must be an object'];
  for(const key of schema.required)if(!Object.hasOwn(value,key))errors.push(path+'.'+key+' is required');
  for(const key of Object.keys(value)){
   if(!schema.properties[key])errors.push(path+'.'+key+' is not allowed');
   else errors.push(...validatePlan(value[key],schema.properties[key],path+'.'+key));
  }
 } else if(schema.type==='array'){
  if(!Array.isArray(value))return [path+' must be an array'];
  value.forEach((v,n)=>errors.push(...validatePlan(v,schema.items,path+'['+n+']')));
 } else if(schema.type==='integer'){ if(!Number.isSafeInteger(value))errors.push(path+' must be an integer'); }
 else if(typeof value!=='string')errors.push(path+' must be a string');
 else if(schema.enum&&!schema.enum.includes(value))errors.push(path+' must be one of '+schema.enum.join(', '));
 if(path==='plan'&&!errors.length){
  if(value.priorities.length>5)errors.push('plan.priorities allows at most 5 entries');
  if(value.replan_below_hp_percent<10||value.replan_below_hp_percent>60)errors.push('plan.replan_below_hp_percent must be 10-60');
  if(value.shop.gold_reserve<0)errors.push('plan.shop.gold_reserve must be >= 0');
  if(value.elite_min_hp_percent<0||value.elite_min_hp_percent>100)errors.push('plan.elite_min_hp_percent must be 0-100');
  const potionFloor=value.combat.hallway_potion_below_hp_percent;
  if(potionFloor<0||potionFloor>100)errors.push('plan.combat.hallway_potion_below_hp_percent must be 0-100');
  for(const n of value.route_path)if(!/^\d+,\d+$/.test(n))errors.push(`plan.route_path entry ${n} must be "col,row"`);
 }
 return errors;
}

const alive=state=>(state.battle?.enemies??[]).filter(e=>e.hp>0);
const usesPotion=c=>c.command.action==='use_potion'||(c.plan??[]).some(s=>s.command?.action==='use_potion');
// A plan forecast to be fatal, when another plan is forecast to survive. Partial forecasts
// count: they omit some effects but still use the visible intents and known block.
const fatal=c=>c.forecast?.survives===false;
const survives=c=>c.forecast?.survives===true;

// Combat rules, applied in order; each keeps at least one option and records what it removed.
export function combatConstraints(state,candidates,plan) {
 if(!combatScreens.has(state.state_type))return {candidates,rules:[]};
 let kept=candidates;const rules=[];
 const apply=(kind,next,extra={})=>{if(next.length&&next.length<kept.length){rules.push({kind,removed:kept.length-next.length,...extra});kept=next;}};
 if(kept.some(survives))apply('avoid_fatal',kept.filter(c=>!fatal(c)));
 const floor=plan?.combat?.hallway_potion_below_hp_percent;
 const hp=pct(state.player);
 if(state.state_type==='monster'&&Number.isInteger(floor)&&floor<100&&hp!=null&&hp>=floor){
  const next=kept.filter(c=>!usesPotion(c));
  // Keep potions when every remaining option without one is forecast to die.
  if(next.some(c=>c.forecast?.survives!==false))apply('hallway_potion',next,{hp_percent:hp,floor});
 }
 const name=plan?.combat?.focus_enemy?.trim().toLowerCase();
 const enemies=alive(state),focus=name&&enemies.find(e=>e.name?.toLowerCase().includes(name));
 if(focus&&enemies.length>1){
  apply('focus_enemy',kept.filter(c=>{
   const target=c.command.target;
   if(!target||target===focus.entity_id||!['play_card','use_potion'].includes(c.command.action))return true;
   return (c.forecast?.defeatedEnemies??[]).some(d=>d.id===target);
  }),{enemy:focus.name});
 }
 return {candidates:kept,rules};
}

// Constrained mode: code enforces the parts of the plan that are checkable.
export function constrainCandidates(state,candidates,plan,mode='constrained') {
 if(!plan||mode!=='constrained'||plan.run_id!==state.run?.live_id)return {candidates,constraint:null};
 if(combatScreens.has(state.state_type)){
  const {candidates:kept,rules}=combatConstraints(state,candidates,plan);
  return {candidates:kept,constraint:rules.length?{kind:'combat',rules,removed:candidates.length-kept.length}:null};
 }
 if(plan.screen===screenKey(state)&&plan.allowed_options?.length){
  const kept=candidates.filter(c=>plan.allowed_options.includes(optionKey(c)));
  if(kept.length)return {candidates:kept,constraint:{kind:'allowed_options',removed:candidates.length-kept.length}};
 }
 if(state.state_type==='map'&&plan.route_path?.length&&plan.route_act===state.run.act){
  const kept=routeOptions(candidates,plan);
  if(kept.length)return {candidates:kept,constraint:{kind:'route',removed:candidates.length-kept.length}};
 }
 if(state.state_type==='shop'&&plan.shop?.gold_reserve>0){
  const gold=state.player?.gold??0,items=state.shop?.items??[];
  const kept=candidates.filter(c=>{
   if(c.command.action!=='shop_purchase')return true;
   const price=items.find(i=>i.index===c.command.index)?.price;
   return typeof price!=='number'||gold-price>=plan.shop.gold_reserve;
  });
  if(kept.length&&kept.length<candidates.length)return {candidates:kept,constraint:{kind:'gold_reserve',reserve:plan.shop.gold_reserve,removed:candidates.length-kept.length}};
 }
 return {candidates,constraint:null};
}

// What Jev sees: stable fields, not the strategist's reasoning.
export function strategyContext(plan,state) {
 if(!plan||plan.run_id!==state.run?.live_id)return null;
 const context={source:'Claude run strategy, written at act '+plan.act+' floor '+plan.floor+' ('+plan.reason+')',...planFields(plan)};
 if(plan.screen===screenKey(state)){
  if(plan.option_note)context.current_screen_note=plan.option_note;
  if(plan.recommended_options?.length)context.recommended_options=plan.recommended_options;
 }
 return context;
}
