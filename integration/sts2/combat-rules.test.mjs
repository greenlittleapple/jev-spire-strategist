import {test} from 'node:test';
import assert from 'node:assert/strict';
import {combatConstraints,constrainCandidates,validatePlan} from './strategy.mjs';

const enemy=(entity_id,name,hp,status=[])=>({entity_id,name,hp,max_hp:100,status});
const fight=({type='monster',hp=60,enemies=[enemy('a','Leader',50)]}={})=>({state_type:type,run:{live_id:'run',act:1,floor:5},
 player:{hp,max_hp:80},battle:{round:2,enemies}});
const cand=(id,command,forecast={},plan)=>({id,label:id,command,forecast:{quality:'partial',survives:true,defeatedEnemies:[],...forecast},...(plan?{plan}:{})});
const ids=r=>r.candidates.map(c=>c.id);
const plan=combat=>({run_id:'run',combat:{risk_tolerance:'low',potion_policy:'',focus:'',hallway_potion_below_hp_percent:100,potion_reserve:0,...combat}});

test('plays forecast to be fatal are removed only when another play survives',()=>{
 const cands=[cand('defend',{action:'play_card',card_index:0},{survives:false}),cand('beckon',{action:'play_card',card_index:1}),cand('end',{action:'end_turn'},{survives:false})];
 const r=combatConstraints(fight({type:'boss'}),cands,null);
 assert.deepEqual(ids(r),['beckon']);assert.equal(r.rules[0].kind,'avoid_fatal');
 const allDie=cands.map(c=>({...c,forecast:{...c.forecast,survives:false}}));
 assert.equal(combatConstraints(fight(),allDie,null).candidates.length,3,'nothing is removed when every play dies');
 const unknown=[cand('x',{action:'play_card',card_index:0},{survives:false}),cand('y',{action:'play_card',card_index:1},{survives:null,quality:'unknown'})];
 assert.equal(combatConstraints(fight(),unknown,null).candidates.length,2,'an unknown forecast is not a survivor');
});

test('hallway potions wait until HP falls below the plan floor, unless everything else dies',()=>{
 const cands=[cand('potion',{action:'use_potion',slot:0}),cand('later',{action:'play_card',card_index:0},{},[{command:{action:'play_card',card_index:0}},{command:{action:'use_potion',slot:0}}]),cand('strike',{action:'play_card',card_index:1})];
 const p=plan({hallway_potion_below_hp_percent:50});
 assert.deepEqual(ids(combatConstraints(fight({hp:60}),cands,p)),['strike']);
 assert.equal(combatConstraints(fight({hp:30}),cands,p).candidates.length,3,'below the floor');
 assert.equal(combatConstraints(fight({type:'elite',hp:80}),cands,p).candidates.length,3,'elites and bosses are unaffected');
 const desperate=[cands[0],cand('strike',{action:'play_card',card_index:1},{survives:false})];
 assert.deepEqual(ids(combatConstraints(fight({hp:60}),desperate,p)),['potion'],'the fatal rule keeps the surviving potion');
 assert.equal(combatConstraints(fight({hp:60}),cands,plan({})).candidates.length,3,'100 means no limit');
});

test('target priority removes single-target plays at others unless they kill',()=>{
 const enemies=[enemy('q','Queen',300),enemy('m','Torch Head Amalgam',150,[{name:'Minion'}]),enemy('s','Small Minion',5,[{name:'Minion'}])];
 const cands=[cand('hitQueen',{action:'play_card',card_index:0,target:'q'}),cand('hitMinion',{action:'play_card',card_index:1,target:'m'}),
  cand('killSmall',{action:'play_card',card_index:2,target:'s'},{defeatedEnemies:[{id:'s'}]}),cand('aoe',{action:'play_card',card_index:3}),cand('end',{action:'end_turn'})];
 const r=combatConstraints(fight({type:'boss',enemies}),cands,plan({}),{plan:'Kill the Queen',target_priority:['queen','Torch Head Amalgam']});
 assert.deepEqual(ids(r),['hitQueen','killSmall','aoe','end']);assert.equal(r.rules[0].enemy,'Queen');assert.equal(r.rules[0].kind,'target_priority');
 const gone=[enemy('q','Queen',0),enemies[1]];
 // With the Queen dead the next name in priority becomes the focus; one enemy left means no filter.
 assert.equal(combatConstraints(fight({type:'boss',enemies:gone}),cands,plan({}),{plan:'x',target_priority:['queen','Torch Head Amalgam']}).candidates.length,5);
 const two=[enemy('q','Queen',0),enemies[1],enemies[2]];
 assert.deepEqual(ids(combatConstraints(fight({type:'boss',enemies:two}),cands,plan({}),{plan:'x',target_priority:['queen','Torch Head Amalgam']})),['hitMinion','killSmall','aoe','end']);
});

