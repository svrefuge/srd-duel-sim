// Pricing attacks on a Paralyzed creature and its failed Dexterity saves. Each test is written from the printed SRD
// 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight, srdMechanicsForTest as e } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const near = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);

/** `user`'s price for each of its options against `foe`, and its best routine, with `foe` under `condition` (or free). */
function prices(userName: string, foeName: string, distance: number, condition?: string) {
  const user = block(userName), foe = block(foeName), a = e.initState(user), d = e.initState(foe);
  const evaluator = e.createPairEvaluator(user, foe, true);
  if (condition) d.conditions.push({ name: condition, duration: 'saveEndsEachTurn', save: { ability: 'con', dc: 17 }, source: 0, appliedTurn: 0 } as any);
  const ev = (name: string) => e.dynamicEv(user.options.find((o) => o.name === name)!.action, user, foe, d, a, 0, distance, evaluator);
  return { ev, routine: e.bestUsableRoutinesAtDistance(user, foe, a, d, 0, distance, evaluator).any.routine?.name };
}

test('PU01 attacks on a Paralyzed creature are priced with the Advantage the condition gives them', () => {
  // p186, Paralyzed: "Attack rolls against you have Advantage." and "Any attack roll that hits you is a Critical Hit if
  // the attacker is within 5 feet of you." Nothing in it touches a Constitution save.
  // Young Silver Dragon (p324): Rend +10, 15 (2d8 + 6); Cold Breath Con DC 17, 49 (11d8), half on a success.
  // Young Red Dragon: AC 18, Con +5. Rend hits on an 8: 1 - 0.35^2 = 0.8775, each a critical 4d8 + 6 = 24, so three
  // Rends are 3 x 0.8775 x 24 = 63.2. The breath fails on an 11 or less: 49.5 x (0.55 + 0.45 / 2) = 38.4. Rend it is.
  const paralyzed = prices('Young Silver Dragon', 'Young Red Dragon', 5, 'paralyzed');
  assert.equal(paralyzed.routine, 'Multiattack (Rend)');
  const free = prices('Young Silver Dragon', 'Young Red Dragon', 5);
  assert.ok(paralyzed.ev('Rend') / free.ev('Rend') > paralyzed.ev('Cold Breath') / free.ev('Cold Breath'));
  // max30, seed 2: without the Paralyzed pricing, the Silver Dragon's turn after "falls paralyzed" would be a move
  // from 10 to 30 feet and a Cold Breath.
  const log = fight(block('Young Silver Dragon'), block('Young Red Dragon'), 2, true, 'max30').log;
  const fell = log.indexOf('Young Red Dragon falls paralyzed'), turn = log.slice(log.indexOf('Round 2', fell), log.indexOf('Round 3', fell));
  assert.ok(fell > 0 && turn.includes('Young Silver Dragon uses Rend') && !turn.includes('Young Silver Dragon uses Cold Breath'), turn.join(' / '));
});

test('PU01 control: Incapacitated alone gives attack rolls nothing, and attacks gain nothing on the breath', () => {
  // p184, Incapacitated: no Action, Bonus Action or Reaction, no Concentration, no speech, Disadvantage on Initiative.
  // No Advantage for attackers: Rend and Cold Breath keep the ratio they have against a free dragon.
  const free = prices('Young Silver Dragon', 'Young Red Dragon', 5), held = prices('Young Silver Dragon', 'Young Red Dragon', 5, 'incapacitated');
  near(held.ev('Rend') / free.ev('Rend'), held.ev('Cold Breath') / free.ev('Cold Breath'), 'Rend against Cold Breath');
});

test('PU02 a Dexterity save a Paralyzed creature cannot make is priced as failed', () => {
  // p186, Paralyzed: "You automatically fail Strength and Dexterity saving throws."
  // Young Red Dragon (p318): Fire Breath Dex DC 17, 56 (16d6), half on a success. Young Silver Dragon: Dex +4, so it
  // fails on a 12 or less: 56 x (0.6 + 0.4 / 2) = 44.8 rolled, 56 failed. 56 / 44.8 = 1.25 over the same breath on a
  // creature that is only Incapacitated.
  const paralyzed = prices('Young Red Dragon', 'Young Silver Dragon', 10, 'paralyzed'), held = prices('Young Red Dragon', 'Young Silver Dragon', 10, 'incapacitated');
  near(paralyzed.ev('Fire Breath') / held.ev('Fire Breath'), 56 / 44.8, 'Fire Breath');
});

test('PU02 control: a Constitution save is rolled as ever, and a Legendary Resistance still answers the failure', () => {
  // Cold Breath is a Constitution save: Paralyzed does nothing for it.
  const paralyzed = prices('Young Silver Dragon', 'Young Red Dragon', 10, 'paralyzed'), held = prices('Young Silver Dragon', 'Young Red Dragon', 10, 'incapacitated');
  near(paralyzed.ev('Cold Breath') / held.ev('Cold Breath'), 1, 'Cold Breath');
  // Adult Silver Dragon (p324): "Legendary Resistance (3/Day). If the dragon fails a saving throw, it can choose to
  // succeed instead." An automatic failure is a failure it can choose to succeed on.
  const legend = prices('Young Red Dragon', 'Adult Silver Dragon', 10, 'paralyzed'), legendHeld = prices('Young Red Dragon', 'Adult Silver Dragon', 10, 'incapacitated');
  near(legend.ev('Fire Breath') / legendHeld.ev('Fire Breath'), 1, 'Fire Breath against Legendary Resistance');
});
