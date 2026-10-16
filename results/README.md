# Results

A frozen copy of one full run of the simulator. Everything here can be analyzed without running any code.
`MANIFEST.md` records the commit, the commands and a checksum for each file.

| File | Contents |
|---|---|
| `RANKINGS.md` | Every creature's rank, Elo and win rate in each scenario, in one table |
| `rankings.csv` | The same table as data |
| `pairs-<scenario>.csv` | The raw result of every pairing |
| `matrix-<scenario>.csv` | The score of every creature against every other, as a square table |
| `statblocks.json` | The stat blocks as the simulator compiled them: what each creature actually fought with |
| `coverage.md` | What the compiler modelled and what it skipped, with reasons |
| `plots/` | Charts drawn from `rankings.csv` |

## Scenarios

A fight is one creature against one other on open, flat ground, starting 30 feet apart. The scenario sets how far
apart they may get: `max30` is 30 feet, `max120` is 120 feet, `max600` is 600 feet. A fight that reaches 100 rounds
is a draw.

## Columns

**`pairs-<scenario>.csv`**: one row per unordered pair.

| Column | Meaning |
|---|---|
| `a`, `b` | The two creatures |
| `iters` | Fights run for this pair. Lopsided pairs stop early, so this varies from 70 to 800 |
| `winsA`, `winsB`, `draws` | Outcomes; they sum to `iters` |
| `avgRounds` | Mean length of a fight in rounds |
| `avgWinnerHpPct` | Mean share of its hit points the winner had left, over the decided fights |
| `drawHpA`, `drawHpB` | Mean share of hit points each side had left, over the drawn fights |

**Score.** A win is 1 and a loss is 0. A draw is split by hit points left: `a` takes
`0.5 + (drawHpA - drawHpB) / 2` and `b` takes the rest, so an even draw is half each. A pair's score for `a` is
`(winsA + draws * that share) / iters`.

**`matrix-<scenario>.csv`**: the cell in row R, column C is R's score against C. The diagonal is 0.5.

**`rankings.csv`**

| Column | Meaning |
|---|---|
| `name`, `cr` | The creature and its Challenge Rating (0.125 is CR 1/8) |
| `meanRank` | Mean of its ranks across the scenarios; the file is sorted by it |
| `<scenario>_rank` | Position by Elo in that scenario, 1 is strongest |
| `<scenario>_elo` | Bradley-Terry strength fitted to every pair's score, each pair weighted equally, on the Elo scale (400 points is 10 to 1 odds) with the median CR 1 creature at 1000 |
| `<scenario>_meanWinRate` | Mean of the creature's score over all its opponents |

Seahorse and Shrieker Fungus never won a fight: they have no way to deal damage. Their Elo is a floor value, and the plots leave them out.

## Plots

- `plots/elo-vs-cr-<scenario>.svg`: Elo against Challenge Rating, with the median Elo of each CR as a line.
- `plots/cr-vs-rank-<scenario>.svg`: the same comparison turned on its side. One row per Challenge Rating, every creature at its rank, a shaded band over the middle half of the row (its interquartile range) and a black mark at its median.
- `plots/over-under-cr.svg`: the creatures furthest above and below the median Elo of their own CR.
- `plots/rank-shift.svg`: each creature's rank in the tightest scenario against its rank in the widest.

Opened on their own, the SVG files show a creature's name and numbers when the pointer rests on a point.

## Reproducing

`node tools/make-results.mjs` rebuilds this folder from the sweep outputs in `out/`. `MANIFEST.md` has the sweep commands.