test('combat rules apply only in constrained mode for the plan run, and plans validate the floor',()=>{
 const cands=[cand('potion',{action:'use_potion',slot:0}),cand('strike',{action:'play_card',card_index:1})];
 const p=plan({hallway_potion_below_hp_percent:50});
 assert.equal(constrainCandidates(fight(),cands,p).constraint.kind,'combat');
 assert.equal(constrainCandidates(fight(),cands,p,'advisory').candidates.length,2);
 assert.equal(constrainCandidates(fight(),cands,{...p,run_id:'other'}).candidates.length,2);
 const full={archetype:'x',summary:'x',priorities:[],combat:{...p.combat,hallway_potion_below_hp_percent:120},card_reward:{desired:[],avoid:[],skip_when:''},
  shop:{gold_reserve:0,priorities:[]},route:'',route_path:[],elite_min_hp_percent:0,rest:'',replan_below_hp_percent:25,fight:{plan:'',target_priority:[]},allowed_option_ids:[],option_note:''};
 assert.match(validatePlan(full).join(),/hallway_potion_below_hp_percent must be 0-100/);
});

test('pure block is removed when ending the turn loses no HP and nothing uses block',()=>{
 const defend={type:'Skill',description:'Gain 5 Block.'};
 const cands=[{id:'defend',label:'Defend',command:{action:'play_card',card_index:0},details:defend,forecast:{hpLoss:0,quality:'partial',survives:true}},
  {id:'shrug',label:'Shrug',command:{action:'play_card',card_index:1},details:{type:'Skill',description:'Gain 8 Block. Draw 1 card.'},forecast:{hpLoss:0,quality:'partial',survives:true}},
  {id:'end',label:'End turn',command:{action:'end_turn'},forecast:{hpLoss:0,quality:'partial',survives:true}}];
 const s=fight();s.player.hand=[];s.player.status=[];s.player.relics=[];
 assert.deepEqual(ids(combatConstraints(s,cands,null)),['shrug','end']);
 const hit=cands.map(c=>c.id==='end'?{...c,forecast:{...c.forecast,hpLoss:6}}:c);
 assert.equal(combatConstraints(s,hit,null).candidates.length,3,'block matters when damage is coming');
 const jug={...s,player:{...s.player,status:[{name:'Juggernaut',amount:6}]}};
 assert.equal(combatConstraints(jug,cands,null).candidates.length,3,'Juggernaut turns block into damage');
});

test('exhaust choice prefers junk and payoff cards, then plain Strikes and Defends',async()=>{
 const {exhaustConstraint}=await import('./strategy.mjs');
 const card=(index,name,type,extra={})=>({index,name,type,description:'',...extra});
 const state=(cards,hp=60)=>({state_type:'hand_select',player:{hp,max_hp:80},hand_select:{prompt:'Choose a card to Exhaust.',cards}});
 const cands=cards=>cards.map(c=>({id:'c'+c.index,label:c.name,command:{action:'combat_select_card',card_index:c.index}}));
 const basic=[card(0,'Bash','Attack'),card(1,'Strike','Attack'),card(2,'Defend','Skill'),card(3,'Strike','Attack',{is_upgraded:true})];
 assert.deepEqual(ids(exhaustConstraint(state(basic),cands(basic))),['c1','c2']);
 assert.deepEqual(ids(exhaustConstraint(state(basic,20),cands(basic))),['c1'],'low HP keeps Defends');
 const junk=[...basic,card(4,'Dazed','Status'),card(5,'Drum of Battle','Skill',{description:'Draw 2 cards. When this card is Exhausted, gain 3 energy.'})];
 assert.deepEqual(ids(exhaustConstraint(state(junk),cands(junk))),['c4','c5']);
 const none=[card(0,'Bash','Attack'),card(1,'Inflame','Power')];
 assert.equal(exhaustConstraint(state(none),cands(none)),null);
 assert.equal(exhaustConstraint({...state(basic),hand_select:{prompt:'Choose any number of cards to Exhaust.',cards:basic}},cands(basic)),null);
});

