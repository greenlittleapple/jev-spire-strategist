import {actionsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {decisionQuestion} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {compactRequest} from '../../vendor/jev-the-spire/spire-demo/compact-request.mjs';
import {includeHextechRules} from './runes.mjs';
import {includePileKnowledge} from './piles.mjs';
import {FACTS_POLICY} from './route-facts.mjs';

export const EFFICIENT_POLICY = 'jev-compact-v1';
const combatScreens = new Set(['monster','elite','boss']);
const instructions = {
 combat: 'Win the encounter while preserving the run. Compare focused kills, defense, useful scaling and potion timing. Read enemy intents and powers, death/revival effects, retaliation, facing and play limits. Apply live rules before partial forecasts; unknown is not zero. Compare affordable card order and remaining energy, including draw/setup payoffs. A plan is a prefix, not a forced end of turn. Re-observe after its first action. Avoid ending with a useful playable action, but do not play into harmful triggers. Use observed HP/Strength trends to detect a losing race; never invent future intents or phases.',
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

export function efficientQuestion(state,candidates,recent={},strategy=null,facts=null) {
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
 payload.state.policy=facts?FACTS_POLICY:EFFICIENT_POLICY;
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
 if(state.state_type==='rewards')return command==='proceed'&&state.rewards?.items?.length===0;
 if(state.state_type==='treasure')return command==='proceed'&&state.treasure?.relics?.length===0;
 if(state.state_type==='rest_site')return command==='proceed'&&!(state.rest_site?.options??[]).some(o=>o.is_enabled);
 return false;
}

export function reviewReason(state,candidates,chosen) {
 if(!combatScreens.has(state.state_type))return null;
 if(chosen.command.action==='end_turn'&&candidates.some(c=>['play_card','use_potion'].includes(c.command.action)))
  return 'Ending while a card or potion can still be used: compare a concrete beneficial alternative, retaliation, self-damage and potion timing. Keeping end turn is valid if those alternatives are harmful or wasteful.';
 if(chosen.forecast?.survives===false)
  return 'This prefix has a forecast marked lethal. Check its caveats, continuation and every legal alternative against live rules before accepting it. A partial forecast is not proof of death or safety.';
 return null;
}

export async function efficientDeliberate({state,candidates,ask,recent={},strategy=null,facts=null,onStage=()=>{}}) {
 if(!candidates.length)throw Error('No legal candidates');
 if(isForcedChoice(state,candidates))return {
  decisionSource:'forced',model:null,usage:{input_tokens:0,output_tokens:0},deliberation:null,
  answers:{move:{type:'choice',choice:candidates[0].id,confidence:null,probabilities:{}}}
 };
 const payload=efficientQuestion(state,candidates,recent,strategy,facts),calls=[];
 const evaluate=async (request,stage)=>{
  onStage(stage);
  const result=await ask(request),answer=result.answers?.move;
  if(answer?.type!=='choice'||!candidates.some(c=>c.id===answer.choice))throw Error('Jev returned an invalid action ID.');
  calls.push({stage,input_tokens:result.usage?.input_tokens??0,output_tokens:result.usage?.output_tokens??0,request_chars:JSON.stringify(request).length});
  return result;
 };
 const first=await evaluate(payload,'Jev is choosing');
 const selected=candidates.find(c=>c.id===first.answers.move.choice);
 const reason=reviewReason(state,candidates,selected);
 let final=first;
 if(reason){
  const review=structuredClone(payload);
  review.state.proposed_action={id:selected.id,label:selected.label,reason_for_review:reason};
  review.questions.move.instructions+=' Review the proposed action against this specific concern. The initial answer is a fallible same-model hypothesis, not independent evidence. All original choices remain available.';
  final=await evaluate(review,'Jev is checking a risky choice');
 }
 return {...final,decisionSource:'jev',usage: calls.reduce((sum,c)=>({input_tokens:sum.input_tokens+c.input_tokens,output_tokens:sum.output_tokens+c.output_tokens}),{input_tokens:0,output_tokens:0}),
  deliberation:{version:facts?FACTS_POLICY:EFFICIENT_POLICY,focus:'selective',calls:calls.length,request_usage:calls,reviewReason:reason,
   initial:first.answers.move,assessments:{move:first.answers.move},changed:final.answers.move.choice!==first.answers.move.choice}};
}
