using System.Reflection;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Actions;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Replay;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;

namespace Sts2Sim;

/// <summary>
/// Loads a combat replay (.mcr, as the game's CombatReplayWriter saves it after every fight) and plays it back
/// through the game's own action queue, the same way the game's debug replay loader does, minus the scene.
/// Every checksum the game computes during playback is compared with the one recorded in the replay.
/// </summary>
public sealed class ReplayRunner
{
    public int ChecksumsCompared { get; private set; }
    public int ChecksumMismatches { get; private set; }
    public readonly List<string> MismatchDetails = new();
    public int EventsApplied { get; private set; }
    public int EndTurnsReconstructed { get; private set; }

    private readonly CombatReplay _replay;

    public ReplayRunner(CombatReplay replay) => _replay = replay;

    public static CombatReplay Read(string path)
    {
        var reader = new PacketReader();
        reader.Reset(File.ReadAllBytes(path));
        return reader.Read<CombatReplay>();
    }

    /// <summary>Reads only the version fields, which deserialize even when the model list differs.</summary>
    public static string Header(string path)
    {
        var reader = new PacketReader();
        reader.Reset(File.ReadAllBytes(path));
        return $"version {reader.ReadString()} commit {reader.ReadString()} model hash {reader.ReadUInt()}";
    }

    /// <summary>Sets up the run from the replay's starting snapshot and enters the recorded combat.</summary>
    public RunState Load(SimLoop loop)
    {
        RunState runState = RunState.FromSerializable(_replay.serializableRun);
        RunManager rm = RunManager.Instance;
        rm.SetUpReplay(runState, _replay, runState.Players[0].NetId);
        rm.CombatStateSynchronizer.IsDisabled = true;
        EnableChecksums(rm);
        rm.Launch();
        loop.Run(() => rm.GenerateMap(), "GenerateMap");
        rm.ActionQueueSet.FastForwardNextActionId(_replay.nextActionId);
        rm.ActionQueueSynchronizer.FastForwardHookId(_replay.nextHookId);
        rm.ChecksumTracker.LoadReplayChecksums(_replay.checksumData, _replay.nextChecksumId);
        rm.PlayerChoiceSynchronizer.FastForwardChoiceIds(_replay.choiceIds);
        rm.RewardsSetSynchronizer.FastForwardRewardIds(_replay.rewardIds);
        AbstractRoom? preFinished = AbstractRoom.FromSerializable(_replay.serializableRun.PreFinishedRoom, runState);
        loop.Run(() => rm.LoadIntoLatestMapCoord(preFinished), "LoadIntoLatestMapCoord");
        loop.Drain();
        return runState;
    }

    /// <summary>Applies every recorded event in order, letting the game resolve each one.</summary>
    public void PlayAll(SimLoop loop, RunState runState, Action<int, CombatReplayEvent>? afterEvent = null)
    {
        RunManager rm = RunManager.Instance;
        for (int i = 0; i < _replay.events.Count; i++)
        {
            CombatReplayEvent e = _replay.events[i];
            switch (e.eventType)
            {
                case CombatReplayEventType.GameAction:
                {
                    loop.Drain();
                    Player player = runState.GetPlayer(e.playerId!.Value)!;
                    GameAction action = e.action!.ToGameAction(player);
                    if (action is ReadyToBeginEnemyTurnAction && !CombatManager.Instance.IsPlayerReadyToEndTurn(player))
                    {
                        // The bridge mod ends turns by calling PlayerCmd.EndTurn directly instead of enqueueing an
                        // EndPlayerTurnAction, so that step is missing from bridge-played replays. Re-create it here,
                        // at the same point: after the last player action, before the game's ready-to-switch action.
                        PlayerCmd.EndTurn(player, canBackOut: false);
                        loop.Drain();
                        EndTurnsReconstructed++;
                    }
                    rm.ActionQueueSet.EnqueueWithoutSynchronizing(action);
                    if (action is EndPlayerTurnAction || action is ReadyToBeginEnemyTurnAction)
                        loop.RunUntil(rm.ActionExecutor.FinishedExecutingActions(), action.ToString()!);
                    break;
                }
                case CombatReplayEventType.HookAction:
                    rm.ActionQueueSet.EnqueueWithoutSynchronizing(
                        rm.ActionQueueSynchronizer.GetHookActionForId(e.hookId!.Value, e.playerId!.Value, e.gameActionType!.Value));
                    break;
                case CombatReplayEventType.ResumeAction:
                    rm.ActionQueueSet.ResumeActionWithoutSynchronizing(e.actionId!.Value);
                    break;
                case CombatReplayEventType.PlayerChoice:
                    rm.PlayerChoiceSynchronizer.ReceiveReplayChoice(runState.GetPlayer(e.playerId!.Value)!, e.choiceId!.Value, e.playerChoiceResult!.Value);
                    break;
            }
            loop.Drain();
            EventsApplied++;
            afterEvent?.Invoke(i, e);
        }
        loop.Drain();
    }

    /// <summary>
    /// Test mode switches the checksum tracker off and skips the hook that takes a checksum after each action
    /// (ActionExecutor only forwards JustBeforeFinished in interactive mode). Turn both back on so playback produces
    /// the same checksum sequence as the real game, then compare each one with the recording.
    /// </summary>
    private void EnableChecksums(RunManager rm)
    {
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
            int index = _replay.checksumData.FindIndex(c => c.checksumData.id == data.id);
            if (index < 0)
            {
                ChecksumMismatches++;
                MismatchDetails.Add($"#{data.id} {context}: not in replay");
                return;
            }
            ReplayChecksumData recorded = _replay.checksumData[index];
            uint expected = rm.ChecksumTracker.GenerateChecksum(recorded.fullState);
            ChecksumsCompared++;
            if (expected != data.checksum)
            {
                ChecksumMismatches++;
                MismatchDetails.Add($"#{data.id} {context}: ours {data.checksum} recorded {expected} ({recorded.context})");
            }
        };
    }
}
