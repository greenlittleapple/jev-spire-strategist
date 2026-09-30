import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionsFor, fingerprint, COUNTER_TRIGGERS, counterTrigger, triggeredCounters, counterWait } from './actions.mjs';
import { decisionCandidates } from './planner.mjs';

// Relic texts as the bridge reported them in the 2026-09-27 run log.
const DESCRIPTIONS = {
  HAPPY_FLOWER: 'Every 3 turns, gain [ironclad_energy_icon.png].',
  PENDULUM: 'Every 3 turns, draw 1 card.',
  ORNAMENTAL_FAN: 'Every time you play 3 Attacks in a single turn, gain 4 Block.',
  KUSARIGAMA: 'Every time you play 3 Attacks in a single turn, deal 6 damage to a random enemy.',
  LETTER_OPENER: 'Every time you play 3 Skills in a single turn, deal 5 damage to ALL enemies.',
  POLLINOUS_CORE: 'Every 4 turns, draw 2 additional cards.',
  PEN_NIB: 'Every 10th Attack you play deals double damage.',
  NUNCHAKU: 'Every time you play 10 Attacks, gain [ironclad_energy_icon.png].',
};
const relic = (id, counter, description = DESCRIPTIONS[id]) => ({ id, name: id, description, counter });
const combat = relics => ({ state_type: 'monster', run: { live_id: 'r', floor: 5 }, battle: { round: 2, turn: 'player', is_play_phase: true, enemies: [] }, player: { hp: 50, relics } });

test('the log-derived trigger table agrees with each relic text', () => {
  // Value last seen before a reset to 0 in the log: Happy Flower 3 (55 resets), Pendulum 3 (7), Ornamental Fan 3 (13),
  // Kusarigama 3 (21), Letter Opener 3 (2), Pollinous Core 4 (1), Pen Nib 10 (6), Nunchaku 10 (12).
  assert.deepEqual(Object.keys(COUNTER_TRIGGERS).sort(), Object.keys(DESCRIPTIONS).sort());
  for (const [id, n] of Object.entries(COUNTER_TRIGGERS)) assert.equal(counterTrigger({ id: 'UNLISTED', description: DESCRIPTIONS[id] }), n, id);
  // Not seen at the trigger value in the log; the text gives it.
  assert.equal(counterTrigger({ id: 'TUNING_FORK', description: 'Every time you play 10 Skills, gain 7 Block.' }), 10);
  assert.equal(counterTrigger({ id: 'FISHING_ROD', description: 'Every 3 normal combats, Upgrade a random card in your Deck.' }), 3);
  // Counters that are not "every N" counters: a cap, a countdown, a turn number.
  for (const description of ['Gain [ironclad_energy_icon.png] at the start of each turn. You cannot play more than 6 cards per turn.',
    'At the start of the next 5 combats, gain 2 Strength.', 'At the end of turn 7, deal 52 damage to ALL enemies.'])
    assert.equal(counterTrigger({ id: 'X', description }), null, description);
});

test('only a counter at its trigger value is unsettled', () => {
  assert.deepEqual(triggeredCounters(combat([relic('HAPPY_FLOWER', 3), relic('PEN_NIB', 9), relic('NUNCHAKU', 10)])), ['HAPPY_FLOWER', 'NUNCHAKU']);
  assert.deepEqual(triggeredCounters(combat([relic('HAPPY_FLOWER', 0), relic('ORNAMENTAL_FAN', 2), relic('VELVET_CHOKER', 6, 'You cannot play more than 6 cards per turn.')])), []);
  assert.deepEqual(triggeredCounters(combat([relic('ORNAMENTAL_FAN', null)])), []);
});

test('the runner waits up to the limit once per relic trigger, then asks', () => {
  const flower = (c, round = 2) => ({ ...combat([relic('HAPPY_FLOWER', c)]), battle: { round, turn: 'player', is_play_phase: true, enemies: [] } });
  let w = counterWait(flower(3), null, 1000);
  assert.equal(w.wait, true); assert.deepEqual(w.ids, ['HAPPY_FLOWER']);
  w = counterWait(flower(3), w.memo, 1600); assert.equal(w.wait, true, 'still inside the limit');
  // Usual case: the counter reset about 0.5 s later, so the next observation is settled.
  assert.equal(counterWait(flower(0), w.memo, 1700).wait, false);
  // A counter that stays: asked after the limit, and not held again in the same round.
  w = counterWait(flower(3), w.memo, 2000); assert.equal(w.wait, false);
  assert.equal(counterWait(flower(3), w.memo, 9000).wait, false);
  assert.equal(counterWait(flower(3, 5), w.memo, 9000).wait, true, 'a later trigger waits again');
});

