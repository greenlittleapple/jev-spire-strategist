// How each encounter went: HP at the start and end of each fight, rounds, and win or loss.
// Shown to the strategist with that encounter's saved plan, and used to re-review a saved
// plan that did badly (a normal fight with a saved plan is otherwise never reviewed again).
// Built from the run logs at startup and updated live.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {encounterKey} from './playbook.mjs';

const combat = new Set(['monster', 'elite', 'boss']);
// Screens that mean the fight is over (won); in-fight choice screens (hand_select) are neutral.
const after = new Set(['rewards', 'card_reward', 'map', 'event', 'rest_site', 'shop', 'treasure']);
const RESULTS_PER_ENCOUNTER = 6;

export function newFightResults() { return {open: {}, encounters: {}}; }

const close = (memory, run, result) => {
 const f = memory.open[run]; delete memory.open[run];
 if (!f) return;
 const list = memory.encounters[f.key] ??= [];
 list.push({...f, ...result});
 if (list.length > RESULTS_PER_ENCOUNTER) list.shift();
};

// Folds one observed state into the results. time: when the state was observed.
export function recordFight(memory, state, time = new Date().toISOString()) {
 const run = state?.run?.live_id;
 if (!run) return;
 const open = memory.open[run];
 if (combat.has(state.state_type) && state.battle) {
  const fight = `${state.run.act}:${state.run.floor}`;
  if (open && open.fight !== fight) close(memory, run, {hp_end: open.hp_last, won: true});
  if (!memory.open[run]) memory.open[run] = {key: encounterKey(state.battle.enemies), fight, run, kind: state.state_type,
   time, hp_start: state.player?.hp ?? null, max_hp: state.player?.max_hp ?? null, rounds: 0, hp_last: state.player?.hp ?? null};
  const f = memory.open[run];
  f.rounds = Math.max(f.rounds, state.battle.round ?? 0);
  f.hp_last = state.player?.hp ?? f.hp_last;
  return;
 }
 if (!open) return;
 // Game over at 0 HP is a loss; with HP left the run ended another way (a win or an abandon).
 if (state.state_type === 'game_over') { const hp = state.player?.hp ?? 0; close(memory, run, {hp_end: hp, won: hp > 0}); }
 else if (after.has(state.state_type) || `${state.run.act}:${state.run.floor}` !== open.fight)
  close(memory, run, {hp_end: state.player?.hp ?? open.hp_last, won: true});
}

// Recent results for one encounter, newest first, plus the average HP lost.
// since: an ISO time; results from fights that started later are marked after_plan.
export function encounterResults(memory, key, since = null) {
 const list = (memory?.encounters?.[key] ?? []).slice().reverse();
 if (!list.length) return null;
 const lost = f => f.hp_start != null && f.hp_end != null ? Math.max(0, f.hp_start - f.hp_end) : null;
 const losses = list.map(lost).filter(n => n != null);
 return {
  fights: list.length, wins: list.filter(f => f.won).length,
  ...(losses.length ? {avg_hp_lost: Math.round(losses.reduce((a, b) => a + b, 0) / losses.length)} : {}),
  recent: list.slice(0, 3).map(f => ({hp: `${f.hp_start}→${f.hp_end}/${f.max_hp}`, rounds: f.rounds, won: f.won,
   ...(since ? {after_plan: f.time > since} : {})})),
 };
}

// True when the saved plan has been used since it was written and went badly:
// a loss, or an average loss of at least a quarter of max HP.
export function planNeedsReview(memory, key, plan) {
 if (!plan?.updatedAt) return false;
 const used = (memory?.encounters?.[key] ?? []).filter(f => f.time > plan.updatedAt);
 if (!used.length) return false;
 if (used.some(f => !f.won)) return true;
 const share = used.map(f => f.max_hp ? Math.max(0, f.hp_start - f.hp_end) / f.max_hp : 0);
 return share.reduce((a, b) => a + b, 0) / share.length >= 0.25;
}

export async function loadFightResults(logFile) {
 const memory = newFightResults();
 try {
  for await (const line of createInterface({input: createReadStream(logFile)})) {
   // Game over is logged as run_end.
   if (!line.includes('"kind":"decision"') && !line.includes('"kind":"run_end"')) continue;
   try { const e = JSON.parse(line); recordFight(memory, e.state, e.time); } catch {}
  }
 } catch {}
 // Fights still open at the end of the log (the run was stopped mid-fight) are left open.
 return memory;
}
