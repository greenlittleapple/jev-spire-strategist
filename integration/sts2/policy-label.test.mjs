import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {policyLabel, basePolicy} from './policy-label.mjs';
import {scoreLogged, versionFor} from './progress-data.mjs';
import {FACTS_V3_POLICY} from './route-facts.mjs';
import {STRATEGY_POLICY} from './strategy.mjs';

test('live engine forecasts add +engine to the recorded policy; shadow mode and no setting leave it unchanged', () => {
 assert.equal(FACTS_V3_POLICY, 'jev-compact-v3.4');
 assert.equal(policyLabel(FACTS_V3_POLICY, {SIM_FORECAST: 'live'}), 'jev-compact-v3.4+engine');
 assert.equal(policyLabel(STRATEGY_POLICY, {SIM_FORECAST: 'live'}), 'claude-strategy-v3+engine');
 for (const env of [{SIM_FORECAST: 'shadow'}, {}, {SIM_FORECAST: ''}]) {
  assert.equal(policyLabel(FACTS_V3_POLICY, env), 'jev-compact-v3.4');
  assert.equal(policyLabel(STRATEGY_POLICY, env), 'claude-strategy-v3');
 }
 assert.equal(basePolicy('jev-compact-v3.4+engine'), 'jev-compact-v3.4');
 assert.equal(basePolicy('jev-compact-v3.4+jev-compact-v3.4+engine'), 'jev-compact-v3.4');
 assert.equal(basePolicy('jev-compact-v2+jev-compact-v3'), 'jev-compact-v2+jev-compact-v3');
});

test('the runner records currentPolicy() through policyLabel', () => {
 const src = readFileSync(new URL('../../vendor/jev-the-spire/spire-demo/server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
 assert.match(src, /const currentPolicy = \(\) => policyLabel\(/);
 assert.match(src, /policy: currentPolicy\(\), decisionMode:view\.decisionMode/);
});

test('progress maps a policy with +engine to the same mode and version', () => {
 const decision = (id, policy) => ({kind: 'decision', outcome: 'executed', time: '2026-10-01T00:01:00Z', policy,
  state: {state_type: 'map', run: {live_id: `modded:profile1:${id}`, act: 1, floor: 1, ascension: 0}, player: {hp: 10}}});
 const s = scoreLogged({events: [decision('1', 'jev-compact-v3.4+engine'), decision('2', 'claude-strategy-v3+engine'), decision('3', 'jev-compact-v3.4')]});
 assert.deepEqual(['1', '2', '3'].map(id => s.get(id).mode), ['jev_facts_v3', 'claude', 'jev_facts_v3']);
 const data = {versions: [{name: 'Jev v3.4', policy: 'jev-compact-v3.4', mode: 'jev_facts_v3', runs: []}]};
 assert.equal(versionFor(data, {label: null, policy: 'jev-compact-v3.4+engine'}).version.name, 'Jev v3.4');
});
