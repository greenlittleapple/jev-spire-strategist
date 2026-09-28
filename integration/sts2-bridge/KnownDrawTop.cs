using System.Collections.Generic;
using System.Linq;

namespace STS2_MCP;

// Tracks only an observed deterministic top insertion, never the hidden pile order.
internal sealed class KnownDrawTop<T> where T : class
{
    private readonly List<T> _top = new();
    public void Clear() => _top.Clear();
    public void PutOnTop(T card) { Remove(card); _top.Insert(0, card); }
    public void Remove(T card) => _top.RemoveAll(item => ReferenceEquals(item, card));
    public IReadOnlyList<T> Validate(IReadOnlyList<T> actual)
    {
        if (_top.Count > actual.Count || _top.Where((card, i) => !ReferenceEquals(card, actual[i])).Any()) Clear();
        return _top.ToArray();
    }
}
