// Held creatures escaping or hitting back, Fly at Speed 0, Invisibility against a swallower, chargers backing off,
// and verbose-log lines. Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in
// the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight, srdMechanicsForTest as e } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const near = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);
const log = (a: string, b: string, seed: number, scenario: 'max30' | 'max600') => fight(block(a), block(b), seed, true, scenario).log;

/** Whether `held`, in the hold `holder`'s option `grab` puts on it at `distance` feet, tries to get out of it. */
function escapes(heldName: string, holderName: string, grab: string, distance: number): boolean {
  const held = block(heldName), holder = block(holderName), a = e.initState(held), d = e.initState(holder);
  const engagement = { ...e.startingEngagement('max30'), distance, ground: distance };
  const action = holder.options.find((o) => o.name === grab)!.action as any;
  e.applyRiders(a, held, d, action.riders, 1, false, () => 0.5, { on: false, push() {} } as any, true);
  assert.ok(a.conditions.some((c) => c.name === 'grappled'), `${heldName} is not held`);
  return e.escapeWorthwhile(held, holder, a, d, engagement, e.createPairEvaluator(held, holder, true));
}

test('OL01 a held creature that can hit its holder does not escape to a square the holder walks back to', () => {
  // p350 Giant Crocodile, Bite: "the target has the Grappled condition (escape DC 15) ... Restrained"; Speed 30 ft.,
  // reach 5 ft. p282 Earth Elemental, Slam: "+8, reach 10 ft. Hit: 14 (2d8 + 5)", two a turn; Athletics +5.
  // Staying: two Slams at Disadvantage. Leaving: an action on a 55% check (11 or more on the d20), and the square it
  // buys, 10 feet off, is one the crocodile's Speed covers before it bites again. The elemental attacks.
  assert.equal(escapes('Earth Elemental', 'Giant Crocodile', 'Bite', 5), false);
  for (const seed of [1, 2, 3]) assert.ok(!log('Earth Elemental', 'Giant Crocodile', seed, 'max30').some((line) => line.startsWith('Earth Elemental fails to escape')), `seed ${seed}`);
});

test('OL01 control: a held creature with nothing it can do from where it stands still tries to get out', () => {
  // Chuul, Pincer: "reach 10 ft. ... Grappled condition (escape DC 14)". Brown Bear: Bite and Claw, "reach 5 ft.",
  // and nothing ranged. Held at 10 feet the bear reaches nothing: any chance of getting out beats none.
  assert.equal(escapes('Brown Bear', 'Chuul', 'Pincer', 10), true);
});

test('OL02 Fly is not cast by a creature whose Speed is held at 0', () => {
  // p181, Grappled: "Speed 0. Your Speed is 0 and can't increase." Fly gives a Fly Speed of 60 feet: no use to it.
  // Vampire against Rakshasa, max30, seed 1: Grappled in round 1, the Rakshasa must not cast Fly.
  const lines = log('Vampire', 'Rakshasa', 1, 'max30');
  const round1 = lines.slice(0, lines.indexOf('Round 2'));
  assert.ok(round1.includes('Rakshasa gains grappled'));
  assert.ok(!round1.includes('Rakshasa uses Fly'), round1.join(' / '));
});

test('OL02 control: a Rakshasa nothing holds still casts Fly over a foe on the ground', () => {
  const lines = log('Rakshasa', 'Storm Giant', 1, 'max30');
  assert.ok(lines.includes('Rakshasa uses Fly'));
  assert.ok(!lines.slice(0, lines.indexOf('Rakshasa uses Fly')).includes('Rakshasa gains grappled'));
});

/** The Djinni's price for Invisibility against a Behir beside it, swallowed or not. */
function invisibility(swallowed: boolean): number {
  const user = block('Djinni'), foe = block('Behir'), a = e.initState(user), d = e.initState(foe);
  if (swallowed) a.conditions.push({ name: 'swallowed', duration: 'permanent', source: 1, appliedTurn: 0 } as any);
  return e.dynamicEv(user.options.find((o) => o.name === 'Invisibility')!.action, user, foe, d, a, 0, 5, e.createPairEvaluator(user, foe, true));
}

test('OL03 Invisibility is worth nothing to a creature its foe has swallowed', () => {
  // p263 Behir, Swallow: "While swallowed, a creature has the Blinded and Restrained conditions, has Total Cover
  // against attacks and other effects outside the behir, and takes 21 (6d6) Acid damage at the start of each of the
  // behir's turns." No attack roll is made against it there, so being unseen blunts nothing.
  assert.equal(invisibility(true), 0);
});

test('OL03 control: outside the Behir, Invisibility keeps its price', () => {
  assert.ok(invisibility(false) > 0);
});

