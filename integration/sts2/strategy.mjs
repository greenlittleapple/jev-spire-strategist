// Event-triggered hierarchical control: Claude (the operator's Claude Code session)
// writes a persistent run strategy on a few deterministic triggers; Jev makes
// every ordinary decision with it.
import {summarizeHistory} from './efficient-decisions.mjs';
import {runeRules} from './runes.mjs';
import {nodeKey,minElitesFrom,restHeal} from './route-facts.mjs';

export const STRATEGY_POLICY = 'claude-strategy-v3';
const combatScreens = new Set(['monster','elite','boss']);
// Run-shaping screens where an unsure Jev answer is worth a Claude consult.
export const IMPORTANT_SCREENS = new Set(['card_reward','shop','hextech_rune','rest_site']);
// Screens the strategist decides outright: Claude is consulted on every one of them.
export const OWNED_SCREENS = new Set(['card_reward','shop','fake_merchant','event','rest_site','treasure','hextech_rune','card_select','bundle_select','relic_select','crystal_sphere']);
// Rewards are owned only when a potion is offered and every slot is full: taking it means a swap.
// actionsFor(state, {potionSwaps:true}) then offers "discard slot N to make room for X" and, when
// nothing else is left to claim, leaving; after the discard the claim is offered normally.
const potionSwap = s => s.state_type==='rewards' && (s.player?.potions?.length??0) >= (s.player?.max_potion_slots??3)
 && (s.rewards?.items??[]).some(i=>i.type==='potion');
export const isOwnedScreen = s => (OWNED_SCREENS.has(s.state_type) && !(s.state_type==='card_select' && s.battle)) || potionSwap(s);

