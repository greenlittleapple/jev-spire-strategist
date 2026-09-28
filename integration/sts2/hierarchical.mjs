// Jev decides every move; Claude refreshes a persistent strategy on triggers.
import {efficientDeliberate,isForcedChoice} from './efficient-decisions.mjs';
import {computedFacts,currentMap,distinctRoutes,mapNodeKeys,FACTS_POLICY,FACTS_V3_POLICY} from './route-facts.mjs';
import {STRATEGIST_INSTRUCTIONS,PLAN_SCHEMA,screenKey,replanReason,escalationReason,isOwnedScreen,
 strategistBrief,requestStamp,stampPlan,constrainCandidates,strategyContext,deathCountdown} from './strategy.mjs';
import {patternFor} from './movesets.mjs';
import {cardSummary} from './card-stats.mjs';
import {currentEncounter,fightId} from './playbook.mjs';
import {encounterResults,planNeedsReview} from './fight-results.mjs';
import {replayChoice} from './replay.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const addUsage=(a,b)=>({input_tokens:(a?.input_tokens??0)+(b?.input_tokens??0),output_tokens:(a?.output_tokens??0)+(b?.output_tokens??0)});
const noUsage={input_tokens:0,output_tokens:0};
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
export async function hierarchicalDeliberate({state,candidates,ask,recent={},onStage=()=>{},strategist,withFacts=false,factsVersion=withFacts?2:0,mapMemory=null,replay=null,cancelled=()=>false}) {
 if(isForcedChoice(state,candidates))return efficientDeliberate({state,candidates,ask,recent,onStage});
 const version=strategist?3:factsVersion,factsPolicy=version>=3?FACTS_V3_POLICY:FACTS_POLICY;
 const facts=version?computedFacts(state,candidates,mapMemory,{version}):null;
 // v3 also enables the potion and shop resource reviews.
 const resourceReviews=version>=3;
 const events=[];
 const replayed=replayChoice(replay,state,candidates);
 if(replay&&!replayed&&isOwnedScreen(state)&&!replay.diverged.has(screenKey(state))){
  replay.diverged.add(screenKey(state));
  events.push({kind:'replay_diverged',screen:screenKey(state),source_run:replay.source});
 }
 if(!strategist){
  if(replayed)return {...direct('replay','Reference run',replayed),strategyEvents:events};
  return {...await efficientDeliberate({state,candidates,ask,recent,onStage,facts,factsPolicy,resourceReviews}),strategyEvents:events};
 }
 const {channel,status,playbook=null,glossary=null,movesets=null}=strategist;
 const cardStats=()=>strategist.cardStats??null;
 const fightResults=()=>strategist.fightResults??null;
 const {map,position}=currentMap(state,mapMemory);
 status.fights??={};status.encountersAsked??=[];status.screenChoices??={};
 const encounter=currentEncounter(state,status.fights);
 const adopt=async()=>{
  const request=await channel.current();
  const answer=request&&await channel.take(request.id);
  if(!answer)return false;
  status.plan=stampPlan(answer.plan,request.stamp,{request_id:request.id,answeredAt:answer.answeredAt});
  status.answers++;status.available=true;
  // Remember each screen's ordered list so returning to that screen reuses it.
  if(status.plan.allowed_options?.length){
   if(Object.keys(status.screenChoices).some(k=>!k.startsWith(String(status.plan.run_id))))status.screenChoices={};
   status.screenChoices[status.plan.screen]=status.plan.allowed_options;
   const keys=Object.keys(status.screenChoices);if(keys.length>60)delete status.screenChoices[keys[0]];
  }
  if(playbook&&request.stamp.encounter_key&&answer.plan.fight?.plan)
   await playbook.set(request.stamp.encounter_key,answer.plan.fight,{source:request.stamp.reason,run:request.stamp.run_id,floor:request.stamp.floor});
  events.push({kind:'strategy_adopted',reason:request.stamp.reason,request_id:request.id,plan:status.plan});
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
   if(encounter){brief.encounter=encounter;if(fight)brief.saved_fight_plan=fight;
    else{const similar=playbook?await playbook.similar(encounter):null;if(similar)brief.similar_fight_plan=similar;}
    // How this encounter went before (HP, rounds, win), marking fights played since the saved plan.
    const results=fightResults()&&encounterResults(fightResults(),encounter,fight?.updatedAt??null);if(results)brief.encounter_results=results;}
   // Intents each enemy showed round by round in recent fights (this one included).
   if(movesets&&brief.enemies)for(const e of brief.enemies){const seen=patternFor(movesets,e.name);if(seen.length)e.seen_pattern=seen;}
   // Earlier runs: how often an offered card was taken, played per fight afterwards, and run depth.
   if(cardStats()&&['card_reward','shop','card_select'].includes(state.state_type))for(const o of brief.current_options??[]){const past=cardSummary(cardStats(),o.label);if(past)o.past_runs=past;}
   // Descriptions for named cards and relics the options mention but do not explain.
   if(glossary)await glossary(brief);
   const request=await channel.post({key,instructions:STRATEGIST_INSTRUCTIONS,schema:PLAN_SCHEMA,brief,
    stamp:{...requestStamp(state,candidates,reason,mapNodeKeys(map)),encounter_key:encounter,
     // Seen routes carry forward within an act; only a brief that lists them marks them seen.
     route_act:routes?state.run.act:status.plan?.act===state.run.act?status.plan.route_act??null:null,
     // A choice screen inside a fight (a potion's card pick) keeps that fight as the plan's encounter,
     // so the fight-start trigger does not fire again for the same fight.
     ...(!['monster','elite','boss'].includes(state.state_type)&&status.plan?.encounter&&status.plan.floor===state.run.floor&&status.plan.run_id===state.run.live_id?{encounter:status.plan.encounter}:{})}});
   status.requests++;
   events.push({kind:'strategy_request',reason,request_id:request.id});
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
  if(isOwnedScreen(state)&&candidates.length===1&&status.ownScreens!==false)return direct('forced',null,candidates[0]);
  const fight=playbook&&encounter?await playbook.get(encounter):null;
  const {candidates:options,constraint}=constrainCandidates(state,candidates,status.plan,status.mode,{fight,ownScreens:status.ownScreens!==false,screenChoices:status.screenChoices});
  // A single allowed option is Claude's choice; no Jev call is needed.
  if(constraint&&options.length===1)return direct('claude','Strategist',options[0],{constraint});
  return {...await efficientDeliberate({state,candidates:options,ask,recent,onStage,facts,factsPolicy,resourceReviews,strategy:strategyContext(status.plan,state,fight)}),constraint};
 };

 await adopt();
 let trigger=replanReason(state,status.plan,candidates,{ownScreens:status.ownScreens!==false,screenChoices:status.screenChoices});
 // A replayed screen needs no strategist decision.
 if(trigger==='owned_screen'&&replayed)trigger=null;
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
 if(trigger)await consult(trigger);
 let result=await decide();
 const escalation=result.decisionSource==='jev'&&escalationReason(state,result.answers.move,status.plan,status.threshold);
 if(escalation&&await consult(escalation)){
  const first=result;
  result=await decide();
  result={...result,usage:addUsage(first.usage,result.usage),escalatedFrom:first.answers.move};
 }
 return {...result,strategyEvents:events};
}
