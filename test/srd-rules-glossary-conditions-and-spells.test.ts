// The Rules Glossary, the combat chapter and the spell descriptions against the engine. Each test is written from the
// printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight, FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import { mulberry32 } from '../src/rng.ts';
import { actionEv, bestRoutineEvAtDistance } from '../src/engine/pairContext.ts';
import type { AttackAction, CombatAction, CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (b: CombatStatblock, name: string) => b.options.find((o) => o.name === name)!;
const log = () => new FightLog(true);
/** A Guard's body with nothing to do: AC 15, 1,000 hit points, Dexterity +1, Speed 30, no saves of its own. */
const dummy = (): CombatStatblock => ({ ...block('Guard'), ac: 15, hpAvg: 1000, saves: {}, options: [], routines: [], reaction: undefined });
const swing = (toHit: number): AttackAction => ({ kind: 'attack', toHit, damage: [{ dice: { n: 0, d: 1, mod: 1 }, type: 'piercing' }], riders: [], magical: false, melee: true, ranged: false, reach: 5 });
const held = (name: string) => ({ name, duration: 'permanent', source: 0, appliedTurn: 0 }) as any;
const near = (actual: number, expected: number, tolerance: number, label: string) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} vs ${expected}`);

/** The share of 4,000 uses of `action` at `distance` that damage a fresh `foe`, prepared by `prepare`. */
function hitRate(user: CombatStatblock, foe: CombatStatblock, action: CombatAction, distance: number, prepare: (d: any, a: any) => void = () => {}): number {
  const rng = mulberry32(11);
  let hits = 0;
  for (let i = 0; i < 4000; i++) {
    const a = e.initState(user), d = e.initState(foe);
    a.turnCount = 1;
    prepare(d, a);
    e.resolveAction(user, foe, a, d, action, rng, 0, distance, new FightLog(false));
    if (d.hp < d.maxHp) hits++;
  }
  return hits / 4000;
}

test('RS01 the Dodge action gives attack rolls against the dodger Disadvantage', () => {
  // p181, Dodge: "until the start of your next turn, any attack roll made against you has Disadvantage if you can see
  // the attacker, and you make Dexterity saving throws with Advantage."
  // +5 against AC 15 hits on a 10: 11 faces of 20, 0.55. With Disadvantage both dice must: 0.55^2 = 0.3025.
  const foe = dummy();
  near(hitRate(foe, foe, swing(5), 5), 0.55, 0.03, 'no Dodge');
  near(hitRate(foe, foe, swing(5), 5, (d) => { d.dodging = true; }), 0.3025, 0.03, 'Dodge');
});

test('RS01 control: the Dodge is lost at Speed 0, while Incapacitated, and at the start of the next turn', () => {
  // p181: "You lose these benefits if you have the Incapacitated condition or if your Speed is 0."
  // Grappled is Speed 0 and gives the attacker nothing else: 0.55 again.
  const foe = dummy();
  near(hitRate(foe, foe, swing(5), 5, (d) => { d.dodging = true; d.conditions.push(held('grappled')); }), 0.55, 0.03, 'Dodge at Speed 0');
  // Incapacitated alone gives attackers no Advantage (p184): 0.55.
  near(hitRate(foe, foe, swing(5), 5, (d) => { d.dodging = true; d.conditions.push(held('incapacitated')); }), 0.55, 0.03, 'Dodge while Incapacitated');
  const d = e.initState(foe);
  d.dodging = true;
  e.startTurn(foe, d, () => 0.5, log());
  assert.equal(d.dodging, false);
});

test('RS01 the Dodge action gives Dexterity saves Advantage, and no other save', () => {
  // Dexterity +1 against DC 12 succeeds on an 11: 0.5. With Advantage 1 - 0.5^2 = 0.75. Constitution +1 (a Guard's):
  // DC 12 stays at 0.5.
  const foe = dummy();
  const rate = (ability: 'dex' | 'con', dodging: boolean) => {
    const rng = mulberry32(5);
    let saved = 0;
    for (let i = 0; i < 4000; i++) {
      const d = e.initState(foe);
      d.dodging = dodging;
      if (e.rollSave(foe, d, ability, 11 + foe.abilityMods[ability], false, rng)) saved++;
    }
    return saved / 4000;
  };
  near(rate('dex', false), 0.5, 0.03, 'Dexterity, no Dodge');
  near(rate('dex', true), 0.75, 0.03, 'Dexterity, Dodge');
  near(rate('con', true), 0.5, 0.03, 'Constitution, Dodge');
});

test('RS01 a creature with no action it can use takes the Dodge action; one that attacks does not', () => {
  // Xorn (Speed 20, no Fly Speed, reach 5, no ranged option) against a Wyvern that stings from the air: without the Dodge,
  // the Xorn would take no action at all for 16 to 24 rounds (PT09).
  const stuck = fight(block('Xorn'), block('Wyvern'), 1, true, 'max30').log;
  assert.ok(stuck.includes('Xorn dodges'), 'the Xorn dodges');
  const round1 = stuck.slice(0, stuck.indexOf('Round 2'));
  assert.ok(round1.includes('Xorn uses Bite') && !round1.includes('Xorn dodges'), 'not on the turn it attacks');
  // Control: two creatures that reach each other every turn never Dodge.
  assert.ok(!fight(block('Elephant'), block('Ogre'), 1, true, 'max30').log.some((line) => line.endsWith(' dodges')));
});

/** Adult Red Dragon's price for an option against an Adult Blue Dragon with no Legendary Resistance left. */
function price(name: string, prepare: (d: any) => void = () => {}): number {
  const user = block('Adult Red Dragon'), foe = block('Adult Blue Dragon'), a = e.initState(user), d = e.initState(foe);
  d.legendaryResistances = 0;
  prepare(d);
  return e.dynamicEv(option(user, name).action, user, foe, d, a, 0, 5, e.createPairEvaluator(user, foe, true));
}

test('RS02 a Dexterity save against a Restrained creature is priced with its Disadvantage', () => {
  // p187, Restrained: "You have Disadvantage on Dexterity saving throws."
  // Adult Red Dragon Fire Breath: Dexterity DC 21, half on a success. Adult Blue Dragon: Dexterity save +5, so it fails
  // on a 15 or less: 0.75, worth 0.75 + 0.25 / 2 = 0.875 of the damage. With Disadvantage 1 - 0.25^2 = 0.9375, worth
  // 0.96875. The price rises by 0.96875 / 0.875.
  near(price('Fire Breath', (d) => d.conditions.push(held('restrained'))) / price('Fire Breath'), 0.96875 / 0.875, 1e-9, 'Fire Breath');
});

test('RS02 the Dodge action is priced: Advantage on the Dexterity save, Disadvantage on the attack', () => {
  // With Advantage the save fails 0.75^2 = 0.5625 of the time, worth 0.78125 of the damage.
  near(price('Fire Breath', (d) => { d.dodging = true; }) / price('Fire Breath'), 0.78125 / 0.875, 1e-9, 'Fire Breath');
  // A Dodging, Restrained creature has Speed 0 and so no Dodge: Restrained's price alone.
  near(price('Fire Breath', (d) => { d.dodging = true; d.conditions.push(held('restrained')); }) / price('Fire Breath'), 0.96875 / 0.875, 1e-9, 'both');
  assert.ok(price('Rend', (d) => { d.dodging = true; }) < price('Rend'));
});

test('RS02 control: Restrained does nothing for a Wisdom save', () => {
  // Command is a Wisdom save: Restrained names Dexterity only.
  near(price('Command', (d) => d.conditions.push(held('restrained'))), price('Command'), 1e-9, 'Command');
});

test('RS03 Harm cannot reduce a Hit Point maximum below 1', () => {
  // p139, Harm: "On a failed save, it takes 14d6 Necrotic damage, and its Hit Point maximum is reduced by an amount
  // equal to the Necrotic damage it took. ... This spell can't reduce a target's Hit Point maximum below 1."
  // A creature of 10 hit points behind 200 temporary ones fails the save (every die shows 1: 14 damage, all of it
  // absorbed). Its maximum falls by 14 from 10, and stops at 1; it is alive.
  const lord = block('Mummy Lord'), harm = option(lord, 'Harm').action;
  assert.equal((harm as any).damage[0].reducesMaxHpFloor, 1);
  const cast = (action: CombatAction) => {
    const foe = { ...dummy(), hpAvg: 10 }, a = e.initState(lord), d = e.initState(foe);
    d.tempHp = 200;
    e.resolveAction(lord, foe, a, d, action, () => 0.01, 0, 30, log());
    return d;
  };
  const harmed = cast(harm);
  assert.equal(harmed.tempHp, 186);
  assert.equal(harmed.maxHp, 1);
  assert.equal(harmed.hp, 1);
  assert.ok(!harmed.slain);
  // Control: the same reduction with no printed floor takes the maximum to 0, which kills.
  const unfloored = cast({ ...(harm as any), damage: (harm as any).damage.map(({ reducesMaxHpFloor, ...clause }: any) => clause) });
  assert.equal(unfloored.maxHp, 0);
  assert.ok(unfloored.slain);
  // And no other compiled reduction carries a floor (a Wight's Life Drain prints none).
  assert.deepEqual(blocks.filter((b) => /reducesMaxHpFloor/.test(JSON.stringify(b))).map((b) => b.name), ['Mummy Lord']);
});

test('RS04 Spiritual Weapon is a melee spell attack: a foe beside the caster gives it no Disadvantage', () => {
  // p165, Spiritual Weapon: "you can make one melee spell attack against one creature within 5 feet of the force."
  // p15, Ranged Attacks in Close Combat: "When you make a ranged attack roll ... you have Disadvantage on the roll if
  // you are within 5 feet of an enemy" - a ranged attack roll, which this is not.
  // Cultist Fanatic, +4 against AC 15: hits on an 11, 0.5; it was rolled at Disadvantage, 0.25.
  const fanatic = block('Cultist Fanatic'), weapon = option(fanatic, 'Spiritual Weapon').action as AttackAction;
  assert.equal(weapon.conjuredMelee, true);
  near(hitRate(fanatic, dummy(), weapon, 5), 0.5, 0.03, 'Spiritual Weapon at 5 feet');
  // Control: a ranged attack roll with the same numbers has the Disadvantage at 5 feet, and not at 30.
  const { conjuredMelee, ...ranged } = weapon;
  near(hitRate(fanatic, dummy(), ranged, 5), 0.25, 0.03, 'ranged at 5 feet');
  near(hitRate(fanatic, dummy(), ranged, 30), 0.5, 0.03, 'ranged at 30 feet');
  // No ranged spell attack carries the mark (a Priest's Guiding Bolt is a ranged spell attack).
  assert.deepEqual(blocks.filter((b) => b.options.some((o) => (o.action as any).conjuredMelee)).map((b) => b.name), ['Cultist Fanatic']);
});

test('RS21 a mover whose Fly ends to an opportunity attack walks the rest of its move; it does not climb and fall', () => {
  // p131, Fly: "Concentration, up to 10 minutes ... The target gains a Fly Speed of 60 feet for the duration."
  // p179, Concentration: damage forces a Constitution save, and on a failure the spell ends.
  // Mage v Troll, max600, seed 2: the Mage casts Fly beside the Troll and moves; the Troll's opportunity attack ends
  // its Concentration; the Mage must not then rise to 30 feet with no Fly Speed and fall.
  const log = fight(block('Mage'), block('Troll'), 2, true, 'max600').log;
  const lost = log.indexOf('Mage loses Concentration'), turn = log.slice(lost, log.findIndex((line, i) => i > lost && line.startsWith('Troll ')));
  assert.ok(lost > 0 && log[lost - 2] === 'Troll makes an opportunity attack', 'the fight still loses Fly to the opportunity attack');
  assert.ok(turn.includes('Mage can no longer fly and stays at 0 ft'), turn.join(' / '));
  assert.ok(!turn.some((line) => /altitude|falls/.test(line)), turn.join(' / '));
  assert.ok(turn.some((line) => line.includes('(5 ft -> 35 ft)')), 'it still moves its 30 feet');
});

test('RS21 control: a Mage whose Fly holds through the opportunity attack climbs', () => {
  // Every Fly cast in eight open fights against the Troll that is not followed by a lost Concentration on that move
  // still ends with the Mage aloft.
  let climbs = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const log = fight(block('Mage'), block('Troll'), seed, true, 'max600').log;
    for (let i = log.indexOf('Mage becomes flying'); i >= 0; i = log.indexOf('Mage becomes flying', i + 1)) {
      const move = log.slice(i, i + 6);
      if (!move.includes('Mage loses Concentration') && move.some((line) => /^Mage flies .*altitude 0 ft to \d+ ft/.test(line))) climbs++;
      if (!move.includes('Mage loses Concentration')) assert.ok(!move.some((line) => line.includes('can no longer fly')), move.join(' / '));
    }
  }
  assert.ok(climbs > 0, 'at least one Fly cast in the eight fights climbs');
});

const strike = (damage: number): AttackAction => ({ ...swing(100), damage: [{ dice: { n: 0, d: 1, mod: damage }, type: 'slashing' }] });

test('RS22 a Troll at 0 Hit Points is Unconscious until it regenerates, and remains Prone then', () => {
  // p17, Dropping to 0 Hit Points: "When a creature drops to 0 Hit Points, it either dies outright or falls
  // unconscious". p333, Troll, Regeneration: "The troll dies only if it starts its turn with 0 Hit Points and doesn't
  // regenerate." p191, Unconscious: Incapacitated and Prone; "When this condition ends, you remain Prone."
  const troll = block('Troll'), foe = dummy(), a = e.initState(foe), t = e.initState(troll);
  a.turnCount = 1;
  e.resolveAction(foe, troll, a, t, strike(200), () => 0.5, 0, 5, log());
  assert.ok(t.hp <= 0);
  assert.ok(!t.slain);
  assert.ok(t.conditions.some((c) => c.name === 'unconscious'), 'Unconscious at 0');
  assert.equal(e.reactionAvailable(troll, t), false, 'no Reaction, so no opportunity attack');
  assert.equal(e.currentSpeed(troll, t), 0);
  // Its turn starts: it regains 15, wakes, and is Prone.
  const lines = log();
  e.startTurn(troll, t, () => 0.5, lines);
  assert.equal(t.hp, 15);
  assert.ok(!t.conditions.some((c) => c.name === 'unconscious'));
  assert.ok(t.conditions.some((c) => c.name === 'prone'), lines.lines.join(' / '));
  // Adult Bronze Dragon v Troll, max120, seed 1: no Troll opportunity attack while it has 0.
  const fightLog = fight(block('Adult Bronze Dragon'), troll, 1, true, 'max120').log;
  let out = false;
  for (const line of fightLog) {
    if (line === 'Troll falls unconscious at 0 hit points') out = true;
    if (line.startsWith('Troll regenerates back up')) out = false;
    assert.ok(!(out && /^Troll (makes an opportunity attack|uses|moves|flees)/.test(line)), line);
  }
  assert.ok(fightLog.includes('Troll falls unconscious at 0 hit points'));
});

test('RS22 control: a Troll with Hit Points left keeps its Reaction, and a creature with no such trait just dies', () => {
  const troll = block('Troll'), foe = dummy(), a = e.initState(foe), t = e.initState(troll);
  a.turnCount = 1;
  e.resolveAction(foe, troll, a, t, strike(50), () => 0.5, 0, 5, log());
  assert.equal(t.hp, troll.hpAvg - 50);
  assert.ok(!t.conditions.some((c) => c.name === 'unconscious'));
  assert.equal(e.reactionAvailable(troll, t), true);
  const ogre = block('Ogre'), o = e.initState(ogre);
  e.resolveAction(foe, ogre, a, o, strike(200), () => 0.5, 0, 5, log());
  assert.ok(o.hp <= 0 && !o.conditions.some((c) => c.name === 'unconscious'));
});

/** A Lich about to cast Dispel Magic, with spells of the foe's (index 1) on itself and on the foe. */
function dispelling(onSelf: any[], onFoe: any[]) {
  const lich = block('Lich'), foe = dummy(), a = e.initState(lich), d = e.initState(foe);
  a.turnCount = 1;
  const spell = (c: any) => ({ duration: 'permanent', source: 1, appliedTurn: 0, magical: true, ...c });
  a.conditions.push(...onSelf.map(spell));
  d.conditions.push(...onFoe.map(spell));
  const action = option(lich, 'Dispel Magic').action;
  const ev = e.dynamicEv(action, lich, foe, d, a, 0, 30, e.createPairEvaluator(lich, foe, true));
  e.resolveAction(lich, foe, a, d, action, () => 0.5, 0, 30, log());
  return { ev, self: a.conditions.map((c) => c.name), foe: d.conditions.map((c) => c.name) };
}

test('RS23 Dispel Magic is cast on the caster to end a Slow spell on it', () => {
  // p124, Dispel Magic: "Any ongoing spell of level 3 or lower on the target ends." p161, Slow (level 3): half Speed,
  // -2 to AC and Dexterity saves, no Reactions, an action or a Bonus Action, one attack only.
  // It was aimed at the foe, whose Bless ended, and the Slow stayed.
  const cast = dispelling([{ name: 'slowed', spellLevel: 3 }], [{ name: 'blessed', spellLevel: 1 }]);
  assert.deepEqual(cast.self, []);
  assert.deepEqual(cast.foe, ['blessed']);
  assert.ok(cast.ev > 0);
});

test('RS23 control: with nothing on the caster the spell goes at the foe', () => {
  const cast = dispelling([], [{ name: 'blessed', spellLevel: 1 }]);
  assert.deepEqual(cast.foe, []);
});

test("RS24 Mind Spike's outline gives attackers nothing, so Dispel Magic is not spent on it", () => {
  // p150, Mind Spike: "it gains no benefit from that condition [Invisible] against you" - no Advantage for anyone.
  // p128, Faerie Fire: "Attack rolls against an affected creature or object have Advantage".
  const spike = dispelling([{ name: 'outlined', spellLevel: 2 }], [{ name: 'blessed', spellLevel: 1 }]);
  assert.deepEqual(spike.self, ['outlined']);
  assert.deepEqual(spike.foe, []);
  // Control: Faerie Fire's outline does, and is ended first.
  const fire = dispelling([{ name: 'outlined', spellLevel: 1, rollEffects: [{ roll: 'attackAgainst', mode: 'advantage' }] }], [{ name: 'blessed', spellLevel: 1 }]);
  assert.deepEqual(fire.self, []);
  assert.deepEqual(fire.foe, ['blessed']);
});

test("RS25 a creature under the Fear spell is Frightened: Disadvantage on its attacks, and no Legendary move toward the caster", () => {
  // p130, Fear: "have the Frightened condition for the duration. A Frightened creature takes the Dash action and moves
  // away from you ... on each of its turns". p182, Frightened: "You have Disadvantage on ability checks and attack
  // rolls while the source of fear is within line of sight" and "You can't willingly move closer to the source of fear."
  // +5 against AC 15: 0.55, and 0.3025 at Disadvantage.
  const foe = dummy();
  near(hitRate(foe, foe, swing(5), 5, (_d, a) => a.conditions.push({ ...held('fearSpell'), source: 1 })), 0.3025, 0.03, 'under Fear');
  // Adult Black Dragon v Lich, max30, seed 1: after "gains fearSpell" the dragon flees on its
  // turn and must not then close 30 ft -> 10 ft "for legendary Rend".
  const log = fight(block('Adult Black Dragon'), block('Lich'), 1, true, 'max30').log;
  let afraid = false, seen = 0;
  for (const line of log) {
    if (line === 'Adult Black Dragon gains fearSpell') { afraid = true; seen++; }
    else if (/^Adult Black Dragon (is no longer|ends|shakes off)/.test(line) || line === 'Lich loses Concentration') afraid = false;
    const move: RegExpMatchArray | null | false = afraid && line.match(/^Adult Black Dragon .*\((\d+) ft -> (\d+) ft\)/);
    if (move) assert.ok(Number(move[2]) >= Number(move[1]), line);
    assert.ok(!(afraid && line.startsWith('Adult Black Dragon closes for legendary')), line);
  }
  assert.ok(seen > 0, 'the Lich still casts Fear in this fight');
});

test('RS25 control: a creature immune to Frightened is not held by Fear', () => {
  const lich = block('Adult Black Dragon'), fear = option(lich, 'Fear').action;
  const cast = (target: CombatStatblock) => {
    const a = e.initState(lich), d = e.initState(target);
    a.turnCount = 1;
    e.resolveAction(lich, target, a, d, fear, () => 0.01, 0, 10, log());
    return d.conditions.map((c) => c.name);
  };
  assert.deepEqual(cast(dummy()), ['fearSpell']);
  assert.deepEqual(cast({ ...dummy(), conditionImmune: ['frightened'] }), []);
});

test("RS26 Dispel Magic is cast on the caster to end the Fear spell or Phantasmal Killer on it", () => {
  // p130, Fear (level 3): "have the Frightened condition for the duration". p158, Phantasmal Killer (level 4): "has
  // Disadvantage on ability checks and attack rolls for the duration". Both went unrecognised: the spell was aimed at
  // the foe. Fear ends outright (level 3). Phantasmal Killer needs the check: DC 14, and a Lich's 10 + 5 makes it.
  const fear = dispelling([{ name: 'fearSpell', spellLevel: 3 }], [{ name: 'blessed', spellLevel: 1 }]);
  assert.deepEqual(fear.self, []);
  assert.deepEqual(fear.foe, ['blessed']);
  const killer = dispelling([{ name: 'afflicted', spellLevel: 4 }], [{ name: 'blessed', spellLevel: 1 }]);
  assert.deepEqual(killer.self, []);
  assert.deepEqual(killer.foe, ['blessed']);
  // Control: a spell on the caster that costs it nothing (the foe's Mirror Image marker would not be on it; an
  // unpriced name stands in) leaves the choice at the foe.
  const idle = dispelling([{ name: 'sustaining', spellLevel: 2 }], [{ name: 'blessed', spellLevel: 1 }]);
  assert.deepEqual(idle.foe, []);
});

test('RS28 a mover its own Reaction teleported mid-move goes no farther than the movement it has left', () => {
  // p309, Mummy Lord: "Speed 30 ft." p310, Whirlwind of Sand: "Trigger: The mummy is hit by an attack roll. Response:
  // ... the mummy teleports up to 60 feet". A teleport spends no movement, and gives none.
  // Mummy Lord v Kraken, max120, seed 6, round 1: leaving 30 ft, the Kraken's opportunity
  // attack hits, the mummy teleports to 5 ft and must not then walk "5 ft -> 60 ft": 55 ft on a Speed of 30.
  const log = fight(block('Mummy Lord'), block('Kraken'), 6, true, 'max120').log;
  const whirl = log.indexOf('Mummy Lord uses Whirlwind of Sand');
  assert.ok(whirl > 0 && log[whirl + 2] === 'Mummy Lord teleports (30 ft -> 5 ft)', 'the fight still opens with the teleport');
  const move = log.slice(whirl).find((line) => line.startsWith('Mummy Lord moves'))!.match(/\((\d+) ft -> (\d+) ft\)/)!;
  assert.ok(Math.abs(Number(move[2]) - Number(move[1])) <= 30, move[0]);
});

test('RS28 no walking move in twelve Mummy Lord fights exceeds its Speed, or two Speeds on a Dash', () => {
  for (let seed = 1; seed <= 6; seed++) for (const foe of ['Kraken', 'Ogre']) {
    for (const line of fight(block('Mummy Lord'), block(foe), seed, true, 'max120').log) {
      const move = line.match(/^Mummy Lord (moves|dashes) \((\d+) ft -> (\d+) ft\)/);
      if (move) assert.ok(Math.abs(Number(move[3]) - Number(move[2])) <= (move[1] === 'dashes' ? 60 : 30), `${foe} seed ${seed}: ${line}`);
    }
  }
});

test('RS28 control: a mover the opportunity attack did not relocate still makes its whole move', () => {
  // Ogre (Speed 40) leaving an Elephant's reach in the open: hit or missed, it stands where it stood, and walks on.
  const ogre = block('Ogre'), elephant = block('Elephant'), a = e.initState(ogre), d = e.initState(elephant);
  const ground = { ...e.startingEngagement('max600'), distance: 5, ground: 5 };
  e.bindPlace([ogre, elephant], [a, d], ground);
  a.turnCount = 1;
  const lines = log();
  e.applyMovement(ogre, a, elephant, d, 0, ground, 45, 0, mulberry32(3), lines, e.createPairEvaluator(ogre, elephant, true), 'moves', false, 40);
  assert.ok(lines.lines.includes('Elephant makes an opportunity attack'), lines.lines.join(' / '));
  assert.equal(ground.ground, 45);
});

test("RS29 Consume Life is priced against a Troll held Unconscious at 0 Hit Points", () => {
  // p340, Will-o'-Wisp, Consume Life: "Constitution Saving Throw: DC 10, one living creature the wisp can see within 5
  // feet that has 0 Hit Points. Failure: The target dies". With RS22 the Troll at 0 is Unconscious, and an effect that
  // deals no damage to an Incapacitated foe was priced at nothing: the one way the wisp has to kill a Troll went unused.
  const wisp = block("Will-o'-Wisp"), troll = block('Troll'), a = e.initState(wisp), t = e.initState(troll);
  a.turnCount = 1;
  const consume = option(wisp, 'Consume Life').action, evaluator = e.createPairEvaluator(wisp, troll, true);
  // Control: nothing against a Troll with Hit Points left.
  assert.equal(e.dynamicEv(consume, wisp, troll, t, a, 0, 5, evaluator, 'bonus'), 0);
  e.resolveAction(dummy(), troll, e.initState(dummy()), t, strike(500), () => 0.5, 1, 5, log());
  assert.ok(t.hp <= 0 && t.conditions.some((c) => c.name === 'unconscious'));
  assert.ok(e.dynamicEv(consume, wisp, troll, t, a, 0, 5, evaluator, 'bonus') > 0);
  // And it kills on a failed save (every die a 1).
  const lines = log();
  e.resolveAction(wisp, troll, a, t, consume, () => 0.01, 0, 5, lines);
  assert.ok(t.slain, lines.lines.join(' / '));
});

test('RS30 a Frightened caster of Fly does not use its new Fly Speed to close on the source of its fear', () => {
  // p182, Frightened: "You can't willingly move closer to the source of fear." Ghost, Horrific Visage: Frightened
  // "until the start of the ghost's next turn". Glabrezu v Ghost, max30, seed 9, round 1, the line it must not print:
  // "Glabrezu gains frightened / Glabrezu uses Fly / Glabrezu flies (30 ft -> 5 ft) [altitude 0 ft to 20 ft]".
  for (const seed of [9, 18, 37]) {
    const lines = fight(block('Glabrezu'), block('Ghost'), seed, true, 'max30').log;
    let afraid = false;
    for (const line of lines) {
      if (line === 'Glabrezu gains frightened') afraid = true;
      else if (/^Glabrezu (is no longer|ends) frightened/.test(line) || line.startsWith('Ghost uses') || line.startsWith('Ghost moves')) afraid = false;
      const move: RegExpMatchArray | null | false = afraid && line.match(/^Glabrezu (?:flies|moves|dashes) \((\d+) ft -> (\d+) ft\)/);
      if (move) assert.ok(Number(move[2]) >= Number(move[1]), `seed ${seed}: ${line}`);
    }
  }
});

test('RS30 control: a caster of Fly that is not Frightened still flies to a foe in the air', () => {
  // In sixteen fights against the Ghost, a Glabrezu that is not Frightened at the time closes by flying at least once.
  let closes = 0;
  for (let seed = 1; seed <= 8; seed++) {
    for (const scenario of ['max30', 'max600'] as const) {
      const lines = fight(block('Glabrezu'), block('Ghost'), seed, true, scenario).log;
      let afraid = false;
      for (const line of lines) {
        if (line === 'Glabrezu gains frightened') afraid = true;
        else if (line.startsWith('Ghost uses') || line.startsWith('Ghost moves')) afraid = false;
        const move: RegExpMatchArray | null | false = !afraid && line.match(/^Glabrezu flies \((\d+) ft -> (\d+) ft\)/);
        if (move && Number(move[2]) < Number(move[1])) closes++;
      }
    }
  }
  assert.ok(closes > 0, 'an unfrightened Glabrezu still flies toward the Ghost');
});

test('RS34 a Frightened creature does not close on the source of its fear with a Bonus Action move or a leap', () => {
  // p182, Frightened: "You can't willingly move closer to the source of fear." Xorn v Ghost, max30, seed 13, the lines it must
  // not print: "Xorn gains frightened / Xorn uses bonus action Charge / Xorn uses bonus movement (30 ft -> 20 ft)".
  // Bulette v Mummy, max30, seed 15: Frightened by Dreadful Glare, then "uses Deadly Leap / jumps (15 ft -> 5 ft)".
  const closes = (user: string, foe: string, seeds: number[], ends: RegExp) => {
    let seen = 0;
    for (const seed of seeds) {
      let afraid = false;
      for (const line of fight(block(user), block(foe), seed, true, 'max30').log) {
        if (line === `${user} gains frightened`) { afraid = true; seen++; }
        else if (ends.test(line)) afraid = false;
        const move: RegExpMatchArray | null | false = afraid && line.match(new RegExp(`^${user} .*\\((\\d+) ft -> (\\d+) ft\\)`));
        if (move) assert.ok(Number(move[2]) >= Number(move[1]), `${user} v ${foe} seed ${seed}: ${line}`);
      }
    }
    return seen;
  };
  // Horrific Visage and Dreadful Glare both last until the source's next turn: its first line there ends the hold.
  assert.ok(closes('Xorn', 'Ghost', [13, 14, 15], /^Ghost (uses|moves|flies|dodges)/) > 0);
  assert.ok(closes('Bulette', 'Mummy', [13, 14, 15, 16], /^Mummy (uses|moves|dodges)/) > 0);
  // The leap is not offered to a Frightened Bulette that would have to close to make it; it is to one that is not.
  const bulette = block('Bulette'), mummy = block('Mummy'), a = e.initState(bulette), d = e.initState(mummy);
  const leap = option(bulette, 'Deadly Leap').action;
  assert.equal(e.actionTargetable(leap, bulette, mummy, 15, d, a), true);
  a.conditions.push({ ...held('frightened'), source: 1 });
  assert.equal(e.actionTargetable(leap, bulette, mummy, 15, d, a), false);
});

test('RS34 the guard itself: a Frightened creature moves away but not closer; one that is not (the control) closes', () => {
  const xorn = block('Xorn'), ghost = block('Ghost');
  const move = (frightened: boolean, to: number) => {
    const a = e.initState(xorn), d = e.initState(ghost), ground = { ...e.startingEngagement('max30'), distance: 20, ground: 20 };
    e.bindPlace([xorn, ghost], [a, d], ground);
    a.turnCount = 1;
    if (frightened) a.conditions.push({ ...held('frightened'), source: 1 });
    e.applyMovement(xorn, a, ghost, d, 0, ground, to, 0, () => 0.5, log(), e.createPairEvaluator(xorn, ghost, true), 'moves', false, 20);
    return ground.ground;
  };
  assert.equal(move(true, 30), 30);
  assert.equal(move(true, 5), 20);
  assert.equal(move(false, 5), 5);
});

test('RS35 a Giant Hyena its own bite brought to 0 Hit Points does not Rampage', () => {
  // p352, Giant Hyena, Rampage: "Immediately after dealing damage to a creature that is already Bloodied, the hyena
  // moves up to half its Speed, and it makes one Bite attack." p17: "A monster dies the instant it drops to 0 Hit
  // Points". Black Pudding, Corrosive Form: a creature that hits it with a melee attack takes Acid damage.
  // Black Pudding v Giant Hyena, max600, seed 22, round 5, lines it must not print: "Giant Hyena takes 3 damage (0 hp
  // left) / Giant Hyena uses bonus action Rampage (1/Day)".
  const lines = fight(block('Black Pudding'), block('Giant Hyena'), 22, true, 'max600').log;
  const dead = lines.findIndex((line) => /^Giant Hyena takes \d+ damage \(0 hp left\)/.test(line));
  assert.ok(dead > 0, 'the hyena still dies to the pudding in this fight');
  assert.ok(!lines.slice(dead).some((line) => /^Giant Hyena (uses|moves|makes)/.test(line)), lines.slice(dead).join(' / '));
});

test('RS35 control: a living Giant Hyena still Rampages after damaging a Bloodied creature', () => {
  let rampages = 0;
  for (let seed = 1; seed <= 6; seed++) rampages += fight(block('Giant Hyena'), block('Ogre'), seed, true, 'max30').log.filter((line) => line.startsWith('Giant Hyena uses bonus action Rampage')).length;
  assert.ok(rampages > 0);
});

/** An Ogre (Speed 40) walks from 5 to 45 feet out of an Elephant's reach; returns the log and the Elephant's state. */
function ogreLeavesElephant(prepare: (elephantState: any) => void = () => {}) {
  const ogre = block('Ogre'), elephant = block('Elephant'), a = e.initState(ogre), d = e.initState(elephant);
  const ground = { ...e.startingEngagement('max600'), distance: 5, ground: 5 };
  e.bindPlace([ogre, elephant], [a, d], ground);
  a.turnCount = 1;
  prepare(d);
  const lines = log();
  e.applyMovement(ogre, a, elephant, d, 0, ground, 45, 0, mulberry32(3), lines, e.createPairEvaluator(ogre, elephant, true), 'moves', false, 40);
  assert.equal(ground.ground, 45);
  return { lines: lines.lines, elephant: d };
}

test('R08 a Blinded creature makes no Opportunity Attack and keeps its Reaction', () => {
  // p185, Opportunity Attacks: "You can make an Opportunity Attack when a creature that you can see leaves your reach".
  // Blinded: "You can't see". In Dragon Turtle v Storm Giant (max120, seed 3) the missing Opportunity Attack is
  // correct: Thunderbolt's Blinded lasts "until the start of the giant's next turn", and the giant left on that turn.
  const { lines, elephant } = ogreLeavesElephant((d) => d.conditions.push({ name: 'blinded', duration: 'startOfSourceNextTurn', source: 0, appliedTurn: 0 }));
  assert.ok(!lines.includes('Elephant makes an opportunity attack'), lines.join(' / '));
  assert.equal(elephant.reactionUsed, false);
});

test('R08 control: the same Elephant, able to see, makes it', () => {
  const { lines, elephant } = ogreLeavesElephant();
  assert.ok(lines.includes('Elephant makes an opportunity attack'));
  assert.equal(elephant.reactionUsed, true);
});

/** The option names a creature used, turn by turn, in a traced fight. */
const used = (a: string, b: string, seed: number) => fight(block(a), block(b), seed, true, 'max30').log
  .filter((line) => line.startsWith(`${a} uses `)).map((line) => line.slice(`${a} uses `.length));
const partNames = (b: CombatStatblock, parts: { optionIdx: number }[]) => parts.map((part) => b.options[part.optionIdx].name);

test('U04 a Gladiator makes its Shield Bash before the Spear attacks it gives Advantage to', () => {
  // p289: "The gladiator makes three Spear attacks. It can replace one attack with a use of Shield Bash." Any one of
  // the three. Shield Bash: "Strength Saving Throw: DC 15 ... If the target is a Medium or smaller creature, it has the
  // Prone condition." Knight (AC 18, Strength save +3): Spear hits on a 11, 5.85 a swing and 8.93 with Advantage; the
  // save fails 55%. Bash last 2 x 5.85 + 4.95 = 16.65; Bash first 4.95 + 2 x (0.55 x 8.93 + 0.45 x 5.85) = 20.0.
  const gladiator = block('Gladiator'), knight = block('Knight');
  const routine = gladiator.routines.find((r) => r.name === 'Multiattack (Spear) + Shield Bash')!;
  assert.deepEqual(partNames(gladiator, routine.parts), ['Spear', 'Shield Bash']);
  assert.deepEqual(partNames(gladiator, e.attackOrder(routine, gladiator, knight, e.initState(knight), 5)), ['Shield Bash', 'Spear']);
  assert.deepEqual(used('Gladiator', 'Knight', 1).slice(0, 3), ['Shield Bash', 'Spear', 'Spear']);
});

test('U04 the knock-down that goes first is priced by the two Spears behind it', () => {
  // Half-Dragon (AC 18, Strength +4): the save fails 50%. Three Spears 17.55; Bash first 4.5 + 2 x (0.5 x 8.93 +
  // 0.5 x 5.85) = 19.3. Priced as Advantage on one swing (half of the other two) the Bash routine came to 17.2.
  assert.deepEqual(used('Gladiator', 'Half-Dragon', 1).slice(0, 3), ['Shield Bash', 'Spear', 'Spear']);
});

test('U04 control: no Bash first at a foe too big to knock down, already Prone, or with a use that pushes it away', () => {
  const gladiator = block('Gladiator'), knight = block('Knight'), troll = block('Troll');
  const routine = gladiator.routines.find((r) => r.name === 'Multiattack (Spear) + Shield Bash')!;
  // "If the target is a Medium or smaller creature": a Troll is Large.
  assert.equal(e.attackOrder(routine, gladiator, troll, e.initState(troll), 5), routine.parts);
  assert.ok(!used('Gladiator', 'Troll', 1).includes('Shield Bash'));
  const prone = e.initState(knight);
  prone.conditions.push(held('prone'));
  assert.equal(e.attackOrder(routine, gladiator, knight, prone, 5), routine.parts);
  // Repulsion Breath (p270) knocks Prone and pushes "up to 60 feet straight away": the Rends could not follow it.
  const dragon = block('Adult Bronze Dragon'), breath = dragon.routines.find((r) => r.name === 'Multiattack (Rend) + Repulsion Breath')!;
  assert.equal(e.attackOrder(breath, dragon, knight, e.initState(knight), 5), breath.parts);
});

const fightLog = (a: string, b: string, seed: number, scenario: 'max30' | 'max120') => fight(block(a), block(b), seed, true, scenario).log;

test('I01 a Vrock keeps over a Hydra that out-fights it and seeds it with Spores', () => {
  // Vrock Spores (Recharge 6): "each creature in a 20-foot Emanation ... has the Poisoned condition ... While Poisoned,
  // the target takes 5 (1d10) Poison damage at the start of each of its turns." No damage of its own, so it was not a
  // recharge worth waiting for, and the Vrock landed beside five Bites (reach 10, no ranged attack) and lost 400 of 400.
  for (const seed of [1, 2, 3]) {
    const log = fightLog('Vrock', 'Hydra', seed, 'max120');
    const landed = log.indexOf('Vrock uses Shred');
    assert.ok(landed < 0 || log.slice(0, landed).filter((line) => line === 'Vrock uses Spores').length > 1, `seed ${seed}: no landing before the Spores have had their turns`);
    assert.ok(log.filter((line) => line === 'Vrock uses Spores').length > 1, `seed ${seed}: Spores again when it recharges`);
  }
});

test('I01 control: the same Vrock lands on a Triceratops, an exchange it wins', () => {
  // Shred twice a round against two Gores: the Vrock won 302 of 400 on the ground, and waiting aloft would draw them.
  const log = fightLog('Vrock', 'Triceratops', 3, 'max120');
  assert.ok(log.some((line) => line === 'Vrock uses Shred'));
});

test('F17 a Manticore beside an Ogre climbs out of its Greatclub and uses Tail Spikes', () => {
  // Rend and Tail Spike are both +5 for 1d8 + 3. Beside the Ogre it takes Greatclub 0.65 x 13 = 8.5 a round; from
  // beyond 30 feet up the Ogre has a long-range Javelin (30/120, Disadvantage: 0.42 x 11 = 4.6). The climb costs one
  // Opportunity Attack (8.5) and saves 3.9 a round for the four rounds 68 Hit Points last.
  const log = fightLog('Manticore', 'Ogre', 8, 'max120');
  assert.equal(log.find((line) => line.startsWith('Manticore uses ')), 'Manticore uses Tail Spike');
  assert.ok(log.some((line) => line.startsWith('Manticore moves') && line.includes('altitude 0 ft to')));
});

test('F17 control: no climb where the room keeps it inside the Javelin\'s normal range', () => {
  // max30: 30 feet up the Javelin is at its normal range (0.65 x 11 = 7.2), 1.3 a round less than the Greatclub and not
  // worth an Opportunity Attack.
  const log = fightLog('Manticore', 'Ogre', 8, 'max30');
  assert.equal(log.find((line) => line.startsWith('Manticore uses ')), 'Manticore uses Rend');
});

test('F20 an Ancient Red Dragon does not climb through a Kraken\'s Tentacle, which would hold it', () => {
  // Kraken Tentacle (reach 30): "the target has the Grappled condition (escape DC 20) ... the target has the
  // Restrained condition". A creature Grappled has Speed 0, so a climb through that Opportunity Attack ends under the
  // Kraken (F17's spreading of the toll does not apply). max120, seed 5: the dragon wins initiative 30 feet away.
  const log = fightLog('Kraken', 'Ancient Red Dragon', 5, 'max120');
  assert.ok(!log.slice(0, 6).includes('Kraken makes an opportunity attack'));
  assert.equal(log.find((line) => line.startsWith('Ancient Red Dragon uses ')), 'Ancient Red Dragon uses Rend');
});

test('SZ01 a Kraken\'s Fling is worth nothing against a Gargantuan dragon, which then climbs out of its Tentacles', () => {
  // Kraken Fling: "The kraken throws a Large or smaller creature Grappled by it to a space it can see within 60 feet".
  // An Ancient Blue Dragon is Gargantuan and Immune to the Kraken's Lightning Strike, so past the Tentacles' 30-foot
  // reach the Kraken has nothing for it. max120, seed 1: once free of the grapple the dragon climbs and stays up.
  const kraken = block('Kraken'), dragon = block('Ancient Blue Dragon');
  assert.equal(actionEv(option(kraken, 'Fling').action, kraken, dragon), 0);
  assert.equal(bestRoutineEvAtDistance(kraken, dragon, 60, false), 0);
  const log = fightLog('Ancient Blue Dragon', 'Kraken', 1, 'max120');
  const climb = log.findIndex((line) => /^Ancient Blue Dragon moves .*altitude 0 ft to [4-9]\d ft/.test(line));
  assert.ok(climb > 0, 'the dragon climbs');
  assert.ok(!log.slice(climb, climb + 60).some((line) => line.startsWith('Kraken uses ')));
});

test('SZ01 control: the Fling keeps its worth against a Large dragon', () => {
  const kraken = block('Kraken');
  assert.ok(actionEv(option(kraken, 'Fling').action, kraken, block('Young Red Dragon')) > 10);
});
