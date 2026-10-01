// Protocol checks for the forecast worker (`Sts2Sim.exe serve`). Needs the game, so CI does not run it.
//
//   node integration/sts2-sim/worker-check.mjs --exe <Sts2Sim.exe> --replay <a combat .mcr> [--replay2 <another .mcr>]
//
// STS2_GAME_DIR must be set as for the worker. Checks: ping; load, then a truncated load and an incremental load;
// a deterministic line gives identical results across samples and seeds; ending the turn (an empty line) draws
// different hands for different seeds and identical output for the same request twice; illegal actions stop with a
// reason. Prints timings. Exit code 1 when a check fails.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const exe = arg('--exe'), replay = arg('--replay'), replay2 = arg('--replay2');
if (!exe || !replay) { console.error('usage: worker-check.mjs --exe <Sts2Sim.exe> --replay <file.mcr> [--replay2 <file.mcr>]'); process.exit(2); }

const child = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let nextId = 1;
readline.createInterface({ input: child.stdout }).on('line', line => {
  const msg = JSON.parse(line); // stdout must carry only JSON responses
  waiting.get(msg.id)?.({ msg, raw: line }); waiting.delete(msg.id);
});
const send = req => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ id, ...req }) + '\n'); });
const body = raw => raw.replace(/^\{"id":\d+,/, '{').replace(/"ms":\d+,/g, '');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`); };

const ping = (await send({ cmd: 'ping' })).msg;
check('ping', ping.ok && ping.version && ping.game, `worker ${ping.version}, game ${ping.game}`);

const full = (await send({ cmd: 'load', replay })).msg;
check('load', full.ok, `${full.ms} ms, ${JSON.stringify(full.combat)}`);
const n = full.combat.player_actions;
const start = (await send({ cmd: 'load', replay, actions: 0 })).msg;
const again = await send({ cmd: 'load', replay });
check('incremental load reaches the same state', again.msg.incremental && JSON.stringify(again.msg.state) === JSON.stringify(full.state), `${again.msg.ms} ms for ${n} actions`);

await send({ cmd: 'load', replay, actions: 0 });
const hand = start.state.player.hand, enemy = start.state.enemies.find(e => e.hp > 0);
const atk = hand.findIndex(h => h.id.startsWith('STRIKE'));
if (atk >= 0) {
  const line = [{ id: 'strike', actions: [{ action: 'play_card', card_index: atk, target: enemy.entity_id }] }];
  const a = (await send({ cmd: 'simulate', lines: line, end_turn: false, samples: 4, seed: 1 })).msg.results[0].samples;
  const b = (await send({ cmd: 'simulate', lines: line, end_turn: false, samples: 4, seed: 99 })).msg.results[0].samples;
  const distinct = new Set([...a, ...b].map(s => JSON.stringify(s))).size;
  check('deterministic line identical across samples and seeds', a[0].ok && distinct === 1, `enemy hp ${enemy.hp} -> ${a[0].after_line.enemies.find(e => e.entity_id === enemy.entity_id).hp}`);
} else console.log('skip deterministic line: no Strike in the starting hand');

const endTurn = seed => send({ cmd: 'simulate', lines: [{ id: 'end', actions: [] }], end_turn: true, samples: 4, seed, known_top: 0 });
const s1 = await endTurn(1), s1b = await endTurn(1), s2 = await endTurn(2);
const hands = r => r.msg.results[0].samples.map(s => s.after_enemy_turn?.player.hand.map(h => h.id).join(' '));
check('empty line ends the turn', s1.msg.results[0].samples.every(s => s.ok && s.after_enemy_turn));
check('same request twice gives identical output', body(s1.raw) === body(s1b.raw));
check('draws differ across seeds and samples', new Set([...hands(s1), ...hands(s2)]).size > 4, `${new Set([...hands(s1), ...hands(s2)]).size} distinct hands in 8 samples`);
console.log(`     ${(s1.msg.ms / 4).toFixed(1)} ms per line and sample (rebuild, line, enemy turn)`);

const bad = (await send({ cmd: 'simulate', lines: [{ id: 'bad', actions: [{ action: 'play_card', card_index: 42 }] }, { id: 'target', actions: [{ action: 'use_potion', slot: 99 }] }], samples: 1 })).msg;
check('illegal actions stop with a reason', bad.results.every(r => !r.samples[0].ok && r.samples[0].stopped_at === 0 && r.samples[0].reason),
  bad.results.map(r => r.samples[0].reason).join('; '));

if (replay2) {
  const other = (await send({ cmd: 'load', replay: replay2 })).msg;
  check('load a second combat', other.ok && !other.incremental, `${other.ms} ms, ${JSON.stringify(other.combat)}`);
  const half = Math.floor(other.combat.player_actions / 2);
  await send({ cmd: 'load', replay: replay2, actions: half });
  const r = (await send({ cmd: 'simulate', lines: [{ id: 'end', actions: [] }], samples: 4, seed: 5 })).msg;
  console.log(`     after ${half} actions: ${(r.ms / 4).toFixed(1)} ms per line and sample`);
}
child.stdin.end();
await new Promise(r => child.on('exit', r));
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
