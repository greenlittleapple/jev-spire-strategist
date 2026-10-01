import {retaliationRule,applyRetaliation} from './retaliation.mjs';
import {facingDamage} from './facing.mjs';
import {potionTiming} from './potion-timing.mjs';
import {spendingRoutes} from './routes.mjs';
import {mechanicsReview} from './mechanics.mjs';
import {setupLinks} from './setup-links.mjs';
import {encounterBrief,deckSnapshot,visibleState} from './encounters.mjs';
import { actionsFor, factsFor, makeQuestion } from './actions.mjs';
import { modeledRunes, unsupportedRuneRules } from '../../../integration/sts2/runes.mjs';

export const POLICY_VERSION = 'jev-visible-v24-hextech';
const amount = (powers, name) => (powers ?? []).filter(p => p.name?.toLowerCase() === name.toLowerCase()).reduce((n,p) => n + Number(p.amount ?? 0), 0);
const number = (text, regex, fallback = 0) => Number(text.match(regex)?.[1] ?? fallback);
const nameOf = c => (c.name ?? '').replace(/\+$/, '').toLowerCase();
export const supportedCards = new Set(['beckon','strike','defend','bash','uppercut','setup strike','inflame','shrug it off','rage','bludgeon','whirlwind','stomp','dismantle','rampage','anger','breakthrough','offering','slimed','twin strike','conflagration','bully','unrelenting','mind blast','perfected strike','thunderclap','impervious','dominate','vicious','molten fist','stone armor','armaments','feel no pain','giant rock','toxic','iron wave','pommel strike','taunt','battle trance','toric toughness','pyre','drum of battle','relax','flame barrier','hemokinesis','restlessness','bloodletting','colossus','expect a fight',"pact's end","cruelty","pillage","headbutt","true grit","spite","feed","fiend fire","thrash","cinder","evil eye","body slam","howl from beyond","juggernaut","crimson mantle","tremble","ashen strike","distraction","stoke","burning pact","metamorphosis","rupture","unmovable","juggling","stampede","aggression","forgotten ritual","brand","barricade","mayhem","infernal blade","secret weapon","one-two punch","sword boomerang","frantic escape",
  'mangle','fight me!','omnislice','fisticuffs','blizzara','thrumming hatchet','demon form',"neow's fury",'primal force','second wind']);
export const supportedPotions = new Set(['blood potion','fysh oil','strength potion','flex potion','weak potion','fortifier','block potion','energy potion','fire potion','swift potion','dexterity potion','speed potion','explosive ampoule','shackling potion','vulnerable potion','potion-shaped rock','beetle juice','regen potion','powdered demise','power potion','attack potion','skill potion','colorless potion','ashwater','lucky tonic','potion of binding','fruit juice','heart of iron','radiant tincture','cure all','clarity extract','stable serum','entropic brew','gambler\'s brew','glowwater potion','blessing of the forge','soldier\'s stew','duplicator']);
// Powers the forecast covers. Anything else on the player or an enemy is flagged "Unmodeled ... power"
// in warnings and listed in notModeled (see unmodeledMechanics), so the forecast is marked partial.
// Modeled in the arithmetic, or already included in the live hand text, status, energy or intents
// (Shrink and Vigor are in displayed card damage; Setup Strike, Flex Potion and Speed Potion are
// already in live Strength or Dexterity; Ringing and Sloth stop plans at a play-limit boundary;
// Surrounded is handled by the facing projection).
const knownPlayerPowers = new Set(['strength','dexterity','weak','frail','vulnerable','rage','plating','metallicize','free attack','vicious','feel no pain','cruelty','juggernaut','crimson mantle','rupture','unmovable','juggling','stampede','aggression','regen','buffer','barricade','mayhem','duplicator','duplication','one-two punch','smoggy','disintegration','constrict','colossus',
  'no draw','no energy gain','ringing','sloth','shrink','tender','vigor','setup strike','flex potion','speed potion','surrounded',
  // No effect before the enemy attacks this turn: start-of-turn or next-turn effects, and replies to enemy attacks.
  'pyre','demon form','radiance','waste away','clarity','mind rot','prep time','retain hand','toric toughness','self-forming clay','block next turn','thorns','flame barrier']);
const knownEnemyPowers = new Set(['strength','weak','vulnerable','slippery','plow','artifact','hardened shell','skittish','minion','hard to kill','intangible','personal hive','imbalanced','sandpit','paper cuts',
  'slow','flutter','back attack',
  // Strength lost this turn (Mangle, Shackling Potion) is already in the displayed intents.
  'mangle','shackling potion',
  // Death rules whose effect comes after this turn (see laterDeathRule).
  'steam eruption','reattach','illusion',
  // No effect on this turn's damage, block or displayed incoming: they act at the end of a turn,
  // on later turns, or on gold and discard piles.
  'ritual','territorial','high voltage','nemesis','demise','hatch','escape artist','thievery','rampart','plating','dexterity','painful stabs']);
const knownRelics = new Set(['ORICHALCUM','BURNING_BLOOD','VAJRA','GORGET','ORNAMENTAL_FAN','ANCHOR','STRAWBERRY','PEAR','MANGO','BAG_OF_PREPARATION','POTION_BELT','ARCANE_SCROLL','TUNING_FORK',
  'CLOAK_CLASP','CHARONS_ASHES','UNSETTLING_LAMP','FORGOTTEN_SOUL','LETTER_OPENER',
  // No effect within a player turn, or the effect is already in live status, energy or card text
  // (Oddly Smooth Stone as Dexterity, Red Mask as Weak, Ember Tea as Strength, Miniature Cannon in upgraded Attack text).
  'BIG_MUSHROOM','BLACK_BLOOD','BONE_TEA','BOOMING_CONCH','BOWLER_HAT','EMBER_TEA','EUREKA_RUNE','FESTIVE_POPPER','FISHING_ROD',
  'HAPPY_FLOWER','JEWELED_MASK','JUZU_BRACELET','LANTERN','LAVA_ROCK','LOST_COFFER','LUCKY_FYSH','MEAL_TICKET','MERCURY_HOURGLASS',
  'MINIATURE_CANNON','NEOWS_BONES','NEOWS_TALISMAN','NUTRITIOUS_OYSTER','ODDLY_SMOOTH_STONE','PETRIFIED_TOAD','PHIAL_HOLSTER','POMANDER',
  'PRECISE_SCISSORS','RED_MASK','REGAL_PILLOW','SCROLL_BOXES','SMALL_CAPSULE','TOUCH_OF_OROBAS','VENERABLE_TEA_SET','WAR_PAINT',
  'YUMMY_COOKIE','TOASTY_MITTENS','ICE_CREAM','BRONZE_SCALES',
  // Strike Dummy is in the shown damage of Strike cards (logged: Strike shows and deals 9 with no Strength).
  'STRIKE_DUMMY','BAG_OF_MARBLES','BLOOD_VIAL','VERY_HOT_COCOA','PENDULUM','POLLINOUS_CORE','PAELS_BLOOD','PAELS_FLESH','CHANDELIER',
  'SOZU','BRIMSTONE','MR_STRUGGLES','SPARKLING_ROUGE','SAI','WINGED_BOOTS','AMETHYST_AUBERGINE','PRAYER_WHEEL','TINY_MAILBOX',
  // Modeled below.
  'RED_SKULL','NUNCHAKU','KUSARIGAMA','PEN_NIB','VELVET_CHOKER']);

const hasRelic=(s,id)=>(s.player.relics??[]).some(r=>r.id===id);
// A relic whose whole text is a one-time pickup effect (Large Capsule, Alchemical Coffer, Tri-Boomerang)
// does nothing in combat; its results are already in the deck, relics or potions.
export const pickupOnly=r=>{const d=String(r?.description??'');
 return /^(Upon pickup,|Choose \d+ [^.]* in your Deck\.)/i.test(d)&&!/\b(combat|turns?|whenever|at the (start|end)|rest site|shop)\b/i.test(d);};
