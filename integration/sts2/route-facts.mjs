// Exact counts over the visible act map and live resources. These are facts for
// Jev and the strategist; they never remove options.
export const FACTS_POLICY = 'jev-compact-v2';
export const FACTS_V3_POLICY = 'jev-compact-v3';
const ROOM = {Monster:'M',Elite:'E',RestSite:'R',Shop:'$',Treasure:'T',Unknown:'?',Ancient:'A',Boss:'B'};
const TRACK = {Elite:'elites',RestSite:'rests',Shop:'shops',Unknown:'unknowns',Monster:'monsters',Treasure:'treasures'};
const combatScreens = new Set(['monster','elite','boss']);
export const nodeKey = n => `${n.col},${n.row}`;

function graph(map) {
 const nodes = new Map((map?.nodes ?? []).map(n => [nodeKey(n), n]));
 const memo = new Map();
 // Per-type minimum and maximum over every path from this node to the boss, including the node itself.
 const summary = key => {
  if (memo.has(key)) return memo.get(key);
  const node = nodes.get(key);
  if (!node) return null;
  const children = (node.children ?? []).map(([c,r]) => summary(`${c},${r}`)).filter(Boolean);
  const result = {paths: children.length ? 0 : 1, min: {}, max: {}};
  for (const t of Object.values(TRACK)) { result.min[t] = children.length ? Infinity : 0; result.max[t] = 0; }
  for (const child of children) {
   result.paths += child.paths;
   for (const t of Object.values(TRACK)) { result.min[t] = Math.min(result.min[t], child.min[t]); result.max[t] = Math.max(result.max[t], child.max[t]); }
  }
  const own = TRACK[node.type];
  if (own) { result.min[own]++; result.max[own]++; }
  memo.set(key, result);
  return result;
 };
 return {nodes, summary};
}

const range = (a,b) => a === b ? a : `${a}-${b}`;
function describe(s) {
 const out = {paths_to_boss: s.paths};
 for (const t of Object.values(TRACK)) out[t] = range(s.min[t], s.max[t]);
 return out;
}
function merge(summaries) {
 const list = summaries.filter(Boolean);
 if (!list.length) return null;
 const out = {paths: 0, min: {}, max: {}};
 for (const t of Object.values(TRACK)) { out.min[t] = Infinity; out.max[t] = 0; }
 for (const s of list) {
  out.paths += s.paths;
  for (const t of Object.values(TRACK)) { out.min[t] = Math.min(out.min[t], s.min[t]); out.max[t] = Math.max(out.max[t], s.max[t]); }
 }
 return out;
}
const childKeys = (nodes,pos) => (nodes.get(nodeKey(pos))?.children ?? []).map(([c,r]) => `${c},${r}`);

// For each map option: what every route through it contains.
export function optionRoutes(map, candidates) {
 const {summary} = graph(map), out = {};
 for (const c of candidates) {
  if (c.command?.action !== 'choose_map_node' || c.details?.col == null) continue;
  const s = summary(nodeKey(c.details));
  if (s) out[c.id] = describe(s);
 }
 return out;
}

// What remains ahead of a position (the node the player is at or travelling to).
export function remainingRoute(map, position) {
 if (!map || !position) return null;
 const {nodes, summary} = graph(map);
 const ahead = merge(childKeys(nodes,position).map(summary));
 const boss = map.boss ?? map.bosses?.[0];
 return ahead ? {...describe(ahead), floors_to_boss: boss ? boss.row - position.row : null} : null;
}

