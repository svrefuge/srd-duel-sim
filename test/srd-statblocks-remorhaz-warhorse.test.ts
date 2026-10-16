// Printed mechanics of the Remorhaz to Warhorse stat blocks. Each test is written from the printed SRD 5.2.1 text
// quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock, Rider } from '../src/types.ts';

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

/** One use of an option from `distance`, every die showing `roll`, in a bound fight; then the fall, if anyone is dropped. */
function use(monster: string, name: string, distance: number, roll: number, foe: CombatStatblock = tank(), before?: (s: ReturnType<typeof e.initState>, t: ReturnType<typeof e.initState>) => void) {
  const user = block(monster), a = e.initState(user), d = e.initState(foe), engagement = at(distance), lines = log();
  e.bindPlace([user, foe], [a, d], engagement);
  before?.(a, d);
  e.resolveOptionWithTeleport(user, foe, a, d, action(monster, name), rolls(roll), 0, engagement, lines, e.createPairEvaluator(user, foe, true));
  e.settleAfterAction(user, foe, a, d, 0, engagement, rolls(roll), lines);
  return { distance: engagement.distance, held: names(d), a, d, lines: lines.lines, user, foe };
}

test('M01 Shambling Mound Engulf: targets a Medium or smaller creature within 5 feet that it does not yet hold', () => {
  // p.323: "Engulf. Strength Saving Throw: DC 15, one Medium or smaller creature within 5 feet. Failure: The target is
  // pulled into the shambling mound's space and has the Grappled condition (escape DC 14). Until the grapple ends, the
  // target has the Blinded and Restrained conditions". No grapple is asked for first; Charged Tendril gives none.
  assert.equal((action('Shambling Mound', 'Engulf') as { requiresTargetCondition?: string }).requiresTargetCondition, undefined);
  const foe = tank(), d = e.initState(foe);
  assert.ok(e.actionTargetable(action('Shambling Mound', 'Engulf'), block('Shambling Mound'), foe, 5, d));
  // Strength save, d20 showing 1: fails DC 15.
  assert.deepEqual(use('Shambling Mound', 'Engulf', 5, LOW).held.sort(), ['blinded', 'grappled', 'restrained']);
});

test('M01 control: a Large creature is no target, and a Swallow printed "Grappled by the remorhaz" still needs the grapple', () => {
  assert.equal(e.actionTargetable(action('Shambling Mound', 'Engulf'), block('Shambling Mound'), tank({ size: 3 }), 5), false);
  assert.equal((action('Remorhaz', 'Swallow') as { requiresTargetCondition?: string }).requiresTargetCondition, 'grappled');
});

test('M02 Satyr Hooves and Tough Boss Warhammer: a hit pushes the target up to 10 feet straight away', () => {
  // p.322: "If the target is a Medium or smaller creature, the satyr pushes the target up to 10 feet straight away from
  // itself." p.332: "If the target is a Large or smaller creature, the tough pushes the target up to 10 feet straight away
  // from itself." Hit at 5 ft: 5 + 10 = 15 ft.
  assert.equal(use('Satyr', 'Hooves', 5, HIGH).distance, 15);
  assert.equal(use('Tough Boss', 'Warhammer', 5, HIGH).distance, 15);
  assert.equal(use('Tough Boss', 'Warhammer', 5, HIGH, tank({ size: 3 })).distance, 15);
});

test('M02 in a Multiattack: "up to" is the tough\'s choice, so its first Warhammer hit does not push the target out of the second\'s reach', () => {
  // Two Warhammer attacks, reach 5 ft., both hitting: the first leaves the target where it is, the last pushes it 10 feet.
  const boss = block('Tough Boss'), foe = tank(), a = e.initState(boss), d = e.initState(foe), engagement = at(5), turn = log();
  e.bindPlace([boss, foe], [a, d], engagement);
  e.takeTurn([boss, foe], [a, d], 0, rolls(HIGH), engagement, turn, e.createPairEvaluator(boss, foe, true), false);
  assert.equal(turn.lines.filter((line) => line === 'Tough Boss uses Warhammer').length, 2, turn.lines.join('\n'));
  assert.deepEqual(turn.lines.filter((line) => /is pushed/.test(line)), ['Guard is pushed (5 ft -> 15 ft)']);
  assert.equal(engagement.distance, 15);
});

