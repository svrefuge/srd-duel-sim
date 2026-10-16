// Telekinesis (finding V06). Each test is written
// from the printed SRD 5.2.1 text (p167-168): "The target must succeed on a Strength saving throw, or you move it up to
// 30 feet in any direction within the spell's range. Until the end of your next turn, the creature has the Restrained
// condition, and if you lift it into the air, it is suspended there. It falls at the end of your next turn unless you use
// this option on it again and it fails the save."
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const HIGH = 0.9, LOW = 0;

/** The Cloud Giant and a foe 30 feet apart under a 120-foot ceiling, on the giant's first turn. */
function duel(foeName: string) {
  const giant = block('Cloud Giant'), foe = block(foeName), a = e.initState(giant), d = e.initState(foe);
  const engagement = { ...e.startingEngagement('max120') }, lines = new FightLog(true);
  e.bindPlace([giant, foe], [a, d], engagement);
  const idx = giant.options.findIndex((o) => o.name === 'Telekinesis'), option = giant.options[idx];
  e.startTurn(giant, a, rolls(HIGH), lines);
  a.ownTurn = true;
  /** The giant uses Telekinesis; `save` is the foe's d20 as an rng value. */
  const cast = (save: number) => {
    e.spend(a, idx, option);
    e.resolveOptionWithTeleport(giant, foe, a, d, option.action, rolls(save), 0, engagement, lines, e.createPairEvaluator(giant, foe, true));
    e.settleAfterAction(giant, foe, a, d, 0, engagement, rolls(HIGH), lines);
  };
  const endGiantTurn = (die = HIGH) => e.endTurn([giant, foe], [a, d], 0, engagement, rolls(die), lines);
  const nextGiantTurn = () => e.startTurn(giant, a, rolls(HIGH), lines);
  const restrained = () => d.conditions.some((c) => c.name === 'restrained');
  return { giant, foe, a, d, engagement, lines, idx, option, cast, endGiantTurn, nextGiantTurn, restrained };
}

test('V06 Telekinesis compiles for the Cloud Giant from the spell text', () => {
  // Cloud Giant p275: "1/Day Each: Control Weather, Gaseous Form, Telekinesis", spell save DC 15. Telekinesis p167: Range
  // 60 feet, Concentration, "a Huge or smaller creature", Strength save, "up to 30 feet".
  const o = block('Cloud Giant').options.find((x) => x.name === 'Telekinesis')!, a = o.action as any;
  assert.deepEqual([a.kind, a.ability, a.dc, a.range, a.concentration, a.targetMaxSize, a.sustained, o.uses, o.timing],
    ['save', 'str', 15, 60, true, block('Fire Giant').size, true, { t: 'perDay', max: 1 }, 'action']);
  assert.deepEqual(a.riders.map((r: any) => [r.condition, r.duration, r.lift, r.spellLevel]), [['restrained', 'endOfSourceNextTurn', 30, 5]]);
  assert.ok(!block('Cloud Giant').skipped.some((s: any) => s.name === 'Telekinesis'));
});

test('V06 a failed save restrains the target, lifts it 30 feet and drops it at the end of the giant\'s next turn', () => {
  // Ogre: Strength save +4, so a 1 on the d20 fails DC 15. It hangs 30 feet up through the end of the turn of the cast
  // and falls at the end of the giant's next turn: 3d6 for 30 feet, 18 with every die a 6, and Prone.
  const t = duel('Ogre'), hp = t.d.hp;
  t.cast(LOW);
  assert.ok(t.restrained());
  assert.equal(t.d.height, 30);
  t.endGiantTurn();
  assert.ok(t.restrained(), 'still held at the end of the turn it was cast on');
  assert.equal(t.d.height, 30);
  assert.equal(t.d.hp, hp);
  t.nextGiantTurn();
  t.endGiantTurn();
  assert.ok(!t.restrained());
  assert.equal(t.d.height, 0);
  assert.equal(t.d.hp, hp - 18);
  assert.ok(t.d.conditions.some((c) => c.name === 'prone'));
  assert.ok(t.lines.lines.some((l) => l === 'Ogre falls 30 ft'));
});

test('V06 control: a successful save moves nothing and restrains nothing', () => {
  // A 19 on the d20 (+4) meets DC 15.
  const t = duel('Ogre'), hp = t.d.hp;
  t.cast(HIGH);
  assert.ok(!t.restrained());
  assert.equal(t.d.height, 0);
  t.endGiantTurn(); t.nextGiantTurn(); t.endGiantTurn();
  assert.equal(t.d.hp, hp);
});

