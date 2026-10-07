// README charts: how far each version got, and the median time per move. Renders light and
// dark SVGs into docs/images from docs/progress/data.json and fills the README's results, table
// and cost blocks between their markers. With --refresh it first updates each listed run's result and the
// pace figures from the private run logs; --add first lists every logged run not yet in the data under its
// version (progress-data.mjs), then refreshes. A new version is a new entry in data.json.
//   npm run sts2:progress [-- --refresh | --add]
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readLogs, scoreLogged, refreshRun, memoryIssues, addRuns, addToolIssues, checkIssues, seriesRows, finishedRuns, winRate, winRateText, mixedCommitRows, mixedModRows} from './progress-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dataFile = resolve(root, 'docs/progress/data.json');
const outDir = resolve(root, 'docs/images');

const THEMES = {
 light: {surface: '#fcfcfb', text: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', track: 0.35, series: ['#2a78d6', '#eb6834'], good: '#0ca30c', goodText: '#006300'},
 dark: {surface: '#1a1a19', text: '#ffffff', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', track: 0.5, series: ['#3987e5', '#d95926'], good: '#0ca30c', goodText: '#0ca30c'},
};
const FONT = `system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;
const W = 960, LEFT = 24;

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, content, {size = 13, weight = 400, fill, anchor = 'start'} = {}) =>
 `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${content}</text>`;
function wrap(s, max) {
 const lines = [''];
 for (const word of s.split(' ')) {
  if (lines.at(-1) && (lines.at(-1) + ' ' + word).length > max) lines.push(word);
  else lines[lines.length - 1] = lines.at(-1) ? lines.at(-1) + ' ' + word : word;
 }
 return lines;
}
// A bar growing right from x0, square at the baseline and rounded at the data end.
const bar = (x0, x1, cy, h, fill, opacity = 1) => {
 const r = Math.min(h / 2, 4, Math.max(0, x1 - x0)), top = cy - h / 2, bottom = cy + h / 2;
 return `<path d="M${x0},${top} H${x1 - r} A${r},${r} 0 0 1 ${x1},${top + r} V${bottom - r} A${r},${r} 0 0 1 ${x1 - r},${bottom} H${x0} Z" fill="${fill}" fill-opacity="${opacity}"/>`;
};
// The letter for an issue ID: a for the first in data.issues, b for the second, and so on.
export function issueMarker(data, id) {
 const i = (data.issues ?? []).findIndex(x => x.id === id);
 if (i < 0) throw Error(`Unknown issue ${id}; add it to issues.`);
 return String.fromCharCode(97 + i);
}
const affected = r => (r.issues?.length ?? 0) > 0;
const fixedNote = f => !f || f === '-' ? '' : /^[0-9a-f]{7,40}$/.test(f) ? ` Fixed in ${f}.` : ` Fixed: ${f}.`;
const svg = (height, title, desc, t, body) =>
 `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="t d" font-family="${FONT}">\n`
 + `<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>\n`
 + `<rect width="${W}" height="${height}" rx="12" fill="${t.surface}"/>\n${body.join('\n')}\n</svg>\n`;

export function progressSvg(data, t) {
 checkIssues(data);
 const X0 = 590, X1 = 870, maxFloor = Math.max(...data.bosses.map(b => b.floor));
 const x = f => X0 + (X1 - X0) * f / maxFloor;
 const rowsOf = seriesRows(data), hollow = rowsOf.some(v => finishedRuns(v).some(affected)), off = hollow ? 20 : 0;
 const body = [
  text(LEFT, 40, 'How far each version got', {size: 20, weight: 600, fill: t.text}),
  text(LEFT, 64, esc(`${data.game}. Each dot is one run, green if it won; the bar reaches the best run.`), {size: 14, fill: t.secondary}),
  ...(hollow ? [text(LEFT, 84, 'Hollow dots: runs affected by a known issue (see the notes under the table).', {size: 13, fill: t.secondary})] : []),
 ];
 for (const b of data.bosses) {
  body.push(text(x(b.floor), 100 + off, esc(b.label), {size: 13, weight: 600, fill: t.secondary, anchor: 'middle'}),
   text(x(b.floor), 117 + off, `floor ${b.floor}`, {size: 12, fill: t.muted, anchor: 'middle'}));
 }
 let y = 130 + off;
 const rows = [], top = y;
 for (const [gi, g] of data.groups.entries()) {
  const color = t.series[gi];
  rows.push(`<circle cx="${LEFT + 6}" cy="${y + 21}" r="6" fill="${color}"/>`, text(LEFT + 20, y + 26, esc(g.label), {size: 14, weight: 600, fill: t.text}));
  y += 38;
  for (const v of rowsOf.filter(v => v.group === g.id)) {
   const done = finishedRuns(v), rate = winRate(v);
   const lines = wrap(v.added, 88);
   const h = 26 + 18 * lines.length + 8, cy = y + h / 2;
   rows.push(`<text x="${LEFT}" y="${y + 18}" font-size="15"><tspan font-weight="600" fill="${t.text}">${esc(v.name)}</tspan><tspan fill="${t.muted}" font-size="13"> · ${rate ? esc(winRateText(rate)) : `${done.length} run${done.length === 1 ? '' : 's'}`}</tspan></text>`);
   lines.forEach((line, i) => rows.push(text(LEFT, y + 38 + 18 * i, esc(line), {size: 13.5, fill: t.secondary})));
   if (done.length) {
    const best = Math.max(...done.map(r => r.floor));
    rows.push(bar(X0, x(best), cy, 6, color, t.track));
    // Runs that ended on the same floor stack vertically, centered on the row. A win is a
    // larger dot in the status green, drawn on top, and its label says so.
    const dots = [...Map.groupBy(done, r => r.floor).values()]
     .flatMap(same => same.map((r, i) => ({r, dy: (i - (same.length - 1) / 2) * 7})))
     .sort((a, b) => (a.r.result === 'won') - (b.r.result === 'won'));
    for (const {r, dy} of dots) {
     const won = r.result === 'won', fill = won ? t.good : color;
     // A run affected by a known issue is hollow, outlined in its colour.
     rows.push(affected(r) ? `<circle cx="${x(r.floor)}" cy="${cy + dy}" r="${won ? 5.5 : 3.5}" fill="${t.surface}" stroke="${fill}" stroke-width="2"/>`
      : `<circle cx="${x(r.floor)}" cy="${cy + dy}" r="${won ? 6.5 : 4.5}" fill="${fill}" stroke="${t.surface}" stroke-width="2"/>`);
    }
    const won = done.some(r => r.result === 'won' && r.floor === best);
    rows.push(`<text x="${x(best) + 12}" y="${cy + 5}" font-size="13" font-weight="600"><tspan fill="${t.text}">${best}</tspan>`
     + `${won ? `<tspan fill="${t.goodText}"> ✓ won</tspan>` : ''}</text>`);
   }
   y += h;
  }
  y += 6;
 }
 // Floor 0 baseline and the boss floors, drawn under the rows.
 const guides = [`<line x1="${X0}" y1="${top}" x2="${X0}" y2="${y}" stroke="${t.axis}" stroke-width="1"/>`,
  ...data.bosses.map(b => `<line x1="${x(b.floor)}" y1="${top}" x2="${x(b.floor)}" y2="${y}" stroke="${t.grid}" stroke-width="1"/>`)];
 body.push(...guides, ...rows);
 y += 8;
 for (const note of data.notes) for (const line of wrap(note, 146)) { y += 18; body.push(text(LEFT, y, esc(line), {size: 12.5, fill: t.muted})); }
 const plotted = rowsOf.map(v => `${v.name}: best floor ${Math.max(0, ...finishedRuns(v).map(r => r.floor))}`).join('; ');
 return svg(y + 24, 'How far each version got', plotted, t, body);
}

export function paceSvg(data, t) {
 const groups = data.pace.groups.filter(g => g.median_s != null);
 const X0 = 560, X1 = 880, maxS = Math.ceil(Math.max(...groups.map(g => g.median_s)) + 0.5);
 const x = s => X0 + (X1 - X0) * s / maxS;
 const body = [
  text(LEFT, 40, 'Median time per move', {size: 20, weight: 600, fill: t.text}),
  text(LEFT, 64, esc(data.pace.about), {size: 14, fill: t.secondary}),
 ];
 let y = 92;
 const top = y, rows = [];
 for (const g of groups) {
  const current = g.id === 'ready', cy = y + 26;
  rows.push(text(LEFT, y + 22, esc(g.label), {size: 15, weight: 600, fill: t.text}),
   text(LEFT, y + 42, esc(`${g.detail} · ${g.runs} run${g.runs === 1 ? '' : 's'}, ${g.moves.toLocaleString('en-US')} moves`), {size: 13.5, fill: t.secondary}),
   bar(X0, x(g.median_s), cy, 16, current ? t.series[0] : t.muted),
   text(x(g.median_s) + 10, cy + 5, `${g.median_s.toFixed(2)} s`, {size: 14, weight: 600, fill: t.text}));
  y += 60;
 }
 const ticks = Array.from({length: maxS + 1}, (_, s) => s);
 body.push(...ticks.map(s => `<line x1="${x(s)}" y1="${top}" x2="${x(s)}" y2="${y}" stroke="${s ? t.grid : t.axis}" stroke-width="1"/>`), ...rows,
  ...ticks.map(s => text(x(s), y + 18, `${s} s`, {size: 12, fill: t.muted, anchor: 'middle'})));
 return svg(y + 40, 'Median time per move', groups.map(g => `${g.label}: ${g.median_s.toFixed(2)} s`).join('; '), t, body);
}

// The README's table view of the progress chart. A row with a win rate (winRate) leads with it. A run
// affected by a known issue gets the issue's letter, and the letters used are explained under the table. An issue's
// fixed is a commit, '-' for none, or a phrase for a fix made outside the code (a settings change).
export function progressTable(data) {
 checkIssues(data);
 const floor = r => r.result === 'in progress' ? `in progress (floor ${r.floor})` : r.result === 'won' ? `won (floor ${r.floor})` : String(r.floor);
 const cell = r => `${r.seed ? `${r.seed}: ` : ''}${floor(r)}`;
 const marks = r => affected(r) ? `<sup>${r.issues.map(id => issueMarker(data, id)).join(',')}</sup>` : '';
 const runs = v => v.runs.map(r => (r.result === 'won' ? `**${cell(r)}**` : cell(r)) + (r.replay ? ' (replay)' : '') + marks(r)).join(', ') || '-';
 const rated = v => { const w = winRate(v); return w ? `**${winRateText(w)}**: ${runs(v)}` : runs(v); };
 const used = new Set(data.versions.flatMap(v => v.runs.flatMap(r => r.issues ?? [])));
 const notes = (data.issues ?? []).filter(i => used.has(i.id))
  .map(i => `- <sup>${issueMarker(data, i.id)}</sup> ${i.label}${fixedNote(i.fixed)}`);
 return ['| Version | Final floor of each run | What it added |', '|---|---|---|',
  ...seriesRows(data).map(v => `| ${v.name} (\`${v.policy}\`) | ${rated(v)} | ${v.added} |`), ...(notes.length ? ['', ...notes] : [])].join('\n');
}

