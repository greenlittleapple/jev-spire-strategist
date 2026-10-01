using System.Reflection;
using System.Security.Cryptography;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Potions;
using MegaCrit.Sts2.Core.Entities.Rngs;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Multiplayer.Replay;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;
using MegaCrit.Sts2.Core.Random;

namespace Sts2Sim;

/// <summary>
/// Rebuilds a combat from a replay (combat-start snapshot plus the recorded player actions and choices) and
/// evaluates candidate lines from that state under re-randomized hidden information.
/// </summary>
public sealed class Forecaster
{
    /// <summary>A parsed replay with what the worker needs to rebuild it.</summary>
    public sealed class LoadedReplay
    {
        public required CombatReplay Replay { get; init; }
        /// <summary>Hash of the combat-start snapshot and id counters: equal for every replay of the same combat.</summary>
        public required string CombatKey { get; init; }
        /// <summary>Indexes into Replay.events of the player's own actions.</summary>
        public required List<int> ActionEvents { get; init; }
        /// <summary>Per player action: the serialized action and the choices recorded with it.</summary>
        public required List<string> ActionSignatures { get; init; }
    }

    private readonly Dictionary<string, (long length, DateTime written, LoadedReplay loaded)> _files = new();

    /// <summary>The state the last load built, while nothing else has used the game since.</summary>
    private (LoadedReplay loaded, int applied, Sim sim, List<Creature> seen)? _live;

    public LoadedReplay? Loaded { get; private set; }
    public int LoadedActions { get; private set; }
    public bool LastLoadIncremental { get; private set; }

    public LoadedReplay Read(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Replay not found: " + path);
        if (_files.TryGetValue(path, out var cached) && cached.length == info.Length && cached.written == info.LastWriteTimeUtc)
            return cached.loaded;
        CombatReplay replay = ReplayRunner.Read(path);
        var loaded = Describe(replay);
        _files[path] = (info.Length, info.LastWriteTimeUtc, loaded);
        return loaded;
    }

    private static LoadedReplay Describe(CombatReplay replay)
    {
        var writer = new PacketWriter();
        writer.Write(replay.serializableRun);
        writer.WriteUInt(replay.nextActionId);
        writer.WriteUInt(replay.nextHookId);
        writer.WriteUInt(replay.nextChecksumId);
        string key = Convert.ToHexString(SHA256.HashData(writer.Buffer.AsSpan(0, writer.BytePosition)))[..16];
        var actions = new List<int>();
        var signatures = new List<string>();
        for (int i = 0; i < replay.events.Count; i++)
        {
            if (replay.events[i].eventType != CombatReplayEventType.GameAction) continue;
            var w = new PacketWriter();
            w.Write(replay.events[i]);
            for (int j = i + 1; j < replay.events.Count && replay.events[j].eventType != CombatReplayEventType.GameAction; j++)
                if (replay.events[j].eventType == CombatReplayEventType.PlayerChoice) w.Write(replay.events[j]);
            actions.Add(i);
            signatures.Add(Convert.ToHexString(SHA256.HashData(w.Buffer.AsSpan(0, w.BytePosition))));
        }
        return new LoadedReplay { Replay = replay, CombatKey = key, ActionEvents = actions, ActionSignatures = signatures };
    }

    /// <summary>
    /// Makes <paramref name="loaded"/> (its first <paramref name="maxActions"/> player actions, or all) the current
    /// state. When the live game state is an earlier point of the same combat, only the new actions are applied.
    /// </summary>
    public (Sim sim, List<Creature> seen) Load(LoadedReplay loaded, int? maxActions)
    {
        int target = Math.Min(maxActions ?? int.MaxValue, loaded.ActionEvents.Count);
        if (target < 0) throw new ArgumentException("actions must be at least 0");
        LastLoadIncremental = false;
        if (_live is { } live && live.loaded.CombatKey == loaded.CombatKey && live.applied <= target
            && live.loaded.ActionSignatures.Take(live.applied).SequenceEqual(loaded.ActionSignatures.Take(live.applied)))
        {
            Apply(loaded, live.sim, live.seen, live.applied, target);
            LastLoadIncremental = true;
            _live = (loaded, target, live.sim, live.seen);
        }
        else
        {
            var (sim, seen) = Rebuild(loaded, target);
            _live = (loaded, target, sim, seen);
        }
        Loaded = loaded;
        LoadedActions = target;
        return (_live.Value.sim, _live.Value.seen);
    }

    /// <summary>Rebuilds the combat from the snapshot plus the first <paramref name="count"/> player actions.</summary>
    public static (Sim sim, List<Creature> seen) Rebuild(LoadedReplay loaded, int count)
    {
        var sim = Sim.Start(loaded.Replay.serializableRun, loaded.Replay);
        var seen = new List<Creature>();
        Observe(sim, seen);
        Apply(loaded, sim, seen, 0, count);
        return (sim, seen);
    }

