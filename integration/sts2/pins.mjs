// The bridge build and game version this code was checked against. A run on anything else pauses
// before its first decision, as the BTD6 runner pauses on an unpinned mod loader, so a Steam update
// or an older bridge can't enter a comparison unnoticed. Update PINS after installing and checking
// a new build; STS2_UNPINNED=1 skips the check.
export const PINS = {bridge: '0.4.0-jev.1', game: 'v0.111.0'};

// bridge: run_start's {version, build, game} from the bridge greeting, or null when it didn't answer.
export function pinMismatch(bridge, pins = PINS, env = process.env) {
 if (env.STS2_UNPINNED === '1') return null;
 const got = {bridge: bridge?.version ?? null, game: bridge?.game ?? null};
 const off = Object.entries(pins).filter(([key, want]) => got[key] !== want).map(([key, want]) => `${key} ${got[key] ?? 'unknown'} (pinned ${want})`);
 return off.length ? `Pinned build check failed: ${off.join(', ')}. Install the pinned bridge, or check the new build and update integration/sts2/pins.mjs; STS2_UNPINNED=1 skips the check.` : null;
}
