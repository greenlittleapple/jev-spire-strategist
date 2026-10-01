using System.Text.Json;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.MonsterMoves.Intents;

namespace Sts2Sim;

/// <summary>Reads the live combat state into plain records (the numbers a forecast needs) and prints them as JSON.</summary>
public static class StateView
{
    public sealed record CardView(string id, int upgrades, int cost);
    public sealed record PowerView(string id, int amount);
    public sealed record IntentView(string type, int? damage, int? hits);
    public sealed record CreatureView(uint? combatId, string id, int hp, int maxHp, int block, List<PowerView> powers, List<IntentView>? intents);
    public sealed record PlayerView(CreatureView creature, int energy, int maxEnergy, List<CardView> hand, List<CardView> draw,
        List<CardView> discard, List<CardView> exhaust, List<string> potions);
    public sealed record CombatView(int round, string side, bool inProgress, PlayerView player, List<CreatureView> enemies);

    public static CombatState Combat => CombatManager.Instance.DebugOnlyGetState()
        ?? throw new InvalidOperationException("No combat in progress.");

    public static CombatView Read(CombatState combat)
    {
        var player = combat.Players[0];
        var pcs = player.PlayerCombatState!;
        var view = new PlayerView(Creature(player.Creature, null), pcs.Energy, pcs.MaxEnergy,
            Pile(pcs.Hand), Pile(pcs.DrawPile), Pile(pcs.DiscardPile), Pile(pcs.ExhaustPile),
            player.Potions.Select(p => p.Id.Entry).ToList());
        var targets = combat.PlayerCreatures;
        var enemies = combat.Enemies.Select(e => Creature(e, Intents(e, targets))).ToList();
        return new CombatView(combat.RoundNumber, combat.CurrentSide.ToString(), CombatManager.Instance.IsInProgress, view, enemies);
    }

    public static string Json(CombatView view) => JsonSerializer.Serialize(view);

    private static CreatureView Creature(Creature c, List<IntentView>? intents) =>
        new(c.CombatId, c.Monster?.Id.Entry ?? "PLAYER", c.CurrentHp, c.MaxHp, c.Block,
            c.Powers.Select(p => new PowerView(p.Id.Entry, p.Amount)).ToList(), intents);

    private static List<CardView> Pile(CardPile pile) =>
        pile.Cards.Select(c => new CardView(c.Id.Entry, c.CurrentUpgradeLevel, c.EnergyCost.GetResolved())).ToList();

    private static List<IntentView>? Intents(Creature enemy, IReadOnlyList<Creature> targets)
    {
        if (enemy.Monster == null || !enemy.IsAlive) return null;
        return enemy.Monster.NextMove.Intents.Select(i => i is AttackIntent a
            ? new IntentView(i.IntentType.ToString(), a.GetSingleDamage(targets, enemy), Math.Max(1, a.Repeats))
            : new IntentView(i.IntentType.ToString(), null, null)).ToList();
    }
}
