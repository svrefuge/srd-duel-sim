# PC benchmark blocks

The twelve SRD 5.2.1 classes at levels 1, 5, 11 and 17 (48 blocks), written as stat blocks so they can
duel the SRD monsters. They are not part of the corpus: nothing here is read by `npm run compile`, the
sweep or the rankings, and outputs go to `out/pc-pilot/`. Nothing in `src/` or `data/` is changed.

| File | What it is |
|---|---|
| `classes.mjs` | The source: one builder per class, giving a bestiary-format record and an optional post-compile patch |
| `blocks.json` | The 48 records, written out by the compile for reading. Generated; edit `classes.mjs` |
| `compile.mjs` | `node pc-pilot/compile.mjs [--routines]` compiles, patches, prints options and the skip log |
| `fight.mjs` | `ladder [--iters N] [--scenario S] [--only "Fighter"] [--full]` runs every block against every SRD monster; `one "<pc>" "<monster>"` traces a fight. `"Fighter"` is every fighter, `"Fighter 1"` is level 1 only |
| `markdown.mjs` | `node pc-pilot/markdown.mjs` writes `statblocks/<class>.md`: the 48 blocks as readable stat blocks, four levels a file, each with the builder's `notes` on what its patch and numbers do and its `max120` CR from the last ladder CSV. Generated; rerun after changing `classes.mjs` or running a full `max120` ladder |
| `check.mjs` | `node pc-pilot/check.mjs` asserts the compiled fields behind mistakes already made once (smite dice, slot pools, Focus Points) |

## Working on this

**What it is for.** Answering "which monster CR does a level N single-class character duel like?" The blocks
are a side experiment. They are not corpus blocks, and no result here feeds the monster rankings.

**Ground rules.**

- Change `classes.mjs` only; `src/` and `data/` are not edited for this work. Where the compiler or engine gets
  something wrong, work around it in a patch and record it under "Hacks, by kind".
- `blocks.json`, `statblocks/` and everything in `out/pc-pilot/` are generated. Edit `classes.mjs` and regenerate.
- Run `npm run compile` first: `fight.mjs` fights against the compiled corpus in `out/statblocks.json`.
- A full `ladder` at 60 fights a monster takes several minutes a scenario. It overwrites
  `out/pc-pilot/ladder-<scenario>.csv`; a run with `--only` leaves that file holding only the filtered blocks,
  so finish with a full run in each scenario you touched.

**How a class is built.** Each builder in `classes.mjs` returns `{ raw, patch }` for one level index
(0 to 3 for levels 1, 5, 11, 17).

1. `raw` is a bestiary-format record. Write the feature in the wording the SRD parser already reads (the
   helpers `melee`, `ranged`, `save`, `heal`, `casting` produce it). This is the first choice.
2. `patch(compiled)` runs after `compileMonster` and sets engine fields that no stat-block wording reaches.
   Use it only when step 1 cannot express the feature. The fields are in `src/types.ts`.
3. If neither works, bake the feature into a number (AC, a save bonus, a damage bonus) or leave it out.

Whichever you choose, record it under the matching heading below ("Hacks, by kind" or "Not modelled").

**Checking a change.**

1. `node pc-pilot/compile.mjs --routines` and read the block's options, uses, slot pools and routines. A
   `SKIP` line means the parser dropped an action. An unrecognised trait is dropped with no line at all, so
   check that the feature shows up as an option, a reaction or a field. Then `node pc-pilot/check.mjs`, and
   add an assertion there for the field the change sets.
2. `node pc-pilot/fight.mjs one "Paladin 11" "Vampire" --seed 1` and confirm in the trace that the feature fires.
3. `node pc-pilot/fight.mjs ladder --iters 40 --only "Paladin"` for a quick before-and-after.
4. A full `ladder --iters 60` in `max30` and `max120`, then update the results table below.

**Traps already met.**

