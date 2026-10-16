// Escaping or ignoring holds and attached creatures, reach-10 positioning, and temporary Hit Points against Hit Point
// maximum drains. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id
// is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const run = (a: string, b: string, scenario: 'max30' | 'max120' | 'max600', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;
/** The log split into rounds: rounds(log)[0] is round 1. */
const rounds = (lines: string[]) => lines.reduce<string[][]>((all, line) => {
  if (/^Round \d+$/.test(line)) all.push([]); else all.at(-1)?.push(line);
  return all;
}, []);

test('E01 a reach-10 attacker steps to 5 feet of an Unconscious foe', () => {
  // Prone: "An attack roll against you has Advantage if the attacker is within 5 feet of you. Otherwise, that attack
  // roll has Disadvantage." Unconscious: a hit from within 5 feet is a Critical Hit. Oni Claw, +7 against AC 18, 19.5:
  // from 10 feet Advantage and Disadvantage cancel, 0.5 x 19.5 = 9.8; from 5 feet 0.75 x 39 = 29. The Oni swung from 10.
  const log = run('Young Black Dragon', 'Oni', 'max30', 1).log;
  const asleep = log.indexOf('Young Black Dragon falls unconscious');
  assert.ok(asleep > 0);
  assert.equal(log[asleep + 1], 'Oni moves (10 ft -> 5 ft)');
});

test('E01 control: a reach-10 grappler stays out of the reach of the creature it holds', () => {
  // The Succubus, Grappled (Speed 0), has reach 5: from 10 feet the Chuul's Pincers reach her and nothing of hers
  // reaches it. Paralyzed is not Prone, so the Pincers have their Advantage from there.
  const log = run('Succubus', 'Chuul', 'max30', 1).log;
  assert.ok(log.includes('Chuul moves (5 ft -> 10 ft)'));
  assert.equal(count(log, 'Chuul moves (10 ft -> 5 ft)'), 0);
});

test('E02 a creature with a Stirge attached attacks it and does not spend its action detaching it', () => {
  // Stirge: "the target or a creature within 5 feet of it can detach the stirge as an action"; attached, "the stirge
  // can't make Proboscis attacks". Detaching saves one 2d4 (5) and gives the Stirge back a Proboscis worth about 5
  // that attaches it again; the Camel's Bite (+4, 1d4 + 2 against AC 13) is worth 2.7 of the Stirge's 5 Hit Points.
  const log = run('Stirge', 'Camel', 'max600', 4).log;
  assert.equal(count(log, 'Camel escapes (DC 0)'), 0);
  assert.ok(count(log, 'Camel uses Bite') > 0);
});

test('E02 control: a hold that bars none of its holder\'s attacks is still escaped', () => {
  const log = run('Chain Devil', 'Cloaker', 'max30', 1).log;
  assert.ok(count(log, 'Cloaker fails to escape (DC 14)') + count(log, 'Cloaker escapes (DC 14)') > 0);
});

test('E03 Dispel Evil and Good is not the opener against a foe whose best answer is no attack roll', () => {
  // The spell gives the listed creature types Disadvantage on attack rolls against the caster. Night Hag: two Claws
  // or Magic Missile, which rolls nothing. The Unicorn cast its one use in round 1 and lost Concentration to the darts.
  const first = rounds(run('Unicorn', 'Night Hag', 'max30', 1).log)[0];
  assert.equal(count(first, 'Unicorn uses Dispel Evil and Good'), 0);
  assert.ok(first.includes('Unicorn uses Hooves'));
});

test('E03 control: it is still cast against a Fiend that only makes attack rolls', () => {
  const first = rounds(run('Unicorn', 'Barbed Devil', 'max30', 3).log)[0];
  assert.ok(first.includes('Unicorn uses Dispel Evil and Good'));
});

