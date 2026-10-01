using System.Reflection;
using MegaCrit.Sts2.Core.Entities.Actions;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.Multiplayer.Replay;
using MegaCrit.Sts2.Core.Runs;

namespace Sts2Sim;

/// <summary>
/// Compares every checksum the game computes with the one recorded in a replay. The checksum is the game's own
/// xxHash32 of NetFullCombatState (HP, block, powers, piles, RNG counters, ids) taken after each action and at each
/// turn boundary, so a match means the full combat state matched at that point.
/// </summary>
public sealed class ChecksumParity
{
    public int Compared { get; private set; }
    public int Mismatches { get; private set; }
    public readonly List<string> Details = new();
    public readonly List<uint> Sequence = new();

    /// <summary>
    /// Test mode switches the checksum tracker off and skips the hook that takes a checksum after each action
    /// (ActionExecutor only forwards GameAction.JustBeforeFinished in interactive mode). Turn both back on so the run
    /// produces the same checksum sequence as the real game.
    /// </summary>
    public static ChecksumParity Attach(RunManager rm, CombatReplay? replay)
    {
        var parity = new ChecksumParity();
        rm.ChecksumTracker.IsEnabled = true;
        MethodInfo postAction = typeof(RunManager).GetMethod("SendPostActionChecksum", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var hooked = new HashSet<GameAction>();
        rm.ActionExecutor.BeforeActionExecuted += action =>
        {
            if (!hooked.Add(action)) return;
            action.JustBeforeFinished += a =>
            {
                if (a.State == GameActionState.Finished) postAction.Invoke(rm, new object[] { a });
            };
        };
        rm.ChecksumTracker.ChecksumGenerated += (data, context, _) =>
        {
            parity.Sequence.Add(data.checksum);
            if (replay == null) return;
            int index = replay.checksumData.FindIndex(c => c.checksumData.id == data.id);
            if (index < 0)
            {
                parity.Mismatches++;
                parity.Details.Add($"#{data.id} {context}: not in replay");
                return;
            }
            ReplayChecksumData recorded = replay.checksumData[index];
            uint expected = rm.ChecksumTracker.GenerateChecksum(recorded.fullState);
            parity.Compared++;
            if (expected != data.checksum)
            {
                parity.Mismatches++;
                parity.Details.Add($"#{data.id} {context}: ours {data.checksum} recorded {expected} ({recorded.context})");
            }
        };
        return parity;
    }

    public string Summary(int expected) =>
        $"checksums compared {Compared} of {expected}, mismatches {Mismatches}" +
        (Details.Count > 0 ? "\n  " + string.Join("\n  ", Details.Take(10)) : "");
}
