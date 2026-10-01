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

    // Kept separate so no game type is touched before the assembly resolver is registered.
    private static bool Verbose;

    private static int Run(string[] args)
    {
        var clock = Stopwatch.StartNew();
        Verbose = args.Contains("--verbose");
        Boot.Start(echoLog: args.Contains("--log"));
        Console.WriteLine($"boot {clock.ElapsedMilliseconds} ms, {GodotHeadless.StubbedFunctions} engine functions stubbed, {HeadlessPatches.PatchedEngineCalls} engine calls zeroed, " +
                          $"{ModelDb.All.Count()} models, model id hash {ModelIdSerializationCache.Hash}");
        string command = args.FirstOrDefault(a => !a.StartsWith("--")) ?? "boot";
        string[] rest = args.Where(a => !a.StartsWith("--")).Skip(1).ToArray();
        switch (command)
        {
            case "boot":
                return 0;
            case "replay":
                return Replay(rest[0]);
            default:
                Console.Error.WriteLine("unknown command " + command);
                return 2;
        }
    }

    private static int Replay(string path)
    {
        Console.WriteLine($"replay header: {ReplayRunner.Header(path)}");
        var replay = ReplayRunner.Read(path);
        Console.WriteLine($"replay {Path.GetFileName(path)}: version {replay.version} commit {replay.gitCommit} model hash {replay.modelIdHash}, " +
                          $"{replay.events.Count} events, {replay.checksumData.Count} checksums");
        if (Verbose)
        {
            foreach (var e in replay.events) Console.WriteLine($"  event {e.eventType} player {e.playerId} {e.action} hook {e.hookId} {e.gameActionType} resume {e.actionId} choice {e.choiceId}");
            foreach (var c in replay.checksumData) Console.WriteLine($"  checksum #{c.checksumData.id} {c.context}");
        }
        var runner = new ReplayRunner(replay);
        var clock = Stopwatch.StartNew();
        var state = runner.Load(SimLoop.Instance);
        Console.WriteLine($"loaded in {clock.ElapsedMilliseconds} ms");
        clock.Restart();
        runner.PlayAll(SimLoop.Instance, state);
        Console.WriteLine($"played {runner.EventsApplied} events in {clock.ElapsedMilliseconds} ms; checksums compared {runner.ChecksumsCompared}, mismatches {runner.ChecksumMismatches}, end turns reconstructed {runner.EndTurnsReconstructed}");
        foreach (string m in runner.MismatchDetails.Take(10)) Console.WriteLine("  " + m);
        return runner.ChecksumMismatches == 0 ? 0 : 1;
    }
}
