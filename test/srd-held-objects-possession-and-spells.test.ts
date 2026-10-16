// Holds that are destructible objects (Ettercap webs, Erinyes ropes), Ghost Possession, and the spells of the
// Cloaker, Drider and Couatl. Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is
// in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { ActionOption, CombatAction, CombatStatblock, DamageClause, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const action = (monster: string, name: string) => option(monster, name).action;
const riders = (monster: string, name: string): Rider[] => (action(monster, name) as { riders: Rider[] }).riders;
/** A Medium bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** A Guard (Spear +3, 1d6 + 1 Piercing) with 1000 hit points, its Spear's damage replaced when `damage` is given. */
const spearman = (damage?: DamageClause[], count = 1): CombatStatblock => {
  const spear = block('Guard').options[0];
  const options: ActionOption[] = [{ ...spear, action: { ...spear.action, ...(damage ? { damage } : {}) } as CombatAction }];
  return tank({ options, routines: [{ name: 'Spear', parts: [{ optionIdx: 0, count }] }] });
};
const fixed = (amount: number, type: string): DamageClause[] => [{ dice: { n: 0, d: 1, mod: amount }, type }];
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const HIGH = 0.9, LOW = 0;
const ROPE = 'Entangling Rope (Requires Magic Rope)';

/** `holder` uses `name` on `foe` from `distance` (every die `roll`), then `foe` takes one turn with every die `turnRoll`. */
function heldTurn(holder: string, name: string, foe: CombatStatblock, distance: number, turnRoll: number, roll = LOW) {
  const user = block(holder), a = e.initState(user), d = e.initState(foe), engagement = at(distance), l = log();
  e.resolveAction(user, foe, a, d, action(holder, name), rolls(roll), 0, distance, log());
  const before = d.conditions.map((c) => c.name);
  e.takeTurn([user, foe], [a, d], 1, rolls(turnRoll), engagement, l, e.createPairEvaluator(user, foe, true), false);
  return { before, after: d.conditions.map((c) => c.name), lines: l.lines, a, d, user };
}

test('H01 Ettercap Web Strand: the web is an object (AC 10, HP 5), not a DC 10 check, and a hit that deals 5 destroys it', () => {
  // p.284: "Failure: The target has the Restrained condition until the web is destroyed (AC 10; HP 5; Vulnerability to
  // Fire damage; Immunity to Bludgeoning, Poison, and Psychic damage)." No check is printed.
  assert.deepEqual(riders('Ettercap', 'Web Strand')[0].breakable,
    { name: 'web', ac: 10, hp: 5, immune: ['bludgeoning', 'poison', 'psychic'], vulnerable: ['fire'] });
  assert.equal(riders('Ettercap', 'Web Strand')[0].escapeDc, undefined);
  // Giant Spider's web (p.354) prints no Bludgeoning immunity.
  assert.deepEqual(riders('Giant Spider', 'Web')[0].breakable?.immune, ['poison', 'psychic']);
  // A Guard webbed at 30 ft. Restrained gives its Spear Disadvantage: two d20s of 19, 19 + 3 = 22 against AC 10 hits;
  // a d6 showing 6, 6 + 1 = 7 Piercing, and 5 - 7 leaves the web at 0.
  const turn = heldTurn('Ettercap', 'Web Strand', spearman(), 30, HIGH);
  assert.deepEqual(turn.before, ['restrained']);
  assert.ok(turn.lines.includes('Guard uses Spear on the web'), turn.lines.join('\n'));
  assert.ok(turn.lines.includes('The web is destroyed and Guard is no longer restrained'));
  assert.deepEqual(turn.after, []);
});

test('H01 the attack on the web is made with Disadvantage (Restrained), and a miss leaves the creature held', () => {
  // d20s of 19 and 1: with Disadvantage the roll is 1, a miss.
  const user = block('Ettercap'), foe = spearman(), a = e.initState(user), d = e.initState(foe), l = log();
  e.resolveAction(user, foe, a, d, action('Ettercap', 'Web Strand'), rolls(LOW), 0, 30, log());
  e.strikeObject(foe, user, d, a, foe.options[0], e.heldObject(d)!, rolls(HIGH, LOW), l);
  assert.deepEqual(l.lines, ['Guard misses the web']);
  assert.deepEqual(d.conditions.map((c) => c.name), ['restrained']);
});

