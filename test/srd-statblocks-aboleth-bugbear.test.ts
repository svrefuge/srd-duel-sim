// Printed mechanics of the Aboleth to Bugbear Warrior stat blocks. Each test is written from the printed SRD 5.2.1
// text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import { actionEv } from '../src/engine/pairContext.ts';
import type { CombatAction, CombatStatblock, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const riders = (monster: string, name: string): Rider[] => (option(monster, name).action as { riders: Rider[] }).riders;
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
const packet = (damage: number): CombatAction => ({ kind: 'autohit', magical: false, damage: [{ dice: { n: 0, d: 1, mod: damage }, type: 'force' }] });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);

test('F01 Hurl Flame sets only unattended flammable objects alight, never the creature hit', () => {
  // Barbed Devil p.262, Horned Devil p.300: "If the target is a flammable object that isn't being worn or carried, it starts burning."
  assert.deepEqual(riders('Barbed Devil', 'Hurl Flame'), []);
  assert.deepEqual(riders('Horned Devil', 'Hurl Flame'), []);
});

test('F01 control: a print that sets a creature alight keeps its burning rider', () => {
  const burning = block('Magmin').options.flatMap((o) => 'riders' in o.action ? o.action.riders ?? [] : []).filter((r) => r.condition === 'burning');
  assert.equal(burning.length, 1);
});

test('F02 Balor Lightning Blade: a hit bars the target from Reactions until the start of the balor\'s next turn', () => {
  const balor = block('Balor'), foe = tank(), a = e.initState(balor), d = e.initState(foe);
  e.resolveAction(balor, foe, a, d, option('Balor', 'Lightning Blade').action, rolls(0.9), 0, 5, log());
  const held = d.conditions.filter((c) => c.noReactions);
  assert.equal(held.length, 1);
  assert.equal(held[0].duration, 'startOfSourceNextTurn');
});

test('F02 control: Flame Whip prints no such clause and leaves Reactions alone', () => {
  const balor = block('Balor'), foe = tank(), a = e.initState(balor), d = e.initState(foe);
  e.resolveAction(balor, foe, a, d, option('Balor', 'Flame Whip').action, rolls(0.9), 0, 5, log());
  assert.equal(d.conditions.some((c) => c.noReactions), false);
});

test('F04 Berserker Bloodied Frenzy: Advantage on saving throws while Bloodied', () => {
  // d20 shows 3 then 19. Constitution +3 against DC 15: 6 fails, 22 succeeds, so only Advantage saves.
  const berserker = block('Berserker'), state = e.initState(berserker);
  assert.equal(e.rollSave(berserker, state, 'con', 15, false, rolls(0.1, 0.9)), false, 'not Bloodied: one die');
  state.hp = Math.floor(state.maxHp / 2);
  assert.equal(e.rollSave(berserker, state, 'con', 15, false, rolls(0.1, 0.9)), true, 'Bloodied: the higher die');
});

test('F04 control: a creature without the trait rolls one die when Bloodied', () => {
  const guard = tank(), state = e.initState(guard);
  state.hp = Math.floor(state.maxHp / 2);
  assert.equal(e.rollSave(guard, state, 'con', 15, false, rolls(0.1, 0.9)), false);
});

function psychicDrain(missingHp: number) {
  // The target is Grappled by the aboleth and has AC 100, so Lash (one Tentacle attack) is worth nothing and Psychic Drain is taken.
  const aboleth = block('Aboleth'), foe = tank({ ac: 100 }), a = e.initState(aboleth), d = e.initState(foe), lines = log();
  d.conditions.push({ name: 'grappled', duration: 'untilEscape', source: 0, appliedTurn: 0 });
  a.hp = a.maxHp - missingHp;
  const engagement = { ...e.startingEngagement('max30'), distance: 5, ground: 5 };
  e.legendaryStep([aboleth, foe], [a, d], 1, rolls(0.5), engagement, lines, e.createPairEvaluator(aboleth, foe, true));
  return { a, d, lines: lines.lines.join('\n') };
}

test('F11 Aboleth Psychic Drain: uses Consume Memories and regains 1d10 Hit Points', () => {
  // rng 0.5 on 1d10 shows 6.
  const { a, d, lines } = psychicDrain(50);
  assert.match(lines, /legendary Consume Memories/);
  assert.ok(d.hp < d.maxHp, 'Consume Memories dealt its damage');
  assert.equal(a.hp, a.maxHp - 50 + 6);
});

test('F11 control: the healing never exceeds the Hit Point maximum, and Lash carries none', () => {
  const full = psychicDrain(0);
  assert.equal(full.a.hp, full.a.maxHp);
  const entries = block('Aboleth').legendaryOptions;
  assert.deepEqual(entries.map((entry) => !!entry.selfHeal), [false, true]);
});

