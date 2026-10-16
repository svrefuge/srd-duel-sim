// Dispel Magic (V09). Each test carries the finding id Y01 and is
// written from the printed SRD 5.2.1 text: "Choose one creature, object, or magical effect within range. Any ongoing spell
// of level 3 or lower on the target ends. For each ongoing spell of level 4 or higher on the target, make an ability check
// using your spellcasting ability (DC 10 plus that spell's level)." (p.124)
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const DM = 'Dispel Magic';
const dispel = (monster: string) => option(monster, DM).action as { kind: string; dispels: { mod: number; range: number } };
/** A Medium Humanoid bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const LOW = 0, HIGH = 0.99;

/** A spell the foe (index 1) holds, or has put on the caster (index 0), at the level given. */
const spell = (name: string, spellLevel: number | undefined, source: 0 | 1, extra: Record<string, unknown> = {}) =>
  ({ name, spellLevel, source, duration: 'permanent' as const, appliedTurn: 0, magical: true, ...extra });

function duel(caster: string, foe: CombatStatblock = tank()) {
  const user = block(caster), a = e.initState(user), d = e.initState(foe);
  return { user, foe, a, d };
}
type Duel = ReturnType<typeof duel>;
const cast = (c: Duel, rng = rolls(LOW), distance = 30) => {
  const lines = log();
  e.resolveAction(c.user, c.foe, c.a, c.d, option(c.user.name, DM).action, rng, 0, distance, lines);
  return lines.lines;
};
const turn = (c: Duel, distance = 30) => {
  const lines = log();
  e.takeTurn([c.user, c.foe], [c.a, c.d], 0, rolls(0.5), at(distance), lines, e.createPairEvaluator(c.user, c.foe, true), false);
  return lines.lines;
};
const names = (state: { conditions: { name: string }[] }) => state.conditions.map((x) => x.name);

test('Y01 Dispel Magic is compiled for its six casters with their spellcasting modifier and a 120-foot range', () => {
  // Glabrezu p.289 "At Will: ... Dispel Magic"; Lich, Mummy Lord, Sphinx of Lore and Sphinx of Valor list it; the Priest's
  // Divine Aid (3/Day) is a Bonus Action (p.40966 of the text). Mods are Int 4, 5, 4 (Mummy Lord Wis), Wis 3, Int 4, Wis 6.
  const expected: Record<string, number> = { Glabrezu: 4, Lich: 5, 'Mummy Lord': 4, Priest: 3, 'Sphinx of Lore': 4, 'Sphinx of Valor': 6 };
  for (const [caster, mod] of Object.entries(expected)) {
    assert.deepEqual(dispel(caster).dispels, { mod, range: 120 }, caster);
    assert.equal(dispel(caster).kind, 'selfheal', caster);
    assert.deepEqual(block(caster).skipped.filter((s) => s.name === DM), [], caster);
  }
  assert.equal(option('Priest', DM).timing, 'bonus');
});

test('Y01 a spell carries the level it was cast at', () => {
  // Mage: Invisibility is level 2 and Fly level 3; Pit Fiend casts Hold Monster at level 7 (p.315).
  const level = (monster: string, name: string) => (option(monster, name).action as { spellLevel: number }).spellLevel;
  assert.equal(level('Mage', 'Invisibility'), 2);
  assert.equal(level('Mage', 'Fly'), 3);
  const hold = option('Pit Fiend', 'Hold Monster').action as { riders: { spellLevel: number }[] };
  assert.equal(hold.riders[0].spellLevel, 7);
});

test('Y01 Dispel Magic ends a level 3 or lower spell on the foe outright, whatever the roll', () => {
  const c = duel('Glabrezu');
  c.d.conditions.push(spell('invisible', 2, 1), spell('flying', 3, 1, { flySpeed: 60 }));
  const lines = cast(c, rolls(LOW));
  assert.deepEqual(names(c.d), [], lines.join('\n'));
  assert.ok(lines.some((l) => /Dispel Magic on .*invisible, flying ends/.test(l)), lines.join('\n'));
});

