import type { Action, Adapter, Observation } from '../contracts.js';

// Original tiny deterministic fixture, not an emulator or a Jev performance benchmark.
export class DemoAdapter implements Adapter {
  id = 'workshop-demo';
  private room = 'hall';
  private key = false;
  private won = false;
  private revision = 0;
  private applied = new Set<string>();
  private snapshot(): Observation {
    const actions: Action[] = this.won ? [] : this.room === 'hall' ? [
      { id: 'workshop', description: 'Walk to the workshop.', facts: { contains: this.key ? 'empty shelf' : 'brass key' } },
      { id: 'exit', description: 'Walk to the locked exit.', facts: { requires: 'brass key', haveKey: this.key } },
    ] : this.room === 'workshop' && !this.key ? [
      { id: 'take_key', description: 'Pick up the brass key.', facts: { unlocks: 'exit' } },
      { id: 'hall', description: 'Return to the hall.', facts: { leavesKeyBehind: true } },
    ] : this.room === 'exit' && this.key ? [
      { id: 'unlock', description: 'Unlock the exit and complete the objective.', facts: { completesObjective: true } },
      { id: 'hall', description: 'Return to the hall.', facts: {} },
    ] : [{ id: 'hall', description: 'Return to the hall.', facts: {} }];
    return { revision: String(this.revision), progressKey: `${this.room}:${this.key}:${this.won}`,
      state: { room: this.room, inventory: this.key ? ['brass key'] : [], exitUnlocked: this.won },
      actions, status: this.won ? 'won' : 'running' };
  }
  async observe(): Promise<Observation> { return this.snapshot(); }
  async execute(action: string, revision: string, actionId: string): Promise<void> {
    if (this.applied.has(actionId)) return;
    const observation = this.snapshot();
    if (revision !== observation.revision || !observation.actions.some(a => a.id === action))
      throw new Error('Stale or illegal demo action.');
    if (action === 'take_key') this.key = true;
    else if (action === 'unlock') this.won = true;
    else this.room = action;
    this.revision++;
    this.applied.add(actionId);
  }
  async close(): Promise<void> {}
}
