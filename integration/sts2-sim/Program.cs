using System.Diagnostics;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;

namespace Sts2Sim;

public static class Program
{
    public static int Main(string[] args)
    {
        GameAssemblies.Register();
        return Run(args);
    }

    private static bool Verbose;
    private static bool NoChecksums;

    // Kept separate so no game type is touched before the assembly resolver is registered.
    private static int Run(string[] args)
    {
        Verbose = args.Contains("--verbose");
        NoChecksums = args.Contains("--no-checksums");
        var clock = Stopwatch.StartNew();
        Boot.Start(echoLog: args.Contains("--log"));
        Console.WriteLine($"boot {clock.ElapsedMilliseconds} ms, {GodotHeadless.StubbedFunctions} engine functions stubbed, " +
                          $"{HeadlessPatches.PatchedEngineCalls} engine calls zeroed, {ModelDb.All.Count()} models, model id hash {ModelIdSerializationCache.Hash}");
        string command = args.FirstOrDefault(a => !a.StartsWith("--")) ?? "boot";
        string[] rest = args.Where(a => !a.StartsWith("--")).Skip(1).ToArray();
        return command switch
        {
            "boot" => 0,
            "replay" => Replay(rest[0]),
            "drive" => Drive(rest[0]),
            "demo" => Demo(rest[0]),
            "branch" => Branch(rest[0], int.Parse(rest[1]), rest.Length > 2 ? int.Parse(rest[2]) : 20),
            "states" => States(rest[0], rest[1]),
            "bench" => Bench(rest[0], rest.Length > 1 ? int.Parse(rest[1]) : 20),
            _ => Usage(command),
        };
    }

    private static int Usage(string command)
    {
        Console.Error.WriteLine($"unknown command {command}; commands: boot | replay <file.mcr> | drive <file.mcr> | demo <file.mcr> | bench <file.mcr> [runs] | branch <file.mcr> <actions> [runs] | states <file.mcr> <out.jsonl>");
        return 2;
    }

    private static MegaCrit.Sts2.Core.Multiplayer.Replay.CombatReplay Load(string path)
    {
        Console.WriteLine($"replay header: {ReplayRunner.Header(path)}");
        var replay = ReplayRunner.Read(path);
        Console.WriteLine($"replay {Path.GetFileName(path)}: {replay.events.Count} events, {replay.checksumData.Count} checksums");
        if (Verbose)
        {
            foreach (var e in replay.events) Console.WriteLine($"  event {e.eventType} {e.action} hook {e.hookId} {e.gameActionType} resume {e.actionId} choice {e.choiceId}");
            foreach (var c in replay.checksumData) Console.WriteLine($"  checksum #{c.checksumData.id} {c.context}");
        }
        return replay;
    }

    private static int Replay(string path)
    {
        var replay = Load(path);
        var clock = Stopwatch.StartNew();
        var result = ReplayRunner.Playback(replay, SimLoop.Instance);
        Console.WriteLine($"playback: {result.Events} events in {clock.ElapsedMilliseconds} ms, end turns reconstructed {result.EndTurnsReconstructed}, " +
                          result.Parity.Summary(replay.checksumData.Count));
        return result.Parity.Mismatches == 0 ? 0 : 1;
    }

    private static int Drive(string path)
    {
        var replay = Load(path);
        var clock = Stopwatch.StartNew();
        var result = ReplayRunner.Driven(replay, (sim, e) =>
        {
            if (Verbose) Console.WriteLine($"  after {e.action}: {StateView.Json(StateView.Read(sim.Combat))}");
        });
        Console.WriteLine($"driven: {result.Events - result.Skipped} player actions in {clock.ElapsedMilliseconds} ms ({result.Skipped} recorded hook events left to the game), " +
                          result.Parity.Summary(replay.checksumData.Count));
        return result.Parity.Mismatches == 0 ? 0 : 1;
    }

    /// <summary>
    /// Self-chosen actions from a replay's combat-start snapshot: play an attack on an enemy, use a potion on an
    /// enemy, end the turn and let the enemy act, printing the state after each step. Runs twice to show the result
    /// is identical.
    /// </summary>
    private static int Demo(string path)
    {
        var replay = ReplayRunner.Read(path);
        string? first = null;
        for (int run = 1; run <= 2; run++)
        {
            var log = new System.Text.StringBuilder();
            var sim = Sim.Start(replay.serializableRun, replay);
            void Show(string step) => log.AppendLine($"{step}: {StateView.Json(StateView.Read(sim.Combat))}");
            Show("start");
            var hand = sim.Player.PlayerCombatState!.Hand.Cards;
            var enemy = sim.Combat.Enemies.First(e => e.IsAlive);
            int attack = hand.ToList().FindIndex(c => c.Type == MegaCrit.Sts2.Core.Entities.Cards.CardType.Attack && c.CanPlayTargeting(enemy));
            sim.PlayCard(attack, enemy.CombatId);
            Show($"played hand[{attack}] on enemy {enemy.CombatId}");
            int slot = sim.Player.PotionSlots.ToList().FindIndex(p => p != null);
            var potion = sim.Player.PotionSlots[slot]!;
            uint? potionTarget = potion.IsValidTarget(enemy) ? enemy.CombatId : null;
            sim.Choices.Answer(1); // if the potion asks for a card, take the second option
            sim.UsePotion(slot, potionTarget);
            Show($"used potion {potion.Id.Entry} (slot {slot}) on {potionTarget?.ToString() ?? "no target"}; choices: {string.Join("; ", sim.Choices.Asked)}");
            sim.EndTurn();
            Show("ended turn; enemy turn resolved");
            string text = log.ToString();
            if (run == 1) { Console.Write(text); first = text; }
            else Console.WriteLine(text == first ? "second run: identical output" : "second run: DIFFERENT output\n" + text);
        }
        return 0;
    }

