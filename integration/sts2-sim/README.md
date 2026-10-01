# STS2 headless combat worker

Runs Slay the Spire 2's own combat code (`sts2.dll`, v0.111.0) in a console process with no Godot engine, so
forecasts can come from the game's rules instead of a hand-written model. `serve` is the long-lived forecast worker
(protocol below); the other commands are the spike's checks and benchmarks.

## Build and run

```
dotnet build -c Release -p:STS2GameDir="<game dir>"
set STS2_GAME_DIR=<game dir>
bin/Release/net9.0/win-x64/Sts2Sim.exe <command>
```

The game's assemblies are referenced for compilation only and loaded read-only from
`<game dir>/data_sts2_windows_x86_64` at run time. The worker is self-contained on .NET 9, like the game.
It writes nothing outside its own output folder: the game's test mode keeps saves in memory, and engine file
access is a no-op.

| Command | What it does |
| --- | --- |
| `serve` | The forecast worker: JSON lines on stdin and stdout (see Forecast worker protocol). |
| `replay <file.mcr>` | Plays a combat replay back in the game's replay mode and compares every checksum. |
| `drive <file.mcr>` | Feeds only the replay's player actions and card choices to a normal singleplayer combat; the game generates hooks, turn changes and the enemy turn. Compares every checksum. |
| `demo <file.mcr>` | From the replay's combat-start snapshot: plays an attack on an enemy, uses a potion (answering its card choice), ends the turn. Prints the state after each step; runs twice and compares. |
| `states <file.mcr> <out.jsonl>` | Writes the state at combat start and after each player action. |
| `bench <file.mcr> [runs] [--no-checksums]` | Times combat setup, player actions and end turns over repeated runs. |
| `branch <file.mcr> <n> [runs]` | Rebuilds the state after the first n player actions and times it. |
| `save <current_run.save>` | Enters the room a run save points at; for a combat, ends two turns on two loads and compares. |

Replays: the game writes `replays/latest.mcr` in the profile folder after every combat. Copy it into the main
checkout's `.private/`; never commit replay or save contents.

## Forecast worker protocol (`serve`)

The worker is a child process. It boots once (about 1.3 s), then reads one JSON request per line on stdin and writes
one JSON response per line on stdout, in order, echoing the request's `id`. Logs go to stderr only (stdout is
redirected to stderr before the game assembly loads). A failed request returns `{"id","ok":false,"error"}` and the
worker keeps serving. `node integration/sts2-sim/worker-check.mjs --exe <Sts2Sim.exe> --replay <file.mcr>` checks it.

- `{"id":1,"cmd":"ping"}` returns `{"id":1,"ok":true,"version":"0.1.0","game":"v0.111.0"}`. The game version comes from
  `release_info.json` beside the data folder (the game reads the same file through Godot, which is stubbed here).
- `{"id":2,"cmd":"load","replay":"<absolute .mcr path>"}` rebuilds the state at the end of the replay: the combat-start
  snapshot plus every recorded player action and the card choices recorded with them. Returns
  `{"ok":true,"ms","incremental","combat":{"encounter","round","player_actions","recorded_actions","in_progress"},"state"}`.
  - Parsed replays are cached by path, size and write time. When the live game state is an earlier point of the same
    combat (same snapshot, same earlier actions and choices, no `simulate` since), only the new actions are applied
    (`incremental`: true). Otherwise the combat is rebuilt.
  - Extension: `"actions": n` applies only the first n player actions, to reproduce an earlier decision point.
