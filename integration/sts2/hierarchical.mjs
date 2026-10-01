// Jev decides every move; Claude refreshes a persistent strategy on triggers.
import {efficientDeliberate,isForcedChoice} from './efficient-decisions.mjs';
import {computedFacts,currentMap,distinctRoutes,mapNodeKeys,eliteReadiness,FACTS_POLICY,FACTS_V3_POLICY,STRATEGY_FACTS_POLICY} from './route-facts.mjs';
import {STRATEGIST_INSTRUCTIONS,PLAN_SCHEMA,screenKey,replanReason,escalationReason,isOwnedScreen,
 strategistBrief,requestStamp,stampPlan,constrainCandidates,strategyContext,deathCountdown,swapPending,swapClaim,eliteReadyConstraint} from './strategy.mjs';
import {patternFor} from './movesets.mjs';
import {cardSummary} from './card-stats.mjs';
import {currentEncounter,fightId,FIGHT_START_REASONS,planForRun,activeFightPlan} from './playbook.mjs';
import {encounterResults,planNeedsReview} from './fight-results.mjs';
import {unknownMechanics,mechanicsToAsk,mechanicText,presentNames,mechanicKey} from './mechanics.mjs';
import {replayChoice} from './replay.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const addUsage=(a,b)=>({input_tokens:(a?.input_tokens??0)+(b?.input_tokens??0),output_tokens:(a?.output_tokens??0)+(b?.output_tokens??0)});
const noUsage={input_tokens:0,output_tokens:0};
// Constraints from code rules, not from the strategist's plan: when one leaves a single option the
// move is labeled 'rule' (with the rule's name), not 'claude'.
const RULE_CONSTRAINTS=new Set(['combat','exhaust_choice','rest_waste','elite_not_ready']);
const direct=(decisionSource,model,choice,extra={})=>({decisionSource,model,usage:noUsage,deliberation:null,...extra,
 answers:{move:{type:'choice',choice:choice.id,confidence:null,probabilities:{}}}});

export function newStrategyStatus({enabled=false,mode='constrained',threshold=0.35,waitMs=300000,ownScreens=true}={}) {
 if(!['constrained','advisory'].includes(mode))throw Error('CLAUDE_PLAN_MODE must be constrained or advisory');
 if(!(threshold>0&&threshold<1)||!(waitMs>=0))throw Error('Invalid strategist settings');
 return {enabled,mode,threshold,waitMs,ownScreens,plan:null,available:true,requests:0,answers:0,timeouts:0};
}