test('H01 the web takes double Fire damage and no Bludgeoning damage', () => {
  // 3 Fire is 6 to the web (Vulnerability): destroyed. 3 Piercing leaves 5 - 3 = 2. Bludgeoning deals nothing.
  const strike = (damage: DamageClause[]) => {
    const user = block('Ettercap'), foe = spearman(damage), a = e.initState(user), d = e.initState(foe);
    e.resolveAction(user, foe, a, d, action('Ettercap', 'Web Strand'), rolls(LOW), 0, 30, log());
    const web = e.heldObject(d)!;
    e.strikeObject(foe, user, d, a, foe.options[0], web, rolls(HIGH), log());
    return { hp: web.hp, held: d.conditions.map((c) => c.name) };
  };
  assert.deepEqual(strike(fixed(3, 'fire')), { hp: 0, held: [] });
  assert.deepEqual(strike(fixed(3, 'piercing')), { hp: 2, held: ['restrained'] });
  assert.deepEqual(strike(fixed(30, 'bludgeoning')), { hp: 5, held: ['restrained'] });
});

test('H01 control: a creature whose only damage is Bludgeoning cannot destroy the ettercap\'s web and stays Restrained', () => {
  const turn = heldTurn('Ettercap', 'Web Strand', spearman(fixed(30, 'bludgeoning')), 30, HIGH);
  assert.ok(!turn.lines.some((line) => / on the web$/.test(line)), turn.lines.join('\n'));
  assert.deepEqual(turn.after, ['restrained']);
  // And a creature that made the save is not held and attacks nothing but its foe.
  assert.deepEqual(heldTurn('Ettercap', 'Web Strand', spearman(), 30, HIGH, HIGH).before, []);
});

test('H01 the attacks left after the web is destroyed are made at the foe', () => {
  // Two Spear attacks at 5 ft: the first destroys the web (7 Piercing), the second is made at the ettercap without
  // Disadvantage, 19 + 3 = 22 against AC 13: 7 Piercing off its 44 hit points.
  const turn = heldTurn('Ettercap', 'Web Strand', spearman(undefined, 2), 5, HIGH);
  assert.deepEqual(turn.after, []);
  assert.equal(turn.lines.filter((line) => line === 'Guard uses Spear on the web').length, 1);
  assert.equal(turn.a.hp, 44 - 7);
});

test('H02 Erinyes Entangling Rope: using it again ends the old restraint, and the target makes a new save', () => {
  // p.283: "... the target has the Restrained condition until the rope is destroyed, the erinyes uses a Bonus Action
  // to release the target, or the erinyes uses Entangling Rope again." A d20 of 1 fails DC 16; a 19 (+1 Strength) makes it.
  assert.equal(riders('Erinyes', ROPE)[0].endsOnReuse, true);
  assert.equal(riders('Erinyes', ROPE)[0].duration, 'untilEscape');
  const user = block('Erinyes'), foe = tank(), a = e.initState(user), d = e.initState(foe), l = log();
  e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(LOW), 0, 60, log());
  assert.deepEqual(d.conditions.map((c) => c.name), ['restrained']);
  e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(HIGH), 0, 60, l);
  assert.deepEqual(d.conditions.map((c) => c.name), []);
  assert.ok(l.lines.some((line) => /uses Entangling Rope .* again and Guard is no longer restrained/.test(line)), l.lines.join('\n'));
  // A second failure restrains it again: one copy, not two.
  e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(LOW), 0, 60, log());
  e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(LOW), 0, 60, log());
  assert.deepEqual(d.conditions.map((c) => c.name), ['restrained']);
});

test('H02 control: a hold that does not print the re-use ending stays on when its action is used again and saved against', () => {
  assert.equal(riders('Ettercap', 'Web Strand')[0].endsOnReuse, undefined);
  const user = block('Ettercap'), foe = tank(), a = e.initState(user), d = e.initState(foe);
  e.resolveAction(user, foe, a, d, action('Ettercap', 'Web Strand'), rolls(LOW), 0, 30, log());
  e.resolveAction(user, foe, a, d, action('Ettercap', 'Web Strand'), rolls(HIGH), 0, 30, log());
  assert.deepEqual(d.conditions.map((c) => c.name), ['restrained']);
});

