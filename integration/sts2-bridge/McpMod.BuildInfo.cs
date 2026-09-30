using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.RegularExpressions;
using Godot;
using MegaCrit.Sts2.Core.Debug;

namespace STS2_MCP;

// Build identity for the root greeting, so a run log can tell bridge builds apart.
public static partial class McpMod
{
    // The source commit the SDK appends to AssemblyInformationalVersion ("1.0.0+<commit>"),
    // or null when the build had no git information.
    internal static readonly string? BuildCommit = ReadBuildCommit();

    // The game's version from its release_info.json (for example "v0.111.0"), read once on
    // the main thread in Initialize, since ReleaseInfoManager loads the file through Godot.
    private static string? _gameVersion;

    private static string? ReadBuildCommit()
    {
        string? info = typeof(McpMod).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        int plus = info?.IndexOf('+') ?? -1;
        if (info == null || plus < 0) return null;
        string commit = info[(plus + 1)..];
        return Regex.IsMatch(commit, "^[0-9a-f]{7,40}$") ? commit : null;
    }

    private static void ReadGameVersion()
    {
        try
        {
            _gameVersion = ReleaseInfoManager.Instance.ReleaseInfo?.Version;
        }
        catch (Exception ex)
        {
            GD.Print($"[STS2 MCP] Game version unavailable: {ex.GetType().Name}: {ex.Message}");
        }
    }

    // GET / body. A dictionary keeps build and game as explicit nulls, which the JSON options
    // would otherwise drop. message keeps the upstream wording for older readers.
    private static Dictionary<string, object?> Greeting() => new()
    {
        ["message"] = $"Hello from STS2 MCP v{Version}",
        ["status"] = "ok",
        ["version"] = Version,
        ["build"] = BuildCommit,
        ["game"] = _gameVersion,
    };
}
