using MegaCrit.Sts2.Core.Entities.CardRewardAlternatives;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.TestSupport;

namespace Sts2Sim;

/// <summary>
/// Answers in-combat card choices (choose-a-card screens, discard/exhaust selections) through the game's own
/// test/AutoSlay hook, CardSelectCmd.UseSelector. Each answer is a list of option indexes; with no answer queued,
/// the first allowed number of options is taken. Every request is recorded so a caller can see what was asked.
/// </summary>
public sealed class ChoiceSelector : ICardSelector
{
    private readonly Queue<int[]> _answers = new();
    public readonly List<string> Asked = new();

    public void Answer(params int[] optionIndexes) => _answers.Enqueue(optionIndexes);

    public Task<IEnumerable<CardModel>> GetSelectedCards(IEnumerable<CardModel> options, int minSelect, int maxSelect)
    {
        var list = options.ToList();
        int[] pick = _answers.Count > 0 ? _answers.Dequeue() : Enumerable.Range(0, Math.Min(Math.Max(minSelect, 1), list.Count)).ToArray();
        Asked.Add($"choose {minSelect}-{maxSelect} of [{string.Join(", ", list.Select(c => c.Id.Entry))}] -> [{string.Join(", ", pick)}]");
        return Task.FromResult(pick.Select(i => list[i]));
    }

    public CardRewardSelection GetSelectedCardReward(IReadOnlyList<CardCreationResult> options, IReadOnlyList<CardRewardAlternative> alternatives) =>
        throw new NotSupportedException("Card rewards happen after combat; the worker stops at combat end.");
}
