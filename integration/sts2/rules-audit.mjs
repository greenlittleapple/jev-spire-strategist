// Rule audit and forecast check over the private decision logs. For each enforced rule and
// each second-look review: how often it fired, how often it left one option or changed Jev's
// pick, and what followed (HP lost that turn, fight won or lost). Then, for end-turn decisions,
// the forecast HP loss against the HP actually lost by the next turn.
//   node integration/sts2/rules-audit.mjs [--json] [--since ISO-time] [--run id]
import {readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {encounterKey} from './playbook.mjs';

const combat=new Set(['monster','elite','boss']);
// Screens that mean the fight is over (won); in-fight choice screens (hand_select) keep it open.
const after=new Set(['rewards','card_reward','map','event','rest_site','shop','treasure']);
// Rules and reviews whose judgment rests on the one-turn forecast.
export const FORECAST_RULES=['avoid_fatal','take_lethal','block_not_needed','hallway_potion','idle_potion','intangible_defense','review:danger','review:lethal_forecast'];

// Review kinds, from the review prompt (compact policies) or the older per-review flags.
export function reviewKind(d){
 const r=d?.reviewReason;
 if(r){
  if(/^Dangerous turn/.test(r))return 'danger';
  if(/^This spends a potion/.test(r))return 'potion';
  if(/^Leaving the shop/.test(r))return 'shop';
  if(/^Card order/.test(r))return 'card_order';
  if(/forecast marked lethal/.test(r))return 'lethal_forecast';
  if(/^Ending while a card or potion/.test(r))return 'end_turn';
  return 'other';
 }
 if(d?.endTurnReviewed)return 'end_turn';
 if(d?.orderReviewed)return 'card_order';
 if(d?.merchantReviewed)return 'shop';
 return null;
}

const fc=f=>f?{hpLoss:f.hpLoss,quality:f.quality??null,survives:f.survives}:null;
// Keeps the fields the audit reads, so a large log fits in memory. Other record kinds give null.
export function slim(e){
 if(e.kind==='run_end')return {kind:'run_end',time:e.time,run:e.state?.run?.live_id??null,type:e.state?.state_type??null,hp:e.state?.player?.hp??0};
 if(e.kind!=='decision')return null;
 const s=e.state??{},f=e.chosen?.forecast,d=e.deliberation;
 // Forecasts of the options a rule removed, when the rule recorded their IDs.
 const removedIds=new Set((e.strategyConstraint?.rules??[e.strategyConstraint]).flatMap(r=>r?.removed_ids??[]));
 const removed=removedIds.size?Object.fromEntries((e.candidates??[]).filter(c=>removedIds.has(c.id)).map(c=>[c.id,fc(c.forecast)])):null;
 return {kind:'decision',time:e.time,outcome:e.outcome,policy:e.policy??null,source:e.decisionSource??null,
  run:s.run?.live_id??null,act:s.run?.act??null,floor:s.run?.floor??null,type:s.state_type??null,battle:Boolean(s.battle),round:s.battle?.round??null,
  hp:s.player?.hp??null,max_hp:s.player?.max_hp??null,...(s.event?.event_id==='THE_ARCHITECT'?{architect:true}:{}),encounter:combat.has(s.state_type)&&s.battle?encounterKey(s.battle.enemies):null,
  options:e.candidates?.length??null,constraint:e.strategyConstraint??null,
  review:reviewKind(d),changed:d?.changed??null,review_forecast:d?.review??null,override:d?.override??null,removed_forecast:removed,
  action:e.chosen?.command?.action??null,label:e.chosen?.label??null,
  forecast:f?{hpLoss:f.hpLoss,quality:f.quality??null,survives:f.survives,boundary:f.boundary??null,warnings:(f.warnings??[]).slice(0,3)}:null};
}

// Fights (run:act:floor) with their turns, rebuilt from every observed state in log order.
// A turn's HP loss runs from its first observation to the first observation of a later round.
// The last turn of a won fight ends at the fight's last observation, before post-fight heals
// (Burning Blood); a fight lost ends at 0 HP. That turn is marked ends_fight.
export function buildFights(events){
 const fights=new Map(),open=new Map();
 const close=(run,result,hp)=>{const f=open.get(run);if(!f)return;open.delete(run);f.result=result;f.hp_end=hp;};
 for(const e of events){
  if(!e.run)continue;
  if(e.kind==='run_end'){const f=open.get(e.run);if(f)close(e.run,(e.hp??0)>0?'ended':'died',e.hp??0);continue;}
  if(e.kind!=='decision'||e.hp==null)continue;
  const key=`${e.run}:${e.act}:${e.floor}`,f=open.get(e.run);
  if(e.battle&&(combat.has(e.type)||f?.key===key)){
   if(f&&f.key!==key)close(e.run,'won',f.hp_last);
   let g=open.get(e.run);
   if(!g){g={key,run:e.run,act:e.act,floor:e.floor,type:combat.has(e.type)?e.type:null,encounter:e.encounter,policy:e.policy,hp_start:e.hp,max_hp:e.max_hp,turns:new Map(),result:'open',hp_end:null,hp_last:e.hp};open.set(e.run,g);fights.set(key,g);}
   g.type??=combat.has(e.type)?e.type:null;g.encounter??=e.encounter;
   if(e.round!=null&&!g.turns.has(e.round))g.turns.set(e.round,{round:e.round,hp:e.hp});
   g.hp_last=e.hp;continue;
  }
  if(f&&(after.has(e.type)||f.key!==key))close(e.run,'won',e.hp);
 }
 for(const f of fights.values()){
  const rounds=[...f.turns.values()].sort((a,b)=>a.round-b.round);
  rounds.forEach((t,i)=>{const next=rounds[i+1];
   if(next){t.hp_next=next.hp;t.ends_fight=false;}
   else if(f.result!=='open'){t.hp_next=f.result==='died'?0:f.hp_last;t.ends_fight=true;}
   else t.hp_next=null;
   t.lost=t.hp_next==null?null:t.hp-t.hp_next;});
 }
 return fights;
}

const turnOf=(fights,e)=>fights.get(`${e.run}:${e.act}:${e.floor}`)?.turns.get(e.round)??null;
const mean=a=>a.length?Math.round(10*a.reduce((x,y)=>x+y,0)/a.length)/10:null;
const pctOf=(n,d)=>d?Math.round(100*n/d):null;
const quant=(a,q)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(q*s.length))];};

