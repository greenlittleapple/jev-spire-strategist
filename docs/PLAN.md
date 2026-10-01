# Plan

The current plan for the Slay the Spire 2 lab. Update this file whenever the plan changes, so any AI session (Claude or Codex) can continue from here. Results are in `docs/progress/data.json` and the README chart; setup, design and commands in [STS2.md](STS2.md); live evidence in [STS2-VERIFICATION.md](STS2-VERIFICATION.md); the strategist's brief in [STS2-STRATEGIST.md](STS2-STRATEGIST.md).

Last updated: 2026-10-01.

## Goal

Automatic Slay the Spire 2 play by Jev with a Claude strategist, first at Ascension 0 and finally at Ascension 10. The comparison that matters is Jev with the strategist (`claude` mode) against Jev alone with the same computed facts (`jev_facts_v3`), on the same seeds.

## Benchmark decisions

| Setting | Choice |
|---|---|
| Game | Slay the Spire 2 v0.111.0 from Steam with the user's other mods, except the two character mods Hornet (Workshop 3747589529) and Cloud (3752536686), disabled on 2026-09-30 at 23:50 UTC because their cards entered runs through events (41 of 44 mods load; Hextech Runes was already off). The STS2MCP bridge adapted in `integration/sts2-bridge` |
| Setup | Custom-mode seeded runs, Ironclad, Ascension 0, no run modifiers. `npm run sts2:start` refuses anything else, and each run's `run_start` record states its setup |
| Seeds | JEV1 to JEV25 are used; JEV21 to JEV25 are the development seeds. Strength claims use seeds no earlier run has played. From v3.19, inputs taken from earlier runs skip runs on the current seed (see [Memory across runs and seeds](#memory-across-runs-and-seeds-2026-10-01)). A rerun of a seed differs from its first combat on, because the shuffle follows earlier play, so a replay tests only the non-combat choices |
| Model | `jev-1.13.0`, pinned (`JEV_MODEL`) |
| Arms | `claude` (`claude-strategy-v3`: v3.1 facts, enforced combat rules, strategist-owned screens) is the main line. `jev_facts_v3` (`jev-compact-v3.2`) is the Jev-only arm. `jev` (`jev-compact-v1`) and `jev_facts` (`jev-compact-v2`) are historical baselines |
| Score | Result (beating the Act 3 boss, or reaching The Architect, is a win), floor and act reached, share of each boss's HP removed, HP and potions at each boss, elites chosen, gold left, moves and Jev tokens. A single run is not evidence |
| Series | At least 5 finished runs on one version (one lab commit), one mode and one seed list. The code stays fixed during a series, except fixes for bugs that stop runs, which are tagged as known issues in the progress data. The README shows a win rate only for such a row |
| After each series | `npm run sts2:rules-audit`, `npm run sts2:scorecard`, `npm run sts2:progress -- --add` |
| Strategist | A `general-medium` agent answering from `docs/STS2-STRATEGIST.md`; check Marcus's usage before a strategist series |
| Caps | Lifetime `MAX_INPUT_TOKENS` and `MAX_DECISIONS` in `.env`; raising them is Marcus's call |

## Results so far

- 37 finished runs and JEV20 in progress (paused by Marcus at Act 1 floor 3 on 2026-09-29, with a strategist request pending).
- Jev alone: 11 runs on unseeded maps, no wins, best floor 28; 6 of them lost at the Act 1 boss.
- Jev with the strategist: 26 seeded runs, 3 wins (JEV4 on v3.5, JEV8 on v3.8, JEV15 on v3.13); 6 reached the final boss on floor 48. On unseen seeds (JEV3 to JEV19): 3 wins in 17, and 7 losses at the Act 1 boss.
- The strategist version changed after nearly every run, so no strategist version has more than 3 runs and none has a win rate yet.
- Until Strategist v3.17 the strategist was the orchestrating session itself, with earlier runs in its context; from v3.17 each run gets a fresh Medium agent. See [Memory across runs and seeds](#memory-across-runs-and-seeds-2026-10-01).

## Lessons from the BTD6 lab

The Bloons TD 6 port of this design, kept in a separate private repository, learned the following. Applied here on 2026-09-30:

| BTD6 lesson | Here |
|---|---|
| Keep a plan of record | This file |
| A single run is not evidence: compare series of at least 5 finished runs on one revision and setup; change one thing at a time | Series rule above; `winRate` in `integration/sts2/progress-data.mjs` shows a rate only for such a row |
| Record the code and data each run used | `run_start` record: lab commit and dirty flag, policy, mode, model, bridge `{version, build, game}`, playbook and mechanics hashes, caps, setup; `series.jsonl` rows carry the commit |
| Version every bridge build and freeze its DLL | Bridge `0.4.0-jev.1` reports version, source commit and game version; builds are frozen under `.private/bridge-builds/<version>/` |
| Tag runs affected by known bugs | `issues` in the progress data, letters in the README table, hollow dots in the chart (5 issues tagged) |
| Add runs to the progress data from the logs | `npm run sts2:progress -- --add` |
| Audit whether the rules' judgments hold up after every series | `npm run sts2:rules-audit`: per rule, what it removed, the turns and fights that followed, and forecast against actual HP |
| Measure estimates against outcomes before rules depend on them | The forecast check: 91% of 1,816 end-turn forecasts were exact, mean error -0.2 HP. Unlike BTD6's MOAB estimate, no calibration factor is needed |
| Count near ties | Scorecard column: 31% of Jev answers have their top two options less than 0.10 apart; identical re-asks move 0.03 at the median and flip the top pick 7% of the time |
| Majority wait: a passive choice stands only with at least half of Jev's probability | Applied to leaving a shop in `jev_facts_v3` (`jev-compact-v3.2`). Checked and not applied to End turn (the alternatives were mostly potions, with no HP saved) |
| Every lift of a plan constraint must be recorded; constraints need exit conditions | Per-rule removed options and `lifted` records with reasons; the no-kill exit condition is in the strategist instructions |
| Review all run logs for mechanical bugs | Six found and fixed (see below) |
| Test with bridge-shaped states, not hand-built ones | Six recorded states in `integration/sts2/fixtures/` go through the forecasts, route facts, strategist brief and Jev request; no dropped field found |
| Check for private details in `npm test` | `integration/sts2/privacy.test.mjs`, before the publish script's own check |
| A self-contained brief lets a Medium agent be the strategist | `docs/STS2-STRATEGIST.md`, examples checked by `integration/sts2/strategist-doc.test.mjs` |
| Run series unattended, stopping cleanly on a stop file | `npm run sts2:series`; `touch .private/sts2/stop-series` stops it after the current run |
| Build in worktrees on branches; merge between runs, never during one | Used for this change |

Checked and not carried over: a forecast tie-break for near ties (Jev picked the forecast-better side 45 times and the worse 46, and a narrow tie-break changed no fight result), a deck-size cap (the BTD6 tower cap's analog; deck size did not separate Act 1 and 2 wins from losses), and resuming by itself after a person closes an unknown screen (at most 11 long gaps in 42 runs; pauses are now logged with a reason instead). Game speed, non-blocking consults and placement spots have no counterpart in a turn-based game that waits for every answer.

## Findings from the first audit and log reviews (2026-09-30)

- Rules mostly fire where nothing bad follows. Baseline: 52% of combat turns lose no HP, 3.7 HP per turn. `block_not_needed` turns lose no HP 88% of the time and `take_lethal` 95%, as designed. `hallway_potion` fired in 2,213 decisions (503 left one option) with outcomes close to the monster baseline.
- `play_first` turns lose more HP than the baseline in every fight type, and 7 of the 30 fights where it fired were lost. Against that, only 1 of 26 comparable fires removed a line with a better forecast. Watch it with the new rule records before changing it.
- The second-look reviews change Jev's pick 67 to 83% of the time (card order, danger, shop, potion), and changed picks lost more HP (danger 8.7 against 3.7). The new review records hold the first pick's forecast, so the next audit can tell a selection effect from a review overruling a better first pick.
- Under-forecasts come from unmodeled player debuffs (Knowledge Demon's Mind Rot and Sloth, Constrict); over-forecasts from unmodeled heals, block and Thorns.
- Mechanical bugs fixed: strategy requests were logged only after the answer (wrong times, 12 lost requests); rule-made moves were labeled as the strategist's (793 moves) and runner-filtered screens as forced (173); relic counters at their trigger value made 37 decisions stale (about 434K tokens); pauses left no record and timeouts didn't say what timed out; full-belt potion rewards never offered the potion; a failed dispatch-marker write left a phantom uncertain action.

## Run analysis: wins against losses (2026-10-01)

From every logged run, 19 of them unseen-seed strategist runs from v3.5 on (3 won).
- **Where runs die:** Act 1 boss 7, Act 2 boss 4, elites 4, hallways 2 (one crash-affected).
- **Boss fights are lost on damage, not defence.** HP lost per round is about the same for winners and losers (4 to 9); damage per round is not (Ceremonial Beast: winners 26 to 29, the loser 8; Soul Fysh 17 to 29 against 7 to 17; Vantom 10 to 31 against 5 to 17; The Insatiable 41 against 13 to 35). The Insatiable is a clock: Sandpit 4 means eaten in 4 turns unless Frantic Escape (cost rising by 1 per play) adds a turn.
- **Act 1 elites decide Act 1.** Losers' Act 1 elite fights cost 24 to 76 HP, winners' 0 to 7. Five of the seven Act 1 boss deaths followed a costly Act 1 elite; the other two were the Waterfall Giant's Steam Eruption, which the forecast did not model. A late elite (floors 12 to 15) followed by the boss at about 52 HP killed JEV16, JEV18, JEV21 (Jev v3.3) and JEV22 (v3.17).
- **What predicts an elite's cost:** potions held and the last three hallway fights. Act 1 elites with 2+ potions and under 7 net HP lost per recent hallway fight: 11 fights, mean 6.9 HP lost, none over 30, no deaths. Fewer than 2 potions and 7 or more: 13 fights, mean 37.5, 4 deaths. Act 2 shows the same with a limit near 10 (fewer than 2 potions: 35 to 51 mean, 3 to 4 deaths). Entry HP barely differs (87% against 82%).
- **The spiral:** low HP forces healing at rest sites, so losers upgrade less (Act 1 upgrades at the boss: winners 2 to 3, losers mostly 0 to 1).
- **Combat choices follow the forecast.** No logged Jev choice lost to another line on a complete forecast (the candidate builder already drops those); every dominated choice was on a line stopped at a draw, partial for an unmodelled mechanic, or a Power. The remaining combat errors come from what the forecast leaves out, hence step 7.
- **Potions** were all drunk in the fatal fights, mostly on round 1; none died with a potion left.

## Memory across runs and seeds (2026-10-01)

Marcus had the BTD6 session ask whether to add a strategist arm that keeps notes across runs, as the BTD6 lab is doing at its CHIMPS step. Checked in the logs:
- **The strategist arm already keeps notes across runs** (since 2026-09-28): its own encounter fight plans (`playbook.json`) and mechanic notes (`mechanics.json`), both hashed in each `run_start`; and, built from all logged runs, each enemy's moves in its last three fights (`seen_pattern`), encounter results and card stats (`past_runs`). The runner passes none of this in `jev_facts_v3`, so the Jev-only arm has no cross-run memory.
- **Same-seed history.** Enemies' later moves partly follow the seed: on rounds 2 and later, the same enemy's moves match 87% of the time between two runs on one seed and 77% across seeds. Per enemy: Ceremonial Beast 58% against 21%, Bygone Effigy 100% against 84%; Vantom, Soul Fysh and Phrog Parasite about 98% on any seed. The memory had no seed boundary, so strategist runs on a replayed seed could see that seed's earlier fights: JEV1 v3.4, Strategist v3.17 JEV21 and JEV22, Strategist v3.18 JEV21 to JEV25. About a third of the 81 logged briefs that showed move patterns included a line from an earlier run on the same seed, among them JEV23 v3.18's Ceremonial Beast boss fight. The first plays of JEV3 to JEV20, including the three wins, had none. On JEV21 to JEV25 the strategist arm always played after the Jev-only arm, so the comparison leaned its way; no win count changes.
- **Strategist memory.** Before v3.17 the orchestrating session (highest reasoning) answered strategy requests itself, run after run, with earlier runs in its context: JEV5's plan copied JEV4's potion reserve. This is the case the BTD6 lab tagged `strategist-memory`.

Decided (main session, 2026-10-01):
- **No separate notes arm.** The strategist arm is already one, kept in files that can be read, reset and replayed. Both arms win 0 of 5 for reasons the run analysis traced to boss damage, elite readiness and forecast gaps, so a second, free-text memory couldn't show an effect yet. A memory-free strategist arm would measure what the memory adds; that waits until a version passes the 9-of-10 test.
- **A seed boundary in v3.19, before its first series:** `seen_pattern`, encounter results and the `review_encounter` check, card `past_runs`, and a saved fight plan written on the current seed skip runs on that seed. Mechanic notes stay, since they describe game rules rather than a fight.
- **Tags in the progress data:** `strategist-memory` for every strategist run before v3.17, `same-seed-history` for the runs listed above. They keep counting toward win rates, marked like the other issues.
- **Held-out seeds for the 9-of-10 test** (step 8): JEV21 to JEV25 are development seeds, played by several versions and read for every change, so they compare versions and arms but don't count toward the test.

## Next steps, in order

Marcus approved these suggestions and all future runs on 2026-09-30.

1. **Done 2026-09-30 22:20 UTC:** bridge `0.4.0-jev.1` installed (backup of `ca70db78...` in `.private/backups/2026-09-30-before-bridge-jev.1/`); its greeting reports build `e5edbc2` and game `v0.111.0`. The runner restarted on the new code. Checked live on the first run: the `run_start` record (commit, setup with the seed from the save, bridge, content hashes, caps), the pinned build check, and the `run_changed` pause record.
2. **Done:** JEV20 abandoned from the main menu (finishing it on new code would have mixed two versions in one run); left out through `excluded` in the progress data. Its stale strategist request is archived as `.private/sts2/strategy/request.JEV20-abandoned.json`.
3. **First comparison series (v3.17), stopped for fixes.** Jev v3.2 on JEV21 to JEV25: 0 of 5 (floors 14, 17, 31, 8, 8). Strategist v3.17: JEV21 lost to The Insatiable (Act 2 boss, floor 33, 87% of its HP removed), JEV22 lost to the Bygone Effigy elite (floor 11); stopped before JEV23 moved, at Marcus's word, to fix what the review of the day's runs found:
   - **Mid-fight plans saved as encounter plans.** A `low_hp` or `unknown_mechanic` answer replaced the encounter's saved plan, and its `play_first` then forced cards in later runs (16 saved plans had `play_first`, at least 8 of them one-off notes such as "Strangler has 2 HP: play Strike now"). v3.18: only fight-start consults save; `play_first` stays in the run that wrote it; `integration/sts2/playbook-clean.mjs` removed the 19 saved mid-fight plans (backup kept).
   - **Two elites with no rest between.** JEV22 v3.17 took an elite on floor 9 at 76% and the forced treasure and elite after it; `route_risk` couldn't fire on single-option moves. In the logs, both runs that fought the second elite of such a chain died there (JEV19, JEV22). v3.18: routes list their elite chains, and `route_risk` asks before a branch commits to one below the plan's elite HP plus 26 (the upper quartile of HP lost in Act 1 elite fights).
   - **Forecast coverage** (Marcus spotted the Effigy's Slow, 10% more attack damage per card played): Slow, Flutter, Tender, Vigor, the Duplication potion and Expect a Fight's current text are now modelled (Expect a Fight's energy forecast was wrong in 47 of 50 plays and drove JEV24's loop), and other uncovered powers are listed in `notModeled`. Exact attack forecasts on logged plays: 3,422 to 3,486 of 3,836. This changes Jev-only requests too, so the Jev-only arm reruns as Jev v3.3 (`jev-compact-v3.3`).
   - **Strategist inputs:** effects of our own cards and potions are no longer asked about as unknown mechanics, each name asks once per fight, reward claims keep matching after an earlier claim, and the brief defines keywords in card text (Tainted).
   - **Checked, no change:** a rule forcing damage on turns with nothing incoming (12% of such turns had a gap, mostly setup plays the forecast can't value; a narrow rule changed 11 decisions, none in a lost fight); the second looks (with first-pick forecasts logged, every changed danger pick lowered the forecast loss, 22 to 7.7 HP).
4. **Second comparison series (v3.18), running.** Jev v3.3 on JEV21 to JEV25 (2026-09-30 23:49 to 2026-10-01 00:10 UTC): 0 of 5, floors 17, 24, 33, 8, 12 (v3.2 on the same seeds: 14, 17, 31, 8, 8). Strategist v3.18 on the same seeds started 2026-10-01 00:11 UTC, one fresh `general-medium` strategist agent per run (the strategist is part of the system under test, so it stays Medium; Marcus, 2026-10-01). Then the rules audit, the scorecard and the 9-of-10 rule below.
5. **After the series:** `npm run sts2:rules-audit` and the scorecard; compare wins, floors and boss HP removed per arm; check the review records (first against final pick) and `play_first`; record the results and decisions here.
6. **v3.19, prepared on branches, merged after the strategist arm** (labels set at merge: Strategist v3.19, Jev v3.4 / `jev-compact-v3.4`):
   - `v319-forecast`: 17 more mechanics in the forecast (Steam Eruption, Red Skull, Nunchaku, Kusarigama, Pen Nib, Velvet Choker, Mangle, Fight Me!, Omnislice, Fisticuffs, Second Wind, Reattach, Illusion and others); a replay of 2,461 logged plays found more exact forecasts (attack damage 1,970 to 2,108) and none made worse. A killed Waterfall Giant is now forecast as stunned, with its Steam Eruption the next turn.
   - `v319-elite-ready` (in progress): elite readiness in Acts 1 and 2, from the run analysis below. Not ready (fewer than 2 potions and the last three hallway fights averaging at least 7 net HP lost in Act 1, 10 in Act 2) removes elite paths as a code rule; risky asks the strategist through `route_risk`; the numbers are shown to the strategist and to Jev.
   - `v319-potion-claim`: after a strategist potion discard, the potion it made room for is claimed as a rule move (`potion_swap_claim`).
   - `v319-mods`: `run_start` records the enabled mod ids and their hash; rows mixing mod sets get no win rate; runs whose deck gained a Hornet or Cloud card are tagged with the issue `character-mod-cards` by `--refresh`.
   - Not built yet (decided 2026-10-01, see [Memory across runs and seeds](#memory-across-runs-and-seeds-2026-10-01)): the seed boundary on inputs from earlier runs, and the `strategist-memory` and `same-seed-history` tags. Both go in before the next series.
7. **Exact forecasts from the game's own engine** (Marcus, 2026-10-01: forecasts have no reason to be inexact except for random effects). The hand-written forecast keeps missing mechanics; the game's code defines all of them. `sts2.dll` is decompiled locally for reading (`.private/sts2-decompiled/`, never committed). The live game records every fight in memory (`CombatReplayWriter`: the run state at combat start, every action and checksums; `WriteReplay` writes it). Plan: a bridge endpoint writes the current fight's replay; a headless .NET worker loads the game's own `sts2.dll` with Godot stubbed, replays the fight to the current decision and simulates each candidate line, so every deterministic effect is exact. Hidden information stays hidden: unknown draw order, random targets and enemy moves chosen at random are re-randomized in the simulation, never read from the real seed. Prior art on v0.111.0 (MIT, read only, not run here): [sts2-bridge](https://github.com/a-recknagel/sts2-bridge) runs `sts2.dll` headless with checksum parity. Done on branches and merged into the integration branch `v319` (2026-10-01):
- **The worker** (`integration/sts2-sim`) replays real fights with every game checksum matching (20/20 and 84/84, rechecked by the main session). It rebuilt all 43 logged states of a 10-turn fight, and matched the logged next-turn HP and block on every turn without randomness.
- **Shadow mode** (`SIM_FORECAST=shadow`) logs engine forecasts next to the planner's, and `npm run sts2:sim-compare` compares both with what happened.
- **Bridge 0.4.0-jev.2**, with `GET /api/v1/combat_replay`.

The planner's current accuracy against what happened, on 3,233 lines followed to the end of the turn: damage 97.7%, HP after the enemy turn 83%. Acceptance bar for the engine (Marcus, 2026-10-01: zero uncertainty about damage on either side): on every line with no draw or random effect, damage dealt, block and HP after the enemy turn match what happened 100% of the time, and every miss is investigated as a bug. Lines with hidden or random parts are reported as a range over samples.

Order of work:
1. Install the bridge after the v3.18 arm.
2. Run shadow mode on the first v3.19 fights.
3. Switch Jev to engine forecasts (`SIM_FORECAST=live`, worker pool, planner fallback; in progress on `sim-live`) once the bar is met.
8. **Ascension ladder** (revised 2026-09-30 at Marcus's question: the goal is a player that almost always wins, not one that sometimes does): A0, then A5, then A10. A frozen strategist version moves up a level once it wins at least 9 of 10 unseen seeds at its current level: seeds no earlier run has played (from JEV26), five and then five more on the same version. A version takes the test once it loses at most 1 of the 5 development seeds (JEV21 to JEV25), which don't count toward it (decided 2026-10-01). After a second loss it can't reach 9, so the test stops there and the losses go into the next version. Chance of passing, by true win rate: 95% passes 91% of the time, 90% passes 74%, 80% passes 38%, 70% passes 15% (the earlier bar of 2 of 5 let a 20% player through 26% of the time). Before the first step: `npm run sts2:start` and `--add` accept only Ascension 0 today, and setting the custom run's ascension through the bridge needs checking.

## Open items

- Runs before 2026-09-30 23:50 UTC had the Hornet and Cloud character mods enabled. Checked in the logs (card ids in the saved run's history: `CARD.HORNET_MOD_*`, `CARD.CLOUD-*`): JEV6 (Strategist v3.6) and JEV23 (Jev v3.2) took Cloud's Blizzara from Neow, and one early verification run took three Hornet cards from an event. `v319-mods` tags them; run `--refresh` after the merge.
- Unchecked live so far: strategy requests logged when posted, the relic counter settle, potion swaps, the shop majority rule, and a whole series run by `npm run sts2:series` (the first series is running). Checked live on 2026-09-30: the `run_start` record, the pinned build check, pause records and bridge `0.4.0-jev.1`.
- Still unchecked from before: a top-deck (`known_draw_top`) combat cycle and a golden-active Hextech reroll.
- Issue-affected runs count toward a row's win rate (Jev v1 shows "0 of 6 won", all six carrying the multi-hit intent issue).
- `shop.gold_reserve` is never set (0 in 1,183 plans) and has no effect while the strategist owns shops.
- Hextech rune options never carried the `revision` the code expects (Hextech runs only).
- `jev_uncertain`, `rich_shop` and the shop-leaving review can't fire in claude v3, where the strategist owns those screens.

## Decisions made

On 2026-09-30 Marcus approved all future runs and these suggestions: install the new bridge and restart the runner, abandon JEV20, run the comparison series, and an ascension ladder, whose bar Marcus questioned and which now asks for 9 of 10 wins at a level. Runs affected by a known issue keep counting toward win rates, marked in the table and chart.

On 2026-10-01 Marcus decided:
- Medium agents make every code and test change, while the main session (highest reasoning) does the analysis and chooses the direction.
- The per-run strategist stays a Medium agent, because it is part of the system under test.
- Forecasts should come from the game's own code. Marcus approved decompiling `sts2.dll` locally with ilspycmd; the decompiled source is never committed or published.

On 2026-10-01 Marcus left the BTD6 session's notes-arm question to the main session, which decided: no separate notes arm, a seed boundary on inputs from earlier runs, the `strategist-memory` and `same-seed-history` tags, and the 9-of-10 test on seeds no earlier run has played (see [Memory across runs and seeds](#memory-across-runs-and-seeds-2026-10-01)).