// Distinct room sequences for the strategist, each with one concrete node path.
export function distinctRoutes(map, position, {maxPaths=5000, maxRoutes=30}={}) {
 if (!map || !position) return null;
 const {nodes} = graph(map), seen = new Map();
 let total = 0, truncated = false;
 const walk = (key, rooms, path) => {
  if (total >= maxPaths) { truncated = true; return; }
  const node = nodes.get(key);
  if (!node) return;
  const nextRooms = rooms + (ROOM[node.type] ?? '?'), nextPath = [...path, key];
  if (!node.children?.length) {
   total++;
   if (!seen.has(nextRooms)) seen.set(nextRooms, nextPath);
   return;
  }
  for (const [c,r] of node.children) walk(`${c},${r}`, nextRooms, nextPath);
 };
 for (const key of childKeys(nodes, position)) walk(key, '', []);
 // Take routes from each next node in turn so truncation never hides an option.
 const byFirst = new Map();
 for (const [rooms, path] of seen) { const list = byFirst.get(path[0]) ?? []; list.push({rooms, nodes: path}); byFirst.set(path[0], list); }
 const groups = [...byFirst.values()], routes = [];
 for (let i = 0; routes.length < maxRoutes && groups.some(g => i < g.length); i++)
  for (const g of groups) if (i < g.length && routes.length < maxRoutes) routes.push(g[i]);
 return {legend: 'M monster, E elite, R rest, $ shop, T treasure, ? unknown, A ancient, B boss',
  from: nodeKey(position), total_paths: total, distinct_room_sequences: seen.size,
  truncated: truncated || seen.size > maxRoutes, routes};
}

// v3: order-aware facts per map option. Every act map places a rest site on the
// floor right before the boss, so that rest is reported separately, not counted.
function optionPaths(nodes, key, maxPaths) {
 const out = [];
 const walk = (k, path) => {
  if (out.length >= maxPaths) return;
  const node = nodes.get(k);
  if (!node) return;
  if (node.type === 'Boss' || !node.children?.length) { out.push(path); return; }
  for (const [c,r] of node.children) walk(`${c},${r}`, [...path, node]);
 };
 walk(key, []);
 return out;
}

function pathStats(path) {
 const last = path.length - 1;
 // path[i] is i+1 floors away from the current position.
 const s = {elites:0, rests_before_boss_rest:0, shops:0, next_rest_in:null, next_elite_in:null, shop_in:[], elites_with_rest_before:0,
  rooms: path.map(n => ROOM[n.type] ?? '?').join('')};
 let restSinceElite = false;
 path.forEach((n, i) => {
  if (n.type === 'RestSite') {
   s.next_rest_in ??= i + 1;
   if (i !== last) { s.rests_before_boss_rest++; restSinceElite = true; }
  }
  if (n.type === 'Elite') {
   s.elites++; s.next_elite_in ??= i + 1;
   if (restSinceElite) s.elites_with_rest_before++;
   restSinceElite = false;
  }
  if (n.type === 'Shop') { s.shops++; s.shop_in.push(i + 1); }
 });
 return s;
}

const span = values => values.length ? range(Math.min(...values), Math.max(...values)) : null;
// Up to three example routes that no other route beats on elites, rests and shops together.
function examples(stats) {
 const better = (a, b) => a.elites >= b.elites && a.rests_before_boss_rest >= b.rests_before_boss_rest && a.shops >= b.shops
  && (a.elites > b.elites || a.rests_before_boss_rest > b.rests_before_boss_rest || a.shops > b.shops);
 const front = stats.filter(s => !stats.some(o => better(o, s)));
 const picks = [], add = s => { if (s && !picks.includes(s)) picks.push(s); };
 const by = f => [...front].sort((a, b) => f(b) - f(a))[0];
 add(by(s => s.elites * 10 + s.elites_with_rest_before));
 add(by(s => s.rests_before_boss_rest * 10 + s.shops));
 add(by(s => s.shops * 10 + (s.shop_in.at(-1) ?? 0)));
 return [...new Set(picks.slice(0, 3).map(s => s.rooms))];
}

export function orderedOptionRoutes(map, candidates, {maxPaths=2000}={}) {
 const {nodes} = graph(map), out = {};
 for (const c of candidates) {
  if (c.command?.action !== 'choose_map_node' || c.details?.col == null) continue;
  const stats = optionPaths(nodes, nodeKey(c.details), maxPaths).map(pathStats);
  if (!stats.length) continue;
  const rests = stats.map(s => s.next_rest_in).filter(v => v != null), elites = stats.map(s => s.next_elite_in).filter(v => v != null);
  out[c.id] = {paths_to_boss: stats.length,
   elites: span(stats.map(s => s.elites)),
   max_elites_with_rest_before: Math.max(...stats.map(s => s.elites_with_rest_before)),
   rests_before_boss_rest: span(stats.map(s => s.rests_before_boss_rest)),
   next_rest_in: span(rests), next_elite_in: span(elites),
   shops: span(stats.map(s => s.shops)), shop_in: span(stats.flatMap(s => s.shop_in)),
   example_routes: examples(stats)};
 }
 return out;
}