function letterProgress(s){const r=(s.player.relics??[]).find(r=>r.id==='LETTER_OPENER');return r&&Number.isInteger(r.counter)?r.counter:null;}
// The one place that decides which visible powers and relics the forecast does not cover.
// Each is warned as "Unmodeled <kind>: <name>" and listed in notModeled as "<kind>: <name>".
export function unmodeledMechanics(s, runes = modeledRunes(s)) {
  const items = [], add = (kind, name) => { if (!items.some(x => x.kind === kind && x.name === name)) items.push({kind, name}); };
  for (const p of s.player?.status ?? []) if (!knownPlayerPowers.has(p.name.toLowerCase())) add('player power', p.name);
  for (const e of s.battle?.enemies ?? []) for (const p of e.status ?? []) if (!knownEnemyPowers.has(p.name.toLowerCase()) && retaliationRule(p)?.damage==null) add('enemy power', p.name);
  for (const r of s.player?.relics ?? []) if (!knownRelics.has(r.id) && !pickupOnly(r)
    && !(r.id === 'GROUNDED_RUNE' && runes.grounded)
    && !(r.id === 'FLYING_KICK_RUNE' && runes.flyingKick)) add('relic', r.name);
  return items;
}
// Counter relics. A counter at its trigger value is the moment before the bridge shows the reset
// (logged: Nunchaku 10, Kusarigama 3 and Pen Nib 10 read as 0 on the next state), so it counts as 0.
function relicCounters(s, warnings) {
  const relic = id => (s.player.relics ?? []).find(r => r.id === id);
  const counter = (id, every) => { const r = relic(id); if (!r) return null;
    if (!Number.isInteger(r.counter)) { warnings.push(`${r.name} counter unavailable: forecast omits its effect.`); return null; }
    return r.counter % every; };
  const skull = relic('RED_SKULL'), kusa = relic('KUSARIGAMA'), choker = relic('VELVET_CHOKER');
  const kusaEvery = kusa ? number(kusa.description ?? '', /play (\d+) Attacks/i, 3) : 3;
  const chokerLimit = choker ? number(choker.description ?? '', /cannot play more than (\d+) cards/i, 6) : 0;
  const chokerPlayed = choker ? counter('VELVET_CHOKER', Infinity) : null;
  return {
    // Red Skull: Strength while HP is at or below half; the live Strength already includes it.
    redSkull: skull ? number(skull.description ?? '', /(\d+) additional Strength/i, 3) : 0,
    redSkullOn: s.player.hp * 2 <= s.player.max_hp,
    // Nunchaku: energy on every 10th Attack (logged: Strike at counter 9 cost 1 and left energy unchanged).
    nunchaku: counter('NUNCHAKU', 10),
    // Kusarigama: damage to a random enemy on every 3rd Attack in a turn, not raised by Vulnerable
    // (logged: Iron Wave 5 at counter 2 took 11; Dismantle 32 on Vulnerable at counter 2 took 38).
    kusarigama: counter('KUSARIGAMA', kusaEvery), kusaEvery, kusaDamage: kusa ? number(kusa.description ?? '', /deal (\d+) damage/i, 6) : 0,
    // Pen Nib: every 10th Attack deals double. At counter 9 every Attack in hand already shows double damage.
    penNib: counter('PEN_NIB', 10),
    // Velvet Choker: the counter is the number of cards played this turn.
    cardsLeft: chokerPlayed === null ? null : Math.max(0, chokerLimit - chokerPlayed),
  };
}
// Red Skull follows the current HP both ways.
function redSkullCheck(m) {
  if (!m.redSkull) return;
  const on = m.hp * 2 <= m.maxHp;
  if (on !== m.redSkullOn) { m.strengthDelta += on ? m.redSkull : -m.redSkull; m.redSkullOn = on; }
}
// Death rules that act after this turn. A Waterfall Giant is stunned when killed and its Steam
// Eruption hits at the end of the next turn (logged: no damage taken that turn, then a DeathBlow for
// the amount); Reattach and Illusion revive later and only matter while another enemy keeps the fight going.
const laterDeathRule = (text, fightContinues) => /^When killed, deals \d+ damage at the end of your next turn\.?$/i.test(text)
  || (fightContinues && /^(If other segments are still alive, revives in \d+ turns with \d+ HP|When this dies, it revives next turn at full HP)\.?$/i.test(text));
const deathRuleText = /when killed|upon dying|on death|when this dies|would be defeated|revives?/i;
function initial(s) {
  const runes = modeledRunes(s);
  const unmodeled = unmodeledMechanics(s, runes);
  const warnings = unmodeled.map(x => `Unmodeled ${x.kind}: ${x.name}`);
  const fan = (s.player.relics ?? []).find(r => r.id === 'ORNAMENTAL_FAN');
  const fanProgress = Number.isInteger(fan?.counter) ? fan.counter : null;
  if (hasRelic(s,'UNSETTLING_LAMP') && typeof s.player.lamp_used !== 'boolean') warnings.push('Unsettling Lamp: whether it was used this combat is unknown; debuffs are not doubled.');
  if (hasRelic(s,'LETTER_OPENER') && letterProgress(s) === null) warnings.push('Letter Opener counter unavailable: forecast omits its damage.');
  if (fan && fanProgress === null) warnings.push('Ornamental Fan counter unavailable: forecast omits its extra block.');
  return {
    runes, runeEvents: [], unsupportedRunes: unsupportedRuneRules(s), unmodeled,
    retaliationEvents:[],
    retaliationModifiers:(s.player.status??[]).some(p=>!['strength','dexterity','weak','frail','no energy gain','no draw','free attack'].includes(p.name.toLowerCase())),
    // Colossus active at the start: displayed intents of already Vulnerable enemies include its reduction.
    colossus:false, colossusStart:amount(s.player.status,'Colossus')>0,
    noEnergyGain:amount(s.player.status,'No Energy Gain')>0,
    exhaustCount:s.player.exhaust_pile_count ?? s.player.exhaust_pile?.length ?? 0,
    noDraw:amount(s.player.status,'No Draw')>0,
    unmovable:amount(s.player.status,'Unmovable')>0,
    ringing: (s.player.status??[]).some(p=>p.name==='Ringing' || /cannot play more than \d+ cards each turn/i.test(p.description??'')),
    energy: s.player.energy, hp: s.player.hp, startHp: s.player.hp, maxHp: s.player.max_hp, block: s.player.block ?? 0,
    hand: structuredClone(s.player.hand).map(c => ({ ...c, sourceIndex: c.index })),
    potions: structuredClone(s.player.potions ?? []), enemies: structuredClone(s.battle.enemies),
    dexterityDelta: 0, frailFactor: amount(s.player.status,'Frail') > 0 ? .75 : 1,
    strengthDelta: 0, weakFactor: amount(s.player.status,'Weak') > 0 ? .75 : 1,
    feelNoPain:amount(s.player.status,'Feel No Pain'),
    juggernaut:amount(s.player.status,'Juggernaut'),
    buffer:amount(s.player.status,'Buffer'),
    // Extra plays granted by Duplicator (next card) and One-Two Punch (next Attack).
    // The Duplicator potion's power is named Duplication in the game.
    extraNextCard:amount(s.player.status,'Duplicator')+amount(s.player.status,'Duplication'), extraNextAttack:amount(s.player.status,'One-Two Punch'),
    // Tender: each card played lowers Strength and Dexterity for the rest of the turn (the live status already has earlier plays).
    tender:(s.player.status??[]).filter(p=>p.name==='Tender').reduce((n,p)=>n+number(p.description??'',/lose (\d+) Strength/i,1),0),
    // Vigor: the live hand text includes it for every Attack, but only the next Attack gets it.
    vigor:amount(s.player.status,'Vigor'), vigorSpent:false,
    vicious:amount(s.player.status,'Vicious'),
    // Cruelty: extra percent damage against Vulnerable enemies (status amount is the percent).
    cruelty:amount(s.player.status,'Cruelty'),
    rage: amount(s.player.status,'Rage'), plating: amount(s.player.status,'Plating'), metallicize: amount(s.player.status,'Metallicize'),
    attacks: 0, fan: Boolean(fan), fanProgress, steps: [], warnings,
    // Cloak Clasp: 1 Block per card in hand at end of turn. Charon's Ashes / Forgotten Soul: damage on exhaust.
    orichalcum:(()=>{const r=(s.player?.relics??[]).find(r=>r.id==='ORICHALCUM');return r?number(r.description??'',/without Block, gain (\d+) Block/i,6):0;})(),
    cloakClasp:hasRelic(s,'CLOAK_CLASP'), charonsAshes:hasRelic(s,'CHARONS_ASHES'), forgottenSoul:hasRelic(s,'FORGOTTEN_SOUL'),
    // Letter Opener: every 3rd Skill in a turn deals 5 to all enemies; counter = Skills played this turn.
    letterOpener:letterProgress(s), skills:0,
    ...relicCounters(s, warnings),
    // Smoggy: one Skill per turn. The live hand already reflects Skills played before this plan.
    smoggy:amount(s.player.status,'Smoggy')>0,
    // Unsettling Lamp: the first debuffing card each combat has its debuff doubled; lamp_used comes from the runner.
    lampReady:hasRelic(s,'UNSETTLING_LAMP')&&s.player.lamp_used===false,
    // Unknown interactions stop search expansion; never invent complete outcomes.
    unsupported: false, boundary: null, freeAttack: amount(s.player.status,'Free Attack') > 0,
    originalVulnerable:Object.fromEntries(s.battle.enemies.map(e=>[e.entity_id,amount(e.status,'Vulnerable')])),
    drawCount:s.player.draw_pile_count ?? 0, deck:s.player.deck ?? [],
    fork:(s.player.relics ?? []).find(r=>r.id==='TUNING_FORK')?.counter ?? null, stunned:[],
    cardDamage: 0, removedCharges: 0, extraStrength: 0,
    startBlock: s.player.block ?? 0, exhaustedThisTurn: false,
  };
}

function cost(card, m) {
  if (m.freeAttack && card.type === 'Attack') return 0;
  if (card.cost === 'X') return m.energy;
  const value = Number(card.cost);
  if (!Number.isFinite(value)) return Infinity;
  return Math.max(0, value - (nameOf(card) === 'stomp' ? m.attacks : 0));
}

function available(m, rootState) {
  const virtual = { ...rootState, player: { ...rootState.player, energy:m.energy, hand:m.hand.map((c,i) => ({
    ...c, index:i, can_play: cost(c,m) <= m.energy && !(m.cardsLeft !== null && m.cardsLeft <= 0) && !(m.smoggy && m.skills > 0 && c.type === 'Skill') && (c.can_play || (/energy/i.test(c.unplayable_reason ?? '') && !/BlockedByHook/i.test(c.unplayable_reason ?? ''))),
  })), potions:m.potions }, battle:{...rootState.battle,enemies:m.enemies} };
  return actionsFor(virtual);
}

