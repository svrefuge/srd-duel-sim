// Engulf, Spiritual Weapon, the Cloaker's attachment, the Chain Devil's Chain, a Mephit's death burst, and
// teleporting out of a rope. Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is
// in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight, FightLog, srdMechanicsForTest as e, holdMovementForTest as p } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const HIGH = 0.9, LOW = 0;

/** Two creatures 5 feet apart in the 30-foot arena. */
function adjacent(aName: string, dName: string) {
  const A = block(aName), D = block(dName), a = e.initState(A), d = e.initState(D);
  const engagement = { ...e.startingEngagement('max30') }, lines = new FightLog(true);
  engagement.ground = 5; engagement.distance = 5;
  e.bindPlace([A, D], [a, d], engagement);
  return { A, D, a, d, engagement, lines };
}

test('PS01 Gelatinous Cube does not Engulf a creature it already holds', () => {
  // p287: "each creature whose space the cube enters for the first time during this move ... When the cube moves, the
  // engulfed target moves with it." A held creature is carried, so the save is not repeated on it: one 3d6 a round.
  assert.deepEqual((option('Gelatinous Cube', 'Engulf').action as any).requiresTargetMissingConditions, ['restrained']);
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    let held = false;
    for (const line of fight(block('Gelatinous Cube'), block('Wererat'), seed, true, 'max600').log) {
      if (line === 'Wererat gains restrained') held = true;
      else if (/^Wererat (escapes|is no longer restrained)/.test(line)) held = false;
      else if (line === 'Gelatinous Cube uses Engulf') assert.ok(!held, `seed ${seed}: Engulf on an engulfed Wererat`);
    }
  }
});

test('PS01 control: Shambling Mound Engulf, which enters no space, carries no such gate', () => {
  // p330: "Strength Saving Throw: DC 15, one Medium or smaller creature within 5 feet." No move, no "first time".
  assert.equal((option('Shambling Mound', 'Engulf').action as any).requiresTargetMissingConditions, undefined);
});

/** The Cultist Fanatic beside an Ogre, having cast Spiritual Weapon on its first turn. */
function fanatic() {
  const t = adjacent('Cultist Fanatic', 'Ogre');
  const idx = t.A.options.findIndex((o) => o.name === 'Spiritual Weapon'), weapon = t.A.options[idx];
  const left = () => t.a.perDay.get(weapon.uses.t === 'perDay' ? weapon.uses.pool ?? idx : idx);
  const use = () => {
    e.spend(t.a, idx, weapon);
    e.resolveOptionWithTeleport(t.A, t.D, t.a, t.d, weapon.action, rolls(HIGH), 0, t.engagement, t.lines, e.createPairEvaluator(t.A, t.D, true));
    e.settleAfterAction(t.A, t.D, t.a, t.d, 0, t.engagement, rolls(HIGH), t.lines);
  };
  e.startTurn(t.A, t.a, rolls(HIGH), t.lines);
  use();
  return { ...t, idx, weapon, left, use };
}

test('PS02 Spiritual Weapon repeats its attack on later turns for one use while Concentration lasts', () => {
  // p165: "Duration: Concentration, up to 1 minute ... As a Bonus Action on your later turns, you can move the force up
  // to 20 feet and repeat the attack". p278: "Spiritual Weapon (2/Day)". One cast: 2 - 1 = 1 use left, and it stays 1.
  assert.equal((option('Cultist Fanatic', 'Spiritual Weapon').action as any).sustained, true);
  const t = fanatic();
  assert.equal(t.left(), 1);
  assert.ok(t.a.concentrating);
  e.syncConcentration([t.A, t.D], [t.a, t.d], t.lines);
  assert.ok(t.a.concentrating, 'the weapon lasts past the first attack');
  for (let turn = 0; turn < 3; turn++) {
    e.startTurn(t.A, t.a, rolls(HIGH), t.lines);
    assert.ok(e.usable(t.a, t.idx, t.weapon));
    const hp = t.d.hp;
    t.use();
    assert.ok(t.d.hp < hp, 'the repeated attack hits on a 19');
    assert.equal(t.left(), 1);
  }
});

