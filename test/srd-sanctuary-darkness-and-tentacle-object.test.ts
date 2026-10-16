// Dimension Door, Invisibility pricing, Dominate saves, tentacles as objects, Sanctuary, Darkness and Fire auras, and
// Tremorsense. Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in the test
// name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, runPair, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { ActionOption, CombatAction, CombatStatblock, DamageClause, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const action = (monster: string, name: string) => option(monster, name).action;
/** A Medium bystander with 1000 hit points, AC 16, Wisdom +0 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
const fixed = (amount: number, type: string): DamageClause[] => [{ dice: { n: 0, d: 1, mod: amount }, type }];
/** A Guard with 1000 hit points whose Spear has this attack bonus and damage, made `count` times. */
const spearman = (toHit = 3, damage: DamageClause[] = fixed(10, 'piercing'), count = 1): CombatStatblock => {
  const spear = block('Guard').options[0];
  const options: ActionOption[] = [{ ...spear, action: { ...spear.action, toHit, damage } as CombatAction }];
  return tank({ options, routines: [{ name: 'Spear', parts: [{ optionIdx: 0, count }] }] });
};
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const names = (state: { conditions: { name: string }[] }) => state.conditions.map((c) => c.name);
const HIGH = 0.9, LOW = 0;

/** `monster` takes one turn against `foe` from `distance`, after `prepare`. */
function turn(monster: string, foe: CombatStatblock, distance: number, roll = HIGH, prepare?: (a: ReturnType<typeof e.initState>) => void) {
  const user = block(monster), a = e.initState(user), d = e.initState(foe, 1), l = log();
  prepare?.(a);
  e.takeTurn([user, foe], [a, d], 0, rolls(roll), at(distance), l, e.createPairEvaluator(user, foe, true), true);
  return { lines: l.lines, a, d };
}

// P01. Spirit Naga against Weretiger: at 130 feet with Lightning Bolt spent the naga must not Dash
// 80 feet when Dimension Door (p. 123: "You teleport to a location within range", 500 feet) was usable.
const spendAll = (monster: string, name: string) => (a: ReturnType<typeof e.initState>) => {
  const idx = block(monster).options.findIndex((o) => o.name === name);
  for (let i = 0; i < 2; i++) e.spend(a, idx, block(monster).options[idx]);
};

test('P01 a Spirit Naga out of range of everything else uses Dimension Door instead of a Dash', () => {
  const lines = turn('Spirit Naga', block('Weretiger'), 130, HIGH, spendAll('Spirit Naga', 'Lightning Bolt')).lines;
  assert.ok(lines.includes('Spirit Naga uses Dimension Door'), lines.join('\n'));
  assert.ok(!lines.some((line) => /dashes/.test(line)));
});

test('P01 control: with Dimension Door spent as well it Dashes', () => {
  const lines = turn('Spirit Naga', block('Weretiger'), 130, HIGH, (a) => {
    spendAll('Spirit Naga', 'Lightning Bolt')(a); spendAll('Spirit Naga', 'Dimension Door')(a);
  }).lines;
  assert.deepEqual(lines, ['Spirit Naga dashes (130 ft -> 50 ft)']);
});

// P02. Rakshasa (p. 317) against Young Brass Dragon (p. 268: Blindsight 30 ft., Fly 80 ft.):
// Invisibility is not usable at 40 feet. From there the dragon has only its breath, which being unseen does not
// hamper; to Rend it closes inside its Blindsight on its own turn, and the spell buys nothing.
test('P02 Invisibility is worth nothing against a foe that must close to attack and brings its Blindsight into range doing so', () => {
  const rakshasa = block('Rakshasa'), dragon = block('Young Brass Dragon');
  assert.equal(dragon.blindsight, 30);
  const ev = (foe: CombatStatblock, distance: number) =>
    e.dynamicEv(action('Rakshasa', 'Invisibility'), rakshasa, foe, e.initState(foe, 1), e.initState(rakshasa), 0, distance, e.createPairEvaluator(rakshasa, foe, true));
  assert.equal(ev(dragon, 40), 0);
  // Control: a foe with no such sense, from inside its Spear's normal range (20/60): past it the throw already has
  // Disadvantage and being unseen adds none (G03).
  assert.ok(ev(block('Guard'), 20) > 0);
  assert.equal(ev(block('Guard'), 40), 0);
  // Control: the same dragon with an attack roll it can make from 40 feet (a Longbow) may stay where it cannot see.
  // The caster must also have something to do from outside that sense, so here both
  // carry the Longbow: the caster's is `armed`. With its own reach 5 and range 30 alone the price is 0 (W01).
  const bow = block('Scout').options.find((o) => o.name === 'Longbow')!;
  const armed = { ...rakshasa, options: [...rakshasa.options, bow] };
  const armedEv = (foe: CombatStatblock) =>
    e.dynamicEv(action('Rakshasa', 'Invisibility'), armed, foe, e.initState(foe, 1), e.initState(armed), 0, 40, e.createPairEvaluator(armed, foe, true));
  assert.ok(armedEv({ ...dragon, options: [...dragon.options, bow] }) > 0);
  assert.equal(armedEv(dragon), 0);
});