// Outcome summary over firings: distinct turns and fights, HP lost that turn, fight results.
function outcome(list,fights){
 const turns=new Map(),fs=new Map();
 for(const x of list){if(x.turn)turns.set(x.turnKey,x.turn);if(x.fight)fs.set(x.fight.key,x.fight);}
 const losses=[...turns.values()].map(t=>t.lost).filter(Number.isFinite);
 const results=[...fs.values()].map(f=>f.result);
 return {turns:turns.size,turns_no_hp_lost_pct:pctOf(losses.filter(n=>n<=0).length,losses.length),mean_hp_lost:mean(losses),
  fights:fs.size,fights_won:results.filter(r=>r==='won').length,fights_lost:results.filter(r=>r==='died').length,
  fights_other:results.filter(r=>r!=='won'&&r!=='died').length};
}
const split=(list,by,fights)=>{const g={};for(const x of list)(g[x[by]??'?']??=[]).push(x);return Object.fromEntries(Object.entries(g).sort().map(([k,v])=>[k,{decisions:v.length,...outcome(v,fights)}]));};

// Forecast check: executed end-turn decisions in combat, forecast HP loss of that line against
// the HP lost by the next turn. error = actual - forecast (positive: more lost than forecast).
// The forecast counts damage past 0 HP, so it is capped at the HP held.
export function forecastCheck(events,fights){
 const rows=[];
 for(const e of events){
  if(e.kind!=='decision'||e.outcome!=='executed'||!combat.has(e.type)||e.action!=='end_turn'||!Number.isFinite(e.forecast?.hpLoss))continue;
  const t=turnOf(fights,e),f=fights.get(`${e.run}:${e.act}:${e.floor}`);
  if(!t||t.hp_next==null||e.hp==null)continue;
  const actual=e.hp-t.hp_next,forecast=Math.min(e.forecast.hpLoss,e.hp);
  rows.push({run:e.run,act:e.act,floor:e.floor,round:e.round,type:e.type,encounter:f?.encounter??e.encounter,policy:e.policy,
   quality:e.forecast.quality??'none',forecast,actual,error:actual-forecast,ends_fight:t.ends_fight,
   survives:e.forecast.survives,died:t.ends_fight&&f?.result==='died',warnings:e.forecast.warnings,turnKey:`${e.run}:${e.act}:${e.floor}:${e.round}`});
 }
 return rows;
}
export function errorSummary(rows){
 const err=rows.map(r=>r.error),abs=err.map(Math.abs);
 return {n:rows.length,mean_error:mean(err),median_error:quant(err,0.5),p10:quant(err,0.1),p90:quant(err,0.9),mean_abs_error:mean(abs),
  exact_pct:pctOf(err.filter(x=>x===0).length,err.length),under_pct:pctOf(err.filter(x=>x>0).length,err.length),over_pct:pctOf(err.filter(x=>x<0).length,err.length),
  off_by_5_plus_pct:pctOf(abs.filter(x=>x>=5).length,abs.length)};
}

