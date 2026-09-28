// Card and relic descriptions for names the strategist brief mentions without explaining:
// shop and reward options with no description, and names inside option text
// ("Add Metamorphosis to your Deck", "Obtain the Chosen Cheese").
// Only exact name matches are used, so a fuzzy near-miss never supplies wrong text.

// Words that start with a capital in game text but are keywords, not card or relic names.
const KEYWORDS = new Set(['add','obtain','gain','lose','deal','apply','replace','choose','upgrade','remove','transform','heal','draw',
 'exhaust','block','vulnerable','weak','frail','strength','dexterity','energy','hp','max','deck','hand','draw pile','discard pile',
 'common','uncommon','rare','attack','attacks','skill','skills','power','powers','curse','curses','status','potion','potions',
 'relic','relics','card','cards','gold','all','the','a','an','at','each','whenever','if','upon','every','this','your','it',
 'enemies','enemy','turn','combat','ethereal','innate','retain','unplayable','neow','random']);

const normalize = name => String(name ?? '').trim().toLowerCase().replace(/^the\s+/, '');
const stripPrice = label => String(label ?? '').replace(/\s+[—-]\s+\d+\s+gold$/i, '').trim();

// Capitalized phrases (up to 4 words, allowing "of"/"the"/apostrophes) that could be names.
export function candidateNames(text) {
 const found = new Set();
 for (const m of String(text ?? '').matchAll(/\b(?:the\s+)?([A-Z][\w'’-]*(?:\s+(?:of|the|and|[A-Z][\w'’-]*)){0,3})/g)) {
  // Drop leading keywords ("Add Metamorphosis" -> "Metamorphosis") and trailing connectors.
  const words = m[1].replace(/\s+(?:of|the|and)$/i, '').trim().split(/\s+/);
  while (words.length > 1 && KEYWORDS.has(words[0].toLowerCase())) words.shift();
  const phrase = words.join(' ');
  if (words.every(w => KEYWORDS.has(w.toLowerCase()))) continue;
  if (words.length === 1 && KEYWORDS.has(phrase.toLowerCase())) continue;
  found.add(phrase);
 }
 return [...found];
}

// lookup(name) resolves to [{name, item_type, description, ...}] search results.
export function makeGlossary(lookup) {
 const cache = new Map();
 const exact = async name => {
  const key = normalize(name);
  if (!key) return null;
  if (!cache.has(key)) {
   cache.set(key, (async () => {
    try {
     const results = await lookup(name);
     const hit = (results ?? []).find(r => normalize(r.name) === key && r.description);
     return hit ? {name: hit.name, type: hit.item_type ?? null, description: hit.description} : null;
    } catch { return null; }
   })());
  }
  return cache.get(key);
 };
 // Fills missing option descriptions in place and returns glossary entries for named items.
 return async brief => {
  const options = brief.current_options ?? [];
  for (const option of options) {
   if (option.description) continue;
   const found = await exact(stripPrice(option.label));
   if (found) { option.description = found.description; option.item_type = found.type; }
  }
  const known = new Set([...(brief.deck ?? []).map(c => normalize(c.name)), ...(brief.relics ?? []).map(r => normalize(r.name)),
   ...options.map(o => normalize(stripPrice(o.label)))]);
  const entries = [];
  for (const option of options) {
   for (const name of candidateNames(option.description)) {
    if (known.has(normalize(name))) continue;
    const found = await exact(name);
    if (found && !entries.some(e => e.name === found.name)) entries.push(found);
   }
  }
  if (entries.length) brief.glossary = entries;
  return brief;
 };
}

// The bridge's wiki search over the active profile's discovered cards and relics.
export const bridgeLookup = (bridge = 'http://127.0.0.1:15526') => async name => {
 const response = await fetch(`${bridge}/api/v1/wiki?q=${encodeURIComponent(name)}&limit=3`, {signal: AbortSignal.timeout(3000)});
 if (!response.ok) return [];
 return (await response.json()).results ?? [];
};
