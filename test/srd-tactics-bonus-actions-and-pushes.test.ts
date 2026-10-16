// Bonus Actions before the attacks they help, standing and Dashing, pushes worth an Opportunity Attack, and
// end-of-turn auras. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding
// id is in the test name.
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
/** Every round in which both lines appear, as [index of first, index of second]. */
const orderIn = (lines: string[], first: string, second: string) => rounds(lines)
  .map((round) => [round.indexOf(first), round.indexOf(second)]).filter(([a, b]) => a >= 0 && b >= 0);

test('D01 a Bonus Action cure of Blinded is cast before the attacks it frees from Disadvantage', () => {
  // Storm Giant's Thunderbolt Blinds until the start of its next turn; a Blinded creature's attack rolls have
  // Disadvantage. Three Radiant Swords at +12 against AC 16: 85% to hit, 72% with Disadvantage, about 12 damage a turn.
  // The Planetar swung three times Blinded and then cast Lesser Restoration.
  const order = orderIn(run('Storm Giant', 'Planetar', 'max30', 1).log, 'Planetar uses bonus action Lesser Restoration', 'Planetar uses Radiant Sword');
  assert.ok(order.length > 0, 'never cured and attacked in one round');
  for (const [cure, sword] of order) assert.ok(cure < sword);
});

test('D01 control: a Bonus Action heal that changes no attack roll still follows the attacks', () => {
  const order = orderIn(run('Storm Giant', 'Planetar', 'max30', 1).log, 'Planetar uses bonus action Cure Wounds', 'Planetar uses Radiant Sword');
  assert.ok(order.length > 0, 'never healed and attacked in one round');
  for (const [heal, sword] of order) assert.ok(heal > sword);
});

test('D02 Bless is cast before the Mace attacks it adds 1d4 to', () => {
  const order = orderIn(run('Priest', 'Polar Bear', 'max30', 1).log, 'Priest uses bonus action Bless', 'Priest uses Mace');
  assert.ok(order.length > 0, 'never Blessed and attacked in one round');
  for (const [bless, mace] of order) assert.ok(bless < mace);
});

test('D02 control: Bless is not cast ahead of a Concentration action that would end it', () => {
  // Spirit Guardians and Bless both take Concentration; round 1 is the aura and no Bless before it.
  const first = rounds(run('Priest', 'Ogre', 'max30', 1).log)[0];
  assert.ok(first.includes('Priest uses Spirit Guardians'));
  assert.equal(count(first, 'Priest uses bonus action Bless'), 0);
});

test('D03 a creature that stands from Prone and Dashes moves half its Speed plus its Speed', () => {
  // p15, Dash: "you gain extra movement for the current turn. The increase equals your Speed after applying any
  // modifiers." p186, Prone: "spend an amount of movement equal to half your Speed (round down) to right yourself".
  // Hezrou, Speed 30: 15 left after the stand, 30 from the Dash, 45 feet. It moved 30.
  const log = run('Stone Giant', 'Hezrou', 'max120', 1).log;
  const stand = log.indexOf('Hezrou spends half its Speed to stand');
  assert.equal(log[stand + 1], 'Hezrou dashes (60 ft -> 15 ft)');
});

test('D03 control: no Dash covers more than twice the Speed, and one after a stand no more than a Speed and a half', () => {
  const log = run('Stone Giant', 'Hezrou', 'max120', 1).log;
  log.forEach((line, i) => {
    const dash = line.match(/^Hezrou dashes \((\d+) ft -> (\d+) ft\)$/);
    if (dash) assert.ok(Number(dash[1]) - Number(dash[2]) <= (log[i - 1] === 'Hezrou spends half its Speed to stand' ? 45 : 60), line);
  });
  assert.ok(run('Gnoll Warrior', 'Bugbear Warrior', 'max120', 3).log.includes('Bugbear Warrior dashes (60 ft -> 5 ft)'));
});

test('D04 a push the foe flies straight back from does not replace an attack', () => {
  // p270, Young Bronze Dragon: "can replace one attack with a use of Repulsion Breath" (Strength save DC 15, pushed up
  // to 40 feet and Prone, no damage). A Vrock flies 60 feet: it stands for 30 and is back beside the dragon with its
  // Shreds still to make, in a 30-foot room. The Rend given up is 70% x 16 = 11 damage.
  assert.equal(count(run('Young Bronze Dragon', 'Vrock', 'max30', 3).log, 'uses Repulsion Breath'), 0);
});

test('D04 control: the breath keeps its worth where the pushed foe could not have reached the dragon anyway', () => {
  // A wyrmling above an Ochre Jelly (immune to Lightning and Slashing) has nothing else to use. Against a Triceratops
  // it Dodges while Lightning Breath recharges (H08).
  assert.ok(count(run('Bronze Dragon Wyrmling', 'Ochre Jelly', 'max30', 1).log, 'uses Repulsion Breath') > 0);
});

test('D07 a knock-down from 10 feet is not worth an Opportunity Attack against a foe that walks back', () => {
  // Earth Elemental v Vrock: two Slams adjacent (2 x 70% x 14 = 19.6) against a step out through the Vrock's
  // Opportunity Attack for Slam + Rock Launch (15.8). The Vrock stood and walked back each round.
  assert.equal(count(run('Earth Elemental', 'Vrock', 'max600', 3).log, 'Vrock makes an opportunity attack'), 0);
});