test('H03 Erinyes Magic Rope: one rope with AC 20 and 90 HP; destroying it frees the target and ends the action', () => {
  // p.283, Magic Rope: "While bearing it, the erinyes can use the Entangling Rope action. The rope has AC 20, HP 90, and
  // Immunity to Poison and Psychic damage. The rope turns to dust if reduced to 0 Hit Points".
  assert.deepEqual(riders('Erinyes', ROPE)[0].breakable,
    { name: 'rope', ac: 20, hp: 90, immune: ['poison', 'psychic'], vulnerable: [], item: true });
  const user = block('Erinyes'), foe = spearman(fixed(50, 'slashing')), a = e.initState(user), d = e.initState(foe), l = log();
  const rope = user.options.findIndex((o) => o.name === ROPE);
  e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(LOW), 0, 60, log());
  // A natural 20 hits AC 20 and is not doubled here (the damage has no dice): 90 - 50 = 40.
  e.strikeObject(foe, user, d, a, foe.options[0], e.heldObject(d)!, rolls(0.99), log());
  assert.equal(e.heldObject(d)!.hp, 40);
  // The damage stays on the rope when the erinyes uses it again.
  e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(LOW), 0, 60, log());
  assert.equal(e.heldObject(d)!.hp, 40);
  assert.ok(e.usable(a, rope, user.options[rope]));
  e.strikeObject(foe, user, d, a, foe.options[0], e.heldObject(d)!, rolls(0.99), l);
  assert.deepEqual(l.lines.slice(-1), ['The rope is destroyed and Guard is no longer restrained']);
  assert.deepEqual(d.conditions.map((c) => c.name), []);
  assert.equal(e.usable(a, rope, user.options[rope]), false);
});

test('H03 the rope has AC 20 and is immune to Poison: a 19 on the die with +0 misses, and Poison deals nothing', () => {
  const user = block('Erinyes'), a = e.initState(user);
  const hit = (foe: CombatStatblock, roll: number) => {
    const d = e.initState(foe);
    e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(LOW), 0, 60, log());
    const object = e.heldObject(d)!, before = object.hp;
    e.strikeObject(foe, user, d, a, foe.options[0], object, rolls(roll), log());
    return before - object.hp;
  };
  const flat = (damage: DamageClause[]): CombatStatblock => {
    const foe = spearman(damage);
    return { ...foe, options: [{ ...foe.options[0], action: { ...foe.options[0].action, toHit: 0 } as CombatAction }] };
  };
  assert.equal(hit(flat(fixed(10, 'slashing')), 0.9), 0); // 19 + 0 < 20
  assert.equal(hit(flat(fixed(10, 'slashing')), 0.99), 10); // a natural 20
  assert.equal(hit(flat(fixed(10, 'poison')), 0.99), 0);
});

test('H03 control: a Guard does not spend its turns on a 90 HP rope it cannot expect to destroy', () => {
  const turn = heldTurn('Erinyes', ROPE, spearman(), 5, HIGH);
  assert.deepEqual(turn.before, ['restrained']);
  assert.ok(!turn.lines.some((line) => / on the rope$/.test(line)), turn.lines.join('\n'));
  assert.ok(turn.lines.includes('Guard uses Spear'));
});

/** The ghost uses Possession on `foe` at 5 ft with every die `roll`. */
function possess(foe: CombatStatblock, roll = LOW) {
  const ghost = block('Ghost'), a = e.initState(ghost), d = e.initState(foe), engagement = at(5);
  e.resolveAction(ghost, foe, a, d, action('Ghost', 'Possession'), rolls(roll), 0, 5, log());
  return { ghost, foe, a, d, engagement, evaluator: e.createPairEvaluator(ghost, foe, true) };
}

test('H04 Ghost Possession: the possessed body is Incapacitated and does nothing; the ghost goes where the body goes', () => {
  // p.288: "Failure: The target is possessed by the ghost; the ghost disappears, and the target has the Incapacitated
  // condition and loses control of its body. ... The possession lasts until the body drops to 0 Hit Points or the
  // ghost leaves as a Bonus Action." A Knight (Charisma +2) rolling 1 fails DC 13.
  assert.equal(riders('Ghost', 'Possession')[0].possession, true);
  const p = possess(block('Knight')), l = log();
  assert.deepEqual(p.d.conditions.map((c) => [c.name, c.duration]), [['incapacitated', 'permanent']]);
  assert.equal(p.a.possessing, true);
  assert.equal(e.currentSpeed(p.ghost, p.a), 0);
  // The Knight's turn: no move (an Incapacitated creature that keeps control of its body may still move), no action.
  e.takeTurn([p.ghost, p.foe], [p.a, p.d], 1, rolls(HIGH), p.engagement, l, p.evaluator, false);
  assert.deepEqual(l.lines, ['Knight loses its turn']);
  assert.equal(p.engagement.distance, 5);
  assert.equal(p.a.hp, 45);
});

