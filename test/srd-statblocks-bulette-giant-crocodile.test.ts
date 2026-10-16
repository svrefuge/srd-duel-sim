// Printed mechanics of the Bulette to Giant Crocodile stat blocks. Each test is written from the printed SRD 5.2.1
// text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatAction, CombatStatblock, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const action = (monster: string, name: string) => option(monster, name).action;
const riders = (monster: string, name: string): Rider[] => (action(monster, name) as { riders: Rider[] }).riders;
/** A Medium bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const HIGH = 0.9, LOW = 0;

/** One use of an option from `distance`, every die showing `roll`; returns where the two creatures end up and what the target holds. */
function use(monster: string, name: string, distance: number, roll: number, foe: CombatStatblock = tank()) {
  const user = block(monster), a = e.initState(user), d = e.initState(foe), engagement = at(distance);
  e.resolveOptionWithTeleport(user, foe, a, d, action(monster, name), rolls(roll), 0, engagement, log(), e.createPairEvaluator(user, foe, true));
  return { distance: engagement.distance, held: d.conditions.map((c) => c.name), d, a };
}

test('G01 Cultist Ritual Sickle: a hit deals 1 Necrotic damage on top of the 1d4 + 1 Slashing', () => {
  // p.278: "Hit: 3 (1d4 + 1) Slashing damage plus 1 Necrotic damage." A d4 showing 4: 4 + 1 + 1 = 6.
  assert.deepEqual((action('Cultist', 'Ritual Sickle') as { damage: unknown }).damage,
    [{ dice: { n: 1, d: 4, mod: 1 }, type: 'slashing' }, { dice: { n: 0, d: 1, mod: 1 }, type: 'necrotic' }]);
  assert.equal(1000 - use('Cultist', 'Ritual Sickle', 5, HIGH).d.hp, 6);
});

test('G01 control: a target immune to Necrotic damage takes only the Slashing, and a one-type hit keeps one clause', () => {
  assert.equal(1000 - use('Cultist', 'Ritual Sickle', 5, HIGH, tank({ immune: ['necrotic'] })).d.hp, 5);
  assert.equal((action('Guard', 'Spear') as { damage: unknown[] }).damage.length, 1);
});

test('G02 Frost Giant War Cry: the giant has Advantage on attack rolls until the start of its next turn', () => {
  // p.286: "... gains 16 (2d10 + 5) Temporary Hit Points and has Advantage on attack rolls until the start of the giant's
  // next turn." With Advantage a first d20 of 1 and a second of 19 hits (19 + 9 against AC 16).
  const giant = block('Frost Giant'), foe = tank(), a = e.initState(giant), d = e.initState(foe);
  e.resolveAction(giant, foe, a, d, action('Frost Giant', 'War Cry'), rolls(0.5), 0, 5, log());
  assert.ok(a.tempHp > 0);
  assert.deepEqual(a.conditions.map((c) => [c.name, c.duration, c.source]), [['attackAdvantage', 'startOfSourceNextTurn', 0]]);
  e.resolveAction(giant, foe, a, d, action('Frost Giant', 'Frost Axe'), rolls(LOW, HIGH), 0, 5, log());
  assert.ok(d.hp < 1000);
});

test('G02 control: without War Cry the same two dice are one roll of 1, a miss', () => {
  const giant = block('Frost Giant'), foe = tank(), a = e.initState(giant), d = e.initState(foe);
  e.resolveAction(giant, foe, a, d, action('Frost Giant', 'Frost Axe'), rolls(LOW, HIGH), 0, 5, log());
  assert.equal(d.hp, 1000);
});

test('G03 Fire Giant Hammer Throw: a hit pushes the target up to 15 feet straight away', () => {
  // p.285: "... and the target is pushed up to 15 feet straight away from the giant and has Disadvantage on the next
  // attack roll it makes before the end of its next turn." Hit at 30 ft: 30 + 15 = 45 ft.
  assert.equal(use('Fire Giant', 'Hammer Throw', 30, HIGH).distance, 45);
});

test('G03 control: a miss pushes nobody, and Flame Sword prints no push', () => {
  assert.equal(use('Fire Giant', 'Hammer Throw', 30, LOW).distance, 30);
  assert.equal(riders('Fire Giant', 'Flame Sword').some((r) => r.push), false);
});

/** The lines of one Giant Crocodile turn against a target its Bite has (or, too big, has not) grappled. */
function crocodileTurn(size: number) {
  const croc = block('Giant Crocodile'), foe = tank({ size }), a = e.initState(croc), d = e.initState(foe), lines = log();
  e.resolveAction(croc, foe, a, d, action('Giant Crocodile', 'Bite'), rolls(HIGH), 0, 5, log());
  e.takeTurn([croc, foe], [a, d], 0, rolls(HIGH), at(5), lines, e.createPairEvaluator(croc, foe, true));
  const tail = lines.lines.findIndex((l) => /\bTail\b/.test(l)), released = lines.lines.findIndex((l) => l.includes('lets go of'));
  return { grappled: d.conditions.some((c) => c.name === 'grappled'), bite: lines.lines.some((l) => /\bBite\b/.test(l)), tail: tail >= 0, released: released >= 0 && released < tail };
}