const text = {type:'string'};
const list = {type:'array',items:text};
export const PLAN_SCHEMA = {
 type:'object',additionalProperties:false,
 required:['archetype','summary','priorities','combat','card_reward','shop','route','route_path','elite_min_hp_percent','rest','replan_below_hp_percent','fight','allowed_option_ids','option_note'],
 properties:{
  archetype:text, summary:text, priorities:list,
  combat:{type:'object',additionalProperties:false,required:['risk_tolerance','potion_policy','focus','hallway_potion_below_hp_percent','potion_reserve'],
   properties:{risk_tolerance:{type:'string',enum:['low','medium','high']},potion_policy:text,focus:text,
    hallway_potion_below_hp_percent:{type:'integer'},potion_reserve:{type:'integer'}}},
  fight:{type:'object',additionalProperties:false,required:['plan','target_priority'],properties:{plan:text,target_priority:list,play_first:list}},
  // Optional: explanations for unmodeled mechanics (trigger unknown_mechanic), kept across runs.
  mechanics:{type:'array',items:{type:'object',additionalProperties:false,required:['name','note'],properties:{name:text,note:text}}},
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
- archetype: the deck's direction in one sentence (what it builds toward and how it wins), rewritten each answer as the deck changes. The dashboard shows it as the current plan, so a bare tag such as "strength block" is not enough.
- summary: the run plan in one or two sentences (what the deck still needs, which fights and rooms to take, how to reach the boss), rewritten each answer. Jev sees it with every decision, so it is not a log of screens: a note about the current screen goes in option_note.
- combat: run-level risk tolerance, potion policy and general focus for the deck (not a single fight; that goes in fight). potion_reserve is enforced: outside boss fights, potion plays that would leave fewer potions than this are removed unless every other option is forecast to die; set it (usually 1) when the boss is near and potions matter there, 0 otherwise. hallway_potion_below_hp_percent is enforced: in normal (non-elite, non-boss) fights, potions are removed from Jev's options while HP is at or above this percentage (100 = no limit, 0 = never in hallways). They stay available when every option without a potion is forecast to die.
  Code also takes a play forecast to win the fight when one exists, and removes: plays forecast to be fatal when another play is forecast to survive; healing potions that would heal more than the HP missing (heal_potion_waste); in normal fights below hallway_potion_below_hp_percent, potions that save no HP this turn, except healing potions and potions whose effect the forecast cannot see (idle_potion); ending the turn while an affordable Beckon-style card is in hand; plays that lose more HP than the best while every enemy is Intangible; pure block cards when ending the turn would lose no HP; resting that wastes half its heal when Smith is offered; and exhaust picks other than status, curse, exhaust-payoff or plain Strike/Defend cards when those exist. When a death countdown is at 3 or less, it forces an affordable card that names it (countdown_escape). fight.play_first and target_priority are enforced as described under fight. Your allowed_option_ids for a screen take precedence over the rest and exhaust rules.
- fight: when the trigger is a fight start (new_encounter, review_encounter, elite_start, boss_start), a plan for this encounter from the visible enemies, intents and powers: plan (targeting, what to avoid, when to block, potion use) and target_priority (enemy names or the selectors lowest_hp, biggest_attack, can_kill, most important first, or [] for none). It is saved for this encounter and reused whenever the same enemies appear again, in this run and later runs, so write it for the encounter, not for today's HP. brief.saved_fight_plan may come from another run and name cards this deck lacks; rewrite it for this deck. target_priority is enforced: while two or more enemies are alive, single-target plays aimed at anyone except the highest-priority enemy still alive are removed unless they kill their target; area attacks are unaffected. Use a priority only when you are sure. Each enemy may carry seen_pattern: the intents it showed round by round in recent fights; plan around the turns it repeats. encounter_results shows how this encounter went before (HP start→end, rounds, won; after_plan marks fights played with the saved plan). review_encounter means the saved plan did badly: write a better one. A power on an enemy that counts down to your death ("In N turns, you will be eaten and die") must be pushed back with the cards that name it; the combat rules force those at 3 or less (countdown_escape), and the fight plan should say to play them. A plan that tells Jev not to kill an enemy, or to hold back in any way, must say when to stop (for example "kill it once block covers the eruption damage"); check draw_cards for what next turn can hold. JEV11 told Jev not to kill the Waterfall Giant with no exit, stalled while Steam Eruption grew to 63, and missed a kill it would have survived. Trigger death_countdown asks once per fight when such a power appears: rewrite the fight plan around it. fight.play_first (optional, card names) is enforced and saved with the fight plan for this run only (a later run keeps the plan text and target_priority, not play_first): while a listed card is affordable in hand, other card plays and ending the turn are removed (potions stay). It yields when the best forced line loses at least max(10, 12% of max HP) more than the best surviving line (not under a death countdown), or when no forced line is forecast to survive and another is. Use it for cards that must be played (an escape from a death countdown). Trigger unknown_mechanic lists powers, relics or cards the forecast does not model (brief.unknown_mechanics with their text): answer mechanics with one entry per item, {name, note}, a one-line explanation of what it does and what to do about it; notes are saved and shown to Jev whenever the item is present. On triggers during a fight (low_hp, unknown_mechanic, death_countdown) a non-empty fight plan, play_first included, replaces the plan for the rest of this fight only and is not saved; brief.current_fight_plan shows one given earlier in this fight. Write one only to change this fight's play; otherwise use {"plan":"","target_priority":[]} and the current plan stays. brief.glossary and brief.keywords explain names and keywords the options mention; combat_state is your hand, energy, block and powers. Card options may carry past_runs from earlier logged runs (different seeds and policies): times offered and picked, plays per fight after picking, and the floor those runs reached; treat it as a rough signal.
- card_reward: the kinds of cards the deck needs, what to avoid, and when to skip. In Act 1 the deck needs damage for the boss: take the best offered card unless it hurts the deck (JEV12 and JEV14 skipped 3-4 of 7-8 Act 1 rewards and lost at the Act 1 boss).
- shop.gold_reserve: gold to keep unspent for a concrete later need; 0 if none. Purchases that would drop gold below it are removed from Jev's options, so be deliberate.
- route: map-route policy in words for the rest of the act (used when the planned path cannot be followed). Weigh unspent gold against reachable shops; gold left at the boss buys nothing (JEV11 reached it with 323). Elites give the relics a deck needs by Act 2 (JEV5, JEV6 and JEV9 took no Act 1 elite and all lost by the Act 2 boss): take one or two while HP allows. Act 1 bosses (Waterfall Giant aside) were beaten in 9 of 9 runs entered at 87% HP or more and 0 of 4 entered at 77% or less (JEV12, 14, 16, 18; JEV18 took an optional elite at 75% six floors out and entered at 65%): in all four the only rest site after the last elite was the one right before the boss. rests_before_boss_rest in the route facts leaves that rest out, so for an elite that is the next map option it counts the other rests after it (on a listed route, count the R rooms after the elite except the last): with 0, take an optional Act 1 elite only near full HP; with 1 or more, the elite is fine; runs with no Act 1 elite lost by the end of Act 2 (JEV5, 6, 9, 19).
- route_path: when the brief includes routes, the node IDs ("col,row") of the path you choose, in order, copied from one listed route (you may stop before the boss). Jev's map options are limited to the next node on this path. Use [] to leave routing to Jev.
- elite_min_hp_percent: if HP is below this percentage when the next node on route_path is an elite, or leads through more elites than another offered node must, you are consulted again (route_risk) (0 = never). JEV13 and JEV14 lost after routes that committed to an elite at 33-39% HP while an elite-free path was offered. To keep such a route, lower this value in the answer.
- rest: rest-site policy (heal versus upgrade). The facts field gives exact heal and waste; route and gold counts are also exact. Before a boss, rest unless most of the heal would be wasted (JEV11 upgraded at 66/80 and lost to the Waterfall Giant with it on 18 HP).
- replan_below_hp_percent: HP percentage at which you want to be consulted again (10-60; 25 is typical).
- allowed_option_ids: only for a non-combat screen whose current_options you were shown. On card rewards, shops, events, rest sites, treasure, runes and card selections outside combat you decide: list the option IDs in the order to take them; the first one still offered is taken directly each time (a shop list of purchases ending with leaving buys them in order, skipping any no longer offered). You are asked again if none of your IDs is offered. Use [] in combat or when no options are shown.
- option_note: one sentence on the current screen, or "".`;

const pct = p => p?.max_hp ? Math.round(100*p.hp/p.max_hp) : null;
export const screenKey = s => `${s.run?.live_id}:${s.run?.act}:${s.run?.floor}:${s.state_type}`;
// Label is included: after a reroll or purchase an index can name a different option.
// An event option's description is part of its identity: a repeated page ("Linger — Take 4 damage",
// then 12) is a new choice, not the one already answered (JEV12 lingered nine times, 69 to 25 HP).
const optionKey = c => JSON.stringify({command:c.command,label:c.label,
 ...(c.command?.action==='choose_event_option'&&c.details?.description?{description:c.details.description}:{})});
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
 // In combat the strategist also needs the player's side: energy, block, powers and hand.
 if(state.battle)brief.combat_state={round:state.battle.round,energy:p.energy,max_energy:p.max_energy,block:p.block??0,
  status:(p.status??[]).map(({name,amount,description})=>({name,amount,description})),
  hand:(p.hand??[]).map(({name,cost,type,description})=>({name,cost,type,description})),
  draw_pile:p.draw_pile_count??null,discard_pile:p.discard_pile_count??null,exhaust_pile:p.exhaust_pile_count??null,
  // A small draw pile's contents (sorted, order unknown) tell what next turn can hold (JEV11: when to kill the Waterfall Giant).
  ...(Array.isArray(p.draw_pile)&&p.draw_pile.length&&p.draw_pile.length<=10?{draw_cards:p.draw_pile.map(c=>c.name).sort()}:{})};
 if(state.battle)brief.enemies=state.battle.enemies.map(({name,hp,max_hp,block,status,intents})=>({name,hp,max_hp,block,
  status:(status??[]).map(({name,amount,description})=>({name,amount,description})),intents:(intents??[]).map(({title,label,description})=>({title,label,description}))}));
 if(routes)brief.routes=routes;
 if(facts)brief.facts=facts;
 // The event's own text often explains what its options really do.
 if(state.event)brief.event={name:state.event.event_name??null,...(state.event.body?{text:state.event.body}:{})};
 if(!combatScreens.has(state.state_type)){
  brief.current_options=candidates.map(c=>({id:c.id,label:c.label,...optionText(c)}));
  // Keyword definitions attached to offered cards and relics (Exhaust, Ethereal, Dazed...).
  const keywords=new Map();
  for(const c of candidates)for(const k of c.details?.keywords??[])if(k?.name&&k.description&&!keywords.has(k.name))keywords.set(k.name,k.description);
  if(keywords.size)brief.keywords=Object.fromEntries(keywords);
 }
 // A plan from another run (another seed) is not shown: cross-run knowledge comes from the playbook,
 // the mechanics registry and card stats, and an old plan's combat section was copied into new runs.
 if(previous&&previous.run_id===state.run?.live_id)brief.previous_plan=planFields(previous);
 return brief;
}

// Every description the bridge sends for an option: shop items carry card_, relic_ or
// potion_description; event options may name a relic with its own description. A reward
// "description" that only repeats the label is not a description.
function optionText(c) {
 const d=c.details??{};
 const own=[d.description,d.card_description,d.relic_description,d.potion_description].find(t=>t&&t.trim()!==String(c.label).trim());
 const extra=d.relic_description&&own!==d.relic_description&&d.relic_name?`${d.relic_name}: ${d.relic_description}`:null;
 const description=[own,extra].filter(Boolean).join(' ');
 return description?{description}:{};
}

export function planFields(plan) {
 if(!plan)return null;
 const {archetype,summary,priorities,combat,card_reward,shop,route,route_path,elite_min_hp_percent,rest,replan_below_hp_percent}=plan;
 return {archetype,summary,priorities,combat,card_reward,shop,route,route_path,elite_min_hp_percent,rest,replan_below_hp_percent};
}

// Deterministic triggers evaluated before Jev. Returns a reason or null.
const mapOptions=candidates=>candidates.filter(c=>c.command?.action==='choose_map_node'&&c.details?.col!=null);
const routeOptions=(candidates,plan)=>mapOptions(candidates).filter(c=>plan.route_path.includes(nodeKey(c.details)));
// The route's next node leads through more elites than another offered node must, so an elite
// can still be avoided here (JEV13 at 33% and JEV14 at 39% HP kept such routes and lost).
const commitsToElite=(map,candidates,next)=>{
 const min=minElitesFrom(map),count=list=>list.map(c=>min(nodeKey(c.details))).filter(Number.isFinite);
 const all=count(mapOptions(candidates)),mine=count(next);
 return all.length>0&&mine.length>0&&Math.min(...mine)>Math.min(...all);
};

// The first option in the plan's order that is still offered.
const orderedAllowed=(candidates,plan,list=plan.allowed_options)=>{
 for(const key of list??[]){const c=candidates.find(x=>optionKey(x)===key);if(c)return c;}
 return null;
};

// ownScreens: the strategist decides owned screens outright (default); off, it is only
// consulted there when Jev is unsure (escalationReason).
// screenChoices: {screenKey: ordered option keys} from earlier answers in this run.
export function replanReason(state,plan,candidates=[],{ownScreens=true,screenChoices={}}={}) {
 const run=state.run;
 if(!run?.live_id)return null;
 if(!plan||plan.run_id!==run.live_id)return 'run_start';
 if(plan.act!==run.act)return 'new_act';
 if(['boss','elite'].includes(state.state_type)&&state.battle?.round===1&&plan.encounter!==screenKey(state))
  return `${state.state_type}_start`;
 const threshold=Math.min(60,Math.max(10,plan.replan_below_hp_percent||25)),hp=pct(state.player);
 if(hp!=null&&hp<threshold&&(plan.hp_percent??100)>=threshold)return 'low_hp';
 // Owned screens: ask on arrival, and again when none of the chosen options is offered
 // (a new event page, or a shop list that is used up).
 // A screen with one option (such as a confirmation) needs no decision.
 if(ownScreens&&isOwnedScreen(state)&&candidates.length>1&&!orderedAllowed(candidates,plan,screenChoices[screenKey(state)]))return 'owned_screen';
 if(!ownScreens&&state.state_type==='shop'&&(state.player?.gold??0)>=150&&plan.screen!==screenKey(state))return 'rich_shop';
 if(state.state_type==='map'&&state.map?.nodes?.length&&plan.screen!==screenKey(state)){
  // The first map screen of an act is where the whole route is visible.
  if(plan.route_act!==run.act)return 'route_plan';
  if(plan.route_path?.length){
   const next=routeOptions(candidates,plan);
   if(!next.length)return 'route_off';
   if(hp!=null&&hp<(plan.elite_min_hp_percent??0)&&(next.some(c=>c.details.type==='Elite')||commitsToElite(state.map,candidates,next)))return 'route_risk';
  }
 }
 // Relic/rune pickups can change the plan: consult at the first screen outside combat after one.
 if(!combatScreens.has(state.state_type)&&relicIds(state).some(id=>!plan.relic_ids?.includes(id)))return 'new_relic';
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
  if(value.combat.potion_reserve<0||value.combat.potion_reserve>5)errors.push('plan.combat.potion_reserve must be 0-5');
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

// Block with nothing else, or with an effect that only works when attacked (Flame Barrier).
// Every sentence only adds block, a thorns-style reply to attacks this turn, or a refund of energy
// (a Sown enchantment). JEV16 played Sown Expect a Fight on Vantom's buff turn with attacks in hand.
const blockSentences=[/^Gain \d+ Block$/i,/^Gains? (?:\d+ )?additional Block for each [^.]+$/i,/^Gain another \d+ Block if [^.]+$/i,
 /^Whenever you are attacked this turn, [^.]+$/i,/^Gain (?:\[[^\]]*energy[^\]]*\])+$/i];
const pureBlock=card=>{const parts=String(card?.description??'').split(/\.(?:\s+|$)/).map(s=>s.trim()).filter(Boolean);
 return parts.length>0&&blockSentences[0].test(parts[0])&&parts.every(p=>blockSentences.some(r=>r.test(p)));};
// Block that carries over or is turned into damage keeps block useful with nothing incoming.
const usesBlock=state=>(state.player?.status??[]).some(p=>/juggernaut|barricade|blur/i.test(p.name))
 ||(state.player?.relics??[]).some(r=>r.id==='CALIPERS')
 ||(state.player?.hand??[]).some(c=>/equal to your Block|double your Block|Block is not removed/i.test(c.description??''));

// The IDs of the options a rule removed, for the decision record.
const removedIds=(before,after)=>before.filter(c=>!after.includes(c)).map(c=>c.id);

// Single-card exhaust choice: status and curse cards, cards that pay off when exhausted,
// then plain Strikes and Defends, before anything else.
export function exhaustConstraint(state,candidates) {
 const select=state.hand_select;
 if(state.state_type!=='hand_select'||!/^Choose a card to Exhaust/i.test(select?.prompt??''))return null;
 const card=c=>c.command.action==='combat_select_card'?(select.cards??[]).find(x=>x.index===c.command.card_index):null;
 const tiers=[
  x=>['Status','Curse'].includes(x.type)||/when (?:this card is )?exhausted/i.test(x.description??''),
  // Below 30% HP, keep Defends when a Strike can go instead.
  x=>x.name==='Strike'&&!x.is_upgraded&&(pct(state.player)??100)<30,
  x=>/^(Strike|Defend)$/.test(x.name)&&!x.is_upgraded];
 for(const tier of tiers){
  const kept=candidates.filter(c=>{const x=card(c);return x&&tier(x);});
  if(kept.length&&kept.length<candidates.length)return {candidates:kept,constraint:{kind:'exhaust_choice',removed:candidates.length-kept.length,removed_ids:removedIds(candidates,kept)}};
  if(kept.length)return null;
 }
 return null;
}

// Resting that wastes at least half its heal, when Smith is offered. The heal counts relic
// bonuses shown on the option ("+15 HP from Regal Pillow").
export function restConstraint(state,candidates) {
 if(state.state_type!=='rest_site')return null;
 const heal=candidates.find(c=>c.details?.id==='HEAL'),smith=candidates.some(c=>c.details?.id==='SMITH'&&c.details.is_enabled!==false);
 const amount=restHeal(heal?.details?.description),p=state.player??{};
 if(!heal||!smith||!Number.isFinite(amount)||!p.max_hp)return null;
 const wasted=amount-(p.max_hp-p.hp);
 if(wasted<amount/2)return null;
 return {candidates:candidates.filter(c=>c!==heal),constraint:{kind:'rest_waste',heal:amount,wasted,removed:1,removed_ids:[heal.id]}};
}

// Combat rules, applied in order; each keeps at least one option and records what it removed.
// Target selectors: a name matches enemies by name; lowest_hp, biggest_attack and can_kill
// pick one living enemy from live HP, block, intents and the forecast.
const intentDamage=e=>(e.intents??[]).reduce((n,i)=>{
 const m=String(i.label??'').trim().match(/^(\d+)(?:\s*[x×]\s*(\d+))?/i);
 return n+(m&&/attack|aggressive/i.test(`${i.title??''} ${i.type??''} ${i.description??''}`)?Number(m[1])*Number(m[2]??1):0);
},0);
const effectiveHp=e=>(e.hp??0)+(e.block??0);
export const TARGET_SELECTORS=['lowest_hp','biggest_attack','can_kill'];
export function resolveTarget(wanted,enemies,candidates=[]) {
 const pick=(list,score)=>list.length?list.reduce((a,b)=>score(b)>score(a)?b:a):null;
 if(wanted==='lowest_hp')return pick(enemies,e=>-effectiveHp(e));
 if(wanted==='biggest_attack'){const attackers=enemies.filter(e=>intentDamage(e)>0);return pick(attackers,e=>intentDamage(e)*1000-effectiveHp(e));}
 if(wanted==='can_kill'){
  const killable=new Set(candidates.flatMap(c=>(c.forecast?.defeatedEnemies??[]).map(d=>d.id)));
  return pick(enemies.filter(e=>killable.has(e.entity_id)),e=>intentDamage(e)*1000-effectiveHp(e));
 }
 const name=wanted.toLowerCase();
 return name?enemies.find(e=>e.name?.toLowerCase().includes(name))??null:null;
}

// The HP a potion line must save over the best known line without a potion to stay allowed
// under the hallway floor; null when no line without a potion has a known HP loss.
export function hallwayPotionSaving(state,withoutPotion){
 const known=withoutPotion.filter(c=>c.forecast?.quality!=='unknown'&&Number.isFinite(c.forecast?.hpLoss));
 if(!known.length)return null;
 return {best:Math.min(...known.map(c=>c.forecast.hpLoss)),need:Math.max(10,Math.ceil(0.12*(state.player?.max_hp??0)))};
}
const saves=(c,{best,need})=>c.forecast?.quality!=='unknown'&&c.forecast?.survives===true&&Number.isFinite(c.forecast?.hpLoss)&&best-c.forecast.hpLoss>=need;
// The lowest death countdown shown on a living enemy, as {name, amount}, or null.
export function deathCountdown(state){
 const found=alive(state).flatMap(e=>e.status??[]).filter(p=>/you will be (?:eaten|killed|destroyed)[^.]*die|you will die/i.test(p.description??'')&&Number.isFinite(Number(p.amount)));
 if(!found.length)return null;
 const p=found.reduce((a,b)=>Number(b.amount)<Number(a.amount)?b:a);
 return {name:p.name,amount:Number(p.amount)};
}
// Forcing lines is dropped when none of them is known to survive this turn while another kept line is
// (JEV9: a 3-cost Frantic Escape at 13 HP against 28 incoming, with 10-loss block lines available).
// A countdown at 1 kills this turn anyway, so the escape still applies then.
const knownSurvivor=c=>c.forecast?.quality!=='unknown'&&c.forecast?.survives===true;
const diesNow=(forced,kept,countdown)=>!(countdown&&countdown.amount<=1)&&!forced.some(knownSurvivor)&&kept.some(knownSurvivor);
// fight = the saved plan for the current encounter ({plan, target_priority}) or null.
export function combatConstraints(state,candidates,plan,fight=null) {
 if(!combatScreens.has(state.state_type))return {candidates,rules:[],lifted:[]};
 let kept=candidates;const rules=[],lifted=[];
 // A rule that steps aside, or would remove every option, is recorded in lifted with a reason,
 // when it would otherwise have removed something (JEV5's reserve and JEV9's forced escape
 // left no trace in the log). A lift changes nothing about the options.
 const lift=(kind,reason,next,extra={})=>{if(next.length<kept.length)lifted.push({kind,reason,would_remove:kept.length-next.length,...extra});};
 const apply=(kind,next,extra={})=>{
  if(!next.length){lift(kind,'no_option_left',next,extra);return;}
  if(next.length<kept.length){rules.push({kind,removed:kept.length-next.length,removed_ids:removedIds(kept,next),...extra});kept=next;}};
 if(kept.some(survives))apply('avoid_fatal',kept.filter(c=>!fatal(c)));
 // A healing potion drunk with less HP missing than it heals wastes the heal (Blood Potion at full
 // HP on round 1 of a boss). In every fight type, unless every line without it is forecast to die.
 const maxHp=state.player?.max_hp,missing=Number.isFinite(maxHp)?maxHp-(state.player?.hp??maxHp):null;
 const healOf=p=>{const d=p?.description??'';const pc=d.match(/Heal for (\d+)% of your Max HP/i),flat=d.match(/^Heal (\d+) HP/i);
  return pc&&maxHp?Math.floor(maxHp*Number(pc[1])/100):flat?Number(flat[1]):0;};
 const wastes=c=>(c.plan??[c]).some(s=>s.command?.action==='use_potion'&&healOf((state.player?.potions??[]).find(p=>p.slot===s.command.slot)??state.player?.potions?.[s.command.slot])>missing);
 if(missing!=null&&kept.some(wastes)){
  const next=kept.filter(c=>!wastes(c));
  if(next.some(c=>c.forecast?.survives!==false))apply('heal_potion_waste',next,{missing});
  else lift('heal_potion_waste','others_die',next,{missing});
 }
 const floor=plan?.combat?.hallway_potion_below_hp_percent;
 const hp=pct(state.player);
 if(state.state_type==='monster'&&Number.isInteger(floor)&&floor<100&&hp!=null&&hp>=floor){
  const withoutPotion=kept.filter(c=>!usesPotion(c));
  // Keep potions when every remaining option without one is forecast to die.
  if(withoutPotion.some(c=>c.forecast?.survives!==false)){
   // Also keep a potion line that is forecast to save a lot of HP this turn: known, surviving,
   // and at least max(10, 12% of max HP) less HP lost than the best line without a potion.
   // The saving only counts when the best line without a potion would leave HP under the floor
   // (JEV10 drank two potions at 80/80 to avoid a 15-damage hit).
   const saving=hallwayPotionSaving(state,withoutPotion);
   const dropsBelow=saving&&maxHp&&((state.player.hp-saving.best)/maxHp)*100<floor;
   const savers=dropsBelow?kept.filter(c=>usesPotion(c)&&saves(c,saving)):[];
   apply('hallway_potion',kept.filter(c=>!usesPotion(c)||savers.includes(c)),{hp_percent:hp,floor,...(savers.length?{potion_lines_kept:savers.length}:{})});
  } else lift('hallway_potion','others_die',withoutPotion,{hp_percent:hp,floor});
 }
 // Below the floor potions are allowed, but not one that saves no HP this turn (JEV10 threw an
 // Explosive Ampoule on a turn forecast to lose nothing). Healing potions are exempt.
 if(state.state_type==='monster'&&Number.isInteger(floor)&&floor<100&&hp!=null&&hp<floor){
  const withoutPotion=kept.filter(c=>!usesPotion(c));
  const saving=hallwayPotionSaving(state,withoutPotion);
  const heals=c=>(c.plan??[c]).some(s=>s.command?.action==='use_potion'&&healOf((state.player?.potions??[]).find(p=>p.slot===s.command.slot))>0);
  // A potion whose effect this turn's forecast cannot show (new cards, draws, later effects) is unknown, not idle.
  const unseen=c=>(c.forecast?.warnings??[]).some(w=>/adds or chooses unknown cards|unknown drawn cards|effect starts later/i.test(w));
  const idle=c=>usesPotion(c)&&!heals(c)&&!unseen(c)&&c.forecast?.quality!=='unknown'&&Number.isFinite(c.forecast?.hpLoss)&&c.forecast.hpLoss>=saving.best;
  if(saving&&withoutPotion.some(c=>c.forecast?.survives!==false))apply('idle_potion',kept.filter(c=>!idle(c)),{hp_percent:hp,floor});
  else if(saving)lift('idle_potion','others_die',kept.filter(c=>!idle(c)),{hp_percent:hp,floor});
 }
 // Potions kept for the boss: outside boss fights, plays that would leave fewer than the
 // reserve are removed, unless every option that keeps the reserve is forecast to die.
 // Below the plan's hallway potion threshold (when it is a real limit, under 100) HP matters more than the reserve, so it yields.
 const reserve=plan?.combat?.potion_reserve,held=state.player?.potions?.length??0;
 const lowHp=Number.isInteger(floor)&&floor<100&&hp!=null&&hp<floor;
 if(state.state_type!=='boss'&&Number.isInteger(reserve)&&reserve>0){
  const potionCount=c=>(c.plan??[c]).filter(p=>p.command?.action==='use_potion').length;
  const next=kept.filter(c=>held-potionCount(c)>=reserve||!usesPotion(c));
  if(lowHp)lift('potion_reserve','below_hallway_floor',next,{held,reserve,hp_percent:hp,floor});
  else if(next.some(c=>c.forecast?.survives!==false))apply('potion_reserve',next,{held,reserve});
  else lift('potion_reserve','others_die',next,{held,reserve});
 }
 // A fully forecast win ends the fight: take it, using as few potions as possible.
 // Runs after the hallway potion rule, so a win that needs a held-back potion is not forced.
 // A win whose forecast names an unmodeled enemy power or an unobserved per-turn cap is not trusted.
 // Ravenous (a survivor eats the dead) cannot trigger with one enemy left.
 // An unmodeled debuff on the player (Tender: lose Strength per card) makes the damage untrusted.
 // With no living enemy (a boss between revives) there is nothing to win: the rule does not apply.
 const lone=alive(state).length===1;
 const debuffs=new Set((state.player?.status??[]).filter(p=>p.type==='Debuff').map(p=>String(p.name).toLowerCase()));
 const untrustedDebuff=w=>{const m=String(w).match(/^Unmodeled player power: (.+)$/);return m&&debuffs.has(m[1].trim().toLowerCase());};
 const trusted=c=>!(c.forecast.warnings??[]).some(w=>(/Unmodeled enemy power|not observed/i.test(w)&&!(lone&&/Unmodeled enemy power: Ravenous/i.test(w)))||untrustedDebuff(w));
 const wins=alive(state).length===0?[]:kept.filter(c=>c.forecast?.boundary==='combat_won'&&c.forecast.survives===true&&c.forecast.quality!=='unknown'&&trusted(c));
 if(wins.length){
  const potions=c=>(c.plan??[c]).filter(p=>p.command?.action==='use_potion').length;
  const fewest=Math.min(...wins.map(potions));
  apply('take_lethal',wins.filter(c=>potions(c)===fewest));
 }
 // While every enemy is Intangible, damage is capped at 1, so keep only the plays that lose the least HP.
 const living=alive(state);
 if(living.length&&living.every(e=>(e.status??[]).some(p=>/^intangible$/i.test(p.name??'')))){
  const known=kept.filter(c=>c.forecast?.quality!=='unknown'&&Number.isFinite(c.forecast?.hpLoss));
  const least=Math.min(...known.map(c=>c.forecast.hpLoss));
  if(known.length)apply('intangible_defense',kept.filter(c=>!known.includes(c)||c.forecast.hpLoss===least),{hp_loss:least});
 }
 // Ending the turn with energy to play a card that costs HP if held (Beckon) wastes that HP.
 const hpIfHeld=(state.player?.hand??[]).filter(c=>c.can_play!==false&&/if this is in your Hand,\s+lose \d+ HP/i.test(c.description??'')&&Number(c.cost)<=(state.player?.energy??0));
 if(hpIfHeld.length){
  // Also remove a play that leaves too little energy for one (JEV12: Whirlwind spent all 3 energy
  // with two Beckons in hand, 12 HP lost), unless it wins the fight.
  const energy=state.player?.energy??0,hand=state.player?.hand??[],need=Math.min(...hpIfHeld.map(c=>Number(c.cost)));
  const starves=c=>{if(c.command.action!=='play_card'||c.forecast?.boundary==='combat_won')return false;
   const card=hand.find(h=>h.index===c.command.card_index)??hand[c.command.card_index];
   if(!card||hpIfHeld.includes(card))return false;
   const cost=String(card.cost).toUpperCase()==='X'?energy:Number(card.cost);
   return Number.isFinite(cost)&&energy-cost<need;};
  // Keep a starving play when its forecast (which counts held Beckons) beats every line that keeps energy for one.
  const known=c=>c.forecast?.quality!=='unknown'&&c.forecast?.survives!==false&&Number.isFinite(c.forecast?.hpLoss);
  const fed=kept.filter(c=>c.command.action!=='end_turn'&&!starves(c)&&known(c));
  const bestFed=Math.min(...fed.map(c=>c.forecast.hpLoss));
  const worth=c=>known(c)&&c.forecast.hpLoss<bestFed;
  apply('play_hp_loss_cards',kept.filter(c=>c.command.action!=='end_turn'&&(!starves(c)||worth(c))),{card:hpIfHeld[0].name});
 }
 // A death countdown on an enemy ("In 2 turns, you will be eaten and die", The Insatiable's
 // Sandpit) is pushed back only by cards that name it ("Increase Sandpit by 1"). The one-turn
 // forecast sees the death only on the last turn, so once the countdown is at 3 or less, an
 // affordable extending card in hand is played before anything else.
 const countdown=deathCountdown(state);
 if(countdown&&countdown.amount<=3){
  const extenders=new Set((state.player?.hand??[]).filter(c=>c.can_play!==false&&Number(c.cost)<=(state.player?.energy??0)
   &&new RegExp(`Increase ${countdown.name} by \\d+`,'i').test(c.description??'')).map(c=>c.index));
  const escapes=kept.filter(c=>c.command.action==='play_card'&&extenders.has(c.command.card_index));
  if(extenders.size&&diesNow(escapes,kept,countdown))lift('countdown_escape','forced_line_dies',escapes,{power:countdown.name,amount:countdown.amount});
  else if(extenders.size)apply('countdown_escape',escapes,{power:countdown.name,amount:countdown.amount});
 }
 // Pure block does nothing when ending the turn now takes no damage and nothing uses block.
 // HP lost from held cards (Beckon) ignores block, so only damage counts; End turn is read from
 // the original options because the Beckon rule may already have removed it.
 const end=candidates.find(c=>c.command.action==='end_turn');
 const damageTaken=end?.forecast&&Number.isFinite(end.forecast.hpLoss)?end.forecast.hpLoss-(end.forecast.endTurnCardHpLoss??0):null;
 if(damageTaken===0&&end.forecast.quality!=='unknown'&&!usesBlock(state))
  apply('block_not_needed',kept.filter(c=>!(c.command.action==='play_card'&&pureBlock(c.details))));
 // Cards the fight plan says to play first (fight.play_first): while one is affordable in hand,
 // other card plays and ending the turn are removed.
 const first=new Set((fight?.play_first??[]).map(n=>String(n).replace(/\+$/,'').toLowerCase()));
 if(first.size){
  const idx=new Set((state.player?.hand??[]).filter(c=>c.can_play!==false&&Number(c.cost)<=(state.player?.energy??0)&&first.has(String(c.name).replace(/\+$/,'').toLowerCase())).map(c=>c.index));
  const firstLines=kept.filter(c=>c.command.action==='use_potion'||(c.command.action==='play_card'&&idx.has(c.command.card_index)));
  // A setup card is not forced into a turn it makes much worse: the best forced line must stay within
  // the danger margin (max(10, 12% max HP)) of the best surviving line. Countdown escapes always apply.
  const bestLoss=list=>Math.min(...list.filter(c=>c.forecast?.quality!=='unknown'&&c.forecast?.survives!==false&&Number.isFinite(c.forecast?.hpLoss)).map(c=>c.forecast.hpLoss));
  const margin=Math.max(10,Math.ceil(0.12*(state.player?.max_hp??0)));
  const bf=bestLoss(firstLines),bk=bestLoss(kept);
  const costly=!deathCountdown(state)&&Number.isFinite(bf)&&Number.isFinite(bk)&&bf-bk>=margin;
  if(idx.size&&costly)lift('play_first','costly',firstLines,{best_forced_hp_loss:bf,best_hp_loss:bk});
  else if(idx.size&&diesNow(firstLines,kept,deathCountdown(state)))lift('play_first','forced_line_dies',firstLines);
  else if(idx.size)apply('play_first',firstLines);
 }
 // Target priority: the first entry that matches a living enemy picks the focus.
 const enemies=alive(state);
 let focus=null,focusName=null;
 for(const wanted of fight?.target_priority??[]){
  focus=resolveTarget(String(wanted).trim(),enemies,kept);focusName=wanted;
  if(focus)break;
 }
 // A name matches every living enemy it names, as resolveTarget matches (two Bowlbug (Nectar)s are both the focus).
 const focusIds=new Set(focus?(TARGET_SELECTORS.includes(String(focusName).trim())?[focus]:enemies.filter(e=>e.name?.toLowerCase().includes(String(focusName).trim().toLowerCase()))).map(e=>e.entity_id):[]);
 if(focus&&enemies.length>focusIds.size){
  apply('target_priority',kept.filter(c=>{
   const target=c.command.target;
   if(!target||focusIds.has(target)||!['play_card','use_potion'].includes(c.command.action))return true;
   return (c.forecast?.defeatedEnemies??[]).some(d=>d.id===target);
  }),{enemy:focus.name});
 }
 return {candidates:kept,rules,lifted};
}

// Constrained mode: code enforces the parts of the plan that are checkable.
export function constrainCandidates(state,candidates,plan,mode='constrained',{fight=null,ownScreens=true,screenChoices={}}={}) {
 if(!plan||mode!=='constrained'||plan.run_id!==state.run?.live_id)return {candidates,constraint:null};
 if(combatScreens.has(state.state_type)){
  const {candidates:kept,rules,lifted}=combatConstraints(state,candidates,plan,fight);
  return {candidates:kept,constraint:rules.length||lifted.length?{kind:'combat',rules,removed:candidates.length-kept.length,...(lifted.length?{lifted}:{})}:null};
 }
 if(ownScreens&&isOwnedScreen(state)){
  const first=orderedAllowed(candidates,plan,screenChoices[screenKey(state)]);
  // remembered: the answer was given for this screen at an earlier consult, not by the plan in force now.
  if(first)return {candidates:[first],constraint:{kind:'strategist_choice',removed:candidates.length-1,removed_ids:removedIds(candidates,[first]),remembered:plan.screen!==screenKey(state)}};
 }
 if(plan.screen===screenKey(state)&&plan.allowed_options?.length){
  const kept=candidates.filter(c=>plan.allowed_options.includes(optionKey(c)));
  if(kept.length)return {candidates:kept,constraint:{kind:'allowed_options',removed:candidates.length-kept.length,removed_ids:removedIds(candidates,kept)}};
 }
 const fixed=exhaustConstraint(state,candidates)??restConstraint(state,candidates);
 if(fixed)return fixed;
 if(state.state_type==='map'&&plan.route_path?.length&&plan.route_act===state.run.act){
  const kept=routeOptions(candidates,plan);
  if(kept.length)return {candidates:kept,constraint:{kind:'route',removed:candidates.length-kept.length,removed_ids:removedIds(candidates,kept)}};
 }
 if(state.state_type==='shop'&&plan.shop?.gold_reserve>0){
  const gold=state.player?.gold??0,items=state.shop?.items??[];
  const kept=candidates.filter(c=>{
   if(c.command.action!=='shop_purchase')return true;
   const price=items.find(i=>i.index===c.command.index)?.price;
   return typeof price!=='number'||gold-price>=plan.shop.gold_reserve;
  });
  if(kept.length&&kept.length<candidates.length)return {candidates:kept,constraint:{kind:'gold_reserve',reserve:plan.shop.gold_reserve,removed:candidates.length-kept.length,removed_ids:removedIds(candidates,kept)}};
 }
 return {candidates,constraint:null};
}

// What Jev sees: stable fields, not the strategist's reasoning.
export function strategyContext(plan,state,fight=null) {
 if(!plan||plan.run_id!==state.run?.live_id)return null;
 const context={source:'Strategist run plan, written at act '+plan.act+' floor '+plan.floor+' ('+plan.reason+')',...planFields(plan)};
 // Card, shop, route and rest policy do not bear on combat moves; leave them out of combat requests.
 if(combatScreens.has(state.state_type))for(const k of ['card_reward','shop','route','route_path','rest'])delete context[k];
 // Fight plans are scoped to their encounter, so they never carry into another fight.
 if(fight?.plan)context.fight_plan={plan:fight.plan,target_priority:fight.target_priority??[]};
 if(plan.screen===screenKey(state)){
  if(plan.option_note)context.current_screen_note=plan.option_note;
  if(plan.recommended_options?.length)context.recommended_options=plan.recommended_options;
 }
 return context;
}