test('resting that wastes half its heal is removed when Smith is offered',async()=>{
 const {restConstraint}=await import('./strategy.mjs');
 const cands=[{id:'rest',label:'Rest',details:{id:'HEAL',description:'Heal for 30% of your Max HP (24).'}},{id:'smith',label:'Smith',details:{id:'SMITH',is_enabled:true}}];
 const at=hp=>({state_type:'rest_site',player:{hp,max_hp:80}});
 assert.deepEqual(ids(restConstraint(at(72),cands)),['smith']);
 assert.equal(restConstraint(at(60),cands),null,'20 of 24 heal used');
 assert.equal(restConstraint(at(72),cands.slice(0,1)),null,'no Smith offered');
});

test('a forecast win is taken, with the fewest potions',()=>{
 const win=(id,command,plan)=>cand(id,command,{boundary:'combat_won',survives:true},plan);
 const cands=[cand('thrash',{action:'play_card',card_index:0,target:'a'}),
  win('strikeFirst',{action:'play_card',card_index:1,target:'a'}),
  win('potionWin',{action:'use_potion',slot:0,target:'a'},[{command:{action:'use_potion',slot:0}}]),
  cand('end',{action:'end_turn'})];
 const r=combatConstraints(fight({type:'boss'}),cands,null);
 assert.deepEqual(ids(r),['strikeFirst']);assert.equal(r.rules[0].kind,'take_lethal');
 const unknown=[cands[0],cand('maybe',{action:'play_card',card_index:1},{boundary:'combat_won',survives:null,quality:'unknown'})];
 assert.equal(combatConstraints(fight(),unknown,null).candidates.length,2,'an unknown forecast is not a win');
});

test('a win that needs a potion is not forced in a hallway fight above the potion floor',()=>{
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'a'}),
  cand('ampouleWin',{action:'use_potion',slot:0},{boundary:'combat_won',survives:true},[{command:{action:'use_potion',slot:0}}]),
  cand('end',{action:'end_turn'})];
 const r=combatConstraints(fight({hp:64}),cands,plan({hallway_potion_below_hp_percent:40}));
 assert.deepEqual(ids(r),['strike','end']);assert.deepEqual(r.rules.map(x=>x.kind),['hallway_potion']);
 assert.deepEqual(ids(combatConstraints(fight({type:'elite',hp:64}),cands,plan({hallway_potion_below_hp_percent:40}))),['ampouleWin'],'elites still take it');
});

test('ending the turn is removed while an affordable Beckon is still in hand',()=>{
 const beckon={name:'Beckon',cost:'1',can_play:true,description:'At the end of your turn, if this is in your Hand,  lose 6 HP.'};
 const s=fight({type:'boss'});s.player.hand=[beckon];s.player.energy=1;
 const cands=[cand('beckon',{action:'play_card',card_index:0}),cand('end',{action:'end_turn'})];
 const r=combatConstraints(s,cands,null);
 assert.deepEqual(ids(r),['beckon']);assert.equal(r.rules[0].kind,'play_hp_loss_cards');
 s.player.energy=0;
 assert.equal(combatConstraints(s,cands,null).candidates.length,2,'no energy to play it');
});

test('while every enemy is Intangible only the least-HP-loss plays remain',()=>{
 const s=fight({type:'boss',enemies:[enemy('f','Soul Fysh',123,[{name:'Intangible',amount:1}])]});
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'f'},{hpLoss:13}),cand('uppercut',{action:'play_card',card_index:1,target:'f'},{hpLoss:9}),
  cand('mystery',{action:'play_card',card_index:2},{hpLoss:null,quality:'unknown',survives:null}),cand('end',{action:'end_turn'},{hpLoss:13})];
 const r=combatConstraints(s,cands,null);
 assert.deepEqual(ids(r),['uppercut','mystery']);assert.equal(r.rules[0].kind,'intangible_defense');
 const normal=fight({type:'boss',enemies:[enemy('f','Soul Fysh',123)]});
 assert.equal(combatConstraints(normal,cands,null).candidates.length,4,'no rule without Intangible');
});