test('H04 the possessing ghost attacks the body with Withering Touch, against its AC and without Advantage', () => {
  // "The ghost's game statistics are the same": Withering Touch +5 against the Knight's AC 18. A 12 on the die is 17, a
  // miss; a 13 is 18, a hit. Incapacitated gives no Advantage: dice of 1 then 19 are one roll of 1.
  const touch = (...dice: number[]) => { const p = possess(block('Knight')); e.resolveAction(p.ghost, p.foe, p.a, p.d, action('Ghost', 'Withering Touch'), rolls(...dice), 0, 5, log()); return 52 - p.d.hp; };
  assert.equal(touch(0.55), 0);
  assert.ok(touch(0.6) > 0);
  assert.equal(touch(LOW, HIGH), 0);
  // Inside the body it has only its attacks: Horrific Visage is not something it does to the body.
  const p = possess(block('Knight'));
  assert.equal(e.actionTargetable(action('Ghost', 'Horrific Visage'), p.ghost, p.foe, 5, p.d, p.a), false);
  assert.equal(e.actionTargetable(action('Ghost', 'Withering Touch'), p.ghost, p.foe, 5, p.d, p.a), true);
  // Its turn: two Withering Touch attacks (Multiattack), and no move.
  const l = log();
  e.takeTurn([p.ghost, p.foe], [p.a, p.d], 0, rolls(HIGH), p.engagement, l, p.evaluator, false);
  assert.equal(l.lines.filter((line) => line === 'Ghost uses Withering Touch').length, 2);
  assert.ok(!l.lines.some((line) => /moves|Horrific|Possession/.test(line)), l.lines.join('\n'));
});

test('H04 a ghost that cannot damage the body leaves as a Bonus Action, and the target is then immune to Possession', () => {
  // "When the possession ends ... the target is immune to this ghost's Possession for 24 hours." A body immune to
  // Necrotic damage can never be dropped by Withering Touch.
  const p = possess(tank({ immune: ['necrotic'] })), l = log();
  assert.equal(p.a.possessing, true);
  e.takeTurn([p.ghost, p.foe], [p.a, p.d], 0, rolls(HIGH), p.engagement, l, p.evaluator, false);
  assert.ok(l.lines.includes("Ghost leaves Guard's body (Bonus Action)"), l.lines.join('\n'));
  assert.deepEqual(p.d.conditions.map((c) => c.name), []);
  assert.equal(p.a.possessing, false);
  assert.ok(p.d.immuneTo.has('Possession'));
});

test('H04 control: a made save possesses nothing, and a ghost outside a body keeps its Speed and its other actions', () => {
  const p = possess(block('Knight'), HIGH);
  assert.deepEqual(p.d.conditions.map((c) => c.name), []);
  assert.ok(!p.a.possessing);
  assert.equal(e.currentSpeed(p.ghost, p.a), 40);
  assert.equal(e.actionTargetable(action('Ghost', 'Horrific Visage'), p.ghost, p.foe, 5, p.d, p.a), true);
  // Possession names "one Humanoid": a Beast is not a target.
  assert.equal(e.actionTargetable(action('Ghost', 'Possession'), p.ghost, block('Wolf'), 5, e.initState(block('Wolf')), e.initState(p.ghost)), false);
});

test('H04 choice: Possession is priced at the body\'s Hit Points times the chance it lands', () => {
  // Knight: 52 HP, fails DC 13 on a 10 or less (50%): 26, above two Withering Touches. Guard: 11 HP at 60%: 6.6, below.
  const pick = (name: string) => { const ghost = block('Ghost'), foe = block(name); return e.bestUsableRoutinesAtDistance(ghost, foe, e.initState(ghost), e.initState(foe), 0, 5, e.createPairEvaluator(ghost, foe, true)).any; };
  assert.equal(pick('Knight').routine?.name, 'Possession');
  assert.equal(pick('Knight').ev, 26);
  assert.equal(pick('Guard').routine?.name, 'Multiattack (Withering Touch)');
});

