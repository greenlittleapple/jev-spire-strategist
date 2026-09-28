# Verification

Verified locally on 2026-09-26, Windows x64, Node 26.4.0, npm 11.17.0.

- `Setup.ps1`: passed. Reinstalled from package-lock.json with package scripts disabled, compiled TypeScript, ran offline readiness check.
- `npm.cmd test`: **18 passed, 0 failed**. Includes a complete demo cycle, illegal/low-confidence/stale-action rejection, deterministic single-option execution, call/step/request-size bounds, loop detection, timeout/cancellation, official SDK HTTP contract, disabled provider retries, action deduplication, real localhost bridge cycle, configuration validation, concurrent revision rejection, uncertain HTTP 202 handling, and report escaping/uncertain-action visibility.
- `npm.cmd run demo`: **won**, five confirmed actions, four scripted decision calls, zero API requests/tokens. Trace observed the final unlocked-exit state.
- Final demonstration artifact: `runs/2026-09-26T22-07-41-798Z-9238ed26/report.html`, with `events.jsonl` and `summary.json` alongside it.
- `npm.cmd run jev:demo` without a key: expected exit 1 before any run/lock/API request. Clear missing-key message verified.
- `npm.cmd audit --omit=dev --json`: zero reported production vulnerabilities at installation time.
- Independent read-only review identified uncertain action reporting, bridge acknowledgement semantics, and demo atomicity defects; all three were repaired and covered by regression checks.
- Independent follow-up review confirmed all three findings resolved and the bridge documentation consistent with implementation; no remaining actionable findings in that review scope.

**UNVERIFIED:** live TypeSafe authentication, Jev output quality, and billing, because the user has no key. SDK tests use an injected HTTP transport and never contact the paid endpoint. Native-game input and state extraction cannot be verified until a game/adapter is selected. These are distinct from the locally verified harness and localhost bridge.

**UNVERIFIED:** visual browser rendering of the optional HTML report. Browser policy blocked the attempted local-file preview; no bypass was attempted. Generated report content, escaping, uncertainty labels, traces, and summary were inspected programmatically.

No native game was opened or controlled. No WSL/emulator/GPU packages were installed. No API key was entered, paid request made, remote repository created, deployment performed, or background service scheduled. Runs exit and release the project operator lock. All test HTTP servers are closed by their tests.
