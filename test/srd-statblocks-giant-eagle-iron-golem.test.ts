// Printed mechanics of the Giant Eagle to Iron Golem stat blocks. Each test is written from the printed SRD 5.2.1
// text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
/** A Medium bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** A Guard (Spear +3, melee or thrown 20/60, 1d6 + 1 Piercing) with 1000 hit points. */
const spearman = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });

/** A Guard's Spear against the stalker with d20s of 19 then 1: one die hits AC 14 (19 + 3), Disadvantage misses (1 + 3). */
function spearAtStalker(attacker: CombatStatblock) {
  const stalker = block('Invisible Stalker'), a = e.initState(attacker), d = e.initState(stalker);
  e.resolveAction(attacker, stalker, a, d, block('Guard').options[0].action, rolls(0.9, 0, 0), 0, 5, log());
  return stalker.hpAvg - d.hp;
}

test('K01 Invisible Stalker Invisibility: it has the Invisible condition from the start, and attacking does not end it', () => {
  // p.301: "Invisibility. The stalker has the Invisible condition." An attacker that cannot see it has Disadvantage.
  const stalker = block('Invisible Stalker'), state = e.initState(stalker), foe = tank();
  assert.deepEqual(state.conditions.map((c) => c.name), ['invisible']);
  assert.deepEqual(blocks.filter((b) => b.innateInvisible).map((b) => b.name), ['Invisible Stalker']);
  assert.equal(spearAtStalker(spearman()), 0, '19 then 1 with Disadvantage: 1 + 3 misses AC 14');
  e.resolveAction(stalker, foe, state, e.initState(foe), option('Invisible Stalker', 'Wind Swipe').action, rolls(0.9), 0, 5, log());
  assert.deepEqual(state.conditions.map((c) => c.name), ['invisible'], 'still Invisible after its own attack');
});

test('K01 control: an attacker with Truesight sees the stalker and hits on the same dice; other creatures start with no condition', () => {
  assert.equal(spearAtStalker(spearman({ truesight: true, truesightRange: 120 })), 1, '19 + 3 hits; the damage die shows 1, halved by Resistance');
  assert.deepEqual(e.initState(block('Imp')).conditions, []);
});

/** The hobgoblin's first attack against AC 16 with d20s of 1 then 19, and a DC 15 Constitution save with 3 then 19. */
function captainRolls(name: string, incapacitated = false) {
  const hob = block(name), a = e.initState(hob), foe = tank(), d = e.initState(foe);
  if (incapacitated) a.conditions.push({ name: 'stunned', duration: 'permanent', source: 1, appliedTurn: 0 });
  const save = e.rollSave(hob, a, 'con', 15, false, rolls(0.1, 0.9));
  if (incapacitated) return { save, hit: false };
  e.resolveAction(hob, foe, a, d, hob.options[0].action, rolls(0, 0.9, 0), 0, 5, log());
  return { save, hit: d.hp < 1000 };
}

test('K02 Hobgoblin Captain Aura of Authority: Advantage on its attack rolls and saving throws', () => {
  // p.299: "the hobgoblin and its allies have Advantage on attack rolls and saving throws, provided the hobgoblin
  // doesn't have the Incapacitated condition." Attack: 1 misses, 19 + 4 hits AC 16. Save: 3 + 2 fails DC 15, 19 + 2 succeeds.
  assert.deepEqual(captainRolls('Hobgoblin Captain'), { save: true, hit: true });
});

test('K02 control: no Advantage on saves while Incapacitated, and none for a Hobgoblin Warrior', () => {
  assert.equal(captainRolls('Hobgoblin Captain', true).save, false);
  assert.deepEqual(captainRolls('Hobgoblin Warrior'), { save: false, hit: false });
});