// P03. Aboleth, p. 258, Dominate Mind: "The target repeats the save whenever it takes damage ... ending the effect on
// itself on a success." No Advantage is printed. The engine rolled every damage-triggered repeat with Advantage.
/** A tank Charmed by `monster`'s `name`, then hit by a Spear for 10: the hit's d20, then the save's dice `save`. */
function struckWhileCharmed(monster: string, name: string, ...save: number[]) {
  const user = block(monster), foe = tank(), a = e.initState(user), d = e.initState(foe, 1);
  e.resolveAction(user, foe, a, d, action(monster, name), rolls(LOW), 0, 5, log());
  assert.deepEqual(names(d), ['charmed']);
  const striker = spearman(15);
  e.resolveAction(striker, foe, e.initState(striker), d, striker.options[0].action, rolls(HIGH, ...save), 0, 5, log());
  return names(d);
}

test('P03 Dominate Mind: the repeat save on taking damage is one d20, with no Advantage', () => {
  assert.equal((action('Aboleth', 'Dominate Mind (2/Day)') as { riders: Rider[] }).riders[0].saveOnDamageAdvantage, undefined);
  // Wisdom +0 against DC 16. The first d20 is a 1: failed, and the 19 behind it is never rolled.
  assert.deepEqual(struckWhileCharmed('Aboleth', 'Dominate Mind (2/Day)', LOW, HIGH), ['charmed']);
  // A 19 on that one d20 ends it.
  assert.deepEqual(struckWhileCharmed('Aboleth', 'Dominate Mind (2/Day)', HIGH), []);
});

test('P03 control: Dominate Person keeps its printed Advantage on the repeat (the caster is fighting the target)', () => {
  // p. 126: "The target has Advantage on the save if you or your allies are fighting it. Whenever the target takes
  // damage, it repeats the save". A 1 and then a 19 is a 19 against DC 15.
  assert.equal((action('Succubus', 'Dominate Person') as { riders: Rider[] }).riders[0].saveOnDamageAdvantage, true);
  assert.deepEqual(struckWhileCharmed('Succubus', 'Dominate Person', LOW, HIGH), []);
});

// P04 (was H13). Roper, p. 320, Tentacle: "The target has the Grappled condition (escape DC 14) from one of six
// tentacles, and the target has the Poisoned condition until the grapple ends. The tentacle can be damaged, freeing a
// creature it has Grappled when destroyed (AC 20, HP 10, Immunity to Poison and Psychic damage)."
/** `foe`, hit by a Tentacle at 30 feet, takes one turn with every die `roll`. */
function tentacled(foe: CombatStatblock, roll = HIGH) {
  const roper = block('Roper'), a = e.initState(roper), d = e.initState(foe, 1), l = log();
  e.resolveAction(roper, foe, a, d, action('Roper', 'Tentacle'), rolls(HIGH), 0, 30, log());
  assert.deepEqual(names(d), ['grappled', 'poisoned']);
  e.takeTurn([roper, foe], [a, d], 1, rolls(roll), at(30), l, e.createPairEvaluator(roper, foe, true), false);
  return { lines: l.lines, after: names(d) };
}

test('P04 Roper Tentacle: the tentacle is an object (AC 20, HP 10) and the hold keeps its escape DC 14', () => {
  const tentacle = { name: 'tentacle', ac: 20, hp: 10, immune: ['poison', 'psychic'], vulnerable: [] };
  for (const rider of (action('Roper', 'Tentacle') as { riders: Rider[] }).riders) {
    assert.deepEqual(rider.breakable, tentacle);
    assert.equal(rider.escapeDc, 14);
  }
});

