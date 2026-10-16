// Printed mechanics of the Jackal to Reef Shark stat blocks. Each test is written from the printed SRD 5.2.1 text
// quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, fight, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const optionIdx = (monster: string, name: string) => block(monster).options.findIndex((o) => o.name === name);
/** A Medium bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });

test('L01 Pit Fiend Hellfire Spellcasting: one Recharge use casts two spells, Fireball twice or Fireball with one replacement', () => {
  // p.315: "Hellfire Spellcasting (Recharge 4-6). The pit fiend casts Fireball (level 5 version) twice ... It can replace
  // one Fireball with Hold Monster (level 7 version) or Wall of Fire."
  const fiend = block('Pit Fiend'), state = e.initState(fiend);
  const [fire, hold, wall] = ['Fireball', 'Hold Monster', 'Wall of Fire'].map((name) => optionIdx('Pit Fiend', name));
  state.turnCount = 1;
  assert.deepEqual(fiend.routines.map((r) => r.name).filter((name) => /Fireball|Hold|Wall/.test(name)),
    ['Fireball x2', 'Hold Monster + Fireball', 'Fireball + Hold Monster', 'Wall of Fire + Fireball', 'Fireball + Wall of Fire']);
  e.spend(state, hold, fiend.options[hold]);
  assert.ok(e.usable(state, fire, fiend.options[fire]), 'the second cast of the same use');
  e.spend(state, fire, fiend.options[fire]);
  assert.deepEqual([fire, hold, wall].map((idx) => e.usable(state, idx, fiend.options[idx])), [false, false, false], 'two casts, then the use is spent');
});

test('L01 control: an unused second cast does not carry to a later turn, and an ordinary Recharge action is one use', () => {
  const fiend = block('Pit Fiend'), state = e.initState(fiend), fire = optionIdx('Pit Fiend', 'Fireball');
  state.turnCount = 1;
  e.spend(state, fire, fiend.options[fire]);
  state.turnCount = 2;
  assert.equal(e.usable(state, fire, fiend.options[fire]), false);
  const dragon = block('Adult Red Dragon'), breath = dragon.options.findIndex((o) => o.uses.t === 'recharge'), d = e.initState(dragon);
  d.turnCount = 1;
  e.spend(d, breath, dragon.options[breath]);
  assert.equal(e.usable(d, breath, dragon.options[breath]), false);
});

test('L01 in a fight: the pit fiend casts two Hellfire spells in a turn and never three', () => {
  let most = 0;
  for (let seed = 1; seed <= 12; seed++) {
    let casts = 0;
    for (const line of fight(block('Pit Fiend'), tank({ hpAvg: 5000 }), seed, true, 'max600').log) {
      if (/^Round \d+/.test(line)) casts = 0;
      if (/^Pit Fiend uses (Fireball|Hold Monster|Wall of Fire)$/.test(line)) most = Math.max(most, ++casts);
    }
  }
  assert.equal(most, 2);
});

/** A Priest that has cast Spirit Guardians with the foe `distance` feet away; `outside`: the foe has since stepped out. */
function guardians(distance: number, outside = false) {
  const priest = block('Priest'), foe = tank(), a = e.initState(priest), d = e.initState(foe), l = log();
  e.resolveAction(priest, foe, a, d, option('Priest', 'Spirit Guardians').action, rolls(0), 0, distance, l);
  if (outside) e.settleEmanationSpeed([a, d], 1, 40);
  return { priest, foe, a, d, l };
}

test('L02 Priest Spirit Guardians: the save is made by a creature that ends its turn in the Emanation, every turn', () => {
  // p.164-165: "whenever the Emanation enters a creature's space and whenever a creature enters the Emanation or ends
  // its turn there, the creature must make a Wisdom saving throw. On a failed save, the creature takes 3d8 Radiant
  // damage ... A creature makes this save only once per turn." DC 13. A d20 of 1 fails; three d8s showing 1 are 3.
  const { priest, foe, a, d } = guardians(5);
  assert.equal(d.hp, 1000, 'casting rolls no save: appearing is not one of the printed triggers');
  assert.ok(a.concentrating);
  e.resolveEmanationEndTurn([priest, foe], [a, d], 1, at(5), rolls(0), log());
  assert.equal(d.hp, 997);
  e.resolveEmanationEndTurn([priest, foe], [a, d], 1, at(15), rolls(0), log());
  assert.equal(d.hp, 994, 'again on its next turn, at the edge of 15 feet');
  e.resolveEmanationEndTurn([priest, foe], [a, d], 0, at(5), rolls(0), log());
  assert.equal(d.hp, 994, 'nothing on the caster\'s turn: the creature was already inside');
});