/** A Guard `distance` feet from an Ice Devil takes one turn, after an Ice Spear hit when `speared`. */
function guardTurn(distance: number, speared: boolean) {
  const devil = block('Ice Devil'), guard = spearman(), a = e.initState(devil), d = e.initState(guard), engagement = at(distance), l = log();
  if (speared) e.resolveAction(devil, guard, a, d, option('Ice Devil', 'Ice Spear').action, rolls(0.9), 0, distance, log());
  e.takeTurn([devil, guard], [a, d], 1, rolls(0.5), engagement, l, e.createPairEvaluator(devil, guard, true), false);
  return { distance: engagement.distance, attacked: l.lines.some((line) => /uses Spear/.test(line)), d };
}

test('K03 Ice Devil Ice Spear: the target moves or takes one action, not both, and takes no Bonus Action or Reaction', () => {
  // p.300: "Until the end of its next turn, the target can't take a Bonus Action or Reaction, its Speed decreases by
  // 10 feet, and it can move or take one action on its turn, not both."
  const rider = (option('Ice Devil', 'Ice Spear').action as { riders: Rider[] }).riders[0];
  assert.deepEqual({ cut: rider.speedCut, r: rider.noReactions, b: rider.noBonusActions, m: rider.moveOrAct, until: rider.duration },
    { cut: 10, r: true, b: true, m: true, until: 'endOfTargetNextTurn' });
  // Out of the Spear's 60-foot range it can only move: 30 - 10 = 20 feet, with no Dash and no attack.
  assert.deepEqual((({ distance, attacked }) => ({ distance, attacked }))(guardTurn(100, true)), { distance: 80, attacked: false });
  // At 30 feet the thrown Spear is usable: it acts and stays where it is.
  assert.deepEqual((({ distance, attacked }) => ({ distance, attacked }))(guardTurn(30, true)), { distance: 30, attacked: true });
  // No Bonus Action while the rider holds.
  const goblin = block('Goblin Warrior'), state = e.initState(goblin), nimble = goblin.options.findIndex((o) => o.name === 'Nimble Escape');
  assert.equal(e.usable(state, nimble, goblin.options[nimble]), true);
  e.applyRiders(state, goblin, e.initState(block('Ice Devil')), [rider], 1, false, rolls(0.5), log(), true);
  assert.equal(e.usable(state, nimble, goblin.options[nimble]), false);
  // No Reaction either: a Gladiator's Parry.
  const gladiator = block('Gladiator'), parrying = e.initState(gladiator);
  assert.equal(e.reactionAvailable(gladiator, parrying), true);
  e.applyRiders(parrying, gladiator, e.initState(block('Ice Devil')), [rider], 1, false, rolls(0.5), log(), true);
  assert.equal(e.reactionAvailable(gladiator, parrying), false);
});

test('K03 control: without the Ice Spear hit the same Guard dashes from 100 feet, and moves and attacks from 30', () => {
  assert.deepEqual((({ distance, attacked }) => ({ distance, attacked }))(guardTurn(100, false)), { distance: 40, attacked: false });
  const near = guardTurn(30, false);
  assert.equal(near.attacked, true);
  assert.notEqual(near.distance, 30);
  // The limits end with the rider, at the end of the target's next turn.
  assert.equal(guardTurn(30, true).d.conditions.some((c) => c.moveOrAct), false);
});

test('K04 Glabrezu Multiattack: two Pincer attacks and Pummel or Spellcasting', () => {
  // p.289: "The glabrezu makes two Pincer attacks and uses Pummel or Spellcasting."
  const glabrezu = block('Glabrezu'), name = (i: number) => glabrezu.options[i].name;
  const routine = glabrezu.routines.find((r) => r.name === 'Multiattack (Pincer) + Power Word Stun')!;
  assert.deepEqual(routine.parts.map((p) => [name(p.optionIdx), p.count]), [['Pincer', 2], ['Power Word Stun', 1]]);
});

test('K04 control: the Pummel routine is unchanged and Power Word Stun keeps its one use a day', () => {
  const glabrezu = block('Glabrezu'), name = (i: number) => glabrezu.options[i].name;
  const pummel = glabrezu.routines.find((r) => r.name === 'Multiattack (Pincer) + Pummel')!;
  assert.deepEqual(pummel.parts.map((p) => [name(p.optionIdx), p.count]), [['Pincer', 2], ['Pummel', 1]]);
  assert.deepEqual(option('Glabrezu', 'Power Word Stun').uses, { t: 'perDay', max: 1 });
});

