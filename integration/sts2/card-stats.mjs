// How cards picked in earlier runs worked out, from the run logs: how often a card was
// offered and taken, how often it was played per fight afterwards, and how far those runs got.
// Runs used different policies and seeds, so these are rough signals, not win rates.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';

const combat = new Set(['monster', 'elite', 'boss']);
export const baseCard = name => String(name ?? '').replace(/\s+[—-]\s+\d+\s+gold$/i, '').replace(/\+\d*$/, '').trim();

export function newCardStats() { return {runs: {}, cards: {}}; }

// Folds one logged decision into the stats.
export function recordDecision(stats, e) {
 const s = e?.state, run = s?.run?.live_id;
 if (!run || e.kind !== 'decision' || e.outcome !== 'executed') return;
 const r = stats.runs[run] ??= {floor: 0, act: 0, picks: {}, fights: new Set(), plays: {}};
 r.floor = Math.max(r.floor, s.run.floor ?? 0); r.act = Math.max(r.act, s.run.act ?? 0);
 if (s.state_type === 'card_reward') {
  const offered = (e.candidates ?? []).map(c => baseCard(c.label)).filter(n => n && !/^skip/i.test(n));
  const chosen = baseCard(e.chosen?.label);
  for (const n of new Set(offered)) (stats.cards[n] ??= {offered: 0, picked: 0}).offered++;
  if (offered.includes(chosen)) { stats.cards[chosen].picked++; r.picks[chosen] ??= s.run.floor ?? 0; }
 }
 if (combat.has(s.state_type)) {
  const fight = `${s.run.act}:${s.run.floor}`; r.fights.add(fight);
  if (e.chosen?.command?.action === 'play_card') {
   const card = baseCard(s.player?.hand?.find(c => c.index === e.chosen.command.card_index)?.name);
   if (card) (r.plays[card] ??= new Set()).add(`${fight}:${s.battle?.round}:${e.chosen.command.card_index}:${e.time}`);
  }
 }
}

// Summary for one card name: offered/picked counts, plays per fight after picking, and run depth.
export function cardSummary(stats, name) {
 const n = baseCard(name), c = stats.cards[n];
 if (!c) return null;
 let plays = 0, fights = 0; const floors = [];
 for (const r of Object.values(stats.runs)) {
  if (r.picks[n] == null) continue;
  floors.push(r.floor);
  const after = [...r.fights].filter(f => Number(f.split(':')[1]) >= r.picks[n]).length;
  fights += after;
  plays += [...(r.plays[n] ?? [])].filter(p => Number(p.split(':')[1]) >= r.picks[n]).length;
 }
 return {offered: c.offered, picked: c.picked,
  ...(fights ? {plays_per_fight_after_pick: Math.round(plays / fights * 10) / 10} : {}),
  ...(floors.length ? {floor_reached_when_picked: Math.round(floors.reduce((a, b) => a + b, 0) / floors.length)} : {})};
}

export async function loadCardStats(logFile) {
 const stats = newCardStats();
 try {
  for await (const line of createInterface({input: createReadStream(logFile)})) {
   if (!line.includes('"kind":"decision"') || !line.includes('"outcome":"executed"')) continue;
   try { recordDecision(stats, JSON.parse(line)); } catch {}
  }
 } catch {}
 return stats;
}
