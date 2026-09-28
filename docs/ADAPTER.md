# Connecting a game

`src/contracts.ts` is the contract for an in-process TypeScript adapter. Register a new adapter in `src/cli.ts` and `src/config.ts`, or implement the existing localhost HTTP protocol below. The latter lets a native C# game mod or any other runtime connect without changing the runner.

## HTTP bridge

Bind to `127.0.0.1` only, on the port in your profile. Require `Authorization: Bearer <GAME_BRIDGE_TOKEN>` for both routes. The token stays in `.env`; the runner never puts it in state, profiles, or logs. Disable redirects.

`GET /observe` returns a JSON object:

```json
{
  "revision": "session123:42",
  "progressKey": "room=workshop;key=no",
  "state": { "room": "workshop", "inventory": [] },
  "actions": [
    { "id": "take_key", "description": "Pick up the brass key.", "facts": { "unlocks": "exit" } },
    { "id": "return_hall", "description": "Return to the hall.", "facts": {} }
  ],
  "status": "running"
}
```

Status is `running`, `won`, or `lost`, based on an observable game condition. Actions need unique IDs matching `[a-zA-Z0-9_-]{1,64}`. State/facts are JSON. Revision changes for every state/action-set change and includes a new session identity after restart. Progress key captures meaningful state and excludes clocks, frame numbers, and revision counters so loops can be recognized.

`POST /act` receives:

```json
{
  "action": "take_key",
  "expectedRevision": "session123:42",
  "actionId": "a-unique-uuid"
}
```

Authenticate; acquire the bridge's exclusive controller lease; check revision and action legality; execute once; record the outcome; then return **HTTP 204 only after completion**. Validation and mutation must be serialized/atomic. Return 409 on stale state and reject unknown actions. Never interpret the model's action ID as a shell command, path, coordinate, or arbitrary code.

The bridge must deduplicate `actionId` without applying it twice; reject reuse of an ID with different arguments. Record uncertain completion so an interrupted request can be reconciled against the actual game state. The runner never retries `/act`. HTTP 202 and other non-204 responses do not establish completion and leave an unconfirmed action in the summary/report. Timeout is five seconds per bridge request, capped by the remaining run deadline. Keep each macro bounded; split long navigation into progress-observable segments.

A client disconnect is not proof the game stopped. The bridge must honor cancellation/disconnect, release held keys/buttons, and stop further macro steps. Focus and exact window/process identity must be rechecked before input. The operator lock in the CLI covers this project only; the bridge must exclude all competing control clients. Observe the resulting state after each action rather than trusting an acknowledgement alone.

## Choosing the observation surface

| Surface | Adapter responsibility |
|---|---|
| Supported game/mod API | Read legal game state, supply options, execute approved commands |
| Logs or save data | Prove freshness and correlate with current runtime before acting |
| Screenshot/OCR/vision | Convert visible data into text/JSON, retain uncertainty, reject stale captures |
| Keyboard/mouse/controller | Implement bounded macros, verified target focus, cancellation, input release |

Jev does not read images and cannot discover hidden game state from an action list. Supply facts such as distance, inventory requirements, costs, and reachable destinations. Use deterministic routines for navigation and exact calculations; ask Jev to choose among meaningful objectives. Do not label success merely because a button was pressed.

Before an extended run: prove one observed state → chosen legal action → real execution → newly observed state cycle in the chosen game, then validate stopping and recovery. Save/load hooks come only after that game's supported checkpoint behavior is established. No emulator interfaces are assumed.
