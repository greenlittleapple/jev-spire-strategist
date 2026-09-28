using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Nodes.Screens.Overlays;

namespace STS2_MCP;

public static partial class McpMod
{
    private static bool IsHextechModel(object model)
    {
        for (var type = model.GetType(); type != null; type = type.BaseType)
            if (type.Namespace?.StartsWith("HextechRunes", StringComparison.Ordinal) == true
                || type.Assembly.GetName().Name?.StartsWith("HextechRunes", StringComparison.Ordinal) == true) return true;
        return false;
    }

    private static Dictionary<string, object?>? BuildHextechContext(RunState run)
    {
        var modifier = run.Modifiers.FirstOrDefault(m => m.GetType().FullName == "HextechRunes.HextechMayhemModifier");
        if (modifier == null) return null;
        try
        {
            var type = modifier.GetType();
            var catalog = type.Assembly.GetType("HextechRunes.MonsterHexCatalog") ?? throw new InvalidOperationException("Monster hex catalog unavailable");
            var active = type.GetMethod("GetActiveMonsterHexes")?.Invoke(modifier, null) as IEnumerable
                ?? throw new InvalidOperationException("Active monster hex list unavailable");
            var hexes = new List<Dictionary<string, object?>>();
            foreach (var hex in active)
            {
                var args = new[] { hex };
                var icon = catalog.GetMethod("GetIconRelicForMonsterHex", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, args) as RelicModel;
                var description = catalog.GetMethod("GetEnemyHexDescriptionFormatted", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, args) as string;
                if (icon == null || string.IsNullOrWhiteSpace(description)) throw new InvalidOperationException($"Missing enemy rule for {hex}");
                var tier = type.GetMethod("GetMonsterHexStrengthTier")?.Invoke(modifier, args)
                    ?? throw new InvalidOperationException($"Missing strength tier for {hex}");
                string? rarity = null;
                try { rarity = catalog.GetMethod("GetMonsterHexRarity", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, args)?.ToString(); }
                catch { /* Disabled or older registry entries may have no rarity lookup. Core rules remain available. */ }
                hexes.Add(new() {
                    ["id"] = hex.ToString(), ["name"] = SafeGetText(() => icon.Title) ?? hex.ToString(),
                    ["description"] = description, ["source_mod"] = "HextechRunes",
                    ["strength_tier"] = tier, ["rarity"] = rarity
                });
            }
            return new() { ["available"] = true, ["active_enemy_hexes"] = hexes,
                ["source"] = "Live HextechMayhemModifier active effects, including carried hexes; no future rolls" };
        }
        catch (Exception error) { return new() { ["available"] = false, ["error"] = error.GetBaseException().Message }; }
    }