// A firing is costly when it removed a line forecast (known, surviving) to lose at least
// max(5, 6% of max HP) less HP this turn than the line played; null without removed IDs or forecasts.
function costlyRemoval(r,e){
 const known=x=>x&&x.quality!=='unknown'&&x.survives===true&&Number.isFinite(x.hpLoss);
 if(!r.removed_ids?.length||!e.removed_forecast||!known(e.forecast))return null;
 const margin=Math.max(5,Math.ceil(0.06*(e.max_hp??0)));
 return r.removed_ids.map(id=>e.removed_forecast[id]).some(x=>known(x)&&e.forecast.hpLoss-x.hpLoss>=margin);
}
// Review forecasts: for changed picks with both forecasts known, the first and final HP-loss forecasts.
function reviewForecasts(v){
 if(!v.some(x=>x.forecast))return {};
 const rows=v.filter(x=>x.changed&&Number.isFinite(x.forecast?.initial?.hp_loss)&&Number.isFinite(x.forecast?.final?.hp_loss))
  .map(x=>[x.forecast.initial.hp_loss,x.forecast.final.hp_loss]);
 return {changed_with_forecasts:{n:rows.length,initial_mean_hp_loss:mean(rows.map(r=>r[0])),final_mean_hp_loss:mean(rows.map(r=>r[1])),
  lower:rows.filter(([a,b])=>b<a).length,same:rows.filter(([a,b])=>b===a).length,higher:rows.filter(([a,b])=>b>a).length}};
}