test('Y01 control: a condition that is not a spell, or one the caster cast itself, stays', () => {
  const c = duel('Glabrezu');
  // An innate Invisible (the Invisible Stalker) has no spell level; Hold Person the caster put on the foe is its own.
  c.d.conditions.push(spell('invisible', undefined, 1), spell('paralyzed', 2, 0));
  cast(c, rolls(LOW));
  assert.deepEqual(names(c.d), ['invisible', 'paralyzed']);
});

test('Y01 a level 4 or higher spell ends on a d20 plus the modifier against 10 plus its level', () => {
  // Glabrezu +4 against a level 7 spell: DC 17, so it needs a 13. A roll of 12 fails and 13 succeeds.
  const fail = duel('Glabrezu');
  fail.d.conditions.push(spell('mirrorImage', 7, 1));
  const failed = cast(fail, rolls(11 / 20 + 0.01));
  assert.deepEqual(names(fail.d), ['mirrorImage'], failed.join('\n'));
  assert.ok(failed.some((l) => /checks 16 against 17 to end mirrorImage/.test(l)), failed.join('\n'));
  const pass = duel('Glabrezu');
  pass.d.conditions.push(spell('mirrorImage', 7, 1));
  cast(pass, rolls(12 / 20 + 0.01));
  assert.deepEqual(names(pass.d), []);
});

test('Y01 a caster hampered by a spell of the foe dispels it from itself, not from the foe', () => {
  const c = duel('Priest');
  c.a.conditions.push(spell('charmed', 5, 1));
  c.d.conditions.push(spell('invisible', 2, 1));
  // Priest +3 against a level 5 spell: DC 15, a 12 needed; the high roll ends it.
  cast(c, rolls(HIGH));
  assert.deepEqual(names(c.a), []);
  assert.deepEqual(names(c.d), ['invisible']);
});

test('Y01 a Priest 30 feet from a foe hidden by a spell casts Dispel Magic and sees it', () => {
  const c = duel('Priest');
  c.d.conditions.push(spell('invisible', 2, 1, { breaksOnAttackOrSpell: false }));
  const lines = turn(c);
  assert.ok(lines.some((l) => /Dispel Magic/.test(l)), lines.join('\n'));
  assert.deepEqual(names(c.d), []);
});

test('Y01 control: nothing a spell put there, nothing to dispel', () => {
  const plain = duel('Priest');
  assert.ok(!turn(plain).some((l) => /Dispel Magic/.test(l)));
  // An Invisible with no spell level (innate) is not worth the action.
  const innate = duel('Priest');
  innate.d.conditions.push(spell('invisible', undefined, 1, { breaksOnAttackOrSpell: false }));
  assert.ok(!turn(innate).some((l) => /Dispel Magic/.test(l)));
  // And a foe beyond 120 feet is out of range.
  const far = duel('Priest');
  far.d.conditions.push(spell('invisible', 2, 1, { breaksOnAttackOrSpell: false }));
  assert.ok(!cast(far, rolls(LOW), 130).some((l) => /ends/.test(l)));
  assert.deepEqual(names(far.d), ['invisible']);
});

test('Y01 Fly dispelled while its holder is aloft: the holder falls', () => {
  // Fly p.133: "When the spell ends, the target falls if it is still aloft unless it can stop the fall."
  const c = duel('Glabrezu');
  const engagement = { ...e.startingEngagement('max120') }, lines = log();
  e.bindPlace([c.user, c.foe], [c.a, c.d], engagement);
  c.d.conditions.push(spell('flying', 3, 1, { flySpeed: 60, hover: true }));
  c.d.height = 40;
  e.resolveAction(c.user, c.foe, c.a, c.d, option('Glabrezu', DM).action, rolls(LOW), 0, 30, lines);
  e.settleAfterAction(c.user, c.foe, c.a, c.d, 0, engagement, rolls(LOW), lines);
  assert.ok(!names(c.d).includes('flying'));
  assert.equal(c.d.height, 0, lines.lines.join('\n'));
  assert.ok(c.d.hp < c.d.maxHp, lines.lines.join('\n'));
});
