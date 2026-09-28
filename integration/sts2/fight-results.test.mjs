import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newFightResults,recordFight,encounterResults,planNeedsReview} from './fight-results.mjs';

const fight = (type, floor, hp, round = 1, enemies = [{name: 'Bowlbug'}, {name: 'Bowlbug'}]) =>
 ({state_type: type, run: {live_id: 'r1', act: 2, floor}, player: {hp, max_hp: 80}, battle: {round, enemies}});
const screen = (type, floor, hp) => ({state_type: type, run: {live_id: 'r1', act: 2, floor}, player: {hp, max_hp: 80}});

test('a won fight records HP start and end, rounds, and the counted encounter key', () => {
 const m = newFightResults();
 recordFight(m, fight('monster', 20, 70), 't1');
 recordFight(m, screen('hand_select', 20, 60), 't2');
 recordFight(m, fight('monster', 20, 55, 3), 't3');
 recordFight(m, screen('rewards', 20, 55), 't4');
 const r = encounterResults(m, 'Bowlbug x2');
 assert.equal(r.fights, 1); assert.equal(r.wins, 1); assert.equal(r.avg_hp_lost, 15);
 assert.deepEqual(r.recent[0], {hp: '70→55/80', rounds: 3, won: true});
});

test('game over records a loss; results after the plan are marked and a loss triggers review', () => {
 const m = newFightResults();
 recordFight(m, fight('monster', 20, 70), '2026-01-01');
 recordFight(m, screen('rewards', 20, 66), '2026-01-01');
 recordFight(m, fight('monster', 25, 30), '2026-03-01');
 recordFight(m, screen('game_over', 25, 0), '2026-03-01');
 recordFight(m, fight("monster", 26, 30), "2026-03-02"); recordFight(m, {...screen("game_over", 26, 30)}, "2026-03-02");
 const plan = {updatedAt: '2026-02-01'};
 const r = encounterResults(m, 'Bowlbug x2', plan.updatedAt);
 assert.equal(r.wins, 2); assert.equal(r.recent[0].won, true); assert.equal(r.recent[1].won, false); assert.equal(r.recent[1].after_plan, true); assert.equal(r.recent[2].after_plan, false);
 assert.equal(planNeedsReview(m, 'Bowlbug x2', plan), true);
});

test('a plan is reviewed only when fights since it lost a quarter of max HP on average', () => {
 const m = newFightResults();
 recordFight(m, fight('monster', 20, 70), '2026-03-01'); recordFight(m, screen('rewards', 20, 60), '2026-03-01');
 assert.equal(planNeedsReview(m, 'Bowlbug x2', {updatedAt: '2026-02-01'}), false);
 recordFight(m, fight('monster', 21, 60), '2026-03-02'); recordFight(m, screen('map', 22, 20), '2026-03-02');
 assert.equal(planNeedsReview(m, 'Bowlbug x2', {updatedAt: '2026-02-01'}), true);
 assert.equal(planNeedsReview(m, 'Bowlbug x2', {updatedAt: '2026-04-01'}), false);
});
