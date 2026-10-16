// A Petrified creature has Speed 0; a Stunned one does not. Each test is written from the printed SRD 5.2.1 text
// quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { srdMechanicsForTest as e } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const speedUnder = (name: string, condition: string) => {
  const b = block(name), s = e.initState(b);
  s.conditions.push({ name: condition, duration: 'permanent', source: 1, appliedTurn: 0 } as any);
  return e.currentSpeed(b, s);
};

test('RR01 a Petrified creature has Speed 0', () => {
  // Petrified (p. 186): "Incapacitated. You have the Incapacitated condition." and "Speed 0. Your Speed is 0 and
  // can't increase." Every petrification ends the duel today (`petrifiedDefeat`), so this pins the set, not a fight.
  assert.equal(speedUnder('Ogre', 'petrified'), 0);
});

test('RR01 control: Stunned prints no Speed 0, and the creature keeps its Speed', () => {
  // Stunned (p. 189) prints Incapacitated, failed Strength and Dexterity saves and Advantage against it, no Speed 0.
  assert.equal(speedUnder('Ogre', 'stunned'), 40);
  assert.equal(speedUnder('Ogre', 'paralyzed'), 0);
});
