// Records the runner writes about its own state: pauses, timeouts and the dispatch marker.
// Kept out of server.mjs so they can be tested without starting a runner.

// Pause reasons logged by stop() as {kind:'pause', reason, message}. unspecified covers a stop
// without a named reason.
export const PAUSE_REASONS = ['operator', 'shutdown', 'checkpoint_mismatch', 'unknown_screen', 'menu', 'overlay',
  'no_actions', 'no_change', 'budget', 'run_changed', 'pin_mismatch', 'unspecified'];
export const pauseRecord = (reason, message, extra = {}) => ({ kind: 'pause', reason, message, ...extra });

// A fetch timeout names the call that timed out ("Game state read timed out", "Jev request timed out"):
// both used to fail with the same "The operation was aborted due to timeout", and the operators'
// auto-resume rule reads this text. Other errors pass through unchanged.
export const timeoutMessage = (error, message) =>
  error?.name === 'TimeoutError' || error?.name === 'AbortError' ? Error(message) : error;

// An operator pause (or shutdown) during a decision cancels it, including a strategist wait. The pause
// record already says so; the cancellation is not an error.
export const operatorCancel = (error, cancelled) => cancelled && error?.message === 'Decision cancelled.';

// The dispatch marker (view.uncertainAction) must be on disk before a command is sent. If writing it
// fails, the command is not sent: the marker is cleared, a not_sent record is attempted, and the
// error is rethrown so the step pauses. log() appends the pending line before the snapshot write
// that can fail, so without the not_sent record the log shows a dispatch that never happened.
export async function writeDispatchMarker(log, view, marker) {
  view.uncertainAction = marker;
  try { await log({ kind: 'dispatch', outcome: 'pending', ...marker }); }
  catch (error) {
    view.uncertainAction = null;
    await log({ kind: 'dispatch', outcome: 'not_sent', message: error.message }).catch(() => {});
    throw error;
  }
}
