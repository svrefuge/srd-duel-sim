// Burning and putting it out, burning fliers, regurgitation damage, and a Hill Giant's step back. Each test is
// written from the printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

// Burning [Hazard], p. 178: "A burning creature or object takes 1d4 Fire
// damage at the start of each of its turns. As an action, you can extinguish fire on yourself by giving yourself the
// Prone condition and rolling on the ground."
const blocks = compileAll();
const block = (name: string) => blocks.find(b => b.name === name)!;
const tank = (): CombatStatblock => ({ ...block('Guard'), ac: 0, hpAvg: 1000, options: [], routines: [], reaction: undefined, counterspell: undefined });
const fixed = () => .4;

/** `victim` set burning by `source`'s named attack at 5 feet; returns whether it then spends its action on the fire. */
function burningChoice(source: CombatStatblock, attack: string, victim: CombatStatblock, foe: CombatStatblock = source, height = 0): boolean {
  const a = e.initState(source), b = e.initState(victim), log = new FightLog(true);
  const g = { ...e.startingEngagement('max600'), distance: 5, ground: 5 };
  e.resolveOptionWithTeleport(source, victim, a, b, source.options.find(o => o.name === attack)!.action, fixed, 0, g, log, e.createPairEvaluator(source, victim, true));
  assert.ok(b.conditions.some(c => c.name === 'burning'));
  b.height = height;
  return e.extinguishIfWorthwhile(victim, foe, b, a, 1, 5, e.createPairEvaluator(victim, foe, true), log);
}
/** The same creature with nothing that ignites. */
const spent = (b: CombatStatblock): CombatStatblock => ({ ...b, sourceTurnAura: undefined, options: [] });

test('S1 a creature keeps attacking a Magmin that will light it again on the next hit', () => {
  // Touch +4 against Ochre Jelly AC 8 hits 17 in 20. Fire-free turns ahead: 0.15 + 0.15^2 + 0.15^3 = 0.176, worth
  // 2.5 x 0.176 = 0.44 HP. Pseudopod +4 against AC 14 hits 11 in 20 for 12.5: 6.9. The attack is the better action.
  assert.equal(burningChoice(block('Magmin'), 'Touch', block('Ochre Jelly')), false);
});

test('S1 a creature inside an igniting emanation does not roll, since the aura relights it the same round', () => {
  // Fire Aura, p. 261 (Fire Elemental): "Creatures and flammable objects in the Emanation start burning." Nothing saved.
  assert.equal(burningChoice(block('Fire Elemental'), 'Burn', tank()), false);
});

test('S1 control: the same Ochre Jelly puts the fire out when the foe has nothing to relight it with', () => {
  // Three turns of 1d4 = 7.5 against the 6.9 its Pseudopod is worth.
  assert.equal(burningChoice(block('Magmin'), 'Touch', block('Ochre Jelly'), spent(block('Magmin'))), true);
});

test('S2 a burning creature in the air cannot roll on the ground', () => {
  assert.equal(burningChoice(block('Magmin'), 'Touch', tank(), spent(block('Magmin')), 20), false);
});

test('S2 control: the same creature on the ground extinguishes', () => {
  assert.equal(burningChoice(block('Magmin'), 'Touch', tank(), spent(block('Magmin')), 0), true);
});

// Swallow, p. 319-320 (Remorhaz): "it takes 10 (3d6) Acid damage plus 10 (3d6) Fire damage at the start of each of the
// remorhaz's turns. If the remorhaz takes 30 damage or more on a single turn from a creature inside it, the remorhaz
// must succeed on a DC 15 Constitution saving throw at the end of that turn or regurgitate all swallowed creatures".
// The save closes the victim's turn; the acid opens the remorhaz's, which comes after.
/** A swallowed tank deals `dealt` to the Remorhaz on its own turn, which then ends; every die and the save roll `roll`. */
function swallowedTurnEnd(dealt: number, roll: number) {
  const remorhaz = block('Remorhaz'), victim = tank();
  const a = e.initState(remorhaz), b = e.initState(victim), log = new FightLog(true);
  const swallow = remorhaz.options.find(o => o.name === 'Swallow')!.action;
  assert.equal(swallow.kind, 'save');
  if (swallow.kind !== 'save') throw new Error('unreachable');
  e.applyRiders(b, victim, a, swallow.riders!, 0, false, () => 0, log);
  assert.ok(b.conditions.some(c => c.name === 'swallowed'));
  b.turnCount = 1;
  e.dealDamage(victim, remorhaz, b, a, { kind: 'autohit', magical: false, damage: [{ dice: { n: 0, d: 1, mod: dealt }, type: 'force' }] }, () => roll, 1, false, log);
  e.endTurn([remorhaz, victim], [a, b], 1, { ...e.startingEngagement('max600'), distance: 0, ground: 0 }, () => roll, log);
  return { lost: 1000 - b.hp, swallowed: b.conditions.some(c => c.name === 'swallowed') };
}

test('S3 a creature regurgitated at the end of its turn takes no swallow damage on the way out', () => {
  // 30 dealt meets the threshold; the save rolls 1 + 5 = 6 against DC 15 and fails. Out before the remorhaz's turn: 0.
  assert.deepEqual(swallowedTurnEnd(30, 0), { lost: 0, swallowed: false });
});

test('S3 control: when the regurgitation save succeeds the swallow damage still lands', () => {
  // The save rolls 20 + 5 = 25 and succeeds; 3d6 + 3d6 at 6 a die is 36.
  assert.deepEqual(swallowedTurnEnd(30, .999), { lost: 36, swallowed: true });
});

test('S3 control: under the threshold there is no save and the swallow damage lands', () => {
  // 29 dealt, no save; 3d6 + 3d6 at 1 a die is 6.
  assert.deepEqual(swallowedTurnEnd(29, 0), { lost: 6, swallowed: true });
});

// Hill Giant, p. 298: Tree Club (reach 10 ft) knocks a Large or smaller target Prone; Trash Lob is the ranged attack.
// Opportunity Attacks: leaving a foe's reach provokes one. Stepping back to throw is only worth that attack if the foe
// cannot follow, and a foe that stood up from Prone on its last turn has its whole Speed again on its next.
/** The Hill Giant's turn at 5 feet from `foe`, which spent `spent` feet of its own last turn standing up. */
function giantTurn(foe: CombatStatblock, spent: number): string[] {
  const giant = block('Hill Giant');
  const a = e.initState(giant), b = e.initState(foe), log = new FightLog(true);
  b.movementPenalty = spent;
  e.takeTurn([giant, foe], [a, b], 0, fixed, { ...e.startingEngagement('max30'), distance: 5, ground: 5 }, log, e.createPairEvaluator(giant, foe, true), true);
  return log.lines;
}

test('S4 a Hill Giant does not walk out of reach of a foe that stood up last turn and can follow', () => {
  // Owlbear Speed 40 covers the 25 feet back in, so the step buys nothing and costs an opportunity attack.
  const lines = giantTurn(block('Owlbear'), 20);
  assert.ok(!lines.some(l => /opportunity attack|Hill Giant moves/.test(l)), lines.join('\n'));
  assert.ok(lines.includes('Hill Giant uses Tree Club'));
});

test('S4 control: it still steps back to throw when the foe is too slow to follow', () => {
  // The same Owlbear with Speed 20 cannot cover 25 feet; two Trash Lobs from 30 feet go unanswered.
  const lines = giantTurn({ ...block('Owlbear'), speed: 20 }, 0);
  assert.ok(lines.some(l => /Hill Giant moves \(5 ft -> 30 ft\)/.test(l)), lines.join('\n'));
});
