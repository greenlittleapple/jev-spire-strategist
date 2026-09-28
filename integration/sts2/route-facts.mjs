// Exact counts over the visible act map and live resources. These are facts for
// Jev and the strategist; they never remove options.
export const FACTS_POLICY = 'jev-compact-v2';
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
 const routes = [...seen].slice(0, maxRoutes).map(([rooms, path]) => ({rooms, nodes: path}));
 return {legend: 'M monster, E elite, R rest, $ shop, T treasure, ? unknown, A ancient, B boss',
  from: nodeKey(position), total_paths: total, distinct_room_sequences: seen.size,
  truncated: truncated || seen.size > maxRoutes, routes};
}

export function mapNodeKeys(map) { return (map?.nodes ?? []).map(nodeKey); }

// mapMemory = {runId, act, map, position}: the act map from the last map screen.
export function currentMap(state, mapMemory) {
 if (state.map?.nodes?.length) return {map: state.map, position: state.map.current_position};
 if (mapMemory && mapMemory.runId === state.run?.live_id && mapMemory.act === state.run?.act) return {map: mapMemory.map, position: mapMemory.position};
 return {map: null, position: null};
}

export function computedFacts(state, candidates, mapMemory) {
 const facts = {}, p = state.player ?? {};
 const {map, position} = currentMap(state, mapMemory);
 if (state.state_type === 'map' && map) {
  facts.route_options = optionRoutes(map, candidates);
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
 if (!Object.keys(facts).length) return null;
 facts.note = 'Exact counts from the visible act map and live state. Ranges are minimum-maximum over all paths to this act\'s boss. Unknown rooms are unrevealed; potion and gold values carry no judgment.';
 return facts;
}