// strategist = {channel, status, playbook}; status is the persisted dashboard record and
// playbook holds per-encounter fight plans (optional).
// replay = the active reference run from replay.mjs, or null.
// factsVersion 2 or 3 adds exact route/resource facts (jev-compact-v2/v3); strategy uses v3.
// mapMemory = {runId, act, map, position} from the runner's last map screen.
// onEvent(event) receives each strategy event when it happens (the runner logs it then), so a
// request posted by a decision that is later cancelled, or before a runner restart, is still logged.
// strategyEvents in the result lists the same events.
export async function hierarchicalDeliberate({state,candidates,ask,recent={},onStage=()=>{},onEvent=null,strategist,withFacts=false,factsVersion=withFacts?2:0,mapMemory=null,replay=null,cancelled=()=>false}) {
 if(isForcedChoice(state,candidates))return efficientDeliberate({state,candidates,ask,recent,onStage});
 // Claude mode keeps the v3.1 facts label; jev-compact-v3.2 and later (the shop majority rule) are jev_facts_v3 only.
 const version=strategist?3:factsVersion,factsPolicy=strategist?STRATEGY_FACTS_POLICY:version>=3?FACTS_V3_POLICY:FACTS_POLICY;
 // Elite readiness (v3 facts: claude and jev_facts_v3 modes). elite_not_ready removes its options before
 // anything else sees them, the strategist's triggers and route included.
 const readiness=version>=3&&state.state_type==='map'?eliteReadiness(state):null;
 const eliteRule=readiness?eliteReadyConstraint(state,candidates,readiness):null;
 if(eliteRule)candidates=eliteRule.candidates;
 const facts=version?computedFacts(state,candidates,mapMemory,{version,readiness:strategist?null:readiness}):null;
 // v3 also enables the potion and shop resource reviews.
 const resourceReviews=version>=3;
 const events=[];
 const replayed=replayChoice(replay,state,candidates);
 if(replay&&!replayed&&isOwnedScreen(state)&&!replay.diverged.has(screenKey(state))){
  replay.diverged.add(screenKey(state));
  events.push({kind:'replay_diverged',screen:screenKey(state),source_run:replay.source});
 }
 const emit=async event=>{events.push(event);if(onEvent)await onEvent(event);};
 if(onEvent)for(const e of events)await onEvent(e);
 if(!strategist){
  if(replayed)return {...direct('replay','Reference run',replayed),strategyEvents:events};
  if(eliteRule&&candidates.length===1)return {...direct('rule','Rule',candidates[0],{constraint:eliteRule.constraint,rule:'elite_not_ready'}),strategyEvents:events};
  return {...await efficientDeliberate({state,candidates,ask,recent,onStage,facts,factsPolicy,resourceReviews}),...(eliteRule?{constraint:eliteRule.constraint}:{}),strategyEvents:events};
 }
 const {channel,status,playbook=null,glossary=null,movesets=null}=strategist;
 const cardStats=()=>strategist.cardStats??null;
 const fightResults=()=>strategist.fightResults??null;
 const mechanics=strategist.mechanics??null;
 const known=mechanics?await mechanics.all():{};
 // Unmodeled powers, relics and cards in this fight that have no saved explanation yet; powers named after
 // your own cards and potions count as those items (integration/sts2/mechanics.mjs unknownMechanics).
 const unknownHere=['monster','elite','boss'].includes(state.state_type)?unknownMechanics(state,candidates,known):[];
 const {map,position}=currentMap(state,mapMemory);
 status.fights??={};status.encountersAsked??=[];status.screenChoices??={};status.screenChoiceGiven??={};
 // Screens whose answer was adopted during this call (a strategist choice there is from this consult).
 const adoptedHere=new Set();
 const encounter=currentEncounter(state,status.fights);
 const adopt=async()=>{
  const request=await channel.current();
  const answer=request&&await channel.take(request.id);
  if(!answer)return false;
  status.plan=stampPlan(answer.plan,request.stamp,{request_id:request.id,answeredAt:answer.answeredAt});
  status.answers++;status.available=true;adoptedHere.add(status.plan.screen);
  // Remember each screen's ordered list so returning to that screen reuses it; screenChoiceGiven
  // records the request and floor each list came from, for the decision records.
  if(status.plan.allowed_options?.length){
   if(Object.keys(status.screenChoices).some(k=>!k.startsWith(String(status.plan.run_id)))){status.screenChoices={};status.screenChoiceGiven={};}
   status.screenChoices[status.plan.screen]=status.plan.allowed_options;
   status.screenChoiceGiven[status.plan.screen]={request_id:request.id,floor:status.plan.floor};
   const keys=Object.keys(status.screenChoices);if(keys.length>60){delete status.screenChoices[keys[0]];delete status.screenChoiceGiven[keys[0]];}
  }
  if(mechanics){
   const meta={run:request.stamp.run_id,floor:request.stamp.floor};
   // The kind comes from the request's list, else from a saved entry with that name, else "any".
   const kinds=new Map((request.brief?.unknown_mechanics??[]).map(m=>[m.name,m.kind]));
   const saved=Object.values(await mechanics.all()),savedKind=name=>saved.find(e=>e.name===name)?.kind;
   for(const m of answer.plan.mechanics??[])await mechanics.set(m.name,m.note,meta,kinds.get(m.name)??savedKind(m.name)??'any');
   // Items asked about but not explained are recorded too, so they do not trigger again.
   const answered=new Set((answer.plan.mechanics??[]).map(m=>m.name));
   for(const m of request.brief?.unknown_mechanics??[])if(!answered.has(m.name))await mechanics.set(m.name,'No special handling noted.',meta,m.kind??'any');
  }
  // A fight-start answer saves the encounter's plan; one from a consult during the fight applies to
  // that fight until it ends (status.fightPlan) and is not saved.
  const {stamp}=request,fight=answer.plan.fight,startsFight=FIGHT_START_REASONS.has(stamp.reason);
  let fightScope=null;
  if(stamp.encounter_key&&fight?.plan){
   const id=`${stamp.run_id}:${stamp.act}:${stamp.floor}`;
   if(startsFight){
    if(status.fightPlan?.fight_id===id)status.fightPlan=null;
    if(playbook){await playbook.set(stamp.encounter_key,fight,{source:stamp.reason,run:stamp.run_id,floor:stamp.floor});fightScope='encounter';}
   }else{
    status.fightPlan={fight_id:id,encounter:stamp.encounter_key,plan:fight.plan,target_priority:fight.target_priority??[],
     ...(fight.play_first?.length?{play_first:fight.play_first}:{}),source:stamp.reason,request_id:request.id,floor:stamp.floor};
    fightScope='this_fight';
   }
  }
  await emit({kind:'strategy_adopted',reason:stamp.reason,request_id:request.id,requestCreatedAt:request.createdAt??null,answeredAt:answer.answeredAt??null,
   ...(fightScope?{fight_scope:fightScope}:{}),plan:status.plan});
  return true;
 };
 const consult=async reason=>{
  const key=`${reason}:${screenKey(state)}`,current=await channel.current();
  if(current?.key!==key){
   const fight=playbook&&encounter?await playbook.get(encounter):null;
   // Route nodes go into the stamp only when the brief lists routes: a consult off the map
   // (the act's opening event) must not count as having seen this act's routes.
   const routes=distinctRoutes(map,position);
   const brief=strategistBrief(state,candidates,reason,status.plan,{routes,facts});
   const runId=state.run?.live_id;
   if(encounter){brief.encounter=encounter;if(fight)brief.saved_fight_plan=planForRun(fight,runId);
    else{const similar=playbook?await playbook.similar(encounter):null;if(similar)brief.similar_fight_plan=planForRun(similar,runId);}
    // A plan given earlier in this fight by a mid-fight consult.
    const own=status.fightPlan?.fight_id===fightId(state)?status.fightPlan:null;
    if(own)brief.current_fight_plan={plan:own.plan,target_priority:own.target_priority,...(own.play_first?{play_first:own.play_first}:{}),source:own.source};
    // How this encounter went before (HP, rounds, win), marking fights played since the saved plan.
    const results=fightResults()&&encounterResults(fightResults(),encounter,fight?.updatedAt??null);if(results)brief.encounter_results=results;}
   // Intents each enemy showed round by round in recent fights (this one included).
   if(movesets&&brief.enemies)for(const e of brief.enemies){const seen=patternFor(movesets,e.name);if(seen.length)e.seen_pattern=seen;}
   // Earlier runs: how often an offered card was taken, played per fight afterwards, and run depth.
   if(cardStats()&&['card_reward','shop','card_select'].includes(state.state_type))for(const o of brief.current_options??[]){const past=cardSummary(cardStats(),o.label);if(past)o.past_runs=past;}
   if(reason==='unknown_mechanic')brief.unknown_mechanics=unknownHere.map(([name,kind])=>({name,kind,text:mechanicText(state,name)}));
   // Descriptions for named cards and relics the options mention but do not explain.
   if(glossary)await glossary(brief);
   const request=await channel.post({key,instructions:STRATEGIST_INSTRUCTIONS,schema:PLAN_SCHEMA,brief,
    stamp:{...requestStamp(state,candidates,reason,mapNodeKeys(map)),encounter_key:encounter,
     // Seen routes carry forward within an act; only a brief that lists them marks them seen.
     route_act:routes?state.run.act:status.plan?.act===state.run.act&&status.plan?.run_id===state.run.live_id?status.plan.route_act??null:null,
     // Elites whose risky readiness the strategist has seen at a route_risk branch this act: asked once each.
     readiness_asked:[...(status.plan?.act===state.run.act&&status.plan?.run_id===state.run.live_id?status.plan.readiness_asked??[]:[]),
      ...(brief.route_risk?.elite_readiness?.level==='risky'&&brief.route_risk.elite_readiness.elite?[brief.route_risk.elite_readiness.elite.node]:[])],
     // A choice screen inside a fight (a potion's card pick) keeps that fight as the plan's encounter,
     // so the fight-start trigger does not fire again for the same fight.
     ...(!['monster','elite','boss'].includes(state.state_type)&&status.plan?.encounter&&status.plan.floor===state.run.floor&&status.plan.run_id===state.run.live_id?{encounter:status.plan.encounter}:{})}});
   status.requests++;
   // Logged when posted, with the brief the strategist is shown.
   await emit({kind:'strategy_request',reason,request_id:request.id,key,run_id:state.run?.live_id??null,state_type:state.state_type,
    act:state.run?.act??null,floor:state.run?.floor??null,createdAt:request.createdAt,brief});
  }
  // Claude strategy mode never falls back to Jev: play waits for the answer until
  // it arrives or the operator pauses (which cancels the decision).
  onStage('Waiting for the strategist to update the run strategy');
  for(;;){
   if(cancelled())throw Error('Decision cancelled.');
   await sleep(1000);
   if(await adopt())return true;
  }
 };
 const decide=async()=>{
  if(replayed)return direct('replay','Reference run',replayed);
  // True forced choices (isForcedChoice) returned above; one candidate left here comes from the
  // runner's own filters (actionsFor), and the game may allow other actions.
  if(isOwnedScreen(state)&&candidates.length===1&&status.ownScreens!==false)return direct('filtered',null,candidates[0]);
  // The plan from a consult during this fight, else the saved plan (play_first only from this run).
  const fight=encounter?activeFightPlan(state,status,playbook?await playbook.get(encounter):null):null;
  const {candidates:options,constraint:planned}=constrainCandidates(state,candidates,status.plan,status.mode,{fight,ownScreens:status.ownScreens!==false,screenChoices:status.screenChoices});
  // With the plan's route also applied, both are recorded as rules in order under the plan's kind.
  const constraint=!eliteRule?planned:!planned?eliteRule.constraint:{...planned,removed:eliteRule.constraint.removed+planned.removed,
   removed_ids:[...eliteRule.constraint.removed_ids,...(planned.removed_ids??[])],rules:[eliteRule.constraint,planned]};
  // A single option left by a code rule is that rule's move; one left by the strategist's plan is
  // its choice. Neither needs a Jev call.
  // A rule that only recorded lifts (removed 0) did not choose; a lone option then stays single_option.
  const ruleKind=constraint&&RULE_CONSTRAINTS.has(constraint.kind);
  if(ruleKind&&constraint.removed>0&&options.length===1)
   return direct('rule','Rule',options[0],{constraint,rule:constraint.kind==='combat'?constraint.rules?.at(-1)?.kind??'combat':constraint.kind});
  if(constraint&&!ruleKind&&options.length===1){
   const extra={constraint};
   if(constraint.kind==='strategist_choice'){
    const key=screenKey(state),given=status.screenChoices[key]?status.screenChoiceGiven[key]:{request_id:status.plan.request_id??null,floor:status.plan.floor??null};
    extra.screenChoice={source:adoptedHere.has(key)?'consult':'remembered',floor:given?.floor??null,request_id:given?.request_id??null};
    // A relic bought from the strategist's own list does not ask again as a new relic.
    const item=options[0].command.action==='shop_purchase'?options[0].details:null;
    if(item?.category==='relic'&&item.relic_id)status.listRelics={run_id:state.run?.live_id,ids:[...(status.listRelics?.run_id===state.run?.live_id?status.listRelics.ids:[]),item.relic_id].slice(-10)};
   }
   return direct('claude','Strategist',options[0],extra);
  }
  const strategy=strategyContext(status.plan,state,fight);
  // Saved explanations of mechanics present now reach Jev directly, not only through plan text.
  const here=presentNames(state),notes=Object.entries(known).filter(([k,{note}])=>here.has(k)&&note!=='No special handling noted.').map(([k,{name,note}])=>({name:name??k,note}));
  if(strategy&&notes.length)strategy.mechanics=notes;
  return {...await efficientDeliberate({state,candidates:options,ask,recent,onStage,facts,factsPolicy,resourceReviews,strategy}),constraint};
 };

 await adopt();
 // A potion discard is followed by the claim it made room for (strategy.mjs swapClaim), with no consult.
 // The pending swap is kept until that claim is no longer offered, so a stale or cancelled claim is retried.
 const swapped=swapClaim(state,candidates,status.potionSwap);
 if(!swapped)status.potionSwap=null;
 else return {...direct('rule','Rule',swapped,{rule:'potion_swap_claim',constraint:{kind:'potion_swap_claim',removed:candidates.length-1,
  removed_ids:candidates.filter(c=>c!==swapped).map(c=>c.id),discarded:status.potionSwap.discarded}}),strategyEvents:events};
 let trigger=replanReason(state,status.plan,candidates,{ownScreens:status.ownScreens!==false,screenChoices:status.screenChoices});
 // A replayed screen needs no strategist decision.
 if(trigger==='owned_screen'&&replayed)trigger=null;
 // new_relic after buying the relic from the strategist's own shop list: the plan already chose it,
 // so the relic joins the plan's list instead of asking again (10 of 82 new_relic consults).
 if(trigger==='new_relic'&&status.listRelics?.run_id===state.run?.live_id){
  const planned=status.plan.relic_ids??[],added=(state.player?.relics??[]).map(r=>r.id).filter(id=>!planned.includes(id));
  if(added.length&&added.every(id=>status.listRelics.ids.includes(id))){
   status.plan={...status.plan,relic_ids:[...planned,...added].sort()};status.listRelics=null;trigger=null;
  }
 }
 // A normal fight's first sight of an encounter with no saved plan asks for one, once per fight.
 // A saved plan that went badly since it was written (a loss, or a quarter of max HP lost on average)
 // is reviewed once per fight.
 if(!trigger&&state.state_type==='monster'&&playbook&&encounter&&!status.encountersAsked.includes(fightId(state))){
  const saved=await playbook.get(encounter);
  const next=!saved?'new_encounter':planNeedsReview(fightResults(),encounter,saved)?'review_encounter':null;
  if(next){
   status.encountersAsked.push(fightId(state));
   if(status.encountersAsked.length>100)status.encountersAsked.shift();
   trigger=next;
  }
 }
 // An enemy that shows a death countdown ("In N turns, you will be eaten and die") asks once
 // per fight: the fight-start plan was written before the countdown existed.
 status.countdownsAsked??=[];
 if(!trigger&&deathCountdown(state)&&!status.countdownsAsked.includes(fightId(state))){
  status.countdownsAsked.push(fightId(state));
  if(status.countdownsAsked.length>50)status.countdownsAsked.shift();
  trigger='death_countdown';
 }
 // Unmodeled mechanics without a saved explanation: each name asks at most once per fight, and one that
 // first appears later in the fight still asks.
 status.mechanicsAsked??=[];
 const toAsk=mechanicsToAsk(unknownHere,status.mechanicsAsked,fightId(state));
 if(!trigger&&toAsk.length){
  for(const [name] of toAsk)status.mechanicsAsked.push(`${fightId(state)}|${name}`);
  while(status.mechanicsAsked.length>200)status.mechanicsAsked.shift();
  trigger='unknown_mechanic';
 }
 if(trigger)await consult(trigger);
 let result=await decide();
 const escalation=result.decisionSource==='jev'&&escalationReason(state,result.answers.move,status.plan,status.threshold);
 if(escalation&&await consult(escalation)){
  const first=result;
  result=await decide();
  result={...result,usage:addUsage(first.usage,result.usage),escalatedFrom:first.answers.move};
 }
 status.potionSwap=swapPending(state,candidates.find(c=>c.id===result.answers?.move?.choice));
 return {...result,strategyEvents:events};
}