function pounce(movedToward: number, size: number) {
  const allosaurus = block('Allosaurus'), foe = tank({ size, ac: 5 }), a = e.initState(allosaurus), d = e.initState(foe), lines = log();
  a.movedToward = movedToward;
  e.resolveAction(allosaurus, foe, a, d, option('Allosaurus', 'Claws').action, rolls(0.9), 0, 5, lines);
  return { lost: d.maxHp - d.hp, lines: lines.lines.join('\n') };
}

test('F13 Allosaurus Claws: after a 30-foot run-up a hit on a Large or smaller target grants one Bite attack', () => {
  // rng 0.9: Claws 1d8+4 = 12, then Bite +6 hits and deals 2d10+4 = 24.
  const hit = pounce(30, 3);
  assert.match(hit.lines, /free Bite attack/);
  assert.equal(hit.lost, 12 + 24);
});

test('F13 control: no Bite without the run-up or against a Huge target, and the price follows the run-up', () => {
  assert.equal(pounce(0, 3).lost, 12);
  assert.equal(pounce(30, 4).lost, 12);
  const allosaurus = block('Allosaurus'), foe = tank({ ac: 5 }), claws = option('Allosaurus', 'Claws').action;
  const bite = actionEv(option('Allosaurus', 'Bite').action, allosaurus, foe);
  assert.ok(actionEv(claws, allosaurus, foe, undefined, 30) - actionEv(claws, allosaurus, foe, undefined, 0) >= bite * 0.9);
});

function concentrationSave(shaken: boolean) {
  // Damage 20 gives DC 10. Constitution save +0 would pass on the first die (19) and fail on the second (2).
  const source = tank(), victim = tank({ saves: { con: 0 } }), a = e.initState(source), d = e.initState(victim);
  d.concentrating = true;
  if (shaken) e.applyRiders(d, victim, a, riders('Adult Black Dragon', 'Cloud of Insects'), 0, false, rolls(0.5), log(), true);
  e.dealDamage(source, victim, a, d, packet(20), rolls(0.9, 0.05), 0, false, log());
  return d.concentrating;
}

test('F14 Cloud of Insects: Disadvantage on saving throws to maintain Concentration', () => {
  for (const dragon of ['Adult Black Dragon', 'Ancient Black Dragon']) {
    assert.deepEqual(riders(dragon, 'Cloud of Insects'), [{ condition: 'concentrationShaken', duration: 'endOfTargetNextTurn', concentrationDisadvantage: true }]);
  }
  assert.equal(concentrationSave(true), false);
});

test('F14 control: the same damage and dice keep Concentration without the rider', () => {
  assert.equal(concentrationSave(false), true);
});

function swing(penalised: boolean) {
  // +0 to hit, d20 shows 15, against the Guard's AC 16: a miss, and a hit against AC 14.
  const source = tank(), foe = tank(), a = e.initState(source), d = e.initState(foe);
  assert.equal(foe.ac, 16);
  if (penalised) e.applyRiders(d, foe, a, riders('Adult Green Dragon', 'Noxious Miasma'), 0, false, rolls(0.5), log(), true);
  const attack = { kind: 'attack', toHit: 0, damage: [{ dice: { n: 0, d: 1, mod: 10 }, type: 'force' }], riders: [], magical: false, melee: true, ranged: false, reach: 5, range: 5, requiresSight: false } as CombatAction;
  e.resolveAction(source, foe, a, d, attack, rolls(0.7), 0, 5, log());
  return d.maxHp - d.hp;
}

test('F16 Noxious Miasma: a failed save gives the target -2 AC until the end of its next turn', () => {
  for (const dragon of ['Adult Green Dragon', 'Ancient Green Dragon']) {
    assert.deepEqual(riders(dragon, 'Noxious Miasma'), [{ condition: 'acPenalty', duration: 'endOfTargetNextTurn', acAdjustment: -2 }]);
  }
  assert.equal(swing(true), 10);
});

test('F16 control: the same attack roll misses the unpenalised AC', () => {
  assert.equal(swing(false), 0);
});

test('F09 Cunning Action: the Dash option of "takes the Dash, Disengage, or Hide action" compiles as a bonus action', () => {
  for (const monster of ['Assassin', 'Spy']) {
    const cunning = option(monster, 'Cunning Action (Dash)'); // named for its Dash, beside the Disengage (K05)
    assert.equal(cunning.timing, 'bonus');
    assert.equal(cunning.action.kind, 'selfbuff');
    assert.deepEqual(cunning.action.kind === 'selfbuff' && cunning.action.movement, { mode: 'dash', noProvoke: false });
    assert.equal(block(monster).skipped.some((entry) => entry.name === 'Cunning Action'), false);
  }
});