test('P04 a creature with two attacks destroys the tentacle with the first, is freed of both conditions, and makes the second', () => {
  // Spear +15, Poisoned: two d20s of 19, 19 + 15 = 34 against AC 20. 10 Piercing leaves the tentacle at 0.
  const held = tentacled(spearman(15, fixed(10, 'piercing'), 2));
  assert.deepEqual(held.lines.slice(0, 3), ['Guard uses Spear on the tentacle', 'Guard hits the tentacle for 10 (0 hp)',
    'The tentacle is destroyed and Guard is no longer grappled or poisoned']);
  assert.ok(held.lines.includes('Roper takes 10 damage (83 hp left)'), held.lines.join('\n'));
  assert.deepEqual(held.after, []);
});

test('P04 control: Poison damage cannot hurt the tentacle, and a poor attacker makes the DC 14 check instead', () => {
  const immune = tentacled(spearman(15, fixed(10, 'poison'), 2));
  assert.ok(!immune.lines.some((line) => /tentacle/.test(line)), immune.lines.join('\n'));
  // Spear +3 with Disadvantage hits AC 20 on two rolls of 17 or more: 0.04 of the tentacle's 10 HP a turn. The check,
  // Strength +1 with Disadvantage against DC 14, is 0.16.
  const weak = tentacled(spearman(3));
  assert.ok(weak.lines.includes('Guard escapes (DC 14)'), weak.lines.join('\n'));
  assert.deepEqual(weak.after, []);
});

// P05. Sanctuary, p. 159: "any creature who targets the warded creature with an attack roll or a damaging spell must
// succeed on a Wisdom saving throw or either choose a new target or lose the attack or spell. This spell doesn't
// protect the warded creature from areas of effect. The spell ends if the warded creature makes an attack roll, casts
// a spell, or deals damage." Priest Acolyte, p. 316, Divine Aid (1/Day), a Bonus Action; spell save DC 12.
/** A warded Priest Acolyte and its state. */
function warded() {
  const priest = block('Priest Acolyte'), a = e.initState(priest);
  e.resolveAction(priest, tank(), a, e.initState(tank(), 1), action('Priest Acolyte', 'Sanctuary'), rolls(HIGH), 0, 5, log());
  assert.deepEqual(names(a), ['sanctuary']);
  return { priest, a };
}

test('P05 Sanctuary compiles as a Bonus Action ward at the spell save DC', () => {
  const priest = option('Priest Acolyte', 'Sanctuary'), couatl = option('Couatl', 'Sanctuary');
  assert.deepEqual([priest.timing, (priest.action as { wardDc?: number }).wardDc, (priest.action as { rounds?: number }).rounds], ['bonus', 12, 10]);
  assert.deepEqual([couatl.timing, (couatl.action as { wardDc?: number }).wardDc], ['bonus', 15]);
  for (const name of ['Couatl', 'Priest Acolyte']) assert.ok(!block(name).skipped.some((s) => s.name === 'Sanctuary'));
});

test('P05 an attacker that fails the Wisdom save loses the attack; one that succeeds attacks as usual', () => {
  const striker = spearman(15), spear = striker.options[0].action;
  // Wisdom +0 against DC 12: a 1 fails, and no attack roll is made.
  const lost = warded(), l = log();
  e.resolveAction(striker, lost.priest, e.initState(striker, 1), lost.a, spear, rolls(LOW, HIGH), 1, 5, l);
  assert.deepEqual(l.lines, ["Guard loses the attack to Priest Acolyte's sanctuary"]);
  assert.equal(lost.a.hp, lost.priest.hpAvg);
  // A 19 saves; the next d20 is the attack, 19 + 15 against AC 13, for 10.
  const hit = warded();
  e.resolveAction(striker, hit.priest, e.initState(striker, 1), hit.a, spear, rolls(HIGH), 1, 5, log());
  assert.equal(hit.a.hp, hit.priest.hpAvg - 10);
  assert.deepEqual(names(hit.a), ['sanctuary']);
});

test('P05 an area spell is not warded against, and a damaging spell aimed at the creature is', () => {
  const mage = block('Mage'), fireball = action('Mage', 'Fireball'), bolt = action('Adult Brass Dragon', 'Scorching Ray');
  assert.equal(fireball.area, true);
  assert.equal(bolt.area, undefined);
  const burned = warded();
  e.resolveAction(mage, burned.priest, e.initState(mage, 1), burned.a, fireball, rolls(LOW), 1, 30, log());
  assert.ok(burned.a.hp < burned.priest.hpAvg);
  const spared = warded(), l = log(), dragon = block('Adult Brass Dragon');
  e.resolveAction(dragon, spared.priest, e.initState(dragon, 1), spared.a, bolt, rolls(LOW), 1, 30, l);
  assert.deepEqual(l.lines, ["Adult Brass Dragon loses the spell to Priest Acolyte's sanctuary"]);
});

