using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using Godot;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Multiplayer.Replay;
using MegaCrit.Sts2.Core.Runs;

namespace STS2_MCP;

// GET /api/v1/combat_replay: writes the current fight's combat replay so far to one fixed
// file, for a headless simulator to load. Recording continues, so the live fight is unaffected.
public static partial class McpMod
{
    // Fixed output file under the game's user data folder. Callers never choose the path.
    private const string CombatReplayPath = "user://jev-replays/current.mcr";

    private static void HandleGetCombatReplay(HttpListenerResponse response)
    {
        var (status, body) = RunOnMainThread(WriteCombatReplay).GetAwaiter().GetResult();
        if (status != 200) SendError(response, status, (string)body["error"]!);
        else SendJson(response, body);
    }

    private static (int, Dictionary<string, object?>) WriteCombatReplay()
    {
        static (int, Dictionary<string, object?>) Fail(int status, string message) =>
            (status, new() { ["error"] = message });

        var run = RunManager.Instance;
        var writer = run?.CombatReplayWriter;
        var combat = CombatManager.Instance?.DebugOnlyGetState();
        if (run is not { IsInProgress: true } || CombatManager.Instance is not { IsInProgress: true } || combat == null)
            return Fail(409, "No combat in progress");
        if (writer is not { IsEnabled: true })
            return Fail(409, "Combat replay recording is disabled");
        if (!writer.IsRecordingReplay)
            return Fail(409, "No combat replay is being recorded");

        // WriteReplay logs a failed write instead of throwing, so remove the previous file
        // first and treat a missing file afterwards as a failure.
        string absolute = ProjectSettings.GlobalizePath(CombatReplayPath);
        if (File.Exists(absolute)) File.Delete(absolute);
        writer.WriteReplay(CombatReplayPath, stopRecording: false);
        var file = new FileInfo(absolute);
        if (!file.Exists) return Fail(500, "The game did not write the replay file (see the game log)");

        // The writer keeps the replay in a private field; read its counts so a caller can tell
        // whether its copy is stale. Null when the field is not found in this game version.
        var replay = GetInstanceFieldValue(writer, "_replay") as CombatReplay;
        var runState = run.DebugOnlyGetState();
        return (200, new()
        {
            ["status"] = "ok",
            ["path"] = file.FullName,
            ["bytes"] = file.Length,
            ["written_at"] = file.LastWriteTimeUtc.ToString("o"),
            ["seed"] = runState?.Rng.StringSeed,
            ["floor"] = runState?.TotalFloor,
            ["encounter_id"] = combat.Encounter?.Id.Entry,
            ["round"] = combat.RoundNumber,
            ["events"] = replay?.events.Count,
            ["game_actions"] = replay?.events.Count(e => e.eventType == CombatReplayEventType.GameAction),
            ["checksums"] = replay?.checksumData.Count,
            ["game_version"] = replay?.version,
        });
    }
}