test('block is removed on a turn with no incoming damage even while a Beckon costs HP',()=>{
 const beckon={name:'Beckon',cost:'1',can_play:true,description:'At the end of your turn, if this is in your Hand,  lose 6 HP.'};
 const s=fight({type:'boss'});s.player.hand=[beckon,{name:'Defend',cost:'1',can_play:true,type:'Skill',description:'Gain 5 Block.'}];s.player.energy=2;
 const cands=[cand('beckon',{action:'play_card',card_index:0},{hpLoss:0}),
  {...cand('defend',{action:'play_card',card_index:1},{hpLoss:6,endTurnCardHpLoss:6}),details:{type:'Skill',description:'Gain 5 Block.'}},
  cand('end',{action:'end_turn'},{hpLoss:6,endTurnCardHpLoss:6})];
 const r=combatConstraints(s,cands,null);
 assert.deepEqual(ids(r),['beckon']);assert.deepEqual(r.rules.map(x=>x.kind),['play_hp_loss_cards','block_not_needed']);
});

test('the boss potion reserve holds potions outside boss fights unless every other option dies',()=>{
 const withPotions=(s,n)=>({...s,player:{...s.player,potions:Array.from({length:n},(_,i)=>({name:'P'+i}))}});
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'a'}),cand('potion',{action:'use_potion',slot:0}),cand('end',{action:'end_turn'})];
 const r=combatConstraints(withPotions(fight({type:'elite'}),1),cands,plan({potion_reserve:1}));
 assert.deepEqual(ids(r),['strike','end']);assert.deepEqual(r.rules,[{kind:'potion_reserve',removed:1,held:1,reserve:1}]);
 assert.deepEqual(ids(combatConstraints(withPotions(fight({type:'elite'}),2),cands,plan({potion_reserve:1}))),['strike','potion','end'],'a spare potion can be used');
 assert.deepEqual(ids(combatConstraints(withPotions(fight({type:'boss'}),1),cands,plan({potion_reserve:1}))),['strike','potion','end'],'the boss uses it');
 const dying=cands.map(c=>c.id==='potion'?c:{...c,forecast:{...c.forecast,survives:false}});
 assert.equal(combatConstraints(withPotions(fight({type:'elite'}),1),dying,plan({potion_reserve:1})).rules.some(x=>x.kind==='potion_reserve'),false,'kept when everything else dies');
});

test('a target name covers every living enemy with that name',()=>{
 const st=fight({enemies:[enemy('a','Bowlbug (Nectar)',20),enemy('b','Bowlbug (Nectar)',20),enemy('c','Bowlbug (Rock)',20)]});
 const cands=['a','b','c'].map(t=>cand('hit_'+t,{action:'play_card',card_index:0,target:t}));
 const r=combatConstraints(st,cands,plan({}),{plan:'x',target_priority:['Bowlbug (Nectar)']});
 assert.deepEqual(ids(r),['hit_a','hit_b']);
});

test('above the hallway floor, a potion line stays when it saves max(10, 12% of max HP) and the best line without one would drop under the floor',()=>{
 const cands=[cand('defend',{action:'play_card',card_index:0},{hpLoss:20}),cand('end',{action:'end_turn'},{hpLoss:25}),
  cand('block',{action:'use_potion',slot:0},{hpLoss:8}),cand('fire',{action:'use_potion',slot:1},{hpLoss:15})];
 const r=combatConstraints(fight({hp:40}),cands,plan({hallway_potion_below_hp_percent:40}));
 assert.deepEqual(ids(r),['defend','end','block']);assert.equal(r.rules[0].potion_lines_kept,1);
 assert.deepEqual(ids(combatConstraints(fight({hp:70}),cands,plan({hallway_potion_below_hp_percent:40}))),['defend','end'],'70 - 20 stays above the floor: no potion');
 const unknown=cands.map(c=>c.id==='block'?{...c,forecast:{...c.forecast,quality:'unknown'}}:c);
 assert.deepEqual(ids(combatConstraints(fight({hp:40}),unknown,plan({hallway_potion_below_hp_percent:40}))),['defend','end'],'an unknown forecast does not qualify');
});

