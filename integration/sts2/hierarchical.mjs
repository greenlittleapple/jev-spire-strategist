// Jev decides every move; Claude refreshes a persistent strategy on triggers.
import {efficientDeliberate,isForcedChoice} from './efficient-decisions.mjs';
import {computedFacts,currentMap,distinctRoutes,mapNodeKeys,FACTS_POLICY,FACTS_V3_POLICY} from './route-facts.mjs';
import {STRATEGIST_INSTRUCTIONS,PLAN_SCHEMA,screenKey,replanReason,escalationReason,
 strategistBrief,requestStamp,stampPlan,constrainCandidates,strategyContext} from './strategy.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const addUsage=(a,b)=>({input_tokens:(a?.input_tokens??0)+(b?.input_tokens??0),output_tokens:(a?.output_tokens??0)+(b?.output_tokens??0)});

export function newStrategyStatus({enabled=false,mode='constrained',threshold=0.35,waitMs=300000}={}) {
 if(!['constrained','advisory'].includes(mode))throw Error('CLAUDE_PLAN_MODE must be constrained or advisory');
 if(!(threshold>0&&threshold<1)||!(waitMs>=0))throw Error('Invalid Claude strategy settings');
 return {enabled,mode,threshold,waitMs,plan:null,available:true,requests:0,answers:0,timeouts:0};
}

// strategist = {channel, status}; status is the persisted dashboard record.
// factsVersion 2 or 3 adds exact route/resource facts (jev-compact-v2/v3); strategy uses v3.
// mapMemory = {runId, act, map, position} from the runner's last map screen.
export async function hierarchicalDeliberate({state,candidates,ask,recent={},onStage=()=>{},strategist,withFacts=false,factsVersion=withFacts?2:0,mapMemory=null,cancelled=()=>false}) {
 if(isForcedChoice(state,candidates))return efficientDeliberate({state,candidates,ask,recent,onStage});
 const version=strategist?3:factsVersion,factsPolicy=version>=3?FACTS_V3_POLICY:FACTS_POLICY;
 const facts=version?computedFacts(state,candidates,mapMemory,{version}):null;
 // v3 also enables the potion and shop resource reviews.
 const resourceReviews=version>=3;
 if(!strategist)return efficientDeliberate({state,candidates,ask,recent,onStage,facts,factsPolicy,resourceReviews});
 const {channel,status}=strategist,events=[];
 const {map,position}=currentMap(state,mapMemory);
 const adopt=async()=>{
  const request=await channel.current();
  const answer=request&&await channel.take(request.id);
  if(!answer)return false;
  status.plan=stampPlan(answer.plan,request.stamp,{request_id:request.id,answeredAt:answer.answeredAt});
  status.answers++;status.available=true;
  events.push({kind:'strategy_adopted',reason:request.stamp.reason,request_id:request.id,plan:status.plan});
  return true;
 };
 const consult=async reason=>{
  const key=`${reason}:${screenKey(state)}`,current=await channel.current();
  if(current?.key!==key){
   const request=await channel.post({key,instructions:STRATEGIST_INSTRUCTIONS,schema:PLAN_SCHEMA,
    brief:strategistBrief(state,candidates,reason,status.plan,{routes:distinctRoutes(map,position),facts}),stamp:requestStamp(state,candidates,reason,mapNodeKeys(map))});
   status.requests++;
   events.push({kind:'strategy_request',reason,request_id:request.id});
  }
  // After a timeout the request stays posted, but play does not block on it again
  // until an answer arrives or the operator restarts Autoplay.
  if(!status.available)return false;
  onStage('Waiting for Claude to update the run strategy');
  for(const deadline=Date.now()+status.waitMs;Date.now()<deadline;){
   if(cancelled())throw Error('Decision cancelled.');
   await sleep(1000);
   if(await adopt())return true;
  }
  status.available=false;status.timeouts++;
  events.push({kind:'strategy_timeout',reason});
  return false;
 };
 const decide=async()=>{
  const {candidates:options,constraint}=constrainCandidates(state,candidates,status.plan,status.mode);
  // A single allowed option is Claude's choice; no Jev call is needed.
  if(constraint&&options.length===1)return {decisionSource:'claude',model:'Claude strategy',usage:{input_tokens:0,output_tokens:0},deliberation:null,constraint,
   answers:{move:{type:'choice',choice:options[0].id,confidence:null,probabilities:{}}}};
  return {...await efficientDeliberate({state,candidates:options,ask,recent,onStage,facts,factsPolicy,resourceReviews,strategy:strategyContext(status.plan,state)}),constraint};
 };

 await adopt();
 const trigger=replanReason(state,status.plan,candidates);
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