// Returns the damage after multipliers and caps, before block (what "damage dealt" counts).
function hit(m, enemy, value, attack) {
  if (enemy.hp <= 0) return 0;
  let damage = Math.max(0, value);
  if (attack) {
    // Attack multipliers combine before one rounding down (logged: Iron Wave 5 on a Vulnerable
    // Bygone Effigy with Slow 20 dealt 9 = floor(5 x 1.5 x 1.2)). Percentages keep the arithmetic exact.
    let num = 1, den = 1;
    if (amount(enemy.status,'Vulnerable') > 0) { num *= 150 + (m.cruelty ?? 0); den *= 100; }
    // Slow: its amount is the percent from cards already played this turn; the attack itself is not counted.
    const slow = amount(enemy.status,'Slow');
    if (slow > 0) { num *= 100 + slow; den *= 100; }
    // Flutter: less damage from Attacks while it has charges; each attack hit removes one.
    const flutter = (enemy.status ?? []).find(p => p.name === 'Flutter' && p.amount > 0);
    if (flutter) { num *= 100 - number(flutter.description ?? '', /Receives (\d+)% less damage from Attacks/i, 50); den *= 100; }
    damage = Math.floor(damage * num / den);
  }
  for(const power of enemy.status??[]) {
    const cap=(power.description??'').match(/Reduce all damage taken and HP (?:loss|lost)(?:\s+.*?)?\s+to (\d+)/i);
    if(cap)damage=Math.min(damage,Number(cap[1]));
  }
  const dealt = damage;
  const blocked = Math.min(enemy.block ?? 0, damage);
  enemy.block = (enemy.block ?? 0) - blocked; damage -= blocked;
  const slippery = (enemy.status ?? []).find(p => p.name.toLowerCase() === 'slippery' && p.amount > 0);
  if (damage > 0 && slippery) { damage = 1; slippery.amount--; m.removedCharges++; }
  // Per-turn HP-loss caps (Hardened Shell). Its amount is the HP it can still lose this turn;
  // without it, only this plan's losses count and earlier ones are not observed.
  const capPower = (enemy.status ?? []).find(p => /cannot lose more than (\d+) HP each turn/i.test(p.description ?? ''));
  if (capPower) {
    const left = Number.isInteger(capPower.amount) ? capPower.amount : Number(capPower.description.match(/cannot lose more than (\d+)/i)[1]);
    damage = Math.min(damage, Math.max(0, left - (enemy.lostThisTurn ?? 0)));
    if (!Number.isInteger(capPower.amount)) m.warnings.push(`${enemy.name} has a per-turn HP-loss cap; HP lost earlier this turn is not observed.`);
  }
  const lost = Math.min(enemy.hp, damage); enemy.hp -= lost; m.cardDamage += lost;
  const flutter = attack && (enemy.status ?? []).find(p => p.name === 'Flutter' && p.amount > 0);
  if (flutter && --flutter.amount === 0 && enemy.hp > 0) {
    m.boundary ??= 'enemy_stunned';
    m.warnings.push(`${enemy.name} loses its last Flutter charge and is stunned: re-observe its intent and damage taken.`);
  }
  enemy.lostThisTurn = (enemy.lostThisTurn ?? 0) + lost;
  if (attack && enemy.hp > 0 && !enemy.hit_this_turn) {
    const skittish = (enemy.status ?? []).find(p => p.name?.toLowerCase() === 'skittish');
    if (skittish) enemy.block = (enemy.block ?? 0) + number(skittish.description ?? '', /gains (\d+) Block/i, skittish.amount ?? 0);
  }
  if (attack) enemy.hit_this_turn = true;
  if (m.runes.flyingKick && lost > 0) {
    const rune = m.runes.flyingKick;
    // Native game uses decimal arithmetic. Scaled integer comparison preserves
    // the strict boundary (binary floats can incorrectly execute equal HP).
    const left = enemy.hp * 10000, right = enemy.max_hp * (1000 + 8 * rune.maxHp);
    if(enemy.hp > 0 && (!Number.isSafeInteger(left) || !Number.isSafeInteger(right))) {
      m.unsupported=true;m.boundary='rune_threshold_unknown';
      m.warnings.push('Flying Kick threshold cannot be compared exactly; re-observe instead of predicting execution.');return dealt;
    }
    const executed = enemy.hp > 0 && left < right;
    if (executed || enemy.hp <= 0) {
      if((enemy.status??[]).some(p=>/cannot (?:die|be killed)|prevent.*death|would.*die|reviv|resurrect|transform|when killed|upon dying|on death/i.test(p.description??''))) {
        m.unsupported=true; m.boundary='rune_death_unknown';
        m.warnings.push('Flying Kick reaches a kill threshold, but death prevention, revival or death effects require a fresh observation; execution and healing are uncertain.');
        return dealt;
      }
      if (executed) { m.cardDamage += enemy.hp; enemy.hp = 0; }
      const healed = Math.min(rune.heal, Math.max(0, rune.maxHp - m.hp));
      m.hp += healed;
      m.runeEvents.push({rune:'Flying Kick',enemy:enemy.name,executed,healed,thresholdPercent:rune.thresholdPercent});
    }
  }
  const plow=(enemy.status??[]).find(p=>p.name.toLowerCase()==='plow');
  if(plow && enemy.hp<=plow.amount && !m.stunned.includes(enemy.entity_id)) {
    m.stunned.push(enemy.entity_id);
    enemy.status=enemy.status.filter(p=>!['plow','strength'].includes(p.name.toLowerCase()));
  }
  return dealt;
}

// Slow grows by its percent for every card played this turn; Tender lowers Strength and Dexterity.
function afterCardPlayed(m) {
  for (const e of m.enemies) for (const p of e.status ?? []) if (p.name === 'Slow') p.amount = Number(p.amount ?? 0) + number(p.description ?? '', /receives (\d+)% more damage/i, 10);
  if (m.tender) { m.strengthDelta -= m.tender; m.dexterityDelta -= m.tender; }
}

function applyPower(enemy, name, n) {
  if(enemy.hp<=0)return false;
  enemy.status ??= [];
  const artifact=enemy.status.find(p=>p.name.toLowerCase()==='artifact'&&p.amount>0);
  if(artifact){artifact.amount--;return false;}
  const existing = enemy.status.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.amount += n;
  else enemy.status.push({name,amount:n});
  return true;
}

const STOP_AFTER = {distraction:'random', stoke:'random', 'burning pact':'selection', ashwater:'selection',
  'infernal blade':'random', 'entropic brew':'random', 'secret weapon':'selection', "gambler's brew":'selection',
  brand:'selection', 'glowwater potion':'draw', 'blessing of the forge':'upgrade', "soldier's stew":'upgrade',
  "neow's fury":'selection', 'primal force':'transform', 'power potion':'selection', 'attack potion':'selection', 'skill potion':'selection', 'colorless potion':'selection'};
// Powers whose effects start on later turns (or later in the turn in ways not simulated).
const LATER_ONLY = new Set(['demon form','rupture','unmovable','juggling','stampede','aggression','powdered demise','metamorphosis','barricade','mayhem','stable serum','clarity extract','radiant tincture']);

// Every block gain goes through here. Juggernaut deals its damage (not an Attack) to a random
// enemy per gain: exact with one living enemy, otherwise the plan stops at a random boundary.
function gainBlock(m, n) {
  if (!(n > 0)) return;
  m.block += n;
  if (!m.juggernaut) return;
  const living = m.enemies.filter(e => e.hp > 0);
  if (living.length === 1) hit(m, living[0], m.juggernaut, false);
  else if (living.length > 1) { m.boundary = 'random'; m.warnings.push('Juggernaut hits a random enemy; re-observe enemy HP.'); }
}

// One card leaves the hand to the exhaust pile. Unknown on-exhaust triggers stop the plan.
function exhaustCard(m, card) {
  m.exhaustCount++; gainBlock(m, m.feelNoPain); m.exhaustedThisTurn = true;
  if (m.charonsAshes) for (const e of m.enemies.filter(e => e.hp > 0)) hit(m, e, 3, false);
  if (m.forgottenSoul) {
    const living = m.enemies.filter(e => e.hp > 0);
    if (living.length === 1) hit(m, living[0], 1, false);
    else if (living.length > 1) { m.boundary ??= 'random'; m.warnings.push('Forgotten Soul hits a random enemy; re-observe.'); }
  }
  if (/when(?: this is)? exhausted|whenever you exhaust/i.test(card.description ?? '')) {
    m.unsupported = true; m.boundary = 'unsupported';
    m.warnings.push(`${card.name} has an on-exhaust effect that is not modeled; re-observe.`);
  }
}
// "At random" exhausts are exact only when every eligible card is the same card.
function exhaustRandom(m, eligible, what) {
  const pool = m.hand.filter(eligible);
  if (!pool.length) return;
  const same = pool.every(c => c.name === pool[0].name && c.description === pool[0].description);
  if (!same) { m.boundary = 'random'; m.warnings.push(`${what} exhausts a random card; the remaining hand is re-observed.`); return; }
  m.hand.splice(m.hand.indexOf(pool[0]), 1); exhaustCard(m, pool[0]);
}