test('a death countdown at 4 or less forces an affordable card that extends it',()=>{
 const boss=enemy('b','The Insatiable',200,[{name:'Sandpit',amount:3,description:'In 3 turns, you will be eaten and die.'}]);
 const st={...fight({type:'boss',enemies:[boss]}),player:{hp:60,max_hp:80,energy:3,hand:[
  {index:0,name:'Frantic Escape',cost:'1',can_play:true,description:'Get farther away. Increase Sandpit by 1. Increase the cost of this card by 1.'},
  {index:1,name:'Strike',cost:'1',can_play:true,description:'Deal 6 damage.'}]}};
 const cands=[cand('escape',{action:'play_card',card_index:0}),cand('strike',{action:'play_card',card_index:1,target:'b'}),cand('end',{action:'end_turn'})];
 const r=combatConstraints(st,cands,plan({}));
 assert.deepEqual(ids(r),['escape']);assert.equal(r.rules.at(-1).kind,'countdown_escape');
 boss.status[0].amount=6;assert.equal(combatConstraints(st,cands,plan({})).rules.some(x=>x.kind==='countdown_escape'),false,'not yet urgent');
});

test('fight.play_first keeps only the listed card while it is affordable (potions stay)',()=>{
 const st={...fight(),player:{hp:60,max_hp:80,energy:2,hand:[{index:0,name:'Frantic Escape',cost:'1',can_play:true,description:'x'},{index:1,name:'Strike',cost:'1',can_play:true,description:'Deal 6 damage.'}]}};
 const cands=[cand('escape',{action:'play_card',card_index:0}),cand('strike',{action:'play_card',card_index:1,target:'a'}),cand('potion',{action:'use_potion',slot:0}),cand('end',{action:'end_turn'})];
 const r=combatConstraints(st,cands,plan({}),{plan:'x',target_priority:[],play_first:['Frantic Escape']});
 assert.deepEqual(ids(r),['escape','potion']);
 st.player.energy=0;assert.equal(combatConstraints(st,cands,plan({}),{plan:'x',target_priority:[],play_first:['Frantic Escape']}).rules.some(x=>x.kind==='play_first'),false,'unaffordable: no constraint');
});

test('no lethal rule on an empty board, and an unmodeled player debuff makes a win untrusted',()=>{
 const win=(id,command,warnings=[])=>cand(id,command,{boundary:'combat_won',survives:true,warnings});
 const cands=[win('howl',{action:'play_card',card_index:0}),cand('end',{action:'end_turn'})];
 assert.deepEqual(ids(combatConstraints(fight({type:'boss',enemies:[]}),cands,null)),['howl','end'],'a reviving boss leaves the board empty');
 const tender={...fight(),player:{hp:60,max_hp:80,status:[{name:'Tender',type:'Debuff'}]}};
 const tendered=[win('kill',{action:'play_card',card_index:0,target:'a'},['Unmodeled player power: Tender']),cand('end',{action:'end_turn'})];
 assert.deepEqual(ids(combatConstraints(tender,tendered,null)),['kill','end']);
 const buffed={...tender,player:{...tender.player,status:[{name:'Tender',type:'Buff'}]}};
 assert.deepEqual(ids(combatConstraints(buffed,tendered,null)),['kill'],'an unmodeled buff does not block the win');
});

test('the potion reserve yields below the hallway potion floor',()=>{
 const withPotions=(s,n)=>({...s,player:{...s.player,potions:Array.from({length:n},(_,i)=>({name:'P'+i}))}});
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'a'}),cand('potion',{action:'use_potion',slot:0}),cand('end',{action:'end_turn'})];
 const p=plan({potion_reserve:1,hallway_potion_below_hp_percent:40});
 assert.deepEqual(ids(combatConstraints(withPotions(fight({type:'elite',hp:60}),1),cands,p)),['strike','end']);
 assert.deepEqual(ids(combatConstraints(withPotions(fight({type:'elite',hp:20}),1),cands,p)),['strike','potion','end'],'at 25% HP the potion is allowed');
});

test('Flame Barrier counts as pure block on a turn with nothing incoming',()=>{
 const barrier={type:'Skill',description:'Gain 12 Block. Whenever you are attacked this turn, deal 4 damage back.'};
 const cands=[{id:'barrier',label:'Flame Barrier',command:{action:'play_card',card_index:0},details:barrier,forecast:{hpLoss:0,quality:'partial',survives:true}},
  {id:'strike',label:'Strike',command:{action:'play_card',card_index:1,target:'a'},details:{type:'Attack',description:'Deal 6 damage.'},forecast:{hpLoss:0,quality:'partial',survives:true}},
  {id:'end',label:'End turn',command:{action:'end_turn'},forecast:{hpLoss:0,quality:'partial',survives:true}}];
 const s=fight();s.player.hand=[];s.player.status=[];s.player.relics=[];
 assert.deepEqual(ids(combatConstraints(s,cands,null)),['strike','end']);
});

