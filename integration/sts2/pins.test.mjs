// The pinned bridge and game check that pauses a run before its first decision.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PINS, pinMismatch} from './pins.mjs';

const pinned = {version: PINS.bridge, build: 'e5edbc2', game: PINS.game};

test('the pinned bridge and game pass', () => {
 assert.equal(pinMismatch(pinned, PINS, {}), null);
});

test('another bridge, another game version or no answer from the bridge is reported', () => {
 assert.match(pinMismatch({...pinned, version: '0.4.0', game: null}, PINS, {}), /bridge 0\.4\.0 \(pinned 0\.4\.0-jev\.1\), game unknown \(pinned v0\.111\.0\)/);
 assert.match(pinMismatch({...pinned, game: 'v0.112.0'}, PINS, {}), /^Pinned build check failed: game v0\.112\.0 \(pinned v0\.111\.0\)\./);
 assert.match(pinMismatch(null, PINS, {}), /bridge unknown .*game unknown/);
});

test('STS2_UNPINNED=1 skips the check', () => {
 assert.equal(pinMismatch(null, PINS, {STS2_UNPINNED: '1'}), null);
});