test('P05 the ward ends when the warded creature makes an attack roll, and not when it is merely attacked', () => {
  const { priest, a } = warded(), l = log();
  e.resolveAction(priest, tank(), a, e.initState(tank(), 1), action('Priest Acolyte', 'Mace'), rolls(HIGH), 0, 5, l);
  assert.equal(l.lines[0], "Priest Acolyte's sanctuary ends");
  assert.deepEqual(names(a), []);
});

test('P05 in its turn the acolyte attacks first and wards itself after, with its Bonus Action', () => {
  // Against a foe whose every action is an attack roll. Its other Divine Aid choices are Bless and Healing Word.
  const { lines, a } = turn('Priest Acolyte', spearman(15, fixed(10, 'piercing'), 2), 5);
  assert.ok(lines.indexOf('Priest Acolyte uses bonus action Sanctuary') > lines.findIndex((line) => /^Priest Acolyte uses (Mace|Radiant Flame)/.test(line)), lines.join('\n'));
  assert.deepEqual(names(a), ['sanctuary']);
});

// P06. Darkmantle, p. 279, Darkness Aura (1/Day): "Magical Darkness fills a 15-foot Emanation originating from the
// darkmantle. This effect lasts while the darkmantle maintains Concentration on it, up to 10 minutes. Darkvision can't
// penetrate this area, and no light can illuminate it." The darkmantle has Blindsight 60 ft.
/** A Darkmantle with its aura up. */
function shrouded() {
  const mantle = block('Darkmantle'), a = e.initState(mantle);
  e.resolveAction(mantle, tank(), a, e.initState(tank(), 1), action('Darkmantle', 'Darkness Aura (1/Day)'), rolls(HIGH), 0, 5, log());
  return { mantle, a };
}

test('P06 Darkness Aura: the darkmantle is unseen, except by Blindsight in range and by Darkvision unimpeded by magical Darkness', () => {
  assert.ok(!block('Darkmantle').skipped.some((s) => /Darkness Aura/.test(s.name)));
  const { a } = shrouded();
  assert.equal(e.canSee(block('Guard'), a, undefined, 5), false);
  // Bearded Devil, p. 262: "Darkvision 120 ft. (unimpeded by magical Darkness)".
  assert.equal(block('Bearded Devil').seesMagicalDarkness, true);
  assert.equal(e.canSee(block('Bearded Devil'), a, undefined, 5), true);
  assert.equal(e.canSee(tank({ blindsight: 10 }), a, undefined, 10), true);
  assert.equal(e.canSee(tank({ blindsight: 10 }), a, undefined, 15), false);
  // "No light can illuminate it": an outline (Faerie Fire) does not show the darkmantle.
  a.conditions.push({ name: 'outlined', duration: 'permanent', source: 1, appliedTurn: 0 });
  assert.equal(e.canSee(block('Guard'), a, undefined, 5), false);
});

test('P06 control: ordinary Invisibility is not seen through by a devil, and is cancelled by an outline', () => {
  const rakshasa = block('Rakshasa'), a = e.initState(rakshasa);
  e.resolveAction(rakshasa, tank(), a, e.initState(tank(), 1), action('Rakshasa', 'Invisibility'), rolls(HIGH), 0, 5, log());
  assert.equal(e.canSee(block('Bearded Devil'), a, undefined, 5), false);
  a.conditions.push({ name: 'outlined', duration: 'permanent', source: 1, appliedTurn: 0 });
  assert.equal(e.canSee(block('Guard'), a, undefined, 5), true);
});

test('P06 the aura is not ended by the darkmantle attacking', () => {
  const { mantle, a } = shrouded(), foe = tank();
  e.resolveAction(mantle, foe, a, e.initState(foe, 1), action('Darkmantle', 'Crush'), rolls(HIGH), 0, 5, log());
  assert.ok(names(a).includes('invisible'));
});