function apply(m0, a) {
  const m = structuredClone(m0);
  m.steps.push(a);
  if (a.command.action === 'end_turn') { m.boundary = 'end_turn'; return m; }
  const potion = a.command.action === 'use_potion';
  const item = potion ? m.potions.find(p => p.slot === a.command.slot) : m.hand[a.command.card_index];
  if (!item) return null;
  const name = nameOf(item), text = item.description ?? '';
  if (!(potion ? supportedPotions : supportedCards).has(name)) {
    m.boundary = 'unsupported'; m.unsupported = true;
    m.warnings.push(`Re-observe after ${item.name}; full consequences are not modeled.`);
    return m;
  }
  const replayCount = !potion ? number(text,/\bReplay (\d+)\b/i) : 0;
  // Replay repeats the card's whole effect. Very large counts are left to re-observation.
  if(replayCount>10) {
    m.unsupported=true;m.boundary='unsupported';
    m.warnings.push('Replay count too large to forecast; re-observe.');
    return m;
  }
  const spent = potion ? 0 : cost(item,m);
  if (spent > m.energy) return null;
  m.energy -= spent;
  if (potion) m.potions = m.potions.filter(p => p.slot !== item.slot);
  else m.hand.splice(a.command.card_index,1);
  if (!potion && m.cardsLeft !== null) m.cardsLeft--;
  if(name!=='beckon')m.hp -= number(text,/Lose (\d+) HP/i);
  if (m.hp <= 0) { m.boundary = 'player_dead'; return m; }
  redSkullCheck(m);
  if(name==='restlessness') {
    if(m.hand.length===0) {
      if(!m.noEnergyGain)m.energy+=(text.match(/\[[^\]]*energy_icon[^\]]*\]/g)??[]).length;
      if(!m.noDraw){m.boundary='draw';m.warnings.push('Empty-hand condition met; re-observe unknown drawn cards.');}
    } else m.warnings.push('Empty-hand condition not met: this play grants no draw or energy and gives up retaining the card.');
    return m;
  }
  if(name==="pact's end" && m.exhaustCount<number(text,/If you have (\d+) or more/i,3)) {
    m.warnings.push('Exhaust-pile threshold not met: this card deals no damage.');
    return m;
  }
  const isAttack = !potion && item.type === 'Attack';
  const targets = item.target_type === 'AnyEnemy' ? m.enemies.filter(e => e.entity_id === a.command.target) : m.enemies.filter(e => e.hp > 0);
  // Extra plays: the card's own Replay plus a pending Duplicator or One-Two Punch.
  let plays = 1 + replayCount;
  if (!potion && m.extraNextCard > 0) { plays += m.extraNextCard; m.extraNextCard = 0; }
  if (isAttack && m.extraNextAttack > 0) { plays += m.extraNextAttack; m.extraNextAttack = 0; }
  // Returns true to stop resolving and return the model as it is.
  const resolve = replay => {
  let retaliationHits=0;
  if ((name==='stoke' || name==='glowwater potion') && replay===0) { for (const c of m.hand.splice(0)) exhaustCard(m,c); if(m.unsupported)return true; }
  let fiendFireCount = 0;
  if (name==='fiend fire' && replay===0) { const burned=m.hand.splice(0); fiendFireCount=burned.length; for (const c of burned) exhaustCard(m,c); if(m.unsupported)return true; }
  const bodySlam = name==='body slam' ? text.match(/\(Deals (\d+) damage\)/i) : null;
  if (name==='body slam' && !bodySlam) m.warnings.push('Body Slam current value not shown; Strength is not included.');
  if (name==='sword boomerang' && replay===0 && m.enemies.filter(e=>e.hp>0).length>1) { m.boundary='random'; m.warnings.push('Sword Boomerang hits random enemies; re-observe.'); return false; }
  const damageMatch = name==='flame barrier' || name==='juggernaut' ? null : name==='mind blast' ? [null,String(m.drawCount)]
    : name==='body slam' ? [null,String(Math.max(0,(bodySlam ? Number(bodySlam[1])-m.startBlock : 0)+m.block))] : text.match(/Deal (\d+) damage/i);
  if (damageMatch) {
    let dmg = Number(damageMatch[1]), nib = 1;
    if (isAttack && m.penNib !== null && m.penNib !== undefined) {
      // Pen Nib at 9 doubles the shown damage of every Attack, but only the next one is doubled.
      if (m.penNib === 9) { if (dmg % 2 || m.weakFactor !== 1) m.warnings.push('Pen Nib: undoubled damage may differ by 1.'); dmg = Math.floor(dmg / 2); }
      if ((m.penNib + m.attacks + 1) % 10 === 0) nib = 2;
    }
    if (isAttack) {
      // Hand descriptions already include the player's current Strength/Weak.
      // Add only the change from simulated setup actions, never Strength twice.
      dmg += Math.floor(m.strengthDelta * m.weakFactor);
      // Vigor is shown on every Attack but only the first one gets it.
      if (m.vigor && m.vigorSpent) dmg = Math.max(0, dmg - Math.floor(m.vigor * m.weakFactor));
      else if (m.vigor && (name === 'whirlwind' || /twice|times/i.test(text))) m.warnings.push('Vigor on a multi-hit Attack: whether every hit gets it is not modeled.');
      if (m.weakFactor !== 1 && (m.strengthDelta || targets.some(e => amount(e.status,'Vulnerable')))) {
        m.warnings.push('Weak/Vulnerable rounding may differ by 1 damage per hit.');
      }
      dmg *= nib;
    }
    for (const e of targets) {
      const hits = name === 'whirlwind' ? spent : name==='fiend fire' ? fiendFireCount : name==='sword boomerang' ? number(text,/(\d+) times/i,3) : name==='twin strike' || /Deal \d+ damage twice/i.test(text) ? 2 : name==='spite' ? (m.hp < m.startHp ? 2 : 1) : name==='conflagration' ? number(text,/damage to ALL enemies (\d+) times/i,4) : name === 'dismantle' && amount(e.status,'Vulnerable') > 0 ? 2 : 1;
      retaliationHits=hits;
      const bonus=name==='bully' ? number(text,/Deals (\d+) additional damage/i)*(amount(e.status,'Vulnerable')-(m.originalVulnerable[e.entity_id]??0))
        : name==='ashen strike' ? number(text,/Deals (\d+) additional damage for each card in your Exhaust Pile/i)*m.exhaustCount : 0;
      for (let i=0; i<hits && e.hp>0; i++) {
        const before = {hp:e.hp, block:e.block ?? 0};
        const dealt = hit(m,e,dmg+bonus,isAttack);
        // Fisticuffs: block equal to the damage dealt, block-absorbed damage included (logged: 7 into
        // 14 enemy block gave 7 Block; Vulnerable is included). An overkill is counted as HP plus block.
        if (name==='fisticuffs') {
          const sure = e.hp > 0 ? dealt : Math.min(dealt, before.hp + before.block);
          if (sure < dealt) m.warnings.push('Fisticuffs kill: its block counts only the HP and block removed.');
          gainBlock(m, sure);
        }
        // Omnislice: the other enemies take the damage dealt, through their block (logged: 12 on a
        // Vulnerable target splashed 12; 11 splashed into 15 block left 4). The splash counts the HP the
        // target lost, a lower bound when its block or a kill hides the rest.
        if (name==='omnislice') {
          const splash = before.hp - e.hp;
          if (before.block > 0 || e.hp <= 0) m.warnings.push('Omnislice: splash counts only the HP the target lost.');
          for (const o of m.enemies.filter(o => o !== e && o.hp > 0)) {
            if ((o.status ?? []).some(retaliationRule)) { m.unsupported = true; m.boundary = 'unsupported'; m.warnings.push('Omnislice splash on an enemy with retaliation is not modeled; re-observe.'); return true; }
            if ((o.status ?? []).some(p => /^(vulnerable|slow|flutter)$/i.test(p.name ?? ''))) m.warnings.push('Omnislice splash on a Vulnerable, Slow or Flutter enemy is counted without the multiplier.');
            hit(m, o, splash, false);
          }
        }
      }
    }
  }
  if(isAttack){
    if(m.vigor)m.vigorSpent=true;
    applyRetaliation(m,targets,item,retaliationHits);
    if(m.unsupported||m.hp<=0)return true;
  }
  if (isAttack) {
    m.attacks++; gainBlock(m, m.rage);
    if (m.nunchaku !== null && m.nunchaku !== undefined && (m.nunchaku + m.attacks) % 10 === 0 && !m.noEnergyGain) m.energy += 1;
    if (m.kusarigama !== null && m.kusarigama !== undefined && (m.kusarigama + m.attacks) % m.kusaEvery === 0) {
      const living = m.enemies.filter(e => e.hp > 0);
      if (living.length === 1) hit(m, living[0], m.kusaDamage, false);
      else if (living.length > 1) { m.boundary ??= 'random'; m.warnings.push('Kusarigama hits a random enemy; re-observe.'); }
    }
    if(m.freeAttack) { m.freeAttack=false; m.boundary='free_attack_consumed'; m.warnings.push('Re-read card costs after consuming Free Attack.'); }
    if (m.fan && m.fanProgress !== null && (m.fanProgress + m.attacks) % 3 === 0) gainBlock(m, 4);
  }
  if (!potion && item.type === 'Skill') {
    m.skills++;
    if (m.letterOpener !== null && m.letterOpener !== undefined && (m.letterOpener + m.skills) % 3 === 0)
      for (const e of m.enemies.filter(e => e.hp > 0)) hit(m, e, 5, false);
  }
  if (name==='thrash') exhaustRandom(m, c=>c.type==='Attack', 'Thrash');
  if (name==='cinder') exhaustRandom(m, ()=>true, 'Cinder');
  if (m.unsupported) return true;
  if(!potion && item.type==='Skill' && m.fork!==null) { m.fork++; if(m.fork%10===0)gainBlock(m,7); }
  if(name==='flame barrier')m.warnings.push('Immediate block included; retaliation damage and any kills during enemy attacks are omitted. Incoming may be overestimated.');
  if(name==='fortifier')m.block*=3;
  if(name==='colossus')m.colossus=true;
  // Frantic Escape ("Increase Sandpit by 1") pushes back a death countdown on the enemy; it has no effect this turn.
  if(name==='frantic escape'){const [,power,n]=text.match(/Increase (.+?) by (\d+)/i)??[];
   for(const e of m.enemies.filter(e=>e.hp>0))for(const p of e.status??[])if(power&&p.name.toLowerCase()===power.toLowerCase())p.amount=Number(p.amount)+Number(n);}
  // Expect a Fight: the older text gave energy per Attack in hand. The current text is block only
  // (15 + 5 per Strength, handled with other block below); a Sown copy shows "Gain [energy]." until its
  // first play in combat (logged: 3 energy, cost 3, left 1 with the sentence and 0 without it).
  if(name==='expect a fight'){
    if(/for each Attack in your Hand/i.test(text)){if(!m.noEnergyGain)m.energy+=m.hand.filter(c=>c.type==='Attack').length;}
    else if(!m.noEnergyGain)m.energy+=[...text.matchAll(/(?:^|\.\s+)Gain ((?:\[[^\]]*energy_icon[^\]]*\])+)(?=\.|$)/gi)].reduce((n,x)=>n+x[1].match(/energy_icon/g).length,0);
    if(/cannot gain additional/i.test(text))m.noEnergyGain=true;
  }
  if(name==='unrelenting')m.freeAttack=true;
  // Rage's text describes block on subsequent attacks, not block on cast.
  if(name==='pyre')m.warnings.push('Pyre grants energy at the start of future turns, not when played; no immediate energy or protection is forecast.');
  if(name==='relax')m.warnings.push('Relax draw and energy arrive next turn, not now. They cannot rescue lethal incoming damage this turn.');
  if(name==='toric toughness')m.warnings.push('Only immediate Toric Toughness block is included; later-turn block does not prevent damage this turn.');
  if(name==='stone armor')m.plating+=number(text,/Gain (\d+) Plating/i);
  if (name === 'juggernaut') m.juggernaut += number(text,/deal (\d+) damage/i);
  else if (name === 'crimson mantle') m.warnings.push('Crimson Mantle block arrives at the start of later turns, not this turn.');
  else if (name === 'feel no pain') m.feelNoPain+=number(text,/gain (\d+) Block/i);
  else if (name === 'rage') m.rage += number(text,/gain (\d+) Block/i);
  // Second Wind: exhausts every non-Attack in hand, block per card (logged: one Power exhausted gave 7).
  else if (name === 'second wind') {
    const burned = m.hand.filter(c => c.type !== 'Attack'); m.hand = m.hand.filter(c => c.type === 'Attack');
    for (const c of burned) { exhaustCard(m, c); if (m.unsupported) return true; gainBlock(m, Math.max(0, number(text,/Gain (\d+) Block for each/i) + Math.floor(m.dexterityDelta*m.frailFactor))); }
  }
  else {
    const baseBlock=number(text,/Gain (\d+) Block/i);
    // The shown block includes current Strength; add only Strength changed in this plan.
    const perStrength=number(text,/Gains? (\d+) additional Block for each Strength/i)*m.strengthDelta;
    if(baseBlock) gainBlock(m, Math.max(0, baseBlock + perStrength + (!potion ? Math.floor(m.dexterityDelta*m.frailFactor) : 0)));
    if(name==='evil eye') {
      if(m.exhaustedThisTurn) gainBlock(m, number(text,/Gain another (\d+) Block/i) + Math.floor(m.dexterityDelta*m.frailFactor));
      else m.warnings.push('Evil Eye bonus counts only exhausts in this plan; an exhaust earlier this turn may add more block.');
    }
  }
  if(potion && ['dexterity potion','speed potion','fysh oil'].includes(name)) {
    m.dexterityDelta += number(text,/(?:Gain|and) (\d+) Dexterity/i);
    m.warnings.push('Dexterity affects subsequent block cards, not existing block. Temporary Dexterity only benefits cards played before it expires.');
    if(m.frailFactor!==1)m.warnings.push('Frail rounding on simulated Dexterity may differ by 1 block.');
  }
  // Strength loss this turn lowers each displayed enemy hit (after Weak when the enemy is Weak).
  if(name==='lucky tonic')m.buffer+=number(text,/Gain (\d+) Buffer/i,1);
  if(name==='fruit juice'){const n=number(text,/Gain (\d+) Max HP/i);m.maxHp+=n;m.hp+=n;}
  if(name==='heart of iron')m.plating+=number(text,/Gain (\d+) Plating/i);
  if(['forgotten ritual','radiant tincture','cure all'].includes(name)&&!m.noEnergyGain)m.energy+=((text.match(/^Gain ((?:\[[^\]]*energy_icon[^\]]*\])+)/i)??[,''])[1].match(/energy_icon/g)??[]).length;
  if(name==='duplicator')m.extraNextCard+=1;
  if(name==='one-two punch')m.extraNextAttack+=1;
  if(name==='beetle juice')for(const e of targets)e.damageFactor=(e.damageFactor??1)*(1-number(text,/deal (\d+)% less damage/i,30)/100);
  if(name==='regen potion'&&m.maxHp){m.hp=Math.min(m.maxHp,m.hp+number(text,/Gain (\d+) Regen/i));m.warnings.push('Regen heals at the end of this turn and then decays; later turns are not forecast.');}
  if(LATER_ONLY.has(name))m.warnings.push(`${item.name}: its effect starts later and is not in this turn's numbers.`);
  if(STOP_AFTER[name]){m.boundary=STOP_AFTER[name];m.warnings.push(`${item.name} adds or chooses unknown cards; re-observe before continuing.`);}
  // Mangle: the target loses Strength this turn, a debuff (logged: Attack 20 became 10 after Mangle's 10).
  if(name==='mangle'){const n=number(text,/loses (\d+) Strength this turn/i);for(const e of targets)if(applyPower(e,'Mangle',n))e.strengthLoss=(e.strengthLoss??0)+n;}
  // Fight Me!: the enemy's Strength gain raises each of its hits (logged: 6x2 became 7x2).
  if(name==='fight me!'){const n=number(text,/enemy gains (\d+) Strength/i);for(const e of targets.filter(e=>e.hp>0))e.strengthLoss=(e.strengthLoss??0)-n;}
  if(name==='shackling potion'){const n=number(text,/lose (\d+) Strength/i);for(const e of m.enemies.filter(e=>e.hp>0))e.strengthLoss=(e.strengthLoss??0)+n;}
  if(name==='flex potion')m.warnings.push('Temporary Strength applies only to attacks before this turn ends; no future-turn benefit is forecast.');
  const gainStrength = name==='dominate'||name==='rupture'?0:number(text,/Gain (\d+) Strength/i);
  m.strengthDelta += gainStrength; m.extraStrength += gainStrength;
  if (name === 'energy potion' || name === 'bloodletting') {
    const icons = (text.match(/\[[^\]]*energy_icon[^\]]*\]/g) ?? []).length;
    const gain = number(text,/Gain (\d+) Energy/i,icons);
    if (!gain) { m.unsupported = true; m.warnings.push('Energy gain amount could not be parsed.'); }
    if(!m.noEnergyGain)m.energy += gain;
    if(name==='bloodletting' && m.hand.length===0)m.warnings.push('Bloodletting leaves an empty hand: added energy cannot play another card without a separate draw or card-generation effect. HP cost is paid immediately.');
  }
  if(name==='bloodletting' && /Gain \d+ Tainted/i.test(text)) {
    m.unsupported=true;m.boundary='unsupported';
    m.warnings.push('Bloodletting energy and HP cost are included, but added Tainted consequences require a fresh observation.');
  }
  if (name === 'offering' && !m.noEnergyGain) m.energy += number(text,/Gain (\d+) Energy/i,(text.match(/\[[^\]]*energy_icon[^\]]*\]/g)??[]).length);
  if (!potion && replay===0 && /(?:^|[.!]\s*)Exhaust\.?$/i.test(text.trim())) {gainBlock(m,m.feelNoPain);m.exhaustCount++;m.exhaustedThisTurn=true;}
  if(name==='armaments'){m.boundary='upgrade';m.warnings.push('Armaments block is included; re-observe card upgrades before continuing.');}
  // Unsettling Lamp doubles the first debuffing card of the combat (Weak and Vulnerable are modeled).
  const lamp = !potion && m.lampReady && /Apply \d+ /i.test(text) ? 2 : 1;
  if (lamp === 2) { m.lampReady = false; if (/Apply \d+ (?!Weak|Vulnerable)/i.test(text)) m.warnings.push(`Unsettling Lamp doubles ${item.name}; only its Weak and Vulnerable are modeled.`); }
  for (const e of targets) {
    const weak = number(text,/Apply (\d+) Weak/i)*lamp, vuln = number(text,/Apply (\d+) Vulnerable/i)*lamp;
    if (weak) applyPower(e,'Weak',weak);
    let applied=false;
    if (vuln) applied=applyPower(e,'Vulnerable',vuln);
    if(name==='molten fist' && amount(e.status,'Vulnerable')>0)applied=applyPower(e,'Vulnerable',amount(e.status,'Vulnerable'));
    if(name==='dominate'){
      const gain=number(text,/Gain (\d+) Strength/i)*amount(e.status,'Vulnerable');
      m.strengthDelta+=gain;m.extraStrength+=gain;
    }
    if(applied && m.vicious>0 && !m.noDraw){m.boundary='draw';m.warnings.push('Vicious draws unknown cards: re-observe before continuing.');}

  }
  if(name==='cruelty')m.cruelty+=number(text,/additional (\d+)% damage/i,25);
  if(name==='vicious')m.vicious+=number(text,/draw (\d+) card/i,1);
  if(name==='spite' && m.hp >= m.startHp)m.warnings.push('Spite: HP lost earlier this turn is not observed; it may hit twice.');
  if(name==='blood potion' && m.maxHp)m.hp=Math.min(m.maxHp,m.hp+Math.floor(m.maxHp*number(text,/Heal for (\d+)%/i,20)/100));
  if(name==='pillage' && !m.noDraw){m.boundary='draw';m.warnings.push('Pillage draws unknown cards: re-observe before continuing.');}
  if(name==='headbutt'){m.boundary='selection';m.warnings.push('Headbutt damage is included; re-observe the discard-to-top choice before continuing.');}
  if(name==='true grit'){gainBlock(m,m.feelNoPain);m.exhaustCount++;m.exhaustedThisTurn=true;m.boundary='selection';m.warnings.push('True Grit block and one exhaust are included; the exhausted card is re-observed.');}
  if (name!=='vicious' && name!=='relax' && !m.noDraw && /Draw \d+ cards?/i.test(text)) { m.boundary = 'draw'; m.warnings.push('Stops before unknown drawn cards; re-observe before continuing.'); }
  if(name==='battle trance')m.noDraw=true;
  if(!potion && m.unmovable && /Gain \d+ Block/i.test(text) && name!=='rage' && name!=='feel no pain'){m.boundary='block_modifier_consumed';m.warnings.push('Re-read live block values after Unmovable: first-card doubling must not be reused.');}
  if(!potion && /\bBound\b/.test(text)){m.boundary='bound_card_played';m.warnings.push('Bound card played: re-observe remaining card legality before continuing.');}
  if(!potion && m.ringing){m.boundary='card_play_limit';m.warnings.push('A visible power limits card plays; re-observe legality after this card instead of assuming remaining plays.');}
  return false;
  };
  for (let replay = 0; replay < plays; replay++) {
    // A draw does not stop the replay (its own effect does not depend on the drawn cards);
    // a random or choice boundary does.
    if (replay && (m.hp <= 0 || m.enemies.every(e => e.hp <= 0) || m.unsupported || (m.boundary && m.boundary !== 'draw'))) break;
    if (replay) m.warnings.push(`${item.name} is played again (Replay or an extra-play effect).`);
    if (resolve(replay)) return m;
    redSkullCheck(m);
    // "Whenever you play a card" effects fire after each play, extra plays included (logged: Tender
    // lowered the second One-Two Punch play of Molten Fist from 10 to 9).
    if (!potion) afterCardPlayed(m);
  }
  // A departure is not a kill: do not trigger the minion's on-death effects.
  const minionRule=e=>(e.status??[]).some(p=>/^Minions abandon combat without their leader\.?$/i.test((p.description??'').trim()));
  const leaders=m.enemies.filter(e=>!minionRule(e));
  const leaderDeathUncertain=leaders.some(e=>(e.status??[]).some(p=>/when killed|upon dying|on death|when this dies|would be defeated|reviv|resurrect|transform/i.test(p.description??'')&&!laterDeathRule(p.description??'',false)));
  if(leaders.length===1 && leaders[0].hp<=0 && !leaderDeathUncertain && !m.unsupported){
    for(const e of m.enemies.filter(e=>e.hp>0 && minionRule(e))){e.hp=0;e.departedWithLeader=leaders[0].entity_id;}
  }
  // An empty board (a boss between revives) is not a win: nothing was killed.
  if (m.enemies.length && m.enemies.every(e => e.hp <= 0)) {
    const deathEffects=m.enemies.filter(e=>!e.departedWithLeader).flatMap(e=>(e.status??[]).filter(p=>deathRuleText.test(p.description??'')));
    m.boundary=deathEffects.length?'death_effect':'combat_won';
    const unresolved=deathEffects.filter(p=>!laterDeathRule(p.description??'',false));
    for(const e of m.enemies)for(const p of e.status??[])if(deathEffects.includes(p)&&!unresolved.includes(p))
      m.warnings.push(`${e.name} is stunned, not defeated: ${p.description} The fight continues.`);
    if(unresolved.length){m.deathUnresolved=true;m.warnings.push('Enemy death triggers remain unresolved: do not assume victory or survival. Re-observe the death effect.');}
  }
  if (m.hp <= 0) m.boundary = 'player_dead';
  return m;
}