test('D07 control: a reach knock-down keeps its worth against a foe that can fight from a full move away', () => {
  // Dragon Turtle's Tail (reach 15, Prone) holds a flying Efreeti to half its movement.
  assert.ok(count(run('Dragon Turtle', 'Efreeti', 'max120', 1).log, 'Dragon Turtle uses Tail') > 0);
});

test('D09 a push that buys nothing does not draw an archer into a melee-hit retaliation', () => {
  // Tough Boss v Black Pudding (AC 7, reach 10, Speed 20): Heavy Crossbow 2 x 90% x 13 = 23.4 from 10 feet, Warhammer
  // 2 x 95% x 12 = 22.8 and about 8.6 acid from Corrosive Form. The Warhammer's 10-foot push leaves the Pudding in reach.
  assert.equal(count(run('Black Pudding', 'Tough Boss', 'max30', 3).log, "is hurt by Black Pudding's Corrosive Form"), 0);
});

test('D09 control: the Tough Boss still fights with its Warhammer where nothing answers the hit', () => {
  assert.ok(count(run('Tough Boss', 'Ogre', 'max30', 1).log, 'Tough Boss uses Warhammer') > 0);
});

test('D06 no step out of an end-of-turn aura whose owner walks back in before it fires', () => {
  // p261, Azer Sentinel: "Fire Aura. At the end of each of the azer's turns, each creature of the azer's choice in a
  // 5-foot Emanation ... takes 5 (1d10) Fire damage". Awakened Tree, reach 10, Speed 20; the Azer's Speed is 30.
  const log = run('Awakened Tree', 'Azer Sentinel', 'max30', 2).log;
  assert.equal(count(log, 'Azer Sentinel makes an opportunity attack'), 0);
  assert.equal(count(log, 'Awakened Tree moves (5 ft -> 10 ft)'), 0);
});

test('D06 control: a creature that can end beyond the owner\'s walk still leaves the aura', () => {
  // Ogre, Speed 40 with a Javelin: 45 feet away is 15 feet past the Azer's next move.
  assert.ok(run('Ogre', 'Azer Sentinel', 'max120', 1).log.some((line) => /^Ogre (moves|dashes) \(\d+ ft -> [4-9][05] ft\)$/.test(line)));
});

test('D05 a melee creature Dashes once to close on a ranged foe as fast as itself', () => {
  // Bugbear Warrior (Speed 30, Grab reach 10, Light Hammer 20/60) v Gnoll Warrior (Speed 30, Bone Bow): a walk leaves
  // it 30 feet short every round. It threw at long range for ten rounds; in melee it wins.
  const log = run('Gnoll Warrior', 'Bugbear Warrior', 'max120', 3).log;
  assert.ok(log.includes('Bugbear Warrior dashes (60 ft -> 5 ft)'));
  assert.ok(count(log, 'Bugbear Warrior uses Grab') > 0);
});

test('D05 control: no Dash where a walk brings it into reach', () => {
  assert.equal(count(run('Bugbear Warrior', 'Ogre', 'max120', 1).log, 'Bugbear Warrior dashes'), 0);
  assert.equal(count(run('Bugbear Warrior', 'Gnoll Warrior', 'max30', 1).log, 'Bugbear Warrior dashes'), 0);
});

test('D22 an aura of conditions is logged as nothing to a target immune to all of them', () => {
  const log = run('Pit Fiend', 'Stone Golem', 'max120', 1).log;
  assert.ok(log.includes("Stone Golem is immune to Pit Fiend's Fear Aura"));
  assert.equal(count(log, "Stone Golem is caught in Pit Fiend's Fear Aura"), 0);
});

test('D22 control: a target that can be Frightened is still caught in it', () => {
  assert.ok(count(run('Pit Fiend', 'Frost Giant', 'max30', 1).log, "Frost Giant is caught in Pit Fiend's Fear Aura") > 0);
});

test('D04 a jump that lands beside the foe prices its push from the landing, so no step back to jump again', () => {
  // p272, Bulette, Deadly Leap: "jump to a space within 15 feet that contains one or more Large or smaller creatures
  // ... Success: Half damage, and the target is pushed 5 feet straight away". The push starts from 5 feet whether the
  // jump began at 5 or at 15, and a Xorn (Speed 20) walks back from it. The Bulette stepped out to 15 feet through the
  // Xorn's Opportunity Attack every round to jump from there: 118 wins of 400 fell to 36.
  const log = run('Bulette', 'Xorn', 'max30', 3).log;
  assert.equal(count(log, 'Bulette moves (5 ft -> 15 ft)'), 0);
  assert.equal(count(log, 'Xorn makes an opportunity attack'), 0);
});

test('D04 control: the Bulette still leaps where the leap is its best action, and bites where two Bites are', () => {
  // Xorn, AC 19: two Bites 2 x 45% x 17 = 15.3 against the leap's 70% x 19.5 + 30% x 9.75 = 16.6. Flesh Golem, AC 9:
  // two Bites 2 x 95% x 17 = 32.3 against 75% x 19.5 + 25% x 9.75 = 17.1.
  assert.ok(count(run('Bulette', 'Xorn', 'max30', 3).log, 'Bulette uses Deadly Leap') > 2);
  assert.ok(count(run('Bulette', 'Flesh Golem', 'max30', 3).log, 'Bulette uses Bite') > 2);
});
