import { appendFileSync, closeSync, existsSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { DemoAdapter } from './adapters/demo.js';
import { BridgeAdapter } from './adapters/bridge.js';
import { JevDecisions, MockDecisions } from './decisions.js';
import { run } from './engine.js';
import { writeReport } from './report.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
async function main() {
  const [command = 'doctor', ...args] = process.argv.slice(2);
  if (command === 'doctor') {
    await loadConfig(join(root, 'config/demo.json'));
    console.log(`Project: ${root}\nRuntime: ${process.platform} ${process.arch}, Node ${process.version}\nOfficial TypeSafe SDK: 0.6.0\nOffline demo: ready\nGame: not selected\nJev API key: ${process.env.TYPESAFE_API_KEY ? 'present (not validated)' : 'not configured; offline mode ready'}\nOperator lock: ${existsSync(join(root, '.operator.lock')) ? 'present; inspect before starting' : 'clear'}\nNo API request or game input was made.`);
    return;
  }
  if (command !== 'run' || args.some((a, i) => i % 2 === 0 && a !== '--config') || args.length % 2)
    throw new Error('Usage: npm start -- --config config/game.local.json');
  const profile = args[args.indexOf('--config') + 1];
  const config = await loadConfig(resolve(root, profile ?? 'config/demo.json'));
  const decisions = config.provider === 'jev' ? new JevDecisions(config.model, process.env.TYPESAFE_API_KEY ?? '') : new MockDecisions();
  const lockPath = join(root, '.operator.lock');
  let lock: number;
  try { lock = openSync(lockPath, 'wx'); } catch { throw new Error('Operator lock exists. Check .operator.lock and its PID; remove it only after confirming that run stopped.'); }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), profile }));
    const adapter = config.adapter === 'demo' ? new DemoAdapter() : new BridgeAdapter(config.bridgeUrl!, process.env.GAME_BRIDGE_TOKEN ?? '');
    const dir = join(root, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
    await mkdir(dir, { recursive: true });
    const events = join(dir, 'events.jsonl');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    let summary;
    try {
      summary = await run(adapter, decisions, config, event => {
        appendFileSync(events, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
        if (event.type === 'action_applied') console.log(`Step ${event.step}: ${event.action}`);
      }, controller.signal);
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeReport(dir);
    console.log(`Result: ${summary.reason}\nReport: ${join(dir, 'report.html')}\nTrace: ${events}`);
    process.exitCode = summary.reason === 'won' ? 0 : summary.reason === 'error' || summary.reason === 'cleanup_error' ? 1 : 2;
  } finally { closeSync(lock!); unlinkSync(lockPath); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Setup failed.'); process.exitCode = 1; });