/** `caster` casts its own `spell` (every die LOW unless given), facing `foe`. */
function cast(caster: string, spell: string, foe: CombatStatblock, roll = LOW) {
  const user = block(caster), a = e.initState(user), d = e.initState(foe);
  e.resolveAction(user, foe, a, d, action(caster, spell), rolls(roll), 0, 5, log());
  return { user, foe, a, d };
}
/** A spearman that hits for a flat 10 Piercing with +3 to hit. */
const flat10 = (changes: Partial<CombatStatblock> = {}) => ({ ...spearman(fixed(10, 'piercing')), ...changes });

test('H05 Cloaker Phantasms: Mirror Image is one Bonus Action use, and a d6 of 3 or more per duplicate takes the hit', () => {
  // p.274: "Phantasms (Recharge after a Short or Long Rest). The cloaker casts the Mirror Image spell". p.150: "Each
  // time a creature hits you with an attack roll during the spell's duration, roll a d6 for each of your remaining
  // duplicates. If any of the d6s rolls a 3 or higher, one of the duplicates is hit instead of you, and the duplicate
  // is destroyed." Duration 1 minute, no Concentration.
  const o = option('Cloaker', 'Mirror Image');
  assert.deepEqual([o.timing, o.uses], ['bonus', { t: 'perDay', max: 1 }]);
  assert.deepEqual([(o.action as { images?: number }).images, (o.action as { rounds?: number }).rounds, (o.action as { concentration?: boolean }).concentration], [3, 10, false]);
  const c = cast('Cloaker', 'Mirror Image', flat10()), l = log();
  // A 19 hits AC 14 (19 + 3); d6s of 1, 1 and 4: the third is 3 or higher, so a duplicate is hit and the cloaker is not.
  e.resolveAction(c.foe, c.user, c.d, c.a, c.foe.options[0].action, rolls(HIGH, LOW, LOW, 0.5), 1, 5, l);
  assert.equal(c.a.hp, 91);
  assert.deepEqual(l.lines, ['Guard hits a duplicate of Cloaker (2 left)']);
  // Two duplicates left, d6s of 1 and 1: the cloaker itself is hit for 10.
  e.resolveAction(c.foe, c.user, c.d, c.a, c.foe.options[0].action, rolls(HIGH, LOW, LOW), 1, 5, log());
  assert.equal(c.a.hp, 81);
  // "The spell ends when all three duplicates are destroyed."
  e.resolveAction(c.foe, c.user, c.d, c.a, c.foe.options[0].action, rolls(HIGH), 1, 5, log());
  e.resolveAction(c.foe, c.user, c.d, c.a, c.foe.options[0].action, rolls(HIGH), 1, 5, log());
  assert.deepEqual(c.a.conditions.map((x) => x.name), []);
  assert.equal(c.a.hp, 81);
});

test('H05 Mirror Image does nothing against a Blinded attacker or one with Truesight, and ends after ten rounds', () => {
  // p.150: "A creature is unaffected by this spell if it has the Blinded condition, Blindsight, or Truesight."
  const seer = cast('Cloaker', 'Mirror Image', flat10({ truesightRange: 120 }));
  e.resolveAction(seer.foe, seer.user, seer.d, seer.a, seer.foe.options[0].action, rolls(HIGH), 1, 5, log());
  assert.equal(seer.a.hp, 81);
  const blind = cast('Cloaker', 'Mirror Image', flat10());
  e.applyRiders(blind.d, blind.foe, blind.a, [{ condition: 'blinded', duration: 'permanent' }], 0, false, rolls(LOW), log());
  e.resolveAction(blind.foe, blind.user, blind.d, blind.a, blind.foe.options[0].action, rolls(HIGH), 1, 5, log());
  assert.equal(blind.a.hp, 81);
  const timed = cast('Cloaker', 'Mirror Image', flat10());
  timed.a.turnCount += 9;
  e.expireClockedConditions(timed.user, timed.foe, timed.a, timed.d, 0, log());
  assert.deepEqual(timed.a.conditions.map((x) => x.name), ['mirrorImage']);
  timed.a.turnCount += 1;
  e.expireClockedConditions(timed.user, timed.foe, timed.a, timed.d, 0, log());
  assert.deepEqual(timed.a.conditions.map((x) => x.name), []);
});

