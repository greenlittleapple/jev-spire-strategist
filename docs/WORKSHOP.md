# Generic harness and workshop demo

Besides the Slay the Spire 2 integration, this repository has a small game-independent harness (`src/`) and an offline workshop demo used to test it. The STS2 runner does not depend on it.

## Try the demo

Double-click **Demo.cmd**, or open PowerShell in the project folder and run:

```powershell
npm.cmd run demo
```

The workshop demo collects a key and opens an exit. Its offline policy is scripted. It tests observation, legal decisions, execution, state verification, and reporting; it is not a measurement of Jev's playing ability. Each run prints the path to its readable `report.html`, complete `events.jsonl`, and `summary.json` under `runs/`.

```powershell
npm.cmd run doctor   # readiness, no network calls
npm.cmd test         # focused behavior and SDK contract checks
```

To reinstall dependencies and rebuild, run `./Setup.ps1`. It needs Node 22.18+ and was verified on Windows x64 with Node 26.4.0. No WSL, Docker, CUDA, emulator, ROM, Python runtime, or global package install is required.

## Use Jev in the workshop demo

1. Create a TypeSafe key at <https://console.typesafe.ai/settings/keys>.
2. Copy `.env.example` to `.env` and fill in `TYPESAFE_API_KEY=` locally. Keep it out of chat and source control.
3. Run `npm.cmd run jev:demo` for a bounded live test of the same workshop environment.

The live workshop demo makes at most six provider requests, with SDK retries disabled, and stops within a 60-second run window plus cleanup. It uses pinned `jev-1.13.0`. Each response records its actual model and input-token usage. A missing key fails before a run begins.

Only structured game observations, the objective, and available action descriptions/facts go to TypeSafe. Local traces retain them too. Keep account details, chat, tokens, and unrelated screen content out of an adapter's observations.

## Connect another game

Connecting another game requires its own observation/action adapter.

Prefer a supported game API or local mod/plugin exposing structured state. For a game without one, choose a screenshot/OCR or vision route and a target-window input driver after inspecting that game. Jev is text-only, so screenshots must first become reliable structured observations. DirectInput, controllers, game focus, and safe saves depend on the title.

The adapter implements three functions: `observe`, `execute`, and `close`. It enumerates legal actions with useful facts, executes a chosen action mechanically, and checks progress. Navigation, arithmetic, held-key release, and save handling belong in that adapter. [The bridge contract](ADAPTER.md) provides a working HTTP client for adapters written in C#, Python, JavaScript, or another language. Its localhost observe/act cycle is tested.

After implementing and verifying that adapter:

```powershell
Copy-Item config/game.example.json config/game.local.json
# Set your actual objective and bridge URL, and set GAME_BRIDGE_TOKEN in .env.
npm.cmd start -- --config config/game.local.json
```

The game's bridge must exclusively own its controls. The operator lock prevents two CLI runners in one folder; it cannot exclude another copy of the project or an unrelated controller. Establish ownership inside the game bridge as well.

## Run behavior

- Only enumerated actions may execute. Single-option steps use deterministic code without an inference call.
- Observations are checked again after inference. The adapter must atomically reject stale revisions before acting.
- Step, request, elapsed-time, request-size, confidence, and repeated-state limits stop the loop. Ctrl+C cancels the pending request/action through the adapter contract.
- The input-token setting is a **post-response stop threshold**, not a hard billing cap: one request may cross it. Request-count and byte-size limits separately bound each run. Failed requests can have unknown billing; local usage reflects successful responses only.
- Network actions are never automatically retried. Every dispatch gets an ID, logged before sending. An uncertain dispatch is explicitly shown in the report for reconciliation.
- A repeated state stops for inspection. Traces are not game save files, and there is no automatic resume.
- Exit code `0` means the adapter observed a win, `1` means an error, and `2` means a bounded stop or a loss. A low-confidence stop is not success.

## Files

| Path | Purpose |
|---|---|
| `src/decisions.ts` | Official SDK integration and separate offline demo policy |
| `src/engine.ts` | Observation/decision/action loop and stopping rules |
| `src/contracts.ts` | Game-independent adapter and observation types |
| `src/adapters/bridge.ts` | Local native-game bridge client |
| `src/adapters/demo.ts` | Small original deterministic verification environment |
| `config/` | Offline, live-demo, and future-game profiles |
| `runs/` | Private per-run traces, summaries, and HTML reports (ignored) |
| `docs/VERIFICATION.md` | Installation and verification evidence |

The official TypeSafe agent skill is installed at `.agents/skills/typesafe-ai/SKILL.md` (from `typesafe-ai/skills`, revision `65a39f393687675ce170e6094757de20370365b9`, MIT). `AGENTS.md` directs coding agents to use it for Jev work.
