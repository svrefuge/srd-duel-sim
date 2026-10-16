// Printed mechanics of the Warhorse Skeleton to Zombie stat blocks. Each test is written from the printed SRD 5.2.1
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
/** A Medium Humanoid bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const HIGH = 0.9, LOW = 0;
const names = (state: { conditions: { name: string }[] }) => state.conditions.map((c) => c.name);
const packet = (damage: number, type: string): CombatAction => ({ kind: 'autohit', magical: false, damage: [{ dice: { n: 0, d: 1, mod: damage }, type }] });

/** One use of an option from `distance`, every die showing `roll`, in a bound fight. */
function use(monster: string, name: string, distance: number, roll: number, foe: CombatStatblock = tank(), before?: (s: ReturnType<typeof e.initState>, t: ReturnType<typeof e.initState>) => void) {
  const user = block(monster), a = e.initState(user), d = e.initState(foe), engagement = at(distance), lines = log();
  e.bindPlace([user, foe], [a, d], engagement);
  before?.(a, d);
  e.resolveOptionWithTeleport(user, foe, a, d, action(monster, name), rolls(roll), 0, engagement, lines, e.createPairEvaluator(user, foe, true));
  e.settleAfterAction(user, foe, a, d, 0, engagement, rolls(roll), lines);
  return { distance: engagement.distance, held: names(d), a, d, lines: lines.lines, user, foe, engagement };
}
/** The foe's next `turns` turns, each begun and ended with every die showing `roll`. */
function foeTurns(p: ReturnType<typeof use>, turns: number, roll: number) {
  for (let i = 0; i < turns; i++) {
    e.startTurn(p.foe, p.d, rolls(roll), log());
    e.endTurn([p.user, p.foe], [p.a, p.d], 1, p.engagement, rolls(roll), log());
  }
  return names(p.d);
}

test('N01 lycanthropes: in the hybrid form that has all their attacks, the Speed is the printed 30 feet', () => {
  // p.337: "Speed 30 ft., 40 ft. (bear form only), Climb 30 ft. (bear form only)". p.338: "Speed 30 ft., 40 ft. (boar
  // form only)". p.339: "Speed 30 ft., 40 ft. (tiger form only)" and "Speed 30 ft., 40 ft. (wolf form only)". Each block
  // is compiled with its "(Humanoid or Hybrid Form Only)" weapon beside its "(Bear or Hybrid Form Only)" attacks, which
  // only the hybrid form has; 40 feet is printed for the animal form only.
  for (const name of ['Werebear', 'Wereboar', 'Weretiger', 'Werewolf']) assert.equal(block(name).speed, 30, name);
});

test('N01 control: a Speed with no form printed, and a creature with no hybrid form, are unchanged', () => {
  assert.equal(block('Wererat').speed, 30); // "Speed 30 ft., Climb 30 ft."
  assert.equal(block('Vampire').speed, 40); // "Speed 40 ft., Climb 40 ft.": its forms change no Speed
  assert.equal(block('Air Elemental').speed, 90); // "Fly 90 ft. (hover)": a condition that names no form
});

test('N02 lycanthropes: the hybrid form\'s printed size', () => {
  // p.337: "shape-shifts into a Large bear-humanoid hybrid form". p.339: "a Large tiger-humanoid hybrid" and "a Large
  // wolf-humanoid hybrid". p.338: "a Medium boar-humanoid hybrid" and "a Medium rat-humanoid hybrid".
  assert.deepEqual(['Werebear', 'Weretiger', 'Werewolf', 'Wereboar', 'Wererat'].map((name) => block(name).size), [3, 3, 3, 2, 2]);
  // Wolf's Bite (p.364): "If the target is a Medium or smaller creature, it has the Prone condition." A hit on the
  // Large werewolf leaves it standing; a hit on the Medium wererat does not.
  assert.equal(use('Wolf', 'Bite', 5, HIGH, block('Werewolf')).held.includes('prone'), false);
  assert.ok(use('Wolf', 'Bite', 5, HIGH, block('Wererat')).held.includes('prone'));
});

test('N02 control: "Medium or Small" with no hybrid form is still Medium', () => {
  assert.equal(block('Warrior Veteran').size, 2);
  assert.equal(block('Vampire').size, 2);
});

test('N03 Weretiger Prowl: a Bonus Action move of up to its Speed that provokes no Opportunity Attacks', () => {
  // p.339: "Prowl (Tiger or Hybrid Form Only). The weretiger moves up to its Speed without provoking Opportunity
  // Attacks. At the end of this movement, the weretiger can take the Hide action."
  const prowl = block('Weretiger').options.find((o) => o.name.startsWith('Prowl'))!;
  assert.equal(prowl.timing, 'bonus');
  assert.deepEqual((prowl.action as { movement?: unknown }).movement, { mode: 'dash', noProvoke: true });
  assert.equal(block('Weretiger').skipped.some((s) => s.name.startsWith('Prowl')), false);
});

test('N03 control: Nimble Escape is still a Disengage with no extra movement', () => {
  const escape = block('Goblin Warrior').options.find((o) => o.name === 'Nimble Escape')!;
  assert.deepEqual((escape.action as { movement?: unknown }).movement, { mode: 'dash', distance: 0, noProvoke: true });
});