// P07. Fire Elemental, p. 284, Fire Aura: "each creature in a 10-foot Emanation originating from the elemental takes 5
// (1d10) Fire damage". A flier's altitudes were the ground, where it is, the ceiling, the foe's own height and the
// lowest height outside the foe's reach. Against a Large elemental with a 5-foot reach that last is 10 + 5 + 5 = 20
// feet: 10 feet above it, inside the aura. The lowest height clear of the aura is 10 + 10 + 5 = 25.
test('P07 a flier is offered the lowest altitude clear of the foe\'s emanation', () => {
  const wyrmling = block('Bronze Dragon Wyrmling'), elemental = block('Fire Elemental');
  assert.equal(elemental.sourceTurnAura?.radius, 10);
  const heights = e.moveHeights(wyrmling, 0, elemental, 0, 60, 120);
  assert.ok(heights.includes(25), String(heights));
  assert.equal(e.verticalGap(wyrmling, 20, elemental, 0), 10);
  assert.equal(e.verticalGap(wyrmling, 25, elemental, 0), 15);
  // Control: a foe with no emanation adds no altitude.
  assert.deepEqual(e.moveHeights(wyrmling, 0, block('Guard'), 0, 60, 120), [0, 60, 15]);
});

test('P07 the wyrmling does not lose every fight in the 120-foot arena by hovering inside the Fire Aura', () => {
  // 0 of 40 before. In the 30-foot arena, where the ceiling already kept it at 25 feet, it won 186 of 400.
  const result = runPair(block('Bronze Dragon Wyrmling'), block('Fire Elemental'), 40, 1, 'max120');
  assert.ok(result.winsA > 0, JSON.stringify(result));
});

// Q02. Xorn, p. 343: "Senses Darkvision 60 ft., Tremorsense 60 ft." and "Charge. The xorn moves up to its Speed or Burrow
// Speed straight toward an enemy it can sense." The engine granted the sense by the name "Xorn".
/** Whether this creature's Charge is worth anything against an Invisible foe on the ground at `distance`. */
function chargesUnseen(xorn: CombatStatblock, distance: number, foeHeight = 0): boolean {
  const foe = tank(), d = e.initState(foe, 1), charge = xorn.options.find((o) => o.name === 'Charge')!.action;
  d.conditions.push({ name: 'invisible', duration: 'permanent', source: 1, appliedTurn: 0 });
  d.height = foeHeight;
  return e.dynamicEv(charge, xorn, foe, d, e.initState(xorn), 0, distance, e.createPairEvaluator(xorn, foe, true), 'bonus') > 0;
}

test('Q02 Tremorsense is a compiled range, and a creature of any name senses an unseen foe on the ground inside it', () => {
  assert.equal(block('Xorn').tremorsense, 60);
  assert.equal(block('Bulette').tremorsense, 120);
  // Speed 20: from 30 feet the Charge and the move bring its Bite and Claws into reach.
  assert.equal(chargesUnseen({ ...block('Xorn'), name: 'Renamed' }, 30), true);
  // Control: a shorter range, a foe in the air, and no Tremorsense.
  assert.equal(chargesUnseen({ ...block('Xorn'), tremorsense: 25 }, 30), false);
  assert.equal(chargesUnseen(block('Xorn'), 30, 20), false);
  assert.equal(chargesUnseen({ ...block('Xorn'), tremorsense: undefined }, 30), false);
});

// Q03, Q04. Two rules read the printed sentence, not the monster's name.
test('Q03 Q04 Fire Aura ignites and Hasten gates the third Slam, read from the text', () => {
  // Fire Elemental, p. 284: "Creatures and flammable objects in the Emanation start burning." Balor's Fire Aura does not say so.
  assert.deepEqual(block('Fire Elemental').sourceTurnAura?.riders.map((r) => r.condition), ['burning']);
  assert.deepEqual(block('Balor').sourceTurnAura?.riders.map((r) => r.condition), []);
  // Clay Golem, p. 274: "The golem makes two Slam attacks, or it makes three Slam attacks if it used Hasten this turn."
  assert.deepEqual(block('Clay Golem').routines.map((r) => r.requiresCondition), [undefined, 'hastened', undefined]);
  assert.ok(block('Stone Golem').routines.every((r) => r.requiresCondition === undefined));
});

// Q05. Remorhaz, p. 319-320: "the remorhaz must succeed on a DC 15 Constitution saving throw at the end of that turn or
// regurgitate all swallowed creatures". A remorhaz at 0 Hit Points makes no save.
function swallowerSave(remorhazHp: number): string[] {
  const remorhaz = block('Remorhaz'), victim = tank();
  const a = e.initState(remorhaz), b = e.initState(victim, 1), l = log();
  const swallow = remorhaz.options.find((o) => o.name === 'Swallow')!.action as { riders: Rider[] };
  e.applyRiders(b, victim, a, swallow.riders, 0, false, () => 0, l);
  b.turnCount = 1;
  a.hp = remorhazHp;
  e.dealDamage(victim, remorhaz, b, a, { kind: 'autohit', magical: false, damage: fixed(30, 'force') } as CombatAction, () => 0, 1, false, l);
  e.endTurn([remorhaz, victim], [a, b], 1, { ...e.startingEngagement('max600'), distance: 0, ground: 0 }, () => 0, l);
  return l.lines.filter((line) => /regurgitation save/.test(line));
}