/** A Goblin Warrior next to an Ogre (reach 5 ft.) takes one turn; `nimble` false removes Nimble Escape. */
function goblinTurn(nimble: boolean) {
  const printed = block('Goblin Warrior'), goblin = nimble ? printed : { ...printed, options: printed.options.filter((o) => o.name !== 'Nimble Escape') };
  const ogre = { ...block('Ogre'), hpAvg: 1000 }, a = e.initState(goblin), d = e.initState(ogre), engagement = at(5), l = log();
  e.takeTurn([goblin, ogre], [a, d], 0, rolls(0.5), engagement, l, e.createPairEvaluator(goblin, ogre, true), false);
  return { distance: engagement.distance, lines: l.lines, hp: a.hp };
}

test('K05 Nimble Escape: the goblin Disengages as a Bonus Action and leaves reach without an Opportunity Attack', () => {
  // p.290: "Nimble Escape. The goblin takes the Disengage or Hide action."
  const turn = goblinTurn(true);
  assert.ok(turn.lines.some((line) => /uses bonus action Nimble Escape/.test(line)));
  assert.equal(turn.distance, 35, '5 ft plus its 30-foot Speed');
  assert.equal(turn.hp, block('Goblin Warrior').hpAvg, 'no Opportunity Attack landed or was made');
  assert.ok(!turn.lines.some((line) => /opportunity/i.test(line)));
  for (const name of ['Goblin Minion', 'Goblin Boss', 'Panther', 'Tiger', 'Saber-Toothed Tiger']) {
    assert.equal(option(name, 'Nimble Escape').action.kind, 'selfbuff', name);
  }
  // "takes the Dash, Disengage, or Hide action" (Cunning Action) offers the Disengage too.
  for (const name of ['Assassin', 'Spy']) assert.ok(option(name, 'Cunning Action (Disengage)'), name);
});

test('K05 control: without Nimble Escape the same goblin stays in reach, and a Dash-only bonus action gains no Disengage', () => {
  assert.equal(goblinTurn(false).distance, 5);
  assert.equal(block('Clay Golem').options.some((o) => /Disengage/.test(o.name)), false);
});

/** The Giant Seahorse's Ram on an AC 5 target with every die at its maximum, after `runUp` feet straight toward it. */
function ram(monster: string, runUp: number) {
  const beast = block(monster), foe = tank({ ac: 5 }), a = e.initState(beast), d = e.initState(foe);
  a.movedToward = runUp;
  e.resolveAction(beast, foe, a, d, option(monster, 'Ram').action, rolls(0.5, 0.999), 0, 5, log());
  return 1000 - d.hp;
}

test('K06 Giant Seahorse Ram: 2d8 + 2 after moving 20+ feet straight toward the target, 2d6 + 2 otherwise', () => {
  // p.353: "Hit: 9 (2d6 + 2) Bludgeoning damage, or 11 (2d8 + 2) Bludgeoning damage if the seahorse moved 20+ feet
  // straight toward the target immediately before the hit." Maximum dice: 12 + 2 = 14 without the run, 16 + 2 = 18 with.
  assert.equal(ram('Giant Seahorse', 0), 14);
  assert.equal(ram('Giant Seahorse', 20), 18);
});

test('K06 control: a charge printed as extra damage still adds to the base (Giant Goat: 1d6 + 3, plus 2d4 after the run)', () => {
  assert.equal(ram('Giant Goat', 0), 9);
  assert.equal(ram('Giant Goat', 20), 17);
});