// The README's results summary and cost line, so its numbers follow the data.
export function readmeSummary(data) {
 const finished = g => data.versions.filter(v => v.group === g).flatMap(v => v.runs.map(r => ({...r, version: v.name})))
  .filter(r => r.floor != null && r.result !== 'in progress');
 const jev = finished('jev'), strategist = finished('strategist'), final = Math.max(...data.bosses.map(b => b.floor));
 const wins = strategist.filter(r => r.result === 'won').map(r => `${r.version} on seed ${r.seed}`);
 const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
 const results = `**Results so far** (Ironclad, Ascension 0, standard runs): `
  + (wins.length ? `${count(wins.length, 'win')}, by ${wins.join(' and ')}. ` : 'no win yet. ')
  + `Of the ${count(strategist.length, 'finished strategist run')}, ${strategist.filter(r => r.floor >= final).length} reached the final boss on floor ${final}. `
  + `Jev alone got no further than floor ${Math.max(...jev.map(r => r.floor))} in ${count(jev.length, 'run')}.`;
 const millions = runs => runs.map(r => r.tokens).filter(Boolean).map(t => t / 1e6);
 const range = m => `${Math.min(...m).toFixed(1)} to ${Math.max(...m).toFixed(1)} million`;
 const all = [...millions(jev), ...millions(strategist)], dollars = m => `$${(m * 0.042).toFixed(2)}`;
 const cost = `Jev used ${range(millions(jev))} input tokens per Jev-only run and ${range(millions(strategist))} with the strategist, `
  + `about ${dollars(Math.min(...all))} to ${dollars(Math.max(...all))} per run at TypeSafe's listed $0.042 per million input tokens (output is free). `
  + `Claude's usage counts against the Claude Code subscription and is not measured here.`;
 return {results, cost};
}