test('PS02 control: once Concentration is lost, the next Spiritual Weapon is a second cast', () => {
  const t = fanatic();
  t.a.concentrating = false;
  t.a.conditions = t.a.conditions.filter((c: any) => c.sustainsSpell === undefined);
  e.startTurn(t.A, t.a, rolls(HIGH), t.lines);
  t.use();
  assert.equal(t.left(), 0);
});

test('PS03 a creature with a Cloaker attached cannot walk away from it', () => {
  // p274: "the cloaker attaches to it ... The cloaker can detach itself by spending 5 feet of movement." The cloaker
  // lets go by its own movement; the host's movement carries it, so the 5 feet between them does not grow.
  const t = adjacent('Cloaker', 'Assassin');
  const attach = (option('Cloaker', 'Attach').action as any).riders;
  e.applyRiders(t.d, t.D, t.a, attach, 0, false, rolls(LOW), t.lines);
  assert.ok(t.d.conditions.some((c: any) => c.name === 'attached'));
  assert.equal(p.movementCeiling(t.d, t.a, 1, 5), 5);
  for (const seed of [1, 2, 3, 4]) {
    let attached = false;
    for (const line of fight(block('Cloaker'), block('Assassin'), seed, true, 'max30').log) {
      if (line === 'Assassin gains attached') attached = true;
      else if (/^Assassin (escapes|is no longer|teleports free)|hold ends/.test(line)) attached = false;
      const move = line.match(/^Assassin moves \((\d+) ft -> (\d+) ft\)/);
      if (move && attached) assert.ok(Number(move[2]) <= Number(move[1]), `seed ${seed}: ${line}`);
    }
  }
});

test('PS03 control: the Cloaker itself, and a creature with nothing attached, are not capped', () => {
  const t = adjacent('Cloaker', 'Assassin');
  assert.equal(p.movementCeiling(t.d, t.a, 1, 5), Infinity);
  e.applyRiders(t.d, t.D, t.a, (option('Cloaker', 'Attach').action as any).riders, 0, false, rolls(LOW), t.lines);
  assert.equal(p.movementCeiling(t.a, t.d, 0, 5), Infinity);
});

test('PS04 Chain Devil: Chain restrains until the grapple ends, over a conjured chain about to vanish', () => {
  // p273 Chain: "it has the Grappled condition (escape DC 14) from one of two chains, and it has the Restrained
  // condition until the grapple ends." Conjure Infernal Chain: "Restrained condition until the end of the devil's next
  // turn". The shorter Restrained does not stand in for the one the grapple gives.
  const t = adjacent('Chain Devil', 'Ogre');
  const conjure = (option('Chain Devil', 'Conjure Infernal Chain').action as any).riders.filter((r: any) => r.condition === 'restrained');
  const chain = (option('Chain Devil', 'Chain').action as any).riders;
  e.applyRiders(t.d, t.D, t.a, conjure, 0, false, rolls(LOW), t.lines, true);
  assert.deepEqual(t.d.conditions.filter((c: any) => c.name === 'restrained').map((c: any) => c.duration), ['endOfSourceNextTurn']);
  e.applyRiders(t.d, t.D, t.a, chain, 0, false, rolls(LOW), t.lines);
  assert.deepEqual(t.d.conditions.filter((c: any) => c.name === 'restrained').map((c: any) => c.duration).sort(), ['endOfSourceNextTurn', 'untilEscape']);
  assert.ok(t.d.conditions.some((c: any) => c.name === 'grappled'));
});

test('PS04 control: a second Chain hit adds no second Restrained', () => {
  const t = adjacent('Chain Devil', 'Ogre');
  const chain = (option('Chain Devil', 'Chain').action as any).riders;
  e.applyRiders(t.d, t.D, t.a, chain, 0, false, rolls(LOW), t.lines);
  e.applyRiders(t.d, t.D, t.a, chain, 0, false, rolls(LOW), t.lines);
  assert.equal(t.d.conditions.filter((c: any) => c.name === 'restrained').length, 1);
});

