// A pool of long-lived headless sim workers (sim-client.mjs) for live engine forecasts.
// Every worker loads the same replay; the lines are cut into small chunks (one sample count per
// chunk, since samples is one number per simulate request) and each worker takes the next chunk
// when it is free, so slow lines do not hold up the rest. Results are keyed by line id; the caller
// orders them. A worker whose request fails (crash or timeout) leaves the decision, its chunk goes
// back to the queue once, and it is restarted in the background for the next decision. A worker that
// cannot be restarted (SimClient's restart limit) is retired; with none left the pool is dead.
export const DEFAULT_WORKERS = 4, MAX_WORKERS = 8;
// About 4 line-samples per request: 0.05 to 0.25 s of work each, from combat start to round 10.
export const CHUNK_COST = 4;

export function workerCount(text) {
  const n = Number.parseInt(text ?? '', 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_WORKERS) : DEFAULT_WORKERS;
}

// Chunks in line order: lines with the same sample count are grouped up to CHUNK_COST line-samples,
// and chunks are ordered by their first line, so with a deadline the first lines finish first.
export function chunkLines(lines, cost = CHUNK_COST) {
  const open = new Map(), chunks = [];
  for (const [order, line] of lines.entries()) {
    let c = open.get(line.samples);
    if (!c || c.cost + line.samples > cost && c.lines.length) { c = {order, samples: line.samples, cost: 0, lines: [], tries: 0}; open.set(line.samples, c); chunks.push(c); }
    c.lines.push({id: line.id, actions: line.actions}); c.cost += line.samples;
  }
  return chunks.sort((a, b) => a.order - b.order);
}

const retiring = error => /not restarting|failed to start|closed/.test(error?.message ?? '');

export class SimPool {
  constructor({size = DEFAULT_WORKERS, makeClient, onEvent = null} = {}) {
    this.workers = Array.from({length: Math.min(Math.max(1, size), MAX_WORKERS)}, (_, i) => ({i, client: makeClient(i), restarting: null}));
    this.onEvent = onEvent; this.retired = []; this.crashes = 0;
  }

  get size() { return this.workers.length; }
  get dead() { return this.workers.length === 0; }

  retire(w, reason) {
    if (!this.workers.includes(w)) return;
    this.workers = this.workers.filter(x => x !== w);
    this.retired.push({worker: w.i, reason});
    this.onEvent?.({type: 'retired', worker: w.i, reason});
    w.client.close?.().catch(() => {});
  }

  // A failed worker is restarted now (a ping boots it) so it is warm for the next decision.
  failed(w, error) {
    this.crashes++;
    if (retiring(error)) { this.retire(w, error.message); return; }
    this.onEvent?.({type: 'worker_error', worker: w.i, error: error.message});
    w.restarting ??= w.client.request('ping', {}, {timeoutMs: 30000})
      .catch(e => { if (retiring(e)) this.retire(w, e.message); })
      .finally(() => { w.restarting = null; });
  }

  // Pings every worker in parallel; workers that fail are retired. Resolves with the first pong.
  async start({timeoutMs = 30000} = {}) {
    const pongs = await Promise.all(this.workers.map(async w => {
      try {
        const pong = await w.client.request('ping', {}, {timeoutMs});
        if (!pong?.ok) { this.retire(w, `ping failed: ${pong?.error ?? 'not ok'}`); return null; }
        return pong;
      } catch (error) { this.retire(w, `ping failed: ${error.message}`); return null; }
    }));
    return pongs.find(Boolean) ?? null;
  }

  // Loads the replay on every worker. Resolves with [{worker, response}] for the loads that
  // succeeded and the errors of the rest; a worker still restarting is left out.
  async load(replay, {timeoutMs = 15000} = {}) {
    const ok = [], errors = [];
    await Promise.all(this.workers.filter(w => !w.restarting).map(async w => {
      try {
        const response = await w.client.request('load', {replay}, {timeoutMs});
        if (response?.ok) ok.push({worker: w, response}); else errors.push(String(response?.error ?? 'load failed'));
      } catch (error) { errors.push(error.message); this.failed(w, error); }
    }));
    return {ok: ok.sort((a, b) => a.worker.i - b.worker.i), errors};
  }

  // Simulates the lines on the given loaded workers. ctx.stopped (set by the caller at its deadline)
  // stops handing out chunks; results already in ctx.results stay. Resolves when every worker is
  // idle or stopped. ctx: {results: Map(line id -> result), failures: Map(line id -> reason), ms}.
  async simulate(workers, lines, {seed, knownTop = 0, timeoutMs = 15000, cost = CHUNK_COST}, ctx) {
    const queue = chunkLines(lines, cost);
    ctx.results ??= new Map(); ctx.failures ??= new Map(); ctx.ms ??= 0; ctx.requests ??= 0;
    const loop = async w => {
      while (!ctx.stopped && queue.length) {
        const chunk = queue.shift();
        try {
          ctx.requests++;
          const r = await w.client.request('simulate', {lines: chunk.lines, end_turn: true, samples: chunk.samples, seed, known_top: knownTop}, {timeoutMs});
          if (!r?.ok) { for (const l of chunk.lines) ctx.failures.set(l.id, `simulate failed: ${String(r?.error ?? '').slice(0, 200)}`); continue; }
          for (const res of r.results ?? []) ctx.results.set(res.id, res);
          ctx.ms += r.ms ?? 0;
        } catch (error) {
          // The chunk is retried once on another worker; this worker leaves the decision.
          if (++chunk.tries < 2) queue.unshift(chunk);
          else for (const l of chunk.lines) ctx.failures.set(l.id, `worker error: ${error.message}`);
          ctx.crashed.add(w);
          this.failed(w, error);
          return;
        }
      }
    };
    // A chunk put back after a crash may find the other workers already idle: run them again.
    const healthy = new Set(workers);
    const run = async w => { await loop(w); if (ctx.crashed?.has(w)) healthy.delete(w); };
    ctx.crashed = new Set();
    while (!ctx.stopped && queue.length && healthy.size) await Promise.all([...healthy].map(run));
    // Chunks left when every worker failed.
    if (!ctx.stopped) for (const chunk of queue) for (const l of chunk.lines) if (!ctx.failures.has(l.id)) ctx.failures.set(l.id, 'no worker left');
  }

  async close() { await Promise.all(this.workers.map(w => w.client.close?.().catch(() => {}))); }
}