function unknownRuneForecast(rules) {
  return {quality:'unknown',damage:null,block:null,incoming:null,hpLoss:null,hpAfter:null,survives:null,energyLeft:null,
    defeatedEnemies:null,bossStunned:null,runeEffects:null,
    warnings:['Active Hextech rules are supplied to Jev; exact arithmetic is unavailable for '+rules.map(r=>r.name).join(', ')+'. Execute one live legal action, then re-observe.']};
}

function forecast(m, s) {
  if(m.unsupportedRunes.length)return unknownRuneForecast(m.unsupportedRunes);
  let incoming = 0, parsed = true; const hitList = [], hitMaxHp = [];
  for (const e of m.enemies.filter(e => e.hp > 0)) {
    if(m.stunned.includes(e.entity_id))continue;
    const before = s.battle.enemies.find(x => x.entity_id === e.entity_id);
    for (const intent of e.intents ?? []) {
      if (!/attack|deathblow/i.test(intent.type) && !/attack.*\d+ damage/i.test(intent.description??'')) continue;
      const match = String(intent.label).trim().match(/^(\d+)(?:\s*[x×]\s*(\d+))?(?:\s*\(\d+\))?$/i);
      if (!match) { parsed = false; continue; }
      let perHit = Number(match[1]);
      if (e.damageFactor) perHit = Math.floor(perHit * e.damageFactor);
      if (e.strengthLoss) {
        const weak = amount(before?.status,'Weak') > 0;
        perHit = Math.max(0, perHit - (weak ? Math.floor(e.strengthLoss*.75) : e.strengthLoss));
        if (weak) m.warnings.push('Strength loss on a Weak enemy may differ by 1 damage per hit.');
      }
      if (amount(before?.status,'Weak') === 0 && amount(e.status,'Weak') > 0) perHit = Math.floor(perHit*.75);
      // Halve only what the displayed intent does not already include: Colossus played in this plan,
      // or an active Colossus against an enemy made Vulnerable in this plan.
      if((m.colossus||m.colossusStart) && amount(e.status,'Vulnerable')>0 && !(m.colossusStart && (m.originalVulnerable[e.entity_id]??0)>0))perHit=Math.floor(perHit*.5);
      incoming += perHit * Number(match[2] ?? 1);
      // Paper Cuts: each unblocked hit from this enemy also costs Max HP.
      const maxHpPerHit = (e.status??[]).reduce((n,p)=>n+number(p.description??'',/deals unblocked attack damage to you, you lose (\d+) Max HP/i),0);
      for (let i = 0; i < Number(match[2] ?? 1); i++) { hitList.push(perHit); hitMaxHp.push(maxHpPerHit); }
    }
  }
  const defeatedEnemies = s.battle.enemies.filter(e=>e.hp>0 && m.enemies.some(after=>after.entity_id===e.entity_id && after.hp<=0 && !after.departedWithLeader)).map(e=>({
    id:e.entity_id,name:e.name,
    attackRemoved:(e.intents??[]).reduce((sum,i)=>{
      if(!/attack|deathblow/i.test(i.type??'') && !/attack.*\d+ damage/i.test(i.description??''))return sum;
      const hit=String(i.label??'').trim().match(/^(\d+)(?:\s*[x×]\s*(\d+))?(?:\s*\(\d+\))?$/i);
      return hit && sum!==null ? sum+Number(hit[1])*Number(hit[2]??1) : null;
    },0),
    deathRules:(e.status??[]).filter(p=>deathRuleText.test(p.description??'')).map(p=>p.description),
  }));
  // Orichalcum: ending the turn with no Block from cards gives its Block before the enemy attacks.
  const orichalcumBlock = m.orichalcum && m.block === 0 ? m.orichalcum : 0;
  const block = (m.block + m.plating) * (m.runes.grounded ? 2 : 1) + m.metallicize + (m.cloakClasp ? m.hand.length : 0) + orichalcumBlock;
  const positioningUnknown = [...(s.player.status??[]),...s.battle.enemies.flatMap(e=>e.status??[])].some(p=>/from behind|orientation/i.test(p.description??''));
  const lethalTurnRule=m.enemies.filter(e=>e.hp>0&&!m.stunned.includes(e.entity_id)).flatMap(e=>e.status??[]).some(p=>/takes? (?:its|their) turn.*(?:you.*die|kill you)/i.test(p.description??''));
  const facingProjection=positioningUnknown?facingDamage(s,m.steps,m.enemies):null;
  // Weak and Vulnerable applied in this prefix are handled by facingDamage; other status changes still void the projection.
  const facingStatus=st=>JSON.stringify((st??[]).filter(p=>!/^(weak|vulnerable)$/i.test(p.name??"")));
  const facingEffectsChanged=m.enemies.some(e=>facingStatus(e.status)!==facingStatus(s.battle.enemies.find(x=>x.entity_id===e.entity_id)?.status));
  const facingUsable=facingProjection&&!facingEffectsChanged&&!m.unsupported;
  if(facingUsable)incoming=facingProjection.incomingMax;
  const uncertain = m.unsupportedRunes.length > 0 || lethalTurnRule || (positioningUnknown&&!facingUsable) || m.unsupported || m.deathUnresolved || defeatedEnemies.some(e=>e.deathRules.some(r=>!laterDeathRule(r,m.enemies.some(x=>x.hp>0)))) || !parsed;
  // Player debuffs that deal damage at the end of the turn (Disintegration; Constrict while its
  // source is alive). Damage, so Block reduces it, like the hand cards below.
  const endTurnStatusDamage = m.enemies.some(e=>e.hp>0) ? (s.player.status??[]).reduce((sum,p)=>{
    const d=(p.description??'').match(/^(?:While (?:the )?(.+?) is alive, )?at the end of your turn, take (\d+) damage\.?$/i);
    if(!d)return sum;
    if(d[1]&&!m.enemies.some(e=>e.hp>0&&e.name?.toLowerCase().includes(d[1].toLowerCase())))return sum;
    return sum+Number(d[2]);
  },0) : 0;
  const endTurnCardDamage = endTurnStatusDamage + (m.enemies.some(e=>e.hp>0) ? m.hand.reduce((sum,c)=>sum+(/At the end of your turn, if this is in your Hand, take (\d+) damage/i.test(c.description??'') ? number(c.description,/take (\d+) damage/i) : 0),0) : 0);
  const endTurnCardHpLoss = m.enemies.some(e=>e.hp>0) ? m.hand.reduce((sum,c)=>sum+number(c.description,/At the end of your turn, if this is in your Hand,\s+lose (\d+) HP/i),0) : 0;
  // Buffer cancels whole HP-loss events, so with Buffer the loss is counted event by event:
  // held-card HP loss first, then end-of-turn card damage, then each enemy hit through block.
  const bufferedLoss = () => {
    let buffer = m.buffer, left = block, loss = 0;
    const lose = n => { if (n <= 0) return; if (buffer > 0) buffer--; else loss += n; };
    for (const c of m.hand) lose(number(c.description ?? '', /At the end of your turn, if this is in your Hand,\s+lose (\d+) HP/i));
    for (const h of [endTurnCardDamage, ...(facingUsable ? [incoming] : hitList)]) { const through = Math.max(0, h - left); left = Math.max(0, left - h); lose(through); }
    return loss;
  };
  // Crimson Mantle costs HP at the start of the next turn (after the enemy turn), whether or not it was played this turn.
  const mantleText=[...(s.player.status??[]),...m.steps.filter(x=>x.command.action==='play_card').map(x=>x.details??{})].filter(p=>String(p.name??'').replace(/\+$/,'').toLowerCase()==='crimson mantle').map(p=>p.description??'');
  // An empty board (a boss between revives) means the fight goes on.
  const fightContinues=!m.enemies.length||m.enemies.some(e=>e.hp>0);
  const mantleLoss=fightContinues?mantleText.reduce((n,d)=>n+number(d,/lose (\d+) HP/i),0):0;
  const projectedLoss = mantleLoss + (m.buffer > 0 && m.enemies.some(e=>e.hp>0) ? bufferedLoss() : endTurnCardHpLoss + Math.max(0,incoming+endTurnCardDamage-block));
  // Regen already active heals at the end of this turn, before the enemy attacks.
  const regenHeal = fightContinues ? Math.max(0, Math.min(amount(s.player.status,'Regen'), (m.maxHp ?? m.hp) - m.hp)) : 0;
  // Max HP lost to unblocked hits (Paper Cuts) is permanent: it counts in hpLoss at least like HP.
  let maxHpLoss = 0;
  if (!facingUsable && hitMaxHp.some(n=>n>0)) { let left = Math.max(0, block - endTurnCardDamage); hitList.forEach((h,i)=>{ if (h > left) maxHpLoss += hitMaxHp[i]; left = Math.max(0, left - h); }); }
  const loss = Math.max(0,s.player.hp-m.hp + projectedLoss - regenHeal) + maxHpLoss;
  const warnings = [...new Set(m.warnings)];
  if(!m.enemies.length)warnings.push('No enemy is on the board: one may revive or arrive. Attacks have no target; keep potions.');
  if(m.unsupportedRunes.length)warnings.push('Active Hextech effects require live rule interpretation: '+m.unsupportedRunes.map(r=>r.name).join(', ')+'. Numeric outcomes are unknown; use a single legal action and re-observe.');
  if(lethalTurnRule)warnings.push('A visible rule says the enemy taking its turn kills you regardless of ordinary block. Attack-only HP estimates cannot establish survival; prevent that turn using a supported kill or stated interruption.');
  if(positioningUnknown&&!facingUsable)warnings.push('Position-dependent incoming damage is not modeled; targeting can change orientation. Survival is uncertain.');
  if (!parsed) warnings.push('Some incoming attacks could not be parsed.');
  return {
    ...(facingUsable?{facingProjection}:{}),
    ...(positioningUnknown?{facingReview:{lastTargetedAction:[...m.steps].reverse().find(a=>a.command?.target)??null,note:facingUsable?'Use facingProjection for the candidate final direction; incoming uses its conservative upper bound. Facing evidence comes from executed actions; re-observe after every action.':'Visible rules say targeting changes orientation. Compare the final target with each surviving attacker before ending. Current facing and unmodified attack values are not supplied, so do not multiply displayed intents again or assume exact damage after turning. Reserve an affordable targeted card or potion when a final turn can reduce incoming damage; re-observe live intents after it. Untargeted block or area damage is not evidence of turning.'}}:{}),
    damage: m.unsupported || m.unsupportedRunes.length ? null : m.cardDamage,
    block: m.unsupported || m.unsupportedRunes.length ? null : block,
    incoming: parsed ? incoming : null,
    endTurnCardDamage, endTurnCardHpLoss, ...(maxHpLoss?{maxHpLoss}:{}),
    defeatedEnemies,
    retaliationEvents:m.retaliationEvents,
    runeEffects:{grounded:m.runes.grounded,extraBlock:m.runes.grounded?m.block+m.plating:0,events:m.runeEvents},
    departedMinions:m.enemies.filter(e=>e.departedWithLeader).map(e=>({id:e.entity_id,name:e.name,leader:e.departedWithLeader,reason:'Visible rule: abandons combat without its leader; departure is not a death.'})),
    delayedDeathEffects:m.enemies.filter(e=>!e.departedWithLeader).flatMap(e=>(e.status??[]).filter(p=>/when killed|upon dying|on death|when this dies|would be defeated|revives?/i.test(p.description??'')).map(p=>({enemy:e.name,rule:p.description,note:'Not included in current-turn attack total; death may not end combat.'}))),
    hpLoss: uncertain ? null : loss,
    hpAfter: uncertain ? null : Math.max(0,m.hp+regenHeal-projectedLoss),
    survives: uncertain ? null : m.hp+regenHeal > projectedLoss,
    bossStunned:m.stunned.length>0, bossThresholds:m.enemies.flatMap(e=>(e.status??[]).filter(p=>p.name.toLowerCase()==='plow').map(p=>({enemy:e.name,damageToStun:Math.max(0,e.hp-p.amount)}))),
    energyLeft:m.unsupported || m.unsupportedRunes.length ? null : m.energy, slipperyRemoved:m.removedCharges, strengthGained:m.extraStrength,
    // Powers keep working after this turn; the numbers above cover this turn only.
    lastingEffects:m.steps.filter(x=>x.command.action==='play_card'&&x.details?.type==='Power').map(x=>`${x.details.name}: ${x.details.description}`),
    notModeled:[...(m.unsupported&&m.steps.length?[m.steps.at(-1).details?.name??m.steps.at(-1).label]:[]),...m.unmodeled.map(x=>`${x.kind}: ${x.name}`)],
    quality:uncertain?'unknown':warnings.length?'partial':'calculated',
    boundary:m.boundary, warnings,
    assumption:'Forecast if this prefix is followed by ending the turn. Known-effects estimate; unmodeled interactions are omitted when marked partial. Displayed damage intents and explicit end-of-turn damage from remaining hand; no prediction of hidden draws or future turns. Extra block from an unavailable Fan counter is omitted.',
  };
}