// Median seconds between consecutive executed moves, by how the runner waited between moves:
// on the bridge's readiness report (states carry `ready`), or fixed waits with the imported
// jev-visible policies or the compact ones. Gaps over 10 minutes are pauses and left out.
export function paceGroups(events) {
 const runs = new Map();
 for (const e of events) {
  if (e.kind !== 'decision' || e.outcome !== 'executed' || !e.state?.run?.live_id) continue;
  const r = runs.get(e.state.run.live_id)
   ?? {times: [], group: 'ready' in e.state ? 'ready' : /^jev-visible/.test(e.policy ?? '') ? 'imported' : 'fixed'};
  runs.set(e.state.run.live_id, r);
  r.times.push(Date.parse(e.time));
 }
 const groups = {};
 for (const r of runs.values()) {
  if (r.times.length < 5) continue;
  const g = groups[r.group] ??= {runs: 0, moves: 0, gaps: []};
  g.runs++; g.moves += r.times.length;
  for (let i = 1; i < r.times.length; i++) { const s = (r.times[i] - r.times[i - 1]) / 1000; if (s <= 600) g.gaps.push(s); }
 }
 return Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, {runs: g.runs, moves: g.moves, median_s: Math.round(median(g.gaps) * 100) / 100}]));
}

// Updates each listed run and the pace figures from the logs; with add, first adds the runs not yet listed.
// Returns the --add report (or null) and warnings for rows that mix recorded lab commits or mod sets.
export async function refresh(data, {add = false, logs} = {}) {
 logs ??= await readLogs();
 const scored = scoreLogged(logs);
 const report = add ? addRuns(data, scored) : null;
 for (const v of data.versions) for (const r of v.runs) refreshRun(v, r, scored.get(r.run));
 memoryIssues(data, scored);
 addToolIssues(data);
 const pace = paceGroups(logs.events);
 for (const g of data.pace.groups) Object.assign(g, pace[g.id] ?? {runs: 0, moves: 0, median_s: null});
 const warnings = [...mixedCommitRows(data).map(x => `${x.name} mixes runs from lab commits ${x.commits.join(', ')}; it gets no win rate until they are split into versions.`),
  ...mixedModRows(data).map(x => `${x.name} mixes runs with mod sets ${x.mods.join(', ')}; it gets no win rate until they are split into versions.`)];
 return {report, warnings};
}

