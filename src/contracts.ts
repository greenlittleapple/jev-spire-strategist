import type { JsonValue } from '@typesafe-ai/sdk';

export interface Action { id: string; description: string; facts: JsonValue; }
export interface Observation {
  // Revision must change whenever the set of valid actions/state changes.
  revision: string;
  // Stable semantic key: exclude clocks, animation frames, and revision counters.
  progressKey: string;
  state: JsonValue;
  actions: Action[];
  status: 'running' | 'won' | 'lost';
}
export interface Adapter {
  id: string;
  observe(signal: AbortSignal): Promise<Observation>;
  // Revalidate revision and action inside the adapter before any mutation.
  // Remote adapters must deduplicate actionId and reject stale revisions.
  execute(action: string, revision: string, actionId: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface Decision {
  action: string; confidence: number; model: string;
  probabilities: Record<string, number>; inputTokens: number;
}
export interface DecisionMaker {
  choose(observation: Observation, objective: string, signal: AbortSignal): Promise<Decision>;
}
export interface Config {
  provider: 'mock' | 'jev'; model: string; adapter: 'demo' | 'bridge';
  bridgeUrl?: string; objective: string; maxSteps: number; maxCalls: number;
  maxSeconds: number; minIntervalMs: number; minConfidence: number;
  maxRepeatedStates: number; maxRequestBytes: number; maxInputTokens: number;
}
export function validateObservation(value: unknown): asserts value is Observation {
  const o = value as Observation;
  if (!o || typeof o.revision !== 'string' || !o.revision || typeof o.progressKey !== 'string' || !o.progressKey ||
      !['running', 'won', 'lost'].includes(o.status) || !Array.isArray(o.actions) || o.state === undefined)
    throw new Error('Invalid game observation.');
  const ids = new Set<string>();
  for (const a of o.actions) {
    if (!a || typeof a.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) ||
        typeof a.description !== 'string' || a.facts === undefined || ids.has(a.id))
      throw new Error('Invalid or duplicate game action.');
    ids.add(a.id);
  }
}
