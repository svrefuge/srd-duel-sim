// The Sphinx of Valor's Roar choices and the Succubus's Draining Kiss in a Multiattack. Each test is written from the
// printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
/** A Medium Humanoid bystander with 1000 hit points and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });

/** `turns` turns of a Sphinx of Valor beside `foe`, every die showing its middle face; returns the Roar lines and the damage dealt. */
function sphinxTurns(foe: CombatStatblock, turns: number) {
  const sphinx = block('Sphinx of Valor'), a = e.initState(sphinx), d = e.initState(foe), log = new FightLog(true);
  const evaluator = e.createPairEvaluator(sphinx, foe, true), engagement = at(5);
  for (let i = 0; i < turns; i++) e.takeTurn([sphinx, foe], [a, d], 0, () => 0.5, engagement, log, evaluator, false);
  return { roars: log.lines.filter((l) => /uses Roar/.test(l)).map((l) => l.replace(/^.*: /, '')), lost: 1000 - d.hp, lines: log.lines };
}

test('L6-05 a Sphinx of Valor roars at a foe its first two roars cannot touch, and reaches the third', () => {
  // p328, Multiattack: "The sphinx makes two Claw attacks and uses Roar." Roar (3/Day): "Whenever it roars, the roar
  // has a different effect, as detailed below". First Roar: Frightened. Second Roar: Paralyzed. Third Roar:
  // "Constitution Saving Throw: DC 20 ... Failure: 44 (8d10) Thunder damage, and the target has the Prone condition."
  // Against a foe immune to Frightened and Paralyzed the first two do nothing, and the third is still owed:
  // six Claws at 4d6 + 6 with every d6 a 4 are 6 x 22 = 132; a Guard's Constitution save is 11 + 1 = 12 against DC 20,
  // so 8d10 with every d10 a 6 is 48. Total 180.
  const { roars, lost, lines } = sphinxTurns(tank({ conditionImmune: ['frightened', 'paralyzed'] }), 3);
  assert.deepEqual(roars, ['First Roar', 'Second Roar', 'Third Roar'], lines.join('\n'));
  assert.equal(lost, 180);
});

test('L6-05 control: three roars a day, so the fourth Multiattack is two Claws alone', () => {
  const { roars } = sphinxTurns(tank({ conditionImmune: ['frightened', 'paralyzed'] }), 4);
  assert.equal(roars.length, 3);
});

test('L6-05 control: a foe the First Roar can frighten is roared at for that', () => {
  const { roars, lines } = sphinxTurns(tank(), 1);
  assert.deepEqual(roars, ['First Roar']);
  assert.ok(lines.some((l) => /Guard gains frightened/.test(l)), lines.join('\n'));
});

/** One Succubus turn beside a Guard-like tank it has Charmed (a charm any damage ends: the repeat save is DC 1). */
function succubusTurn() {
  const succubus = block('Succubus'), foe = tank(), a = e.initState(succubus), d = e.initState(foe), log = new FightLog(true);
  d.conditions.push({ name: 'charmed', duration: 'permanent', source: 0, appliedTurn: 0, save: { ability: 'wis', dc: 1 }, saveOnDamage: true });
  e.takeTurn([succubus, foe], [a, d], 0, () => 0.5, at(5), log, e.createPairEvaluator(succubus, foe, true), false);
  return { uses: log.lines.filter((l) => /^Succubus uses /.test(l)).map((l) => l.replace('Succubus uses ', '')), lost: 1000 - d.hp, lines: log.lines };
}

test('L6-08 a Succubus kisses the creature it has Charmed before its touch can end the charm', () => {
  // p331, Multiattack: "The succubus makes one Fiendish Touch attack and uses Charm or Draining Kiss." Draining Kiss:
  // "Constitution Saving Throw: DC 15, one creature Charmed by the succubus within 5 feet. Failure: 13 (3d8) Psychic
  // damage." Dominate Person (p126): "Whenever the target takes damage, it repeats the save". The Multiattack sets no
  // order, so the Kiss comes while the charm still stands: 3d8 with every d8 a 5 is 15 (Constitution save 12 v DC 15),
  // then the Touch, 11 + 7 = 18 against AC 16, 2d10 + 5 with every d10 a 6 is 17. Total 32, not the Touch's 17 alone.
  const { uses, lost, lines } = succubusTurn();
  assert.deepEqual(uses, ['Draining Kiss', 'Fiendish Touch'], lines.join('\n'));
  assert.equal(lost, 32);
});

test('L6-08 control: a part whose condition another part of the Multiattack gives keeps its printed place', () => {
  // Vampire Spawn (p334): the Bite needs a creature that is Grappled, and the Claw is what grapples. Glabrezu (p289):
  // Pummel needs a creature the Pincer grappled.
  const order = (name: string, routine: string) => {
    const b = block(name);
    return b.routines.find((r) => r.name === routine)!.parts.map((p) => b.options[p.optionIdx].name);
  };
  assert.deepEqual(order('Vampire Spawn', 'Multiattack (Claw)'), ['Claw', 'Bite']);
  assert.deepEqual(order('Glabrezu', 'Multiattack (Pincer) + Pummel'), ['Pincer', 'Pummel']);
  assert.deepEqual(order('Succubus', 'Multiattack (Fiendish Touch) + Dominate Person'), ['Fiendish Touch', 'Dominate Person']);
});