// Indented JSON with each innermost object (a run, a boss, a pace group, an issue) on one line. Arrays of
// strings without spaces (a run's issues) go on one line first, so a run with issues stays on one line.
export const compactJson = data => JSON.stringify(data, null, 1)
 .replace(/\[\n\s+((?:"[^"\s]*",\n\s+)*"[^"\s]*")\n\s+\]/g, (_, inner) => `[${inner.replace(/\n\s+/g, ' ')}]`)
 .replace(/\{\n\s+([^{}]*?)\n\s+\}/g, (_, inner) => `{${inner.replace(/\n\s+/g, ' ')}}`) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const data = JSON.parse(await readFile(dataFile, 'utf8'));
 const add = process.argv.includes('--add');
 if (add || process.argv.includes('--refresh')) {
  const {report, warnings} = await refresh(data, {add});
  if (report) {
   for (const a of report.added) console.log(`Added ${a.run}${a.seed ? ` (${a.seed})` : ''} to ${a.version}: ${a.result}, floor ${a.floor}`);
   for (const u of report.unmatched) console.log(`Left out ${u.run}${u.label ? ` ("${u.label}")` : ''}: ${u.reason}`);
   for (const x of report.excluded) console.log(`Excluded on purpose ${x.run}: ${x.reason}`);
   if (report.skipped.length) console.log(`Skipped (the runner made no move): ${report.skipped.join(', ')}`);
   if (!report.added.length) console.log('No new runs to add.');
  }
  for (const w of warnings) console.warn(`Warning: ${w}`);
  checkIssues(data);
  await writeFile(dataFile, compactJson(data));
 }
 await mkdir(outDir, {recursive: true});
 for (const [mode, t] of Object.entries(THEMES)) {
  await writeFile(resolve(outDir, `progress-${mode}.svg`), progressSvg(data, t));
  await writeFile(resolve(outDir, `pace-${mode}.svg`), paceSvg(data, t));
 }
 // Generated README blocks sit between <!-- name:start --> and <!-- name:end --> markers.
 const readmeFile = resolve(root, 'README.md'), readme = await readFile(readmeFile, 'utf8');
 const {results, cost} = readmeSummary(data);
 let updated = readme;
 for (const [name, content] of [['results', results], ['progress-table', progressTable(data)], ['cost', cost]])
  updated = updated.replace(new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->`),
   () => `<!-- ${name}:start -->\n\n${content}\n\n<!-- ${name}:end -->`);
 if (updated !== readme) await writeFile(readmeFile, updated);
 console.log(`Wrote progress and pace charts to ${outDir}`);
}
