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

    // Kept separate so no game type is touched before the assembly resolver is registered.
    private static int Run(string[] args)
    {
        Verbose = args.Contains("--verbose");
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
            _ => Usage(command),
        };
    }

    private static int Usage(string command)
    {
        Console.Error.WriteLine($"unknown command {command}; commands: boot | replay <file.mcr> | drive <file.mcr> | demo <file.mcr>");
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
}
