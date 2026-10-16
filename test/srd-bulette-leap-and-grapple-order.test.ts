// Fliers under "move or act", the Bulette's Deadly Leap, and Multiattack order around a grapple. Each test is written
// from the printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight, FightLog, srdMechanicsForTest as e, incapacitatedMovementForTest as f } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const routineNames = (monster: string, routine: string) =>
  block(monster).routines.find((r) => r.name === routine)!.parts.map((part) => block(monster).options[part.optionIdx].name);
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const HIGH = 0.9, LOW = 0;

/** Two creatures `ground` feet apart in the 30-foot arena. */
function apart(aName: string, dName: string, ground: number) {
  const A = block(aName), D = block(dName), a = e.initState(A), d = e.initState(D);
  const engagement = { ...e.startingEngagement('max30') }, lines = new FightLog(true);
  engagement.ground = ground; engagement.distance = ground;
  e.bindPlace([A, D], [a, d], engagement);
  return { A, D, a, d, engagement, lines };
}

test('PT01 a flier that takes its action under "move or act, not both" stays in the air', () => {
  // p300 Ice Spear: "its Speed decreases by 10 feet, and it can move or take one action on its turn, not both."
  // p182, Flying: "you fall if you have the Incapacitated or Prone condition or your Fly Speed is reduced to 0."
  // The dragon's Fly Speed is 80 - 10 = 70, not 0: no fall, no damage, not Prone.
  const { A, D, a, d, engagement, lines } = apart('Adult Black Dragon', 'Ice Devil', 5);
  a.height = 15; a.actsInsteadOfMoving = true;
  const hp = a.hp;
  f.settleFlight([A, D], [a, d], engagement, rolls(HIGH), lines);
  assert.equal(a.height, 15);
  assert.equal(a.hp, hp);
  assert.ok(!a.conditions.some((c) => c.name === 'prone'));
  for (const seed of [1, 2, 3]) {
    assert.ok(!fight(A, D, seed, true, 'max30').log.some((line) => line.startsWith('Adult Black Dragon falls')), `seed ${seed}`);
  }
});

test('PT01 control: a flier whose Speed is 0 falls', () => {
  // The same rule's other half: "or your Fly Speed is reduced to 0." 15 feet is 1d6.
  const { A, D, a, d, engagement, lines } = apart('Adult Black Dragon', 'Ice Devil', 5);
  a.height = 15;
  a.conditions.push({ name: 'restrained', duration: 'permanent', source: 1, appliedTurn: 0 } as any);
  f.settleFlight([A, D], [a, d], engagement, rolls(HIGH), lines);
  assert.equal(a.height, 0);
  assert.ok(lines.lines.includes('Adult Black Dragon falls 15 ft'));
});

test('PT02 Bulette Deadly Leap lands the bulette on its target', () => {
  // p272: "The bulette spends 5 feet of movement to jump to a space within 15 feet that contains one or more Large or
  // smaller creatures. ... Failure: 19 (3d12) Bludgeoning damage, and the target has the Prone condition. Success: Half
  // damage, and the target is pushed 5 feet straight away from the bulette."
  const leap = option('Bulette', 'Deadly Leap').action as any;
  assert.deepEqual(leap.jumpsToTarget, { cost: 5 });
  assert.equal(leap.range, 15);
  assert.equal(leap.targetMaxSize, 3);
  // From 15 feet, a failed save: the bulette is beside its target (the engine's 5-foot floor), 5 feet of movement spent.
  {
    const { A, D, a, d, engagement, lines } = apart('Bulette', 'Tough Boss', 15);
    const ev = e.createPairEvaluator(A, D, false);
    e.resolveOptionWithTeleport(A, D, a, d, leap, rolls(LOW), 0, engagement, lines, ev);
    assert.equal(engagement.distance, 5);
    assert.equal(a.movementPenalty, 5);
    assert.ok(d.conditions.some((c) => c.name === 'prone'));
  }
  // From 15 feet, a made save: pushed 5 feet from where the bulette landed, 5 + 5 = 10, not 15 + 5 = 20.
  {
    const { A, D, a, d, engagement, lines } = apart('Bulette', 'Tough Boss', 15);
    const ev = e.createPairEvaluator(A, D, false);
    e.resolveOptionWithTeleport(A, D, a, d, leap, rolls(HIGH), 0, engagement, lines, ev);
    assert.equal(engagement.distance, 10);
    assert.ok(!d.conditions.some((c) => c.name === 'prone'));
  }
});

test('PT02 control: a bulette with Speed 0 cannot make the jump, and its Bite compiles no jump', () => {
  const { A, D, a, d } = apart('Bulette', 'Tough Boss', 5);
  const leap = option('Bulette', 'Deadly Leap').action;
  assert.equal(e.actionTargetable(leap, A, D, 5, d, a), true);
  a.conditions.push({ name: 'grappled', duration: 'permanent', source: 1, appliedTurn: 0 } as any);
  assert.equal(e.actionTargetable(leap, A, D, 5, d, a), false);
  assert.equal((option('Bulette', 'Bite').action as any).jumpsToTarget, undefined);
  // p330 Shambling Mound Engulf: a save on a creature within 5 feet, no jump.
  assert.equal((option('Shambling Mound', 'Engulf').action as any).jumpsToTarget, undefined);
});

test('PT03 a Multiattack makes the attack its own grapple would bar before the attack that grapples', () => {
  // p363: "The tyrannosaurus makes one Bite attack and one Tail attack." Bite: "While Grappled, the target has the
  // Restrained condition and can't be targeted by the tyrannosaurus's Tail." No order is printed, so the Tail is made
  // first and both attacks are available on a creature not yet held. p350 Giant Crocodile prints the same pair.
  assert.deepEqual(routineNames('Tyrannosaurus Rex', 'Multiattack'), ['Tail', 'Bite']);
  assert.deepEqual(routineNames('Giant Crocodile', 'Multiattack'), ['Tail', 'Bite']);
  // In a fight: a turn that opens on a creature the Rex does not hold has both attacks.
  for (const seed of [1, 2, 3, 4]) {
    const log = fight(block('Tyrannosaurus Rex'), block('Clay Golem'), seed, true, 'max30').log;
    log.forEach((line, i) => {
      if (line !== 'Tyrannosaurus Rex uses Tail') return;
      const after = log.slice(i + 1, i + 8);
      const down = log.slice(i + 1).length < 4;
      assert.ok(down || after.includes('Tyrannosaurus Rex uses Bite'), `seed ${seed}, line ${i}: Tail with no Bite after it`);
    });
    assert.ok(log.includes('Tyrannosaurus Rex uses Tail'), `seed ${seed}: no Tail at all`);
  }
});

test('PT03 control: a grab with no barred partner keeps its printed order', () => {
  // p353 Giant Scorpion: "The scorpion makes two Claw attacks and one Sting attack." Claw grapples; nothing is barred.
  assert.deepEqual(routineNames('Giant Scorpion', 'Multiattack'), ['Claw', 'Sting']);
  // The Tail stays barred while the Bite's grapple holds.
  assert.deepEqual((option('Tyrannosaurus Rex', 'Tail').action as any).requiresTargetMissingConditions, ['grappled']);
});
