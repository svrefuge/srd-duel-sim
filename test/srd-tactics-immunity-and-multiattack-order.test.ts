// Keeping away when every attack meets an immunity, Multiattack order, run-ups, aura positioning, grapple release,
// and Dash against a move. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the
// finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const run = (a: string, b: string, scenario: 'max30' | 'max120' | 'max600', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;
const round = (lines: string[], n: number) => lines.slice(lines.indexOf(`Round ${n}`), lines.indexOf(`Round ${n + 1}`) < 0 ? undefined : lines.indexOf(`Round ${n + 1}`));

test('B01 a flier that cannot finish a regenerator stays out of its reach', () => {
  // p333, Troll Limb: "The limb dies only if it starts its turn with 0 Hit Points and doesn't regenerate", and only Acid
  // or Fire stops that. Rend reach 5 ft., Speed 20 ft., no ranged attack. An Adult Blue Dragon (Lightning, Slashing)
  // landed beside it to make its Rends Critical Hits and lost all 400 fights; aloft the limb cannot touch it.
  const t = run('Adult Blue Dragon', 'Troll Limb', 'max30', 1);
  assert.equal(t.winner, -1);
  assert.equal(count(t.log, 'Adult Blue Dragon takes'), 0);
});

test('B01 control: a dragon whose breath stops the regeneration fights and wins', () => {
  assert.equal(run('Adult Red Dragon', 'Troll Limb', 'max30', 1).winner, 0);
});

test('B02 a creature whose every attack meets an immunity keeps away: aloft, or by a Dash it wins', () => {
  // Ochre Jelly: Immunities Acid, Lightning, Slashing. Young Blue Dragon: Rend (Slashing and Lightning), Lightning
  // Breath. It Dashed up and Dodged beside the jelly for 91 rounds and died.
  const dragon = run('Young Blue Dragon', 'Ochre Jelly', 'max30', 1);
  assert.equal(dragon.winner, -1);
  assert.equal(count(dragon.log, 'Young Blue Dragon takes'), 0);
  // Imp: Immunities Fire, Fly 40 ft. Fire Elemental: Burn, Fire Aura and Fire Form are all Fire; Speed 50 ft. Its Dash
  // covers 100 feet to the Imp's 80.
  const elemental = run('Fire Elemental', 'Imp', 'max600', 1);
  assert.equal(elemental.winner, -1);
  assert.ok(elemental.log.includes('Fire Elemental dashes (30 ft -> 130 ft)'), elemental.log.slice(0, 6).join('\n'));
  assert.equal(count(elemental.log, 'Fire Elemental takes'), 0);
});

test('B02 control: against a foe it can burn, the Fire Elemental closes and never Dashes away', () => {
  const t = run('Fire Elemental', 'Goblin Warrior', 'max600', 1);
  assert.equal(t.winner, 0);
  assert.equal(count(t.log, 'Fire Elemental dashes'), 0);
});

test('B03 a creature that comes down to finish its foe makes the attack it came for', () => {
  // Mummy at 4 hit points; Needle Sword +6 against AC 11, 1d4 + 4. The Sprite flew down from 25 feet to stab it, cast
  // Invisibility beside it instead (priced on the whole of the Mummy's next turn) and was killed.
  // The Sprite does not come down at all: the Mummy cannot hurt it 35 feet up, and it shoots to the end.
  const t = run('Mummy', 'Sprite', 'max30', 1);
  assert.ok(!t.log.some((line) => /^Sprite moves .*to 0 ft\]$/.test(line)));
  assert.ok(!t.log.includes('Sprite uses Invisibility'));
  assert.equal(t.winner, 1);
});

test('B04 Engulf is the cube\'s own move: it ends beside what it engulfed', () => {
  // p287: "Engulf. The cube moves up to its Speed without provoking Opportunity Attacks ... each creature whose space
  // the cube enters ... When the cube moves, the engulfed target moves with it." It engulfed from 15 feet and stayed there.
  const first = round(run('Gelatinous Cube', 'Knight', 'max30', 2).log, 1);
  const engulf = first.indexOf('Gelatinous Cube uses Engulf');
  assert.ok(engulf > 0, first.join('\n'));
  assert.equal(first[engulf + 1], 'Gelatinous Cube moves (15 ft -> 5 ft)');
  assert.ok(!first.includes('Knight makes an opportunity attack'));
});