test('E04 Restrained "until the grapple ends" is not logged as ended when a timed copy lapses', () => {
  // Chain Devil, p273. Chain: Grappled (escape DC 14) "and it has the Restrained condition until the grapple ends".
  // Conjure Infernal Chain: Restrained "until the end of the devil's next turn". The second Conjure renews its own copy.
  const log = run('Chain Devil', 'Cloaker', 'max30', 1).log;
  const escaped = log.indexOf('Cloaker escapes (DC 14)');
  assert.ok(escaped > 0);
  assert.equal(count(log.slice(0, escaped), 'Cloaker is no longer restrained'), 0);
  assert.ok(log.slice(0, escaped).includes("Cloaker's restrained is renewed"));
});

test('E04 control: a timed Restrained with no grapple behind it is still logged when it ends', () => {
  // Treant is Huge: the Chain grapples a Large or smaller creature, so only the conjured chain Restrains it.
  const log = run('Chain Devil', 'Treant', 'max30', 1).log;
  assert.equal(count(log, 'Treant gains grappled'), 0);
  assert.ok(log.includes('Treant is no longer restrained'));
});

test('E05 Paralyzing Tentacles open the Multiattack on a creature the Chuul already holds', () => {
  // "Paralyzing Tentacles. Constitution Saving Throw: DC 13, one creature Grappled by the chuul." Multiattack sets no
  // order (p257): with the target Grappled from the turn before, the Tentacles first give both Pincers Advantage.
  const second = rounds(run('Succubus', 'Chuul', 'max30', 1).log)[1];
  const tentacles = second.indexOf('Chuul uses Paralyzing Tentacles');
  assert.ok(tentacles >= 0 && tentacles < second.indexOf('Chuul uses Pincer'));
});

test('E05 control: with no one Grappled yet the Pincers come first', () => {
  const first = rounds(run('Succubus', 'Chuul', 'max30', 1).log)[0];
  assert.ok(first.indexOf('Chuul uses Pincer') < first.indexOf('Chuul uses Paralyzing Tentacles'));
});

test('E06 no temporary Hit Points taken at full health against a foe whose every hit lowers the maximum', () => {
  // Wraith, Life Drain: "the target's Hit Point maximum decreases by an amount equal to the damage taken". From the
  // maximum, a drain of d leaves max - d with or without temporary Hit Points; Radiant Horn as the Legendary Action
  // is worth about 6.
  const log = run('Unicorn', 'Wraith', 'max30', 2).log;
  assert.equal(count(log, 'Unicorn uses legendary Shimmering Shield'), 0);
  assert.ok(count(log, 'Unicorn uses legendary') > 0);
});

test('E06 control: Shimmering Shield is still used against a foe that only deals damage', () => {
  assert.ok(count(run('Unicorn', 'Night Hag', 'max30', 1).log, 'Unicorn uses legendary Shimmering Shield') > 0);
});

test('E07 a creature Charmed for the rest of the fight keeps out of reach and does not Dodge beside its charmer', () => {
  // Lamia, Corrupting Touch: "the target is cursed for 1 hour. Until the curse ends, the target has the Charmed and
  // Poisoned conditions." Charmed: it can't attack the charmer. With Greater Restoration cast, the Couatl (Fly 90)
  // has no line; aloft it draws, where it Dodged in reach for 50 rounds and died.
  const result = run('Couatl', 'Lamia', 'max120', 10);
  assert.equal(result.winner, -1, 'a draw');
});

test('E07 control: uncursed, the Couatl fights and wins', () => {
  assert.equal(run('Couatl', 'Lamia', 'max30', 9).winner, 0);
});

test('E15 the Hit Points a drain gives its attacker are logged', () => {
  const log = run('Vampire Spawn', 'Wereboar', 'max30', 1).log;
  assert.ok(log.some((line) => /^Vampire Spawn regains \d+ hit points \(drain; \d+ hp\)$/.test(line)));
});

test('E15 control: an attacker with no drain logs none', () => {
  assert.equal(count(run('Vampire Spawn', 'Wereboar', 'max30', 1).log, 'Wereboar regains'), 0);
});
