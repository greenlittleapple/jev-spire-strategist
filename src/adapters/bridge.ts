import type { Adapter, Observation } from '../contracts.js';
import { validateObservation } from '../contracts.js';

// A language-independent connection for a future native game mod/API helper.
export class BridgeAdapter implements Adapter {
  id = 'local-game-bridge';
  private url: string;
  constructor(url: string, private token: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash)
      throw new Error('Bridge must be an HTTP origin on 127.0.0.1.');
    if (!token) throw new Error('Set GAME_BRIDGE_TOKEN before connecting a game bridge.');
    this.url = parsed.origin;
  }
  private async request(path: string, signal: AbortSignal, body?: object) {
    const response = await fetch(this.url + path, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error(`Game bridge HTTP ${response.status}; action is not retried.`);
    return response;
  }
  async observe(signal: AbortSignal): Promise<Observation> {
    const result: unknown = await (await this.request('/observe', signal)).json();
    validateObservation(result);
    return result;
  }
  async execute(action: string, revision: string, actionId: string, signal: AbortSignal): Promise<void> {
    const response = await this.request('/act', signal, { action, expectedRevision: revision, actionId });
    if (response.status !== 204) throw new Error('Bridge did not confirm completed execution with HTTP 204; reconcile before continuing.');
  }
  async close(): Promise<void> {}
}
