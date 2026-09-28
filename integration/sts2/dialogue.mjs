export function repeatableDialogue(state, candidates, events) {
  if (state.state_type !== 'event' || !state.event?.in_dialogue || candidates.length !== 1
      || candidates[0].command.action !== 'advance_dialogue') return false;
  let count = 0;
  for (const event of events) {
    if (event.kind !== 'decision' || event.outcome !== 'executed') continue;
    if (event.chosen.command.action !== 'advance_dialogue'
        || event.state.run?.live_id !== state.run?.live_id
        || event.state.run?.floor !== state.run?.floor) break;
    count++;
  }
  // Some ancient dialogue has no text exposed by STS2MCP. Only repeat acknowledged
  // advances, never an uncertain dispatch or any other command, and stop a bad loop.
  return count > 0 && count < 12;
}