test('L02 Spirit Guardians: the Emanation entering a creature\'s space on the caster\'s turn, and the halved Speed', () => {
  // "Any other creature's Speed is halved in the Emanation": a Guard's 30 feet is 15.
  const { priest, foe, a, d } = guardians(15, true);
  e.resolveEmanationEndTurn([priest, foe], [a, d], 0, at(10), rolls(0), log());
  assert.equal(d.hp, 997, 'the priest walked the Emanation onto it');
  e.settleEmanationSpeed([a, d], 1, 10);
  assert.equal(e.currentSpeed(foe, d), 15);
  e.settleEmanationSpeed([a, d], 0, 10);
  assert.equal(e.currentSpeed(priest, a), priest.speed, 'not the caster\'s own');
});

test('L02 control: outside 15 feet there is no save and no halving, and none once Concentration ends', () => {
  const { priest, foe, a, d } = guardians(15);
  e.resolveEmanationEndTurn([priest, foe], [a, d], 1, at(20), rolls(0), log());
  e.settleEmanationSpeed([a, d], 1, 20);
  assert.equal(d.hp, 1000);
  assert.equal(e.currentSpeed(foe, d), 30);
  // Stunned is Incapacitated, which ends Concentration.
  a.conditions.push({ name: 'stunned', duration: 'permanent', source: 1, appliedTurn: 0 });
  e.syncConcentration([priest, foe], [a, d], log());
  assert.equal(a.conditions.some((c) => c.name === 'emanation'), false);
  e.resolveEmanationEndTurn([priest, foe], [a, d], 1, at(5), rolls(0), log());
  assert.equal(d.hp, 1000);
});

/** A Pirate Captain's attacks against AC 16, each with its own dice (Rapier at 5 feet, Pistol at 10); returns whether each hit. */
function captainAttacks(...attacks: [string, number[]][]) {
  const captain = block('Pirate Captain'), foe = tank(), a = e.initState(captain), d = e.initState(foe);
  return { a, d, foe, captain, hits: attacks.map(([name, dice]) => {
    const before = d.hp;
    e.resolveAction(captain, foe, a, d, option('Pirate Captain', name).action, rolls(...dice), 0, name === 'Pistol' ? 10 : 5, log());
    return d.hp < before;
  }) };
}

test('L03 Pirate Captain Rapier: a hit gives Advantage on its next attack roll this turn, and only that one', () => {
  // p.314: "Hit: 13 (2d8 + 4) Piercing damage, and the pirate has Advantage on the next attack roll it makes before the
  // end of this turn." Rapier d20 19: 19 + 7 hits AC 16. Pistol d20s 1 then 19: with Advantage 19 + 7 hits. The next
  // Pistol on the same dice has no Advantage: 1 + 7 misses.
  assert.deepEqual(captainAttacks(['Rapier', [0.9, 0]], ['Pistol', [0, 0.9, 0]], ['Pistol', [0, 0.9, 0]]).hits, [true, true, false]);
});

test('L03 control: a Pistol hit gives none, and the Advantage is gone when the turn ends', () => {
  assert.deepEqual(captainAttacks(['Pistol', [0.9, 0]], ['Pistol', [0, 0.9, 0]]).hits, [true, false]);
  const { a, d, foe, captain } = captainAttacks(['Rapier', [0.9, 0]]);
  e.endTurn([captain, foe], [a, d], 0, at(5), rolls(0), log());
  e.resolveAction(captain, foe, a, d, option('Pirate Captain', 'Pistol').action, rolls(0, 0.9, 0), 0, 10, log());
  assert.equal(d.hp, 1000 - (2 + 4), 'only the Rapier hit: two d8s showing 1, plus 4');
});

/** The Mummy Lord's Harm against a 1000 hit point target, the save d20 first. */
function harm(...dice: number[]) {
  const lord = block('Mummy Lord'), foe = tank({ saves: { ...block('Guard').saves, con: 0 } }), a = e.initState(lord), d = e.initState(foe);
  e.resolveAction(lord, foe, a, d, option('Mummy Lord', 'Harm').action, rolls(...dice), 0, 30, log());
  return { hp: d.hp, maxHp: d.maxHp };
}

