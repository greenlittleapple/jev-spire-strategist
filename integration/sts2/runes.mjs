// Applied after request compaction so combat, rewards, shops and review passes
// all retain the actual equipped rune rules, including previously unknown runes.
export const isHextech = item => item?.source_mod === 'HextechRunes'
  || /_RUNE$|^HEXTECH_/i.test(item?.id ?? '');

export function runeRules(state) {
  return [
    ...(state.player?.relics ?? []).filter(isHextech).map(r=>({...r,owner:'player',kind:'relic'})),
    ...(state.player?.status ?? []).filter(isHextech).map(r=>({...r,owner:'player',kind:'power'})),
    ...(state.battle?.enemies ?? []).flatMap(e=>(e.status??[]).filter(isHextech).map(r=>({...r,owner:e.entity_id,kind:'power'}))),
    ...(state.hextech?.active_enemy_hexes ?? []).map(r=>({...r,owner:'enemies',kind:'hex'}))
  ];
}

export function modeledRunes(state) {
  const relics = state.player?.relics ?? [];
  const flying = relics.filter(r => r.id === 'FLYING_KICK_RUNE').length === 1 && relics.find(r => r.id === 'FLYING_KICK_RUNE'
    && /execute monsters below .*\(10 \+ 8% of your max HP\).*heal 10% of your max HP/i.test(r.description ?? ''));
  const grounded = relics.filter(r=>r.id==='GROUNDED_RUNE').length === 1 && relics.some(r => r.id === 'GROUNDED_RUNE'
    && /^At the end of your turn, double your Block\.?$/i.test(r.description ?? ''));
  const maxHp = state.player?.max_hp;
  const blockUncertain=(state.player?.status??[]).some(p=>/metallicize/i.test(p.name??'') || /cannot gain.*block|block gain.*(?:double|half|reduc|increas)/i.test(p.description??''));
  const healingUncertain=[...(state.player?.status??[]),...relics.filter(r=>r.id!=='FLYING_KICK_RUNE')].some(r=>/cannot.*heal|healing.*(?:double|half|reduc|increas)|heal.*instead/i.test(r.description??''));
  return {grounded:grounded&&!blockUncertain, flyingKick: flying && !healingUncertain && Number.isSafeInteger(maxHp) && maxHp > 0
    ? {thresholdPercent:10 + maxHp * .08, heal:Math.max(1,Math.floor(maxHp * .1)), maxHp} : null};
}

export function unsupportedRuneRules(state) {
  const modeled=modeledRunes(state);
  return runeRules(state).filter(r=>!(r.kind==='relic' && r.owner==='player'
    && ((r.id==='GROUNDED_RUNE' && modeled.grounded) || (r.id==='FLYING_KICK_RUNE' && modeled.flyingKick))));
}

export function includeHextechRules(request) {
  const state=request.state?.state ?? {};
  if(state.state_type==='hextech_rune') {
    request.state.hextech_reroll_review={
      golden_upgrade:state.hextech_rune?.golden_reroll,
      remaining_screen_budget:state.hextech_rune?.reroll_budget_remaining,
      pending_enemy_hexes:state.hextech_rune?.pending_enemy_hexes??[],
      rule:'Compare taking the best offered player rune with rerolling a weaker slot, preserving good alternatives. Compare keeping pending enemy hexes with rerolling especially harmful effects. Rerolls replace one slot with an unknown result; never assume a specific replacement. Respect per-slot remaining uses, the shared golden upgrade and screen budget. Previously active enemy rules are history/context; pending choices determine what is committed by this selection.'
    };
    for(const question of Object.values(request.questions??{}))
      question.instructions+=' Compare available Hextech rerolls with selecting or confirming now, using `hextech_reroll_review` and each offered action’s remaining uses and cost. Reroll only when the uncertain replacement is worth giving up that current option.';
  }
  const runes = runeRules(state).map(({id,name,description,counter,amount,strength_tier,owner,kind}) => ({id,name,rule:description,counter,amount,strength_tier,owner,kind}));
  if (!runes.length) return request;
  request.state.hextech_runes = {
    source: 'Equipped rune and power rules from the live game', runes,
    proc_tracking: 'Displayed counters and observed actions are supplied. Unexposed enemy used/remaining proc counters are unknown; do not assume they are unused.',
    strength_tiers: 'Enemy strength_tier is 1, 2 or 3. When a description lists three slash-separated values, use the first, second or third respectively. Already modified live card and intent values must not be multiplied again.',
    forecast_mode: unsupportedRuneRules(state).length ? 'Live legal actions only; unsupported rune arithmetic is not treated as a numeric forecast' : 'Known rune arithmetic with explicit limitations',
    checks: [
      'Apply rune triggers and timing to each candidate, including execution thresholds, healing, block multiplication, energy, exhaust and card-play limits when stated.',
      'For rewards, upgrades and purchases, compare synergy with the equipped runes and current deck. Do not assume future runes.',
      'Read enemy powers for opposing rune effects. Rune descriptions override estimates that omit them. Do not apply an effect twice when live card values already include it.',
      'An unmodeled rune is still active. Use its supplied rules; numeric forecasts that omit it cannot establish the complete outcome.'
    ]
  };
  for (const question of Object.values(request.questions ?? {}))
    question.instructions += ' Account for the equipped Hextech rune rules in `hextech_runes` when making this judgment; check their triggers and timing against the candidate and the current deck.';
  return request;
}