test('block cards with scaling, conditional or energy-refund text are pure block too; draw or upgrade is not',()=>{
 const card=(id,description,i)=>({id,label:id,command:{action:'play_card',card_index:i},details:{type:'Skill',description},forecast:{hpLoss:0,quality:'partial',survives:true}});
 const cands=[card('fight','Gain 15 Block. Gains 5 additional Block for each Strength you have. Gain [ironclad_energy_icon.png].',0),
  card('eye','Gain 8 Block. Gain another 8 Block if you have Exhausted a card this turn.',1),
  card('armaments','Gain 5 Block. Upgrade a card in your Hand.',2),card('shrug','Gain 8 Block. Draw 1 card.',3),
  {id:'end',label:'End turn',command:{action:'end_turn'},forecast:{hpLoss:0,quality:'partial',survives:true}}];
 const s=fight();s.player.hand=[];s.player.status=[];s.player.relics=[];
 assert.deepEqual(ids(combatConstraints(s,cands,null)),['armaments','shrug','end']);
});

test('a healing potion is not drunk when less HP is missing than it heals, even in a boss fight',()=>{
 const potion={name:'Blood Potion',description:'Heal for 20% of your Max HP.',slot:0};
 const s=hp=>({...fight({type:'boss',hp}),player:{hp,max_hp:90,potions:[potion]}});
 const cands=[cand('drink',{action:'use_potion',slot:0}),cand('strike',{action:'play_card',card_index:0,target:'a'}),cand('end',{action:'end_turn'})];
 assert.deepEqual(ids(combatConstraints(s(90),cands,null)),['strike','end']);
 assert.equal(ids(combatConstraints(s(60),cands,null)).includes('drink'),true,'30 missing covers the 18 heal');
 const dying=cands.map(c=>c.id==='drink'?c:{...c,forecast:{...c.forecast,survives:false}});
 assert.deepEqual(ids(combatConstraints(s(85),dying,null)),['drink'],'kept when everything else dies');
});

test('play_first yields when the forced line loses much more HP than the best line',()=>{
 const st={...fight({type:'boss'}),player:{hp:40,max_hp:80,energy:4,hand:[{index:0,name:'Juggernaut',cost:'2',can_play:true,description:'x'},{index:1,name:'Uppercut+',cost:'2',can_play:true,description:'y'}]}};
 const fp={plan:'x',target_priority:[],play_first:['Juggernaut']};
 const lines=jug=>[cand('jug',{action:'play_card',card_index:0},{hpLoss:jug}),cand('upper',{action:'play_card',card_index:1,target:'a'},{hpLoss:3}),cand('end',{action:'end_turn'},{hpLoss:30})];
 assert.equal(ids(combatConstraints(st,lines(27),plan({}),fp)).includes('upper'),true,'27 vs 3 exceeds the margin: not forced');
 assert.deepEqual(ids(combatConstraints(st,lines(5),plan({}),fp)),['jug'],'within the margin: forced');
});

test('a forced escape yields when it dies this turn and a blocking line survives, unless the countdown is at 1',()=>{
 const boss=enemy('b','The Insatiable',149,[{name:'Sandpit',amount:4,description:'In 4 turns, you will be eaten and die.'}]);
 const st={...fight({type:'boss',enemies:[boss]}),player:{hp:13,max_hp:91,energy:3,hand:[
  {index:0,name:'Frantic Escape',cost:'3',can_play:true,description:'Get farther away. Increase Sandpit by 1. Increase the cost of this card by 1.'},
  {index:1,name:'Defend',cost:'1',can_play:true,description:'Gain 6 Block.'}]}};
 const fp={plan:'x',target_priority:[],play_first:['Frantic Escape']};
 const cands=[cand('escape',{action:'play_card',card_index:0},{quality:'unknown',survives:null,hpLoss:null}),
  cand('block',{action:'play_card',card_index:1},{hpLoss:10}),cand('end',{action:'end_turn'},{hpLoss:28,survives:false})];
 assert.equal(ids(combatConstraints(st,cands,plan({}),fp)).includes('block'),true,'play_first yields');
 boss.status[0].amount=3;
 assert.equal(ids(combatConstraints(st,cands,plan({}),fp)).includes('block'),true,'countdown_escape yields at 3');
 boss.status[0].amount=1;
 assert.deepEqual(ids(combatConstraints(st,cands,plan({}),fp)),['escape'],'at 1 the escape is forced');
});

