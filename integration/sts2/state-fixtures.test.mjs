// Bridge states recorded in real runs (fixtures/, scrubbed and trimmed: saved-run history cut to
// the last rooms, pile card keywords removed) sent through the code that consumes states. Hand-built
// states only carry the fields a test's author thought of; these check that fields the bridge
// actually sends reach the forecasts, route facts, strategist brief and Jev request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectionState} from '../../vendor/jev-the-spire/spire-demo/selections.mjs';
import {decisionCandidates} from '../../vendor/jev-the-spire/spire-demo/planner.mjs';
import {factsFor} from '../../vendor/jev-the-spire/spire-demo/actions.mjs';
import {computedFacts, FACTS_V3_POLICY} from './route-facts.mjs';
import {strategistBrief} from './strategy.mjs';
import {efficientQuestion} from './efficient-decisions.mjs';

// The same first steps as the runner: selectionState on the observed state, then candidates.
const load = name => {
  const state = selectionState(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')));
  const candidates = decisionCandidates(state);
  const facts = computedFacts(state, candidates, null, {version: 3});
  return {state, candidates, facts, brief: strategistBrief(state, candidates, 'fixture', null, {facts})};
};
const NAMES = ['elite-multi-hit', 'map', 'shop', 'card-reward', 'event', 'rest-site'];

test('fixtures carry no private details and stay small', () => {
  for (const name of NAMES) {
    const text = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
    assert.ok(text.length < 16000, `${name} is ${text.length} characters`);
    assert.doesNotMatch(text, /Users[\\/]|7656119\d{10}|steam_id|platform_id|net_id|@[a-z0-9-]+\.[a-z]{2,}/i, name);
  }
});

test('multi-enemy combat: a multi-hit intent counts every hit in facts, forecasts and the brief', () => {
  const {state, candidates, brief} = load('elite-multi-hit');
  assert.equal(state.battle.enemies.filter(e => e.hp > 0).length, 4);
  // 7 + 1x3 + 7; the Buff intent deals nothing.
  assert.equal(factsFor(state).displayed_incoming_attack_total, 17);
  assert.equal(factsFor(state).all_attack_labels_parsed, true);
  const endTurn = candidates.find(c => c.command.action === 'end_turn');
  assert.equal(endTurn.forecast.incoming, 17);
  // Block at the enemy turn includes end-of-turn Block: Cloak Clasp adds 1 per card held (8 + 5).
  assert.equal(endTurn.forecast.block, state.player.block + state.player.hand.length);
  assert.equal(endTurn.forecast.hpLoss, Math.max(0, 17 - endTurn.forecast.block));
  // Killing an attacker lowers the forecast; nothing is forecast above the displayed total.
  assert.ok(candidates.every(c => c.forecast.incoming <= 17) && candidates.some(c => c.forecast.incoming < 17));
  // Every living enemy is a target, and potions reach the candidates.
  for (const e of state.battle.enemies) assert.ok(candidates.some(c => c.command.target === e.entity_id), e.entity_id);
  assert.ok(candidates.some(c => c.command.action === 'use_potion'));
  assert.deepEqual(brief.enemies.map(e => e.intents[0].label), ['', '7', '1x3 (3)', '7']);
  assert.ok(brief.enemies.every(e => e.status.some(s => s.name === 'Skittish' && s.description)));
  assert.equal(brief.combat_state.hand.length, state.player.hand.length);
  assert.equal(brief.combat_state.block, state.player.block);
});

test('map: every next node has route facts, and the act map carries forward to later screens', () => {
  const {state, candidates, facts, brief} = load('map');
  assert.deepEqual(candidates.map(c => c.details.type), ['RestSite', 'RestSite', 'Elite', 'Shop']);
  assert.deepEqual(Object.keys(facts.route_options), candidates.map(c => c.id));
  for (const option of Object.values(facts.route_options)) {
    assert.ok(option.paths_to_boss > 0 && option.example_routes.length > 0);
    assert.match(option.example_routes[0], /^[MER$T?]+$/);
  }
  assert.equal(facts.route_options.a2.next_elite_in, 1);
  assert.deepEqual(facts.gold, {gold: state.player.gold, shops_ahead_this_act: '0-2'});
  assert.deepEqual(brief.facts.route_options, facts.route_options);
  // Hextech enemy rules sent with the state reach the brief with their text.
  assert.ok(brief.active_rune_rules.length >= 5 && brief.active_rune_rules.every(r => r.name && r.description));
  // On a later screen of the same act the remembered map gives what lies ahead.
  const memory = {runId: state.run.live_id, act: state.run.act, map: state.map, position: state.map.current_position};
  const {map, ...elsewhere} = {...state, state_type: 'event'};
  const later = computedFacts(elsewhere, [], memory, {version: 3});
  assert.ok(later.route_ahead.floors_to_boss > 0);
  assert.equal(later.gold.shops_ahead_this_act, facts.gold.shops_ahead_this_act);
});

test('shop: card, relic and potion descriptions reach the brief with prices', () => {
  const {state, candidates, brief} = load('shop');
  const byLabel = Object.fromEntries(brief.current_options.map(o => [o.label, o.description]));
  for (const item of state.shop.items.filter(i => i.category !== 'card_removal')) {
    const name = item.card_name ?? item.relic_name ?? item.potion_name;
    const text = item.card_description ?? item.relic_description ?? item.potion_description;
    assert.equal(byLabel[`${name} — ${item.price} gold`], text, name);
  }
  assert.ok(brief.current_options.some(o => o.label === 'Remove a card — 75 gold'));
  assert.equal(candidates.find(c => c.label.startsWith('Mayhem')).details.gold_after_purchase, state.player.gold - 176);
  assert.ok(brief.keywords && Object.keys(brief.keywords).length > 0);
});

test('card reward: card text and keyword definitions reach the brief', () => {
  const {brief} = load('card-reward');
  assert.deepEqual(brief.current_options.map(o => o.label), ['Bludgeon', 'Cinder', 'Spite', 'Skip']);
  assert.equal(brief.current_options[1].description, 'Deal 18 damage. Exhaust 1 card at random.');
  assert.equal(brief.keywords.Exhaust, 'Removed until the end of combat.');
});

test('event: the event text, option descriptions and option keywords reach the brief', () => {
  const {state, brief} = load('event');
  assert.equal(brief.event.name, 'Grave of the Forgotten');
  assert.equal(brief.event.text, state.event.body);
  assert.deepEqual(brief.current_options.map(o => o.description), state.event.options.map(o => o.description));
  assert.match(brief.keywords.Decay, /take 2 damage/);
  assert.ok(brief.history?.by_act?.length > 0, 'saved-run history is summarized');
});

test('rest site: the heal amount is read from the option text', () => {
  const {state, facts, brief} = load('rest-site');
  assert.deepEqual(facts.rest, {missing_hp: state.player.max_hp - state.player.hp, rest_heals: 24, heal_wasted: 0});
  assert.equal(brief.current_options[0].description, 'Heal for 30% of your Max HP (24).');
});

// Every text value in the live state (the save history is summarized separately) must reach the
// Jev request; a projection that drops a field the bridge sends fails here.
test('the Jev request keeps every text value the bridge sent', () => {
  const strings = (value, out = []) => {
    if (typeof value === 'string') { if (value.length >= 4) out.push(value); }
    else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
    return out;
  };
  for (const name of NAMES) {
    const {state, candidates, facts} = load(name);
    const request = JSON.stringify(efficientQuestion(state, candidates, {}, null, facts, FACTS_V3_POLICY));
    const {saved_run, ...live} = state;
    const missing = strings(live).filter(s => !request.includes(JSON.stringify(s).slice(1, -1)));
    assert.deepEqual(missing, [], name);
  }
});