test('B04 control: only the Gelatinous Cube compiles an action that enters its target\'s space', () => {
  const names = blocks.filter((x) => x.options.some((o) => o.action.kind === 'save' && o.action.entersTargetSpace)).map((x) => x.name);
  assert.deepEqual(names, ['Gelatinous Cube']);
});

test('B05 a Bonus Action that opens the foe to attacks comes before them', () => {
  // Medusa: Petrifying Gaze (Bonus Action), Con DC 13, Restrained on a failure; "Attack rolls against the target have
  // Advantage" (Restrained). Claw +6 against AC 18: 45% plain, 70% with Advantage.
  const first = round(run('Medusa', 'Knight', 'max30', 1).log, 1);
  const gaze = first.indexOf('Medusa uses bonus action Petrifying Gaze'), claw = first.indexOf('Medusa uses Claw');
  assert.ok(gaze > 0 && claw > gaze, first.join('\n'));
});

test('B05 control: a Bonus Action that waits on the action\'s own hold still follows it', () => {
  // Purple Worm: Swallow needs a target the Bite has Grappled. (A Mage, whose spells the swallow hampers: a
  // swallower keeps biting a foe its Multiattack does more to than the digestion, as a Remorhaz does an Ogre.)
  const first = round(run('Purple Worm', 'Mage', 'max30', 1).log, 1);
  assert.ok(first.indexOf('Purple Worm uses bonus action Swallow') > first.indexOf('Purple Worm uses Bite'), first.join('\n'));
});

test('B06 a Multiattack makes its knock-down first', () => {
  // Brown Bear: "The bear makes one Bite attack and one Claw attack"; Claw: "the target has the Prone condition" if
  // Large or smaller. Prone: "attack rolls against you have Advantage if the attacker is within 5 feet of you".
  const first = round(run('Brown Bear', 'Giant Boar', 'max30', 1).log, 1);
  const claw = first.indexOf('Brown Bear uses Claw'), bite = first.indexOf('Brown Bear uses Bite');
  assert.ok(claw > 0 && bite > claw, first.join('\n'));
});

test('B06 control: an opener that is a grapple keeps the printed order', () => {
  const log = run('Roc', 'Mammoth', 'max30', 1).log.filter((line) => line.startsWith('Roc uses'));
  assert.deepEqual(log.slice(0, 2), ['Roc uses Beak', 'Roc uses Talons']);
});

test('B07 a charger backs off to the square its run-up asks for', () => {
  // Allosaurus, Claws: "moved 30+ feet straight toward it immediately before the hit, the target has the Prone
  // condition, and the allosaurus can make one Bite attack against it". Speed 60 ft., 30 feet away: 5 back, 30 in.
  const first = round(run('Allosaurus', 'Owlbear', 'max120', 1).log, 1);
  assert.ok(first.includes('Allosaurus moves (30 ft -> 35 ft)') && first.includes('Allosaurus makes a free Bite attack'), first.join('\n'));
});

test('B07 control: with the wall 30 feet from the foe there is no room, and no free Bite', () => {
  assert.equal(count(round(run('Allosaurus', 'Owlbear', 'max30', 1).log, 1), 'free Bite'), 0);
});

test('B09 a creature with an aura of its own stands where the aura reaches its foe', () => {
  // Remorhaz, Heat Aura: "At the end of each of the remorhaz's turns, each creature in a 5-foot Emanation originating
  // from the remorhaz takes 16 (3d10) Fire damage." Bite reach 10 ft.: it bit from 10 feet and the aura touched nothing.
  const first = round(run('Remorhaz', 'Ogre', 'max30', 1).log, 1);
  assert.ok(first.includes('Remorhaz moves (30 ft -> 5 ft)') && first.includes("Ogre is caught in Remorhaz's Heat Aura"), first.join('\n'));
});

test('B09 control: against a foe immune to the aura it keeps its reach', () => {
  assert.ok(round(run('Remorhaz', 'Fire Giant', 'max30', 1).log, 1).includes('Remorhaz moves (30 ft -> 10 ft)'));
});

test('B10 a reduction of the Hit Point maximum with no save of its own is logged', () => {
  // Wraith, Life Drain: "The target's Hit Point maximum decreases by an amount equal to the damage taken."
  assert.ok(count(run('Wraith', 'Knight', 'max30', 2).log, "Knight's hit point maximum is reduced by") > 0);
  assert.equal(count(run('Knight', 'Ogre', 'max30', 1).log, 'hit point maximum'), 0);
});