test('G04 Giant Crocodile: a target its Bite holds Grappled cannot be targeted by its Tail', () => {
  // p.350: "While Grappled, the target has the Restrained condition and can't be targeted by the crocodile's Tail."
  assert.deepEqual((action('Giant Crocodile', 'Tail') as { requiresTargetMissingConditions?: string[] }).requiresTargetMissingConditions, ['grappled']);
  assert.deepEqual((action('Tyrannosaurus Rex', 'Tail') as { requiresTargetMissingConditions?: string[] }).requiresTargetMissingConditions, ['grappled']);
  // It makes the Tail attack only after it has let go (H04: "the grappler can release the target at any time", p.182),
  // and the Bite that follows takes the hold again.
  assert.deepEqual(crocodileTurn(2), { grappled: true, bite: true, tail: true, released: true });
});

test('G04 control: a Huge target is not Grappled by the Bite and takes the Tail as well', () => {
  assert.deepEqual(crocodileTurn(4), { grappled: false, bite: true, tail: true, released: false });
});

test('G05 Thunderwave: a failed save pushes the creature 10 feet away', () => {
  // p.169: "On a failed save, a creature takes 2d8 Thunder damage and is pushed 10 feet away from you. On a successful
  // save, a creature takes half as much damage only." Failed at 5 ft: 5 + 10 = 15 ft.
  assert.equal(use('Druid', 'Thunderwave', 5, LOW).distance, 15);
});

test('G05 control: a successful save takes the half damage and is not pushed', () => {
  const saved = use('Druid', 'Thunderwave', 5, 0.99);
  assert.equal(saved.distance, 5);
  assert.ok(saved.d.hp < 1000);
});

test('G06 Dretch Fetid Cloud: the Poisoned creature takes an action or a Bonus Action, not both, and no Reactions', () => {
  // p.281: "While Poisoned, the creature can take either an action or a Bonus Action on its turn, not both, and it can't
  // take Reactions."
  const held = use('Dretch', 'Fetid Cloud (1/Day)', 5, LOW).d.conditions;
  assert.deepEqual(held.map((c) => [c.name, c.duration, c.actionOrBonus, c.noReactions]), [['poisoned', 'endOfTargetNextTurn', true, true]]);
});

test('G06 control: a Poisoned condition printed without that sentence carries neither limit', () => {
  const poisoned = riders('Chuul', 'Paralyzing Tentacles').find((r) => r.condition === 'poisoned')!;
  assert.equal(poisoned.actionOrBonus, undefined);
  assert.equal(poisoned.noReactions, undefined);
});

test('G07 Bulette Deadly Leap: a successful save is pushed 5 feet straight away', () => {
  // p.272: "Failure: 19 (3d12) Bludgeoning damage, and the target has the Prone condition. Success: Half damage, and the
  // target is pushed 5 feet straight away from the bulette." Saved at 5 ft: 5 + 5 = 10 ft, not Prone.
  assert.deepEqual((({ distance, held }) => ({ distance, held }))(use('Bulette', 'Deadly Leap', 5, 0.99)), { distance: 10, held: [] });
});

test('G07 control: a failed save is knocked Prone where it stands', () => {
  assert.deepEqual((({ distance, held }) => ({ distance, held }))(use('Bulette', 'Deadly Leap', 5, LOW)), { distance: 5, held: ['prone'] });
});

test('G08 Chain Devil Conjure Infernal Chain: a failed save moves a Large or smaller target up to 30 feet toward the devil', () => {
  // p.273: "If the target is Large or smaller, the devil moves the target up to 30 feet straight toward itself." Failed at
  // 40 ft: 40 - 30 = 10 ft.
  const failed = use('Chain Devil', 'Conjure Infernal Chain', 40, LOW);
  assert.equal(failed.distance, 10);
  assert.ok(failed.held.includes('restrained'));
});

test('G08 control: a Huge target is Restrained but not moved, and a successful save is neither', () => {
  const huge = use('Chain Devil', 'Conjure Infernal Chain', 40, LOW, tank({ size: 4 }));
  assert.equal(huge.distance, 40);
  assert.ok(huge.held.includes('restrained'));
  assert.deepEqual((({ distance, held }) => ({ distance, held }))(use('Chain Devil', 'Conjure Infernal Chain', 40, 0.99)), { distance: 40, held: [] });
});

/** Two Death Dog bites that hit, every save failed and every die showing 1. */
function bittenTwice(foe: CombatStatblock) {
  const dog = block('Death Dog'), a = e.initState(dog), d = e.initState(foe), bite = action('Death Dog', 'Bite');
  e.resolveAction(dog, foe, a, d, bite, rolls(HIGH, LOW), 0, 5, log());
  const afterFirst = d.maxHp;
  e.resolveAction(dog, foe, a, d, bite, rolls(HIGH, LOW), 0, 5, log());
  return { afterFirst, afterSecond: d.maxHp, poisoned: d.conditions.some((c) => c.name === 'poisoned') };
}

