// Teleport-and-attack, a Roc's drop, swallowing, fliers waiting out of reach, saves that kill, and healing in the
// log. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the
// test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const run = (a: string, b: string, scenario: 'max30' | 'max120' | 'max600', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;
/** The log split into rounds: rounds(log)[0] is round 1. */
const rounds = (lines: string[]) => lines.reduce<string[][]>((all, line) => {
  if (/^Round \d+$/.test(line)) all.push([]); else all.at(-1)?.push(line);
  return all;
}, []);

test('H01 a Marilith out of walking range teleports beside its foe and attacks in the same turn', () => {
  // Teleport (p306, a Bonus Action): "The marilith teleports up to 120 feet to an unoccupied space it can see." At 65 feet
  // a walk of 40 leaves only a Dash; the jump leaves the action for the Multiattack. It Dashed in every seed.
  for (const seed of [1, 2, 3, 4]) {
    const log = run('Marilith', 'Archmage', 'max120', seed).log;
    const jump = log.indexOf('Marilith teleports (65 ft -> 5 ft)');
    assert.ok(jump > 0);
    assert.equal(log[jump + 1], 'Marilith uses Constrict');
    assert.equal(count(log, 'Marilith dashes'), 0);
  }
});

test('H01 control: a Marilith 30 feet from its foe walks and keeps the Teleport', () => {
  const first = rounds(run('Marilith', 'Archmage', 'max120', 1).log)[0];
  assert.equal(first[0], 'Marilith moves (30 ft -> 5 ft)');
  assert.equal(count(first, 'Marilith teleports'), 0);
});

test('H02 a Roc does not drop a foe its Talons hold Restrained when the fall is worth less than the hold', () => {
  // Swoop (p320): "If the roc has a creature Grappled, the roc flies up to half its Fly Speed without provoking
  // Opportunity Attacks and drops that creature." Talons print the Restrained condition with the grapple: the drop gives
  // up Advantage on the Roc's attacks and Disadvantage on a Stone Golem's Slams for a fall the Golem (220 Hit Points)
  // shrugs off. It dropped the Golem from 60 feet in every seed.
  for (const seed of [1, 2, 3]) assert.equal(count(run('Roc', 'Stone Golem', 'max120', seed).log, 'Roc drops Stone Golem'), 0);
});

test('H02 control: a Roc still drops a Triceratops', () => {
  assert.equal(count(run('Roc', 'Triceratops', 'max120', 1).log, 'Roc drops Triceratops from 30 ft'), 1);
});

test('H05 a Remorhaz does not swallow a foe that is worth more bitten', () => {
  // Swallow (p319): "one Large or smaller creature Grappled by the remorhaz ... Failure: The target is swallowed by the
  // remorhaz, and the Grappled condition ends." The swallowed creature takes acid and fire at the start of the
  // remorhaz's turns; a Young Red Dragon is immune to the fire, and the Bite cannot reach a creature inside. It
  // swallowed the dragon in both seeds.
  for (const seed of [2, 3]) {
    const log = run('Remorhaz', 'Young Red Dragon', 'max30', seed).log;
    assert.equal(count(log, 'Remorhaz uses bonus action Swallow'), 0);
    assert.ok(count(log, 'Remorhaz uses Bite') >= 6);
  }
});

test('H05 control: a Purple Worm still swallows a Mage', () => {
  for (const seed of [1, 2, 3]) assert.ok(count(run('Purple Worm', 'Mage', 'max30', seed).log, 'Swallow') >= 1);
});

test('H06 a wounded Wyvern one step from its foe steps in and attacks instead of stanching', () => {
  // Infernal Tail (p300): "While wounded, the target loses 10 (3d6) Hit Points at the start of each of its turns." The
  // check (Wisdom +1 against DC 17, 0.25) saves 0.25 x 10.5 x 3 = 7.9; from 5 feet, a step away, Bite and Sting are worth
  // 12. The comparison was made from 10 feet, where only the Sting reaches.
  for (const seed of [1, 2, 3]) {
    const log = run('Horned Devil', 'Wyvern', 'max30', seed).log;
    assert.equal(count(log, 'attempts to stanch'), 0);
    assert.ok(count(log, 'Wyvern uses Bite') >= 1);
  }
});

test('H06 control: a Druid with nothing better still stanches a Bearded Devil\'s wound', () => {
  assert.equal(count(run('Bearded Devil', 'Druid', 'max30', 1).log, 'attempts to stanch'), 2);
});

test('H08 a flier whose breath is spent waits out of reach of a foe that would kill it in the exchange', () => {
  // Frost Breath (p307): "(Recharge 6) ... 7 (3d4) Cold damage." An Ice Mephit (21 Hit Points) that comes down to Claw an
  // Owlbear takes two Rends (2 x 0.75 x 14); 20 feet up it takes nothing. It came down and died in rounds 2 and 3.
  for (const seed of [1, 2]) {
    const log = run('Ice Mephit', 'Owlbear', 'max120', seed).log;
    assert.equal(count(log, 'Ice Mephit takes'), 0);
    assert.ok(count(log, 'Ice Mephit dodges') >= 10);
  }
});