- `{"id":3,"cmd":"simulate","lines":[{"id":"p3","actions":[...]}],"end_turn":true,"samples":4,"seed":12345,"known_top":0}`
  evaluates lines against the last loaded state. Defaults: `end_turn` true, `samples` 1 (at most 1000), `seed` 0,
  `known_top` 0. For each line and sample: rebuild the loaded state, re-randomize hidden information (below), apply the
  actions in order, then end the turn if `end_turn` is true or the line ends with `end_turn`. An empty `actions` list
  is the End turn candidate. Returns `{"ok":true,"ms","results":[{"id","samples":[{"ok","stopped_at","reason",
  "after_line","after_enemy_turn","player_dead","combat_won"}]}]}`.
  - `after_line` is the state after the line, before the turn ends. `after_enemy_turn` is the state at the start of
    the next player turn, after start-of-turn effects and draws; null when the turn was not ended or the combat ended.
  - An illegal action (the bridge's checks: index range, `CanPlay`, a target among living enemies, potion usability)
    or a game error gives `ok`:false, `stopped_at` (the action's index; the line's length for the end of turn) and
    `reason`, with `after_line` the state before that action.
  - A card choice, in the line or during the enemy turn, stops with `reason` "choice" and the state before the action.
  - If the combat ends partway through a line, the sample is `ok`:true with `stopped_at` the first unplayed action and
    `reason` "combat_ended".
  - `end_turn` inside a line must be its last action; multi-turn lines are rejected.

Actions use the bridge's commands and ids (integration/sts2-bridge, McpMod.Actions.cs):
`{"action":"play_card","card_index","target"}` (index in the current hand; the target is used only for cards that
target an enemy), `{"action":"use_potion","slot","target"}` (potion slot index; self-target potions ignore `target`),
`{"action":"end_turn"}`. Targets are entity ids as the bridge numbers them: the monster id plus a counter over the
living enemies in combat order (`QUEEN_0`), recomputed at each action, so ids shift when an earlier enemy of the same
kind dies, as in the bridge. A numeric combat id is also accepted, as in the bridge's ResolveTarget.

`State`: `{"round","player":{"hp","max_hp","block","energy","status":[{"id","name","amount"}],"hand":[{"id","name",
"upgraded","cost"}],"draw_count","discard_count","exhaust_count","potions":[{"slot","id","name"}]},"enemies":[{"entity_id",
"combat_id","name","hp","max_hp","block","status","intents":[{"type","damage","hits"}]}]}`.
- `id` fields are model ids exactly as the bridge reports them (`STRIKE_IRONCLAD`, `FLEX_POTION`, `VULNERABLE_POWER`).
  `name` is a lookup key, not display text: localization is in the Godot pack, which the worker does not read.
  Compare ids, not names.
- `cost` is the energy the card would spend now, or "X". Status lists visible powers only, as the bridge does.
- Enemies that died stay in the list with hp 0, no status or intents, and `entity_id` `<MONSTER>_dead_<n>`, so a caller
  can count kills. Enemies still in the combat come first, in combat order.

### Hidden information

Forecasts never use the real random state. Before each sample's line, every random stream a combat action can
consume is replaced with a generator seeded from (seed, sample index, stream name) through SplitMix64, and the draw
pile below its top `known_top` cards is shuffled with its own generator from the same inputs. The rebuild up to the
loaded point uses the real streams, because that part already happened.

Reseeded run streams (`RunRngSet` / `RunRngType`, through the game's `RunRngSet.MockRng`):

| Stream | Used in combat by |
| --- | --- |
| Shuffle | reshuffling the discard pile into the draw pile |
| CombatCardGeneration | generated cards (Mad Science, Attack Potion and similar) |
| CombatPotionGeneration | potions created in combat |
| CombatCardSelection | random cards picked from piles (True Grit and similar) |
| CombatEnergyCosts | random costs (Snecko, Confusion) |
| CombatTargets | random targets (Sword Boomerang and similar) |
| MonsterAi | monster move rolls (`MonsterModel` rolls `NextMove` with `RunRng.MonsterAi`) |
| Niche | HP of creatures spawned mid-fight (unique HP values, Tough Egg hatchlings) |
| CombatOrbs | random orbs |

Each monster's own `MonsterModel.Rng` (set per creature from the run seed and combat id) is reseeded too; in v0.111.0
only cosmetic uses of it were found. Left as they are: the run streams UpFront, UnknownMapPoint and
TreasureRoomRelics, the player streams (`PlayerRngSet` / `PlayerRngType`: Rewards, Shops, Transformations) and the
odds sets; no combat card, potion, power or monster code reads them. `Rng.Chaotic` is only used for visuals.

Effects with no randomness give the same result in every sample. Lines are index based: after a draw or a generated
card, later `card_index` values refer to whatever is in hand in that sample, which can differ from the real game. A
caller that needs the exact later cards should end the line at a draw, or pass the known draw prefix in `known_top`.

### Timings (warm, while the game was running on the same machine)

- `load` of a whole replay: 9 to 12 ms for the 3-turn fight, 57 to 108 ms for the 10-turn Queen fight (43 actions);
  the first load after boot takes 230 to 460 ms (parsing and JIT). An incremental load of one more action: 0 to 8 ms.
- `simulate`, per line and sample, including the rebuild, the line and the enemy turn: 9 to 13 ms from combat start,
  25 ms at round 3, 40 to 50 ms at round 5 and 64 ms at round 10. The rebuild dominates, since the game cannot copy a
  combat in progress.

## How it runs without the engine

1. `GodotHeadless` fills GodotSharp's native function table (`NativeFuncs.UnmanagedCallbacks`, installed through the
   public `NativeFuncs.Initialize`) with stubs that return zero, choosing the stub by return type for the Windows x64
   calling convention. Method and singleton lookups return a dummy non-null handle.
2. `HeadlessPatches` (Harmony, in memory):
   - Engine singletons get a managed wrapper around the dummy handle.
   - The 565 generated `Godot.NativeCalls` helpers that return numbers, bools or vectors return zero. Without this
     they return uninitialized stack memory; `FileAccess.FileExists` returned true.
   - `LocString` text returns its key. The localization tables are in the Godot pack, and combat only formats text
     for logs and UI.
   - The singleplayer player id can be set to a replay's anonymized id, so checksums match the recording.
3. `TestMode` is on. It is the game's own headless switch: no visuals, no waits, saves kept in memory.
   Two of its side effects are undone for checksum comparison: the checksum tracker is re-enabled, and the
   after-action checksum hook (which only fires in interactive mode) is re-attached.
4. `SimLoop` is a single-threaded synchronization context that runs every await continuation in order.
5. Card choices are answered through the game's `CardSelectCmd` local selector (`ChoiceSelector`). The game still
   reserves choice ids and signals the choice, as it does with the real screen.

The bridge mod ends turns by calling `PlayerCmd.EndTurn` directly, so bridge-played replays have no
`EndPlayerTurnAction`. Playback re-creates that call before the recorded ready-to-switch action.

## Results (2026-09-30, two replays from the live A0 benchmark run)

- Checksums (the game's xxHash32 of the full combat state after every action and turn boundary) matched the
  recording in playback and driven mode. Fights: 3 turns with 20 checksums; 10 turns, card choices and
  hook actions with 84 checksums.
- Driven states matched the bot's logged observations, field for field: 55 decisions, 823 fields (HP, block,
  energy, hand, pile counts, player and enemy powers, enemy attack intents).
- Warm timings without checksums: about 1 ms per player action, 3 to 6 ms per end turn including the enemy turn,
  8 to 10 ms to enter a combat from a snapshot. Boot is about 1.3 s.
- The game cannot copy or serialize a combat in progress. A mid-fight state is rebuilt from the combat-start
  snapshot plus the actions so far. Round 5 of the 10-turn fight took about 40 ms.

### Forecast worker checks (2026-10-01, same two replays)

- `load` matched the spike's driven states field for field at every step, through truncated and incremental loads:
  12 steps and 258 fields (3-turn fight), 44 steps and 912 fields (Queen fight).
- The Queen fight against the bot's log: a load truncated to each of the 43 logged decisions matched the logged
  state (round, HP, block, energy, hand, pile counts, enemy entity ids, HP and block). Then each turn's logged line
  was simulated with `end_turn` true, 3 samples, and `after_enemy_turn` compared with the next logged turn start:
  - with the real draw order passed as known (`known_top` covering the pile), rounds 4, 5 and 8 matched in player HP,
    block and enemy HP in every sample; round 1 in 2 of 3 samples (in the third, Mad Science generated a different
    card from the reseeded card-generation stream, so a later card was unaffordable); round 10 ended in the player's
    death, as in the game. Rounds 2, 3, 6, 7 and 9 contain card choices and stop with "choice".
  - with `known_top` 0, rounds 4 and 8 still matched in every sample: their lines did not depend on the draw. Others
    drew different cards, so later hand indexes named other cards or became illegal.
- The same request twice, and in two separate processes, gave identical output apart from `ms`. A single Strike gave
  identical results across 4 samples and seeds 1 and 99. Ending the turn drew 8 distinct hands in 8 samples over two
  seeds; an early version derived colliding seeds across (seed, sample) pairs, fixed by mixing each input separately.

## Not covered yet

- No mods are loaded. Hextech Runes was inactive in both fights (the bridge reported `hextech: null`). A fight with
  active runes or hexes would need the mod assembly loaded and is untested.
- A card choice in a forecast line stops the line (`reason` "choice"); there is no way yet to pass an answer.
- Card rewards and anything after combat end are out of scope.
