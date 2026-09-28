// Minimal signatures matching the inspected v0.111.0 methods. This runs the
// production Harmony observers across real asynchronous calls, without a game.
using System.Runtime.CompilerServices;
namespace MegaCrit.Sts2.Core.Models {
 public class AbstractModel { }
 public class CardModel { }
}
namespace MegaCrit.Sts2.Core.Entities.Cards {
 using MegaCrit.Sts2.Core.Models;
 public enum PileType { Draw, Hand }
 public enum CardPilePosition { Top, Bottom, Random }
 public class CardPile(PileType type) {
  public PileType Type { get; }=type;
  private readonly List<CardModel> cards=new();
  public IReadOnlyList<CardModel> Cards=>cards;
  [MethodImpl(MethodImplOptions.NoInlining)] public void AddInternal(CardModel card,int index=-1,bool silent=false) { if(index<0)cards.Add(card);else cards.Insert(index,card); }
  [MethodImpl(MethodImplOptions.NoInlining)] public void RemoveInternal(CardModel card,bool silent=false)=>cards.Remove(card);
  [MethodImpl(MethodImplOptions.NoInlining)] public void RandomizeOrderInternal()=>cards.Reverse();
  [MethodImpl(MethodImplOptions.NoInlining)] public void MoveToTopInternal(CardModel card){cards.Remove(card);cards.Insert(0,card);}
  [MethodImpl(MethodImplOptions.NoInlining)] public void MoveToBottomInternal(CardModel card){cards.Remove(card);cards.Add(card);}
 }
}
namespace MegaCrit.Sts2.Core.Entities.Players {
 using MegaCrit.Sts2.Core.Entities.Cards;
 public class Player { public Combat PlayerCombatState {get;}=new(); }
 public class Combat { public CardPile DrawPile {get;}=new(PileType.Draw); }
}
namespace MegaCrit.Sts2.Core.Commands {
 using MegaCrit.Sts2.Core.Entities.Cards;
 using MegaCrit.Sts2.Core.Entities.Players;
 using MegaCrit.Sts2.Core.Models;
 public static class CardPileCmd {
  [MethodImpl(MethodImplOptions.NoInlining)]
  public static async Task Add(IEnumerable<CardModel> cards,CardPile newPile,CardPilePosition position=CardPilePosition.Bottom,AbstractModel? clonedBy=null,bool skipVisuals=false,bool isChangingOwners=false){
   await Task.Yield();
   foreach(var card in cards)newPile.AddInternal(card,position==CardPilePosition.Bottom?-1:0); // Random deliberately lands at zero.
  }
  [MethodImpl(MethodImplOptions.NoInlining)] public static async Task Shuffle(Player player){
   await Task.Yield();
   await Add(new[]{new CardModel()},player.PlayerCombatState.DrawPile,CardPilePosition.Top);
  }
 }
}
