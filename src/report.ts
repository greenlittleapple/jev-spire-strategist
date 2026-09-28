import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export async function writeReport(dir: string) {
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const summary = events.findLast(e => e.type === 'summary');
  const start = events[0];
  const rows = events.filter(e => ['observation', 'decision', 'action_intent', 'action_applied', 'error'].includes(e.type)).map(e =>
    `<tr><td>${escape(e.step ?? '')}</td><td>${escape(e.type)}</td><td><pre>${escape(JSON.stringify(e.observation ?? e.decision ?? e, null, 2))}</pre></td></tr>`).join('');
  await writeFile(join(dir, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jev Game Lab run</title>
<style>body{background:#11171d;color:#e6ebed;font:16px/1.55 system-ui;margin:40px auto;padding:0 24px;max-width:980px}h1{font-size:28px}a{color:#8bdad1}p{color:#bdc9ce}table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #35434b}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:13px/1.5 Consolas,monospace}.summary{border:1px solid #35434b;padding:18px;border-radius:8px}</style>
<h1>Jev Game Lab</h1><p>${escape(start.adapter)} · ${escape(start.config.provider)} · ${escape(start.config.objective)}</p>
<div class="summary"><strong>Result: ${escape(summary.reason)}</strong><p>${summary.steps} confirmed actions · ${summary.calls} decision calls · ${summary.inputTokens} input tokens · ${summary.elapsedMs} ms</p>${summary.unconfirmedAction ? `<p>Unconfirmed dispatch: ${escape(summary.unconfirmedAction.action)}. Inspect the game before resuming. Action ID: ${escape(summary.unconfirmedAction.actionId)}</p>` : ''}</div>
<p>${start.config.provider === 'mock' ? 'Offline verification uses a scripted demo policy. This run makes no API calls and does not measure Jev ability.' : 'Decisions requested from Jev; deterministic single-option actions are labeled separately.'}</p>
<h2>Run trace</h2><table><thead><tr><th>Step</th><th>Event</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></html>`);
}
