// The Fire Elemental's Fire Form: damage to a creature whose space it enters, once a turn. Each test is written from
// the printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
/** A Medium Humanoid bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d10 shows 1 + floor(value * 10). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
/** The end of the Fire Elemental's turn against `foe` at `distance`, every die showing 6; returns the log and the damage. */
function elementalTurnEnd(foe: CombatStatblock, distance: number, prepare?: (a: ReturnType<typeof e.initState>) => void) {
  const fire = block('Fire Elemental'), a = e.initState(fire), d = e.initState(foe), lines = new FightLog(true);
  prepare?.(a);
  const before = d.hp;
  e.endTurn([fire, foe], [a, d], 0, at(distance), rolls(0.5), lines);
  return { lines: lines.lines, lost: before - d.hp };
}

test('X01 Fire Form: the creature whose space the elemental enters takes 1d10 Fire damage', () => {
  // p.284: "it can enter a creature's space and stop there. The first time it enters a creature's space on a turn,
  // that creature takes 5 (1d10) Fire damage." Fire Aura (same page) adds 5 (1d10) at the end of the turn.
  assert.deepEqual(block('Fire Elemental').spaceEntry, { name: 'Fire Form', damage: [{ dice: { n: 1, d: 10, mod: 0 }, type: 'fire' }] });
  assert.ok(!block('Fire Elemental').skipped.some((s) => s.name === 'Fire Form'));
  // Beside the foe with its whole Speed of 50 unspent: Fire Form 6 + Fire Aura 6.
  const { lines, lost } = elementalTurnEnd(tank(), 5);
  assert.ok(lines.some((l) => /enters Guard's space \(Fire Form\)/.test(l)), lines.join('\n'));
  assert.equal(lost, 12);
});

test('X01 Fire Form is dealt once a turn', () => {
  // "The first time ... on a turn": one line, however much movement is left.
  const { lines } = elementalTurnEnd(tank(), 5);
  assert.equal(lines.filter((l) => /Fire Form/.test(l)).length, 1);
});

test('X01 control: no Fire Form without the movement to step in, or from 10 feet away', () => {
  // 45 of its 50 feet spent: 5 left, and the step out and back in takes 10. The aura still burns: 6.
  const spent = elementalTurnEnd(tank(), 5, (a) => { a.turnMoved = 45; });
  assert.ok(!spent.lines.some((l) => /Fire Form/.test(l)));
  assert.equal(spent.lost, 6);
  // Ten feet off at the end of its turn it is in no one's space; the 10-foot Fire Aura reaches: 6.
  const apart = elementalTurnEnd(tank(), 10);
  assert.ok(!apart.lines.some((l) => /Fire Form/.test(l)));
  assert.equal(apart.lost, 6);
});

test('X01 control: Fire Immunity takes nothing, and the forms that print no damage deal none', () => {
  assert.equal(elementalTurnEnd(tank({ immune: ['fire'] }), 5).lost, 0);
  // Air Form and Water Form (pp.283, 285) let the elemental enter a space and print no damage for it.
  for (const name of ['Air Elemental', 'Water Elemental', 'Invisible Stalker']) assert.equal(block(name).spaceEntry, undefined, name);
});
