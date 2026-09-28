# Jev Game Lab

A Windows Jev game agent with a Slay the Spire 2 integration and a separate offline workshop demo. STS2 uses the imported Jev the Spire player, a bridge built for the installed game, and the existing project `.env` key.

## Play Slay the Spire 2

1. Launch STS2 through Steam, with the installed **STS2 MCP** mod enabled. Existing mods remain enabled.
2. Double-click **Jev STS2.cmd**, or run `npm run sts2` here.
3. Open **http://127.0.0.1:4317/**. Start or continue a single-player run, then press **Autoplay**. **Pause** prevents new moves; an already dispatched move may finish.

The app reads the active profile's `current_run.save` for run history and the live bridge for the current hand, turn, enemies, deck, relics, potions, room and legal actions. Saves are checkpoints and cannot supply the live turn on their own. The app checks that saved and live run identities match before acting.

Hextech rules are included in every decision: equipped runes, visible counters and active enemy hexes. The installed catalog's 565 entries passed rule-routing checks. Effects without reliable numeric simulation use live legal actions and explicit rules; see the documented limits below.

Jev can also reroll player runes and enemy hexes during selection. It compares keeping an offer with spending an available reroll, respects the game's remaining uses, and considers an active golden upgrade. Both reroll paths were verified in the game.

Pile-aware decisions include draw/discard/exhaust contents and known top-deck placements, while leaving shuffled order unknown. The tracker is installed and tested; its first live top-placement check awaits the next run. Autoplay is currently paused as requested.

The default policy uses one compact question, skips API calls for verified forced transitions, and reviews only specific risky combat choices. A 30-position inference replay used 78.4% fewer tokens than the previous policy. Current piles and Hextech rules stay in context; older room history is summarized. This has not yet been evaluated in a new game run.

The dashboard's Decision mode switch picks **Jev only** (default, no LLM strategy) or **Jev + Claude strategy**. With strategy on, Claude, running in your Claude Code session, acts as a slow strategist: it writes a persistent run plan on a few triggers (run and act start, boss and elite starts, low HP, a rich shop, new relics, and uncertain Jev answers on run-shaping screens). Jev plays every move with that plan. Constrained mode lets Claude narrow the options on those screens. No Anthropic API key is used. See [Claude strategy layer](docs/STS2.md#claude-strategy-layer).

Start at Ascension 0. Ascension 10 playing strength has **not been demonstrated**. See [STS2 setup and limitations](docs/STS2.md) and [current verification](docs/STS2-VERIFICATION.md). The separate demo below remains available.

Project: `C:\Users\green\Projects\Jev Game Lab`

## Try it now

Double-click **Demo.cmd**, or open PowerShell here and run:

```powershell
npm.cmd run demo
```

The workshop demo collects a key and opens an exit. Its offline policy is scripted. It tests observation, legal decisions, execution, state verification, and reporting; it is not a measurement of Jev's playing ability. Each run prints the path to its readable `report.html`, complete `events.jsonl`, and `summary.json` under `runs/`.

```powershell
npm.cmd run doctor   # readiness, no network calls
npm.cmd test         # focused behavior and SDK contract checks
```

The setup uses your existing Node installation. To reinstall dependencies and rebuild, run `./Setup.ps1`. It needs Node 22.18+; this machine was verified on Windows x64 / Node 26.4.0. No WSL, Docker, CUDA, emulator, ROM, Python runtime, or global package install is required.

## Use Jev in the workshop demo

1. Create a TypeSafe key at <https://console.typesafe.ai/settings/keys>.
2. Open the existing `.env` in this folder and fill in `TYPESAFE_API_KEY=` locally. Keep it out of chat and source control.
3. Run `npm.cmd run jev:demo` for a bounded live test of the same workshop environment.