- A limited-use action the parser cannot classify is skipped (a printed "Action Surge (1/Day)" was). Build it
  as a routine over a limited copy of an ordinary option, as the fighter does.
- A printed action with the same name as a listed spell takes that spell's slot pool, but only at action
  timing. Bonus-action spells keep the list version.
- A printed action for a spell the compiler does not support compiles as at will. Give it a pool with `pool()`.
- A patch that finds a damage clause by position breaks when another level prints one clause more or fewer
  (the level 5 smite did). Find it by what it is, and assert it in `check.mjs`.
- A local named like a helper hides it (`pool` did in the paladin).
- The engine charges a limited option once per swing in a routine, so a routine of four swings needs four uses.

## Build conventions

- SRD 5.2.1 rules and the SRD subclass: Berserker, Lore, Life, Land, Champion, Open Hand, Devotion, Hunter,
  Thief, Draconic, Fiend, Evoker.
- Standard array with +2/+1 from background. Primary ability 17, 18, 20, 20 at the four levels; Constitution
  15, 16, 16, 18 (Fighter and Rogue 15, 16, 18, 20). Monk and Paladin raise a second ability (Wisdom,
  Charisma) to 15, 16, 16, 20 and keep Constitution 13. Ability Score Improvements only, no other feats.
- No species traits, no origin feat, no magic items. Starting armor at level 1, the best mundane armor after.
  The druid takes the Warden order for medium armor (half plate and a shield, AC 18); the cleric's half plate
  needs no order.
- Subclass features start at level 5, the first benchmark level after the subclass is chosen.
- The level 1 paladin prepares Bless and Divine Smite but spends both slots on smites (Bless never beats a smite in
  a duel); Lay on Hands is its healing.
- Hit points are the fixed PC values. `cr` is set to the level so the proficiency bonus matches; it is a label.
- Full resources: every slot and use is available in the one fight.
- Spells that last hours are taken as already cast: Mage Armor (Wizard, Warlock), Aid (Cleric from 5), Hex
  (Warlock), Hunter's Mark (Ranger), Fiendish Vigor (Warlock from 5), Foresight (Wizard 17). Each costs its
  slot where it has one, so the level 17 wizard has no Meteor Swarm. `PILOT_FORESIGHT=0` swaps that back;
  the two score about the same.

## Hacks, by kind

**Patched after compile** (the engine has the field; no stat-block wording sets it):

- Sneak Attack is once a turn (`oncePerTurn` on the Advantage-gated clause).
- Vex lasts to the end of the rogue's next turn (the Shortsword and Shortbow self-rider).
- Reckless Attack (Barbarian 5+), Innate Sorcery (Sorcerer) and Precise Hunter (Ranger 17) set `attackAdvantage`.
- Frenzy and Colossus Slayer are once-a-turn damage clauses; Colossus Slayer needs a target missing Hit Points.
- Potent Cantrip is `missDamageFactor` 0.5 on the wizard's attack cantrips.
- Heal draws on the level 6 slots.
- Foresight sets `attackAdvantage`, `saveAdvantageUnlessIncapacitated` and `attacksAgainstDisadvantage`.
- Divine Smite gets a copy for each lower slot level, with its own uses and routines, and 1d8 more against a
  Fiend or an Undead (`targetTypes` on a clause). At level 1 it is one entry on the level 1 slot pool.
- Action Surge is a routine of the ordinary swings followed by as many swings of a limited Maul copy, one use
  a swing (2, 3, and 6 for the two surges at 17). All of it lands in one turn. Maul only, not the Javelin.
- Thief's Reflexes (Rogue 17) is a 1/Day routine of both turns' attacks in one, built the same way. The second
  turn's Shortsword copy carries its own Sneak Attack, since every once-a-turn damage clause shares one flag a turn.
- Relentless Rage (Barbarian 11, 17) is `mythicResetHp`: one reset to 39 or 81 Hit Points, the expected total of
  the printed repeated saves (DC 10, +5 a use, to twice the level), replacing `undeadFortitude`. Not tied to raging.