test('under the hallway floor, a non-healing potion that saves no HP this turn is removed; healing potions stay',()=>{
 const st={...fight({hp:26}),player:{hp:26,max_hp:70,potions:[{slot:0,name:'Explosive Ampoule',description:'Deal 10 damage to ALL enemies.'},{slot:1,name:'Blood Potion',description:'Heal for 20% of your Max HP.'},{slot:2,name:'Block Potion',description:'Gain 12 Block.'}]}};
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'a'},{hpLoss:6}),cand('bomb',{action:'use_potion',slot:0},{hpLoss:6}),
  cand('blood',{action:'use_potion',slot:1},{hpLoss:6}),cand('block',{action:'use_potion',slot:2},{hpLoss:0})];
 const r=combatConstraints(st,cands,plan({hallway_potion_below_hp_percent:40}));
 assert.deepEqual(ids(r),['strike','blood','block']);assert.equal(r.rules.at(-1).kind,'idle_potion');
});

test('idle_potion keeps a potion whose effect the forecast cannot show (new cards, draws, later effects)',()=>{
 const st={...fight({hp:20}),player:{hp:20,max_hp:80,potions:[{slot:0,name:'Attack Potion',description:'Choose 1 of 3 random Attacks to add into your Hand. It costs 0 this turn.'}]}};
 const cands=[cand('strike',{action:'play_card',card_index:0,target:'a'},{hpLoss:6}),
  cand('attackpot',{action:'use_potion',slot:0},{hpLoss:6,warnings:['Attack Potion adds or chooses unknown cards; re-observe.']})];
 assert.deepEqual(ids(combatConstraints(st,cands,plan({hallway_potion_below_hp_percent:40}))),['strike','attackpot']);
});

test('a play that leaves too little energy for a held Beckon is removed unless it wins',()=>{
 const beckon=i=>({index:i,name:'Beckon',cost:'1',can_play:true,description:'At the end of your turn, if this is in your Hand,  lose 6 HP.'});
 const s=fight({type:'boss'});s.player.energy=2;
 s.player.hand=[{index:0,name:'Whirlwind',cost:'X',can_play:true,description:'Deal 5 damage to ALL enemies X times.'},beckon(1),beckon(2),{index:3,name:'Strike',cost:'1',can_play:true,description:'Deal 6 damage.'}];
 const cands=[cand('whirl',{action:'play_card',card_index:0}),cand('beckon',{action:'play_card',card_index:1}),cand('strike',{action:'play_card',card_index:3,target:'a'}),cand('end',{action:'end_turn'})];
 assert.deepEqual(ids(combatConstraints(s,cands,null)),['beckon','strike'],'Whirlwind would spend the Beckon energy');
 const winning=cands.map(c=>c.id==='whirl'?{...c,forecast:{...c.forecast,boundary:'combat_won'}}:c);
 assert.equal(ids(combatConstraints(s,winning,null)).includes('whirl'),true,'a winning play stays');
});

test('a play that spends the Beckon energy stays when its forecast beats every line that keeps energy for one',()=>{
 const beckon={index:1,name:'Beckon',cost:'1',can_play:true,description:'At the end of your turn, if this is in your Hand,  lose 6 HP.'};
 const s=fight({type:'boss'});s.player.energy=2;
 s.player.hand=[{index:0,name:'Impervious',cost:'2',can_play:true,description:'Gain 30 Block. Exhaust.'},beckon];
 const cands=[cand('imp',{action:'play_card',card_index:0},{hpLoss:6}),cand('beckon',{action:'play_card',card_index:1},{hpLoss:24}),cand('end',{action:'end_turn'},{hpLoss:30})];
 assert.deepEqual(ids(combatConstraints(s,cands,null)),['imp','beckon'],'blocking a 24 hit is worth the 6-HP Beckon');
});