test('Q05 a swallower reduced to 0 Hit Points by the creature inside it rolls no regurgitation save', () => {
  assert.deepEqual(swallowerSave(30), []);
  // Control: with Hit Points left the save is made (1 + 5 against DC 15 fails).
  assert.deepEqual(swallowerSave(100), ['Remorhaz fails its regurgitation save']);
});

// R1. Frost Giant against Roper went from 312/66 to 188/365: the giant swung at the tentacle (AC 20, at Disadvantage)
// instead of making its check. Its 25 a hit was counted in full against an object with 10 Hit Points.
test('R1 damage past the tentacle\'s 10 Hit Points does not count toward choosing the attacks over the check', () => {
  // A melee-only attacker held 30 feet from the Roper: the tentacle and the check are all it has. Spear +9 for 25,
  // Poisoned: 0.5 x 0.5 = 0.25 a swing, two swings, 10 a hit at most: 0.5 of the tentacle. The check, Athletics +9 with
  // Disadvantage against DC 14, is 0.8 x 0.8 = 0.64. Counted in full the swings came to 1.25.
  const melee = (changes: Partial<CombatStatblock> = {}): CombatStatblock => {
    const base = spearman(9, fixed(25, 'piercing'), 2);
    return { ...base, options: base.options.map((o) => ({ ...o, action: { ...o.action, ranged: false, range: 5, longRange: undefined } as CombatAction })), ...changes };
  };
  const strong = tentacled(melee({ skills: { athletics: 9 } }));
  assert.ok(strong.lines.includes('Guard escapes (DC 14)'), strong.lines.join('\n'));
  // Control: at Athletics +1 (0.16) the same swings are the better chance.
  const weak = tentacled(melee());
  assert.equal(weak.lines[0], 'Guard uses Spear on the tentacle', weak.lines.join('\n'));
});

// R3. Couatl against Chuul fell from 0.48 to 0.32: Sanctuary was priced at the Chuul's whole routine, Paralyzing
// Tentacles (a saving throw, not an attack roll or a spell) included, and took the Divine Aid uses Bless would have had.
test('R3 Sanctuary is priced by the attack rolls in the foe\'s routine, not by a save effect it does not stop', () => {
  const couatl = block('Couatl'), ward = action('Couatl', 'Sanctuary');
  const ev = (foe: CombatStatblock) => e.dynamicEv(ward, couatl, foe, e.initState(foe, 1), e.initState(couatl), 0, 5, e.createPairEvaluator(couatl, foe, true), 'bonus');
  const breath = block('Young Brass Dragon').options.find((o) => o.name === 'Sleep Breath')!;
  const breather = tank({ options: [breath], routines: [{ name: 'Breath', parts: [{ optionIdx: 0, count: 1 }] }] });
  assert.equal(ev(breather), 0);
  assert.ok(ev(spearman(15)) > 0);
});

test('R3 in a long fight the Couatl casts Bless before Sanctuary; the acolyte, in a short one, wards itself', () => {
  // Triceratops, 114 Hit Points against the Couatl's Bite: the fight outlasts the four turns a lasting buff is priced over.
  // It opens with Sleep from 30 feet, which the Triceratops saves against (a 19).
  const couatl = block('Couatl'), foe = block('Triceratops'), l = log();
  e.takeTurn([couatl, foe], [e.initState(couatl), e.initState(foe, 1)], 0, rolls(HIGH), e.startingEngagement('max30'), l, e.createPairEvaluator(couatl, foe, true), true);
  const long = l.lines;
  assert.ok(long.includes('Couatl uses bonus action Bless') && !long.includes('Couatl uses bonus action Sanctuary'), long.join('\n'));
  // The acolyte's 11 Hit Points against 20 a turn: Sanctuary (P05's last test covers the order).
  const short = turn('Priest Acolyte', spearman(15, fixed(10, 'piercing'), 2), 5).lines;
  assert.ok(short.includes('Priest Acolyte uses bonus action Sanctuary'), short.join('\n'));
});
