using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Replay;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;

namespace Sts2Sim;

/// <summary>
/// Combat replays (.mcr), as the game's CombatReplayWriter saves them after every fight: a SerializableRun taken at
/// combat start, the ordered player/hook actions and choices, and a checksum plus full state after each action.
/// Two ways to run one:
///  - Playback: the game's own replay mode, as its debug replay loader does it, minus the scene. Hook actions and
///    choices come from the recording.
///  - Driven: a normal singleplayer run (Sim) given only the player's own actions. The game generates everything
///    else, as it would for a forecast. Matching checksums here show the driven mode is exact.
/// </summary>
public static class ReplayRunner
{
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

    public sealed record Result(ChecksumParity Parity, int Events, int EndTurnsReconstructed, int Skipped);

    public static Result Playback(CombatReplay replay, SimLoop loop)
    {
        RunManager rm = RunManager.Instance;
        rm.CleanUp();
        RunState runState = RunState.FromSerializable(replay.serializableRun);
        rm.SetUpReplay(runState, replay, runState.Players[0].NetId);
        rm.CombatStateSynchronizer.IsDisabled = true;
        ChecksumParity parity = ChecksumParity.Attach(rm, replay);
        rm.Launch();
        loop.Run(() => rm.GenerateMap(), "GenerateMap");
        rm.ActionQueueSet.FastForwardNextActionId(replay.nextActionId);
        rm.ActionQueueSynchronizer.FastForwardHookId(replay.nextHookId);
        rm.ChecksumTracker.LoadReplayChecksums(replay.checksumData, replay.nextChecksumId);
        rm.PlayerChoiceSynchronizer.FastForwardChoiceIds(replay.choiceIds);
        rm.RewardsSetSynchronizer.FastForwardRewardIds(replay.rewardIds);
        AbstractRoom? preFinished = AbstractRoom.FromSerializable(replay.serializableRun.PreFinishedRoom, runState);
        loop.Run(() => rm.LoadIntoLatestMapCoord(preFinished), "LoadIntoLatestMapCoord");
        loop.Drain();

        int endTurns = 0;
        foreach (CombatReplayEvent e in replay.events)
        {
            switch (e.eventType)
            {
                case CombatReplayEventType.GameAction:
                {
                    Player player = runState.GetPlayer(e.playerId!.Value)!;
                    GameAction action = e.action!.ToGameAction(player);
                    if (action is ReadyToBeginEnemyTurnAction && !CombatManager.Instance.IsPlayerReadyToEndTurn(player))
                    {
                        // The bridge mod ends turns by calling PlayerCmd.EndTurn directly instead of enqueueing an
                        // EndPlayerTurnAction, so that step is missing from bridge-played replays. Re-create it here,
                        // at the same point: after the last player action, before the game's ready-to-switch action.
                        PlayerCmd.EndTurn(player, canBackOut: false);
                        loop.Drain();
                        endTurns++;
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
        }
        loop.Drain();
        return new Result(parity, replay.events.Count, endTurns, 0);
    }

    /// <summary>
    /// Feeds only the recorded player actions to a singleplayer Sim. Hook actions and resumes are skipped because the
    /// game generates them itself; a ready-to-begin-enemy-turn action becomes an end-turn request.
    /// Player choices (card selection screens) are not supported yet.
    /// </summary>
    public static Result Driven(CombatReplay replay, Action<Sim, CombatReplayEvent>? afterAction = null)
    {
        ChecksumParity? parity = null;
        var sim = Sim.Start(replay.serializableRun, replay, rm => parity = ChecksumParity.Attach(rm, replay));
        int skipped = 0, endTurns = 0;
        foreach (CombatReplayEvent e in replay.events)
        {
            if (e.eventType == CombatReplayEventType.PlayerChoice)
                throw new NotSupportedException("Replay contains a player choice; the driven mode cannot answer choices yet.");
            if (e.eventType != CombatReplayEventType.GameAction) { skipped++; continue; }
            GameAction action = e.action!.ToGameAction(sim.Player);
            if (action is ReadyToBeginEnemyTurnAction) { sim.EndTurn(); endTurns++; }
            else sim.Enqueue(action);
            afterAction?.Invoke(sim, e);
        }
        return new Result(parity!, replay.events.Count, endTurns, skipped);
    }
}