function preference(m,s,kind) {
  const f=forecast(m,s);
  if(f.quality==='unknown')return -10000;
  if(kind!=='setup')return forecastPreference(f,m.steps,kind);
  const safety=(f.survives?0:-10000)+(m.boundary==='combat_won'?20000:0);
  const potionsUsed=m.steps.filter(a=>a.command.action==='use_potion').length;
  return safety+m.energy*8+f.strengthGained*8+m.rage*3+f.slipperyRemoved*4-f.hpLoss*2-potionsUsed*2;
}
// The attack, defense and conserve scores the plan selection ranks by, from a forecast and its plan
// steps. Live engine pruning (integration/sts2/sim-live.mjs) applies the same scores to engine forecasts.
export const SELECTION_KINDS=['attack','defense','conserve'];
export function forecastPreference(f,plan,kind) {
  if(f.quality==='unknown')return -10000;
  const safety=(f.survives?0:-10000)+(f.boundary==='combat_won'?20000:0);
  const potionsUsed=plan.filter(a=>a.command?.action==='use_potion').length;
  const strength=f.strengthGained??0,slippery=f.slipperyRemoved??0;
  if(kind==='conserve')return safety+f.damage*2-f.hpLoss*8+slippery*5-potionsUsed*18;
  if(kind==='defense')return safety-f.hpLoss*20+f.damage+strength*2;
  return safety+f.damage*3+slippery*6-f.hpLoss*5+strength*5;
}