test('H05 control: without Mirror Image the same hit lands, and no d6 is rolled', () => {
  const user = block('Cloaker'), foe = flat10(), a = e.initState(user), d = e.initState(foe);
  e.resolveAction(foe, user, d, a, foe.options[0].action, rolls(HIGH, LOW, LOW, 0.5), 1, 5, log());
  assert.equal(a.hp, 81);
});

test('H06 Drider Faerie Fire: a failed DC 14 Dexterity save gives attacks against the target Advantage', () => {
  // p.129: "Each creature in the Cube is also outlined if it fails a Dexterity saving throw. ... Attack rolls against
  // an affected creature or object have Advantage if the attacker can see it." Drider, p.281: Bonus Action, Recharge
  // 5-6, spell save DC 14, one use shared with Web.
  const o = option('Drider', 'Faerie Fire'), web = option('Drider', 'Web');
  assert.equal(o.timing, 'bonus');
  assert.deepEqual(o.uses, web.uses);
  assert.equal((o.uses as { t: string; min: number }).min, 5);
  assert.deepEqual([(o.action as { ability: string }).ability, (o.action as { dc: number }).dc, (o.action as { concentration: boolean }).concentration], ['dex', 14, true]);
  // Foreleg +7 against AC 16 with d20s of 1 and 19: Advantage takes the 19.
  const lit = cast('Drider', 'Faerie Fire', tank());
  assert.deepEqual(lit.d.conditions.map((c) => c.name), ['outlined']);
  e.resolveAction(lit.user, lit.foe, lit.a, lit.d, action('Drider', 'Foreleg'), rolls(LOW, HIGH), 0, 5, log());
  assert.ok(lit.d.hp < 1000);
  // A Blinded attacker cannot see it: no Advantage, and Disadvantage takes the 1 of 19 and 1.
  const blind = cast('Drider', 'Faerie Fire', tank());
  e.applyRiders(blind.a, blind.user, blind.d, [{ condition: 'blinded', duration: 'permanent' }], 1, false, rolls(LOW), log());
  e.resolveAction(blind.user, blind.foe, blind.a, blind.d, action('Drider', 'Foreleg'), rolls(HIGH, LOW), 0, 5, log());
  assert.equal(blind.d.hp, 1000);
});

test('H06 an outlined creature cannot benefit from the Invisible condition', () => {
  // p.129: "affected creatures ... can't benefit from the Invisible condition." An Invisible target is attacked with
  // Disadvantage (d20s of 19 and 1: a 1); outlined, it is seen and attacked with Advantage (1 and 19: a 19).
  const hidden = (outlined: boolean, ...dice: number[]) => {
    const c = outlined ? cast('Drider', 'Faerie Fire', tank()) : cast('Drider', 'Faerie Fire', tank(), HIGH);
    e.applyRiders(c.d, c.foe, c.d, [{ condition: 'invisible', duration: 'permanent' }], 1, false, rolls(LOW), log());
    e.resolveAction(c.user, c.foe, c.a, c.d, action('Drider', 'Foreleg'), rolls(...dice), 0, 5, log());
    return 1000 - c.d.hp;
  };
  assert.equal(hidden(false, HIGH, LOW), 0);
  assert.ok(hidden(true, LOW, HIGH) > 0);
});

test('H06 control: a made save outlines nothing, and the same two dice are one roll of 1', () => {
  const c = cast('Drider', 'Faerie Fire', tank(), HIGH);
  assert.deepEqual(c.d.conditions.map((x) => x.name), []);
  e.resolveAction(c.user, c.foe, c.a, c.d, action('Drider', 'Foreleg'), rolls(LOW, HIGH), 0, 5, log());
  assert.equal(c.d.hp, 1000);
});

