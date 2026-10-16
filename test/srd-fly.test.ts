// The Fly spell (finding T04). Each test is written from
// the printed SRD 5.2.1 text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const HIGH = 0.9, LOW = 0;

/** A caster and a foe 30 feet apart in a bound fight, on the caster's own turn. */
function duel(caster: string, foeName: string, scenario: 'max30' | 'max120' | 'max600' = 'max120') {
  const user = block(caster), foe: CombatStatblock = block(foeName), a = e.initState(user), d = e.initState(foe);
  const engagement = { ...e.startingEngagement(scenario) }, lines = log();
  e.bindPlace([user, foe], [a, d], engagement);
  a.ownTurn = true;
  const evaluator = e.createPairEvaluator(user, foe, true);
  const cast = () => {
    e.resolveOptionWithTeleport(user, foe, a, d, option(caster, 'Fly').action, rolls(HIGH), 0, engagement, lines, evaluator);
    e.settleAfterAction(user, foe, a, d, 0, engagement, rolls(HIGH), lines);
  };
  const price = () => e.dynamicEv(option(caster, 'Fly').action, user, foe, d, a, 0, engagement.distance, evaluator, 'action', 0);
  return { user, foe, a, d, engagement, lines, cast, price };
}

test('T04 Fly compiles for the four blocks that print it, with their uses', () => {
  // Fly p.133: "Duration: Concentration, up to 10 minutes ... the target gains a Fly Speed of 60 feet and can hover."
  // Archmage p.305 "2/Day Each: Fly"; Mage p.305, Rakshasa p.318 and Glabrezu p.289 "1/Day Each: ... Fly".
  for (const [name, max] of [['Archmage', 2], ['Mage', 1], ['Rakshasa', 1], ['Glabrezu', 1]] as const) {
    const o = option(name, 'Fly');
    assert.deepEqual([o.action.kind, (o.action as any).fly, (o.action as any).concentration, o.uses], ['selfbuff', { speed: 60, hover: true }, true, { t: 'perDay', max }], name);
    assert.equal(block(name).flySpeed, undefined, name);
  }
});

test('T04 control: no other block gains a Fly option', () => {
  assert.deepEqual(blocks.filter((b) => b.options.some((o) => o.name === 'Fly')).map((b) => b.name).sort(), ['Archmage', 'Glabrezu', 'Mage', 'Rakshasa']);
});

test('T04 the caster gains a Fly Speed of 60 feet: its Speed is 60, and it rises with the movement its turn has left', () => {
  // Archmage p.305: Speed 30 ft. After the cast its Speed is the faster 60. It has moved 0 feet this turn, so 60 feet
  // of movement are left (p.14: "You can break up your move, using some of its movement before and after any action").
  const p = duel('Archmage', 'Tyrannosaurus Rex');
  assert.equal(e.currentSpeed(p.user, p.a), 30);
  p.cast();
  assert.equal(e.currentSpeed(p.user, p.a), 60);
  assert.ok(p.a.height > 0 && p.a.height <= 60, `height ${p.a.height}`);
  assert.ok(p.lines.lines.some((l) => l.startsWith('Archmage flies')));
});

test('T04 control: a caster that has already moved 60 feet this turn stays where it is', () => {
  const p = duel('Archmage', 'Tyrannosaurus Rex');
  p.a.turnMoved = 60;
  p.cast();
  assert.equal(p.a.height, 0);
});

test('T04 when the spell ends the caster falls if it is still aloft', () => {
  // "When the spell ends, the target falls if it is still aloft unless it can stop the fall." From 40 feet: 4d6
  // Bludgeoning (p.182, "A creature that falls takes 1d6 Bludgeoning damage" for every 10 feet); each d6 shows
  // 1 + floor(0.9 * 6) = 6, so 24, and the creature lands Prone.
  const p = duel('Archmage', 'Tyrannosaurus Rex');
  p.cast();
  p.a.height = 40; p.engagement.ground = 200; p.engagement.distance = 200;
  const hp = p.a.hp;
  p.a.conditions = p.a.conditions.filter((c) => c.name !== 'flying');
  e.settleAfterAction(p.user, p.foe, p.a, p.d, 0, p.engagement, rolls(HIGH), log());
  assert.deepEqual([p.a.height, hp - p.a.hp, p.a.conditions.some((c) => c.name === 'prone')], [0, 24, true]);
});

