# Windows Jev setup research

Researched 2026-09-26. Reference conversation: **Weird Programming Watch**, ChatGPT ID `6aaf6c85-ca70-83e8-bf75-ec4db5940491`. Its September 25–26 entry links specifically to christianmat/jev-pokemon. The thread's badge/cost reports are author claims, not a benchmark reproduced here.

## Decision

Use the official JavaScript SDK directly on Windows, with a small game-independent adapter harness. Jev inference is hosted; installing the SDK does not download Jev model weights. Existing Node 26.4.0 / npm 11.17.0 work on this machine. Installed SDK version is 0.6.0, pinned in package-lock.json. This avoids the Pokémon build and gateway layers without changing the observe → legal choices → typed decision → deterministic execution pattern.

## Sources compared

| Source | Evidence and applicability | Outcome |
|---|---|---|
| [Exact Pokémon reference](https://github.com/christianmat/jev-pokemon) | README targets macOS/Linux and uses Node 20+, RGBDS, pret/pokered symbols and a Game Boy emulator. RAM-derived observations, action facts and deterministic mechanics do substantial work. The client adds throttling/logging; saves and navigation are game-specific. | Architecture reference. Do not import emulator or Pokémon modules for an undecided native game. |
| [Official JS SDK](https://github.com/typesafe-ai/typesafe-sdk-js) | Official Node 20+ package with ESM/CJS/types and typed `systemOne` requests. Source uses ordinary HTTP fetch; no native GPU/runtime dependency. Registry version 0.6.0 installed and exercised on Windows. | Selected reusable dependency. Our project minimum is Node 22.18 for built-in environment loading and current tooling. |
| [Official API](https://docs.typesafe.ai/api) | `/v1/systemone` accepts state and named typed questions; Choice returns a decision and probabilities. | SDK request/response contract verified with an injected test transport. No live provider call made. |
| [Official model documentation](https://docs.typesafe.ai/models) | Current stable documented model is `jev-1.13.0`; inputs are text/JSON, with no native image/audio/video support. Published input price is $0.042/M tokens, output free, at research time. | Pin model for repeatability. A future visual game adapter needs separate perception. Prices may change; local usage is not a provider invoice. |
| [IAnMove/jev-game-agent](https://github.com/IAnMove/jev-game-agent) | Existing Windows/PowerShell-oriented Python/BizHawk controller with emulator RAM, lookahead and checkpoint search. | Real Windows precedent, but importing it would bring the emulator assumptions the user explicitly excluded. |
| [milanboers/jev-plays-pokemon](https://github.com/milanboers/jev-plays-pokemon) | Python/uv, PyBoy and ROM-dependent state extraction/navigation. | Another useful structured-goal example; not a generic native-game Windows controller. |
| [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use) | Desktop OCR → action classification, explicitly macOS-specific. | Shows a perception/action division, but not a direct Windows installation route. |
| [Ollaya](https://github.com/ollaya-dev/ollaya) and [v0.7.1 release](https://github.com/ollaya-dev/ollaya/releases/tag/v0.7.1) | README advertises native Windows x64 and a TypeSafe-compatible API. Release API verified a 31,294,769-byte Windows CPU ZIP, a desktop installer/MSI, and a much larger CUDA ZIP. It runs open decision models such as Laya, not Jev weights. | Valid future local-inference experiment. Not installed or silently substituted for the requested Jev setup; Windows binaries alone do not establish game competence. |

The source sweep found runnable emulator-specific agents and a macOS desktop agent; it did not establish a maintained, general Windows Jev controller that can attach to any unspecified game. A generic SDK plus explicit game adapter is the supported foundation established here. This is a scoped research conclusion, not a claim that no other project exists.

## Reuse and implementation boundaries

Imported the official SDK as an npm dependency, including its upstream MIT license. No Pokémon code was vendored into runtime source. The demonstration environment and small adapter/loop are original implementation. Downloaded reference files in this directory are research only and excluded from the local repository. The upstream Pokémon project is GPL-2.0-or-later; its emulator, assets, build system, and gateway client are not runtime dependencies here.

Compared with the reference run, the generic loop preserves structured facts, constrained legal choices, deterministic execution, throttling and logs. It stops on loops instead of automatically reloading an unknown game's save, and stops on stale observations instead of applying decisions against an old screen. There is no general game-playing guarantee until a title-specific adapter passes an actual game cycle.

## Source revisions observed

These are repository default-branch heads returned by GitHub during research, not claims that every file was read. Installed package provenance is separately fixed by npm's lockfile integrity.

| Repository | Observed SHA |
|---|---|
| christianmat/jev-pokemon | `5a2ec3027e641d773235d56ce6960d34277a2d30` |
| typesafe-ai/typesafe-sdk-js | `66880ccded6cb642dc1809620c2b108c33730214` |
| IAnMove/jev-game-agent | `533e205d05aa7f1a67ecae17443b17c77eb827f5` |
| milanboers/jev-plays-pokemon | `0b20f13e48f7e6f71283fc83ddd88c359d71aa32` |
| awlevin/typesafe-computer-use | `2fc5efaaab692122df23e312fe9ba6e87753b3fc` |
| ollaya-dev/ollaya | `f9e2d11fee1d01235878bfa6cfa1eb1e42bbbaea` |

No credentials were available. The installation, offline cycle, HTTP bridge and SDK wire contract can be verified locally; live Jev output quality, account access and billing remain unverified.