test('M02 control: a miss pushes nobody, nor does a hit on a creature above the printed size', () => {
  assert.equal(use('Satyr', 'Hooves', 5, LOW).distance, 5);
  assert.equal(use('Satyr', 'Hooves', 5, HIGH, tank({ size: 3 })).distance, 5);
  assert.equal(use('Tough Boss', 'Warhammer', 5, HIGH, tank({ size: 4 })).distance, 5);
  assert.equal(riders('Tough', 'Mace').some((r) => r.push), false);
});

test('M03 Roper: its Speed on open ground is its printed 10 feet, not its Climb Speed', () => {
  // p.320: "Speed 10 ft., Climb 20 ft."
  assert.equal(block('Roper').speed, 10);
});

test('M03 control: a Fly Speed is still the creature\'s Speed where it is the faster, and a Swim Speed is not', () => {
  assert.equal(block('Stirge').speed, 40); // "Speed 10 ft., Fly 40 ft."
  assert.equal(block('Sea Hag').speed, 30); // "Speed 30 ft., Swim 40 ft."
});

/** A Sphinx of Wonder making a Wisdom save (+1) against `dc` with the d20 showing 10. */
function sphinxSave(dc: number, prepare?: (s: ReturnType<typeof e.initState>) => void) {
  const sphinx = block('Sphinx of Wonder'), state = e.initState(sphinx);
  prepare?.(state);
  const saved = e.rollSave(sphinx, state, 'wis', dc, false, rolls(0.45));
  return { saved, left: state.rollBoostLeft, reactionUsed: state.reactionUsed };
}

test('M04 Sphinx of Wonder Burst of Ingenuity: the Reaction adds 2 to its own saving throw, twice a day', () => {
  // p.327: "Burst of Ingenuity (2/Day). Trigger: The sphinx or another creature within 30 feet makes an ability check or a
  // saving throw. Response: The sphinx adds 2 to the roll." Wis +1: a 10 is 11, and 13 with the Reaction.
  assert.deepEqual(block('Sphinx of Wonder').rollBoost, { name: 'Burst of Ingenuity', bonus: 2, perDay: 2 });
  assert.deepEqual(sphinxSave(13), { saved: true, left: 1, reactionUsed: true });
  assert.deepEqual(sphinxSave(12), { saved: true, left: 1, reactionUsed: true });
});

test('M04 control: not spent on a roll that 2 cannot save or that succeeds, nor without a Reaction or a use', () => {
  assert.deepEqual(sphinxSave(14), { saved: false, left: 2, reactionUsed: false });
  assert.deepEqual(sphinxSave(11), { saved: true, left: 2, reactionUsed: false });
  assert.deepEqual(sphinxSave(13, (s) => { s.reactionUsed = true; }), { saved: false, left: 2, reactionUsed: true });
  assert.deepEqual(sphinxSave(13, (s) => { s.rollBoostLeft = 0; }), { saved: false, left: 0, reactionUsed: false });
  assert.equal(block('Sphinx of Lore').rollBoost, undefined);
});

/** The roc's Talons hit `foe` (every die high), then it uses Swoop. */
function swoop(foe: CombatStatblock, grapple = true) {
  return use('Roc', 'Swoop', 5, HIGH, foe, (a, d) => {
    if (grapple) e.resolveAction(block('Roc'), foe, a, d, action('Roc', 'Talons'), rolls(HIGH), 0, 5, log());
    d.hp = 1000;
  });
}

test('M05 Roc Swoop: it flies up half its Fly Speed with the creature it has Grappled and drops it', () => {
  // p.320: "Swoop (Recharge 5-6). If the roc has a creature Grappled, the roc flies up to half its Fly Speed without
  // provoking Opportunity Attacks and drops that creature." Fly 120 ft.: 60 feet up. A fall is 1d6 per 10 feet and the
  // creature lands Prone: six d6 each showing 6 = 36, 1000 -> 964.
  assert.deepEqual(option('Roc', 'Swoop').uses, { t: 'recharge', min: 5 });
  assert.equal(option('Roc', 'Swoop').timing, 'bonus');
  const { a, d, held, lines } = swoop(tank());
  assert.equal(a.height, 60);
  assert.equal(d.height, 0);
  assert.equal(d.hp, 964, lines.join('\n'));
  assert.deepEqual(held, ['prone']); // the Grappled and Restrained conditions end with the hold
});

