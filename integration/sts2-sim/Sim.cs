using System.Diagnostics;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.Multiplayer.Replay;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;

namespace Sts2Sim;

/// <summary>
/// A combat driven by explicit player actions, set up as a normal singleplayer run so the game itself generates
/// hook actions, turn transitions and the enemy turn. This is the mode a forecast would use.
/// </summary>
public sealed class Sim
{
    private readonly SimLoop _loop = SimLoop.Instance;
    public RunState Run { get; }
    public Player Player => Run.Players[0];

    /// <summary>Answers card choices made during this combat.</summary>
    public ChoiceSelector Choices { get; } = new();

    private static IDisposable? _selectorScope;

    private Sim(RunState run) => Run = run;

    /// <summary>
    /// Builds the run from a SerializableRun taken at the start of a combat (a replay's initial snapshot, or the
    /// equivalent built by a bridge) and enters that combat. When a replay is given, its id counters are applied too,
    /// so checksums line up with the recording.
    /// </summary>
    public static Sim Start(SerializableRun save, CombatReplay? idsFrom = null, Action<RunManager>? afterSetUp = null)
    {
        RunManager rm = RunManager.Instance;
        rm.CleanUp();
        save = Copy(save); // loading mutates the SerializableRun (e.g. map history), so each start gets its own copy
        HeadlessPatches.SingleplayerNetId = save.Players[0].NetId;
        RunState run = RunState.FromSerializable(save);
        var sim = new Sim(run);
        _selectorScope?.Dispose();
        _selectorScope = CardSelectCmd.UseSelector(sim.Choices, localOnly: true);
        sim._loop.Run(() => rm.SetUpSavedSingleplayer(run, save), "SetUpSavedSingleplayer");
        afterSetUp?.Invoke(rm);
        rm.Launch();
        sim._loop.Run(() => rm.GenerateMap(), "GenerateMap");
        if (idsFrom != null)
        {
            rm.ActionQueueSet.FastForwardNextActionId(idsFrom.nextActionId);
            rm.ActionQueueSynchronizer.FastForwardHookId(idsFrom.nextHookId);
            typeof(MegaCrit.Sts2.Core.Multiplayer.Game.ChecksumTracker).GetProperty("NextId")!.SetValue(rm.ChecksumTracker, idsFrom.nextChecksumId);
            rm.PlayerChoiceSynchronizer.FastForwardChoiceIds(idsFrom.choiceIds);
            rm.RewardsSetSynchronizer.FastForwardRewardIds(idsFrom.rewardIds);
        }
        AbstractRoom? preFinished = AbstractRoom.FromSerializable(save.PreFinishedRoom, run);
        sim._loop.Run(() => rm.LoadIntoLatestMapCoord(preFinished), "LoadIntoLatestMapCoord");
        sim.Settle("combat start");
        return sim;
    }

    public CombatState Combat => StateView.Combat;

    /// <summary>Deep copy through the game's own packet serialization (the format replays use).</summary>
    public static SerializableRun Copy(SerializableRun save)
    {
        var writer = new PacketWriter();
        writer.Write(save);
        var reader = new PacketReader();
        reader.Reset(writer.Buffer.AsSpan(0, writer.BytePosition).ToArray());
        return reader.Read<SerializableRun>();
    }

    public void PlayCard(int handIndex, uint? targetCombatId)
    {
        var card = Player.PlayerCombatState!.Hand.Cards[handIndex];
        Creature? target = targetCombatId == null ? null : Combat.Creatures.First(c => c.CombatId == targetCombatId);
        if (!card.CanPlayTargeting(target))
            throw new InvalidOperationException($"{card.Id.Entry} cannot be played on {target?.CombatId}");
        RunManager.Instance.ActionQueueSynchronizer.RequestEnqueue(new PlayCardAction(card, target));
        Settle(card.Id.Entry);
    }

    /// <summary>Enqueues any game action through the normal singleplayer path and runs until the game waits again.</summary>
    public void Enqueue(GameAction action)
    {
        RunManager.Instance.ActionQueueSynchronizer.RequestEnqueue(action);
        Settle(action.ToString() ?? "action");
    }

    public void UsePotion(int slot, uint? targetCombatId)
    {
        var potion = Player.PotionSlots[slot] ?? throw new InvalidOperationException("Empty potion slot " + slot);
        Creature? target = targetCombatId == null ? null : Combat.Creatures.First(c => c.CombatId == targetCombatId);
        if (target == null && potion.IsValidTarget(Player.Creature)) target = Player.Creature; // self-targeted, as the UI does
        if (!potion.IsValidTarget(target))
            throw new InvalidOperationException($"{potion.Id.Entry} cannot be used on {targetCombatId}");
        potion.EnqueueManualUse(target);
        Settle(potion.Id.Entry);
    }

    /// <summary>Ends the turn the way the end-turn button does; returns after the enemy turn, at the next player turn.</summary>
    public void EndTurn()
    {
        PlayerCmd.EndTurn(Player, canBackOut: false);
        Settle("end turn");
    }

    /// <summary>
    /// Runs the game until it waits for player input: no action executing, no turn transition under way, and either
    /// the player's side is up or the combat is over. A few game waits use real timers in test mode
    /// (Task.Delay), so idle polling with a short sleep covers those.
    /// </summary>
    public void Settle(string what, int timeoutMs = 10_000)
    {
        var clock = Stopwatch.StartNew();
        while (true)
        {
            _loop.Drain();
            if (Choices.Pending != null) return; // the game waits on a choice the forecast left open
            CombatManager cm = CombatManager.Instance;
            bool busy = RunManager.Instance.ActionExecutor.IsRunning || cm.EndingPlayerTurnPhaseOne || cm.EndingPlayerTurnPhaseTwo
                        || (cm.IsInProgress && cm.DebugOnlyGetState()?.CurrentSide != CombatSide.Player);
            if (!busy && _loop.IsIdle) return;
            if (clock.ElapsedMilliseconds > timeoutMs)
                throw new TimeoutException($"Game did not settle after '{what}'.");
            Thread.Sleep(0);
        }
    }
}
