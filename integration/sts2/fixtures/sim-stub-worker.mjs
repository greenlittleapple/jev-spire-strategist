// A stand-in for the headless sim worker, speaking the same JSON-lines protocol, for tests.
// load reads {state} from the replay file. Cards and potions act by id, as names in the real worker
// are lookup keys: STRIKE_IRONCLAD deals 6, DEFEND_IRONCLAD gives 5 Block, WILD deals 4 to 6 depending
// on (seed, sample), CHOICE stops for a card choice; each costs 1. BLOCK_POTION gives 12 Block. After the line the
// enemies attack for their intents. Commands crash and hang test the client; STUB_PING_FAIL=1 fails
// ping, STUB_EXIT_AT_START=1 exits at once. Like the bridge, living enemies are numbered
// <MONSTER>_<n> among the living and renumbered after a death; a dead one becomes <MONSTER>_dead_<n>;
// a target may also be a numeric combat_id. A line whose combat ends early stops with "combat_ended".
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';

if (process.env.STUB_EXIT_AT_START === '1') process.exit(2);
let loaded = null;
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

function renumber(s) {
  const count = {}, dead = {};
  for (const e of s.enemies) {
    const kind = e.entity_id.replace(/_(?:dead_)?\d+$/, '');
    e.entity_id = e.hp > 0 ? `${kind}_${(count[kind] = (count[kind] ?? -1) + 1)}` : `${kind}_dead_${(dead[kind] = (dead[kind] ?? -1) + 1)}`;
  }
}
const resolve = (s, t) => /^\d+$/.test(String(t)) ? s.enemies.find(e => String(e.combat_id) === String(t) && e.hp > 0) : s.enemies.find(e => e.entity_id === t && e.hp > 0);

function play(state, actions, seed, sample) {
  const s = structuredClone(state);
  for (const [i, a] of actions.entries()) {
    if (!s.enemies.some(e => e.hp > 0)) return {ok: true, stopped_at: i, reason: 'combat_ended', after_line: structuredClone(s), after_enemy_turn: null, player_dead: false, combat_won: true};
    if (a.action === 'play_card') {
      const card = s.player.hand[a.card_index];
      if (!card || s.player.energy < 1) return {ok: false, stopped_at: i, reason: 'illegal'};
      if (card.id === 'CHOICE') return {ok: false, stopped_at: i, reason: 'choice'};
      const target = a.target == null ? s.enemies.find(e => e.hp > 0) : resolve(s, a.target);
      if (!target) return {ok: false, stopped_at: i, reason: 'illegal'};
      const damage = card.id === 'STRIKE_IRONCLAD' ? 6 : card.id === 'WILD' ? 4 + (seed + sample) % 3 : 0;
      if (target) target.hp = Math.max(0, target.hp - damage);
      if (card.id === 'DEFEND_IRONCLAD') s.player.block += 5;
      s.player.energy -= 1; s.player.hand.splice(a.card_index, 1); renumber(s);
    } else if (a.action === 'use_potion') {
      const k = s.player.potions.findIndex(p => p.slot === a.slot);
      if (k < 0) return {ok: false, stopped_at: i, reason: 'illegal'};
      if (s.player.potions[k].id === 'BLOCK_POTION') s.player.block += 12;
      s.player.potions.splice(k, 1);
    } else return {ok: false, stopped_at: i, reason: 'illegal'};
  }
  const afterLine = structuredClone(s);
  if (!s.enemies.some(e => e.hp > 0)) return {ok: true, stopped_at: null, reason: null, after_line: afterLine, after_enemy_turn: null, player_dead: false, combat_won: true};
  const incoming = s.enemies.filter(e => e.hp > 0).flatMap(e => e.intents ?? []).reduce((n, x) => n + (x.damage ?? 0) * (x.hits ?? 1), 0);
  s.player.hp = Math.max(0, s.player.hp - Math.max(0, incoming - s.player.block));
  s.player.block = 0; s.round += 1;
  return {ok: true, stopped_at: null, reason: null, after_line: afterLine, after_enemy_turn: s, player_dead: s.player.hp <= 0, combat_won: false};
}

createInterface({input: process.stdin}).on('line', line => {
  const req = JSON.parse(line);
  if (req.cmd === 'crash') process.exit(3);
  if (req.cmd === 'hang') return;
  if (req.cmd === 'ping') return send(process.env.STUB_PING_FAIL === '1' ? {id: req.id, ok: false, error: 'stub ping failure'} : {id: req.id, ok: true, version: 'stub-1', game: 'v0.111.0'});
  if (req.cmd === 'load') {
    try { loaded = JSON.parse(readFileSync(req.replay, 'utf8')).state; }
    catch (error) { return send({id: req.id, ok: false, error: error.message}); }
    return send({id: req.id, ok: true, ms: 1, combat: {encounter: 'STUB', round: loaded.round, player_actions: 0}, state: loaded});
  }
  if (req.cmd === 'simulate') {
    if (!loaded) return send({id: req.id, ok: false, error: 'nothing loaded'});
    const results = req.lines.map(l => ({id: l.id, samples: Array.from({length: req.samples}, (_, k) => play(loaded, l.actions, req.seed, k))}));
    return send({id: req.id, ok: true, ms: 2, results});
  }
  send({id: req.id, ok: false, error: `unknown cmd ${req.cmd}`});
});