test('M05 control: nothing without a Grappled creature; a Huge one costs double to carry; a flier is not worth dropping', () => {
  const free = swoop(tank(), false);
  assert.equal(free.a.height, 0);
  assert.equal(free.d.hp, 1000);
  // Gargantuan carrying Huge: each foot costs 1 extra, so 30 feet up and 3d6 = 18.
  const huge = swoop(tank({ size: 4 }));
  assert.equal(huge.a.height, 30);
  assert.equal(huge.d.hp, 982, huge.lines.join('\n'));
  // The Bonus Action step does not choose it against a creature with a Fly Speed, or with nothing held.
  for (const [foe, grapple] of [[tank({ flySpeed: 30 }), true], [tank(), false]] as const) {
    const roc = block('Roc'), a = e.initState(roc), d = e.initState(foe), engagement = at(5), lines = log();
    e.bindPlace([roc, foe], [a, d], engagement);
    if (grapple) e.resolveAction(roc, foe, a, d, action('Roc', 'Talons'), rolls(HIGH), 0, 5, log());
    assert.equal(e.bonusActionStep(roc, foe, a, d, rolls(HIGH), 0, engagement, lines, e.createPairEvaluator(roc, foe, true)), false, lines.lines.join('\n'));
  }
});

test('M06 Succubus Charm: Dominate Person charms a Humanoid on a failed Wisdom save, made with Advantage, and controls it', () => {
  // p.331: "Multiattack. The succubus makes one Fiendish Touch attack and uses Charm or Draining Kiss." "Charm. The
  // succubus casts Dominate Person (level 8 version) ... (spell save DC 15)." p.126: "One Humanoid you can see within range
  // must succeed on a Wisdom saving throw or have the Charmed condition for the duration. The target has Advantage on the
  // save if you or your allies are fighting it."
  assert.deepEqual(block('Succubus').routines.map((r) => r.name),
    ['Multiattack (Fiendish Touch)', 'Multiattack (Fiendish Touch) + Dominate Person', 'Multiattack (Fiendish Touch) + Draining Kiss', 'Draining Kiss', 'Dominate Person']);
  const charm = action('Succubus', 'Dominate Person') as { concentration?: boolean; concentrationRounds?: number; range?: number };
  assert.deepEqual([charm.concentration, charm.concentrationRounds, charm.range], [true, undefined, 60]); // level 8: up to 8 hours
  // Both d20s show 1: fails. The charmed Humanoid is under control, and Draining Kiss now has its target.
  const failed = use('Succubus', 'Dominate Person', 5, LOW);
  assert.deepEqual(failed.held, ['charmed']);
  assert.ok(e.controlled(failed.d));
  assert.ok(e.actionTargetable(action('Succubus', 'Draining Kiss'), failed.user, failed.foe, 5, failed.d, failed.a));
  // Advantage: a 1 and then a 19 is a 19, which saves (Guard Wis +0 against DC 15).
  const user = block('Succubus'), foe = tank(), a = e.initState(user), d = e.initState(foe);
  e.resolveAction(user, foe, a, d, action('Succubus', 'Dominate Person'), rolls(LOW, HIGH), 0, 5, log());
  assert.deepEqual(names(d), []);
  // "Whenever the target takes damage, it repeats the save, ending the spell on itself on a success."
  const struck = use('Succubus', 'Dominate Person', 5, LOW);
  e.resolveAction(struck.user, struck.foe, struck.a, struck.d, action('Succubus', 'Fiendish Touch'), rolls(HIGH), 0, 5, log());
  assert.deepEqual(names(struck.d), []);
});

test('M06 control: a creature that is not a Humanoid is no target, and Draining Kiss needs a creature Charmed by the succubus', () => {
  const beast = tank({ creatureType: 'beast' });
  assert.equal(e.actionTargetable(action('Succubus', 'Dominate Person'), block('Succubus'), beast, 5), false);
  assert.equal((action('Succubus', 'Draining Kiss') as { requiresTargetCondition?: string }).requiresTargetCondition, 'charmed');
  // A turn against a Beast it has not charmed: the Touch, and neither Charm nor the Kiss.
  const succubus = block('Succubus'), a = e.initState(succubus), d = e.initState(beast), engagement = at(5), turn = log();
  e.bindPlace([succubus, beast], [a, d], engagement);
  e.takeTurn([succubus, beast], [a, d], 0, rolls(0.5), engagement, turn, e.createPairEvaluator(succubus, beast, true), false);
  assert.ok(turn.lines.includes('Succubus uses Fiendish Touch'), turn.lines.join('\n'));
  assert.ok(!turn.lines.some((line) => /Dominate Person|Draining Kiss/.test(line)), turn.lines.join('\n'));
});

