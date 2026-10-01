// Client for the headless STS2 combat worker (integration/sts2-sim): a child process that reads one
// JSON request per line on stdin and writes one JSON response per line on stdout, in order, echoing
// the request id. Logs go to stderr. Requests carry their own timeouts. A timed-out worker is killed
// (its later responses would be out of step), and a worker that exits is restarted on the next
// request, up to maxRestarts times per client.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_SIM_EXE = resolve(root, 'integration/sts2-sim/bin/Release/net9.0/win-x64/Sts2Sim.exe');
export const DEFAULT_SIM_ARGS = ['serve'];

// STS2_SIM_ARGS: a JSON array, or words separated by spaces.
export function simArgs(text) {
  if (text == null || text === '') return DEFAULT_SIM_ARGS;
  const t = String(text).trim();
  if (t.startsWith('[')) return JSON.parse(t).map(String);
  return t.split(/\s+/);
}

// The worker needs the game folder; it never needs keys or tokens, so those are left out.
export function workerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/key|token|secret|password/i.test(k)));
}

export class SimClient {
  constructor({exe = DEFAULT_SIM_EXE, args = DEFAULT_SIM_ARGS, env = process.env, timeoutMs = 30000, maxRestarts = 3, onStderr = null, spawnFn = spawn} = {}) {
    Object.assign(this, {exe, args, env: workerEnv(env), timeoutMs, maxRestarts, onStderr, spawnFn});
    this.child = null; this.pending = new Map(); this.nextId = 1; this.starts = 0; this.closed = false;
    this.exitHook = () => { try { this.child?.kill(); } catch {} };
    process.once('exit', this.exitHook);
  }

  get restarts() { return Math.max(0, this.starts - 1); }

  start() {
    if (this.closed) throw Error('Sim client is closed.');
    if (this.child) return;
    if (this.starts > this.maxRestarts) throw Error(`Sim worker exited ${this.starts} times; not restarting.`);
    this.starts++;
    const child = this.spawnFn(this.exe, this.args, {env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    this.child = child;
    const fail = message => {
      if (this.child === child) this.child = null;
      for (const [, p] of this.pending) if (p.child === child) { clearTimeout(p.timer); this.pending.delete(p.id); p.reject(Error(message)); }
    };
    child.on('error', error => fail(`Sim worker failed to start or crashed: ${error.code ?? error.message}`));
    child.on('exit', (code, signal) => fail(`Sim worker exited (${signal ?? code}).`));
    child.stdin.on('error', () => {});
    createInterface({input: child.stdout}).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const p = this.pending.get(String(msg?.id));
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(p.id); p.resolve(msg);
    });
    createInterface({input: child.stderr}).on('line', line => this.onStderr?.(line));
  }

  // Resolves with the worker's response (ok true or false); rejects on timeout or a worker exit.
  request(cmd, payload = {}, {timeoutMs = this.timeoutMs} = {}) {
    return new Promise((resolvePromise, reject) => {
      try { this.start(); } catch (error) { reject(error); return; }
      const child = this.child, id = `r${this.nextId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Sim worker timed out after ${timeoutMs} ms on ${cmd}.`));
        // Responses are in order, so a late answer would be read as the next request's: restart.
        if (this.child === child) { this.child = null; try { child.kill(); } catch {} }
      }, timeoutMs);
      this.pending.set(id, {id, child, timer, resolve: resolvePromise, reject});
      child.stdin.write(JSON.stringify({id, cmd, ...payload}) + '\n');
    });
  }

  // Ends stdin so the worker can exit by itself, then kills it after graceMs.
  async close({graceMs = 2000} = {}) {
    this.closed = true;
    process.removeListener('exit', this.exitHook);
    const child = this.child; this.child = null;
    if (!child) return;
    const exited = new Promise(r => { if (child.exitCode != null || child.signalCode != null) r(); else child.once('exit', r); });
    try { child.stdin.end(); } catch {}
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, graceMs);
    await exited; clearTimeout(timer);
  }
}