test('F09 control: a creature that prints no such bonus action gets none', () => {
  assert.equal(block('Bandit').options.some((o) => o.action.kind === 'selfbuff' && o.action.condition === 'bonusMobility'), false);
});

const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });

function flameWhip(size: number, distance: number) {
  const balor = block('Balor'), foe = tank({ size }), a = e.initState(balor), d = e.initState(foe), engagement = at(distance);
  e.resolveOptionWithTeleport(balor, foe, a, d, option('Balor', 'Flame Whip').action, rolls(0.9), 0, engagement, log(), e.createPairEvaluator(balor, foe, true));
  return { distance: engagement.distance, prone: d.conditions.some((c) => c.name === 'prone'), left: d.conditions.map((c) => c.name) };
}

test('F03 Balor Flame Whip: a hit pulls a Huge or smaller target up to 25 feet straight toward the balor, Prone', () => {
  // p.261: "If the target is a Huge or smaller creature, the balor pulls the target up to 25 feet straight toward itself,
  // and the target has the Prone condition." Hit at the whip's 30-foot reach: 30 - 25 = 5 ft. Hit at 10 ft: 10 - 25 is
  // past the balor, so the target stops next to it, 5 ft.
  assert.deepEqual(riders('Balor', 'Flame Whip').filter((r) => r.pull), [{ condition: 'forcedPull', pull: 25, pullUpTo: true, targetMaxSize: 4, duration: 'endOfTargetTurn' }]);
  assert.deepEqual(flameWhip(2, 30), { distance: 5, prone: true, left: ['prone'] });
  assert.equal(flameWhip(4, 10).distance, 5);
});

test('F03 control: a Gargantuan target is neither pulled nor knocked Prone, and Lightning Blade pulls nobody', () => {
  assert.deepEqual(flameWhip(5, 30), { distance: 30, prone: false, left: [] });
  assert.equal(riders('Balor', 'Lightning Blade').some((r) => r.pull), false);
});

function whippedAloft(flySpeed: number | undefined) {
  // The balor hovers 20 ft up and 20 ft off; the target cannot be knocked Prone, so only the pull moves it.
  const balor = block('Balor'), foe = tank({ conditionImmune: ['prone'], flySpeed }), a = e.initState(balor), d = e.initState(foe), lines = log();
  a.height = 20;
  const engagement = at(20);
  e.resolveOptionWithTeleport(balor, foe, a, d, option('Balor', 'Flame Whip').action, rolls(0.9), 0, engagement, lines, e.createPairEvaluator(balor, foe, true));
  e.settleAfterAction(balor, foe, a, d, 0, engagement, rolls(0.9), lines);
  return { height: d.height, fell: lines.lines.filter((line) => line.includes('falls')) };
}

test('F03 Balor Flame Whip: a target with no Fly Speed pulled straight toward an airborne balor falls', () => {
  // The line to the balor is 20 ft long, so the 25-foot pull brings the target to the balor's altitude, 20 ft up. It has no
  // Fly Speed, so it falls those 20 ft.
  assert.deepEqual(whippedAloft(undefined), { height: 0, fell: ['Guard falls 20 ft'] });
});

test('F03 control: a flying target pulled to the same place stays aloft', () => {
  assert.deepEqual(whippedAloft(30), { height: 20, fell: [] });
});

function banished(reappearWithin: number | undefined) {
  // The copy a failed Banish save leaves, as the dragon's turn starts. The guard's spear reaches 5 ft and Rend 10 ft.
  const dragon = block('Adult Gold Dragon'), foe = { ...block('Guard'), hpAvg: 1000 }, a = e.initState(dragon), d = e.initState(foe), lines = log();
  d.conditions.push({ name: 'incapacitated', duration: 'startOfSourceNextTurn', source: 0, appliedTurn: 0, reappearWithin });
  e.takeTurn([dragon, foe], [a, d], 0, rolls(0.5), at(5), lines, e.createPairEvaluator(dragon, foe, true));
  return lines.lines.filter((line) => line.includes('reappears'));
}

test('F17 Gold Dragon Banish: the target reappears in a space of the dragon\'s choice within 120 feet', () => {
  // p.292: "...until the start of the dragon's next turn, at which point it reappears in an unoccupied space of the
  // dragon's choice within 120 feet of the dragon." Banished from 5 ft, a guard (reach 5 ft) is put back at 10 ft: inside
  // Rend's 10-foot reach and outside its own.
  for (const name of ['Adult Gold Dragon', 'Ancient Gold Dragon']) {
    assert.deepEqual(riders(name, 'Banish').map((r) => [r.condition, r.duration, r.reappearWithin]), [['incapacitated', 'startOfSourceNextTurn', 120]]);
  }
  assert.deepEqual(banished(120), ['Guard reappears where Adult Gold Dragon chooses (5 ft -> 10 ft)']);
});