/** The Satyr kicks a Dust Mephit that has `hp` Hit Points left; every die is high, so Hooves hits (19 + 5 against AC 12). */
function kick(hp: number) {
  const t = adjacent('Satyr', 'Dust Mephit');
  t.d.hp = hp;
  e.resolveOptionWithTeleport(t.A, t.D, t.a, t.d, option('Satyr', 'Hooves').action, rolls(HIGH), 0, t.engagement, t.lines, e.createPairEvaluator(t.A, t.D, true));
  return t;
}

test('PS05 a Dust Mephit killed by Hooves bursts where it was hit, not after the push', () => {
  // p307: "The mephit explodes when it dies ... each creature in a 5-foot Emanation originating from the mephit". p322
  // Hooves: "Hit: 5 (1d4 + 3) Bludgeoning damage. If the target is a Medium or smaller creature, the satyr pushes the
  // target up to 10 feet". The damage is first: at 1 Hit Point it dies 5 feet away and is not moved.
  const t = kick(1);
  assert.ok(t.d.hp <= 0);
  assert.equal(t.engagement.distance, 5);
  assert.ok(!t.lines.lines.join("\n").includes('is pushed'));
});

test('PS05 control: a Dust Mephit that survives the hit may still be pushed', () => {
  // 17 Hit Points less at most 1d4 + 3 = 7 leaves it standing; the push is the Satyr's choice, up to 10 feet.
  const t = kick(17);
  assert.ok(t.d.hp > 0);
  assert.ok(!t.d.conditions.some((c: any) => c.push), 'the push is resolved, not left on the target');
  assert.equal(t.engagement.distance, 15);
  assert.ok(t.lines.lines.join("\n").includes('Dust Mephit is pushed (5 ft -> 15 ft)'));
});

test('PS05 the burst reaches the Satyr in a whole fight', () => {
  const log = fight(block('Dust Mephit'), block('Satyr'), 1, true, 'max30').log;
  const burst = log.indexOf('Dust Mephit releases Death Burst');
  assert.ok(burst > 0);
  assert.ok(!/is pushed/.test(log[burst - 1]), log[burst - 1]);
  assert.match(log.slice(burst + 1).join('\n'), /^Satyr (takes \d+ damage|saves)/);
});

test('PS06 a teleport does not end the Restrained of the Erinyes rope', () => {
  // p283: "the target has the Restrained condition until the rope is destroyed, the erinyes uses a Bonus Action to
  // release the target, or the erinyes uses Entangling Rope again." Three ends; leaving by teleport is not one.
  const t = adjacent('Erinyes', 'Archmage');
  const rope = block('Erinyes').options.find((o) => o.name.startsWith('Entangling Rope'))!;
  e.applyRiders(t.d, t.D, t.a, (rope.action as any).riders, 0, true, rolls(LOW), t.lines, true);
  const held = t.d.conditions.filter((c: any) => c.name === 'restrained');
  assert.equal(held.length, 1);
  assert.equal(p.teleportFreesHold(held[0]), false);
  for (const seed of [1, 2, 3, 4]) {
    assert.ok(!fight(block('Archmage'), block('Erinyes'), seed, true, 'max30').log.some((l) => /Archmage teleports free/.test(l)), `seed ${seed}`);
  }
});

test('PS06 control: a teleport still ends a grapple and the Restrained that rides it', () => {
  // p273 Chain: "Grappled condition (escape DC 14) ... Restrained condition until the grapple ends."
  const t = adjacent('Chain Devil', 'Archmage');
  e.applyRiders(t.d, t.D, t.a, (option('Chain Devil', 'Chain').action as any).riders, 0, false, rolls(LOW), t.lines);
  const holds = t.d.conditions.filter((c: any) => ['grappled', 'restrained'].includes(c.name));
  assert.equal(holds.length, 2);
  assert.ok(holds.every((c: any) => p.teleportFreesHold(c)));
});