test('M07 Tarrasque World-Shaking Movement: a Legendary Action that ends Concentration and knocks Medium or smaller creatures Prone', () => {
  // p.332: "World-Shaking Movement. The tarrasque moves up to its Speed. At the end of this movement, the tarrasque creates
  // an instantaneous shock wave in a 60-foot Emanation originating from itself. Creatures in that area lose Concentration
  // and, if Medium or smaller, have the Prone condition." Speed 60 ft. No roll and no save.
  const tarrasque = block('Tarrasque'), idx = tarrasque.options.findIndex((o) => o.name === 'World-Shaking Movement');
  assert.deepEqual(tarrasque.legendaryOptions.find((l) => l.optionIdx === idx), { optionIdx: idx, count: 1, requiresMythic: undefined, move: { when: 'before', feet: 60, noProvoke: false } });
  assert.deepEqual(tarrasque.skipped, []);
  const shaken = use('Tarrasque', 'World-Shaking Movement', 60, LOW, tank(), (_, d) => { d.concentrating = true; });
  assert.deepEqual(shaken.held, ['prone']);
  assert.equal(shaken.d.concentrating, false);
  assert.equal(shaken.d.hp, 1000);
});

test('M07 control: a Large creature keeps its feet but still loses Concentration', () => {
  const large = use('Tarrasque', 'World-Shaking Movement', 60, LOW, tank({ size: 3 }), (_, d) => { d.concentrating = true; });
  assert.deepEqual(large.held, []);
  assert.equal(large.d.concentrating, false);
});

test('M07 in a Legendary step: out of reach of Onslaught, the tarrasque moves and shakes a Medium creature Prone', () => {
  // 120 ft away: Onslaught's 30-foot move leaves the Tail (reach 30 ft.) 90 feet short; 60 feet of movement puts the
  // creature on the edge of the 60-foot Emanation.
  const tarrasque = block('Tarrasque'), foe = tank(), a = e.initState(tarrasque), d = e.initState(foe), engagement = at(120), lines = log();
  e.bindPlace([tarrasque, foe], [a, d], engagement);
  e.legendaryStep([tarrasque, foe], [a, d], 1, rolls(0.5), engagement, lines, e.createPairEvaluator(tarrasque, foe, true));
  assert.deepEqual(names(d), ['prone'], lines.lines.join('\n'));
  assert.equal(engagement.distance, 60);
});

test('M08 Vrock Stunning Screech: demons succeed automatically, so a demon is no target', () => {
  // p.336: "Constitution Saving Throw: DC 15, each creature in a 20-foot Emanation originating from the vrock (demons
  // succeed automatically). Failure: 10 (3d6) Thunder damage, and the target has the Stunned condition". A success has no
  // effect.
  const screech = action('Vrock', 'Stunning Screech (1/Day)');
  assert.deepEqual((screech as { excludedTargetTags?: string[] }).excludedTargetTags, ['demon']);
  for (const demon of ['Balor', 'Marilith', 'Dretch', 'Vrock']) assert.equal(e.actionTargetable(screech, block('Vrock'), block(demon), 5), false, demon);
});

test('M08 control: a devil and a Humanoid are targets, and fail the save', () => {
  const screech = action('Vrock', 'Stunning Screech (1/Day)');
  assert.ok(e.actionTargetable(screech, block('Vrock'), block('Imp'), 5));
  assert.ok(e.actionTargetable(screech, block('Vrock'), tank(), 5));
  assert.deepEqual(use('Vrock', 'Stunning Screech (1/Day)', 5, LOW).held, ['stunned']);
});

test('M09 Unicorn\'s Blessing: its spells go on another creature, so the unicorn does not cast Lesser Restoration on itself', () => {
  // p.334: "Unicorn's Blessing (3/Day). The unicorn touches another creature with its horn and casts Cure Wounds or Lesser
  // Restoration on that creature".
  const unicorn = block('Unicorn');
  assert.deepEqual(unicorn.options.filter((o) => /Restoration|Cure Wounds/.test(o.name)), []);
  assert.deepEqual(unicorn.skipped.filter((s) => /Restoration|Cure Wounds/.test(s.name)).map((s) => s.reason),
    ['cast on another creature: no ally in a duel', 'cast on another creature: no ally in a duel']);
});

test('M09 control: a caster whose print says only "casts" still cures itself, and the unicorn keeps its other spells', () => {
  for (const caster of ['Couatl', 'Priest', 'Deva', 'Planetar', 'Solar']) assert.equal(option(caster, 'Lesser Restoration')?.timing, 'bonus', caster);
  assert.deepEqual(block('Unicorn').options.filter((o) => /\.spellcasting$/.test(o.sourceRef ?? '')).map((o) => o.name), ['Dispel Evil and Good', 'Entangle']);
});
