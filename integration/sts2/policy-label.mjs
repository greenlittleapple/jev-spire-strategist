// The policy label a run records. With live engine forecasts (SIM_FORECAST=live) the label gets an
// "+engine" suffix, so those runs can be told apart; shadow mode and no setting leave it unchanged.
export const ENGINE_SUFFIX = '+engine';
export const engineLive = (env = process.env) => env.SIM_FORECAST === 'live';
export const policyLabel = (base, env = process.env) => engineLive(env) && base ? base + ENGINE_SUFFIX : base;
// The label without the engine suffix, for mapping to a mode or a version. Scored runs join a run's
// distinct policies with "+", so each "engine" part is dropped and repeats are merged.
export const basePolicy = p => p == null ? p : [...new Set(String(p).split('+').filter(x => x !== 'engine'))].join('+');
