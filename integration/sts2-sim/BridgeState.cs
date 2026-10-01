using System.Text.Json.Serialization;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.MonsterMoves.Intents;

namespace Sts2Sim;

/// <summary>
/// The combat state in the bridge mod's naming and id scheme (integration/sts2-bridge, McpMod.StateBuilder.cs), so a
/// forecast reads like the state the bot sees:
///  - enemy entity_id is the monster id plus a counter over the living enemies in combat order ("QUEEN_0"), exactly
///    as BuildEnemyState and ResolveTarget number them;
///  - hand cards are in hand order (card_index), potions carry their slot index, and only visible powers are listed.
/// Enemies that died are kept, with hp 0 and entity_id "MONSTER_dead_N", so a caller can count kills. Display names
/// are not available headless (localization lives in the Godot pack), so name repeats the id.
/// </summary>
public static class BridgeState
{
    public sealed record Status(string id, string name, int amount);
    public sealed record Card(string id, string name, bool upgraded, object cost);
    public sealed record Potion(int slot, string id, string name);
    public sealed record Intent(string type, int? damage, int? hits);
    public sealed record PlayerState(int hp, int max_hp, int block, int energy, List<Status> status, List<Card> hand,
        int draw_count, int discard_count, int exhaust_count, List<Potion> potions);
    public sealed record EnemyState(string entity_id, uint? combat_id, string name, int hp, int max_hp, int block,
        List<Status> status, List<Intent> intents);
    public sealed record State(int round, PlayerState player, List<EnemyState> enemies);

    /// <summary>Bridge entity ids of the living enemies, in combat order.</summary>
    public static List<(Creature creature, string id)> LivingIds(CombatState combat)
    {
        var counts = new Dictionary<string, int>();
        var list = new List<(Creature, string)>();
        foreach (var c in combat.Enemies)
        {
            if (!c.IsAlive) continue;
            string baseId = c.Monster?.Id.Entry ?? "unknown";
            counts.TryGetValue(baseId, out int n);
            counts[baseId] = n + 1;
            list.Add((c, $"{baseId}_{n}"));
        }
        return list;
    }

    /// <summary>The bridge's ResolveTarget: a numeric combat id, or an entity_id among living enemies.</summary>
    public static Creature? ResolveTarget(CombatState combat, string entityId)
    {
        if (uint.TryParse(entityId, out uint combatId)) return combat.Creatures.FirstOrDefault(c => c.CombatId == combatId);
        return LivingIds(combat).FirstOrDefault(x => x.id == entityId).creature;
    }

    /// <param name="seenEnemies">Every enemy creature seen in this combat, so ones the game removed on death are kept.</param>
    public static State Read(CombatState combat, IReadOnlyList<Creature> seenEnemies)
    {
        var player = combat.Players[0];
        var pcs = player.PlayerCombatState!;
        var potions = new List<Potion>();
        for (int slot = 0; slot < player.PotionSlots.Count; slot++)
            if (player.PotionSlots[slot] is { } p) potions.Add(new Potion(slot, p.Id.Entry, p.Id.Entry));
        var playerState = new PlayerState(player.Creature.CurrentHp, player.Creature.MaxHp, player.Creature.Block,
            Energy(pcs), Powers(player.Creature),
            pcs.Hand.Cards.Select(c => new Card(c.Id.Entry, c.Id.Entry, c.IsUpgraded, Cost(c))).ToList(),
            pcs.DrawPile.Cards.Count, pcs.DiscardPile.Cards.Count, pcs.ExhaustPile.Cards.Count, potions);

        var living = LivingIds(combat).ToDictionary(x => x.creature, x => x.id);
        var ordered = combat.Enemies.Concat(seenEnemies.Where(e => !combat.Enemies.Contains(e))).ToList();
        var deadCounts = new Dictionary<string, int>();
        var targets = combat.PlayerCreatures;
        var enemies = new List<EnemyState>();
        foreach (var e in ordered)
        {
            string baseId = e.Monster?.Id.Entry ?? "unknown";
            string id;
            if (!living.TryGetValue(e, out id!))
            {
                deadCounts.TryGetValue(baseId, out int n);
                deadCounts[baseId] = n + 1;
                id = $"{baseId}_dead_{n}";
            }
            bool alive = e.IsAlive;
            enemies.Add(new EnemyState(id, e.CombatId, baseId, alive ? e.CurrentHp : 0, e.MaxHp, alive ? e.Block : 0,
                alive ? Powers(e) : new List<Status>(), alive ? Intents(e, targets) : new List<Intent>()));
        }
        return new State(combat.RoundNumber, playerState, enemies);
    }

    /// <summary>Energy runs hooks that can fail once the combat is over (the bridge skips it then); 0 in that case.</summary>
    private static int Energy(MegaCrit.Sts2.Core.Entities.Players.PlayerCombatState pcs)
    {
        try { return pcs.Energy; } catch { return 0; }
    }

    /// <summary>The bridge's cost display: "X" for X-cost cards, otherwise the energy the card would spend now.</summary>
    private static object Cost(CardModel card) => card.EnergyCost.CostsX ? "X" : card.EnergyCost.GetAmountToSpend();

    private static List<Status> Powers(Creature c) =>
        c.Powers.Where(p => p.IsVisible).Select(p => new Status(p.Id.Entry, p.Id.Entry, p.Amount)).ToList();

    private static List<Intent> Intents(Creature enemy, IReadOnlyList<Creature> targets)
    {
        if (enemy.Monster?.NextMove is not { } move) return new List<Intent>();
        return move.Intents.Select(i => i is AttackIntent a
            ? new Intent(i.IntentType.ToString(), a.GetSingleDamage(targets, enemy), Math.Max(1, a.Repeats))
            : new Intent(i.IntentType.ToString(), null, null)).ToList();
    }
}