// Bounded search proposes options; Jev alone chooses among them. Keep every
// immediate legal action plus diverse continuations for each first action.
// extra (live engine forecasts only): up to that many more multi-step plans, the next-best per first
// action and selection kind after the planner's own picks, appended with extra: true. Default 0: the
// planner's set, unchanged.
export function planCandidates(s, { maxDepth=6, beamWidth=256, maxPlans=64, extra=0 }={}) {
  const roots=actionsFor(s);
  if(!s.battle || !s.player?.hand)return roots;
  const start=initial(s), singles=roots.map(a=>apply(start,a)).filter(Boolean);
  let frontier=singles, all=[...singles], expanded=0;
  for(let depth=1;depth<maxDepth;depth++) {
    const next=[];
    for(const m of frontier) {
      if(m.boundary)continue;
      for(const a of available(m,s)) {
        if(++expanded>6000)break;
        const child=apply(m,a);if(child)next.push(child);
      }
      if(expanded>6000)break;
    }
    all.push(...next);
    const groups=[];
    // Preserve exploration from each original action, including potions.
    for(const root of roots) {
      const group=next.filter(m=>m.steps[0].id===root.id);
      const kept=[];
      for(const kind of ['attack','defense','setup','conserve']) {
        for(const best of group.toSorted((a,b)=>preference(b,s,kind)-preference(a,s,kind)).slice(0,2))
          if(!kept.includes(best))kept.push(best);
      }
      groups.push(kept);
    }
    frontier=[];
    for(let i=0;i<8;i++) for(const group of groups) if(group[i] && frontier.length<beamWidth)frontier.push(group[i]);
    if(!frontier.length || expanded>6000)break;
  }
  const selected=[...singles], seen=new Set(singles.map(m=>JSON.stringify(m.steps.map(a=>a.command))));
  const ranked=new Map();
  for(const kind of SELECTION_KINDS) for(const root of roots) {
    const group=all.filter(m=>m.steps.length>1 && m.steps[0].id===root.id).toSorted((a,b)=>preference(b,s,kind)-preference(a,s,kind));
    ranked.set(kind+'|'+root.id,group);
    for(const m of group) {
      const key=JSON.stringify(m.steps.map(a=>a.command));
      if(seen.has(key))continue;
      if(selected.length>=Math.max(maxPlans,singles.length))break;
      seen.add(key);selected.push(m);break;
    }
  }
  const extras=[];
  // Round-robin over (kind, first action), taking each group's next plan not yet chosen.
  const cursor=new Map();
  for(let progress=true;extras.length<extra&&progress;){
    progress=false;
    for(const kind of SELECTION_KINDS) for(const root of roots) {
      if(extras.length>=extra)break;
      const group=ranked.get(kind+'|'+root.id)??[];let i=cursor.get(kind+'|'+root.id)??0;
      while(i<group.length&&seen.has(JSON.stringify(group[i].steps.map(a=>a.command))))i++;
      if(i<group.length){seen.add(JSON.stringify(group[i].steps.map(a=>a.command)));extras.push(group[i]);progress=true;i++;}
      cursor.set(kind+'|'+root.id,i);
    }
  }
  const candidate=(m,i,isExtra)=>({
    id:`p${i}`,command:m.steps[0].command,label:m.steps.map(a=>a.label).join(' → '),
    details:m.steps[0].details,
    plan:m.steps.map(a=>({label:a.label,command:a.command})), forecast:forecast(m,s),
    ...(isExtra?{extra:true}:{}),
  });
  return [...selected.map((m,i)=>candidate(m,i,false)),...extras.map((m,i)=>candidate(m,selected.length+i,true))];
}