    /// <summary>
    /// Timing. Replays the fight in driven mode repeatedly in one process and reports the cold first run and the
    /// median of the rest: setup (enter combat from the snapshot), per player action, and per end turn (which
    /// includes the whole enemy turn and the next turn's start). Also checks that every run gives the same checksums.
    /// </summary>
    private static int Bench(string path, int runs)
    {
        var replay = ReplayRunner.Read(path);
        var totals = new List<double>(); var setups = new List<double>(); var actions = new List<double>(); var endTurns = new List<double>();
        List<uint>? firstSequence = null; bool allSame = true;
        for (int run = 0; run < runs; run++)
        {
            var clock = Stopwatch.StartNew();
            var setup = Stopwatch.StartNew();
            double runActions = 0, runEnds = 0; int nActions = 0, nEnds = 0;
            var last = Stopwatch.StartNew();
            var result = ReplayRunner.Driven(replay, (sim, e) =>
            {
                double ms = last.Elapsed.TotalMilliseconds;
                if (e.action is MegaCrit.Sts2.Core.GameActions.NetReadyToBeginEnemyTurnAction) { runEnds += ms; nEnds++; }
                else { runActions += ms; nActions++; }
                last.Restart();
            }, onStarted: () => { setups.Add(setup.Elapsed.TotalMilliseconds); last.Restart(); }, checksums: !NoChecksums);
            totals.Add(clock.Elapsed.TotalMilliseconds);
            actions.Add(runActions / Math.Max(1, nActions)); endTurns.Add(runEnds / Math.Max(1, nEnds));
            if (firstSequence == null) firstSequence = result.Parity.Sequence;
            else allSame &= firstSequence.SequenceEqual(result.Parity.Sequence);
            if (result.Parity.Mismatches > 0) Console.WriteLine($"run {run}: {result.Parity.Summary(replay.checksumData.Count)}");
        }
        static string Med(List<double> v) => v.Count < 2 ? "n/a" : $"{v.Skip(1).OrderBy(x => x).ElementAt((v.Count - 1) / 2):0.00}";
        Console.WriteLine($"{runs} runs of {Path.GetFileName(path)} ({replay.events.Count} events, {replay.checksumData.Count} checksums)");
        Console.WriteLine($"  whole fight ms: cold {totals[0]:0.0}, warm median {Med(totals)}");
        Console.WriteLine($"  enter combat ms: cold {setups[0]:0.00}, warm median {Med(setups)}");
        Console.WriteLine($"  per player action ms: cold {actions[0]:0.00}, warm median {Med(actions)}");
        Console.WriteLine($"  per end turn incl. enemy turn ms: cold {endTurns[0]:0.00}, warm median {Med(endTurns)}");
        Console.WriteLine(NoChecksums ? "  checksums off (game's checksum tracker disabled, as in test mode)"
            : $"  checksum sequences identical across runs: {allSame} ({firstSequence!.Count} checksums each)");
        return allSame ? 0 : 1;
    }

    /// <summary>
    /// Mid-fight branching by re-execution: the game has no way to copy or serialize a combat in progress, so a
    /// mid-fight state is rebuilt from the combat-start snapshot plus the first N player actions. Measures that cost
    /// and checks the rebuilt state is identical every time.
    /// </summary>
    private static int Branch(string path, int actions, int runs)
    {
        var replay = ReplayRunner.Read(path);
        var times = new List<double>(); string? first = null; bool same = true;
        for (int run = 0; run < runs; run++)
        {
            var clock = Stopwatch.StartNew();
            Sim? sim = null;
            ReplayRunner.Driven(replay, (s, _) => sim = s, checksums: false, maxPlayerActions: actions);
            times.Add(clock.Elapsed.TotalMilliseconds);
            string state = StateView.Json(StateView.Read(sim!.Combat));
            if (first == null) { first = state; Console.WriteLine($"state after {actions} player actions: {state}"); }
            else same &= state == first;
        }
        var warm = times.Skip(1).OrderBy(x => x).ToList();
        Console.WriteLine($"rebuild after {actions} player actions: cold {times[0]:0.0} ms, warm median {warm[warm.Count / 2]:0.0} ms, min {warm[0]:0.0} ms; identical state every run: {same}");
        return same ? 0 : 1;
    }

    /// <summary>Writes the combat state at the start and after every player action of a replay, one JSON line each.</summary>
    private static int States(string path, string outPath)
    {
        var replay = ReplayRunner.Read(path);
        using var writer = new StreamWriter(outPath);
        int step = 0;
        var result = ReplayRunner.Driven(replay, (sim, e) =>
            writer.WriteLine($"{{\"step\":{++step},\"after\":{System.Text.Json.JsonSerializer.Serialize(e.action?.ToString())},\"state\":{StateView.Json(StateView.Read(sim.Combat))}}}"),
            onStarted: () => writer.WriteLine($"{{\"step\":0,\"after\":null,\"state\":{StateView.Json(StateView.Read(StateView.Combat))}}}"));
        Console.WriteLine($"wrote {step + 1} states; {result.Parity.Summary(replay.checksumData.Count)}");
        return 0;
    }
}