    private static void Apply(LoadedReplay loaded, Sim sim, List<Creature> seen, int from, int to)
    {
        var events = loaded.Replay.events;
        for (int k = from; k < to; k++)
        {
            int i = loaded.ActionEvents[k];
            for (int j = i + 1; j < events.Count && events[j].eventType != CombatReplayEventType.GameAction; j++)
                if (events[j].eventType == CombatReplayEventType.PlayerChoice)
                    sim.Choices.AnswerRecorded(sim.Player, sim.Run, events[j].playerChoiceResult!.Value);
            GameAction action = events[i].action!.ToGameAction(sim.Player);
            if (action is ReadyToBeginEnemyTurnAction) sim.EndTurn();
            else sim.Enqueue(action);
            Observe(sim, seen);
        }
    }

    private static void Observe(Sim sim, List<Creature> seen)
    {
        if (CombatManager.Instance.DebugOnlyGetState() is not { } combat) return;
        foreach (var e in combat.Enemies)
            if (!seen.Contains(e)) seen.Add(e);
    }

    // ---------------------------------------------------------------- hidden information

    /// <summary>
    /// The run streams a combat action can consume (see the README). The other run streams (UpFront, UnknownMapPoint,
    /// TreasureRoomRelics) and the player streams (Rewards, Shops, Transformations) are only used outside combat.
    /// </summary>
    public static readonly RunRngType[] CombatStreams =
    {
        RunRngType.Shuffle, RunRngType.CombatCardGeneration, RunRngType.CombatPotionGeneration, RunRngType.CombatCardSelection,
        RunRngType.CombatEnergyCosts, RunRngType.CombatTargets, RunRngType.MonsterAi, RunRngType.Niche, RunRngType.CombatOrbs,
    };