test('G09 Death Dog Bite: a failed save by a target already Poisoned lowers its Hit Point maximum by 1d10', () => {
  // p.279: "First Failure: The target has the Poisoned condition. ... Subsequent Failures: The Poisoned target's Hit Point
  // maximum decreases by 5 (1d10)." The d10 shows 1: 1000 after the first failure, 999 after the second.
  assert.deepEqual(bittenTwice(tank()), { afterFirst: 1000, afterSecond: 999, poisoned: true });
});

test('G09 control: a target that cannot be Poisoned never has its maximum lowered', () => {
  assert.deepEqual(bittenTwice(tank({ conditionImmune: ['poisoned'] })), { afterFirst: 1000, afterSecond: 1000, poisoned: false });
});

/** Darkmantle Crush hits in a row on one target; the conditions the target holds after each. */
function crushed(size: number) {
  const mantle = block('Darkmantle'), foe = tank({ size }), a = e.initState(mantle), d = e.initState(foe), out: string[][] = [];
  for (let i = 0; i < 2; i++) {
    e.resolveAction(mantle, foe, a, d, action('Darkmantle', 'Crush'), rolls(HIGH), 0, 5, log());
    out.push(d.conditions.map((c) => c.name).sort());
  }
  return out;
}

test('G10 Darkmantle Crush: it covers the target only on a hit made with Advantage', () => {
  // p.279: "If the target is a Medium or smaller creature and the darkmantle had Advantage on the attack roll, it covers
  // the target, which has the Blinded condition". The first hit has no Advantage and only attaches; attached, the
  // darkmantle "has Advantage on its attack rolls", so the second hit covers.
  assert.deepEqual(crushed(2), [['attached'], ['attached', 'blinded']]);
});

test('G10 control: a Large target is never covered', () => {
  assert.deepEqual(crushed(3), [['attached'], ['attached']]);
});

test('G12 a save repeated each turn that "succeeds automatically" after 1 minute ends after ten rounds', () => {
  // Chuul p.274 and Doppelganger p.280: "After 1 minute, it succeeds automatically." A minute is ten rounds.
  assert.deepEqual(riders('Chuul', 'Paralyzing Tentacles').map((r) => r.rounds), [10, 10]);
  const frightened = use('Doppelganger', 'Unsettling Visage', 5, LOW).d.conditions.find((c) => c.name === 'frightened')!;
  assert.equal(frightened.endsSourceTurn, 10);
});

test('G12 control: a repeated save printed without that sentence has no clock', () => {
  const unclocked = blocks.flatMap((b) => b.options).filter((o) => !/After 1 minute, it succeeds automatically/.test(o.sourceText))
    .flatMap((o) => 'riders' in o.action ? o.action.riders ?? [] : []).filter((r) => r.duration === 'saveEndsEachTurn' && r.rounds === undefined);
  assert.ok(unclocked.length > 0);
});

test('G11 Dryad: Multiattack pairs its attack with Charm Monster, which charms any creature type on a failed Wisdom save', () => {
  // p.282: "The dryad makes one Vine Lash or Thorn Burst attack, and it can use Spellcasting to cast Charm Monster."
  // Spell, p.114-115: "One creature you can see within range makes a Wisdom saving throw. It does so with Advantage if you
  // or your allies are fighting it. On a failed save, the target has the Charmed condition until the spell ends or until
  // you or your allies damage it." With Advantage, dice of 1 and 19 save (19 + 0 against DC 14); two 1s fail.
  const dryad = block('Dryad'), charm = dryad.options.findIndex((o) => o.name === 'Charm Monster');
  assert.deepEqual(dryad.routines.filter((r) => r.name.startsWith('Multiattack')).map((r) => r.parts.map((p) => dryad.options[p.optionIdx].name)),
    [['Vine Lash', 'Charm Monster'], ['Thorn Burst', 'Charm Monster']]);
  assert.equal((dryad.options[charm].action as { dc: number }).dc, 14);
  const giant = tank({ creatureType: 'giant' });
  const failed = use('Dryad', 'Charm Monster', 10, LOW, giant).d.conditions;
  assert.deepEqual(failed.map((c) => [c.name, c.endsOnSourceDamage]), [['charmed', true]]);
  const user = block('Dryad'), a = e.initState(user), d = e.initState(giant);
  e.resolveAction(user, giant, a, d, action('Dryad', 'Charm Monster'), rolls(LOW, HIGH), 0, 10, log());
  assert.deepEqual(d.conditions, []);
});

test('G11 control: a creature immune to Charmed is unaffected, and Charm Person still takes only Humanoids', () => {
  assert.deepEqual(use('Dryad', 'Charm Monster', 10, LOW, tank({ conditionImmune: ['charmed'] })).held, []);
  assert.deepEqual((action('Oni', 'Charm Person') as { targetTypes?: string[] }).targetTypes, ['humanoid']);
});