test('V06 the spell is used again on later turns while Concentration lasts, at no further use', () => {
  // "When you cast the spell and as a Magic action on your later turns before the spell ends": the one use a day is
  // the casting. After a saved first attempt the giant still concentrates and may try again.
  const t = duel('Ogre');
  assert.ok(e.usable(t.a, t.idx, t.option));
  t.cast(HIGH);
  assert.equal(t.a.perDay.get(t.idx), 0);
  assert.ok(t.a.concentrating);
  t.endGiantTurn(); t.nextGiantTurn();
  assert.ok(t.a.concentrating, 'Concentration outlasts a saved attempt');
  assert.ok(e.usable(t.a, t.idx, t.option));
  t.cast(LOW);
  assert.equal(t.a.perDay.get(t.idx), 0);
  assert.ok(t.restrained());
  assert.equal(t.d.height, 30);
});

test('V06 control: once Concentration ends the spent spell cannot be used again', () => {
  const t = duel('Ogre');
  t.cast(LOW);
  t.a.conditions.push({ name: 'stunned', duration: 'permanent', source: 1, appliedTurn: 0 } as any);
  e.syncConcentration([t.giant, t.foe], [t.a, t.d], t.lines);
  assert.ok(!t.a.concentrating);
  assert.ok(!t.restrained(), 'the hold ends with the spell');
  t.a.conditions = t.a.conditions.filter((c) => c.name !== 'stunned');
  assert.ok(!e.usable(t.a, t.idx, t.option));
  // and the target, no longer suspended, falls at the next settle point
  t.endGiantTurn();
  assert.equal(t.d.height, 0);
});

test('V06 used again on a hanging target that fails, it stays up; the fall comes a turn later and from higher', () => {
  // "It falls at the end of your next turn unless you use this option on it again and it fails the save." The second
  // lift is again up to 30 feet, kept within the spell's 60-foot range of the giant.
  const t = duel('Ogre'), hp = t.d.hp;
  t.cast(LOW);
  t.endGiantTurn(); t.nextGiantTurn();
  t.cast(LOW);
  assert.ok(t.d.height > 30 && t.d.height <= 60, `height ${t.d.height}`);
  assert.ok(t.engagement.distance <= 60, `distance ${t.engagement.distance}`);
  const height = t.d.height;
  t.endGiantTurn();
  assert.ok(t.restrained(), 'the second hold outlasts the first');
  assert.equal(t.d.height, height);
  assert.equal(t.d.hp, hp);
  t.nextGiantTurn(); t.endGiantTurn();
  assert.equal(t.d.height, 0);
  assert.equal(t.d.hp, hp - 6 * Math.floor(height / 10));
});

test('V06 control: used again on a hanging target that saves, it falls at the end of that turn', () => {
  const t = duel('Ogre'), hp = t.d.hp;
  t.cast(LOW);
  t.endGiantTurn(); t.nextGiantTurn();
  t.cast(HIGH);
  assert.equal(t.d.height, 30);
  t.endGiantTurn();
  assert.equal(t.d.height, 0);
  assert.equal(t.d.hp, hp - 18);
});

test('V06 control: a Gargantuan creature is no target, and a flier let go does not fall', () => {
  // "You can try to move a Huge or smaller creature." The Tarrasque is Gargantuan.
  const big = duel('Tarrasque');
  big.cast(LOW);
  assert.ok(!big.restrained());
  assert.equal(big.d.height, 0);
  // Giant Eagle: Strength save +3, Fly 80 ft. Held 30 feet up and then released, it has its Fly Speed back.
  const t = duel('Giant Eagle'), hp = t.d.hp;
  t.cast(LOW);
  assert.ok(t.restrained());
  assert.equal(t.d.height, 30);
  t.endGiantTurn(); t.nextGiantTurn(); t.endGiantTurn();
  assert.ok(!t.restrained());
  assert.equal(t.d.hp, hp);
});

test('V06 the giant prices the lift: the fall at the odds of a failed save, and nothing for the fall of a flier', () => {
  // Ogre fails DC 15 on a 10 or lower: 0.5. The fall is 3d6, average 10.5, so the lift adds at least 5.25.
  const t = duel('Ogre'), flat = { ...t.option.action, riders: (t.option.action as any).riders.map((r: any) => ({ ...r, lift: undefined })) } as any;
  const price = (action: any, x = t) => e.dynamicEv(action, x.giant, x.foe, x.d, x.a, 0, x.engagement.distance, e.createPairEvaluator(x.giant, x.foe, true), 'action', 0);
  assert.ok(price(t.option.action) - price(flat) >= 5.25 - 1e-9, `${price(t.option.action)} v ${price(flat)}`);
  // Giant Eagle fails on a 11 or lower (+3): 0.55, and owes no fall; at 30 feet it has no attack either way, so the
  // lift adds only what its turn beside the giant would be worth, less than its whole routine.
  const eagle = duel('Giant Eagle');
  const added = price(eagle.option.action, eagle) - price(flat, eagle);
  const routine = e.createPairEvaluator(eagle.foe, eagle.giant, true).bestRoutineEvAtDistance(eagle.foe, eagle.giant, 5, true);
  assert.ok(added >= 0 && added <= 0.55 * routine + 1e-9, `${added} v ${routine}`);
});