test('the reset of a triggered counter does not make a decision stale; other counter changes still do', () => {
  // #17366 (JEV4, boss round 5): Ornamental Fan 3 when Jev was asked, 0 at the pre-dispatch check.
  const at = c => combat([relic('NUNCHAKU', 2), relic('ORNAMENTAL_FAN', c)]);
  assert.equal(fingerprint(at(3)), fingerprint(at(0)));
  assert.notEqual(fingerprint(at(2)), fingerprint(at(0)));
  assert.notEqual(fingerprint(at(2)), fingerprint(at(3)), 'the third Attack is still a change');
  // #21753 (JEV8 boss): Pen Nib 10 and Kusarigama 3 both reset.
  const both = (p, k) => combat([relic('KUSARIGAMA', k), relic('PEN_NIB', p)]);
  assert.equal(fingerprint(both(10, 3)), fingerprint(both(0, 0)));
});

test('treasure can_proceed changes while the chest opens do not make a claim stale', () => {
  // #11158, #11724, #29864: can_proceed false when asked, true at the pre-dispatch check; 47 claims made while it was false succeeded.
  const chest = (can_proceed, relics = [{ index: 0, name: 'Anchor' }]) => ({ state_type: 'treasure', treasure: { relics, can_proceed } });
  assert.equal(fingerprint(chest(false)), fingerprint(chest(true)));
  assert.deepEqual(actionsFor(chest(false)).map(a => a.command), [{ action: 'claim_treasure_relic', index: 0 }]);
  // Without relics it decides whether proceed is offered, so it still counts.
  assert.notEqual(fingerprint(chest(false, [])), fingerprint(chest(true, [])));
});

test('forecasts are the same with an Ornamental Fan counter at 3 or 0', () => {
  const base = JSON.parse(readFileSync(new URL('../../../integration/sts2/fixtures/elite-multi-hit.json', import.meta.url), 'utf8'));
  const withFan = counter => ({ ...base, player: { ...base.player, relics: [...(base.player.relics ?? []), relic('ORNAMENTAL_FAN', counter)] } });
  const forecasts = counter => decisionCandidates(withFan(counter)).map(c => JSON.stringify([c.command, c.forecast]));
  assert.deepEqual(forecasts(3), forecasts(0));
  assert.notDeepEqual(forecasts(2), forecasts(0));
});

// JEV3 f23 (#16153), trimmed: three potions held, a Duplicator offered.
const swapScreen = items => ({ state_type: 'rewards', run: { live_id: 'r', act: 2, floor: 23 },
  player: { max_potion_slots: 3, potions: [{ id: 'STRENGTH_POTION', name: 'Strength Potion', slot: 0 }, { id: 'SPEED_POTION', name: 'Speed Potion', slot: 1 }, { id: 'EXPLOSIVE_AMPOULE', name: 'Explosive Ampoule', slot: 2 }] },
  rewards: { can_proceed: true, items } });
const gold = { index: 0, type: 'gold', description: '10 Gold' };
const duplicator = index => ({ index, type: 'potion', description: 'Duplicator', potion_id: 'DUPLICATOR', potion_name: 'Duplicator' });

test('a full belt offers one discard per held potion for an offered potion, only with potionSwaps', () => {
  const s = swapScreen([gold, duplicator(1), { index: 2, type: 'card', description: 'Add a card to your deck.' }]);
  assert.deepEqual(actionsFor(s).map(a => a.label), ['10 Gold', 'Add a card to your deck.'], 'Jev-only modes are unchanged');
  const a = actionsFor(s, { potionSwaps: true });
  assert.deepEqual(a.map(x => x.command), [{ action: 'claim_reward', index: 0 }, { action: 'claim_reward', index: 2 },
    { action: 'discard_potion', slot: 0 }, { action: 'discard_potion', slot: 1 }, { action: 'discard_potion', slot: 2 }]);
  assert.equal(a[2].label, 'Discard Strength Potion (slot 0) to make room for Duplicator');
  assert.equal(a[2].details.take.potion_id, 'DUPLICATOR');
});

test('when only the potion is left, leaving it stays possible', () => {
  const s = swapScreen([duplicator(0)]);
  assert.deepEqual(actionsFor(s).map(a => a.command.action), ['proceed']);
  assert.deepEqual(actionsFor(s, { potionSwaps: true }).map(a => a.command.action), ['discard_potion', 'discard_potion', 'discard_potion', 'proceed']);
  // After a discard the claim is offered normally.
  const after = { ...s, player: { ...s.player, potions: s.player.potions.slice(1) } };
  assert.deepEqual(actionsFor(after, { potionSwaps: true }).map(a => a.command), [{ action: 'claim_reward', index: 0 }]);
  // Non-combat decision candidates pass the option through.
  assert.equal(decisionCandidates(s, { potionSwaps: true }).length, 4);
});