- Heightened Focus (Monk 11, 17): the Flurry of Blows copy carries one more strike as a `followUp`, which the
  engine makes only after a hit.
- Quivering Palm (Monk 17) is also a routine of two Unarmed Strikes and the palm, replacing one strike.
- Nature's Veil (Ranger 17) is a Bonus Action self-buff: Invisible to the end of its next turn, 1/Day.
- Feral Instinct and Remarkable Athlete (Advantage on Initiative) are +3 to `initiativeBonus`; Danger Sense
  (Advantage on Dexterity saves) is +4 to the Dexterity save.

**Written as a different feature the parser reads:**

- Indomitable: Legendary Resistance, 1/Day at 11 and 3/Day at 17.
- Divine Smite: an attack entry that replaces one Longsword swing, one for each slot level. A miss still
  spends the use, so each level has slots x 1.25 uses, rounded (the paladin hits about four times in five with
  Sacred Weapon). Level 1 has its own 3 uses for its 2 slots (a 65% hit rate). No holding a smite for a
  critical hit. At 11 and 17 the uses never run out, so the binding limit is the rate: about 0.8 smites a turn
  against a printed 0.96 (smite whenever either swing hits). It leans low.
- Steady Aim: a Bonus Action "Advantage on the next attack roll it makes this turn", which compiles to the
  engine's aiming buff. The engine does not check that the rogue has not moved.
- Intimidating Presence: Frightened for 1 minute with a repeat save at the end of each of its turns, 6/Day at 17
  (one free use, then a spare Rage use restores it).
- Stunning Strike: an attack entry that replaces one Unarmed Strike. Focus Points are split, half to it and
  half to Flurry of Blows, after Quivering Palm's 8 at level 17.
- Mystic Arcanum: Circle of Death is the level 6 spell (Eyebite has no model). In a duel the warlock rarely
  casts it, since three or four beams of Eldritch Blast are worth more against one target.
- Flurry of Blows: a Bonus Action copy of a strike carrying Open Hand's Topple. It adds one strike at every
  level (two are printed from level 10).
- Superior Hunter's Defense: halves one attack's damage, as Uncanny Dodge.
- Deflect Attacks: reduces one hit's damage to 0 (`damageNegation`). The printed reduction (1d10 + Dexterity +
  monk level: 14.5, 21.5, 27.5) covers about a whole hit from the monsters these monks duel (median hit 15, 16.5
  and 28 at CR 4, 6 and 9). The engine also lets it cancel a spell or breath packet, which the print does not
  before Deflect Energy at 13. An attack-only flat reduction would need an engine field.
- Cutting Words: a limited Parry worth the mean of the die.
- Quickened Spell: a Bonus Action Fire Bolt, one use per 2 Sorcery Points.
- Hurl Through Hell: a 1/Day Bonus Action save, not tied to a hit.
- Empowered Evocation, Elemental Affinity, Potent Spellcasting, Disciple of Life, Supreme Healing: the spells
  are printed as actions with the bonus in the dice, and keep their slot pools.
- Overchannel: a 1/Day Cone of Cold at maximum damage, with one level 5 slot removed.

**Baked into the numbers:**

- Reckless Attack lowers the barbarian's AC by 4, for the Advantage it gives the foe.
- Sacred Weapon adds Charisma to the paladin's attack rolls from 5; Aura of Protection adds it to every save from 11.
- Innate Sorcery adds 1 to the sorcerer's save DC. Dragon Wings is a 60 ft Fly Speed at 17.
- Great Weapon Fighting is +1 damage on the fighter's Maul from 11.
- Heroic Warrior is +3 to hit on the fighter's attacks from 11: a reroll each turn, spent on the first miss,
  adds about 0.46 hits a turn with three swings. Superior Critical is +1 Maul damage at 17 (the engine scores a
  critical only on a 20).
