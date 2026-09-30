// Every JSON example in docs/STS2-STRATEGIST.md is answered through the strategy CLI on a matching
// request, so the examples pass the same schema and request checks a live answer does.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {PLAN_SCHEMA,TARGET_SELECTORS,validatePlan,requestStamp,isOwnedScreen} from './strategy.mjs';
import {mapNodeKeys,distinctRoutes} from './route-facts.mjs';
import {fileChannel} from './strategy-channel.mjs';

const here=dirname(fileURLToPath(import.meta.url));
// CI checks the repository out on Windows with CRLF line endings; parse the doc as LF.
const doc=(await readFile(resolve(here,'../../docs/STS2-STRATEGIST.md'),'utf8')).replace(/\r\n/g,'\n');
// Each example is a ```json block directly after <!-- example: name -->.
const blocks=[...doc.matchAll(/```json\n([\s\S]*?)\n```/g)];
const examples=Object.fromEntries([...doc.matchAll(/<!-- example: ([a-z_]+) -->\n```json\n([\s\S]*?)\n```/g)].map(m=>[m[1],JSON.parse(m[2])]));

const run=(floor,act=1)=>({live_id:'run-doc',act,floor,ascension:0});
const player=(extra={})=>({character:'Ironclad',hp:80,max_hp:80,gold:99,max_energy:3,max_potion_slots:3,potions:[],status:[],
 relics:[{id:'BURNING_BLOOD',name:'Burning Blood',description:'At the end of combat, heal 6 HP.'}],
 deck:[{name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.'},{name:'Defend',cost:'1',type:'Skill',description:'Gain 5 Block.'}],...extra});

// Act 1 map: columns 0-3, rows 1-15, boss at 1,16. The doc's route takes these rooms by row.
const pathRooms={1:'Monster',2:'Unknown',3:'Monster',4:'Shop',5:'Elite',6:'RestSite',7:'Unknown',8:'Monster',9:'Treasure',10:'RestSite',
 11:'Elite',12:'Unknown',13:'Monster',14:'Monster',15:'RestSite'};
const route=['1,1','1,2','2,3','2,4','1,5','1,6','2,7','2,8','1,9','1,10','2,11','2,12','1,13','1,14','1,15'];
const map=(()=>{
 const nodes=[{col:1,row:0,type:'Ancient',children:[[0,1],[1,1],[2,1]]},{col:1,row:16,type:'Boss',children:[]}];
 for(let row=1;row<=15;row++)for(let col=0;col<=3;col++){
  const onPath=route.includes(`${col},${row}`);
  const children=row===15?[[1,16]]:[col-1,col,col+1].filter(c=>c>=0&&c<=3).map(c=>[c,row+1]);
  nodes.push({col,row,type:onPath?pathRooms[row]:'Monster',children});
 }
 return {current_position:{col:1,row:0,type:'Ancient'},boss:{col:1,row:16,name:'Boss'},nodes,
  next_options:[0,1,2].map((col,index)=>({index,col,row:1,type:'Monster'}))};
})();
const roomCode={Monster:'M',Unknown:'?',Shop:'$',Elite:'E',RestSite:'R',Treasure:'T'};

// The screens the examples answer; each gives the state and the stamp's map node IDs.
const requests={
 run_start:()=>({reason:'run_start',state:{state_type:'event',run:run(1),player:player(),
  event:{event_name:'Neow',is_ancient:true,in_dialogue:false,options:[
   {index:0,title:'Scroll Boxes',description:'Choose 1 of 2 packs of cards to add to your Deck.',is_locked:false},
   {index:1,title:'New Leaf',description:'Transform 1 card.',is_locked:false},
   {index:2,title:"Neow's Bones",description:'Gain 2 random Neow Relics. Add 1 random Curse to your Deck.',is_locked:false}]}}}),
 route_plan:()=>({reason:'route_plan',state:{state_type:'map',run:run(1),player:player(),map},routeNodes:mapNodeKeys(map)}),
 shop:()=>({reason:'owned_screen',state:{state_type:'shop',run:run(5),player:player({gold:170}),map:{...map,current_position:{col:2,row:4,type:'Shop'}},
  shop:{items:[
   {index:0,category:'card',price:78,is_stocked:true,can_afford:true,card_name:'Hemokinesis',card_description:'Lose 2 HP. Deal 15 damage.'},
   {index:1,category:'card',price:78,is_stocked:true,can_afford:true,card_name:'Stomp',card_description:'Deal 12 damage to ALL enemies.'},
   {index:2,category:'relic',price:164,is_stocked:true,can_afford:true,relic_name:'Red Skull',relic_description:'While your HP is at or below 50%, you have 3 additional Strength.'},
   {index:3,category:'card_removal',price:75,is_stocked:true,can_afford:true},
   {index:4,category:'potion',price:50,is_stocked:true,can_afford:true,potion_name:'Fire Potion',potion_description:'Deal 20 damage to target enemy.'}]}},
  routeNodes:mapNodeKeys(map)}),
 elite_start:()=>({reason:'elite_start',state:{state_type:'elite',run:run(22,2),player:player({hp:58,energy:3,block:0,
  hand:[{index:0,name:'Thunderclap',cost:'1',type:'Attack',description:'Deal 4 damage and apply 1 Vulnerable to ALL enemies.',can_play:true,target_type:'AllEnemies'},
   {index:1,name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',can_play:true,target_type:'AnyEnemy'}]}),
  battle:{round:1,turn:'player',is_play_phase:true,enemies:[
   {entity_id:'e1',name:'Flail Knight',hp:62,max_hp:62,block:0,status:[],intents:[{type:'Attack',label:'2x6',description:'Attack.'}]},
   {entity_id:'e2',name:'Magi Knight',hp:48,max_hp:48,block:0,status:[{name:'Dampen',description:'While this lives, your cards lose their upgrades.'}],intents:[]},
   {entity_id:'e3',name:'Spectral Knight',hp:44,max_hp:44,block:0,status:[{name:'Hex',description:'While this lives, your cards are Ethereal.'}],intents:[]}]}}}),
};

async function answer(name,plan) {
 const dir=await mkdtemp(join(tmpdir(),'jev-strategist-doc-'));
 try{
  const {reason,state,routeNodes=[]}=requests[name]();
  const candidates=['monster','elite','boss'].includes(state.state_type)?[]:decisionCandidates(state);
  const request=await fileChannel(dir).post({key:name,brief:{},stamp:requestStamp(state,candidates,reason,routeNodes)});
  const file=join(dir,'plan.json');
  await writeFile(file,JSON.stringify(plan));
  const {stdout}=await promisify(execFile)(process.execPath,[resolve(here,'strategy-cli.mjs'),'answer',request.id,file],{env:{...process.env,STRATEGY_DIR:dir}});
  return {stdout,state,candidates};
 }finally{await rm(dir,{recursive:true,force:true});}
}

test('the strategist doc labels every JSON example and has the four kinds',()=>{
 assert.equal(Object.keys(examples).length,blocks.length,'every ```json block is labelled <!-- example: name -->');
 assert.deepEqual(Object.keys(examples).sort(),Object.keys(requests).sort());
});

test('the strategist doc describes every plan field',()=>{
 // First cells of the field table: "`card_reward.desired`, `avoid`, `skip_when`" names three fields.
 const table=doc.slice(doc.indexOf('### Fields and how code uses them'),doc.indexOf('### Combat rules'));
 const described=new Set();
 for(const line of table.split('\n').filter(l=>l.startsWith('| `'))){
  let prefix='';
  for(const [,name] of line.split('|')[1].matchAll(/`([a-z_.]+)`/g)){
   if(name.includes('.'))prefix=name.slice(0,name.indexOf('.')+1);
   described.add(name.includes('.')?name:prefix+name);
  }
 }
 const fields=Object.entries(PLAN_SCHEMA.properties).flatMap(([k,v])=>v.type==='object'?Object.keys(v.properties).map(p=>`${k}.${p}`):[k]);
 for(const f of fields)assert.ok(described.has(f),`${f} is not in the field table`);
});

test('the strategist doc shows the one-line answer failures the CLI prints',()=>{
 const table=doc.slice(doc.indexOf('What `answer` prints'),doc.indexOf('## Request reasons'));
 for(const text of ['No strategy request is pending.','was replaced by <new id>; read it with "show" and answer that one.','is not valid JSON:','Cannot read <file>:'])
  assert.ok(table.includes(text),text);
 assert.doesNotMatch(table,/stack|SyntaxError/);
});

for(const name of Object.keys(requests))test(`strategist doc example ${name} passes the schema and the CLI's request checks`,async()=>{
 const plan=examples[name];
 assert.ok(plan,`example ${name} is missing`);
 assert.deepEqual(validatePlan(plan),[]);
 const {stdout,state,candidates}=await answer(name,plan);
 assert.match(stdout,/Delivered plan/);
 if(isOwnedScreen(state))assert.ok(plan.allowed_option_ids.length,'an owned screen answer lists its options');
 else assert.deepEqual(plan.allowed_option_ids,[]);
 // The option IDs the doc gives for the example's screen are the ones the runner builds.
 const labels={run_start:['Scroll Boxes','New Leaf',"Neow's Bones"],
  shop:['Hemokinesis — 78 gold','Stomp — 78 gold','Red Skull — 164 gold','Remove a card — 75 gold','Fire Potion — 50 gold','Continue to the map']}[name];
 if(labels)assert.deepEqual(candidates.map(c=>c.label),labels);
 // Fight plans name living enemies or selectors, and play_first names cards in the hand.
 for(const t of plan.fight.target_priority)assert.ok(TARGET_SELECTORS.includes(t)||state.battle?.enemies.some(e=>e.name.toLowerCase().includes(t.toLowerCase())),t);
 for(const c of plan.fight.play_first??[])assert.ok(state.player.hand?.some(h=>h.name===c.replace(/\+$/,'')),c);
});

test('the route example follows map edges and has the rooms the doc describes',()=>{
 const path=examples.route_plan.route_path,byKey=new Map(map.nodes.map(n=>[`${n.col},${n.row}`,n]));
 let at='1,0';
 for(const key of path){assert.ok(byKey.get(at).children.some(([c,r])=>`${c},${r}`===key),`${at} -> ${key}`);at=key;}
 const rooms=path.map(k=>roomCode[byKey.get(k).type]).join('');
 assert.ok(doc.includes('`'+rooms+'`'),`doc names the rooms ${rooms}`);
 assert.ok(distinctRoutes(map,map.current_position).routes.length>0);
 // The shop answer continues the same route from the node after the shop.
 assert.deepEqual(examples.shop.route_path,path.slice(path.indexOf('2,4')+1));
});
