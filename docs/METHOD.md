# Method

How a duel is run, how the results are scored, and every command. For what the simulator leaves out or decides
by convention, see [LIMITATIONS.md](LIMITATIONS.md).

## The duel

The simulator runs a duel between two stat blocks under the 2024 rules. Each monster's printed entry is compiled
into a combat record, and the engine drives behaviour from those compiled fields, never from monster names. Action
selection is heuristic: each creature picks the option with the best expected value given what it can know.

A fight is one creature against one other on open, flat ground, starting 30 feet apart. A fight that reaches 100
rounds is a draw.

### Scenarios

Scenarios are selected with `--scenario max30`, `--scenario max120`, or `--scenario max600`. The name is the most
the two creatures can be apart, in feet; every scenario starts them 30 feet apart. The same cap applies upward: a
flier may rise until it is that far above the top of the other creature's body, so the highest altitude depends on
the other creature's size (in `max30`, 35 feet over a Medium creature and 50 over a Gargantuan one). The earlier
names `arena`, `arena120`, and `open` are accepted as aliases.

Movement uses a one-turn lookahead by default. Pass `--no-lookahead` to `fight`, `run`, or `analyze` to turn it off.

### What is modelled

**Core combat.** Initiative (including printed Initiative bonuses and Advantage for a creature that starts
Invisible), attack rolls, saving throws, critical hits, Multiattack (including mixed volleys printed "in any
combination"), Recharge and daily uses, Bonus Actions, Reactions, Legendary Actions and Legendary Resistance, damage
resistances, immunities and vulnerabilities, temporary Hit Points, regeneration, Hit Point maximum reduction, and
the Dodge action for a creature with nothing better to do.

**Movement and position.** Walking, flying and hovering, altitude, falling, opportunity attacks, Dash and Disengage
where a stat block prints them (Cunning Action, Nimble Escape, Prowl), charges, leaps and pounces, teleports, pushes
and pulls on a hit or a failed save, Speed reductions, difficult ground created by a creature (Aberrant Ground), and
Legendary entries that move and then attack.

**Conditions and control.** Blinded, Charmed, Frightened, Grappled, Incapacitated, Invisible, Paralyzed, Poisoned,
Prone, Restrained, Stunned, Unconscious and stacking Exhaustion, with repeat saves, timed durations and escape
checks. Grapples carry their victim, including vertically; holds release when a push takes the target out of
reach; holds on a destructible object (webs, an Erinyes's rope, a Roper's tentacle) can be attacked by the creature
they hold.

**Swallow, engulf and attach.** Swallowed creatures have Total Cover against outside actions and auras, take the
printed digestion damage and are disgorged as printed. Engulf, attached creatures (Cloaker, Darkmantle, Stirge) and
Ghost Possession are handled as their entries describe.

**Spellcasting.** Direct-damage and healing spells with upcasts, spell components (a caster that cannot speak
cannot cast a Verbal spell), Concentration (damage saves capped at DC 30, ended by 0 Hit Points or Incapacitation),
Counterspell and Shield with their triggers and resource gates, and a set of control and defensive spells: Bless,
Charm Person, Charm Monster, Confusion, Dispel Evil and Good, Dominate Person, Faerie Fire, Fly, Greater
Restoration, Harm, Hold Person and Hold Monster, Hypnotic Pattern, Lesser Restoration, Mind Spike, Mirror Image,
Power Word Stun, Sanctuary, Slow, Spirit Guardians, Spiritual Weapon, Telekinesis, True Seeing and Web, among
others.

**Senses.** Blindsight, Truesight and Darkvision matter where a creature is unseen (Invisible, or inside a
Darkmantle's Darkness Aura). Tremorsense is not treated as sight.

**Monster-specific mechanics.** Many traits need their own handling and are implemented from the printed text, for
example a Hydra's heads, a Stone Giant's Deflect Missile, devils' infernal wounds and the Medicine action that
closes them, a Rakshasa's and Tarrasque's spell defences, the Burning hazard and the action to extinguish it, Undead
Fortitude, Death Burst, and a Roc carrying a creature aloft and dropping it.

What the compiler modelled and skipped for each monster is listed in `out/coverage.md` after `npm run compile`; the
copy for the published results is [results/coverage.md](../results/coverage.md).

## Sampling and scoring

A sweep fights every unordered pair of the 330 creatures (54,285 pairs) in one scenario.

**Adaptive sampling.** Add `--adaptive` to `run` or `analyze` to size each matchup from a pilot sample. `--iters`
remains the maximum, `--pilot` defaults to 70, and `--target-se` defaults to 0.02. Decisive matchups use fewer
fights; closely matched opponents use more. Each CSV row records the actual count, and the ranking gives each
matchup equal weight. This is a pilot-based sampling rule, not a guaranteed confidence interval. Start a fresh run
when changing sampling settings; `--resume` keeps existing pair rows.

**Score.** A win is 1 and a loss is 0. A draw is split by hit points left: the side with more of its hit points
left takes more than half. A pair's score is the mean over its fights.

**Elo.** A Bradley-Terry strength is fitted to every pair's score at once, each pair weighted equally, and put on
the Elo scale (400 points is 10 to 1 odds) with the median CR 1 creature at 1000. Rank is position by Elo within a
scenario. Creatures that never win (Seahorse and Shrieker Fungus, which have no way to deal damage) get a floor
value. [results/README.md](../results/README.md) defines every published column exactly.

## Commands

```sh
node src/cli.ts compile
node src/cli.ts coverage
node src/cli.ts fight "Goblin Minion" "Guard" --iters 1000 --seed 1 --verbose
node src/cli.ts run --iters 200 --workers 8 --resume
node src/cli.ts run --iters 800 --adaptive --pilot 70 --target-se 0.02 --workers 8
node src/cli.ts rank
node src/cli.ts analyze
node src/cli.ts gauntlet --iters 1000 --workers 8
node src/cli.ts gauntletreport --iters 1000 --top 5
node src/cli.ts combine
node src/cli.ts crcompare
node src/cli.ts benchmark --iters 100000
node src/cli.ts verify --pairs 2000 --iters 1 --seed 1
node src/cli.ts verify-output --iters 10 --seed 1 --workers 8
node src/fight-logs.ts --scenario max120 --seed 1 --workers 9
node tools/make-results.mjs
```

`run` and `rank` use scenario-specific files (`pairs-max600.csv`, `matrix-max600.csv`, `ranking-max600.csv` by
default). Use the same `--scenario` and `--tag NAME` for both commands to keep a separate sweep, and the same
`--only FILTER` to rank its selected corpus. Filters accept a name fragment, a CR comparison such as `cr<=5`, or
`source=SRD`. `analyze` is the standard sweep: it runs and ranks `max30` and `max120`, then produces the combined
rankings and scenario comparison. `max600` is not part of it; run it with `run --scenario max600` and
`rank --scenario max600`, and pass `--max600 ranking-max600.csv` to `combine` to add its column. `crcompare`
defaults to the selected scenario's ranking.

`gauntlet` runs a ladder through the CR tiers: each tier's champion joins the next tier. It writes standings and
matchup CSVs for each scenario, and a Markdown report when all three scenarios run. `--only`, `--label`, `--top`,
and `--scenario` customize the ladder and its outputs. `gauntletreport` rebuilds the report from those standings
without rerunning fights; use the original `--iters`, `--seed`, and label when rebuilding it.

`verify` checks that the optimized engine and the reference engine give the same fights. It checks the optimizer,
not the rules; the rules are checked by the tests, each written from the printed SRD text.

`fight-logs.ts` writes the verbose log of one fight per pair, for every pair, as gzipped JSONL.
`make-results.mjs` rebuilds `results/` (rankings, CSVs, plots and manifest) from the sweep outputs in `out/`.

## Regenerating the data

`data/` is not hand-maintained. It is produced from the text layer of the SRD 5.2.1 PDF, which Wizards of the
Coast publishes under CC BY 4.0 at https://www.dndbeyond.com/srd.

```sh
pip install -r tools/requirements.txt
python tools/build_srd_data.py path/to/SRD_CC_v5.2.1.pdf
python tools/test_srd.py
```

The PDF is not redistributed here. The generator parses stat blocks and spell descriptions using the PDF's own
typography — font and column position identify names, section headers, outcome labels, and the ability table — and
refuses to write output if the record counts change or if any non-SRD source marker appears. Python is needed only
to regenerate; the simulator itself has no Python dependency.