test('B27 Exhaustion is used to finish a regenerator damage cannot', () => {
  // Sphinx of Valor, Weight of Years (Legendary Action): Con DC 16 or 1 Exhaustion level; "you die if your Exhaustion
  // level is 6". Its Claws are Slashing and no Roar is Acid or Fire, so the Troll Limb regenerates from all of it. It
  // spent every Legendary Action on Arcane Prowl and lost all 400 fights.
  const t = run('Sphinx of Valor', 'Troll Limb', 'max30', 1);
  assert.equal(t.winner, 0);
  assert.ok(count(t.log, 'Sphinx of Valor uses legendary Weight of Years') >= 6);
  // H01: "you die if your Exhaustion level is 6" has a log line of its own.
  assert.equal(t.log.at(-1), 'Troll Limb dies of Exhaustion (level 6)');
});

test('B27 control: none against a foe it kills by damage, or one immune to Exhaustion', () => {
  assert.equal(count(run('Sphinx of Valor', 'Knight', 'max30', 1).log, 'Weight of Years'), 0);
  assert.equal(count(run('Sphinx of Valor', 'Ochre Jelly', 'max30', 1).log, 'Weight of Years'), 0);
});

test('B15 a breath that stops Regeneration opens the fight when it out-damages the Multiattack', () => {
  // Young Black Dragon v Troll (Con +5 v DC 14): Acid Breath 49 x 0.6 + 24.5 x 0.4 = 39.2 Acid; three Rends
  // 3 x (0.65 x 12.5 + 0.05 x 8.5) = 25.6, also part Acid. The suppressor's priority is counted once, not once per
  // swing, or the Rends would outbid the breath.
  for (const seed of [1, 2, 3]) {
    const first = round(run('Young Black Dragon', 'Troll', 'max30', seed).log, 1);
    assert.equal(first.find((line) => line.startsWith('Young Black Dragon uses')), 'Young Black Dragon uses Acid Breath');
  }
});

test('B15 control: a dragon whose bites do more than its breath to a regenerator keeps biting', () => {
  // Black Dragon Wyrmling's breath recharges; while it is spent the acid Rends stay the routine, and v an Ogre (no
  // Regeneration) the opening breath is unchanged.
  const first = round(run('Young Black Dragon', 'Ogre', 'max30', 1).log, 1);
  assert.equal(first.find((line) => line.startsWith('Young Black Dragon uses')), 'Young Black Dragon uses Acid Breath');
  const second = round(run('Young Black Dragon', 'Troll', 'max30', 2).log, 2);
  assert.ok(second.includes('Young Black Dragon uses Rend'), second.join('\n'));
});

test('B02a a creature that cannot win and cannot leave Dodges, flies if it can give itself wings, and does not wait for a kill it cannot set up', () => {
  // Troll v Black Pudding (Immunities Slashing; Corrosive Form): it walked off through an opportunity attack every
  // round (about 10 + 5.2) where standing and Dodging costs about 5.2, less than the 15 it regenerates.
  const troll = run('Troll', 'Black Pudding', 'max30', 1);
  assert.equal(troll.winner, -1);
  assert.ok(count(troll.log, 'Troll dodges') >= 90);
  // Rakshasa v Troll Limb: Fly (1/Day) puts it out of a reach of 5 feet for good; three Cursed Touches cannot finish.
  const rakshasa = run('Rakshasa', 'Troll Limb', 'max30', 1);
  assert.equal(rakshasa.winner, -1);
  assert.ok(rakshasa.log.includes('Rakshasa uses Fly'));
  assert.equal(count(rakshasa.log, 'Rakshasa takes'), 0);
  // p363, Consume Life: "one living creature the wisp can see within 5 feet that has 0 Hit Points". Its Shock is
  // Lightning and the Ochre Jelly is immune, so nothing brings the jelly there; it Dodged beside it and died.
  const wisp = run("Will-o'-Wisp", 'Ochre Jelly', 'max30', 1);
  assert.equal(wisp.winner, -1);
  assert.equal(count(wisp.log, "Will-o'-Wisp takes"), 0);
});