export function mapNodeKeys(map) { return (map?.nodes ?? []).map(nodeKey); }

// mapMemory = {runId, act, map, position}: the act map from the last map screen.
export function currentMap(state, mapMemory) {
 if (state.map?.nodes?.length) return {map: state.map, position: state.map.current_position};
 if (mapMemory && mapMemory.runId === state.run?.live_id && mapMemory.act === state.run?.act) return {map: mapMemory.map, position: mapMemory.position};
 return {map: null, position: null};
}

// Damage an enemy deals when killed (e.g. Steam Eruption), set against current HP.
// Forecasts list these rules as notes; this gives Jev the number every turn.
export function killCosts(state) {
 if (!combatScreens.has(state.state_type) || !state.battle) return null;
 const effects = [];
 for (const enemy of state.battle.enemies ?? []) {
  if (!(enemy.hp > 0) || enemy.hp >= 1e8) continue;
  for (const s of enemy.status ?? []) {
   if (!/when (?:it is |this enemy is )?killed|when this (?:enemy )?dies|on death/i.test(s.description ?? '')) continue;
   // Only damage-dealing rules; revival and other death rules are covered by forecasts.
   const damage = Number(s.description.match(/deals? (\d+) damage/i)?.[1]);
   if (Number.isFinite(damage)) effects.push({enemy: enemy.name, rule: s.description, damage});
  }
 }
 if (!effects.length) return null;
 const hp = state.player?.hp ?? null, total = effects.reduce((n, e) => n + e.damage, 0);
 return {effects, player_hp: hp, known_damage_total: total,
  exceeds_current_hp: hp != null && total >= hp,
  note: 'Killing these enemies triggers this damage; plan HP and block for when it resolves. Values change as the power grows.'};
}

export function computedFacts(state, candidates, mapMemory, {version=2}={}) {
 const facts = {}, p = state.player ?? {};
 const {map, position} = currentMap(state, mapMemory);
 if (state.state_type === 'map' && map) {
  facts.route_options = version >= 3 ? orderedOptionRoutes(map, candidates) : optionRoutes(map, candidates);
 } else if (map && position) {
  facts.route_ahead = remainingRoute(map, position);
 }
 const ahead = state.state_type === 'map' ? remainingRoute(map, position) : facts.route_ahead;
 if (state.state_type === 'rest_site') {
  const rest = (state.rest_site?.options ?? []).find(o => o.id === 'HEAL');
  const heal = Number(rest?.description?.match(/\((\d+)\)/)?.[1]);
  if (rest && Number.isFinite(heal) && p.max_hp) {
   const missing = p.max_hp - p.hp;
   facts.rest = {missing_hp: missing, rest_heals: heal, heal_wasted: Math.max(0, heal - missing)};
  }
 }
 if (p.potions) {
  facts.potions = {held: p.potions.length, slots: p.max_potion_slots ?? null,
   encounter: combatScreens.has(state.state_type) ? state.state_type : null,
   floors_to_boss: ahead?.floors_to_boss ?? null};
 }
 if (typeof p.gold === 'number' && ahead) facts.gold = {gold: p.gold, shops_ahead_this_act: ahead.shops};
 const deathEffects = killCosts(state);
 if (deathEffects) facts.death_effects = deathEffects;
 if (!Object.keys(facts).length) return null;
 facts.note = 'Exact counts from the visible act map and live state. Ranges are minimum-maximum over all paths to this act\'s boss. Unknown rooms are unrevealed; potion and gold values carry no judgment.';
 if (version >= 3 && facts.route_options) facts.route_note = 'Distances are floors from now (the option itself is 1). rests_before_boss_rest excludes the rest site every act has right before its boss. max_elites_with_rest_before counts elites reachable with a rest since the previous elite. example_routes list rooms in order (M monster, E elite, R rest, $ shop, T treasure, ? unknown, B boss) for routes no other route beats on elites, rests and shops together.';
 return facts;
}
