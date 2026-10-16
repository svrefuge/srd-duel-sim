// Abduct movement, Dominate Mind control, and Moonbeam. Each test is written from the printed SRD 5.2.1 text quoted
// above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
/** A bystander with 1000 hit points and no actions of its own (a Guard: Speed 30, Con +1, Wis +0). */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });

test('F10 Bugbear Abduct: moving a creature it grapples costs no extra movement', () => {
  // p.271-272: "Abduct. The bugbear needn't spend extra movement to move a creature it is grappling."
  // p.182, Grappled: "every foot of movement costs it 1 extra foot unless you are Tiny or two or more sizes smaller".
  // A Medium bugbear (Speed 30) holding a Medium creature: 30 feet at 1 foot a foot, not 15 at 2.
  assert.deepEqual(blocks.filter((b) => b.freeCarry).map((b) => b.name), ['Bugbear Stalker', 'Bugbear Warrior']);
  const bugbear = block('Bugbear Warrior'), held = tank({ size: bugbear.size });
  assert.equal(e.carryCost(bugbear, held), 1);
  assert.equal(e.movementSpeed(bugbear, e.initState(bugbear)) / e.carryCost(bugbear, held), 30);
});

test('F10 control: a grappler without the trait pays 2 feet a foot for a creature its own size, 1 for a Tiny one', () => {
  const plain = { ...block('Bugbear Warrior'), freeCarry: undefined };
  assert.equal(e.carryCost(plain, tank({ size: plain.size })), 2);
  assert.equal(e.carryCost(plain, tank({ size: 0 })), 1);
});

