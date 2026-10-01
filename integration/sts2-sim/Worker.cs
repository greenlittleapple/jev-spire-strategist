using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MegaCrit.Sts2.Core.Combat;

namespace Sts2Sim;

/// <summary>
/// Long-lived forecast worker: one JSON request per line on stdin, one JSON response per line on stdout, in order,
/// echoing the request id. Everything else (game logs, warnings) goes to stderr. Protocol in README.md.
/// </summary>
public static class Worker
{
    public const string Version = "0.1.0";

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    public static int Serve()
    {
        // Responses are the only thing on stdout: anything else that writes to Console.Out goes to stderr.
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        Console.SetOut(Console.Error);
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var forecaster = new Forecaster();
        Console.Error.WriteLine($"sts2-sim worker {Version} ready, game {GameVersion()}");
        string? text;
        while ((text = input.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(text)) continue;
            output.WriteLine(Handle(forecaster, text));
        }
        return 0;
    }

    public static string Handle(Forecaster forecaster, string text)
    {
        JsonNode? id = null;
        try
        {
            var request = JsonNode.Parse(text) as JsonObject ?? throw new ArgumentException("Request must be a JSON object.");
            id = request["id"]?.DeepClone();
            string cmd = request["cmd"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'cmd'.");
            JsonObject response = cmd switch
            {
                "ping" => new JsonObject { ["ok"] = true, ["version"] = Version, ["game"] = GameVersion() },
                "load" => Load(forecaster, request),
                "simulate" => Simulate(forecaster, request),
                _ => throw new ArgumentException($"Unknown cmd '{cmd}'."),
            };
            return WithId(id, response);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"request failed: {ex}");
            return WithId(id, new JsonObject { ["ok"] = false, ["error"] = ex.GetBaseException().Message });
        }
    }

    private static string WithId(JsonNode? id, JsonObject response)
    {
        var o = new JsonObject { ["id"] = id };
        foreach (var (k, v) in response.ToList())
        {
            response.Remove(k);
            o[k] = v;
        }
        return o.ToJsonString(Json);
    }

    private static JsonObject Load(Forecaster forecaster, JsonObject request)
    {
        string path = request["replay"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'replay'.");
        int? actions = request["actions"]?.GetValue<int>();
        var clock = Stopwatch.StartNew();
        var loaded = forecaster.Read(path);
        var (sim, seen) = forecaster.Load(loaded, actions);
        var combat = sim.Combat;
        var state = BridgeState.Read(combat, seen);
        return new JsonObject
        {
            ["ok"] = true,
            ["ms"] = (int)clock.ElapsedMilliseconds,
            ["incremental"] = forecaster.LastLoadIncremental,
            ["combat"] = new JsonObject
            {
                ["encounter"] = combat.Encounter?.Id.Entry,
                ["round"] = combat.RoundNumber,
                ["player_actions"] = forecaster.LoadedActions,
                ["recorded_actions"] = loaded.ActionEvents.Count,
                ["in_progress"] = CombatManager.Instance.IsInProgress,
            },
            ["state"] = JsonSerializer.SerializeToNode(state, Json),
        };
    }

    private static JsonObject Simulate(Forecaster forecaster, JsonObject request)
    {
        var lines = request["lines"] as JsonArray ?? throw new ArgumentException("Missing 'lines'.");
        bool endTurn = request["end_turn"]?.GetValue<bool>() ?? true;
        int samples = request["samples"]?.GetValue<int>() ?? 1;
        ulong seed = request["seed"] is JsonNode s ? (ulong)s.GetValue<long>() : 0UL;
        int knownTop = request["known_top"]?.GetValue<int>() ?? 0;
        if (samples < 1 || samples > 1000) throw new ArgumentException("samples must be 1 to 1000.");
        if (forecaster.Loaded == null) throw new InvalidOperationException("Nothing loaded: send 'load' first.");
        var clock = Stopwatch.StartNew();
        var results = new JsonArray();
        foreach (var lineNode in lines)
        {
            var line = lineNode as JsonObject ?? throw new ArgumentException("Each line must be an object.");
            var actions = (line["actions"] as JsonArray ?? new JsonArray())
                .Select(a => new Forecaster.LineAction(
                    a?["action"]?.GetValue<string>() ?? "",
                    a?["card_index"]?.GetValue<int>(),
                    a?["slot"]?.GetValue<int>(),
                    a?["target"] is JsonValue t ? t.ToString() : null))
                .ToList();
            var sampleResults = new JsonArray();
            for (int i = 0; i < samples; i++)
                sampleResults.Add(JsonSerializer.SerializeToNode(forecaster.Simulate(actions, endTurn, seed, i, knownTop), Json));
            results.Add(new JsonObject { ["id"] = line["id"]?.DeepClone(), ["samples"] = sampleResults });
        }
        return new JsonObject { ["ok"] = true, ["ms"] = (int)clock.ElapsedMilliseconds, ["results"] = results };
    }

    private static string? _gameVersion;

    /// <summary>
    /// The game's release version. The game reads it from release_info.json through Godot's file API, which is
    /// stubbed here, so the worker reads the same file beside the data folder; the assembly version is the fallback.
    /// </summary>
    public static string GameVersion()
    {
        if (_gameVersion != null) return _gameVersion;
        try
        {
            string file = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(GameAssemblies.DataDir).TrimEnd('/', '\\'))!, "release_info.json");
            if (File.Exists(file) && JsonNode.Parse(File.ReadAllText(file))?["version"]?.GetValue<string>() is { } v)
                return _gameVersion = v;
        }
        catch (Exception ex) { Console.Error.WriteLine("release_info.json unreadable: " + ex.Message); }
        var asm = typeof(CombatManager).Assembly;
        return _gameVersion = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                              ?? asm.GetName().Version?.ToString() ?? "unknown";
    }
}