test('B02a control: a creature that can hold its foe off by damage keeps fighting, and the Wisp still shocks what it can hurt', () => {
  assert.equal(count(run('Gladiator', 'Troll Limb', 'max30', 1).log, 'Gladiator dodges'), 0);
  assert.ok(count(run("Will-o'-Wisp", 'Knight', 'max30', 1).log, "Will-o'-Wisp uses Shock") > 0);
});

test('B08a long range is priced at the real cost of Disadvantage', () => {
  // Spy, Hand Crossbow +4, range 30/120, against a Knight's AC 18: 35% to hit, 12.25% with Disadvantage, a factor of
  // 0.35 where a flat 0.6 was charged. It walked out to 60 feet and Dashed to 120 to shoot at long range.
  const first = round(run('Spy', 'Knight', 'max120', 3).log, 1);
  assert.equal(first[1], 'Spy uses Hand Crossbow', first.join('\n'));
});

test('B08a control: inside normal range a shooter still opens the distance', () => {
  // Scout, Longbow 150/600.
  assert.ok(round(run('Scout', 'Zombie', 'max600', 1).log, 1).includes('Scout moves (30 ft -> 60 ft)'));
});

test('B20 a move inside the creature\'s Speed is not a Dash, and it keeps its action to Dodge', () => {
  // Ogre Zombie, Speed 30 ft., 30 feet from a Manticore 20 feet up: the 20 feet to stand under it were logged as a
  // Dash and spent the action, so three Tail Spikes a round came in without Disadvantage. (The Manticore now holds 30
  // feet up and the zombie stays put; an Ankheg, Speed 30 ft., under a Black Dragon Wyrmling shows the same move.)
  const first = round(run('Black Dragon Wyrmling', 'Ankheg', 'max30', 1).log, 1);
  assert.deepEqual(first.slice(-2), ['Ankheg moves (15 ft -> 10 ft)', 'Ankheg dodges']);
});

test('B20 control: a move past its Speed is still a Dash; a push or pull of 0 feet prints no line', () => {
  // Basilisk, Speed 20 ft., 25 feet of ground to cover.
  assert.ok(run('Ankheg', 'Basilisk', 'max30', 1).log.includes('Basilisk dashes (30 ft -> 5 ft)'));
  const chain = run('Chain Devil', 'Hobgoblin Captain', 'max120', 1).log;
  assert.equal(chain.filter((line) => /is pulled \((\d+) ft -> \1 ft\)/.test(line)).length, 0);
  assert.equal(count(run('Tough Boss', 'Centaur Trooper', 'max600', 1).log, 'gains forcedPush'), 0);
});

test('H04 a grappler whose hold bars its own Tail lets go to make both attacks', () => {
  // p182: "the grappler can release the target at any time (no action required)". p350, Giant Crocodile, Bite: "While
  // Grappled, the target has the Restrained condition and can't be targeted by the crocodile's Tail." Holding on it
  // made one Bite a turn (+8 against AC 17 with Advantage, 0.84 x 21.5 = 18.1); Tail then Bite is 0.6 x 18.5 + about
  // 0.74 x 21.5 = 27, and the Bite takes the hold again.
  const second = round(run('Giant Crocodile', 'Shield Guardian', 'max30', 1).log, 2);
  assert.deepEqual(second.slice(1, 3), ['Giant Crocodile lets go of Shield Guardian', 'Giant Crocodile uses Tail'], second.join('\n'));
  assert.ok(second.includes('Giant Crocodile uses Bite'));
});

test('H04 control: nothing to let go of a foe too big to hold, and a holder with no barred attack keeps its grip', () => {
  assert.equal(count(run('Giant Crocodile', 'Fire Giant', 'max30', 1).log, 'lets go'), 0);
  assert.equal(count(run('Giant Toad', 'Knight', 'max30', 1).log, 'lets go'), 0);
  assert.equal(count(run('Roc', 'Mammoth', 'max30', 1).log, 'lets go'), 0);
});

test('H04 control: a holder whose only grappling action is the barred one keeps its hold', () => {
  // Smother is both the attack the hold bars and the attack that takes the hold (p. 259).
  const { log } = run('Animated Rug of Smothering', 'Pirate', 'max30', 2);
  assert.ok(count(log, 'Pirate gains grappled') > 0);
  assert.equal(count(log, 'lets go'), 0);
});