test('H08 control: an Ice Mephit does not wait above a Scout that shoots back', () => {
  for (const seed of [1, 2]) assert.equal(count(run('Ice Mephit', 'Scout', 'max120', seed).log, 'Ice Mephit dodges'), 0);
});

test('H09 a Bulette whose next attack roll has Disadvantage bites twice instead of leaping', () => {
  // Morningstar (p284): "the target has Disadvantage on the next attack roll it makes before the end of its next turn."
  // One roll: two Bites are 0.64 x 17 + 0.8 x 17 = 24.5 against a Deadly Leap's 15.3. The whole Multiattack was priced
  // at Disadvantage, and it leapt.
  for (const seed of [1, 3, 4]) {
    const log = run('Bulette', 'Ettin', 'max30', seed).log;
    const spent = log.indexOf("Bulette's nextAttackDisadvantage is spent");
    assert.ok(spent > 0);
    assert.equal(log[spent - 1], 'Bulette uses Bite');
    assert.ok(log.slice(spent + 1, spent + 4).includes('Bulette uses Bite'));
  }
});

test('H09 control: a Bulette still opens with Deadly Leap on a Knight', () => {
  // Deadly Leap (p272): "The bulette spends 5 feet of movement to jump to a space within 15 feet".
  const first = rounds(run('Bulette', 'Knight', 'max30', 1).log)[0];
  assert.deepEqual(first.slice(0, 2), ['Bulette moves (30 ft -> 15 ft)', 'Bulette uses Deadly Leap']);
});

test('H10 a save that kills applies no condition to the dead target', () => {
  // Tentacle Slam (p313): "Failure: 16 (3d8 + 3) Bludgeoning damage, and the target has the Stunned condition". The
  // log printed "Knight gains stunned" after "(0 hp left)".
  const log = run('Otyugh', 'Knight', 'max30', 1).log;
  const dead = log.findIndex((line) => line.startsWith('Knight takes') && line.includes('(0 hp left)'));
  assert.ok(dead > 0);
  assert.equal(log[dead - 1], 'Otyugh uses Tentacle Slam');
  assert.notEqual(log[dead + 1], 'Knight gains stunned');
});

test('H10 control: the same save still Stuns a Knight it does not kill', () => {
  for (const seed of [1, 2, 3]) {
    const log = run('Otyugh', 'Knight', 'max30', seed).log;
    const stunned = log.indexOf('Knight gains stunned');
    assert.ok(stunned > 0);
    assert.ok(!log[stunned - 1].includes('(0 hp left)'));
  }
});

test('H12 healing that restores nothing prints no line, and a War Cry that raises nothing says so', () => {
  // Consume Memories (p258) heals an Aboleth at full Hit Points by nothing: "Aboleth regains 0 hp (150 hp)" was logged.
  for (const seed of [1, 2, 3]) assert.equal(count(run('Aboleth', 'Knight', 'max30', seed).log, 'regains 0 hp'), 0);
  // War Cry (p286): "gains 16 (2d10 + 5) Temporary Hit Points". Temporary Hit Points do not stack: a lower roll keeps the
  // ones held, and the action had no result line.
  const log = run('Frost Giant', 'Gorgon', 'max30', 5).log;
  const kept = log.indexOf('Frost Giant keeps its 16 temporary hit points');
  assert.ok(kept > 0);
  assert.equal(log[kept - 1], 'Frost Giant uses bonus action War Cry');
});

test('H12 control: a hurt Aboleth still logs what it regains', () => {
  assert.ok(run('Aboleth', 'Young Red Dragon', 'max30', 1).log.includes('Aboleth regains 4 hp (129 hp)'));
});

test('H13 a creature that cannot hurt its foe Dodges beside it instead of walking off through an Opportunity Attack every round', () => {
  // Pseudopod (p312): "Melee Attack Roll: +4, reach 5 ft. Hit: 12 (3d6 + 2) Acid damage." An Ochre Jelly is immune to an
  // Owlbear's Slashing damage. In a 30-foot room the Jelly Dashes back each round, so each step away pays an Opportunity
  // Attack (0.6 x 12.5 = 7.5); Dodge (p181) beside it costs 0.36 x 12.5 = 4.5. It walked off 10 and 9 times.
  for (const seed of [1, 2]) assert.equal(count(run('Owlbear', 'Ochre Jelly', 'max30', seed).log, 'opportunity attack'), 0);
});

test('H13 control: with room to stay ahead the Owlbear still walks away', () => {
  const log = run('Owlbear', 'Ochre Jelly', 'max120', 1).log;
  assert.equal(rounds(log)[0][0], 'Owlbear moves (30 ft -> 70 ft)');
  assert.equal(count(log, 'opportunity attack'), 0);
});
