using System.Reflection;
using System.Runtime.Loader;

namespace Sts2Sim;

/// <summary>
/// Loads sts2.dll and its dependencies (GodotSharp, 0Harmony, SmartFormat, ...) read-only from the game's data folder.
/// The folder comes from STS2_GAME_DATA_DIR, or STS2_GAME_DIR plus data_sts2_windows_x86_64.
/// Framework assemblies always come from our own runtime, because Resolving only fires when normal probing fails.
/// </summary>
public static class GameAssemblies
{
    public static string DataDir { get; private set; } = "";

    public static void Register()
    {
        string? data = Environment.GetEnvironmentVariable("STS2_GAME_DATA_DIR");
        if (string.IsNullOrEmpty(data))
        {
            string? game = Environment.GetEnvironmentVariable("STS2_GAME_DIR");
            if (string.IsNullOrEmpty(game))
                throw new InvalidOperationException("Set STS2_GAME_DIR (the Slay the Spire 2 install folder) or STS2_GAME_DATA_DIR.");
            data = Path.Combine(game, "data_sts2_windows_x86_64");
        }
        if (!File.Exists(Path.Combine(data, "sts2.dll")))
            throw new FileNotFoundException("sts2.dll not found in " + data);
        DataDir = data;
        AssemblyLoadContext.Default.Resolving += (context, name) =>
        {
            string path = Path.Combine(DataDir, name.Name + ".dll");
            return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
        };
    }
}
