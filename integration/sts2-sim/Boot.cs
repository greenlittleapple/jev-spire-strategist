using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Logging;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.TestSupport;

namespace Sts2Sim;

/// <summary>
/// Starts the game's code without a window: the subset of the game's OneTimeInitialization that the rules need.
/// Asset atlases, mods, Steam and the localization files are skipped.
/// </summary>
public static class Boot
{
    public static readonly List<string> Errors = new();

    public static void Start(bool echoLog = false)
    {
        GodotHeadless.Install();
        HeadlessPatches.Apply();
        // Test mode is the game's own headless switch: no visuals, no waits, in-memory saves, no replay writing.
        TestMode.TurnOnInternal();
        Log.LogCallback += (level, text, _) =>
        {
            if (level >= LogLevel.Error) Errors.Add(text);
            if (echoLog || level >= LogLevel.Warn) Console.Error.WriteLine($"[game {level}] {Trim(text)}");
        };
        SaveManager.Instance.InitSettingsDataForTest();
        SaveManager.Instance.InitPrefsDataForTest();
        // In test mode this marks mods as skipped without reading the mods folder.
        ModManager.Initialize(null!, null, null).GetAwaiter().GetResult();
        AssemblyInfo.Init();
        ModelDb.Init();
        ModelIdSerializationCache.Init();
        ModelDb.InitIds();
        MessageTypes.Initialize();
        ActionTypes.Initialize();
    }

    private static string Trim(string text) => text.Length > 600 ? text[..600] + " ..." : text;
}