test('L04 Mummy Lord Harm: a failed save lowers the Hit Point maximum by the Necrotic damage taken', () => {
  // p.139: "On a failed save, it takes 14d6 Necrotic damage, and its Hit Point maximum is reduced by an amount equal to
  // the Necrotic damage it took." Fourteen d6s showing 1 are 14: 1000 -> 986 for both.
  assert.deepEqual(harm(0), { hp: 986, maxHp: 986 });
});

test('L04 control: "On a successful save, it takes half as much damage only"', () => {
  assert.deepEqual(harm(0.99, 0), { hp: 993, maxHp: 1000 });
});

/** A Guard's Spear (+3) at a Planetar (AC 19) that has cast Dispel Evil and Good, d20s 19 then 1. */
function spearAtWarded(creatureType: string) {
  const planetar = block('Planetar'), attacker = tank({ creatureType }), p = e.initState(planetar), a = e.initState(attacker);
  e.resolveAction(planetar, attacker, p, a, option('Planetar', 'Dispel Evil and Good').action, rolls(0), 0, 5, log());
  e.resolveAction(attacker, planetar, a, p, block('Guard').options[0].action, rolls(0.9, 0, 0), 1, 5, log());
  return p.hp < planetar.hpAvg;
}

test('L05 Dispel Evil and Good: a Fiend has Disadvantage on attack rolls against the caster', () => {
  // p.124: "For the duration, Celestials, Elementals, Fey, Fiends, and Undead have Disadvantage on attack rolls against
  // you." d20s 19 then 1: with Disadvantage 1 + 3 misses AC 19.
  assert.equal(spearAtWarded('fiend'), false);
  assert.deepEqual(blocks.filter((b) => b.options.some((o) => o.name === 'Dispel Evil and Good')).map((b) => b.name), ['Planetar', 'Solar', 'Unicorn']);
  assert.equal((option('Planetar', 'Dispel Evil and Good').action as { concentration?: boolean }).concentration, true);
});

test('L05 control: a Humanoid attacks normally on the same dice', () => {
  assert.equal(spearAtWarded('humanoid'), true, '19 + 3 hits AC 19');
});

/** A foe's turn against this creature, whose Reaction is already spent; is it spent after the turn has begun? */
function reactionSpentAfterFoeTurn(name: string) {
  const creature = block(name), foe = tank(), c = e.initState(creature), f = e.initState(foe);
  c.reactionUsed = true;
  e.takeTurn([creature, foe], [c, f], 1, rolls(0), at(60), log(), e.createPairEvaluator(creature, foe, true), false);
  return c.reactionUsed;
}

test('L06 Marilith Reactive: its Reaction returns at the start of the other creature\'s turn', () => {
  // p.306: "Reactive. The marilith can take one Reaction on every turn of combat."
  assert.equal(reactionSpentAfterFoeTurn('Marilith'), false);
  assert.deepEqual(blocks.filter((b) => b.reactionEveryTurn).map((b) => b.name), ['Marilith']);
});

test('L06 control: a Knight\'s spent Reaction stays spent through the other creature\'s turn', () => {
  assert.equal(reactionSpentAfterFoeTurn('Knight'), true);
});

test('L07 "Medium or Small" creatures compile at the size printed first, Medium', () => {
  // For example p.303 Knight: "Medium or Small Humanoid".
  const either = ['Assassin', 'Bandit', 'Knight', 'Mage', 'Mummy', 'Mummy Lord', 'Noble', 'Pirate Captain', 'Priest'];
  assert.deepEqual(either.map((name) => block(name).size), either.map(() => 2));
});

test('L07 control: a creature printed Small stays Small', () => {
  assert.equal(block('Goblin Warrior').size, 1);
  assert.equal(block('Kobold Warrior').size, 1);
});

test('L08 Kraken Toxic Ink reaches creatures only "while it is underwater": not offered in a duel on land', () => {
  // p.303: "each creature in a 15-foot Emanation originating from the kraken while it is underwater."
  const kraken = block('Kraken');
  assert.equal(kraken.options.some((o) => o.name === 'Toxic Ink'), false);
  assert.ok(kraken.skipped.some((s) => s.name === 'Toxic Ink' && /underwater/.test(s.reason)));
});

test('L08 control: the Kraken keeps Storm Bolt, and no other block loses an option to the gate', () => {
  const kraken = block('Kraken');
  assert.deepEqual(kraken.legendaryOptions!.map((entry) => kraken.options[entry.optionIdx].name), ['Lightning Strike']);
  assert.deepEqual(blocks.filter((b) => b.skipped.some((s) => /only while the creature is underwater/.test(s.reason))).map((b) => b.name), ['Kraken']);
});
