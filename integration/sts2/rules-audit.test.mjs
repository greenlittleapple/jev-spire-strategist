import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {audit,slim,reviewKind,buildFights} from './rules-audit.mjs';

let clock=0;
const time=()=>new Date(Date.UTC(2026,8,30,0,0,clock++)).toISOString();
const state=(type,{floor=3,round=1,hp=50,run='r1'}={})=>({state_type:type,run:{live_id:run,act:1,floor},
 player:{hp,max_hp:80},...(['monster','elite','boss','hand_select'].includes(type)?{battle:{round,enemies:[{name:'Nibbit',hp:20}]}}:{})});
const decision=(s,{action='play_card',forecast=null,constraint=null,options=4,deliberation=null,source='jev'}={})=>({kind:'decision',time:time(),outcome:'executed',
 policy:'claude-strategy-v3',decisionSource:source,state:s,strategyConstraint:constraint,deliberation,candidates:Array(options).fill({}),
 chosen:{command:{action},label:action,forecast}});

test('reviews are classified from the prompt or the older flags',()=>{
 assert.equal(reviewKind({reviewReason:'Dangerous turn: ending now loses 20 HP'}),'danger');
 assert.equal(reviewKind({reviewReason:'This prefix has a forecast marked lethal. Check'}),'lethal_forecast');
 assert.equal(reviewKind({reviewReason:'Leaving the shop with 120 gold'}),'shop');
 assert.equal(reviewKind({endTurnReviewed:true}),'end_turn');
 assert.equal(reviewKind(null),null);
});

test('turn HP loss runs to the next round; the last turn of a won fight ignores the post-fight heal',()=>{
 const events=[
  decision(state('monster',{round:1,hp:50})),decision(state('monster',{round:1,hp:48}),{action:'end_turn'}),
  decision(state('monster',{round:2,hp:41})),decision(state('monster',{round:2,hp:41}),{action:'end_turn'}),
  decision(state('monster',{round:3,hp:35})),
  decision(state('rewards',{hp:41}),{action:'proceed'})].map(slim);
 const f=buildFights(events).get('r1:1:3');
 assert.equal(f.result,'won');
 assert.deepEqual([...f.turns.values()].map(t=>[t.round,t.lost,t.ends_fight]),[[1,9,false],[2,6,false],[3,0,true]]);
});

test('rule firings count removed options, single options and what followed; reviews count changed picks',()=>{
 const two={kind:'combat',rules:[{kind:'hallway_potion',removed:2},{kind:'block_not_needed',removed:1}],removed:3};
 const events=[
  decision(state('monster',{round:1,hp:50}),{constraint:two,options:4,source:'claude'}),
  decision(state('monster',{round:1,hp:50}),{action:'end_turn',forecast:{hpLoss:4,quality:'partial',survives:true},
   deliberation:{reviewReason:'Dangerous turn: ending now loses 30 HP',changed:true}}),
  decision(state('monster',{round:2,hp:44}),{constraint:{kind:'combat',rules:[{kind:'hallway_potion',removed:1}],removed:1}}),
  decision(state('monster',{round:2,hp:44}),{action:'end_turn',forecast:{hpLoss:30,quality:'partial',survives:false}}),
  {kind:'run_end',time:time(),state:{...state('game_over',{hp:0}),battle:undefined}},
  decision(state('map',{run:'r2',floor:1}),{action:'choose_map_node',constraint:{kind:'route',removed:2},options:3,source:'claude'})].map(slim);
 const a=audit(events);
 const hp=a.rules.hallway_potion;
 assert.deepEqual([hp.decisions,hp.single_option,hp.turns,hp.mean_hp_lost,hp.fights_lost,hp.changed_pick],[2,0,2,25,1,null]);
 assert.equal(a.rules.block_not_needed.single_option,1);
 assert.deepEqual([a.rules.route.decisions,a.rules.route.single_option,a.rules.route.runs],[1,1,1]);
 const d=a.reviews['review:danger'];
 assert.deepEqual([d.decisions,d.changed_pick,d.when_changed.mean_hp_lost],[1,1,6]);
 // Round 1 lost 6 against 4 forecast; round 2 died with 44 HP against 30 forecast (capped at HP held, so 30).
 assert.deepEqual([a.forecast.overall.n,a.forecast.overall.mean_error],[1,2]);
 assert.deepEqual([a.forecast.fight_ending_turns.n,a.forecast.fight_ending_turns.mean_error],[1,14]);
 assert.deepEqual(a.forecast.forecast_death,{n:1,died:1});
 assert.equal(a.forecast.largest_under[0].actual,6);
 assert.equal(audit(events,{run:'r2'}).scope.runs,1);
});

test('the CLI reads logs from STS2_PRIVATE_DIR',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sts2-audit-'));
 try{
  await mkdir(join(dir,'runs'));
  const lines=[decision(state('monster',{round:1,hp:50}),{action:'end_turn',forecast:{hpLoss:3,quality:'calculated',survives:true}}),
   decision(state('monster',{round:2,hp:47}))].map(e=>JSON.stringify(e));
  await writeFile(join(dir,'runs','log.jsonl'),lines.join('\n')+'\n');
  const script=join(dirname(fileURLToPath(import.meta.url)),'rules-audit.mjs');
  const out=JSON.parse(execFileSync(process.execPath,[script,'--json'],{env:{...process.env,STS2_PRIVATE_DIR:dir},encoding:'utf8'}));
  assert.deepEqual([out.forecast.overall.n,out.forecast.overall.exact_pct],[1,100]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a run that reaches The Architect counts as won although it ends at 0 HP',()=>{
 const events=[decision({...state('map',{run:'r3'})},{action:'choose_map_node',constraint:{kind:'route',removed:1},options:2}),
  decision({...state('event',{run:'r3',floor:48}),event:{event_id:'THE_ARCHITECT'}},{action:'proceed'}),
  {kind:'run_end',time:time(),state:state('game_over',{run:'r3',floor:48,hp:0})}].map(slim);
 assert.deepEqual([audit(events).rules.route.runs,audit(events).rules.route.runs_died],[1,0]);
});
