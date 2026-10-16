// Pursuit through Opportunity Attacks, Charmed ranged attackers, the Cloaker's attachment, and the riders of a
// killing hit. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is
// in the test name.
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

test('F01 a Nalfeshnee keeps its Reaction for Pursuit when a foe flies out of its walk and reach', () => {
  // Pursuit (p310): "Trigger: Another creature the nalfeshnee can see ends its move within 120 feet of the nalfeshnee.
  // Response: The nalfeshnee uses Teleport, but its destination must be within 10 feet of the triggering creature."
  // One Reaction a round. An Opportunity Attack is one Rend, 0.65 x 27 = 17.5; following keeps next turn's three
  // (52.7) where a 60-foot gap costs the turn to a Dash (Speed 20, Fly 30, reach 10).
  const log = run('Nalfeshnee', 'Adult Brass Dragon', 'max600', 1).log;
  assert.ok(log.includes('Nalfeshnee uses Pursuit (60 ft -> 5 ft)'));
  assert.equal(count(log, 'Nalfeshnee makes an opportunity attack'), 0);
  assert.equal(count(log, 'Nalfeshnee dashes'), 0);
});

test('F01 control: a creature with no Pursuit still makes its Opportunity Attack', () => {
  const log = run('Cultist Fanatic', 'Sprite', 'max120', 4).log;
  assert.equal(rounds(log)[0].filter((line) => line === 'Cultist Fanatic makes an opportunity attack').length, 1);
});

test('F02 a ranged creature Charmed for a turn does not walk up to its charmer', () => {
  // Charmed: "You can't attack the charmer or target the charmer with damaging abilities or magical effects." Captain's
  // Charm lasts until the start of the Pirate Captain's next turn. The Assassin had opened with its Light Crossbow
  // from 30 feet: Charmed there, it walked to 5 feet and Dodged beside a foe whose three attacks it then stood in.
  const log = run('Assassin', 'Pirate Captain', 'max30', 1).log;
  const charmed = log.indexOf('Assassin gains charmed');
  assert.ok(charmed > 0);
  assert.equal(log[charmed + 2], 'Assassin dodges');
});

test('F02 control: Charmed with its foe out of range of everything, a creature still Dashes after it', () => {
  // The Sprite hovers 80 feet up; the Fanatic's Command and Spiritual Weapon reach 60.
  const log = run('Cultist Fanatic', 'Sprite', 'max120', 4).log;
  assert.ok(count(log, 'Cultist Fanatic gains charmed') > 0);
  assert.ok(count(log, 'Cultist Fanatic dashes') > 0);
});

test('F03 a Cloaker that flies off the creature it is attached to has let go of it', () => {
  // Attach (p274): "While the cloaker is attached, the target has the Blinded condition ... The cloaker can detach
  // itself by spending 5 feet of movement." Flying 10 feet up, it must not leave the golem
  // Blinded and "attached". (Against the Flesh Golem it strikes with its Tail from above and never attaches, N03.)
  const log = run('Cloaker', 'Rakshasa', 'max30', 1).log;
  const left = log.indexOf('Cloaker moves (5 ft -> 10 ft) [altitude 0 ft to 15 ft]');
  assert.ok(left > 0);
  assert.equal(log[left + 1], 'Cloaker detaches from Rakshasa');
  assert.equal(count(rounds(log)[4], 'Rakshasa fails to escape') + count(rounds(log)[5], 'Rakshasa fails to escape'), 0);
});

test('F03 control: while it stays on its victim the Cloaker stays attached', () => {
  const second = rounds(run('Cloaker', 'Rakshasa', 'max30', 1).log)[1];
  assert.ok(second.includes('Rakshasa gains attached'));
  assert.equal(count(second, 'Cloaker detaches'), 0);
  assert.ok(count(second, 'Cloaker halves the damage (attached)') > 0);
});

test('F08 a dagger thrower closes on a foe whose Pistol is the better half of its attacks', () => {
  // "When you make a ranged attack roll ... you have Disadvantage on the roll if you are within 5 feet of an enemy."
  // Bandit Captain: Pistol 1d10 + 3 (8.5), Scimitar 1d6 + 3 (6.5). The Umbral Dagger is the same attack thrown or in
  // hand, so beside the Captain the Familiar gives up nothing and takes the Scimitar instead of the Pistol.
  const log = run('Vampire Familiar', 'Bandit Captain', 'max120', 2).log;
  assert.equal(rounds(log)[0][0], 'Vampire Familiar moves (30 ft -> 5 ft)');
});

test('F08 control: an archer still backs away from a creature that only fights in melee', () => {
  const log = run('Scout', 'Ogre', 'max120', 1).log;
  assert.equal(rounds(log)[0][0], 'Scout moves (30 ft -> 60 ft)');
});

test('F09 a hit that kills does not also knock its target Prone or push it', () => {
  const tiger = run('Tiger', 'Lion', 'max30', 1).log;
  assert.equal(tiger.at(-1), 'Lion takes 12 damage (0 hp left)');
  const boss = run('Tough Boss', 'Warrior Veteran', 'max30', 1).log;
  assert.equal(boss.at(-1), 'Warrior Veteran takes 17 damage (0 hp left)');
});

test('F09 control: a hit that leaves its target standing still knocks it Prone', () => {
  assert.ok(count(run('Tiger', 'Lion', 'max30', 1).log, 'gains prone') > 0);
});

test('F15 a hit that deals no damage and whose conditions are all barred is still logged as a hit', () => {
  // Roper Tentacle: no damage, Grappled and Poisoned. A Fire Elemental is immune to both.
  const first = rounds(run('Roper', 'Fire Elemental', 'max120', 2).log)[1];
  assert.ok(first.includes('Roper hits Fire Elemental to no effect'));
});

test('F15 control: a hit that applies its condition has no such line after it', () => {
  const log = run('Roper', 'Ogre', 'max30', 1).log;
  const held = log.indexOf('Ogre gains grappled');
  assert.ok(held > 0);
  assert.notEqual(log[held - 1], 'Roper hits Ogre to no effect');
  assert.ok(!log.slice(held, held + 3).includes('Roper hits Ogre to no effect'));
});

test('F19 Disadvantage is priced once: beside an Invisible foe the Priest uses its stronger ranged attack', () => {
  // "If circumstances cause a roll to have both ... multiple circumstances that impose Disadvantage, you still roll
  // only two d20s." Radiant Flame 2d10 (11); Mace 1d6 + 3 Bludgeoning, halved by the Wisp's Resistance, + 2d4 Radiant
  // (8). Both roll at Disadvantage against a foe the Priest cannot see: +5 against AC 19, 0.35 x 0.35 = 0.12, so
  // 1.3 against 1.0. Priced at Disadvantage twice (within 5 feet, and unseen), the Flame would lose.
  const second = rounds(run('Priest', "Will-o'-Wisp", 'max30', 1).log)[1];
  assert.equal(count(second, 'Priest uses Radiant Flame'), 2);
  assert.equal(count(second, 'Priest uses Mace'), 0);
});

test('F19 control: beside a foe it can see the Priest swings its Mace', () => {
  // Radiant Flame within 5 feet has Disadvantage and the Mace does not.
  const log = run('Priest', 'Ogre', 'max30', 1).log;
  assert.ok(count(log, 'Priest uses Mace') > 0);
  assert.equal(count(log, 'Priest uses Radiant Flame'), 0);
});
