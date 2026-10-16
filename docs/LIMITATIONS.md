# Limitations

The results are 1v1 duels under the assumptions below. A creature whose strength lies in something listed here
(swimming, summons, terrain, allies) is measured without it.

## Interpretations

Where the printed text leaves a choice open, the simulator makes a fixed one:

- A Half-Dragon uses a single Draconic Origin for both damage and resistance. The default is Acid, the first printed
  type; pass `compileMonster(rawMonster, spells, { draconicOrigin: "fire" })` to choose Acid, Cold, Fire, Lightning
  or Poison. The origin never changes to exploit an opponent.
- Lycanthropes fight in hybrid form, the one form that has all their attacks.
- Creatures printed "Medium or Small" are Medium.
- Duels are on land. Aquatic creatures use their walking Speed, and options that work only underwater (Kraken's
  Toxic Ink) are not offered.
- Action selection is heuristic: each creature picks the option with the best expected value given what it can
  know. It is a consistent policy, not optimal play.

## What is not modelled

- Grid terrain, cover from terrain, light levels, and areas fixed at a point on the ground (the Darkness spell, the
  later saves of Insect Plague and Wall of Fire, the Web spell's webs as terrain).
- Summons, lair actions, stealth and surprise, and allies of any kind.
- Changing form (Shape-Shift), Gaseous Form, Etherealness, and creatures that split or shed parts (Black Pudding,
  Ochre Jelly, Troll's Loathsome Limbs).
- Corrosion of armor and weapons (Black Pudding, Gray Ooze, Rust Monster), since no entry says which Armor Class is
  worn metal or which attack is a metal weapon.
- Swim Speeds, suffocation and the Deafened condition.
- General actions a stat block does not print: Disengage, Ready, Unarmed Strike's Grapple and Shove, and Long and
  High Jump.
- Moving between the attacks of a Multiattack, and moving after an action without a Fly Speed: a creature moves,
  then makes its whole routine from where it stands. A push of a length the attacker chooses is therefore kept short
  enough for the routine's later attacks to reach.
- Most non-damage utility magic, and the social side of charm effects (attitudes, checks, what a creature knows
  afterwards).

Parser omissions for individual monsters are listed in [results/coverage.md](../results/coverage.md), or in
`out/coverage.md` after `npm run compile`.