/** A Guard, Confused by a Glabrezu when `confused`, takes one turn `distance` feet away with the listed dice. */
function confusedTurn(distance: number, confused: boolean, ...dice: number[]) {
  const glabrezu = { ...block('Glabrezu'), hpAvg: 1000 }, guard = spearman(), a = e.initState(glabrezu), d = e.initState(guard), engagement = at(distance), l = log();
  if (confused) e.resolveAction(glabrezu, guard, a, d, option('Glabrezu', 'Confusion').action, rolls(0), 0, distance, log());
  const held = d.conditions.some((c) => c.name === 'confused');
  e.takeTurn([glabrezu, guard], [a, d], 1, rolls(...dice), engagement, l, e.createPairEvaluator(glabrezu, guard, true), false);
  return { held, still: d.conditions.some((c) => c.name === 'confused'), distance: engagement.distance,
    attacks: l.lines.filter((line) => /misses Glabrezu|Glabrezu takes \d+ damage/.test(line)).length, moved: l.lines.some((line) => /Guard (moves|dashes|wanders)/.test(line)) };
}

test('K07 Confusion (Glabrezu): the d10 table decides the turn, and the save repeats at the end of each turn', () => {
  // p.117 and p.289 (spell save DC 16). A d10 shows 1 + floor(value * 10).
  const spell = option('Glabrezu', 'Confusion');
  assert.deepEqual(spell.uses, { t: 'perDay', max: 1 });
  assert.equal(spell.action.kind === 'save' && spell.action.ability === 'wis' && spell.action.dc === 16 && spell.action.concentration, true);
  // 3 (2-6): "The target doesn't move or take actions." The repeated save (d20 6, Wisdom +0) fails DC 16.
  assert.deepEqual(confusedTurn(5, true, 0.25), { held: true, still: true, distance: 5, attacks: 0, moved: false });
  // 7 (7-8): no movement and one melee attack on the only creature in reach.
  assert.deepEqual(confusedTurn(5, true, 0.65), { held: true, still: true, distance: 5, attacks: 1, moved: false });
  // 7 with nothing in reach: "the target takes no action."
  assert.deepEqual(confusedTurn(30, true, 0.65), { held: true, still: true, distance: 30, attacks: 0, moved: false });
  // 1: no action, all its movement in a random direction (d4 shows 1: 30 feet closer).
  assert.deepEqual(confusedTurn(60, true, 0, 0, 0.25), { held: true, still: true, distance: 30, attacks: 0, moved: true });
  // 10 (9-10): "The target chooses its behavior"; a d20 of 20 on the repeated save ends the spell on it.
  const free = confusedTurn(5, true, 0.95);
  assert.deepEqual({ attacks: free.attacks, still: free.still }, { attacks: 1, still: false });
  // "can't take Bonus Actions or Reactions"
  const rider = (spell.action as { riders: Rider[] }).riders[0];
  assert.deepEqual({ b: rider.noBonusActions, r: rider.noReactions }, { b: true, r: true });
});

test('K07 control: the same Guard, not Confused, attacks on the dice that cost a Confused one its turn', () => {
  const turn = confusedTurn(5, false, 0.25);
  assert.deepEqual({ held: turn.held, attacks: turn.attacks }, { held: false, attacks: 1 });
});

test('K08 Vortex and Engulf: a held creature cannot cast spells with a Verbal component', () => {
  // p.301-302: "Until the grapple ends, the target can't cast spells with a Verbal component". Gelatinous Cube Engulf:
  // "An engulfed target is suffocating, can't cast spells with a Verbal component".
  const vortex = (option('Invisible Stalker', 'Vortex').action as { riders: Rider[] }).riders;
  assert.equal(vortex.find((r) => r.condition === 'grappled')!.noVerbalSpells, true);
  assert.equal(block('Gelatinous Cube').options.some((o) => 'riders' in o.action && o.action.riders?.some((r) => r.noVerbalSpells)), true);
  const mage = block('Mage'), state = e.initState(mage), stalker = block('Invisible Stalker');
  const verbal = mage.options.findIndex((o) => o.action.verbal), plain = mage.options.findIndex((o) => !o.action.spell && o.timing === 'action');
  assert.ok(verbal >= 0 && plain >= 0);
  assert.equal(e.usable(state, verbal, mage.options[verbal]), true);
  e.applyRiders(state, mage, e.initState(stalker), vortex, 1, false, rolls(0), log(), true);
  assert.equal(state.conditions.some((c) => c.name === 'grappled'), true);
  assert.equal(e.usable(state, verbal, mage.options[verbal]), false);
  assert.equal(e.usable(state, plain, mage.options[plain]), true, 'an action that is not a spell is still usable');
});