const misses=rows=>rows.slice(0,8).map(({turnKey,ends_fight,survives,died,...r})=>({...r,run:String(r.run).split(':').pop()}));
export function audit(events,{since=null,run=null}={}){
 const keep=e=>(!since||e.time>=since)&&(!run||e.run===run||String(e.run).endsWith(':'+run));
 events=events.filter(keep);
 const fights=buildFights(events);
 const firings=[],reviews=[],lifts=[],overrides=[],runs=new Map();
 for(const e of events){
  // The Architect event follows the final boss, and the game then ends the run at 0 HP.
  if(e.kind==='run_end'&&e.run)runs.set(e.run,runs.get(e.run)==='won'?'won':e.hp>0?'ended':'died');
  if(e.architect)runs.set(e.run,'won');
  if(e.kind!=='decision'||e.outcome!=='executed')continue;
  if(!runs.has(e.run))runs.set(e.run,'open');
  const fight=e.battle?fights.get(`${e.run}:${e.act}:${e.floor}`)??null:null;
  const base={run:e.run,act:e.act,policy:e.policy,type:fight?.type??e.type,fight,turn:fight?turnOf(fights,e):null,turnKey:`${e.run}:${e.act}:${e.floor}:${e.round}`,combat:Boolean(fight)};
  const c=e.constraint;
  if(c){
   // Candidates are logged before the rules run; each rule's removed count gives what it left.
   let left=e.options??null;
   for(const r of (c.rules??[c]).filter(x=>(x.removed??1)>0)){
    if(left!=null)left-=r.removed??0;
    firings.push({...base,rule:r.kind,single:left===1,source:e.source,costly:costlyRemoval(r,e),remembered:r.remembered??null});
   }
   for(const l of c.lifted??[])lifts.push({run:e.run,rule:l.kind,reason:l.reason??'?'});
  }
  if(e.review)reviews.push({...base,rule:'review:'+e.review,changed:e.changed===true,forecast:e.review_forecast});
  if(e.override)overrides.push({run:e.run,kind:e.override.kind??'?',price:e.override.price??null});
 }
 const forecast=forecastCheck(events,fights);
 const errByTurn=new Map(forecast.filter(r=>!r.ends_fight).map(r=>[r.turnKey,r.error]));
 const allTurns=[...fights.values()].flatMap(f=>[...f.turns.values()].map(t=>({turn:t,fight:f,turnKey:`${f.key}:${t.round}`,type:f.type,act:f.act,policy:f.policy})));
 const baseline=outcome(allTurns,fights);
 const baselineBy=Object.fromEntries(['type','act','policy'].map(k=>[k,split(allTurns,k,fights)]));
 const summarize=(list,extra)=>{
  const out={};
  for(const [rule,v] of Object.entries(Object.groupBy(list,x=>x.rule)).sort()){
   const inCombat=v.filter(x=>x.combat),errs=[...new Set(inCombat.map(x=>x.turnKey))].map(k=>errByTurn.get(k)).filter(Number.isFinite);
   out[rule]={decisions:v.length,...extra(v),combat_decisions:inCombat.length,
    ...(inCombat.length?{...outcome(inCombat,fights),forecast_error_on_fired_turns:errs.length?{n:errs.length,mean:mean(errs),under_pct:pctOf(errs.filter(x=>x>0).length,errs.length)}:null,
     by_type:split(inCombat,'type',fights),by_act:split(inCombat,'act',fights),by_policy:split(inCombat,'policy',fights)}
     :{runs:[...new Set(v.map(x=>x.run))].length,runs_died:[...new Set(v.map(x=>x.run))].filter(r=>runs.get(r)==='died').length})};
  }
  return out;
 };
 const rules=summarize(firings,v=>({single_option:v.filter(x=>x.single).length,changed_pick:null,
  ...(v.some(x=>x.costly!=null)?{with_removed_forecasts:v.filter(x=>x.costly!=null).length,costly:v.filter(x=>x.costly).length}:{}),
  ...(v.some(x=>x.remembered!=null)?{remembered:v.filter(x=>x.remembered).length}:{})}));
 const reviewOut=summarize(reviews,v=>({changed_pick:v.filter(x=>x.changed).length,...reviewForecasts(v)}));
 for(const [k,v] of Object.entries(reviewOut)){
  const inCombat=reviews.filter(x=>x.rule===k&&x.combat);
  if(inCombat.length)Object.assign(v,{when_changed:outcome(inCombat.filter(x=>x.changed),fights),when_kept:outcome(inCombat.filter(x=>!x.changed),fights)});
 }
 const liftOut={};
 for(const l of lifts){const x=(liftOut[l.rule+': '+l.reason]??={entries:0,runs:new Set()});x.entries++;x.runs.add(l.run);}
 for(const x of Object.values(liftOut))x.runs=x.runs.size;
 const overrideOut={};
 for(const o of overrides){const x=(overrideOut[o.kind]??={decisions:0,gold_spent:0});x.decisions++;x.gold_spent+=o.price??0;}
 const byQuality=Object.fromEntries(Object.entries(Object.groupBy(forecast.filter(r=>!r.ends_fight),r=>r.quality)).sort().map(([k,v])=>[k,errorSummary(v)]));
 const byEncounter=Object.entries(Object.groupBy(forecast.filter(r=>!r.ends_fight),r=>`${r.type}: ${r.encounter}`))
  .map(([k,v])=>({encounter:k,...errorSummary(v)})).sort((a,b)=>b.n-a.n);
 const lethal=forecast.filter(r=>r.survives===false);
 return {
  scope:{since,run,runs:runs.size,executed:events.filter(e=>e.kind==='decision'&&e.outcome==='executed').length,fights:fights.size,
   first:events[0]?.time??null,last:events.at(-1)?.time??null},
  baseline:{all_combat_turns:baseline,...baselineBy},
  rules,reviews:reviewOut,
  // Present only in logs that record them (rule lifts and Jev answer overrides).
  ...(lifts.length?{lifts:Object.fromEntries(Object.entries(liftOut).sort())}:{}),
  ...(overrides.length?{overrides:overrideOut}:{}),
  forecast:{
   // Turns that closed a fight (mostly deaths, where the loss is the HP left) are reported apart.
   overall:errorSummary(forecast.filter(r=>!r.ends_fight)),fight_ending_turns:errorSummary(forecast.filter(r=>r.ends_fight)),
   by_quality:byQuality,by_encounter:byEncounter,
   forecast_death:{n:lethal.length,died:lethal.filter(r=>r.died).length},
   no_hp_forecast:events.filter(e=>e.kind==='decision'&&e.outcome==='executed'&&combat.has(e.type)&&e.action==='end_turn'&&!Number.isFinite(e.forecast?.hpLoss)).length,
   deaths_not_forecast:forecast.filter(r=>r.died&&r.survives!==false).length,
   // More lost than forecast matters most for the rules; less lost is usually an unmodeled heal or block.
   largest_under:misses(forecast.filter(r=>!r.ends_fight&&r.error>0).sort((a,b)=>b.error-a.error)),
   largest_over:misses(forecast.filter(r=>!r.ends_fight&&r.error<0).sort((a,b)=>a.error-b.error))},
 };
}

