// STS2 character names come from the character ID, not the game's displayed title, which a
// skin mod can replace. "CHARACTER.IRONCLAD" or "IRONCLAD" -> "Ironclad".
export function characterName(id) {
  const key = String(id ?? '').split('.').pop();
  if (!/^[A-Z][A-Z_]*$/.test(key)) return null;
  return key.split('_').filter(Boolean).map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
}
