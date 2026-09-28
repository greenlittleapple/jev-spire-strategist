import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Adapter, Config, DecisionMaker, Observation } from './contracts.js';
import { validateObservation } from './contracts.js';
import { makeRequest } from './decisions.js';

export interface Summary { reason: string; steps: number; calls: number; inputTokens: number; elapsedMs: number; unconfirmedAction?: { action: string; actionId: string }; }
export type Event = Record<string, unknown>;
export async function run(adapter: Adapter, decisions: DecisionMaker, config: Config,
  emit: (event: Event) => void = () => {}, userSignal?: AbortSignal): Promise<Summary> {
  const start = Date.now();
  const signal = AbortSignal.any([AbortSignal.timeout(config.maxSeconds * 1000), ...(userSignal ? [userSignal] : [])]);
  const visits = new Map<string, number>();
  const result: Summary = { reason: 'step_limit', steps: 0, calls: 0, inputTokens: 0, elapsedMs: 0 };
  let lastCall = 0;
  async function observe(): Promise<Observation> {
    signal.throwIfAborted();
    const o = await adapter.observe(signal);
    validateObservation(o);
    emit({ type: 'observation', step: result.steps, observation: o });
    return o;
  }
  try {
    emit({ type: 'start', adapter: adapter.id, config });
    while (true) {
      const o = await observe();
      if (o.status !== 'running') { result.reason = o.status; break; }
      if (result.steps >= config.maxSteps) break;
      const seen = (visits.get(o.progressKey) ?? 0) + 1;
      visits.set(o.progressKey, seen);
      if (seen > config.maxRepeatedStates) { result.reason = 'repeated_state'; break; }
      if (!o.actions.length) { result.reason = 'no_legal_actions'; break; }
      let decision;
      if (o.actions.length === 1) {
        decision = { action: o.actions[0].id, confidence: 1, model: 'deterministic-single-option', probabilities: {}, inputTokens: 0 };
      } else {
        if (result.calls >= config.maxCalls) { result.reason = 'call_limit'; break; }
        if (result.inputTokens >= config.maxInputTokens) { result.reason = 'token_limit'; break; }
        const request = makeRequest(o, config.objective, config.model);
        if (Buffer.byteLength(JSON.stringify(request), 'utf8') > config.maxRequestBytes) { result.reason = 'request_size_limit'; break; }
        await delay(Math.max(0, config.minIntervalMs - (Date.now() - lastCall)), undefined, { signal });
        signal.throwIfAborted();
        lastCall = Date.now();
        result.calls++;
        emit({ type: 'request', step: result.steps, request });
        decision = await decisions.choose(o, config.objective, signal);
        result.inputTokens += decision.inputTokens;
      }
      emit({ type: 'decision', step: result.steps, decision });
      if (!o.actions.some(a => a.id === decision.action)) { result.reason = 'illegal_decision'; break; }
      if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1 ||
          decision.confidence < config.minConfidence) { result.reason = 'low_confidence'; break; }
      signal.throwIfAborted();
      // Check again after network latency. Adapter must also check atomically at execution.
      const fresh = await adapter.observe(signal);
      validateObservation(fresh);
      if (fresh.status !== 'running' || fresh.revision !== o.revision || fresh.progressKey !== o.progressKey ||
          !fresh.actions.some(a => a.id === decision.action)) { result.reason = 'stale_observation'; break; }
      const actionId = randomUUID();
      // Persist intent before dispatch so an interrupted/ambiguous action can be reconciled.
      emit({ type: 'action_intent', step: result.steps, action: decision.action, revision: o.revision, actionId });
      signal.throwIfAborted();
      result.unconfirmedAction = { action: decision.action, actionId };
      await adapter.execute(decision.action, o.revision, actionId, signal);
      delete result.unconfirmedAction;
      result.steps++;
      emit({ type: 'action_applied', step: result.steps, action: decision.action, actionId });
    }
  } catch (e) {
    result.reason = signal.aborted ? (userSignal?.aborted ? 'stopped' : 'time_limit') : 'error';
    // Do not persist provider response bodies or credentials in errors.
    emit({ type: 'error', category: e instanceof Error ? e.name : 'UnknownError', reason: result.reason });
  } finally {
    try { await adapter.close(); } catch { result.reason = 'cleanup_error'; }
    result.elapsedMs = Date.now() - start;
    emit({ type: 'summary', ...result });
  }
  return result;
}
