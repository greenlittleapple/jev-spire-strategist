import { readFile } from 'node:fs/promises';
import type { Config } from './contracts.js';
export function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (!c || !['mock', 'jev'].includes(c.provider) || !['demo', 'bridge'].includes(c.adapter) ||
      typeof c.model !== 'string' || !c.model || typeof c.objective !== 'string' || !c.objective.trim())
    throw new Error('Invalid provider, adapter, model, or objective in config.');
  for (const field of ['maxSteps', 'maxCalls', 'maxSeconds', 'maxRepeatedStates', 'maxRequestBytes', 'maxInputTokens'] as const)
    if (!Number.isSafeInteger(c[field]) || c[field] <= 0) throw new Error(`Invalid positive integer: ${field}`);
  if (!Number.isSafeInteger(c.minIntervalMs) || c.minIntervalMs < 0 ||
      !Number.isFinite(c.minConfidence) || c.minConfidence < 0 || c.minConfidence > 1)
    throw new Error('Invalid interval or confidence threshold.');
  if (c.provider === 'mock' && c.adapter !== 'demo') throw new Error('Mock decisions only support the demo.');
  if (c.adapter === 'bridge' && !c.bridgeUrl) throw new Error('Bridge profile requires bridgeUrl.');
  return c;
}
export async function loadConfig(path: string) { return validateConfig(JSON.parse(await readFile(path, 'utf8'))); }
