using MegaCrit.Sts2.Core.Entities.CardRewardAlternatives;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Entities.Models;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.TestSupport;

namespace Sts2Sim;

/// <summary>
/// Answers in-combat card choices (choose-a-card screens, discard/exhaust selections) through the game's own
/// test/AutoSlay hook. It is installed as CardSelectCmd's "local" selector: the game then still reserves a choice id
/// and signals the choice start and end exactly as with the real selection screen, so state and checksums match.
/// Answers are option indexes, or a choice recorded in a replay. With nothing queued, the first options are taken.
/// </summary>
public sealed class ChoiceSelector : ICardSelector
{
    private readonly Queue<Func<List<CardModel>, int[]>> _answers = new();
    public readonly List<string> Asked = new();

    public void Answer(params int[] optionIndexes) => _answers.Enqueue(_ => optionIndexes);

    /// <summary>Queues a choice as a replay recorded it; it is matched to the options when the game asks.</summary>
    public void AnswerRecorded(Player player, RunState run, NetPlayerChoiceResult recorded) =>
        _answers.Enqueue(options =>
        {
            PlayerChoiceResult result = PlayerChoiceResult.FromNetData(player, run, recorded);
            if (result.ChoiceType == PlayerChoiceType.Index) return result.AsIndexes().ToArray();
            return result.AsCards(result.ChoiceType)
                .Select(chosen => options.FindIndex(o => ReferenceEquals(o, chosen)) is int i and >= 0 ? i
                    : options.FindIndex(o => o.Id == chosen.Id && o.CurrentUpgradeLevel == chosen.CurrentUpgradeLevel))
                .ToArray();
        });

    public Task<IEnumerable<CardModel>> GetSelectedCards(IEnumerable<CardModel> options, int minSelect, int maxSelect)
    {
        var list = options.ToList();
        int[] pick = _answers.Count > 0 ? _answers.Dequeue()(list) : Enumerable.Range(0, Math.Min(Math.Max(minSelect, 1), list.Count)).ToArray();
        if (pick.Any(i => i < 0 || i >= list.Count))
            throw new InvalidOperationException($"Choice answer [{string.Join(", ", pick)}] does not fit {list.Count} options.");
        Asked.Add($"choose {minSelect}-{maxSelect} of [{string.Join(", ", list.Select(c => c.Id.Entry))}] -> [{string.Join(", ", pick)}]");
        return Task.FromResult(pick.Select(i => list[i]));
    }

    public CardRewardSelection GetSelectedCardReward(IReadOnlyList<CardCreationResult> options, IReadOnlyList<CardRewardAlternative> alternatives) =>
        throw new NotSupportedException("Card rewards happen after combat; the worker stops at combat end.");
}