// Offline opt-in: rebuild complete plans with Rage before attacks, preserving
// original card identity as hand indices shift. Baseline candidates are untouched.
export function withRageReorders(s,candidates,{maxExtra=16}={}) {
  const added=[],seen=new Set(candidates.map(c=>JSON.stringify(c.plan?.map(p=>p.command))));
  for(const candidate of candidates){
    if(added.length>=maxExtra)break;
    if(!candidate.plan || candidate.plan.length<2)continue;
    let m=initial(s);const identities=[];let valid=true;
    for(const step of candidate.plan){
      if(m.boundary){valid=false;break;}
      const a=available(m,s).find(a=>JSON.stringify(a.command)===JSON.stringify(step.command));
      if(!a){valid=false;break;}
      identities.push({action:a.command.action,source:a.details?.sourceIndex,target:a.command.target,slot:a.command.slot,name:a.details?.name,type:a.details?.type});
      m=apply(m,a);if(!m){valid=false;break;}
    }
    if(!valid)continue;
    const index=identities.findIndex(a=>a.action==='play_card'&&a.name?.replace(/\+$/,'')==='Rage');
    if(index<1||!identities.slice(0,index).some(a=>a.type==='Attack'))continue;
    const ordered=[identities[index],...identities.filter((_,i)=>i!==index)];m=initial(s);
    for(const id of ordered){
      if(m.boundary){valid=false;break;}
      const a=available(m,s).find(a=>a.command.action===id.action && (id.action==='play_card'?a.details?.sourceIndex===id.source&&a.command.target===id.target:id.action==='use_potion'?a.command.slot===id.slot&&a.command.target===id.target:true));
      if(!a){valid=false;break;}m=apply(m,a);if(!m){valid=false;break;}
    }
    if(!valid)continue;
    const key=JSON.stringify(m.steps.map(a=>a.command));if(seen.has(key))continue;
    seen.add(key);let id='rage-reorder-'+added.length;while(candidates.some(c=>c.id===id))id+='x';
    added.push({id,command:m.steps[0].command,label:m.steps.map(a=>a.label).join(' → '),details:m.steps[0].details,plan:m.steps.map(a=>({label:a.label,command:a.command})),forecast:forecast(m,s),reorderedFrom:candidate.id});
  }
  return [...candidates,...added];
}

export function projectSequence(s, labels) {
  let m=initial(s);
  for(const label of labels) {
    if(m.boundary)throw new Error(`Cannot project past ${m.boundary}`);
    const action=available(m,s).find(a=>a.label===label);
    if(!action)throw new Error(`Action not available: ${label}`);
    m=apply(m,action);
  }
  return forecast(m,s);
}

// Projections for reviews (card order, first-action benefit). In live mode, when any candidate carries
// an engine forecast, both sides of a comparison must come from the engine: the forecast of the
// candidate whose plan is exactly these labels (a trailing End turn aside), never the planner's own
// projection. Without such a candidate the projection is unknown. Otherwise, projectSequence.
// Whether two forecasts come from the same source (live engine or planner); reviews compare only those.
export const forecastSource=f=>f?.source==='engine'?'engine':'planner';
export const sameForecastSource=(a,b)=>forecastSource(a)===forecastSource(b);
export const engineForecasts=candidates=>(candidates??[]).some(c=>c.forecast?.source==='engine');
const planLabels=c=>{const steps=c.plan??[{label:c.label,command:c.command}];return (steps.at(-1)?.command?.action==='end_turn'&&steps.length>1?steps.slice(0,-1):steps).map(p=>p.label);};
export function candidateProjection(s,labels,candidates) {
  if(!engineForecasts(candidates))return projectSequence(s,labels);
  const key=JSON.stringify(labels);
  const c=candidates.find(c=>c.forecast?.source==='engine'&&JSON.stringify(planLabels(c))===key);
  if(!c)throw new Error('No engine forecast for this sequence');
  return c.forecast;
}

export function decisionWarnings(s,c) {
  const notes=[]; const a=c.command;
  const playable=(s.player.hand??[]).filter(x=>x.can_play);
  if(a.action==='end_turn' && playable.length)notes.push(`Ends turn with ${s.player.energy} energy and playable cards: ${playable.map(x=>x.name+' ('+x.cost+')').join(', ')}. Compare their damage and Rage block before ending.`);
  if(a.action==='use_potion' && (s.player.potions??[]).find(p=>p.slot===a.slot)?.name==='Block Potion' && factsFor(s).displayed_incoming_attack_total===0)notes.push('No displayed incoming attack: this Block Potion currently prevents zero attack damage. Save it unless another stated mechanic justifies use.');
  return notes;
}
const isCombat = s => ['monster','elite','boss'].includes(s.state_type);
export function decisionCandidates(s, options = {}) {
  if(!isCombat(s))return actionsFor(s, options);
  const unmodeled=unsupportedRuneRules(s);
  if(unmodeled.length)return actionsFor(s).map(action=>({...action,
    plan:[{label:action.label,command:action.command}],
    forecast:unknownRuneForecast(unmodeled)}));
  return planCandidates(s,{extra:options.extra??0});
}

// Added to combat requests only when some candidate carries a live engine forecast (SIM_FORECAST=live).
export const ENGINE_FORECAST_NOTE="A forecast with source engine was played in the game's own combat code: the plan, the end of the turn, the enemy turn and the start of the next turn. quality exact: computed exactly (no draw or random effect in the line). quality sampled: draws or random effects vary; numbers are means over the samples, with min, max and survive_rate (survives null means some samples die). block and energyLeft are at the end of the plan; hpLoss and hpAfter after the enemy turn. A forecast with source planner is the hand-written estimate, with its caveats.";
export function decisionQuestion(s,candidates) {
  s=visibleState(s);
  if(!isCombat(s)){const q=makeQuestion(s,candidates);q.state.encounter=encounterBrief(s);q.state.deck=deckSnapshot(s);q.state.spending_routes=spendingRoutes(s);return q;}
  return {
    model:'jev-latest',
    state:{game:'Slay the Spire 2',objective:'Win the run. Survive the current turn and preserve useful resources.',state:s,encounter:encounterBrief(s),deck:deckSnapshot(s),facts:factsFor(s),policy:POLICY_VERSION,setup_dependencies:setupLinks(s),mechanics_review:mechanicsReview(s),potion_timing:potionTiming(s),
      forecast_scope:'Plans are short prefixes, not complete optimal turns. Forecasts assume ending after the prefix. Null means unknown, not zero. Partial outcomes have explicit caveats. Do not treat displayed card damage as actual damage through enemy powers.',
      ...(candidates.some(c=>c.forecast?.source==='engine')?{forecast_engine:ENGINE_FORECAST_NOTE}:{})},
    questions:{move:{type:'choice',
      instructions:'Choose the next action or short plan that best advances winning the run. Derive tactics from visible rules, intents, cards and observations. Calculations are aids, not guaranteed outcomes; partial estimates omit stated effects and null means unknown. Evaluate tradeoffs over the encounter, not only the current turn. Only the FIRST action executes, followed by a fresh observation. Choose only among supplied IDs.',
      criteria:Object.fromEntries(candidates.map(c=>[c.id,JSON.stringify({sequence:c.plan,forecast:c.forecast,first_action_rules:c.details.description})])),
    }},
  };
}

// Marks enemies already hit this player turn (hit_this_turn), for once-per-turn effects such as
// Skittish. The state does not say so directly: an enemy counts as hit once its HP fell or its
// Block changed since the turn's first observation. memory persists between observations.
export function markHitsThisTurn(memory, state) {
  if (!state?.battle?.enemies || state.battle.turn !== 'player') return state;
  const key = `${state.run?.live_id}:${state.run?.floor}:${state.battle.round}`;
  if (memory.key !== key) { memory.key = key; memory.start = {}; memory.hit = new Set(); }
  const enemies = state.battle.enemies.map(e => {
    const start = memory.start[e.entity_id] ??= {hp: e.hp, block: e.block ?? 0};
    // Any change in Block counts: a first hit absorbed by existing Block can lower it by more than Skittish adds.
    if (e.hp < start.hp || (e.block ?? 0) !== start.block) memory.hit.add(e.entity_id);
    return memory.hit.has(e.entity_id) ? {...e, hit_this_turn: true} : e;
  });
  return {...state, battle: {...state.battle, enemies}};
}

// Unsettling Lamp is spent by the first card played each combat that applies a debuff.
// memory: {fight: true} for fights where that card has been played.
const fightOf = s => `${s.run?.live_id}:${s.run?.act}:${s.run?.floor}`;
export function noteDebuffCard(memory, state, chosen) {
  if (chosen?.command?.action !== 'play_card' || !state?.battle) return;
  const card = (state.player?.hand ?? []).find(c => c.index === chosen.command.card_index);
  if (/Apply \d+ /i.test(card?.description ?? '')) { memory[fightOf(state)] = true; const keys = Object.keys(memory); if (keys.length > 50) delete memory[keys[0]]; }
}
export function markLampUsed(memory, state) {
  if (!state?.battle || !(state.player?.relics ?? []).some(r => r.id === 'UNSETTLING_LAMP')) return state;
  return {...state, player: {...state.player, lamp_used: Boolean(memory[fightOf(state)])}};
}