test('K08 control: a spell cast with no components stays usable under the lock, and other grapples carry no lock', () => {
  const couatl = block('Couatl'), state = e.initState(couatl), vortex = (option('Invisible Stalker', 'Vortex').action as { riders: Rider[] }).riders;
  const spell = couatl.options.findIndex((o) => o.action.spell && !o.action.verbal);
  assert.ok(spell >= 0);
  e.applyRiders(state, couatl, e.initState(block('Invisible Stalker')), vortex, 1, false, rolls(0), log(), true);
  assert.equal(state.conditions.some((c) => c.noVerbalSpells), true);
  assert.equal(e.usable(state, spell, couatl.options[spell]), true);
  assert.equal((option('Glabrezu', 'Pincer').action as { riders: Rider[] }).riders.some((r) => r.noVerbalSpells), false);
});

const volleys = (monster: string) => block(monster).routines.map((r) => r.parts.map((p) => `${block(monster).options[p.optionIdx].name} x${p.count}`).join(' + '));

test('K09 attacks "in any combination": mixed volleys compile beside the pure ones', () => {
  // p.299 Horned Devil: "makes three attacks, using Searing Fork or Hurl Flame in any combination. It can replace one
  // attack with a use of Infernal Tail."
  const devil = volleys('Horned Devil');
  for (const mixed of ['Searing Fork x2 + Hurl Flame x1', 'Searing Fork x1 + Hurl Flame x2', 'Hurl Flame x2 + Searing Fork x1', 'Hurl Flame x1 + Searing Fork x2',
    'Searing Fork x1 + Hurl Flame x1 + Infernal Tail x1']) assert.ok(devil.includes(mixed), mixed);
  assert.ok(volleys('Lich').includes('Paralyzing Touch x1 + Eldritch Burst x2'));
  assert.ok(volleys('Merrow').includes('Harpoon x1 + Bite x1'));
  assert.ok(volleys('Tarrasque').includes('Bite x1 + Tail x1 + Claw x2'));
});

test('K09 control: every Horned Devil Multiattack is still three uses, no block repeats a routine, and a fixed Multiattack gains nothing', () => {
  const devil = block('Horned Devil');
  for (const routine of devil.routines.filter((r) => /^Multiattack/.test(r.name))) assert.equal(routine.parts.reduce((sum, p) => sum + p.count, 0), 3, routine.name);
  for (const b of blocks) assert.equal(new Set(b.routines.map((r) => JSON.stringify({ ...r, name: '' }))).size, b.routines.length, b.name);
  assert.deepEqual(volleys('Owlbear'), ['Rend x2', 'Rend x1']);
});

/** A Guard with the Gibbering result on it takes one turn `distance` feet from a Gibbering Mouther; the d8 shows 8. */
function gibberingTurn(distance: number) {
  const mouther = { ...block('Gibbering Mouther'), hpAvg: 1000 }, guard = spearman(), a = e.initState(mouther), d = e.initState(guard), l = log();
  d.conditions.push({ name: 'gibbering', duration: 'endOfTargetTurn', source: 0, appliedTurn: 0 });
  e.takeTurn([mouther, guard], [a, d], 1, rolls(0.95), at(distance), l, e.createPairEvaluator(mouther, guard, true), false);
  return l.lines.filter((line) => /misses Gibbering Mouther|Gibbering Mouther takes \d+ damage/.test(line)).length;
}

test('K15 Gibbering 7-8: the melee attack needs the creature within reach, not within a thrown weapon\'s range', () => {
  // p.289: "The target makes a melee attack against a randomly determined creature within its reach or does nothing if
  // it can't make such an attack." A Guard's Spear has reach 5 ft. and range 20/60 ft.
  assert.equal(gibberingTurn(15), 0);
});

test('K15 control: with the mouther in reach the same roll makes the attack', () => {
  assert.equal(gibberingTurn(5), 1);
});