test('T04 it can hover: Prone and aloft, a creature under Fly does not fall', () => {
  // p.182: "While flying, you fall if you have the Incapacitated or Prone condition or your Fly Speed is reduced to 0. You
  // can stay aloft in those circumstances if you can hover."
  const p = duel('Archmage', 'Tyrannosaurus Rex');
  p.cast();
  p.a.height = 40; p.engagement.ground = 200; p.engagement.distance = 200;
  e.applyRiders(p.a, p.user, p.d, [{ condition: 'prone', duration: 'permanent' }], 1, false, rolls(LOW), log());
  e.settleAfterAction(p.user, p.foe, p.a, p.d, 0, p.engagement, rolls(HIGH), log());
  assert.equal(p.a.height, 40);
});

test('T04 the planner: worth an action against a foe that cannot follow, nothing against a flier or once aloft', () => {
  // Tyrannosaurus Rex (p.363) has no ranged attack and no Fly Speed; Adult Red Dragon flies at 80 ft.
  const rex = duel('Archmage', 'Tyrannosaurus Rex');
  assert.ok(rex.price() > 0);
  assert.equal(duel('Archmage', 'Adult Red Dragon').price(), 0);
  rex.cast();
  assert.equal(rex.price(), 0);
});

test('T04 the planner: a grounded caster prices Fly to reach a flier overhead, and flies toward it after the cast', () => {
  // Rakshasa p.317: Speed 40 ft., Cursed Touch reach 5 ft., and no attack that reaches a creature 60 feet up. Adult
  // Red Dragon: Fly 80 ft. With the dragon 60 feet overhead the cast is worth something; after it the rakshasa has its
  // 60 feet of movement left and uses it to rise toward the dragon.
  const p = duel('Rakshasa', 'Adult Red Dragon', 'max600');
  p.d.height = 60; p.engagement.ground = 30; p.engagement.distance = 60;
  assert.ok(p.price() > 0);
  p.cast();
  assert.ok(p.a.height > 0 && p.engagement.distance < 60, `height ${p.a.height}, distance ${p.engagement.distance}`);
});

test('T04 control: with the same dragon on the ground, Fly is worth nothing to the rakshasa', () => {
  const p = duel('Rakshasa', 'Adult Red Dragon', 'max600');
  assert.equal(p.price(), 0);
});

// W01, from tracing the Dash warnings Fly brought out: Rakshasa (p.317: Cursed Touch reach 5 ft.,
// Baleful Command 30 feet) against Adult Bronze Dragon (p.270: Blindsight 60 ft.). Pushed 60 feet off by Repulsion
// Breath, it Dashed back past Invisibility priced 8.42. Everything it can do to the dragon is inside the dragon's
// Blindsight, where "If a creature can somehow see you, you don't gain this benefit against that creature" (p.184).
test('W01 Invisibility is worth nothing to a caster whose every attack lies inside the foe\'s Blindsight', () => {
  const rakshasa = block('Rakshasa'), dragon = block('Adult Bronze Dragon');
  assert.equal(dragon.blindsight, 60);
  const ev = (foe: CombatStatblock) =>
    e.dynamicEv(option('Rakshasa', 'Invisibility').action, rakshasa, foe, e.initState(foe), e.initState(rakshasa), 0, 65, e.createPairEvaluator(rakshasa, foe, true));
  assert.equal(ev(dragon), 0);
});

test('W01 control: against the same dragon without its Blindsight the spell keeps a price', () => {
  const rakshasa = block('Rakshasa'), dragon = { ...block('Adult Bronze Dragon'), blindsight: undefined };
  assert.ok(e.dynamicEv(option('Rakshasa', 'Invisibility').action, rakshasa, dragon, e.initState(dragon), e.initState(rakshasa), 0, 65, e.createPairEvaluator(rakshasa, dragon, true)) > 0);
});