test('H07 Drider Web: a failed DC 14 Dexterity save restrains, and the way out is a DC 14 Strength (Athletics) check', () => {
  // p.174: "it must succeed on a Dexterity saving throw or have the Restrained condition while in the webs or until it
  // breaks free. A creature Restrained by the webs can take an action to make a Strength (Athletics) check against
  // your spell save DC." Concentration.
  const a = action('Drider', 'Web') as { ability: string; dc: number; concentration: boolean; targetGroundOnly?: boolean };
  assert.deepEqual([a.ability, a.dc, a.concentration, a.targetGroundOnly], ['dex', 14, true, true]);
  assert.deepEqual(riders('Drider', 'Web').map((r) => [r.condition, r.duration, r.escapeDc, r.escapeAbilities, r.breakable]),
    [['restrained', 'untilEscape', 14, ['str'], undefined]]);
  assert.deepEqual(cast('Drider', 'Web', tank()).d.conditions.map((c) => c.name), ['restrained']);
  // "Webs layered over a flat surface have a depth of 5 feet": a creature flying above the floor is not in them.
  const c = cast('Drider', 'Web', tank(), HIGH);
  assert.equal(e.actionTargetable(action('Drider', 'Web'), c.user, c.foe, 30, c.d, c.a), true);
  c.d.height = 10;
  assert.equal(e.actionTargetable(action('Drider', 'Web'), c.user, c.foe, 30, c.d, c.a), false);
});

test('H07 control: a made save leaves the target free, and the ettercap\'s own web has no check', () => {
  assert.deepEqual(cast('Drider', 'Web', tank(), HIGH).d.conditions.map((c) => c.name), []);
  assert.equal(riders('Ettercap', 'Web Strand')[0].escapeDc, undefined);
});

test('H08 Couatl Bless: 1d4 is added to its attack rolls and saving throws', () => {
  // p.113: "Whenever a target makes an attack roll or a saving throw before the spell ends, the target adds 1d4 to the
  // attack roll or save." Couatl, p.278: Divine Aid (2/Day), a Bonus Action shared with Lesser Restoration.
  const o = option('Couatl', 'Bless');
  assert.equal(o.timing, 'bonus');
  assert.deepEqual(o.uses, option('Couatl', 'Lesser Restoration').uses);
  assert.equal((o.uses as { max: number }).max, 2);
  // Bite +7 against AC 16 on a 7: 14 misses. With a d4 of 3 it is 17 and hits; with a d4 of 1 it is 15 and misses.
  const bite = (blessed: boolean, ...dice: number[]) => {
    const c = blessed ? cast('Couatl', 'Bless', tank()) : { user: block('Couatl'), foe: tank(), a: e.initState(block('Couatl')), d: e.initState(tank()) };
    e.resolveAction(c.user, c.foe, c.a, c.d, action('Couatl', 'Bite'), rolls(...dice), 0, 5, log());
    return 1000 - c.d.hp;
  };
  assert.ok(bite(true, 0.3, 0.5) > 0);
  assert.equal(bite(true, 0.3, LOW, LOW), 0);
  // A Wisdom save (+7) against DC 20 on a 10: 17 fails; with a d4 of 3 it is 20 and succeeds.
  const c = cast('Couatl', 'Bless', tank());
  assert.equal(e.rollSave(c.user, c.a, 'wis', 20, false, rolls(0.45, 0.5)), true);
  assert.equal(e.rollSave(c.user, c.a, 'wis', 20, false, rolls(0.45, LOW)), false);
});

test('H08 control: without Bless the same dice miss and fail', () => {
  const user = block('Couatl'), foe = tank(), a = e.initState(user), d = e.initState(foe);
  e.resolveAction(user, foe, a, d, action('Couatl', 'Bite'), rolls(0.3, 0.5), 0, 5, log());
  assert.equal(d.hp, 1000);
  assert.equal(e.rollSave(user, a, 'wis', 20, false, rolls(0.45, 0.5)), false);
});

