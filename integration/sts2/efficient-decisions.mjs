import {actionsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {decisionQuestion} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {compactRequest} from '../../vendor/jev-the-spire/spire-demo/compact-request.mjs';
import {includeHextechRules} from './runes.mjs';
import {includePileKnowledge} from './piles.mjs';
import {FACTS_POLICY,FACTS_V3_POLICY} from './route-facts.mjs';

export const EFFICIENT_POLICY = 'jev-compact-v1';
const combatScreens = new Set(['monster','elite','boss']);
const instructions = {
 combat: 'Win the encounter while preserving the run. Compare focused kills, defense, useful scaling and potion timing. Read enemy intents and powers, death/revival effects, retaliation, facing and play limits. Apply live rules before partial forecasts; unknown is not zero. Compare affordable card order and remaining energy, including draw/setup payoffs. A plan is a prefix, not a forced end of turn. Re-observe after its first action. Avoid ending with a useful playable action, but do not play into harmful triggers. Use observed HP/Strength trends to detect a losing race; never invent future intents or phases. Forecasts cover this turn only. Quality partial or unknown, or a notModeled card, means effects are missing, not zero. lastingEffects keep working for the rest of combat and are not in the forecast numbers; value them over the remaining fight.',
 card_reward: 'Compare every offered card with skipping using the actual deck, rune/relic interactions, energy, draw consistency and remaining needs. Value the marginal copy, not a hypothetical archetype. Current deck and live rules determine what is useful.',
 shop: 'Compare affordable purchase combinations, removal, potion capacity and leaving. Pick the first purchase of a useful basket or leave if poor value. Preserve gold for a concrete better opportunity; do not invent future stock.',
 map: 'Compare visible routes using current HP, deck strength, potions and the available rest sites, elites, shops and rewards. Balance survival and future strength. Unrevealed rooms remain unknown.',
 rest_site: 'Compare healing, upgrades and every other visible option against current HP, deck needs and the visible route ahead.',
 card_select: 'Follow the current selection prompt and selection_origin. Compare the actual selectable cards, destination and timing: discard, exhaust, top-deck, return, upgrade, remove or transform have different purposes. Recheck current costs and effects. Only select or confirm a supplied legal option.',
 hextech_rune: 'Compare all offered runes and available player/enemy rerolls against the deck and equipped effects. Consider replacement uncertainty, remaining uses, the shared golden upgrade and pending enemy hexes.',
 general: 'Compare every supplied option using current HP, resources, visible consequences, deck and relic/rune interactions. Follow the current screen prompt. Do not invent hidden rewards or outcomes.'
};

export function summarizeHistory(saved) {
 if(!saved)return undefined;
 const {map_point_history=[],...metadata}=saved;
 const byAct=[],recent=[];
 for(const [actIndex,entries] of map_point_history.entries()){
  const summary={act:actIndex+1,rooms:0,combat_turns:0,damage_taken:0,hp_healed:0,gold_spent:0};
  for(const entry of entries){
   summary.rooms++;
   const turns=(entry.rooms??[]).reduce((n,r)=>n+(r.turns_taken??0),0);
   summary.combat_turns+=turns;
   for(const player of entry.player_stats??[])for(const key of ['damage_taken','hp_healed','gold_spent'])summary[key]+=player[key]??0;
   recent.push({act:actIndex+1,type:entry.map_point_type,rooms:(entry.rooms??[]).map(({model_id,room_type,turns_taken})=>({model_id,room_type,turns_taken})),
    players:(entry.player_stats??[]).map(({current_hp,max_hp,current_gold,damage_taken,hp_healed})=>({current_hp,max_hp,current_gold,damage_taken,hp_healed}))});
  }
  byAct.push(summary);
 }
 return {...metadata,history_summary:{by_act:byAct,recent_rooms:recent.slice(-3),
  scope:'Summary of saved room outcomes; past reward offers and detailed per-card history are omitted from inference. The complete save remains local. Current deck, piles and resources come from the live game.'}};
}

export function efficientQuestion(state,candidates,recent={},strategy=null,facts=null,factsPolicy=FACTS_POLICY) {
 if(!candidates.length||candidates.length>255)throw Error('Unsupported action count');
 const projected={...state};
 if(state.saved_run)projected.saved_run=summarizeHistory(state.saved_run);
 const payload=decisionQuestion(projected,candidates);
 // These duplicate enemy/relic rules already present in the live state.
 delete payload.state.encounter;
 if(payload.state.deck)delete payload.state.deck.relics;
 const combat=combatScreens.has(state.state_type)||Boolean(state.battle);
 const stripAssessments=items=>(items??[]).slice(-2).map(({jevAssessments,...item})=>item);
 payload.state.recent_observations=combat?{
  turnHistory:(recent.turnHistory??[]).slice(-4),progress:recent.progress??null,
  unfinishedPlan:recent.unfinishedPlan??null,sameFight:stripAssessments(recent.sameFight)
 }:{recentDeckDecisions:stripAssessments(recent.recentDeckDecisions)};
 const focus=combatScreens.has(state.state_type)?'combat':state.state_type==='hand_select'?'card_select':state.state_type==='fake_merchant'?'shop':state.state_type;
 payload.state.policy=facts?factsPolicy:EFFICIENT_POLICY;
 if(facts)payload.state.computed_facts=facts;
 if(strategy)payload.state.run_strategy=strategy;
 payload.questions={move:{...payload.questions.move,instructions:
  'Choose the next supplied action ID that best advances winning the run. Only its first action executes before a fresh observation. '+(instructions[focus]??instructions.general)
  +(facts?' computed_facts are exact counts from the visible map and live state (route contents per option, what remains ahead, rest healing, potions, gold); use them instead of re-deriving routes or arithmetic. They remove no options and imply no preference.':'')
  +(strategy?' run_strategy is the current plan from a slower strategist: follow its priorities and policies where the live options allow, but live rules, forecasts and legal actions take precedence over it.':'')}};
 return includePileKnowledge(includeHextechRules(compactRequest(payload)));
}

export function isForcedChoice(state,candidates) {
 const legal=actionsFor(state);
 if(candidates.length!==1||legal.length!==1||JSON.stringify(candidates[0].command)!==JSON.stringify(legal[0].command))return false;
 // actionsFor includes legacy policy filters; one remaining candidate is not
 // always the only game choice (e.g. skip a reward or cancel a confirmation).
 const command=candidates[0].command.action;
 if(combatScreens.has(state.state_type))return command==='end_turn'
  &&!(state.player?.hand??[]).some(c=>c.can_play)&&!(state.player?.potions??[]).some(p=>p.can_use_in_combat);
 if(state.state_type==='map')return command==='choose_map_node'&&state.map?.next_options?.length===1;
 if(state.state_type==='event')return (command==='advance_dialogue'&&state.event?.in_dialogue===true)
  ||(command==='choose_event_option'&&(state.event?.options??[]).filter(o=>!o.is_locked).length===1);
 if(state.state_type==='rewards')return command==='proceed'&&(state.rewards?.items?.length??0)===0;
 if(state.state_type==='treasure')return command==='proceed'&&(state.treasure?.relics?.length??0)===0; // relics is absent once taken
 if(state.state_type==='rest_site')return command==='proceed'&&!(state.rest_site?.options??[]).some(o=>o.is_enabled);
 return false;
}

// v3 adds two resource reviews: potions in normal fights (always drunk in round 1 at
// full HP in logged runs) and leaving a shop with gold for an affordable removal or potion.
// Fight key -> HP at the last potion review. Without this the review repeats every
// turn when a potion is the only alternative to ending the turn.
const potionReviews=new Map();
export function potionReviewDue(state){
 const p=state.player??{},key=`${state.run?.live_id}:${state.run?.act}:${state.run?.floor}`,last=potionReviews.get(key);
 if(last!=null&&!(p.max_hp&&last-p.hp>=0.2*p.max_hp))return false;
 potionReviews.set(key,p.hp);
 if(potionReviews.size>50)potionReviews.delete(potionReviews.keys().next().value);
 return true;
}

export function resourceReviewReason(state,candidates,chosen) {
 const p=state.player??{},action=chosen.command.action;
 if(state.state_type==='monster'&&action==='use_potion'&&potionReviewDue(state))
  return 'This spends a potion in a normal (non-elite, non-boss) fight. Potions are scarce and elites and the boss are harder. Using computed_facts (potions held, floors to boss) and the visible enemy intents, compare the HP this fight can realistically cost without the potion against keeping it. Keep the potion choice only if this fight threatens a large HP loss or death.';
 if(state.state_type==='shop'&&action==='proceed'&&(p.gold??0)>=100){
  const slotFree=(p.potions?.length??0)<(p.max_potion_slots??0);
  const useful=candidates.filter(c=>c.command.action==='shop_purchase'&&(c.details?.category==='card_removal'||(c.details?.category==='potion'&&slotFree)));
  if(useful.length)return `Leaving the shop with ${p.gold} gold while a card removal or potion is affordable. Gold has no value at the end of the run; computed_facts give shops still reachable this act. Compare leaving against every affordable purchase, including removing a weak card. Keep leaving only if nothing offered helps the run.`;
 }
 return null;
}

// Turn key -> reviewed. One order review per turn keeps the cost bounded.
const orderReviews=new Set();
const dangerReviews=new Set();
// A dangerous turn (ending now loses at least 25% of max HP, or drops below the plan's replan
// threshold) where the chosen line loses at least max(10, 12% of max HP) more than the best
// known surviving line. One review per turn.
export function dangerReviewReason(state,candidates,chosen,{fightPlan=null,replanPercent=30}={}) {
 if(!combatScreens.has(state.state_type))return null;
 const maxHp=state.player?.max_hp,hp=state.player?.hp;
 if(!maxHp||!Number.isFinite(hp))return null;
 const end=candidates.find(c=>c.command.action==='end_turn'),endLoss=end?.forecast?.hpLoss;
 if(end?.forecast?.quality==='unknown'||!Number.isFinite(endLoss))return null;
 if(endLoss<0.25*maxHp&&100*(hp-endLoss)/maxHp>=replanPercent)return null;
 const known=candidates.filter(c=>c.forecast?.quality!=='unknown'&&c.forecast?.survives===true&&Number.isFinite(c.forecast?.hpLoss));
 const mine=chosen.forecast?.hpLoss;
 if(!known.length||!Number.isFinite(mine))return null;
 const best=known.reduce((a,c)=>c.forecast.hpLoss<a.forecast.hpLoss?c:a);
 if(mine-best.forecast.hpLoss<Math.max(10,Math.ceil(0.12*maxHp)))return null;
 const turn=`${state.run?.live_id}:${state.run?.floor}:${state.battle?.round}`;
 if(dangerReviews.has(turn))return null;
 dangerReviews.add(turn);if(dangerReviews.size>200)dangerReviews.delete(dangerReviews.keys().next().value);
 return `Dangerous turn: ending now loses ${endLoss} HP (${hp}/${maxHp}). This line is forecast to lose ${mine}; ${best.label} loses ${best.forecast.hpLoss}.`
  +(fightPlan?` Fight plan: ${fightPlan}`:'')
  +' Keep this line only if it kills an attacker or its damage clearly saves more HP over the fight than the defensive line saves now.';
}
// An attack chosen first while a non-attack setup card leads to more forecast damage this turn.
export function orderReviewReason(state,candidates,chosen,{minGain=3}={}) {
 if(!combatScreens.has(state.state_type)||chosen.command.action!=='play_card')return null;
 const hand=state.player?.hand??[],cardOf=c=>hand.find(h=>h.index===c.command.card_index)??hand[c.command.card_index];
 if(cardOf(chosen)?.type!=='Attack')return null;
 const key=c=>JSON.stringify(c.command),best=new Map();
 for(const c of candidates){const d=c.forecast?.damage;if(typeof d==='number')best.set(key(c),Math.max(best.get(key(c))??-1,d));}
 const mine=best.get(key(chosen));
 if(mine==null)return null;
 const setups=candidates.filter(c=>c.command.action==='play_card'&&cardOf(c)&&cardOf(c).type!=='Attack'&&(best.get(key(c))??-1)>=mine+minGain);
 if(!setups.length)return null;
 const turn=`${state.run?.live_id}:${state.run?.floor}:${state.battle?.round}`;
 if(orderReviews.has(turn))return null;
 orderReviews.add(turn);if(orderReviews.size>200)orderReviews.delete(orderReviews.keys().next().value);
 const top=[...new Map(setups.map(c=>[key(c),c])).values()].sort((a,b)=>best.get(key(b))-best.get(key(a))).slice(0,2);
 return `Card order: this attacks first, but playing ${top.map(c=>`${cardOf(c).name} first (up to ${best.get(key(c))} forecast damage this turn)`).join(' or ')} beats the best attack-first line (${mine}). Setup such as Strength, Vulnerable or Cruelty should come before the attacks it boosts. Keep attacking first only if it kills, avoids a harmful trigger, or block and energy make the setup line worse.`;
}

export function reviewReason(state,candidates,chosen,{resourceReviews=false,strategy=null}={}) {
 if(resourceReviews){
  const danger=dangerReviewReason(state,candidates,chosen,{fightPlan:strategy?.fight_plan?.plan??null,replanPercent:strategy?.replan_below_hp_percent??30});
  const reason=danger??resourceReviewReason(state,candidates,chosen)??orderReviewReason(state,candidates,chosen);if(reason)return reason;
 }
 if(!combatScreens.has(state.state_type))return null;
 if(chosen.command.action==='end_turn'&&candidates.some(c=>['play_card','use_potion'].includes(c.command.action)))
  return 'Ending while a card or potion can still be used: compare a concrete beneficial alternative, retaliation, self-damage and potion timing. Keeping end turn is valid if those alternatives are harmful or wasteful.';
 // When no option is forecast to survive, the review has nothing to switch to.
 if(chosen.forecast?.survives===false&&candidates.some(c=>c.forecast?.survives!==false))
  return 'This prefix has a forecast marked lethal. Check its caveats, continuation and every legal alternative against live rules before accepting it. A partial forecast is not proof of death or safety.';
 return null;
}

// Majority rule for leaving a shop (jev-compact-v3.2): Jev's answer to leave stands only with at
// least 0.5 of its probability. Otherwise the most probable affordable purchase is taken
// ({choice, record}); null when the answer stands. Jev-only logs had 19 plurality leaves at
// p 0.26-0.41, and every Jev-only loss died with unspent gold (mean 228).
export function majorityLeave(state,candidates,answer,threshold=0.5) {
 if(state.state_type!=='shop')return null;
 const picked=candidates.find(c=>c.id===answer?.choice);
 if(picked?.command.action!=='proceed')return null;
 const p=answer.probabilities??{},pLeave=p[picked.id];
 if(!Number.isFinite(pLeave)||pLeave>=threshold)return null;
 const pl=state.player??{},gold=pl.gold??0,slotsFull=(pl.potions?.length??0)>=(pl.max_potion_slots??3);
 // Affordable and in stock; a potion only with a free slot.
 const buys=candidates.filter(c=>c.command.action==='shop_purchase'&&Number.isFinite(p[c.id])&&p[c.id]>0
  &&Number.isFinite(c.details?.price)&&c.details.price<=gold&&c.details.is_stocked!==false&&c.details.can_afford!==false
  &&!(c.details.category==='potion'&&slotsFull));
 if(!buys.length)return null;
 const best=buys.reduce((a,c)=>p[c.id]>p[a.id]?c:a);
 return {choice:best.id,record:{kind:'majority_leave',p_leave:pLeave,jev_choice:picked.id,chosen:best.id,p_chosen:p[best.id],price:best.details.price,gold}};
}
// The forecast fields a review record keeps for one option: HP lost this turn and quality.
const forecastOf=c=>c?{id:c.id,label:c.label,hp_loss:Number.isFinite(c.forecast?.hpLoss)?c.forecast.hpLoss:null,
 quality:c.forecast?.quality??null,survives:c.forecast?.survives??null}:null;

export async function efficientDeliberate({state,candidates,ask,recent={},strategy=null,facts=null,factsPolicy=FACTS_POLICY,resourceReviews=false,onStage=()=>{}}) {
 if(!candidates.length)throw Error('No legal candidates');
 if(isForcedChoice(state,candidates))return {
  decisionSource:'forced',model:null,usage:{input_tokens:0,output_tokens:0},deliberation:null,
  answers:{move:{type:'choice',choice:candidates[0].id,confidence:null,probabilities:{}}}
 };
 // One offered option (a reward, a confirmation, or the one option a rule left): Jev could only
 // answer with it, so no call is made. Not "forced": the game may allow other actions.
 if(candidates.length===1)return {
  decisionSource:'single_option',model:null,usage:{input_tokens:0,output_tokens:0},deliberation:null,
  answers:{move:{type:'choice',choice:candidates[0].id,confidence:null,probabilities:{}}}
 };
 const payload=efficientQuestion(state,candidates,recent,strategy,facts,factsPolicy),calls=[];
 const evaluate=async (request,stage)=>{
  onStage(stage);
  const result=await ask(request),answer=result.answers?.move;
  if(answer?.type!=='choice'||!candidates.some(c=>c.id===answer.choice))throw Error('Jev returned an invalid action ID.');
  calls.push({stage,input_tokens:result.usage?.input_tokens??0,output_tokens:result.usage?.output_tokens??0,request_chars:JSON.stringify(request).length});
  return result;
 };
 const first=await evaluate(payload,'Jev is choosing');
 const selected=candidates.find(c=>c.id===first.answers.move.choice);
 const reason=reviewReason(state,candidates,selected,{resourceReviews,strategy});
 let final=first;
 if(reason){
  const review=structuredClone(payload);
  review.state.proposed_action={id:selected.id,label:selected.label,reason_for_review:reason};
  review.questions.move.instructions+=' Review the proposed action against this specific concern. The initial answer is a fallible same-model hypothesis, not independent evidence. All original choices remain available.';
  final=await evaluate(review,'Jev is checking a risky choice');
 }
 // The review record: Jev's first pick and its forecast next to the final pick, so the audit can
 // tell whether a changed pick lowered the forecast loss.
 const reviewRecord=reason?{initial:forecastOf(selected),final:forecastOf(candidates.find(c=>c.id===final.answers.move.choice))}:null;
 // jev_facts_v3 only (its label); applied after the shop review, to Jev's final answer.
 const override=factsPolicy===FACTS_V3_POLICY&&facts&&!strategy?majorityLeave(state,candidates,final.answers.move):null;
 // The executed choice becomes the purchase; the answer keeps Jev's pick as jev_choice and its probabilities.
 const answers=override?{...final.answers,move:{...final.answers.move,choice:override.choice,jev_choice:final.answers.move.choice}}:final.answers;
 return {...final,answers,decisionSource:'jev',usage: calls.reduce((sum,c)=>({input_tokens:sum.input_tokens+c.input_tokens,output_tokens:sum.output_tokens+c.output_tokens}),{input_tokens:0,output_tokens:0}),
  deliberation:{version:facts?factsPolicy:EFFICIENT_POLICY,focus:'selective',calls:calls.length,request_usage:calls,reviewReason:reason,
   initial:first.answers.move,assessments:{move:first.answers.move},changed:final.answers.move.choice!==first.answers.move.choice,
   ...(reviewRecord?{review:reviewRecord}:{}),...(override?{override:override.record}:{})}};
}