test('N04 Water Elemental Freeze: Cold damage takes 20 feet off its Speed until the end of its next turn', () => {
  // p.337: "Freeze. If the elemental takes Cold damage, its Speed decreases by 20 feet until the end of its next turn."
  // Speed 30 - 20 = 10.
  const elemental = block('Water Elemental'), foe = tank(), a = e.initState(foe), d = e.initState(elemental);
  assert.deepEqual(elemental.speedLossOnDamage, { types: ['cold'], feet: 20 });
  assert.equal(elemental.skipped.some((s) => s.name === 'Freeze'), false);
  e.dealDamage(foe, elemental, a, d, packet(5, 'cold'), rolls(HIGH), 0, false, log());
  assert.equal(e.currentSpeed(elemental, d), 10);
  // A second Cold hit does not take another 20 feet.
  e.dealDamage(foe, elemental, a, d, packet(5, 'cold'), rolls(HIGH), 0, false, log());
  assert.equal(e.currentSpeed(elemental, d), 10);
  e.startTurn(elemental, d, rolls(HIGH), log());
  assert.equal(e.currentSpeed(elemental, d), 10, 'through its next turn');
  e.endTurn([foe, elemental], [a, d], 1, at(5), rolls(HIGH), log());
  assert.equal(e.currentSpeed(elemental, d), 30, 'until the end of its next turn');
});

test('N04 control: other damage leaves its Speed alone, and so does Cold damage it is immune to', () => {
  const elemental = block('Water Elemental'), foe = tank(), a = e.initState(foe), d = e.initState(elemental);
  e.dealDamage(foe, elemental, a, d, packet(5, 'fire'), rolls(HIGH), 0, false, log());
  assert.equal(e.currentSpeed(elemental, d), 30);
  const immune = { ...elemental, immune: [...elemental.immune, 'cold'] }, d2 = e.initState(immune);
  e.dealDamage(foe, immune, a, d2, packet(5, 'cold'), rolls(HIGH), 0, false, log());
  assert.equal(e.currentSpeed(immune, d2), 30);
});

test('N05 Paralyzing Breath: after 1 minute the Paralyzed target succeeds automatically', () => {
  // p.324: "Second Failure: The target has the Paralyzed condition, and it repeats the save at the end of each of its
  // turns, ending the effect on itself on a success. After 1 minute, it succeeds automatically." Ten rounds.
  assert.equal(riders('Young Silver Dragon', 'Paralyzing Breath')[0].transitionRounds, 10);
  const p = use('Young Silver Dragon', 'Paralyzing Breath', 5, LOW);
  assert.ok(p.held.includes('incapacitated'));
  assert.ok(foeTurns(p, 1, LOW).includes('paralyzed'), 'the second failure, at the end of its next turn');
  assert.ok(foeTurns(p, 9, LOW).includes('paralyzed'), 'nine more failed saves');
  assert.equal(foeTurns(p, 1, LOW).includes('paralyzed'), false, 'the tenth succeeds automatically');
});

test('N05 Sleep Breath: a Young Brass Dragon\'s sleeper wakes after 1 minute', () => {
  // p.268: "Second Failure: The target has the Unconscious condition for 1 minute."
  const p = use('Young Brass Dragon', 'Sleep Breath', 5, LOW);
  assert.ok(foeTurns(p, 1, LOW).includes('unconscious'));
  assert.ok(foeTurns(p, 9, LOW).includes('unconscious'));
  assert.equal(foeTurns(p, 1, LOW).includes('unconscious'), false);
});

test('N05 control: the first stage has no clock, and an Adult Brass Dragon\'s 10 minutes outlast ten rounds', () => {
  assert.equal(riders('Young Silver Dragon', 'Paralyzing Breath')[0].rounds, undefined);
  // p.268, Adult Brass Dragon: "The target has the Unconscious condition for 10 minutes."
  assert.equal(riders('Adult Brass Dragon', 'Sleep Breath')[0].transitionRounds, undefined);
  const p = use('Adult Brass Dragon', 'Sleep Breath', 5, LOW);
  assert.ok(foeTurns(p, 12, LOW).includes('unconscious'));
  // A success on the repeat save ends the first stage with no second.
  const q = use('Young Silver Dragon', 'Paralyzing Breath', 5, LOW);
  assert.deepEqual(foeTurns(q, 1, HIGH).filter((n) => n === 'paralyzed' || n === 'incapacitated'), []);
});

test('N06 Will-o\'-Wisp Consume Life: the target dies and the wisp regains 3d6 Hit Points', () => {
  // p.342: "Consume Life. Constitution Saving Throw: DC 10, one living creature the wisp can see within 5 feet that has
  // 0 Hit Points. Failure: The target dies, and the wisp regains 10 (3d6) Hit Points." Every die showing 1: the save
  // fails, and 5 + 3 = 8.
  assert.deepEqual((action("Will-o'-Wisp", 'Consume Life') as { selfHealOnKill?: unknown }).selfHealOnKill, { n: 3, d: 6, mod: 0 });
  const p = use("Will-o'-Wisp", 'Consume Life', 5, LOW, tank(), (a, d) => { a.hp = 5; d.hp = 0; });
  assert.ok(p.d.slain);
  assert.equal(p.a.hp, 8);
});

test('N06 control: nothing regained on a successful save, and never above its Hit Point maximum', () => {
  const saved = use("Will-o'-Wisp", 'Consume Life', 5, HIGH, tank(), (a, d) => { a.hp = 5; d.hp = 0; });
  assert.equal(saved.a.hp, 5);
  const full = use("Will-o'-Wisp", 'Consume Life', 5, LOW, tank(), (a, d) => { d.hp = 0; });
  assert.equal(full.a.hp, full.a.maxHp);
});
