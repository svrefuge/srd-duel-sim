// Printed Initiative (the Archmage, the Invisible Stalker's Advantage) and Mind Spike's hold on the Invisible
// condition. Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in the test
// name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const action = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!.action;
/** A Medium Humanoid bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const HIGH = 0.9, LOW = 0;
const names = (state: { conditions: { name: string }[] }) => state.conditions.map((c) => c.name);
const INVISIBLE: Rider[] = [{ condition: 'invisible', duration: 'permanent' }];

/** An Adult Green Dragon casts Mind Spike at a tank 30 feet away; the tank's save die shows `save`. */
function spike(save: number) {
  const user = block('Adult Green Dragon'), foe = tank(), a = e.initState(user), d = e.initState(foe);
  e.resolveAction(user, foe, a, d, action('Adult Green Dragon', 'Mind Spike'), rolls(save), 0, 30, log());
  return { user, foe, a, d };
}
/** Hit points a Rend from 5 feet takes off the tank, its d20s showing `dice` in order. */
function rend(p: ReturnType<typeof spike>, ...dice: number[]) {
  const before = p.d.hp;
  e.resolveAction(p.user, p.foe, p.a, p.d, action('Adult Green Dragon', 'Rend'), rolls(...dice), 0, 5, log());
  return before - p.d.hp;
}

test('T01 Archmage rolls Initiative with its printed +7', () => {
  // p.305: "Initiative +7 (17)", on Dex 14 (+2) and PB +4. No multiple of the Proficiency Bonus gives +7 (2 + 4 = 6,
  // 2 + 8 = 10), so the printed bonus is the one compiled.
  assert.equal(block('Archmage').initiativeBonus, 7);
});

test('T01 control: a printed Initiative that is Dex plus a multiple of PB is unchanged', () => {
  // Assassin p.260: "Initiative +10 (20)", Dex +4 and twice PB +3; Mage p.305: "Initiative +2 (12)", Dex +2;
  // Zombie p.343: "Initiative −2 (8)", Dex −2.
  assert.deepEqual(['Assassin', 'Mage', 'Zombie'].map((n) => block(n).initiativeBonus), [10, 2, -2]);
});

test('T02 Mind Spike: after a failed save the target gains no benefit from the Invisible condition against the caster', () => {
  // p.149: "On a failed save, you also always know the target's location until the spell ends ... if it has the
  // Invisible condition, it gains no benefit from that condition against you." Adult Green Dragon, DC 17: a save die
  // of 1 fails. The target then turns Invisible 90 feet away, beyond the dragon's Blindsight 60 ft. (p.294), where
  // only the spell lets the dragon see it.
  const p = spike(LOW);
  assert.deepEqual(names(p.d), ['outlined']);
  e.applyRiders(p.d, p.foe, p.d, INVISIBLE, 1, false, rolls(LOW), log());
  assert.equal(e.canSee(p.user, p.d, p.a, 90), true);
});

test('T02 control: a made save leaves the Invisible target unseen, and Mind Spike gives no Advantage', () => {
  // A save die of 19 succeeds against DC 17: no knowledge of the target's location, so at 90 feet it is unseen. At
  // 30 feet the dragon's Blindsight sees it whatever the spell did.
  const made = spike(HIGH);
  assert.deepEqual(names(made.d), []);
  e.applyRiders(made.d, made.foe, made.d, INVISIBLE, 1, false, rolls(LOW), log());
  assert.deepEqual([e.canSee(made.user, made.d, made.a, 90), e.canSee(made.user, made.d, made.a, 30)], [false, true]);
  // Mind Spike is not Faerie Fire: against a visible target that failed, Rend's d20s of 1 then 19 are one roll of 1.
  assert.equal(rend(spike(LOW), LOW, HIGH), 0);
});

test('T02 the knowledge ends with the spell: a second casting that is saved against leaves nothing', () => {
  // "Duration: Concentration": casting it again ends the first casting.
  const p = spike(LOW);
  e.resolveAction(p.user, p.foe, p.a, p.d, action('Adult Green Dragon', 'Mind Spike'), rolls(HIGH), 0, 30, log());
  assert.deepEqual(names(p.d), []);
});

test('T03 Invisible Stalker rolls Initiative with Advantage', () => {
  // p.301: "Initiative +7 (22)" and "The stalker has the Invisible condition."; Invisible (p.184): "If you're Invisible
  // when you roll Initiative, you have Advantage on the roll." The score is 10 + 7 + 5. d20s of 1 then 19: the roll is
  // the 19, so 19 + 7 = 26.
  const stalker = block('Invisible Stalker');
  assert.equal(e.rollInitiative(stalker, e.initState(stalker), rolls(LOW, HIGH)), 26);
});

test('T03 control: a creature that is not Invisible rolls one d20, and one made Invisible rolls two', () => {
  // Guard p.296: "Initiative +1 (11)". The same dice are one roll of 1: 1 + 1 = 2.
  const guard = block('Guard'), state = e.initState(guard);
  assert.equal(e.rollInitiative(guard, state, rolls(LOW, HIGH)), 2);
  e.applyRiders(state, guard, state, INVISIBLE, 0, false, rolls(LOW), log());
  assert.equal(e.rollInitiative(guard, state, rolls(LOW, HIGH)), 20);
});
