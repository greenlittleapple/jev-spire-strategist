# STS2 strategist brief (policy `claude-strategy-v3`)

This is for the Claude agent that answers strategy requests while the Slay the Spire 2 runner plays in "Jev + strategist" mode. It is self-contained: you need only this file and the requests. The instructions that `show` prints with every request are the authoritative version of the rules. This file explains them and adds how code applies each field; if the two ever disagree, follow `show` and report the difference.

## What you are doing

An automated player runs a Slay the Spire 2 run (Ironclad, Ascension 0, with the operator's gameplay mods, including Hextech Runes). Jev, a fast model, picks each action. Code sits between Jev and the game:

- In combat, code applies fixed rules (listed under [Combat rules](#combat-rules)), then your fight plan and combat limits, and Jev chooses among what is left.
- On run-shaping screens outside combat (card rewards, shops, events, rest sites, treasure, Hextech runes, card selections, bundle and relic selections, the crystal sphere, the Fake Merchant, and reward screens that offer a potion when every slot is full) you decide outright: your ordered `allowed_option_ids` are taken directly, with no Jev call.
- On the map, your `route_path` limits Jev to the next node on your path.

You are asked for a plan at the start of the run and again on the triggers below. Every answer is a complete plan: all fields, every time. The game waits for each answer, with no timeout, so a slow answer costs only time; nothing is played while a request is open. The logged strategist runs up to 2026-09-29 made about 1,170 requests across 27 run starts (about 43 per start), a little over half of them owned screens; a run that reaches Act 2 or 3 makes more. Keep each answer quick and concrete.

## The loop

Run these from the root of the main checkout that the runner uses (the CLI reads the channel folder `.private/sts2/strategy` next to its own script, so a copy of the repository elsewhere has a different channel). `-s` keeps npm's own lines out of the output.

```
npm run -s sts2:strategy -- wait
npm run -s sts2:strategy -- show
npm run -s sts2:strategy -- answer <request-id> <plan-file>
```

1. `wait` polls once a second until an unanswered request exists and prints `Strategy request <id> (<reason>, act <n> floor <m>)`. It can block for a long time (Jev is playing combat, or the run is paused); if your tool call times out, run `wait` again. If it returns at once while no run is going, the request is left over from an earlier session: check `createdAt` in `show` and tell the parent instead of answering it.
2. `show` prints one JSON object: `id`, `createdAt`, `instructions`, `schema` and `brief`. Read the instructions and the brief. `No strategy request is pending.` means the request was answered or consumed; go back to `wait`.
3. Write the plan as JSON to a file in the git-ignored `.private/sts2/` folder (for example `.private/sts2/plan.json`; overwrite it each time), then `answer` with the request's ID. `-` in place of the file reads the plan from standard input.
4. Go back to `wait`.

What `answer` prints and what to do:

| Output | Cause | What to do |
|---|---|---|
| `Delivered plan for <id>.` | Accepted | Back to `wait` |
| Lines such as `plan.combat.potion_reserve is required`, `plan.combat.focus_enemy is not allowed`, `plan.replan_below_hp_percent must be 10-60`, exit status 1 | Schema or range error | Fix those fields and answer again |
| `allowed_option_ids: a7 is not an option on this screen` | An ID that is not in `brief.current_options` (every ID fails in combat, where the list must be `[]`) | Use only IDs from `current_options`, and answer again |
| `route_path: 4,9 is not a node on this act's map` | A node that is not on the current act's map | Copy node IDs from `brief.routes`, and answer again |
| `Request <id> was replaced by <new id>; read it with "show" and answer that one.`, exit status 1 | The runner posted a newer request (after a pause and resume, or a restart) | Run `show` and answer the new request; the old one needs no answer |
| `No strategy request is pending.`, exit status 1 | Nothing to answer (already answered or consumed) | Back to `wait` |
| `<file> is not valid JSON: <parser message>` (`Standard input` for `-`), exit status 1 | The plan is not valid JSON | Fix the JSON and answer again |
| `Cannot read <file>: ENOENT`, exit status 1 | The plan file does not exist at that path | Check the path and answer again |

Running this loop doesn't authorize starting Autoplay, the runner or a new run.

## Request reasons

The reason is in `wait`'s output and in `brief.trigger`. They are checked before Jev on every decision that is not forced; the first that applies is asked.

| Reason | When | What the answer needs |
|---|---|---|
| `run_start` | No plan for this run yet (usually the opening Neow event) | The whole plan from the starting deck and relic, plus `allowed_option_ids` for the screen if `current_options` are shown |
| `new_act` | The first decision in a new act | Rewrite the run plan for the act; `route_path` `[]` until the act's `route_plan` request |
| `elite_start`, `boss_start` | Round 1 of every elite and boss fight | A `fight` plan for this encounter; `allowed_option_ids` `[]` |
| `new_encounter` | A normal fight whose encounter has no saved fight plan (once per fight) | A `fight` plan |
| `review_encounter` | The saved plan for this encounter did badly since it was written: a loss, or on average a quarter of max HP lost (once per fight) | A better `fight` plan; `brief.encounter_results` shows how it went |
| `death_countdown` | An enemy shows a power that counts down to your death (once per fight) | A `fight` plan built around pushing it back, for the rest of this fight (not saved) |
| `unknown_mechanic` | The forecast does not model a power, relic or card in this fight and no note exists yet. Each name asks at most once per fight, and one that first appears later in the fight still asks. A power named after one of your own cards or potions (Shackling Potion's Strength loss on an enemy, The Bomb as a player power) counts as that item: known when the item is modelled or has a note, otherwise asked once as the card | `mechanics`: one `{name, note}` per item in `brief.unknown_mechanics` |
| `low_hp` | HP fell below your `replan_below_hp_percent` | A plan for the new situation; in a fight, a non-empty `fight` plan applies to the rest of this fight and is not saved |
| `owned_screen` | Arrival at an owned screen with more than one option, or none of your listed IDs is still offered there (a new event page, a used-up shop list) | `allowed_option_ids` for this screen, in order |
| `route_plan` | The first map screen of each act; the brief lists routes, each with its `elite_chains` (floors of two elites with no rest site between them) | `route_path` from one listed route, `route` and `elite_min_hp_percent` |
| `route_off` | No offered map node is on your `route_path` | A new `route_path` from the listed routes |
| `route_risk` | At a map screen with two or more options: HP is below `elite_min_hp_percent` and the next node on your path is an elite, or leads through more elites than another offered node must; or HP is below `elite_min_hp_percent` + 26 and the next node commits your path to an elite chain (no path from it to the second elite passes a rest site after the first). `brief.route_risk` says which, with the chain's floors | Keep the route by lowering `elite_min_hp_percent` (below HP minus 26 for a chain), or choose a route that avoids the elite or the chain |
| `new_relic` | The first screen outside combat after any new relic or rune | Update the plan for what the relic changes |
| `jev_uncertain` | Jev answered below the confidence threshold on a card reward, shop, rune or rest site (in practice only when owned screens are off, or in advisory mode) | `allowed_option_ids` for the screen |
| `rich_shop` | A shop entered with 150 or more gold (only when owned screens are off) | Shop decisions |

Only one request is open at a time, and play waits for it. The runner reuses an open request while the situation is the same; a different situation after a pause or restart replaces it, and `answer` then reports the replacement.

## The brief

Fields present depend on the screen:

- `trigger`: the request reason.
- `run`: `live_id`, act, floor, ascension, character. `screen`: the current screen type (`event`, `shop`, `map`, `elite`, `card_select`...).
- `player`: HP, max HP, gold, max energy, potions with descriptions, potion slots.
- `deck`: cards with cost, type, description and `count`. `relics`: with description and counter. `active_rune_rules`: Hextech runes and similar mod rules in force.
- `history`: per act, rooms, combat turns, damage taken, HP healed, gold spent; and the recent rooms.
- `current_options` (outside combat): `{id, label, description}`; card options on rewards, shops and card selections may carry `past_runs` from earlier logged runs (times offered and picked, plays per fight after picking, floor those runs reached). Treat it as a rough signal. `keywords` (every screen): definitions of keywords in the options and in deck and hand card text, from the bridge; a definition that only repeats its name ("Tainted: Gain 2 Tainted when played.") is replaced by the text of a power with that name (on you or an enemy now, or seen earlier this session) or by your saved `mechanics` note for it. `glossary`: descriptions of cards and relics that options name without explaining.
- `event`: the event's name and page text, which often explains what its options really do.
- `routes` (map screens, first of the act): `from` (current node), `legend` (`M` monster, `E` elite, `R` rest, `$` shop, `T` treasure, `?` unknown, `A` ancient, `B` boss) and `routes`: distinct room sequences, each with its node IDs (`"col,row"`) in order and, when it has any, `elite_chains`: `[first, second]` floors of two elites with no rest site between them. `truncated` says the list is a sample. Node IDs give map rows, not floors: floor = row + `floor_offset`. In Act 1 Neow is floor 1 on row 0, so row 8 is floor 9; later acts have larger offsets (Act 2 starts at floor 18 on row 0).
- `route_risk` (trigger `route_risk`): `kind` (`elite` or `elite_chain`), HP and `elite_min_hp_percent`, the offered node(s) on your path with their floors, and for a chain `elite_chain` (`floors`, `nodes`, `rooms_between`) and `needs_hp_percent`.
- `facts`: exact counts. On the map, `route_options` per offered node: paths to the boss and the min-max elites, `rests_before_boss_rest` (rest sites excluding the one every act has right before its boss), shops, distances to the next rest and elite, and example routes; the `route_note` explains each count. Elsewhere, `route_ahead` from the current node; `rest` (missing HP, the heal, the heal wasted) at rest sites; `potions` held against floors to the boss; `gold` against shops still reachable this act; `death_effects` (damage enemies deal when killed, such as Steam Eruption, against current HP).
- In combat: `combat_state` (round, energy, block, your powers, hand, pile counts, and `draw_cards` when 10 or fewer cards are left to draw), `enemies` (HP, block, powers with text, intents, and `seen_pattern`: the intents each enemy showed round by round in recent fights), `encounter` (the playbook key, such as `Bowlbug x3`), `saved_fight_plan` or `similar_fight_plan` (without `play_first` when saved in another run; its text may name cards this deck lacks), `current_fight_plan` (a plan given by a consult earlier in this fight), and `encounter_results` (fights, wins, average HP lost, the last three with `after_plan` marking fights played with the saved plan).
- `unknown_mechanics` (trigger `unknown_mechanic`): `{name, kind, text}`.
- `previous_plan`: your last plan in this run (not `fight` or `allowed_option_ids`). Plans from other runs are never shown.

## The plan

Every field is required except `mechanics` and `fight.play_first`. Unknown fields are refused. A complete run-start plan:

<!-- example: run_start -->
```json
{
 "archetype": "Ironclad Strength and block: add front-loaded damage for the Act 1 fights, then a scaling engine, and remove Strikes at shops.",
 "summary": "Take Scroll Boxes for an early card pack, add damage from rewards, take one or two Act 1 elites while HP allows and enter the boss near full HP.",
 "priorities": [
  "Add damage for Act 1 fights",
  "Add a scaling engine (Strength, Juggernaut or Barricade)",
  "Remove Strikes and Defends at shops",
  "Enter the Act 1 boss near full HP"
 ],
 "combat": {
  "risk_tolerance": "medium",
  "potion_policy": "Potions in elites, bosses, or below 40% HP; never drink a heal near full HP.",
  "focus": "Kill attackers first; block big hits; spend spare energy on damage.",
  "hallway_potion_below_hp_percent": 40,
  "potion_reserve": 0
 },
 "card_reward": {
  "desired": ["front-loaded damage", "area damage", "Strength scaling", "efficient block"],
  "avoid": ["curses", "cards that need a combo the deck lacks"],
  "skip_when": "Only when every offered card hurts the deck; in Act 1 take the best damage card."
 },
 "shop": {"gold_reserve": 0, "priorities": ["Remove a Strike", "strong damage or area card", "relic"]},
 "route": "Monsters and unknowns for cards, one or two elites while HP allows, a shop with 150 gold or more, rest before the boss.",
 "route_path": [],
 "elite_min_hp_percent": 60,
 "rest": "Heal below 60% HP, otherwise upgrade; rest at the last site before a boss unless most of the heal is wasted.",
 "replan_below_hp_percent": 25,
 "fight": {"plan": "", "target_priority": []},
 "allowed_option_ids": ["a0"],
 "option_note": "Scroll Boxes adds a card pack now; New Leaf transforms one card, Neow's Bones adds a curse."
}
```

That request was the Neow event with three options: `a0` Scroll Boxes (choose 1 of 2 card packs), `a1` New Leaf (transform 1 card), `a2` Neow's Bones (2 random Neow relics and a random curse).

### Fields and how code uses them

The runner runs in constrained mode by default (`CLAUDE_PLAN_MODE=constrained`); in advisory mode nothing is removed and your choices only reach Jev as recommendations. Every constraint keeps at least one option.

| Field | Meaning | How code uses it |
|---|---|---|
| `archetype` | The deck's direction in one sentence: what it builds toward and how it wins. Rewrite it in every answer as the deck changes | The dashboard shows it as the current plan, so a bare tag such as "strength block" is not enough. Jev sees it with every decision |
| `summary` | The run plan in one or two sentences: what the deck still needs, which fights and rooms to take, how to reach the boss. Rewrite it in every answer | Jev sees it with every decision, so it is not a log of screens ("JEV20 f2 reward: Shrug It Off." belongs in `option_note`, if anywhere) |
| `priorities` | At most 5, most important first | Shown to Jev |
| `combat.risk_tolerance` | `low`, `medium` or `high` | Shown to Jev |
| `combat.potion_policy`, `combat.focus` | Run-level potion use and general combat focus (a single fight goes in `fight`) | Shown to Jev |
| `combat.hallway_potion_below_hp_percent` | 0-100 | Enforced in normal fights (not elites or bosses): while HP is at or above it, potion plays are removed, unless every play without one is forecast to die, or a potion line is forecast to save at least max(10, 12% of max HP) more HP this turn when the best line without one would take HP under the value. Below it, a potion that saves no HP this turn is removed (healing potions and potions whose effect the forecast cannot see are exempt). 100 means no limit, 0 means never in hallways |
| `combat.potion_reserve` | 0-5 | Enforced outside boss fights: potion plays that would leave fewer potions than this are removed, unless every other option is forecast to die. It yields while HP is under `hallway_potion_below_hp_percent` (when that is below 100). Set it (usually 1) when the boss is near and potions matter there, 0 otherwise |
| `fight.plan` | This encounter's plan: targeting, what to avoid, when to block, potion use | On fight-start triggers (`new_encounter`, `review_encounter`, `elite_start`, `boss_start`), saved to the playbook under the encounter key and reused whenever the same enemies appear, in this run and later runs; shown to Jev only in that encounter. A saved plan may come from another run and name cards this deck lacks; rewrite it for this deck. On triggers during a fight (`low_hp`, `unknown_mechanic`, `death_countdown`), a non-empty plan replaces the plan for the rest of this fight only and is not saved; `""` keeps the current plan |
| `fight.target_priority` | Enemy names, or the selectors `lowest_hp` (HP plus block), `biggest_attack` (largest shown attack), `can_kill` (an enemy a forecast play kills), most important first; `[]` for none | Enforced while two or more enemies are alive: the first entry that matches a living enemy is the focus, and single-target plays or potions aimed at anyone else are removed unless they kill their target. Area attacks are unaffected. A name matches every living enemy whose name contains it (case ignored), so `"Bowlbug"` focuses all Bowlbugs. Use a priority only when you are sure |
| `fight.play_first` | Optional card names | Enforced: while a listed card is affordable in hand, other card plays and ending the turn are removed (potions stay). It yields when the best forced line loses at least max(10, 12% of max HP) more than the best surviving line (unless a death countdown is shown), or when no forced line is known to survive and another is. A trailing `+` is ignored. Saved with a fight-start plan for this run only: a later run keeps that plan's text and `target_priority` but not `play_first`, since the cards came from another deck |
| `mechanics` | Optional `[{name, note}]`, for `unknown_mechanic` | Each note is saved across runs and shown to Jev whenever that item is present. Items asked about but not answered are saved as "No special handling noted." so they do not ask again |
| `card_reward.desired`, `avoid`, `skip_when` | Kinds of cards the deck needs, what to avoid, when to skip | Shown to Jev outside combat. With owned screens on, you pick card rewards yourself through `allowed_option_ids` |
| `shop.gold_reserve` | Gold to keep for a concrete later need; 0 if none | Purchases that would take gold below it are removed from Jev's options. Your own `allowed_option_ids` list is taken first on owned shop screens, so with owned screens on it limits Jev only if you are not deciding the screen |
| `shop.priorities` | What to buy, in order | Shown to Jev |
| `route` | Route policy in words for the rest of the act | Shown to Jev; used when the planned path cannot be followed |
| `route_path` | Node IDs `"col,row"` in order, copied from one listed route (you may stop before the boss); `[]` leaves routing to Jev | The CLI checks each node is on the act's map. On map screens of the act whose routes you were shown, Jev's options are limited to the next node on the path, so a single one moves without a Jev call. No offered node on the path asks again (`route_off`) |
| `elite_min_hp_percent` | 0-100 | If HP is below it when the next node on `route_path` is an elite, or leads through more elites than another offered node must, you are asked again (`route_risk`). At a branch that commits the path to an elite chain, you are asked below this value + 26 (one elite fight's HP). Only at map screens with two or more options: a single option moves without a request. 0 turns it off. To keep such a route, lower the value in that answer |
| `rest` | Heal versus upgrade policy | Shown to Jev. You decide rest sites yourself; code also removes resting when at least half the heal would be wasted and Smith is offered, unless your list says otherwise |
| `replan_below_hp_percent` | 10-60 (25 is typical) | You are asked again (`low_hp`) when HP falls below it |
| `allowed_option_ids` | Option IDs from `current_options`, in the order to take them; `[]` in combat or when no options are shown | Applies to the screen of this request only. The first ID still offered is taken directly each time the screen asks for a choice, so a shop list of purchases ending with leaving buys them in order, skipping any no longer offered. Options are matched by action and label (and an event option's description), so a changed label or price counts as a different option. A reward claim that an earlier claim moved up the list still matches by reward type and label, unless two identical rewards are offered. When none of your IDs is offered, you are asked again. Your list takes precedence over the rest-waste and exhaust rules |
| `option_note` | One sentence on the current screen, or `""` | Shown to Jev on this screen |

When a choice opens another choice (a shop removal opens "Choose a card to Remove.", Smith opens "Choose a card to Upgrade."), that card selection is its own `owned_screen` request.

A reward screen is owned when it offers a potion and every potion slot is full. Its options are the other rewards' claims and one "Discard X (slot N) to make room for Y" per held potion; the offered potion's own claim is not listed while the belt is full, and "Continue to the map" is offered only once nothing else is left to claim. You are asked again on this screen until that proceed option is chosen: when it is offered, end your list with it; when it is not, expect one more request after your claims are taken (JEV21 f22 listed the gold and the card and was asked again for the rest). A potion swap takes two steps, the discard and then the claim. List the discard where the swap should happen; after it the slot is free, the screen is no longer owned, and the potion's claim is offered like any other option (your list still limits the choice if it names another reward still offered).

### Combat rules

Code applies these in combat before Jev chooses, in constrained mode. You don't configure them, but your fight plan should not fight them:

The names in parentheses are the rule names the logs and the instructions use.

- Take a play forecast to win the fight when one is fully forecast, with as few potions as possible (`take_lethal`).
- Remove plays forecast to be fatal when another play is forecast to survive (`avoid_fatal`).
- Remove healing potions that would heal more than the HP missing, unless every line without one is forecast to die (`heal_potion_waste`).
- The potion limits from `combat` (`hallway_potion`, `potion_reserve`; see the field table). In normal fights below `hallway_potion_below_hp_percent`, remove a potion that saves no HP this turn, except healing potions and potions whose effect the forecast cannot see (`idle_potion`).
- Remove ending the turn while an affordable card that costs HP when held (Beckon) is in hand, and plays that leave too little energy for it (`play_hp_loss_cards`).
- While every enemy is Intangible, keep only the plays that lose the least HP (`intangible_defense`).
- When an enemy shows a death countdown ("In N turns, you will be eaten and die") at 3 or less, force an affordable card that names it ("Increase Sandpit by 1") (`countdown_escape`). It yields when no escape is forecast to survive and another line is, unless the countdown is at 1.
- Remove pure block cards when ending the turn would lose no HP and nothing uses block (`block_not_needed`).
- Your fight plan's `play_first` and `target_priority` (same names), as the field table describes; `play_first` yields when forcing it costs too much HP or is forecast to die.
- A single-card exhaust choice (a hand selection such as True Grit+) is limited to status, curse, exhaust-payoff or plain Strike and Defend cards when those exist.

### Rules for strings

- Use only the brief's information. Do not invent hidden information: future card offers, unrevealed rooms, enemy moves not shown.
- Use names exactly as the brief shows them: option IDs from `current_options`, node IDs from `routes`, card names from the deck or hand for `play_first`, enemy names from `enemies` or the three selectors for `target_priority`.
- Keep every string short and concrete: `archetype` and `option_note` one plain sentence each, `summary` one or two, a fight plan a few sentences. No slogans.
- A fight plan that tells Jev not to kill an enemy, or to hold back in any way, says when to stop.
- Write fight-start plans for the encounter, not for today's HP, since they are reused in later runs. A plan from a consult during a fight is for that fight only, so it can answer the current HP and hand.
- Carry fields you are not changing over from `previous_plan`; every answer replaces the whole plan.

## Lessons already in the instructions

These come from lost runs and are in the instructions `show` prints (JEV numbers are run labels):

- The archetype is a one-sentence deck direction, rewritten every answer, since the dashboard shows it as the current plan.
- The summary is the run plan in one or two sentences, rewritten every answer; a note about the current screen goes in `option_note` (the JEV20 plans had used it as a per-screen log).
- In Act 1 the deck needs damage for the boss: take the best offered card unless it hurts the deck. JEV12 and JEV14 skipped 3-4 of 7-8 Act 1 rewards and lost at the Act 1 boss.
- Weigh unspent gold against reachable shops; gold left at the boss buys nothing (JEV11 reached it with 323).
- Elites give the relics a deck needs by Act 2: take one or two while HP allows. Runs with no Act 1 elite (JEV5, 6, 9, 19) lost by the end of Act 2.
- Late Act 1 elite limit: Act 1 bosses (Waterfall Giant aside) were beaten in 9 of 9 runs entered at 87% HP or more and 0 of 4 entered at 77% or less (JEV12, 14, 16, 18), and in all four the only rest site after the last elite was the one right before the boss. `rests_before_boss_rest` leaves that rest out, so for an elite that is the next map option it counts the other rests after it (on a listed route, count the `R` rooms after the elite except the last). With 0, take an optional Act 1 elite only near full HP; with 1 or more, the elite is fine. Each of those four elites showed `rests_before_boss_rest` 0 on its map option; JEV19 skipped an elite at 80% HP whose planned route had one more rest besides the pre-boss one (1).
- Routes that committed to an elite at 33-39% HP while an elite-free path was offered lost (JEV13, JEV14); `elite_min_hp_percent` exists for this.
- Elite chains: two elites with no rest site between them take two fights' HP with no heal. 2 of 69 logged elite fights were the second of such a pair, and both runs died in it (JEV19 at 18/80; JEV22 entered its floor 9 elite at 76% and died in the floor 11 elite at 36/80, only a treasure between). The moves between JEV22's elites had one option each, so no request could come there; `route_risk` now asks at the last branch before the chain.
- Before a boss, rest unless most of the heal would be wasted (JEV11 upgraded at 66/80 and lost to the Waterfall Giant with it on 18 HP).
- A death countdown must be pushed back with the cards that name it; the fight plan should say to play them, and `play_first` can force an escape card.
- A plan that tells Jev not to kill or to hold back must state its exit condition. In JEV11 the fight plan told Jev not to kill the Waterfall Giant (its Steam Eruption would have killed the player) with no condition for when to kill it after all; Jev stalled while the eruption grew to 63 and missed a kill it would have survived. Say when to take the kill (for example "kill once block covers the eruption damage"), and check `draw_cards` for what next turn can hold.
- The instructions list the code-enforced combat rules by name, including `heal_potion_waste`, `idle_potion`, `countdown_escape` and when `play_first` yields.
- Set `potion_reserve` (usually 1) when the boss is near and potions matter there, 0 otherwise.

## More examples

The test suite (`integration/sts2/strategist-doc.test.mjs`) checks every example in this file against the schema and the CLI's answer checks, on matching requests.

A `route_plan` answer at the first map screen of Act 1 (floor 1, 80/80 HP, 99 gold). Node IDs are `"col,row"`: the player is on row 0 at floor 1, so `"1,1"` is floor 2 and the last node, `"1,15"`, is floor 16. The chosen route runs `M?M$ER?MTRE?MMR`, then the boss: the first elite has two rest sites after it besides the one right before the boss, the second elite has only that last one, so the plan asks again before the second elite unless HP is near full.

<!-- example: route_plan -->
```json
{
 "archetype": "Ironclad Strength and block: add front-loaded damage for the Act 1 fights, then a scaling engine, and remove Strikes at shops.",
 "summary": "Early monsters for cards, a shop before the first elite, a second elite only near full HP, then rest before the boss.",
 "priorities": [
  "Add damage for Act 1 fights",
  "Add a scaling engine (Strength, Juggernaut or Barricade)",
  "Remove Strikes and Defends at shops",
  "Enter the Act 1 boss near full HP"
 ],
 "combat": {
  "risk_tolerance": "medium",
  "potion_policy": "Potions in elites, bosses, or below 40% HP; never drink a heal near full HP.",
  "focus": "Kill attackers first; block big hits; spend spare energy on damage.",
  "hallway_potion_below_hp_percent": 40,
  "potion_reserve": 0
 },
 "card_reward": {
  "desired": ["front-loaded damage", "area damage", "Strength scaling", "efficient block"],
  "avoid": ["curses", "cards that need a combo the deck lacks"],
  "skip_when": "Only when every offered card hurts the deck; in Act 1 take the best damage card."
 },
 "shop": {"gold_reserve": 0, "priorities": ["Remove a Strike", "strong damage or area card", "relic"]},
 "route": "Follow the path; if it breaks, prefer monsters and unknowns, and skip an elite with one rest left before the boss unless near full HP.",
 "route_path": ["1,1", "1,2", "2,3", "2,4", "1,5", "1,6", "2,7", "2,8", "1,9", "1,10", "2,11", "2,12", "1,13", "1,14", "1,15"],
 "elite_min_hp_percent": 85,
 "rest": "Heal below 60% HP, otherwise upgrade; rest at the last site before a boss unless most of the heal is wasted.",
 "replan_below_hp_percent": 25,
 "fight": {"plan": "", "target_priority": []},
 "allowed_option_ids": [],
 "option_note": ""
}
```

`elite_min_hp_percent` 85 also applies to the first elite (floor 6); if HP is under 85% there, you are asked again and can lower it to keep that elite, which has two rests after it.

An `owned_screen` answer in the shop on that route (floor 5, 170 gold, the elite on the next floor). The options were `a0` Hemokinesis 78, `a1` Stomp 78, `a2` Red Skull 164, `a3` Remove a card 75, `a4` Fire Potion 50, `a5` Continue to the map:

<!-- example: shop -->
```json
{
 "archetype": "Ironclad Strength and block: front-loaded damage and area attacks now, a scaling engine next, with Strikes removed at shops.",
 "summary": "Remove a Strike and add Stomp for area damage before the elite on the next floor; a second elite only near full HP.",
 "priorities": [
  "Add a scaling engine (Strength, Juggernaut or Barricade)",
  "Remove Strikes and Defends at shops",
  "Enter the Act 1 boss near full HP"
 ],
 "combat": {
  "risk_tolerance": "medium",
  "potion_policy": "Potions in elites, bosses, or below 40% HP; never drink a heal near full HP.",
  "focus": "Kill attackers first; block big hits; spend spare energy on damage.",
  "hallway_potion_below_hp_percent": 40,
  "potion_reserve": 0
 },
 "card_reward": {
  "desired": ["Strength scaling", "efficient block", "card draw"],
  "avoid": ["curses", "a fourth single-target attack"],
  "skip_when": "Only when every offered card hurts the deck."
 },
 "shop": {"gold_reserve": 0, "priorities": ["Remove a Strike", "area damage", "relic"]},
 "route": "Follow the path; if it breaks, prefer monsters and unknowns, and skip an elite with one rest left before the boss unless near full HP.",
 "route_path": ["1,5", "1,6", "2,7", "2,8", "1,9", "1,10", "2,11", "2,12", "1,13", "1,14", "1,15"],
 "elite_min_hp_percent": 85,
 "rest": "Heal below 60% HP, otherwise upgrade; rest at the last site before a boss unless most of the heal is wasted.",
 "replan_below_hp_percent": 25,
 "fight": {"plan": "", "target_priority": []},
 "allowed_option_ids": ["a3", "a1", "a5"],
 "option_note": "Remove a Strike (75), buy Stomp (78) for area damage, keep 17 gold and leave; Red Skull costs more than the gold left."
}
```

The removal opens a card selection, which is its own request (answer it with the Strike's ID). Back in the shop, the list continues with Stomp, then leaving.

An `elite_start` answer in Act 2 (floor 22, 58/80 HP) against Flail Knight, Magi Knight and Spectral Knight. The Spectral Knight's Hex makes every card Ethereal while it lives; the Magi Knight's Dampen removes card upgrades while it lives:

<!-- example: elite_start -->
```json
{
 "archetype": "Ironclad Strength and block: Inflame and Demon Form scale the damage, area attacks handle groups, block cards cover the big turns.",
 "summary": "Beat the knights with Hex removed first, then heal or upgrade at the next rest and look for block scaling before the Act 2 boss.",
 "priorities": [
  "Add block scaling for the Act 2 boss",
  "Remove Strikes and Defends at shops",
  "Enter the Act 2 boss above 70% HP"
 ],
 "combat": {
  "risk_tolerance": "medium",
  "potion_policy": "Potions in elites, bosses, or below 40% HP; never drink a heal near full HP.",
  "focus": "Kill attackers first; block big hits; spend spare energy on damage.",
  "hallway_potion_below_hp_percent": 40,
  "potion_reserve": 0
 },
 "card_reward": {
  "desired": ["block scaling", "card draw", "Strength scaling"],
  "avoid": ["curses", "more single-target attacks"],
  "skip_when": "Only when every offered card hurts the deck."
 },
 "shop": {"gold_reserve": 0, "priorities": ["Remove a Strike", "block scaling card", "relic"]},
 "route": "Rest before the boss; one more elite only above 80% HP with two rests after it.",
 "route_path": [],
 "elite_min_hp_percent": 80,
 "rest": "Heal below 60% HP, otherwise upgrade; rest at the last site before a boss unless most of the heal is wasted.",
 "replan_below_hp_percent": 30,
 "fight": {
  "plan": "Kill the Spectral Knight first: while it lives every card is Ethereal, so play each turn's best cards and let the rest go. Then the Magi Knight to get upgrades back, then the Flail Knight. Area attacks hit all three. Block fully on turns where two knights attack. If HP falls under 40%, switch to killing the knight with the biggest attack.",
  "target_priority": ["Spectral Knight", "Magi Knight", "lowest_hp"]
 },
 "allowed_option_ids": [],
 "option_note": ""
}
```

`play_first` fits a card that must go before anything else in this encounter, for example `"play_first": ["Flame Barrier"]` against an elite whose round 1 is several small hits. It is left out here because no card has to lead every turn.

## How the parent session runs it

The orchestrating Claude session does not answer requests itself. For a strategist run:

1. Check Marcus's plan usage first (the 5-hour and weekly limits); a run has made about 43 requests on average, more when it goes deep.
2. Spawn a `general-medium` agent (Medium effort) whose brief is this file. It loops `wait`, `show`, `answer` from the main checkout until the run ends or the parent stops it, and reports anything it could not answer.
3. Start the runner only with Marcus's current authorization for that run. Running the strategist loop does not authorize starting Autoplay or a new run, and a strategist agent never starts, pauses or stops the runner.
4. After the run, stop the agent. A request left open when the run ends stays in `.private/sts2/strategy/request.json`; the next session's `wait` returns it at once, so check `createdAt` before answering.
