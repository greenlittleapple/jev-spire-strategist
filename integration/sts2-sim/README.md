# STS2 headless combat worker (spike)

Runs Slay the Spire 2's own combat code (`sts2.dll`, v0.111.0) in a console process with no Godot engine, so
forecasts can come from the game's rules instead of a hand-written model. Status: feasibility spike.

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
| `replay <file.mcr>` | Plays a combat replay back in the game's replay mode and compares every checksum. |
| `drive <file.mcr>` | Feeds only the replay's player actions and card choices to a normal singleplayer combat; the game generates hooks, turn changes and the enemy turn. Compares every checksum. |
| `demo <file.mcr>` | From the replay's combat-start snapshot: plays an attack on an enemy, uses a potion (answering its card choice), ends the turn. Prints the state after each step; runs twice and compares. |
| `states <file.mcr> <out.jsonl>` | Writes the state at combat start and after each player action. |
| `bench <file.mcr> [runs] [--no-checksums]` | Times combat setup, player actions and end turns over repeated runs. |
| `branch <file.mcr> <n> [runs]` | Rebuilds the state after the first n player actions and times it. |
| `save <current_run.save>` | Enters the room a run save points at; for a combat, ends two turns on two loads and compares. |

Replays: the game writes `replays/latest.mcr` in the profile folder after every combat. Copy it into the main
checkout's `.private/`; never commit replay or save contents.

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

## Not covered yet

- No mods are loaded. Hextech Runes was inactive in both fights (the bridge reported `hextech: null`). A fight with
  active runes or hexes would need the mod assembly loaded and is untested.
- The snapshot carries the real RNG state. Forecasts from it see the true draw order and enemy rolls, which the bot
  is not supposed to know.
- Card rewards and anything after combat end are out of scope.