const pad=(s,n)=>String(s??'-').padEnd(n);
const lpad=(s,n)=>String(s??'-').padStart(n);
function outcomeCells(o){return o?`${lpad(o.turns,5)} ${lpad(o.turns_no_hp_lost_pct==null?'-':o.turns_no_hp_lost_pct+'%',5)} ${lpad(o.mean_hp_lost,6)} ${lpad(`${o.fights_won}/${o.fights_lost}/${o.fights_other}`,10)}`:'';}
export function report(a){
 const out=[],s=a.scope;
 out.push(`Rules audit: ${s.runs} runs, ${s.executed} executed decisions, ${s.fights} fights (${s.first?.slice(0,16)} to ${s.last?.slice(0,16)})`);
 out.push('Turns: distinct turns where it fired. No HP: share of those turns that lost no HP. HP: mean HP lost that turn (first observation to next turn).');
 out.push('Fights W/D/O: fights it fired in that were won / died in / other (abandoned or open). Single: left one option, played without asking Jev.');
 const head=`${pad('',22)} ${lpad('dec',5)} ${lpad('single',6)} ${lpad('turns',5)} ${lpad('noHP',5)} ${lpad('HP',6)} ${lpad('W/D/O',10)}  fc err`;
 out.push('','Combat rules',head);
 const b=a.baseline.all_combat_turns;
 out.push(`${pad('all combat turns',22)} ${lpad('',5)} ${lpad('',6)} ${outcomeCells(b)}`);
 const fc=r=>r.forecast_error_on_fired_turns?`  ${r.forecast_error_on_fired_turns.mean>0?'+':''}${r.forecast_error_on_fired_turns.mean} (n ${r.forecast_error_on_fired_turns.n})`:'';
 for(const [k,r] of Object.entries(a.rules).filter(([,r])=>r.combat_decisions))out.push(`${pad(k,22)} ${lpad(r.decisions,5)} ${lpad(r.single_option,6)} ${outcomeCells(r)}${fc(r)}`);
 out.push('','Screen, route and gold rules (outcome: runs it fired in / runs that died)');
 for(const [k,r] of Object.entries(a.rules).filter(([,r])=>!r.combat_decisions))out.push(`${pad(k,22)} ${lpad(r.decisions,5)} ${lpad(r.single_option,6)}  runs ${r.runs}, died ${r.runs_died}`);
 out.push('','Reviews (changed: Jev switched its pick on the second look; HP kept/changed: mean HP lost that turn)');
 for(const [k,r] of Object.entries(a.reviews))out.push(`${pad(k,22)} ${lpad(r.decisions,5)} changed ${lpad(r.changed_pick,4)}`+(r.combat_decisions?` ${outcomeCells(r)}  HP kept ${r.when_kept.mean_hp_lost} / changed ${r.when_changed.mean_hp_lost}${fc(r)}`:''));
 const withFc=Object.entries(a.reviews).filter(([,r])=>r.changed_with_forecasts?.n);
 if(withFc.length){
  out.push('','Changed picks with recorded forecasts: HP-loss forecast of the first pick against the final pick');
  for(const [k,r] of withFc){const x=r.changed_with_forecasts;out.push(`${pad(k,22)} n ${lpad(x.n,4)}  first ${lpad(x.initial_mean_hp_loss,5)}  final ${lpad(x.final_mean_hp_loss,5)}  lower ${x.lower}, same ${x.same}, higher ${x.higher}`);}
 }
 const costly=Object.entries(a.rules).filter(([,r])=>r.with_removed_forecasts);
 if(costly.length){
  out.push('','Removed options, where the rule recorded their IDs. Costly: a removed line was forecast to lose max(5, 6% max HP) less than the line played');
  for(const [k,r] of costly)out.push(`${pad(k,22)} ${lpad(r.with_removed_forecasts,5)} costly ${lpad(r.costly,4)}`);
 }
 for(const [k,r] of Object.entries(a.rules).filter(([,r])=>r.remembered!=null))out.push('',`${k}: ${r.remembered} of ${r.decisions} reused an answer from an earlier consult`);
 if(a.lifts){
  out.push('','Lifts: a rule stepped aside or would have removed every option (entries, runs)');
  for(const [k,x] of Object.entries(a.lifts))out.push(`${pad(k,40)} ${lpad(x.entries,5)} ${lpad(x.runs,4)}`);
 }
 if(a.overrides){
  out.push('','Overrides of Jev answers (decisions, gold of the chosen purchases)');
  for(const [k,x] of Object.entries(a.overrides))out.push(`${pad(k,22)} ${lpad(x.decisions,5)} ${lpad(x.gold_spent,6)}`);
 }
 for(const dim of ['type','act','policy']){
  out.push('',`By ${dim === 'type' ? 'fight type' : dim}: turns, no-HP share, mean HP, fights W/D/O`);
  const keys=Object.keys(a.baseline[dim]);
  const cell=o=>o?`${o.turns} ${o.turns_no_hp_lost_pct}% ${o.mean_hp_lost} ${o.fights_won}/${o.fights_lost}/${o.fights_other}`:'-';
  out.push(`${pad('all combat turns',22)} ${keys.map(k=>`${k}: ${cell(a.baseline[dim][k])}`).join(' | ')}`);
  for(const [k,r] of Object.entries({...a.rules,...a.reviews}).filter(([,r])=>r.combat_decisions))
   out.push(`${pad(k,22)} ${Object.entries(r['by_'+dim]).map(([v,o])=>`${v}: ${cell(o)}`).join(' | ')}`);
 }
 const f=a.forecast,line=(k,x)=>`${pad(k,34)} n ${lpad(x.n,5)}  mean ${lpad(x.mean_error,5)}  median ${lpad(x.median_error,3)}  p10 ${lpad(x.p10,4)}  p90 ${lpad(x.p90,4)}  |err| ${lpad(x.mean_abs_error,5)}  exact ${lpad(x.exact_pct,3)}%  under ${lpad(x.under_pct,3)}%  over ${lpad(x.over_pct,3)}%  off 5+ ${lpad(x.off_by_5_plus_pct,3)}%`;
 out.push('','Forecast check: end-turn decisions, error = HP actually lost by the next turn - forecast HP loss');
 out.push(line('all (turns that did not end the fight)',f.overall),line('turns that ended the fight',f.fight_ending_turns));
 for(const [k,x] of Object.entries(f.by_quality))out.push(line('quality '+k,x));
 out.push(`Forecast death on the chosen end turn: ${f.forecast_death.n}, died that turn ${f.forecast_death.died}. Deaths not forecast: ${f.deaths_not_forecast}. End turns without an HP forecast: ${f.no_hp_forecast}.`);
 out.push('','By encounter (8+ end turns)');
 for(const x of f.by_encounter.filter(x=>x.n>=8))out.push(line(x.encounter.slice(0,34),x));
 for(const [title,list] of [['Largest under-forecasts (more HP lost than forecast)',f.largest_under],['Largest over-forecasts',f.largest_over]]){
 out.push('',title);
 for(const m of list)out.push(`${m.run} a${m.act} f${m.floor} r${m.round} ${m.type} ${m.encounter}: forecast ${m.forecast} (${m.quality}), lost ${m.actual}${m.warnings?.length?`; ${m.warnings.join('; ')}`:''}`);
 }
 return out.join('\n');
}

export async function readLogs(dir){
 const events=[];
 for(const f of (await readdir(dir)).filter(f=>f.endsWith('.jsonl')).sort())
  // Streamed: the log passes the ~512 MB string limit. Only decisions and run ends are read.
  for await(const line of createInterface({input:createReadStream(resolve(dir,f))})){
   if(!line.includes('"kind":"decision"')&&!line.includes('"kind":"run_end"'))continue;
   const e=slim(JSON.parse(line));if(e)events.push(e);
  }
 return events;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const dir=resolve(process.env.STS2_PRIVATE_DIR??resolve(root,'.private/sts2'),'runs');
 const arg=k=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:null;
 const result=audit(await readLogs(dir),{since:arg('--since'),run:arg('--run')});
 console.log(process.argv.includes('--json')?JSON.stringify(result,null,1):report(result));
}