    private static Dictionary<string, object?> BuildHextechCatalog()
    {
        var assembly = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetType("HextechRunes.HextechCatalog") != null);
        var catalog = assembly?.GetType("HextechRunes.HextechCatalog");
        if (catalog == null) return new() { ["available"] = false, ["error"] = "Hextech catalog not loaded" };
        var relics = ModelDb.AllRelics.GroupBy(r => r.GetType()).ToDictionary(g => g.Key, g => g.First());
        object DescribeTypes(string method)
        {
            var types = catalog.GetMethod(method, BindingFlags.Public | BindingFlags.Static)?.Invoke(null, null) as IEnumerable
                ?? throw new InvalidOperationException($"Missing Hextech catalog method {method}");
            return types.Cast<Type>().Select(type => {
                relics.TryGetValue(type, out var relic);
                return new Dictionary<string, object?> { ["type"] = type.FullName, ["source_mod"] = "HextechRunes",
                    ["id"] = relic?.Id.Entry, ["name"] = relic == null ? type.Name : SafeGetText(() => relic.Title),
                    ["description"] = relic == null ? null : SafeGetText(() => relic.DynamicDescription) };
            }).ToList();
        }
        var enemyCatalog = assembly!.GetType("HextechRunes.MonsterHexCatalog");
        var enemyKinds = assembly.GetType("HextechRunes.HextechContentRegistry")?
            .GetProperty("AllMonsterHexKinds", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null) as IEnumerable
            ?? throw new InvalidOperationException("Full enemy hex registry unavailable");
        var enemies = new List<Dictionary<string, object?>>();
        foreach(var hex in enemyKinds)
        {
            var args = new[] { hex };
            var icon = enemyCatalog?.GetMethod("GetIconRelicForMonsterHex", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, args) as RelicModel;
            enemies.Add(new() { ["id"] = hex.ToString(), ["name"] = icon == null ? hex.ToString() : SafeGetText(() => icon.Title),
                ["description"] = enemyCatalog?.GetMethod("GetEnemyHexDescriptionFormatted", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, args) as string });
        }
        return new() { ["available"] = true, ["runes"] = DescribeTypes("GetAllRuneTypes"),
            ["forges"] = DescribeTypes("GetAllForgeTypes"), ["enemy_hexes"] = enemies,
            ["scope"] = "Loaded registry, including disabled entries and external player registrations; descriptions use canonical values. Live equipped rules take precedence." };
    }

    private sealed record HextechChoice(string Id, Button Button, string Name, string Description, string? RelicId,
        string Kind = "select", string? Revision = null, int? Remaining = null);

    private static List<int> HextechCounts(Node screen, string field) =>
        (GetInstanceFieldValue(screen, field) as IEnumerable)?.Cast<object>().Select(Convert.ToInt32).ToList() ?? new();
    private static int HextechRerollsUsed(Node screen) => HextechCounts(screen, "_playerRuneRerollCounts").Sum()
        + HextechCounts(screen, "_enemyHexRerollCounts").Sum();
    private static Dictionary<string, object?> HextechGoldenState(Node screen)
    {
        var session = GetInstanceFieldValue(screen, "_goldenRerollSession");
        var active = session?.GetType().GetProperty("IsActive")?.GetValue(session) is true;
        return new() { ["active"] = active, ["shared_uses_remaining"] = active ? 1 : 0,
            ["upgraded_rarity"] = active ? session?.GetType().GetProperty("UpgradedRarity")?.GetValue(session)?.ToString() : null,
            ["rule"] = "When active, the next successful player-rune reroll consumes this shared upgrade. Enemy rerolls do not consume it." };
    }

    private static List<Dictionary<string, object?>> HextechPendingEnemies(Node screen)
    {
        var slots = (GetInstanceFieldValue(screen, "_monsterHexKinds") as IEnumerable)?.Cast<object?>().ToList();
        var counts = HextechCounts(screen, "_enemyHexRerollCounts");
        var limit = GetInstanceFieldValue(screen, "_enemyHexRerollLimit") as int?;
        var catalog = screen.GetType().Assembly.GetType("HextechRunes.MonsterHexCatalog");
        var result = new List<Dictionary<string, object?>>();
        if (slots == null) return result;
        for (var i=0; i<slots.Count; i++)
        {
            var hex = slots[i]; if(hex == null) continue;
            var args = new[] { hex };
            var icon = catalog?.GetMethod("GetIconRelicForMonsterHex", BindingFlags.Public | BindingFlags.Static)?.Invoke(null,args) as RelicModel;
            result.Add(new() { ["slot"] = i, ["id"] = hex.ToString(), ["name"] = icon == null ? hex.ToString() : SafeGetText(()=>icon.Title),
                ["description"] = catalog?.GetMethod("GetEnemyHexDescriptionFormatted", BindingFlags.Public | BindingFlags.Static)?.Invoke(null,args) as string,
                ["rerolls_used"] = i<counts.Count ? counts[i] : null,
                ["rerolls_remaining"] = limit >= 0 && i<counts.Count ? Math.Max(0,limit.Value-counts[i]) : null });
        }
        return result;
    }

    // Optional integration: no mod DLL reference or changes to the mod's rules.
    private static List<HextechChoice> HextechChoices(Node screen)
    {
        var choices = new List<HextechChoice>();
        if (screen.GetType().FullName != "HextechRunes.HextechRuneSelectionScreen") return choices;
        if (GetInstanceFieldValue(screen, "_choiceLocked") is true) return choices;
        if (GetInstanceFieldValue(screen, "_selectionConfirmGuardEndsAtMsec") is ulong guardUntil
            && Time.GetTicksMsec() < guardUntil) return choices;
        var relics = (GetInstanceFieldValue(screen, "_relics") as IEnumerable)?.Cast<object>().OfType<RelicModel>().ToList();
        var holders = (GetInstanceFieldValue(screen, "_holders") as IEnumerable)?.Cast<object>().OfType<Button>().ToList();
        if (relics != null && holders != null && relics.Count == holders.Count)
            for (var i = 0; i < holders.Count; i++)
            {
                var relic = relics[i];
                var button = holders[i];
                if (!button.IsVisibleInTree() || button.Disabled) continue;
                var description = SafeGetText(() => relic.DynamicDescription) ?? string.Join("\n", VisibleHextechText(button));
                choices.Add(new($"rune:{i}", button, SafeGetText(() => relic.Title) ?? relic.Id.Entry, description, relic.Id.Entry));
            }
        var totalRerolls = HextechRerollsUsed(screen);
        if(totalRerolls < 12)
        {
            var golden = HextechGoldenState(screen);
            var counts = HextechCounts(screen,"_playerRuneRerollCounts");
            var limit = GetInstanceFieldValue(screen,"_playerRuneRerollLimit") as int?;
            var buttons = (GetInstanceFieldValue(screen,"_rerollButtons") as IEnumerable)?.Cast<Button>().ToList();
            if(relics != null && buttons != null && limit.HasValue)
                for(var i=0;i<Math.Min(relics.Count,buttons.Count);i++)
                {
                    var button=buttons[i];
                    if(i>=counts.Count || !button.IsVisibleInTree() || button.Disabled || (limit>=0 && counts[i]>=limit))continue;
                    var rune=relics[i]; var name=SafeGetText(()=>rune.Title)??rune.Id.Entry;
                    int? remaining=limit<0?null:Math.Max(0,limit.Value-counts[i]);
                    choices.Add(new($"reroll:player:{i}",button,$"Reroll {name}",
                        $"Replace only offered player rune slot {i+1}. Costs one slot reroll, no gold or HP. Remaining in this slot: {(remaining.HasValue?remaining.ToString():"unlimited by game settings")}. Result is unknown. Current rule: {SafeGetText(()=>rune.DynamicDescription)}. Active golden upgrade: {golden["active"]}.",
                        rune.Id.Entry,"reroll_player",$"{screen.GetInstanceId()}:player:{i}:{counts[i]}:{totalRerolls}:{rune.Id.Entry}:{golden["active"]}",remaining));
                }
            var enemyCounts=HextechCounts(screen,"_enemyHexRerollCounts");
            var enemyLimit=GetInstanceFieldValue(screen,"_enemyHexRerollLimit") as int?;
            var enemyButtons=(GetInstanceFieldValue(screen,"_enemyHexRerollButtons") as IEnumerable)?.Cast<Button>().ToList();
            if(enemyButtons != null && enemyLimit.HasValue)
                foreach(var enemy in HextechPendingEnemies(screen))
                {
                    var i=(int)enemy["slot"]!;
                    if(i>=enemyButtons.Count || i>=enemyCounts.Count)continue;
                    var button=enemyButtons[i];
                    if(!button.IsVisibleInTree() || button.Disabled || (enemyLimit>=0 && enemyCounts[i]>=enemyLimit))continue;
                    int? remaining=enemyLimit<0?null:Math.Max(0,enemyLimit.Value-enemyCounts[i]);
                    choices.Add(new($"reroll:enemy:{i}",button,$"Reroll enemy hex: {enemy["name"]}",
                        $"Replace only pending enemy hex slot {i+1}. Costs one slot reroll, no gold or HP; does not use the golden player upgrade. Remaining in this slot: {(remaining.HasValue?remaining.ToString():"unlimited by game settings")}. Replacement is unknown. Current enemy rule: {enemy["description"]}",
                        null,"reroll_enemy",$"{screen.GetInstanceId()}:enemy:{i}:{enemyCounts[i]}:{totalRerolls}:{enemy["id"]}",remaining));
                }
        }
        foreach (var (field, name) in new[] {
            ("_playerRuneConfirm", "Confirm selected rune"),
            ("_playerRuneCancel", "Cancel pending rune selection"),
            ("_enemyOnlyConfirm", "Confirm displayed enemy runes") })
            if (GetInstanceFieldValue(screen, field) is Button button && button.IsVisibleInTree() && !button.Disabled)
            {
                if (field == "_playerRuneConfirm")
                {
                    if (GetInstanceFieldValue(screen, "_pendingPlayerRuneSlot") is not int slot
                        || relics == null || slot < 0 || slot >= relics.Count) continue;
                    var selected = relics[slot];
                    choices.Add(new(field, button, $"Confirm {SafeGetText(() => selected.Title) ?? selected.Id.Entry}",
                        SafeGetText(() => selected.DynamicDescription) ?? name, selected.Id.Entry));
                }
                else choices.Add(new(field, button, name, name, null));
            }
        return choices;
    }

    private static IEnumerable<string> VisibleHextechText(Node root)
    {
        if (root is CanvasItem canvas && !canvas.IsVisibleInTree()) yield break;
        if (root is Label label && !string.IsNullOrWhiteSpace(label.Text)) yield return label.Text;
        else if (root is RichTextLabel rich && !string.IsNullOrWhiteSpace(rich.Text)) yield return rich.Text;
        foreach (var child in root.GetChildren()) foreach (var text in VisibleHextechText(child)) yield return text;
    }

    private static Dictionary<string, object?> BuildHextechState(Node screen) => new()
    {
        ["source"] = "Hextech Runes visible selection and enabled buttons",
        ["prompt"] = "Choose or confirm a rune, or reroll one offered player rune or pending enemy hex. Compare current options with remaining rerolls; replacements are unknown.",
        ["visible_text"] = VisibleHextechText(screen).Distinct().ToList(),
        ["pending_slot"] = GetInstanceFieldValue(screen, "_pendingPlayerRuneSlot"),
        ["pending_enemy_hexes"] = HextechPendingEnemies(screen),
        ["golden_reroll"] = HextechGoldenState(screen),
        ["reroll_budget_remaining"] = Math.Max(0,12-HextechRerollsUsed(screen)),
        ["options"] = HextechChoices(screen).Select(choice => new Dictionary<string, object?> {
            ["id"] = choice.Id, ["name"] = choice.Name, ["description"] = choice.Description,
            ["relic_id"] = choice.RelicId, ["kind"] = choice.Kind, ["revision"] = choice.Revision,
            ["rerolls_remaining"] = choice.Remaining }).ToList(),
        ["limitation"] = "Autoplay offers at most 12 successful rerolls per screen, within the game's own limits. Enemy-hex removal/undo and self-pick catalogs are not automated."
    };

    private static Dictionary<string, object?> ExecuteHextechSelect(Dictionary<string, JsonElement> data)
    {
        var screen = NOverlayStack.Instance?.Peek() as Node;
        if (screen?.GetType().FullName != "HextechRunes.HextechRuneSelectionScreen") return Error("Hextech selection is no longer active");
        if (!data.TryGetValue("option_id", out var id)) return Error("Missing Hextech option ID");
        var choice = HextechChoices(screen).SingleOrDefault(item => item.Id == id.GetString());
        if (choice == null) return Error("Hextech option is no longer enabled");
        if(choice.Revision != null && (!data.TryGetValue("revision",out var revision) || revision.GetString()!=choice.Revision))
            return Error("Hextech reroll offer or remaining uses changed before dispatch");
        if (choice.RelicId != null && (!data.TryGetValue("relic_id", out var expected) || expected.GetString() != choice.RelicId))
            return Error("Hextech rune changed before dispatch");
        choice.Button.EmitSignal(BaseButton.SignalName.Pressed);
        return new() { ["status"] = "ok", ["message"] = $"Selected {choice.Name}" };
    }
}
