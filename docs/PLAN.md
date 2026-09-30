# Plan

The current plan for the Slay the Spire 2 lab. Update this file whenever the plan changes, so any AI session (Claude or Codex) can continue from here. Results are in `docs/progress/data.json` and the README chart; setup, design and commands in [STS2.md](STS2.md); live evidence in [STS2-VERIFICATION.md](STS2-VERIFICATION.md); the strategist's brief in [STS2-STRATEGIST.md](STS2-STRATEGIST.md).

Last updated: 2026-09-30.

## Goal

Automatic Slay the Spire 2 play by Jev with a Claude strategist, first at Ascension 0 and finally at Ascension 10. The comparison that matters is Jev with the strategist (`claude` mode) against Jev alone with the same computed facts (`jev_facts_v3`), on the same seeds.

## Benchmark decisions

| Setting | Choice |
|---|---|
| Game | Slay the Spire 2 v0.111.0 from Steam, with the user's other mods enabled; the STS2MCP bridge adapted in `integration/sts2-bridge` |
| Setup | Custom-mode seeded runs, Ironclad, Ascension 0, no run modifiers. `npm run sts2:start` refuses anything else, and each run's `run_start` record states its setup |
| Seeds | JEV1 to JEV20 are used. Strength claims use unseen seeds. A rerun of a seed differs from its first combat on, because the shuffle follows earlier play, so a replay tests only the non-combat choices |
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

## Next steps, in order

Marcus approved these suggestions and all future runs on 2026-09-30.

1. **Done 2026-09-30 22:20 UTC:** bridge `0.4.0-jev.1` installed (backup of `ca70db78...` in `.private/backups/2026-09-30-before-bridge-jev.1/`); its greeting reports build `e5edbc2` and game `v0.111.0`. The runner restarted on the new code. Checked live on the first run: the `run_start` record (commit, setup with the seed from the save, bridge, content hashes, caps), the pinned build check, and the `run_changed` pause record.
2. **Done:** JEV20 abandoned from the main menu (finishing it on new code would have mixed two versions in one run); left out through `excluded` in the progress data. Its stale strategist request is archived as `.private/sts2/strategy/request.JEV20-abandoned.json`.
3. **Running: comparison series** on seeds JEV21 to JEV25 with the code frozen:
   - arm 1, `Jev v3.2` (`jev_facts_v3`, `jev-compact-v3.2`), started 22:24 UTC: `npm run sts2:series -- --seeds JEV21,JEV22,JEV23,JEV24,JEV25 --mode jev_facts_v3 --label "Jev v3.2"`;
   - arm 2, `Strategist v3.17` (`claude`), the same seeds with `--mode claude --label "Strategist v3.17"`, with a fresh `general-medium` strategist agent for each run, answering from `docs/STS2-STRATEGIST.md`.
   - The arms run in blocks, not alternating: STS2 is turn-based and the runner waits for the game to be ready, so machine load (a BTD6 series ran at the same time) doesn't change decisions.
   - After each run: `npm run sts2:progress -- --add`, then commit.
4. **After the series:** `npm run sts2:rules-audit` and the scorecard; compare wins, floors and boss HP removed per arm; check the review records (first against final pick) and `play_first`; record the results and decisions here.
5. **Ascension ladder** (decided 2026-09-30): A0, then A5, then A10. A frozen strategist version moves up a level once it wins at least 2 of 5 unseen seeds at its current level. Before the first step: `npm run sts2:start` and `--add` accept only Ascension 0 today, and setting the custom run's ascension through the bridge needs checking.

## Open items

- Unchecked live so far: strategy requests logged when posted, the relic counter settle, potion swaps, the shop majority rule, and a whole series run by `npm run sts2:series` (the first series is running). Checked live on 2026-09-30: the `run_start` record, the pinned build check, pause records and bridge `0.4.0-jev.1`.
- Still unchecked from before: a top-deck (`known_draw_top`) combat cycle and a golden-active Hextech reroll.
- Issue-affected runs count toward a row's win rate (Jev v1 shows "0 of 6 won", all six carrying the multi-hit intent issue).
- `shop.gold_reserve` is never set (0 in 1,183 plans) and has no effect while the strategist owns shops.
- Hextech rune options never carried the `revision` the code expects (Hextech runs only).
- `jev_uncertain`, `rich_shop` and the shop-leaving review can't fire in claude v3, where the strategist owns those screens.

## Decisions made

On 2026-09-30 Marcus approved all future runs and these suggestions: install the new bridge and restart the runner, abandon JEV20, run the comparison series, and the ascension ladder above. Runs affected by a known issue keep counting toward win rates, marked in the table and chart.
