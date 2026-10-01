// A stand-in for the headless sim worker, speaking the same JSON-lines protocol, for tests.
// load reads {state} from the replay file. Cards: Strike deals 6, Defend gives 5 Block, Wild deals
// 4 to 6 depending on (seed, sample); each costs 1. Block Potion gives 12 Block. After the line the
// enemies attack for their intents. Commands crash and hang test the client; STUB_PING_FAIL=1 fails
// ping, STUB_EXIT_AT_START=1 exits at once.
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';

if (process.env.STUB_EXIT_AT_START === '1') process.exit(2);
let loaded = null;
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

function play(state, actions, seed, sample) {
  const s = structuredClone(state);
  for (const [i, a] of actions.entries()) {
    if (a.action === 'play_card') {
      const card = s.player.hand[a.card_index];
      if (!card || s.player.energy < 1) return {ok: false, stopped_at: i, reason: 'illegal'};
      if (card.name === 'Choice') return {ok: false, stopped_at: i, reason: 'choice'};
      const target = s.enemies.find(e => e.entity_id === a.target) ?? s.enemies.find(e => e.hp > 0);
      const damage = card.name === 'Strike' ? 6 : card.name === 'Wild' ? 4 + (seed + sample) % 3 : 0;
      if (target) target.hp = Math.max(0, target.hp - damage);
      if (card.name === 'Defend') s.player.block += 5;
      s.player.energy -= 1; s.player.hand.splice(a.card_index, 1);
    } else if (a.action === 'use_potion') {
      const k = s.player.potions.findIndex(p => p.slot === a.slot);
      if (k < 0) return {ok: false, stopped_at: i, reason: 'illegal'};
      if (s.player.potions[k].name === 'Block Potion') s.player.block += 12;
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
