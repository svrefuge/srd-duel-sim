// Aberrant Ground (finding V05). Written from the
// printed SRD 5.2.1 text: "Aberrant Ground. The ground in a 10-foot Emanation originating from the mouther is Difficult
// Terrain." (Gibbering Mouther, p288) and "Every foot of movement in Difficult Terrain costs 1 extra foot".
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const fixed = () => 0.5;

/** `moverName` walks from `from` feet toward `to` feet of `ownerName` on `budget` feet of movement; where it stops. */
function walk(moverName: string, ownerName: string, from: number, to: number, budget: number): number {
  const mover = block(moverName), owner = block(ownerName), m = e.initState(mover), o = e.initState(owner);
  const engagement = { ...e.startingEngagement('max600'), ground: from, distance: from };
  e.bindPlace([mover, owner], [m, o], engagement);
  // No opportunity attack in these walks: the owner has spent its Reaction.
  o.reactionUsed = true;
  e.applyMovement(mover, m, owner, o, 0, engagement, to, 0, fixed, new FightLog(false), e.createPairEvaluator(mover, owner, true), 'moves', false, budget);
  return engagement.ground;
}

test('V05 Aberrant Ground compiles for the Gibbering Mouther alone', () => {
  assert.deepEqual(block('Gibbering Mouther').difficultGround, { name: 'Aberrant Ground', radius: 10 });
  assert.deepEqual(blocks.filter((b) => b.difficultGround).map((b) => b.name), ['Gibbering Mouther']);
});

test('V05 a foe walking in pays 1 extra foot for each foot within 10 feet of the mouther', () => {
  // Commoner, Speed 30. From 30 feet: 20 feet to the edge of the ground, then 5 feet at double cost: 30, arriving at 5.
  assert.equal(walk('Commoner', 'Gibbering Mouther', 30, 5, 30), 5);
  // From 35 feet: 25 feet to the edge, and the last 5 feet would cost 10 with 5 left. It stops at 10 feet.
  assert.equal(walk('Commoner', 'Gibbering Mouther', 35, 5, 30), 10);
  // From 10 feet with 5 feet of movement: the step in costs 10.
  assert.equal(walk('Commoner', 'Gibbering Mouther', 10, 5, 5), 10);
});

test('V05 a foe walking out pays the same', () => {
  // From 5 feet: 5 feet of the ground at double cost (10), then 20 more: 30 feet away, not 35.
  assert.equal(walk('Commoner', 'Gibbering Mouther', 5, 35, 30), 30);
});

test('V05 control: the same walks beside a creature with no such trait cost 1 foot a foot', () => {
  assert.equal(walk('Commoner', 'Ogre', 35, 5, 30), 5);
  assert.equal(walk('Commoner', 'Ogre', 5, 35, 30), 35);
});

test('V05 control: a flier does not walk on the ground, and the mouther\'s own Speed stands', () => {
  // Giant Eagle, Fly 80 ft.: 35 feet to 5 on 30 feet of movement.
  assert.equal(walk('Giant Eagle', 'Gibbering Mouther', 35, 5, 30), 5);
  // The mouther (Speed 20) closing 20 feet on a Commoner.
  assert.equal(walk('Gibbering Mouther', 'Commoner', 25, 5, 20), 5);
});

test('V05 the foe plans with the cost: from 35 feet a Commoner cannot count on reaching the mouther this turn', () => {
  const mover = block('Commoner'), owner = block('Gibbering Mouther'), m = e.initState(mover);
  assert.equal(e.difficultGroundStop(mover, m, owner, 35, 5, 30), 10);
  assert.equal(e.difficultGroundStop(mover, m, owner, 30, 5, 30), 5);
  assert.equal(e.difficultGroundStop(mover, m, block('Ogre'), 35, 5, 30), 5);
});
