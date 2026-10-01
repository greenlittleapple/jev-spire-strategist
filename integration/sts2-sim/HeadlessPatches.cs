using System.Reflection;
using System.Runtime.CompilerServices;
using Godot;
using HarmonyLib;

namespace Sts2Sim;

/// <summary>
/// In-memory Harmony patches for the few places where the no-op engine (GodotHeadless) is not enough.
/// Nothing on disk is modified. Each patch says why it exists.
/// </summary>
public static class HeadlessPatches
{
    private static readonly Harmony Harmony = new("jev.sts2sim");

    public static void Apply()
    {
        // Engine singletons (OS, Engine, Time, ...) are normally wrapped by the engine calling back into managed code.
        // Without an engine the lookup yields null and every singleton call throws, so build the wrapper here.
        Prefix(AccessTools.Method("Godot.NativeInterop.InteropUtils:EngineGetSingleton"), nameof(EngineGetSingleton));

        // Engine method calls go through generated helpers in Godot.NativeCalls. Those that return a number, bool or
        // vector read it from an uninitialized local the engine would have filled, so with the no-op engine they
        // return stack garbage (for example FileAccess.FileExists returned true). Make all of them return zero/false.
        // Helpers returning strings, arrays or objects already start from a zeroed value and return empty/null.
        Type nativeCalls = AccessTools.TypeByName("Godot.NativeCalls");
        foreach (MethodInfo method in nativeCalls.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        {
            if (method.ReturnType.IsValueType && method.ReturnType != typeof(void) && !method.IsGenericMethodDefinition)
            {
                Prefix(method, nameof(ReturnDefault));
                PatchedEngineCalls++;
            }
        }

        // Display text. The localization tables live in the game's Godot pack, which is not loaded headless, and
        // combat only formats text for log lines and UI. Return the entry key instead.
        Type locString = typeof(MegaCrit.Sts2.Core.Localization.LocString);
        Prefix(AccessTools.Method(locString, "GetFormattedText"), nameof(LocKey));
        Prefix(AccessTools.Method(locString, "GetRawText"), nameof(LocKey));
        Prefix(AccessTools.Method(locString, "Exists", new[] { typeof(string), typeof(string) }), nameof(LocMissing));

        Harmony.Patch(AccessTools.PropertyGetter(typeof(MegaCrit.Sts2.Core.Multiplayer.NetSingleplayerGameService), "NetId"),
            postfix: new HarmonyMethod(typeof(HeadlessPatches), nameof(SingleplayerNetIdOverride)));
    }

    /// <summary>
    /// Singleplayer runs always use player id 1, but saved combat replays carry an anonymized player id. Setting this
    /// lets a replay's snapshot be loaded as a normal singleplayer run while keeping the id its checksums include.
    /// </summary>
    public static ulong? SingleplayerNetId;

    private static void SingleplayerNetIdOverride(ref ulong __result)
    {
        if (SingleplayerNetId != null) __result = SingleplayerNetId.Value;
    }

    private static bool LocKey(MegaCrit.Sts2.Core.Localization.LocString __instance, ref string __result)
    {
        __result = __instance.LocEntryKey;
        return false;
    }

    private static bool LocMissing(ref bool __result)
    {
        __result = false;
        return false;
    }

    public static int PatchedEngineCalls { get; private set; }

    private static bool ReturnDefault() => false;

    private static void Prefix(MethodBase? target, string patch)
    {
        if (target == null) throw new MissingMethodException("Patch target missing for " + patch);
        Harmony.Patch(target, prefix: new HarmonyMethod(typeof(HeadlessPatches), patch));
    }

    private static readonly Dictionary<string, GodotObject> Singletons = new();

    private static bool EngineGetSingleton(string name, ref GodotObject __result)
    {
        if (!Singletons.TryGetValue(name, out GodotObject? singleton))
        {
            Assembly godot = typeof(GodotObject).Assembly;
            Type type = godot.GetType("Godot." + name + "Instance") ?? godot.GetType("Godot." + name)
                ?? throw new InvalidOperationException("Unknown engine singleton " + name);
            singleton = (GodotObject)RuntimeHelpers.GetUninitializedObject(type);
            AccessTools.Field(typeof(GodotObject), "NativePtr").SetValue(singleton, GodotHeadless.DummyHandle);
            Singletons[name] = singleton;
        }
        __result = singleton;
        return false;
    }
}