test('OL04 a charger with Speed to spare and nothing to provoke backs off and comes in again', () => {
  // p348 Elk, Ram: "If the target is a Large or smaller creature and the elk moved 20+ feet straight toward it
  // immediately before the hit, the target takes an extra 3 (1d6) Bludgeoning damage and has the Prone condition."
  // Speed 50 ft. The Dretch (reach 5 ft.) has walked to 10 feet: out to 30 and back to 5 is 45 feet, a 25-foot
  // run-up, and leaving a square outside its reach provokes nothing.
  // Seed 2: on seed 1 the Ram is a Critical Hit that kills the Dretch, and a creature the hit killed is not knocked Prone (F09).
  const lines = log('Dretch', 'Elk', 2, 'max30');
  const out = lines.indexOf('Elk moves (10 ft -> 30 ft)');
  assert.ok(out > 0, lines.slice(0, 12).join(' / '));
  assert.deepEqual(lines.slice(out + 1, out + 3), ['Elk moves (30 ft -> 5 ft)', 'Elk uses Ram']);
  assert.ok(lines.slice(out + 3, out + 7).includes('Dretch gains prone'));
});

test('OL04 control: it does not walk out of a foe\'s reach to do it', () => {
  // Beside a Black Bear (reach 5 ft.), the way out provokes an Opportunity Attack: the Elk stays and Rams.
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    assert.ok(!log('Elk', 'Black Bear', seed, 'max30').some((line) => /^Elk moves \(5 ft -> \d\d/.test(line)), `seed ${seed}`);
  }
});

/** `user`'s price for `option` against `foe` at 10 feet, with `foe` under `condition` (or free). */
function price(userName: string, foeName: string, option: string, condition?: string): number {
  const user = block(userName), foe = block(foeName), a = e.initState(user), d = e.initState(foe);
  if (condition) d.conditions.push({ name: condition, duration: 'permanent', source: 0, appliedTurn: 0 } as any);
  return e.dynamicEv(user.options.find((o) => o.name === option)!.action, user, foe, d, a, 0, 10, e.createPairEvaluator(user, foe, true));
}

test('OL05 a Dexterity save by a Restrained creature is priced at Disadvantage', () => {
  // p187, Restrained: "You have Disadvantage on Dexterity saving throws."
  // Young Red Dragon (p318): Fire Breath Dex DC 17, 56 (16d6), half on a success. Young Silver Dragon: Dex +4, fails
  // on a 12 or less (0.6); the worse of two d20s fails 1 - 0.4^2 = 0.84. 56 x (0.84 + 0.16 / 2) = 51.52 against
  // 56 x (0.6 + 0.4 / 2) = 44.8.
  near(price('Young Red Dragon', 'Young Silver Dragon', 'Fire Breath', 'restrained') / price('Young Red Dragon', 'Young Silver Dragon', 'Fire Breath'), 51.52 / 44.8, 'Fire Breath');
});

test('OL05 control: Restrained does nothing to a Constitution save', () => {
  // Young Silver Dragon (p324): Cold Breath, Constitution Saving Throw.
  near(price('Young Silver Dragon', 'Young Red Dragon', 'Cold Breath', 'restrained') / price('Young Silver Dragon', 'Young Red Dragon', 'Cold Breath'), 1, 'Cold Breath');
});

test('OL06 the verbose log names a Critical Hit, a recharge and a turn with nothing to do', () => {
  // Tyrannosaurus Rex against Clay Golem, max30, seed 10: a Tail that is a Critical Hit.
  const rex = log('Tyrannosaurus Rex', 'Clay Golem', 10, 'max30');
  const crit = rex.indexOf('Tyrannosaurus Rex scores a Critical Hit');
  assert.ok(crit > 0 && rex[crit - 1] === 'Tyrannosaurus Rex uses Tail' && /^Clay Golem takes \d+ damage/.test(rex[crit + 1]));
  // p329 Sphinx of Lore: "Mind-Rending Roar (Recharge 5-6)".
  assert.ok(log('Mage', 'Sphinx of Lore', 6, 'max600').includes('Sphinx of Lore recharges Mind-Rending Roar'));
  // Lich against Frost Giant, max600, seed 13: the Giant is Paralyzed and has no action to take.
  const held = log('Lich', 'Frost Giant', 13, 'max600');
  assert.ok(held.includes('Frost Giant gains paralyzed') && held.includes('Frost Giant does nothing on its turn'));
});

test('OL06 a save that deals no damage logs none, and damage a creature is immune to still logs 0', () => {
  // Chuul, Paralyzing Tentacles: "Constitution Saving Throw: DC 13 ... Failure: The target has the Poisoned condition"
  // and no damage.
  assert.ok(!log('Chuul', 'Succubus', 2, 'max600').some((line) => line.startsWith('Succubus takes 0 damage')));
  // Control: the Pit Fiend, immune to Fire, in the Balor's Fire Aura.
  assert.ok(log('Pit Fiend', 'Balor', 1, 'max30').some((line) => line.startsWith('Pit Fiend takes 0 damage')));
});
