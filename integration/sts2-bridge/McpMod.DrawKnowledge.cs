using System;
using System.Collections.Generic;
using System.Reflection;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using HarmonyLib;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Models;

namespace STS2_MCP;

internal static class DrawKnowledge
{
    internal static bool Ready { get; private set; }
    internal static void CheckPatches()
    {
        var methods = new[] { AccessTools.Method(typeof(CardPile), nameof(CardPile.AddInternal)),
            AccessTools.Method(typeof(CardPile), nameof(CardPile.RemoveInternal)),
            AccessTools.Method(typeof(CardPile), nameof(CardPile.RandomizeOrderInternal)),
            AccessTools.Method(typeof(CardPile), nameof(CardPile.MoveToTopInternal)),
            AccessTools.Method(typeof(CardPile), nameof(CardPile.MoveToBottomInternal)),
            AccessTools.Method(typeof(CardPileCmd), nameof(CardPileCmd.Shuffle)),
            AccessTools.Method(typeof(CardPileCmd), nameof(CardPileCmd.Add), new Type[] { typeof(IEnumerable<CardModel>), typeof(CardPile), typeof(CardPilePosition), typeof(AbstractModel), typeof(bool), typeof(bool) }) };
        Ready = methods.All(method => Harmony.GetPatchInfo(method)?.Owners.Contains("com.sts2mcp") == true);
    }
    internal sealed record Placement(CardPile Pile, CardPilePosition Position);
    internal static readonly AsyncLocal<Placement?> Current = new();
    internal static readonly AsyncLocal<bool> Shuffling = new();
    private static readonly ConditionalWeakTable<CardPile, KnownDrawTop<CardModel>> Tops = new();
    internal static KnownDrawTop<CardModel> For(CardPile pile) => Tops.GetValue(pile, _ => new());

    [HarmonyPatch(typeof(CardPileCmd), nameof(CardPileCmd.Add), new Type[] {
        typeof(IEnumerable<CardModel>), typeof(CardPile), typeof(CardPilePosition), typeof(AbstractModel), typeof(bool), typeof(bool) })]
    private static class ObservePlacement
    {
        // The async game method captures this context across awaits. Restore the
        // caller's context immediately; do not wrap or change the game's Task.
        static void Prefix(CardPile newPile, CardPilePosition position, out Placement? __state)
        { __state = Current.Value; Current.Value = new Placement(newPile, position); }
        static void Postfix(Placement? __state) => Current.Value = __state;
        static void Finalizer(Placement? __state) => Current.Value = __state;
    }

    [HarmonyPatch(typeof(CardPile), nameof(CardPile.AddInternal))]
    private static class ObserveAdd
    {
        static void Postfix(CardPile __instance, CardModel card, int index)
        {
            if (__instance.Type != PileType.Draw) return;
            var top = For(__instance);
            var placement = Current.Value;
            if (Shuffling.Value || placement?.Pile != __instance) top.Clear();
            else if (placement.Position == CardPilePosition.Top && index == 0) top.PutOnTop(card);
            else if (placement.Position != CardPilePosition.Bottom || index != -1) top.Clear();
            top.Validate(__instance.Cards);
        }
    }

    [HarmonyPatch(typeof(CardPile), nameof(CardPile.RemoveInternal))]
    private static class ObserveRemove
    {
        static void Postfix(CardPile __instance, CardModel card)
        { if (__instance.Type == PileType.Draw) { For(__instance).Remove(card); For(__instance).Validate(__instance.Cards); } }
    }

    [HarmonyPatch]
    private static class ForgetDirectReorder
    {
        static IEnumerable<MethodBase> TargetMethods()
        {
            yield return AccessTools.Method(typeof(CardPile), nameof(CardPile.RandomizeOrderInternal));
            yield return AccessTools.Method(typeof(CardPile), nameof(CardPile.MoveToTopInternal));
            yield return AccessTools.Method(typeof(CardPile), nameof(CardPile.MoveToBottomInternal));
        }
        static void Prefix(CardPile __instance)
        { if (__instance.Type == PileType.Draw) For(__instance).Clear(); }
    }

    [HarmonyPatch(typeof(CardPileCmd), nameof(CardPileCmd.Shuffle))]
    private static class ForgetShuffle
    {
        static void Prefix(MegaCrit.Sts2.Core.Entities.Players.Player player, out bool __state)
        {
            __state = Shuffling.Value; Shuffling.Value = true;
            if (player.PlayerCombatState?.DrawPile is { } pile) For(pile).Clear();
        }
        static void Postfix(bool __state) => Shuffling.Value = __state;
        static void Finalizer(bool __state) => Shuffling.Value = __state;
    }
}