- Improved Brutal Strike is +5 on the barbarian's Frenzy clause at 17: its 2d10 less the Advantage given up on
  that swing. At 11 the trade is worth about nothing, so Brutal Strike is left out there.

## Not modelled

Improved Critical, Studied Attacks, Brutal Strike at 11, Hide, Cunning Strike, Indomitable's reroll (it is an
automatic success), Bardic Inspiration on the bard's own rolls, Channel Divinity other than Divine
Spark, Wild Shape, Land's Aid, Metamagic other than Quickened, Dark One's Own Luck, Fiendish Resilience,
Patient Defense, Step of the Wind, Multiattack Defense, Find Steed, the paladin's spells other
than Divine Smite from level 5, the wizard's control spells (Wall of Force, Forcecage, Polymorph, Maze),
Contingency, Simulacrum, upcasting beyond the listed versions,
and the spells the skip log names (Eyebite, Sleet Storm, Wall of Thorns' later damage).

Several of these lean one way. The sorcerer has Advantage on every attack for the whole fight and flies at
17 at no cost, so it reads high. The ranger's Hunter's Mark never drops to a failed Concentration save, so it
reads a little high. The monk's Deflect Attacks also cancels spells and breath, and the rogue's Steady Aim
ignores movement, so both read a little high; the paladin's smite rate reads a little low.

## Results

Monster CR at which the block's mean score (win 1, draw 0.5) first drops below one half and stays below at
the next CR, shown as `max30` / `max120`. 60 fights a monster, seed 1; rerun with
`node pc-pilot/fight.mjs ladder --iters 60 --scenario max30` and the same with `--scenario max120`.

| Class | L1 | L5 | L11 | L17 |
|---|---|---|---|---|
| Barbarian | 1 / 1 | 5 / 5 | 9 / 9 | 13 / 13 |
| Bard | 1/2 / 1/2 | 2 / 3 | 6 / 6 | 11 / 11 |
| Cleric | 1/2 / 1 | 4 / 4 | 6 / 6 | 9 / 9 |
| Druid | 1/2 / 1/2 | 4 / 4 | 7 / 7 | 9 / 9 |
| Fighter | 1 / 1 | 5 / 5 | 9 / 9 | 13 / 13 |
| Monk | 1/2 / 1/2 | 5 / 6 | 8 / 8 | 11 / 13 |
| Paladin | 2 / 2 | 5 / 5 | 9 / 7 | 11 / 9 |
| Ranger | 1 / 1 | 4 / 4 | 6 / 6 | 11 / 11 |
| Rogue | 1 / 1 | 4 / 4 | 7 / 7 | 11 / 11 |
| Sorcerer | 1/2 / 1 | 6 / 6 | 11 / 11 | 13 / 17 |
| Warlock | 1/4 / 1/2 | 3 / 4 | 6 / 7 | 12 / 12 |
| Wizard | 1/4 / 1/2 | 4 / 4 | 8 / 9 | 13 / 13 |

Read these as rough: a change of one CR is within what a build choice moves. The paladin falls at 120 feet because it
closes under fire; the other martials hold level. The monk rises at 5 and 17, probably on its speed and Deflect
Attacks (not traced), and the sorcerer rises because it flies and has a Bonus Action Fire Bolt.

Above CR 11 a CR holds one to seven monsters (two at CR 12), so the crossing is noisy there. The ladder also
prints "holds", the highest CR at one half or more; it is one CR under "falls" for every block except
Sorcerer 17 (`max30` falls at 13 and holds at 15), whose value is the least certain in the table.

## Open work

- Full resources in one fight flatters casters. A budgeted variant (about a third of a day's slots and uses)
  has not been built.
- The wizard is a blaster only. Its control spells need engine support, so it reads low against the sorcerer.
- The "Not modelled" list above. Champion critical range and Brutal Strike are the likeliest to matter.