test('H09 Couatl Lesser Restoration: ends one of Blinded, Deafened, Paralyzed or Poisoned on the couatl', () => {
  // p.144: "You touch a creature and end one condition on it: Blinded, Deafened, Paralyzed, or Poisoned."
  assert.deepEqual((action('Couatl', 'Lesser Restoration') as { curesConditions: string[] }).curesConditions, ['blinded', 'deafened', 'paralyzed', 'poisoned']);
  const user = block('Couatl'), foe = tank(), a = e.initState(user), d = e.initState(foe), l = log();
  e.applyRiders(a, user, d, [{ condition: 'poisoned', duration: 'permanent' }, { condition: 'blinded', duration: 'permanent' }], 1, false, rolls(LOW), log());
  e.resolveAction(user, foe, a, d, action('Couatl', 'Lesser Restoration'), rolls(LOW), 0, 5, l);
  assert.deepEqual(a.conditions.map((c) => c.name), ['poisoned']); // one condition a casting
  assert.deepEqual(l.lines, ['Couatl is no longer blinded']);
  // A Poisoned couatl spends its Bonus Action on it.
  const turn = log();
  e.takeTurn([user, foe], [a, d], 0, rolls(0.5), at(5), turn, e.createPairEvaluator(user, foe, true), false);
  assert.ok(turn.lines.includes('Couatl uses bonus action Lesser Restoration'), turn.lines.join('\n'));
  assert.deepEqual(a.conditions.filter((c) => c.name === 'poisoned'), []);
});

test('H09 control: with none of those conditions it is not cast, and a condition that hangs on a hold is not ended', () => {
  const user = block('Couatl'), foe = tank(), a = e.initState(user), d = e.initState(foe), turn = log();
  e.takeTurn([user, foe], [a, d], 0, rolls(0.5), at(5), turn, e.createPairEvaluator(user, foe, true), false);
  assert.ok(!turn.lines.some((line) => /Lesser Restoration/.test(line)), turn.lines.join('\n'));
  e.applyRiders(a, user, d, [{ condition: 'poisoned', duration: 'untilEscape', escapeDc: 14 }], 1, false, rolls(LOW), log());
  e.resolveAction(user, foe, a, d, action('Couatl', 'Lesser Restoration'), rolls(LOW), 0, 5, log());
  assert.ok(a.conditions.some((c) => c.name === 'poisoned'));
});

test('H09 control: Blinded inside a swallower is not ended (it lasts while swallowed)', () => {
  const user = block('Couatl'), foe = tank(), a = e.initState(user), d = e.initState(foe);
  e.applyRiders(a, user, d, [{ condition: 'swallowed', duration: 'permanent' }, { condition: 'blinded', duration: 'permanent' }], 1, false, rolls(LOW), log());
  e.resolveAction(user, foe, a, d, action('Couatl', 'Lesser Restoration'), rolls(LOW), 0, 5, log());
  assert.ok(a.conditions.some((c) => c.name === 'blinded'));
});

/** The erinyes's turn at 5 ft against a target her rope already holds; returns the log. */
function ropeTurn(foe: CombatStatblock) {
  const user = block('Erinyes'), a = e.initState(user), d = e.initState(foe), l = log();
  e.resolveAction(user, foe, a, d, action('Erinyes', ROPE), rolls(LOW), 0, 5, log());
  e.takeTurn([user, foe], [a, d], 0, rolls(0.5), at(5), l, e.createPairEvaluator(user, foe, true), false);
  return l.lines;
}

test('H02 choice: the erinyes does not use the rope again on a target it holds when the new save would likely free it', () => {
  // p.283, Multiattack: "three Withering Sword attacks and can use Entangling Rope." A Guard (Strength +1) fails DC 16
  // on a 14 or less: 70%. Using it again is worth 0.7 x 14 = 9.8 Force damage and risks, at 30%, the Advantage the
  // restraint gives her three swords for the turns ahead, which is more. She makes the three sword attacks only.
  const lines = ropeTurn(tank());
  assert.equal(lines.filter((line) => line === 'Erinyes uses Withering Sword').length, 3);
  assert.ok(!lines.some((line) => line.startsWith('Erinyes uses Entangling Rope')), lines.join('\n'));
});

test('H02 control: she uses it again on a target almost sure to fail, and on one the rope does not hold', () => {
  // Strength -4 fails DC 16 on a 19 or less: 95%. 0.95 x 14 = 13.3 against a 5% risk.
  const weak = ropeTurn(tank({ abilityMods: { ...block('Guard').abilityMods, str: -4 } }));
  assert.ok(weak.some((line) => line.startsWith('Erinyes uses Entangling Rope')), weak.join('\n'));
  const user = block('Erinyes'), foe = tank(), l = log();
  e.takeTurn([user, foe], [e.initState(user), e.initState(foe)], 0, rolls(0.5), at(5), l, e.createPairEvaluator(user, foe, true), false);
  assert.ok(l.lines.some((line) => line.startsWith('Erinyes uses Entangling Rope')), l.lines.join('\n'));
});
