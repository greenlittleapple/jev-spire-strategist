// How cards picked in earlier runs worked out, from the run logs: how often a card was
// offered and taken (card rewards and shop purchases), how often it was played per fight
// afterwards, and how far those runs got. Replays of one seed repeat the same picks, so
// results are averaged per seed first; seeds says how many distinct seeds the averages cover.
// Runs used different policies, so these are rough signals, not win rates.
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname,resolve} from 'node:path';

const combat = new Set(['monster', 'elite', 'boss']);
export const baseCard = name => String(name ?? '').replace(/\s+[—-]\s+\d+\s+gold$/i, '').replace(/\+\d*$/, '').trim();

// seeds: {runId: seed} for seeded runs; other runs count as their own seed.
export function newCardStats(seeds = {}) { return {runs: {}, cards: {}, seeds}; }

const pick = (stats, r, name, floor) => { (stats.cards[name] ??= {offered: 0, picked: 0}).picked++; r.picks[name] ??= floor; };
const offer = (stats, name) => { (stats.cards[name] ??= {offered: 0, picked: 0}).offered++; };

// Folds one logged decision into the stats.
export function recordDecision(stats, e) {
 const s = e?.state, run = s?.run?.live_id;
 if (!run || e.kind !== 'decision' || e.outcome !== 'executed') return;
 const r = stats.runs[run] ??= {seed: stats.seeds?.[run] ?? run, floor: 0, act: 0, picks: {}, fights: new Set(), plays: {}};
 r.floor = Math.max(r.floor, s.run.floor ?? 0); r.act = Math.max(r.act, s.run.act ?? 0);
 if (s.state_type === 'card_reward') {
  const offered = (e.candidates ?? []).map(c => baseCard(c.label)).filter(n => n && !/^skip/i.test(n));
  const chosen = baseCard(e.chosen?.label);
  for (const n of new Set(offered)) (stats.cards[n] ??= {offered: 0, picked: 0}).offered++;
  if (offered.includes(chosen)) pick(stats, r, chosen, s.run.floor ?? 0);
 }
 if (s.state_type === 'shop' && e.chosen?.command?.action === 'shop_purchase') {
  const item = (s.shop?.items ?? []).find(i => i.index === e.chosen.command.index);
  // A purchase counts as offered and picked, so picked never exceeds offered.
  if (item?.category === 'card') { const n = baseCard(item.card_name ?? e.chosen.label); offer(stats, n); pick(stats, r, n, s.run.floor ?? 0); }
 }
 if (combat.has(s.state_type)) {
  const fight = `${s.run.act}:${s.run.floor}`; r.fights.add(fight);
  if (e.chosen?.command?.action === 'play_card') {
   const card = baseCard(s.player?.hand?.find(c => c.index === e.chosen.command.card_index)?.name);
   if (card) (r.plays[card] ??= new Set()).add(`${fight}:${s.battle?.round}:${e.chosen.command.card_index}:${e.time}`);
  }
 }
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
// Summary for one card name: offered/picked counts, then per-seed averages of plays per fight
// after the pick (a card reward follows its floor's fight, so fights from the next floor on)
// and of the floor reached.
export function cardSummary(stats, name) {
 const n = baseCard(name), c = stats.cards[n];
 if (!c) return null;
 const bySeed = new Map();
 for (const r of Object.values(stats.runs)) {
  if (r.picks[n] == null) continue;
  const fights = [...r.fights].filter(f => Number(f.split(':')[1]) > r.picks[n]).length;
  const plays = [...(r.plays[n] ?? [])].filter(p => Number(p.split(':')[1]) > r.picks[n]).length;
  const list = bySeed.get(r.seed) ?? []; list.push({fights, plays, floor: r.floor}); bySeed.set(r.seed, list);
 }
 const seeds = [...bySeed.values()];
 const rates = seeds.map(runs => { const f = runs.reduce((a, x) => a + x.fights, 0); return f ? runs.reduce((a, x) => a + x.plays, 0) / f : null; }).filter(x => x != null);
 return {offered: c.offered, picked: c.picked,
  ...(seeds.length ? {seeds: seeds.length} : {}),
  ...(rates.length ? {plays_per_fight_after_pick: Math.round(mean(rates) * 10) / 10} : {}),
  ...(seeds.length ? {floor_reached_when_picked: Math.round(mean(seeds.map(runs => mean(runs.map(x => x.floor)))))} : {})};
}

// series.jsonl (next to the runs directory) maps seeded runs to their seed.
async function loadSeeds(logFile) {
 const seeds = {};
 const text = await readFile(resolve(dirname(logFile), '../series.jsonl'), 'utf8').catch(() => '');
 for (const line of text.split(/\r?\n/).filter(Boolean)) { try { const s = JSON.parse(line); if (s.run && s.seed) seeds[s.run] = s.seed; } catch {} }
 return seeds;
}

export async function loadCardStats(logFile) {
 const stats = newCardStats(await loadSeeds(logFile));
 try {
  for await (const line of createInterface({input: createReadStream(logFile)})) {
   if (!line.includes('"kind":"decision"') || !line.includes('"outcome":"executed"')) continue;
   try { recordDecision(stats, JSON.parse(line)); } catch {}
  }
 } catch {}
 return stats;
}