test('F17 control: an effect that ends at the start of its source\'s turn without a reappearance moves nobody', () => {
  assert.deepEqual(banished(undefined), []);
  assert.equal(riders('Balor', 'Lightning Blade').some((r) => r.reappearWithin !== undefined), false);
});

function legendaryEntry(monster: string, entry: string, distance: number, keepMove = true, foe = tank()) {
  // Only the named entry, so the choice among Legendary entries is not what is tested.
  const source = block(monster);
  const actor = { ...source, legendaryOptions: source.legendaryOptions.filter((l) => source.options[l.optionIdx].name === entry).map((l) => keepMove ? l : { ...l, move: undefined }) };
  const a = e.initState(actor), d = e.initState(foe), engagement = at(distance), lines = log();
  e.legendaryStep([actor, foe], [a, d], 1, rolls(0.9), engagement, lines, e.createPairEvaluator(actor, foe, true));
  return { a, d, engagement, lines: lines.lines };
}

test('F19 dragon Pounce: moves up to half its Speed, then makes one Rend attack', () => {
  // p.264: "The dragon moves up to half its Speed, and it makes one Rend attack." Adult Red Dragon: Speed 40 ft., Fly
  // 80 ft.; its Speed is the faster (R03 in srd-pull-distance-and-faster-speed), so 40 ft; Rend reaches 10 ft.
  // From 50 ft: 50 - 40 = 10 ft, in reach, and Rend is made.
  const moves = block('Adult Red Dragon').legendaryOptions.filter((l) => l.move);
  assert.deepEqual(moves.map((l) => [block('Adult Red Dragon').options[l.optionIdx].name, l.move]), [['Rend', { when: 'before', feet: 40, noProvoke: false }]]);
  const { d, engagement, lines } = legendaryEntry('Adult Red Dragon', 'Rend', 50);
  assert.equal(engagement.distance, 10);
  assert.ok(lines.includes('Adult Red Dragon uses legendary Rend'));
  assert.ok(d.hp < d.maxHp);
});

test('F19 control: Pounce cannot reach from 55 feet, and a Rend entry without the move stays out of reach at 30', () => {
  // 55 - 40 = 15 ft, outside Rend's 10-foot reach: no move and no attack.
  const far = legendaryEntry('Adult Red Dragon', 'Rend', 55);
  assert.deepEqual([far.engagement.distance, far.d.hp, far.lines], [55, far.d.maxHp, []]);
  const noMove = legendaryEntry('Adult Red Dragon', 'Rend', 30, false);
  assert.deepEqual([noMove.engagement.distance, noMove.d.hp, noMove.lines], [30, noMove.d.maxHp, []]);
});

test('F19 Blue Dragon Cloaked Flight: casts Invisibility, then may fly up to half its Fly Speed', () => {
  // p.267: "The dragon uses Spellcasting to cast Invisibility on itself, and it can fly up to half its Fly Speed."
  // Fly 80 ft., so 40 ft. Next to a guard (a foe that threatens it) the dragon turns Invisible and flies; neither the
  // climb nor the ground it covers exceeds 40 ft.
  for (const name of ['Adult Blue Dragon', 'Ancient Blue Dragon']) {
    assert.deepEqual(block(name).legendaryOptions.filter((l) => l.move).map((l) => [block(name).options[l.optionIdx].name, l.move]),
      [['Invisibility', { when: 'after', feet: 40, noProvoke: false }]]);
  }
  const { a, engagement, lines } = legendaryEntry('Adult Blue Dragon', 'Invisibility', 5, true, tank({ options: block('Guard').options, routines: block('Guard').routines }));
  assert.ok(a.conditions.some((c) => c.name === 'invisible'));
  assert.ok(lines.includes('Adult Blue Dragon flies as part of legendary Invisibility'));
  assert.ok(a.height > 0 && a.height <= 40 && Math.abs(engagement.ground - 5) <= 40, `height ${a.height}, ground ${engagement.ground}`);
});

test('F19 control: without the printed flight the entry only casts, and other Legendary entries carry no movement', () => {
  const { a, engagement, lines } = legendaryEntry('Adult Blue Dragon', 'Invisibility', 5, false, tank({ options: block('Guard').options, routines: block('Guard').routines }));
  assert.ok(a.conditions.some((c) => c.name === 'invisible'));
  assert.deepEqual([a.height, engagement.ground, lines.some((line) => line.includes('flies'))], [0, 5, false]);
  assert.deepEqual(block('Aboleth').legendaryOptions.filter((l) => l.move), []);
});
