using System;
using System.Collections.Generic;
using System.Linq;
using Godot;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.CustomRun;

namespace STS2_MCP;

// Singleplayer custom-run screen: character, seed, ascension and modifiers. Seeded
// runs let decision policies be compared on identical maps and rewards.
public static partial class McpMod
{
    internal static NCustomRunScreen? FindVisibleCustomRun(Node root)
    {
        var screen = FindFirst<NCustomRunScreen>(root);
        return screen != null && IsNodeVisible(screen) ? screen : null;
    }

    private static List<string> CustomRunModifierIds(NCustomRunScreen screen)
    {
        var lobby = screen.Lobby;
        if (lobby == null) return new List<string>();
        return lobby.Modifiers.Select(m => m.Id.Entry).ToList();
    }

    internal static void AddCustomRunMenuState(Dictionary<string, object?> result, NCustomRunScreen screen)
    {
        result["state_type"] = "menu";
        result["menu_screen"] = "custom_run";
        result["message"] = "Custom run: select a character, then embark with a seed.";

        var selected = GetInstanceFieldValue(screen, "_selectedButton") as NCharacterSelectButton;
        var characters = new List<Dictionary<string, object?>>();
        var options = new List<Dictionary<string, object?>>();
        foreach (var btn in FindAll<NCharacterSelectButton>(screen))
        {
            if (btn.Character is not { } cm || !IsNodeVisible(btn)) continue;
            characters.Add(new Dictionary<string, object?>
            {
                ["id"] = cm.Id.Entry,
                ["name"] = SafeGetText(() => cm.Title),
                ["locked"] = btn.IsLocked,
                ["selected"] = ReferenceEquals(btn, selected),
            });
            options.Add(new Dictionary<string, object?> { ["name"] = cm.Id.Entry, ["enabled"] = !btn.IsLocked });
        }

        var lobby = screen.Lobby;
        var confirm = GetInstanceFieldValue(screen, "_confirmButton") as NClickableControl;
        options.Add(new Dictionary<string, object?> { ["name"] = "embark", ["enabled"] = confirm?.IsEnabled == true });
        options.Add(new Dictionary<string, object?> { ["name"] = "back", ["enabled"] = true });
        result["characters"] = characters;
        result["options"] = options;
        result["custom_run"] = new Dictionary<string, object?>
        {
            ["seed"] = lobby?.Seed,
            ["ascension"] = lobby?.Ascension,
            ["max_ascension"] = lobby?.MaxAscension,
            ["modifiers"] = CustomRunModifierIds(screen),
            ["selected_character"] = selected?.Character?.Id.Entry,
        };
    }

    internal static Dictionary<string, object?> ExecuteCustomRunMenuOption(NCustomRunScreen screen, string option, string? seed)
    {
        if (string.Equals(option, "back", StringComparison.OrdinalIgnoreCase))
        {
            if (GetInstanceFieldValue(screen, "_backButton") is NClickableControl back && back.IsEnabled)
            {
                back.ForceClick();
                return new Dictionary<string, object?> { ["status"] = "ok", ["message"] = "Going back" };
            }
            return Error("Back button not available");
        }

        if (string.Equals(option, "embark", StringComparison.OrdinalIgnoreCase)
            || string.Equals(option, "confirm", StringComparison.OrdinalIgnoreCase))
        {
            var lobby = screen.Lobby;
            if (lobby == null) return Error("Custom run lobby is not ready");
            // A comparison run must be a plain game; never embark with modifiers selected.
            var modifiers = CustomRunModifierIds(screen);
            if (modifiers.Count > 0)
                return Error($"Custom run has modifiers selected ({string.Join(", ", modifiers)}). Clear them in the game first; the run was not started.");
            if (!string.IsNullOrWhiteSpace(seed))
            {
                lobby.SetSeed(seed.Trim());
                if (!string.Equals(lobby.Seed, seed.Trim(), StringComparison.OrdinalIgnoreCase))
                    return Error($"Seed was not applied (lobby seed: {lobby.Seed ?? "none"}); the run was not started.");
            }
            if (GetInstanceFieldValue(screen, "_confirmButton") is NClickableControl confirm && confirm.IsEnabled)
            {
                confirm.ForceClick();
                return new Dictionary<string, object?>
                {
                    ["status"] = "ok",
                    ["message"] = $"Embarking on custom run (seed: {lobby.Seed ?? "random"}, ascension: {lobby.Ascension})",
                    ["seed"] = lobby.Seed,
                    ["ascension"] = lobby.Ascension,
                };
            }
            return Error("Embark button not available — select a character first");
        }

        foreach (var btn in FindAll<NCharacterSelectButton>(screen))
        {
            if (btn.Character == null) continue;
            if (!string.Equals(btn.Character.Id.Entry, option, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(SafeGetText(() => btn.Character.Title), option, StringComparison.OrdinalIgnoreCase)) continue;
            if (btn.IsLocked) return Error($"Character '{option}' is locked");
            btn.Select();
            return new Dictionary<string, object?> { ["status"] = "ok", ["message"] = $"Selected {SafeGetText(() => btn.Character.Title)}. Use 'embark' with a seed." };
        }
        return Error($"Unknown custom run option: {option}. Use a character ID, embark (with seed) or back.");
    }
}