/** A creature `distance` feet from an Aboleth, Charmed by `rider` (Dominate Mind's by default), takes one turn. */
function charmedTurn(distance: number, rider: Rider = option('Aboleth', 'Dominate Mind (2/Day)').action.kind === 'save' ? (option('Aboleth', 'Dominate Mind (2/Day)').action as { riders: Rider[] }).riders[0] : undefined!) {
  const aboleth = block('Aboleth'), guard = { ...block('Guard'), hpAvg: 1000 }, a = e.initState(aboleth), d = e.initState(guard), engagement = at(distance), l = log();
  e.bindPlace([aboleth, guard], [a, d], engagement);
  e.applyRiders(d, guard, a, [{ ...rider, save: undefined }], 0, false, rolls(0), log(), true);
  assert.ok(d.conditions.some((c) => c.name === 'charmed'));
  const reaction = e.reactionAvailable(guard, d);
  e.takeTurn([aboleth, guard], [a, d], 1, rolls(0.5), engagement, l, e.createPairEvaluator(aboleth, guard, true), false);
  return { distance: engagement.distance, reaction, controlled: l.lines.some((line) => /under Aboleth's control/.test(line)), prone: d.conditions.some((c) => c.name === 'prone'), acted: d.actionSlotUsed === true, lines: l.lines };
}

test('F22 Aboleth Dominate Mind: within 60 feet the Charmed target is walked to the Aboleth and dropped Prone, and takes no action', () => {
  // p.258: "While Charmed, the target acts as an ally to the aboleth and is under its control while within 60 feet of it."
  // p.186, Prone: "An attack roll against you has Advantage if the attacker is within 5 feet of you."
  // A Guard (Speed 30) 20 feet away walks 15 feet to stand 5 feet from the Aboleth and drops Prone there.
  assert.equal((option('Aboleth', 'Dominate Mind (2/Day)').action as { riders: Rider[] }).riders[0].controlRange, 60);
  const turn = charmedTurn(20);
  assert.deepEqual({ distance: turn.distance, reaction: turn.reaction, controlled: turn.controlled, prone: turn.prone, acted: turn.acted },
    { distance: 5, reaction: false, controlled: true, prone: true, acted: false });
  // From 60 feet its Speed of 30 leaves it 30 feet away: too far for Prone to help the Aboleth, so it stays standing.
  const far = charmedTurn(60);
  assert.deepEqual({ distance: far.distance, controlled: far.controlled, prone: far.prone }, { distance: 30, controlled: true, prone: false });
});

test('F22 a controlled creature ends its own Concentration and lets go of the Aboleth; uncontrolled it keeps both', () => {
  const turn = (charm: boolean) => {
    const aboleth = block('Aboleth'), guard = { ...block('Guard'), hpAvg: 1000, options: [], routines: [] }, a = e.initState(aboleth), d = e.initState(guard), engagement = at(5), l = log();
    e.bindPlace([aboleth, guard], [a, d], engagement);
    if (charm) e.applyRiders(d, guard, a, [{ condition: 'charmed', duration: 'permanent', controlRange: 60 }], 0, false, rolls(0), log(), true);
    d.concentrating = true;
    a.conditions.push({ name: 'poisoned', duration: 'permanent', source: 1, concentrationSource: 1, appliedTurn: 0 });
    a.conditions.push({ name: 'grappled', duration: 'untilEscape', source: 1, heldBy: 'grapple', appliedTurn: 0 });
    e.takeTurn([aboleth, guard], [a, d], 1, rolls(0.5), engagement, l, e.createPairEvaluator(aboleth, guard, true), false);
    return { concentrating: d.concentrating, held: a.conditions.map((c) => c.name).sort() };
  };
  assert.deepEqual(turn(true), { concentrating: false, held: [] });
  assert.deepEqual(turn(false), { concentrating: true, held: ['grappled', 'poisoned'] });
});

test('F22 control: beyond 60 feet, or Charmed with no control printed, the creature keeps its own turn', () => {
  const far = charmedTurn(65);
  assert.deepEqual({ reaction: far.reaction, controlled: far.controlled }, { reaction: true, controlled: false });
  const plain = charmedTurn(20, { condition: 'charmed', duration: 'permanent' });
  assert.deepEqual({ reaction: plain.reaction, controlled: plain.controlled }, { reaction: true, controlled: false });
});

test('F22 a controlled creature takes no Legendary Action; the same creature uncontrolled does', () => {
  // An Adult Red Dragon: it has Legendary Actions and, unlike the Unicorn, no immunity to Charmed.
  const legendary = (charm: boolean) => {
    const aboleth = block('Aboleth'), dragon = block('Adult Red Dragon'), a = e.initState(aboleth), d = e.initState(dragon), engagement = at(20), l = log();
    e.bindPlace([aboleth, dragon], [a, d], engagement);
    if (charm) e.applyRiders(d, dragon, a, [{ condition: 'charmed', duration: 'permanent', controlRange: 60 }], 0, false, rolls(0), log(), true);
    assert.equal(e.controlled(d), charm);
    e.legendaryStep([aboleth, dragon], [a, d], 0, rolls(0.5), engagement, l, e.createPairEvaluator(dragon, aboleth, true), false);
    return l.lines.some((line) => /Adult Red Dragon uses legendary/.test(line));
  };
  assert.deepEqual([legendary(true), legendary(false)], [false, true]);
});

/** A Druid casts Moonbeam on a 1000-hit-point creature 30 feet away that fails every save and takes 1 on every die. */
function moonbeam(changes: Partial<CombatStatblock> = {}) {
  const druid = block('Druid'), foe = tank(changes), a = e.initState(druid), d = e.initState(foe), engagement = at(30);
  const cast = druid.options.findIndex((o) => o.name === 'Moonbeam'), move = druid.options.findIndex((o) => o.name === 'Moonbeam (move)');
  const before = e.usable(a, move, druid.options[move]);
  e.spend(a, cast, druid.options[cast]);
  e.resolveAction(druid, foe, a, d, druid.options[cast].action, rolls(0), 0, 30, log());
  const lost = () => foe.hpAvg - d.hp;
  const endFoeTurn = () => { const l = log(); e.endTurn([druid, foe], [a, d], 1, engagement, rolls(0), l); return l.lines; };
  return { druid, foe, a, d, cast, move, before, lost, endFoeTurn };
}

test('G19 Moonbeam: the caster moves the Cylinder onto the target as a Magic action for the same save, with no slot spent', () => {
  // p.150-151: "you can take a Magic action on later turns to move the Cylinder up to 60 feet ... A creature also makes
  // this save when the spell's area moves into its space". 2d10 Radiant on a failed save: 2 with 1 on each die.
  const m = moonbeam();
  assert.equal(m.lost(), 2, 'the cast: 1 + 1');
  assert.equal(m.a.concentrating, true, 'the Cylinder is what the Concentration keeps up');
  assert.equal(e.usable(m.a, m.cast, m.druid.options[m.cast]), false, '1/Day, spent');
  for (const total of [4, 6]) {
    assert.equal(e.usable(m.a, m.move, m.druid.options[m.move]), true);
    e.spend(m.a, m.move, m.druid.options[m.move]);
    e.resolveAction(m.druid, m.foe, m.a, m.d, m.druid.options[m.move].action, rolls(0), 0, 30, log());
    assert.equal(m.lost(), total);
  }
});

test('G19 control: the Cylinder cannot be moved before the spell is cast or after Concentration ends', () => {
  const m = moonbeam();
  assert.equal(m.before, false);
  m.a.hp = 0;
  e.syncConcentration([m.druid, m.foe], [m.a, m.d], log());
  assert.equal(e.usable(m.a, m.move, m.druid.options[m.move]), false);
  assert.deepEqual(m.endFoeTurn().filter((line) => /Moonbeam/.test(line)), [], 'and nothing is left standing on the target');
  assert.equal(m.lost(), 2);
});

test('G19 Moonbeam: a creature that ends its turn in the Cylinder saves again', () => {
  // p.151: "A creature also makes this save when ... it enters the spell's area or ends its turn there."
  // Speed 0 (Grappled): it cannot leave a 5-foot-radius Cylinder, so 2 at the cast and 2 at the end of each turn.
  const m = moonbeam();
  m.d.conditions.push({ name: 'grappled', duration: 'permanent', source: 0, appliedTurn: 0 });
  assert.ok(m.endFoeTurn().some((line) => /ends its turn in the Moonbeam/.test(line)));
  assert.equal(m.lost(), 4);
  m.endFoeTurn();
  assert.equal(m.lost(), 6);
});

test('G19 control: a creature with Speed left steps out of the Cylinder and does not save at the end of its turn', () => {
  const m = moonbeam();
  assert.ok(m.endFoeTurn().some((line) => /leaves the Moonbeam/.test(line)));
  assert.equal(m.lost(), 2);
  assert.equal(m.a.concentrating, true, 'the Cylinder stays up for the caster to move');
  m.endFoeTurn();
  assert.equal(m.lost(), 2);
});
