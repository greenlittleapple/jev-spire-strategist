using System.Collections.Generic;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Runs;

namespace STS2_MCP;

public static partial class McpMod
{
    // Whether the game has finished resolving queued actions, so a client can act as soon as
    // the state is final instead of waiting a fixed settle time. "ready" is true only when no
    // action is executing, every action queue is drained and (in combat) player actions are enabled.
    private static void AddReadiness(Dictionary<string, object?> result)
    {
        try
        {
            var run = RunManager.Instance;
            if (run == null || !run.IsInProgress) { result["ready"] = true; return; }
            bool executing = run.ActionExecutor?.IsRunning ?? false;
            bool queued = !(run.ActionQueueSet?.IsEmpty ?? true);
            bool inCombat = CombatManager.Instance?.IsInProgress ?? false;
            bool disabled = inCombat && CombatManager.Instance!.PlayerActionsDisabled;
            result["ready"] = !executing && !queued && !disabled;
            result["busy"] = new Dictionary<string, object?>
            {
                ["action_executing"] = executing,
                ["actions_queued"] = queued,
                ["player_actions_disabled"] = disabled,
            };
        }
        catch
        {
            // Unknown readiness: clients fall back to their own settle timing.
            result.Remove("ready");
        }
    }
}