The live workshop demo makes at most six provider requests, with SDK retries disabled, and stops within a 60-second run window plus cleanup. It uses pinned `jev-1.13.0`, the current documented stable model when researched on 2026-09-26. Each response records its actual model and input-token usage. A missing key fails before a run begins. The project's key is configured and live STS2 inference has been verified; the workshop has its own separate checks.

Only structured game observations, the objective, and available action descriptions/facts go to TypeSafe. The cloud provider receives those fields. Local traces retain them too. Keep account details, chat, tokens, and unrelated screen content out of an adapter's observations.

## Connect another game

The STS2 integration above is ready to use. Connecting another game requires its own observation/action adapter.

Prefer a supported game API or local mod/plugin exposing structured state. For a game without one, choose a screenshot/OCR or vision route and a target-window input driver after inspecting that game. Jev is text-only, so screenshots must first become reliable structured observations. DirectInput, controllers, game focus, and safe saves depend on the title.

The adapter implements three functions: `observe`, `execute`, and `close`. It enumerates legal actions with useful facts, executes a chosen action mechanically, and checks progress. Navigation, arithmetic, held-key release, and save handling belong in that adapter. [The bridge contract](docs/ADAPTER.md) provides a working HTTP client for adapters written in C#, Python, JavaScript, or another language. Its localhost observe/act cycle is tested.

After implementing and verifying that adapter:

```powershell
Copy-Item config/game.example.json config/game.local.json
# Set your actual objective and bridge URL, and set GAME_BRIDGE_TOKEN in .env.
npm.cmd start -- --config config/game.local.json
```

The future game's bridge must exclusively own its controls. This project's operator lock prevents two CLI runners in this folder; it cannot exclude another copy of the project or an unrelated controller. Establish ownership inside the game bridge as well.

## Run behavior

- Only enumerated actions may execute. Single-option steps use deterministic code without an inference call.
- Observations are checked again after inference. The adapter must atomically reject stale revisions before acting.
- Step, request, elapsed-time, request-size, confidence, and repeated-state limits stop the loop. Ctrl+C cancels the pending request/action through the adapter contract.
- The input-token setting is a **post-response stop threshold**, not a hard billing cap: one request may cross it. Request-count and byte-size limits separately bound each run. Failed requests can have unknown billing; local usage reflects successful responses only.
- Network actions are never automatically retried. Every dispatch gets an ID, logged before sending. An uncertain dispatch is explicitly shown in the report for reconciliation.
- A repeated state stops for inspection. Automatic reloads/checkpoints are deliberately deferred until a game's save semantics are known. Traces are not game save files, and there is no automatic resume.
- Exit code `0` means the adapter observed a win, `1` means an error, and `2` means a bounded stop or a loss. A low-confidence stop is not success.

## Files

The official TypeSafe agent skill is installed locally at `.agents/skills/typesafe-ai/SKILL.md`. Project instructions in `AGENTS.md` direct future Jev development to use it. Installed 2026-09-27 from `typesafe-ai/skills`, revision `65a39f393687675ce170e6094757de20370365b9`, including the upstream MIT license. This revision links to live reference documentation rather than bundling reference files.

| Path | Purpose |
|---|---|
| `src/decisions.ts` | Official SDK integration and separate offline demo policy |
| `src/engine.ts` | Observation/decision/action loop and stopping rules |
| `src/contracts.ts` | Game-independent adapter and observation types |
| `src/adapters/bridge.ts` | Local native-game bridge client |
| `src/adapters/demo.ts` | Small original deterministic verification environment |
| `config/` | Offline, live-demo, and future-game profiles |
| `runs/` | Private per-run traces, summaries, and HTML reports |
| `research/WINDOWS-SETUP.md` | Source comparison and Windows findings |
| `docs/VERIFICATION.md` | Installation and verification evidence |

The workshop uses the official SDK directly; Pokémon-specific source and assets were not imported. STS2 uses the imported player and local bridge documented above. Its dashboard shows whether autoplay is running and provides Pause. No scheduled task or automatic background restart is configured.
