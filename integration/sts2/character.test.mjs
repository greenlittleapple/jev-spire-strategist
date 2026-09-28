import test from 'node:test';
import assert from 'node:assert/strict';
import {characterName} from './character.mjs';

test('character name comes from the save or bridge ID, not a displayed title', () => {
  assert.equal(characterName('CHARACTER.IRONCLAD'), 'Ironclad');
  assert.equal(characterName('IRONCLAD'), 'Ironclad');
  assert.equal(characterName('CHARACTER.NECROBINDER'), 'Necrobinder');
  assert.equal(characterName('CHARACTER.THE_DEFECT'), 'The Defect');
  for (const bad of [null, undefined, '', 'CHARACTER.', 'Skin Title']) assert.equal(characterName(bad), null);
});
