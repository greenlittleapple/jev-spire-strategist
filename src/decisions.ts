import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { TypeSafeClientConfig } from '@typesafe-ai/sdk';
import type { DecisionMaker, Observation } from './contracts.js';

export function makeRequest(o: Observation, objective: string, model: string) {
  const criteria = Object.fromEntries(o.actions.map(a => [a.id, { description: a.description, facts: a.facts }]));
  return { model, state: { objective, observation: o.state }, questions: {
    action: choice('Choose the available action that best advances the stated objective, using the supplied facts.', criteria),
  } };
}
export class JevDecisions implements DecisionMaker {
  private client: TypeSafeClient;
  constructor(private model: string, apiKey: string, testTransport: Partial<TypeSafeClientConfig> = {}) {
    if (!apiKey) throw new Error('Jev needs TYPESAFE_API_KEY in .env. Run npm run demo for the free offline check.');
    this.client = new TypeSafeClient({ ...testTransport, apiKey,
      baseURL: 'https://api.typesafe.ai', defaultModel: model,
      timeout: 10000, retry: { maxRetries: 0 }, logLevel: 'off' });
  }
  async choose(o: Observation, objective: string, signal: AbortSignal) {
    const response = await this.client.systemOne(makeRequest(o, objective, this.model), { signal });
    const a = response.answers.action;
    if (!Number.isSafeInteger(response.usage.input_tokens) || response.usage.input_tokens < 0)
      throw new Error('Invalid Jev usage response.');
    return { action: a.choice, confidence: a.confidence, probabilities: a.probabilities,
      model: response.model, inputTokens: response.usage.input_tokens };
  }
}
export class MockDecisions implements DecisionMaker {
  async choose(o: Observation) {
    const s = o.state as { inventory: string[] };
    const priorities = s.inventory.includes('brass key') ? ['unlock', 'exit', 'hall'] : ['take_key', 'workshop', 'hall'];
    const action = priorities.find(id => o.actions.some(a => a.id === id));
    if (!action) throw new Error('Mock policy only supports the bundled workshop demo.');
    return { action, confidence: 1, probabilities: { [action]: 1 }, model: 'scripted-demo-policy', inputTokens: 0 };
  }
}