    private static readonly FieldInfo PileCards = typeof(CardPile).GetField("_cards", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new MissingFieldException("CardPile._cards");

    /// <summary>
    /// Replaces every in-combat random stream with one derived from (seed, sample), reseeds each monster's own RNG,
    /// and shuffles the draw pile below its top <paramref name="knownTop"/> cards.
    /// </summary>
    public static void Rerandomize(Sim sim, ulong seed, int sample, int knownTop)
    {
        foreach (RunRngType type in CombatStreams)
            sim.Run.Rng.MockRng(type, Mix(seed, sample, "run:" + type));
        foreach (Creature enemy in sim.Combat.Enemies)
            if (enemy.Monster is { } monster)
                monster.Rng = new Rng(Mix(seed, sample, "monster:" + enemy.CombatId));
        var cards = (List<CardModel>)PileCards.GetValue(sim.Player.PlayerCombatState!.DrawPile)!;
        int keep = Math.Clamp(knownTop, 0, cards.Count);
        var rest = cards.Skip(keep).ToList();
        new Rng(Mix(seed, sample, "draw")).Shuffle(rest);
        cards.RemoveRange(keep, cards.Count - keep);
        cards.AddRange(rest);
    }

    /// <summary>SplitMix64 over the seed, sample index and stream name: stable across processes and platforms.</summary>
    public static ulong Mix(ulong seed, int sample, string stream)
    {
        ulong h = SplitMix(SplitMix(seed) ^ SplitMix(0x632BE59BD9B4E019UL + (ulong)(uint)sample));
        foreach (char c in stream) h = SplitMix(h ^ c);
        return h;
    }

    private static ulong SplitMix(ulong x)
    {
        x += 0x9E3779B97F4A7C15UL;
        x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9UL;
        x = (x ^ (x >> 27)) * 0x94D049BB133111EBUL;
        return x ^ (x >> 31);
    }

    // ---------------------------------------------------------------- lines

    public sealed record LineAction(string action, int? card_index, int? slot, string? target);

    public sealed record SampleResult(bool ok, int? stopped_at, string? reason, BridgeState.State after_line,
        BridgeState.State? after_enemy_turn, bool player_dead, bool combat_won);

    /// <summary>Rebuilds the loaded state, re-randomizes it for this sample, then plays the line.</summary>
    public SampleResult Simulate(IReadOnlyList<LineAction> line, bool endTurn, ulong seed, int sample, int knownTop)
    {
        if (Loaded == null) throw new InvalidOperationException("Nothing loaded.");
        _live = null; // the game state is about to diverge from the loaded one
        var (sim, seen) = Rebuild(Loaded, LoadedActions);
        sim.Choices.Clear();
        sim.Choices.StopOnUnanswered = true;
        Rerandomize(sim, seed, sample, knownTop);

        BridgeState.State Read() { Observe(sim, seen); return BridgeState.Read(sim.Combat, seen); }
        bool Over() => !CombatManager.Instance.IsInProgress;
        bool Dead() => sim.Player.Creature.IsDead;
        SampleResult Result(bool ok, int? at, string? reason, BridgeState.State afterLine, BridgeState.State? afterEnemy) =>
            new(ok, at, reason, afterLine, afterEnemy, Dead(), Over() && !Dead());

        int firstEnd = -1;
        for (int i = 0; i < line.Count; i++)
        {
            if (line[i].action == "end_turn") { firstEnd = i; break; }
        }
        if (firstEnd >= 0 && firstEnd < line.Count - 1)
            return Result(false, firstEnd + 1, "actions after end_turn are not supported", Read(), null);
        int playCount = firstEnd >= 0 ? firstEnd : line.Count;

        for (int i = 0; i < playCount; i++)
        {
            var before = Read();
            if (Over()) return Result(true, i, "combat_ended", before, null);
            int errors = Boot.Errors.Count;
            string? problem;
            try { problem = Apply(sim, line[i]); }
            catch (Exception ex) { problem = ex.GetBaseException().Message; }
            if (problem == null && sim.Choices.Pending != null) return Result(false, i, "choice", before, null);
            if (problem == null && Boot.Errors.Count > errors) problem = "game error: " + Boot.Errors[errors];
            if (problem != null) return Result(false, i, problem, before, null);
        }
        var afterLine = Read();
        if (Over() || !(endTurn || firstEnd >= 0)) return Result(true, null, null, afterLine, null);

        int endIndex = firstEnd >= 0 ? firstEnd : line.Count;
        int errorsBefore = Boot.Errors.Count;
        try { sim.EndTurn(); }
        catch (Exception ex) { return Result(false, endIndex, ex.GetBaseException().Message, afterLine, null); }
        if (sim.Choices.Pending != null) return Result(false, endIndex, "choice", afterLine, null);
        if (Boot.Errors.Count > errorsBefore) return Result(false, endIndex, "game error: " + Boot.Errors[errorsBefore], afterLine, null);
        var afterEnemy = Read();
        return Result(true, null, null, afterLine, Over() ? null : afterEnemy);
    }

    /// <summary>Applies one action with the bridge's checks (McpMod.Actions.cs). Returns a reason when it is illegal.</summary>
    private static string? Apply(Sim sim, LineAction a)
    {
        var combat = sim.Combat;
        switch (a.action)
        {
            case "play_card":
            {
                var hand = sim.Player.PlayerCombatState!.Hand.Cards;
                if (a.card_index is not int index) return "Missing 'card_index'";
                if (index < 0 || index >= hand.Count) return $"card_index {index} out of range (hand has {hand.Count} cards)";
                CardModel card = hand[index];
                if (!card.CanPlay(out var why, out _)) return $"Card '{card.Id.Entry}' cannot be played: {why}";
                Creature? target = null;
                if (card.TargetType == TargetType.AnyEnemy)
                {
                    if (string.IsNullOrEmpty(a.target)) return "Card requires a target. Provide 'target' with an entity_id.";
                    target = BridgeState.ResolveTarget(combat, a.target);
                    if (target == null) return $"Target '{a.target}' not found among alive enemies";
                }
                if (!card.CanPlayTargeting(target)) return $"Card '{card.Id.Entry}' cannot be played on {a.target ?? "no target"}";
                sim.Enqueue(new PlayCardAction(card, target));
                return null;
            }
            case "use_potion":
            {
                var player = sim.Player;
                if (a.slot is not int slot) return "Missing 'slot' (potion slot index)";
                if (slot < 0 || slot >= player.PotionSlots.Count) return $"Potion slot {slot} out of range (player has {player.PotionSlots.Count} slots)";
                var potion = player.PotionSlots[slot];
                if (potion == null) return $"No potion in slot {slot}";
                if (potion.IsQueued) return $"Potion '{potion.Id.Entry}' is already queued for use";
                if (!potion.PassesCustomUsabilityCheck) return $"Potion '{potion.Id.Entry}' cannot be used right now";
                if (potion.Usage == PotionUsage.Automatic) return $"Potion '{potion.Id.Entry}' is automatic and cannot be manually used";
                Creature? target = null;
                switch (potion.TargetType)
                {
                    case TargetType.AnyEnemy:
                        if (string.IsNullOrEmpty(a.target)) return "Potion requires a target enemy. Provide 'target' with an entity_id.";
                        target = BridgeState.ResolveTarget(combat, a.target);
                        if (target == null) return $"Target '{a.target}' not found among alive enemies";
                        break;
                    case TargetType.Self:
                    case TargetType.AnyAlly:
                    case TargetType.AnyPlayer:
                        target = player.Creature;
                        break;
                }
                potion.EnqueueManualUse(target);
                sim.Settle(potion.Id.Entry);
                return null;
            }
            default:
                return $"Unknown action '{a.action}'";
        }
    }
}
