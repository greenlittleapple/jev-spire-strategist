import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scoreRuns,nearTie} from './scorecard.mjs';

const state=(floor,type,extra={})=>({state_type:type,run:{live_id:'r1',act:1,floor,ascension:0},
 player:{character:'Ironclad',hp:60,max_hp:80,gold:200,relics:[{},{}],potions:[{}]},saved_run:{modifiers:floor===1?[]:[{id:'MODIFIER.X'}]},...extra});
const decision=(s,label,action='x',usage=100)=>({kind:'decision',outcome:'executed',time:'t',state:s,policy:'jev-compact-v1',
 chosen:{label,command:{action}},usage:{input_tokens:usage},deliberation:{request_usage:[{input_tokens:usage}]}});
const boss=(round,hp)=>state(17,'boss',{battle:{round,enemies:[{name:'Boss',hp,max_hp:200},{name:'Add',hp:10,max_hp:20}]}});

test('scorecard reports boss progress, elite choices, hallway potions and a non-empty modifier',()=>{
 const map=state(5,'map',{map:{next_options:[{type:'Elite'},{type:'Monster'}]}});
 const [s]=scoreRuns([
  decision(state(1,'event'),'Start'),
  decision(state(3,'monster'),'Potion',"use_potion"),
  decision(map,'Travel to Monster'),
  decision(boss(1,200),'Strike'),decision(boss(4,50),'Strike'),
  {kind:'run_end',time:'t',state:{...boss(4,50),state_type:'game_over',player:{hp:0,relics:[],gold:9}}}]);
 assert.equal(s.modifiers,'X');assert.equal(s.result,'lost');
 assert.deepEqual(s.bosses.map(b=>[b.name,b.hp_removed_pct,b.killed,b.rounds]),[['Boss',75,false,4]]);
 assert.equal(s.elite_choices_offered,1);assert.equal(s.elite_choices_taken,0);
 assert.equal(s.potions_used_outside_elites_bosses,1);assert.equal(s.input_tokens,500);
});

test('a boss counts as killed when the run reaches a later floor',()=>{
 const [s]=scoreRuns([decision(boss(3,120),'Strike'),decision(state(18,'event'),'Go')]);
 assert.equal(s.bosses[0].killed,true);assert.equal(s.bosses[0].hp_removed_pct,100);
});

test('a run that reaches The Architect after the final boss is a win although it ends at 0 HP',()=>{
 const end={kind:'run_end',time:'t',state:{...state(48,'game_over'),player:{hp:0,relics:[],gold:9}}};
 const [won]=scoreRuns([decision(state(48,'rewards'),'Continue'),decision(state(48,'event',{event:{event_id:'THE_ARCHITECT'}}),'Proceed'),end]);
 assert.equal(won.result,'won');
 const [lost]=scoreRuns([decision(state(48,'boss',{battle:{round:3,enemies:[{name:'Boss',hp:50,max_hp:200}]}}),'Strike'),end]);
 assert.equal(lost.result,'lost');
});

test('near ties count Jev answers whose top two probabilities are under 0.10 apart, split combat and other',()=>{
 const asked=(s,probabilities,source='jev')=>({...decision(s,'x'),decisionSource:source,answer:{probabilities}});
 const [s]=scoreRuns([
  asked(state(3,'monster'),{a:0.5,b:0.45}),asked(state(3,'monster'),{a:0.7,b:0.2}),
  asked(state(4,'map'),{a:0.52,b:0.48,c:0}),asked(state(4,'map'),{a:1}),
  asked(state(5,'monster'),{},'forced')]);
 assert.equal(nearTie({probabilities:{a:0.5,b:0.41}}),true);assert.equal(nearTie({probabilities:{a:1}}),null);
 assert.deepEqual(s.near_ties,{all:{decisions:3,near_ties:2,share:0.67},combat:{decisions:2,near_ties:1,share:0.5},other:{decisions:1,near_ties:1,share:1}});
 assert.equal(s.strategist,null);
});

test('strategist requests date from the decision that posted them and answers from plan adoption',()=>{
 const d=(t,latencyMs)=>({...decision(state(2,'event'),'Go'),time:t,latencyMs});
 const [s]=scoreRuns([
  {kind:'strategy_request',time:'2026-09-30T00:00:09.000Z',request_id:'q1'},
  {kind:'strategy_adopted',time:'2026-09-30T00:00:09.000Z',request_id:'q1',plan:{run_id:'r1',createdAt:'2026-09-30T00:00:08.000Z'}},
  d('2026-09-30T00:00:10.000Z',10000),
  {kind:'strategy_request',time:'2026-09-30T00:01:00.000Z',request_id:'q2'},
  d('2026-09-30T00:01:00.000Z',4000),
  {kind:'strategy_adopted',time:'2026-09-30T00:01:30.000Z',request_id:'q2',plan:{run_id:'r1',createdAt:'2026-09-30T00:01:20.000Z'}},
  d('2026-09-30T00:01:31.000Z',11000)]);
 // q1: 8 s after its decision started; q2 (answered during a later decision): 24 s.
 assert.deepEqual(s.strategist,{requests:2,answers:2,median_answer_s:16});
});

test('the CLI reads logs from STS2_PRIVATE_DIR',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sts2-score-'));
 try{
  await mkdir(join(dir,'runs'));
  const lines=[1,2,3,4,5].map(f=>JSON.stringify({...decision(state(f,'event'),'Go'),decisionSource:'jev',answer:{probabilities:{a:0.5,b:0.45}}}));
  await writeFile(join(dir,'runs','log.jsonl'),lines.join('\n')+'\n');
  const script=join(dirname(fileURLToPath(import.meta.url)),'scorecard.mjs');
  const [row]=JSON.parse(execFileSync(process.execPath,[script,'--json'],{env:{...process.env,STS2_PRIVATE_DIR:dir,SPIRE_LOG_DIR:''},encoding:'utf8'}));
  assert.equal(row.moves,5);assert.equal(row.near_ties.all.share,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
