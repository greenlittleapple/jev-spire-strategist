// Strategist inputs the strategist agents reported missing or wrong: stale requests from another run,
// relics gained before an owned screen, gold still unclaimed on a rewards screen, shop item types,
// card enchantments and afflictions, and names defined by an event option.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {requestStamp,stampPlan,strategistBrief,eventNote,cardModifiers} from './strategy.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from './hierarchical.mjs';
import {fileChannel} from './strategy-channel.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const run=(floor=5,live_id='run-1')=>({live_id,act:1,floor,ascension:0});
const burning={id:'BURNING_BLOOD',name:'Burning Blood',description:'At the end of combat, heal 6 HP.'};
const anchor={id:'ANCHOR',name:'Anchor',description:'Start each combat with 10 Block.'};
const player=(extra={})=>({character:'Ironclad',hp:60,max_hp:80,gold:160,max_energy:3,potions:[],max_potion_slots:3,status:[],relics:[burning],
 deck:[{name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',keywords:[]}],...extra});
const plan=(extra={})=>({archetype:'x',summary:'x',priorities:[],combat:{risk_tolerance:'low',potion_policy:'x',focus:'x',hallway_potion_below_hp_percent:100,potion_reserve:0},
 fight:{plan:'',target_priority:[]},card_reward:{desired:[],avoid:[],skip_when:''},shop:{gold_reserve:0,priorities:[]},route:'x',route_path:[],elite_min_hp_percent:0,
 rest:'x',replan_below_hp_percent:25,allowed_option_ids:[],option_note:'',...extra});
const withDir=async fn=>{const dir=await mkdtemp(join(tmpdir(),'jev-inputs-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const cli=(dir,env,...args)=>promisify(execFile)(process.execPath,[resolve(here,'strategy-cli.mjs'),...args],{env:{...process.env,STRATEGY_DIR:dir,...env}});

test('wait and show archive a request for a run the runner is no longer on',()=>withDir(async dir=>{
 const channel=fileChannel(dir),session=join(dir,'session.json'),env={STRATEGY_SESSION_FILE:session};
 const old={state_type:'event',run:run(1,'run-old'),player:player()};
 const stale=await channel.post({key:'k',brief:{},stamp:requestStamp(old,[],'run_start')});
 // A snapshot written before the request may predate a new run: the request is not archived on it.
 await writeFile(session,JSON.stringify({runId:'run-new'}));
 const before=new Date(Date.parse(stale.createdAt)-60000);await utimes(session,before,before);
 const shown=await cli(dir,env,'show');
 assert.match(shown.stdout,new RegExp(stale.id));
 // A snapshot written after it, naming another run: show archives the request and reports nothing pending.
 await writeFile(session,JSON.stringify({runId:'run-new'}));
 const after=await cli(dir,env,'show');
 assert.equal(after.stdout.trim(),'No strategy request is pending.');
 assert.match(after.stderr,new RegExp(`Archived request ${stale.id} \\(run_start\\) for run run-old: the runner is on run run-new\\.`));
 assert.equal(await channel.current(),null);
 assert.ok((await readdir(dir)).includes(`request.stale-${stale.id.slice(0,8)}.json`));
 // wait skips it the same way and returns the current run's request.
 const again=await channel.post({key:'k2',brief:{},stamp:requestStamp(old,[],'run_start')});
 await writeFile(session,JSON.stringify({runId:'run-new'}));
 const waiting=cli(dir,env,'wait');
 await new Promise(r=>setTimeout(r,300));
 const current=await channel.post({key:'k3',brief:{},stamp:requestStamp({...old,run:run(1,'run-new')},[],'run_start')});
 assert.match((await waiting).stdout,new RegExp(`Strategy request ${current.id} \\(run_start`));
 assert.notEqual(again.id,current.id);
 // The same run, or no readable snapshot: the request stands.
 assert.match((await cli(dir,env,'show')).stdout,new RegExp(current.id));
 assert.match((await cli(dir,{STRATEGY_SESSION_FILE:join(dir,'missing.json')},'show')).stdout,new RegExp(current.id));
}));

test('the runner archives a pending request for another run, with its answer',()=>withDir(async dir=>{
 const channel=fileChannel(dir);
 const request=await channel.post({key:'k',brief:{},stamp:requestStamp({state_type:'event',run:run(1,'run-old'),player:player()},[],'run_start')});
 await channel.answer(request.id,plan());
 assert.equal(await channel.archiveOtherRun('run-old'),null,'same run: kept');
 const archived=await channel.archiveOtherRun('run-new');
 assert.equal(archived.id,request.id);assert.equal(archived.archivedAs,`request.stale-${request.id.slice(0,8)}.json`);
 assert.equal(await channel.current(),null);assert.equal(await channel.pendingAnswer(),null);
 assert.equal(await channel.archiveOtherRun('run-new'),null,'nothing left');
}));

test('the brief lists relics gained since the plan was written as new_relics',()=>{
 const state=r=>({state_type:'card_reward',run:run(8),player:player({relics:r})});
 const written=stampPlan(plan(),requestStamp(state([burning]),[],'owned_screen'));
 assert.deepEqual(written.relic_ids,['BURNING_BLOOD']);
 assert.deepEqual(strategistBrief(state([burning,anchor]),[],'owned_screen',written).new_relics,[{name:'Anchor',description:anchor.description}]);
 assert.equal(strategistBrief(state([burning]),[],'owned_screen',written).new_relics,undefined);
 assert.equal(strategistBrief(state([burning,anchor]),[],'run_start',null).new_relics,undefined,'no plan yet');
});

test('gold still unclaimed on the rewards screen is in the brief, on it and on the card reward it opens',()=>{
 const items=[{index:0,type:'gold',description:'62 Gold',gold_amount:62},{index:1,type:'card',description:'Add a card to your deck.'}];
 const rewards={state_type:'rewards',run:run(7),player:player(),rewards:{items,can_proceed:true}};
 assert.equal(strategistBrief(rewards,decisionCandidates(rewards),'owned_screen',null).player.gold_unclaimed,62);
 const card={state_type:'card_reward',run:run(7),player:player(),card_reward:{cards:[],can_skip:true}};
 assert.equal(strategistBrief(card,[],'owned_screen',null,{goldUnclaimed:62}).player.gold_unclaimed,62);
 assert.equal(strategistBrief(card,[],'owned_screen',null,{goldUnclaimed:0}).player.gold_unclaimed,undefined);
 assert.equal(strategistBrief({...rewards,rewards:{items:[items[1]]}},[],'owned_screen',null).player.gold_unclaimed,undefined);
});

test('shop options carry their item type, and potions the free potion slots',()=>{
 const state={state_type:'shop',run:run(),player:player({gold:200,potions:[{name:'Fire Potion'},{name:'Block Potion'}]}),shop:{items:[
  {index:0,category:'card',price:70,is_stocked:true,can_afford:true,card_name:'Stomp',card_type:'Attack',card_description:'Deal 12 damage to ALL enemies.',keywords:[]},
  {index:1,category:'relic',price:150,is_stocked:true,can_afford:true,relic_name:'Anchor',relic_description:anchor.description},
  {index:2,category:'potion',price:78,is_stocked:true,can_afford:true,potion_name:'Fysh Oil',potion_description:'Gain 1 Strength and 1 Dexterity.'},
  {index:3,category:'card_removal',price:75,is_stocked:true,can_afford:true}]}};
 const options=strategistBrief(state,decisionCandidates(state),'owned_screen',null).current_options;
 assert.deepEqual(options.map(o=>[o.label,o.item_type,o.free_potion_slots]),[
  ['Stomp — 70 gold','card',undefined],['Anchor — 150 gold','relic',undefined],['Fysh Oil — 78 gold','potion',1],['Remove a card — 75 gold','removal',undefined],
  ['Continue to the map',undefined,undefined]]);
});

test('a card shows its enchantment or affliction with the description',()=>{
 // Logged bridge cards: the enchantment is a keyword the card text does not name.
 const bomb={id:'THE_BOMB',name:'The Bomb',type:'Skill',cost:'2',description:'At the end of 3 turns, deal 40 damage to ALL enemies.',is_upgraded:false,
  keywords:[{name:'Imbued',description:'This card is played automatically at the start of each combat.'}]};
 const bash={name:'Bash',type:'Attack',cost:'2',description:'Deal 8 damage. Apply 2 Vulnerable.',keywords:[{name:'Vulnerable',description:'x'},{name:'Sharp',description:'Deal 2 additional damage.'}]};
 const hexed={name:'Strike',type:'Attack',cost:'1',description:'Deal 6 damage.',keywords:[{name:'Hexed',description:'Ethereal while the Hex lives.'},{name:'Exhaust',description:'x'}]};
 assert.deepEqual(cardModifiers(bomb),['Imbued: This card is played automatically at the start of each combat.']);
 assert.deepEqual(cardModifiers(bash),['Sharp: Deal 2 additional damage.']);
 assert.deepEqual(cardModifiers(hexed),['Hexed: Ethereal while the Hex lives.']);
 assert.equal(cardModifiers({name:'Primal Force+',description:'Transform all Attacks into Giant Rock+.',keywords:[{name:'Giant Rock+',description:'x'}]}),null);
 const deck=[bomb,{...bomb,keywords:[]},bash];
 const brief=strategistBrief({state_type:'card_select',run:run(),player:player({deck}),card_select:{prompt:'Choose a card.',cards:[]}},[
  {id:'a0',label:'The Bomb',command:{action:'select_card',index:0},details:{...bomb,index:0}}],'owned_screen',null);
 assert.deepEqual(brief.deck.filter(c=>c.name==='The Bomb').map(c=>[c.count,c.modifiers?.length??0]),[[1,1],[1,0]],'an enchanted copy is its own row');
 assert.deepEqual(brief.current_options[0].modifiers,['Imbued: This card is played automatically at the start of each combat.']);
 assert.equal(brief.selection_prompt,'Choose a card.');
});

// Symbiote: "Enchant an Attack with Corrupted." opens a card selection on the same floor whose brief had
// neither the event nor a definition of Corrupted.
const symbiote={state_type:'event',run:run(38),player:player(),event:{event_id:'SYMBIOTE',event_name:'Symbiote',body:'A dark polyp.',options:[
 {index:0,title:'Approach',description:'Enchant an Attack with Corrupted.',is_locked:false,keywords:[{name:'Corrupted',description:'Deal 50% more damage, but lose 2 HP.'}]},
 {index:1,title:'Kill with Fire',description:'Choose a card to Transform.',is_locked:false,keywords:[{name:'Transform',description:'Transformed cards become a random card of any rarity.'}]}]}};
const select={state_type:'card_select',run:run(38),player:player({deck:[{name:'Strike',cost:'1',type:'Attack',description:'Deal 6 damage.',keywords:[]},{name:'Bash',cost:'2',type:'Attack',description:'Deal 8 damage.',keywords:[]}]}),
 card_select:{screen_type:'choose',prompt:'Choose a card.',cards:[{index:0,name:'Strike',type:'Attack',cost:'1',description:'Deal 6 damage.',keywords:[]},
  {index:1,name:'Bash',type:'Attack',cost:'2',description:'Deal 8 damage.',keywords:[]}],can_skip:false}};

test('event option keywords are defined, locked options included, and carried to the screen the option opens',()=>{
 const candidates=decisionCandidates(symbiote);
 // A locked option is not offered, but its keywords are still defined.
 const locked={...symbiote,event:{...symbiote.event,options:symbiote.event.options.map(o=>o.index===1?{...o,is_locked:true}:o)}};
 assert.deepEqual(decisionCandidates(locked).map(c=>c.label),['Approach']);
 assert.equal(strategistBrief(locked,decisionCandidates(locked),'owned_screen',null).keywords.Transform,'Transformed cards become a random card of any rarity.');
 const note=eventNote(symbiote,candidates[0]);
 assert.deepEqual(note,{run_id:'run-1',floor:38,name:'Symbiote',option:'Approach: Enchant an Attack with Corrupted.',
  keywords:{Corrupted:'Deal 50% more damage, but lose 2 HP.',Transform:'Transformed cards become a random card of any rarity.'}});
 const brief=strategistBrief(select,decisionCandidates(select),'owned_screen',null,{lastEvent:note});
 assert.deepEqual(brief.from_event,{name:'Symbiote',option:'Approach: Enchant an Attack with Corrupted.'});
 assert.equal(brief.keywords.Corrupted,'Deal 50% more damage, but lose 2 HP.');
});

test('the runner carries the event option taken to the next request on that floor only',async()=>withDir(async dir=>{
 const channel=fileChannel(dir),status=newStrategyStatus({enabled:true,waitMs:5000});
 status.plan=stampPlan(plan(),requestStamp({...symbiote,state_type:'map'},[],'route_plan'));
 const answers=[];
 const deadline=Date.now()+10000;
 const answering=(async()=>{for(let n=0;n<2&&Date.now()<deadline;){const r=await channel.pending();if(r){answers.push(r);await channel.answer(r.id,plan({allowed_option_ids:[r.brief.current_options[0].id]}));n++;}await new Promise(x=>setTimeout(x,30));}})();
 const ask=()=>assert.fail('owned screens need no Jev call');
 const first=await hierarchicalDeliberate({state:symbiote,candidates:decisionCandidates(symbiote),strategist:{channel,status},ask});
 assert.equal(first.answers.move.choice,'a0');
 assert.equal(status.lastEvent.option,'Approach: Enchant an Attack with Corrupted.');
 await hierarchicalDeliberate({state:select,candidates:decisionCandidates(select),strategist:{channel,status},ask});
 await answering;
 assert.equal(answers[1].brief.from_event.name,'Symbiote');
 assert.equal(answers[1].brief.keywords.Corrupted,'Deal 50% more damage, but lose 2 HP.');
 // Another floor: nothing carried.
 const later={...select,run:run(39)};
 assert.equal(strategistBrief(later,[],'owned_screen',null).from_event,undefined);
}));
