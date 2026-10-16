// Greater Restoration for its four casters: one effect per casting, Charmed, a reduced score, Exhaustion levels. Each
// test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const action = (monster: string, name: string) => option(monster, name).action;
/** A Medium Humanoid bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const LOW = 0;
const GR = 'Greater Restoration';

/** A couatl and a tank at 5 ft, with the listed permanent conditions put on the couatl by the tank. */
function couatl(...conditions: string[]) { return couatlAgainst(tank(), ...conditions); }
function couatlAgainst(foe: CombatStatblock, ...conditions: string[]) {
  const user = block('Couatl'), a = e.initState(user), d = e.initState(foe);
  e.applyRiders(a, user, d, conditions.map((condition) => ({ condition, duration: 'permanent' as const })), 1, false, rolls(LOW), log());
  return { user, foe, a, d };
}
const turn = (c: ReturnType<typeof couatl>) => {
  const lines = log();
  e.takeTurn([c.user, c.foe], [c.a, c.d], 0, rolls(0.5), at(5), lines, e.createPairEvaluator(c.user, c.foe, true), false);
  return lines.lines;
};

test('U01 Greater Restoration is compiled for its four casters with the effects the spell lists', () => {
  // p.137: "You touch a creature and magically remove one of the following effects from it: 1 Exhaustion level; The
  // Charmed or Petrified condition; A curse ...; Any reduction to one of the target's ability scores; Any reduction to
  // the target's Hit Point maximum". Couatl p.277-278, "1/Day Each: ... Greater Restoration".
  for (const caster of ['Couatl', 'Adult Copper Dragon', 'Ancient Copper Dragon', 'Sphinx of Valor']) {
    const a = action(caster, GR) as { kind: string; curesConditions: string[]; restoresAbilityScores: boolean };
    assert.equal(a.kind, 'selfheal', caster);
    assert.deepEqual(a.curesConditions, ['exhaustion', 'charmed', 'petrified', 'cursed'], caster);
    assert.equal(a.restoresAbilityScores, true, caster);
    assert.deepEqual(block(caster).skipped.filter((s) => s.name === GR), [], caster);
  }
  assert.equal((option('Couatl', GR).uses as { max: number }).max, 1);
  assert.notEqual(option('Couatl', GR).timing, 'bonus'); // an action of Spellcasting, not Divine Aid
});

test('U01 a Charmed couatl casts Greater Restoration on itself and is no longer Charmed', () => {
  const c = couatl('charmed');
  const lines = turn(c);
  assert.ok(lines.some((line) => /Greater Restoration/.test(line)), lines.join('\n'));
  assert.ok(lines.includes('Couatl is no longer charmed'), lines.join('\n'));
  assert.deepEqual(c.a.conditions.filter((x) => x.name === 'charmed'), []);
  // 1/Day: Charmed again, it has no second casting.
  e.applyRiders(c.a, c.user, c.d, [{ condition: 'charmed', duration: 'permanent' }], 1, false, rolls(LOW), log());
  assert.ok(!turn(c).some((line) => /Greater Restoration/.test(line)));
  assert.ok(c.a.conditions.some((x) => x.name === 'charmed'));
});

test('U01 control: a couatl with nothing to remove does not cast it, and does something else', () => {
  const c = couatl();
  const lines = turn(c);
  assert.ok(!lines.some((line) => /Greater Restoration/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /^Couatl uses /.test(line)), lines.join('\n'));
});

test('U01 one effect a casting: Charmed first, then a drained Strength score', () => {
  // A Shadow's drain (p.323) lowers Strength; "Any reduction to one of the target's ability scores" restores it.
  const c = couatl('charmed');
  c.a.drainedScores.str = 4; // printed 16
  e.resolveAction(c.user, c.foe, c.a, c.d, action('Couatl', GR), rolls(LOW), 0, 5, log());
  assert.deepEqual(c.a.conditions.filter((x) => x.name === 'charmed'), []);
  assert.equal(c.a.drainedScores.str, 4);
  const lines = log();
  e.resolveAction(c.user, c.foe, c.a, c.d, action('Couatl', GR), rolls(LOW), 0, 5, lines);
  assert.deepEqual(c.a.drainedScores, {});
  assert.deepEqual(lines.lines, ["Couatl's ability scores are restored"]);
});

test('U01 a couatl whose Strength is drained from 16 to 4 spends its action on Greater Restoration', () => {
  // Three quarters of the way to death at 0: priced at 0.75 of its remaining hit points (0.75 x 60 = 45), more than a
  // turn of attacks on the Shadow that drained it.
  const c = couatlAgainst(block('Shadow'));
  c.a.drainedScores.str = 4;
  const lines = turn(c);
  assert.ok(lines.some((line) => /Greater Restoration/.test(line)), lines.join('\n'));
  assert.deepEqual(c.a.drainedScores, {});
});

test('U01 control: an Exhaustion level is removed one at a time, and Lesser Restoration ends none of these', () => {
  const c = couatl('exhaustion', 'exhaustion');
  e.resolveAction(c.user, c.foe, c.a, c.d, action('Couatl', GR), rolls(LOW), 0, 5, log());
  assert.equal(c.a.conditions.filter((x) => x.name === 'exhaustion').length, 1);
  const d = couatl('charmed');
  d.a.drainedScores.str = 4;
  e.resolveAction(d.user, d.foe, d.a, d.d, action('Couatl', 'Lesser Restoration'), rolls(LOW), 0, 5, log());
  assert.ok(d.a.conditions.some((x) => x.name === 'charmed'));
  assert.equal(d.a.drainedScores.str, 4);
});
