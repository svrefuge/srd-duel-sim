// Power Word Stun timing, Invisibility, "any combination" attacks, damage rounding, and Bonus Action movement. Each
// test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const run = (a: string, b: string, scenario: 'max30' | 'max120' | 'max600', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;
const round = (lines: string[], n: number) => lines.slice(lines.indexOf(`Round ${n}`), lines.indexOf(`Round ${n + 1}`) < 0 ? undefined : lines.indexOf(`Round ${n + 1}`));

test('C01 a daily Power Word Stun waits for the target to fall to 150 Hit Points', () => {
  // p154: "If the target has 150 Hit Points or fewer, it has the Stunned condition. Otherwise, its Speed is 0 until
  // the start of your next turn." Storm Giant has 230 Hit Points; the Glabrezu's one Stun bought a round of Speed 0
  // from a foe already beside it, at 205.
  const t = run('Glabrezu', 'Storm Giant', 'max30', 1);
  assert.equal(count(t.log, 'gains powerWordSlowed'), 0);
  let hp = block('Storm Giant').hpAvg;
  for (const line of t.log) {
    const left = line.match(/^Storm Giant takes \d+ damage \((\d+) hp left\)$/);
    if (left) hp = Number(left[1]);
    if (line === 'Glabrezu uses Power Word Stun') assert.ok(hp <= 150, `cast at ${hp} hit points`);
  }
});

test('C01 control: at 150 Hit Points or fewer the Stun is cast and lands', () => {
  // Hezrou has 157; one Pincer brings it under the mark.
  const t = run('Glabrezu', 'Hezrou', 'max30', 1);
  const cast = t.log.indexOf('Glabrezu uses Power Word Stun');
  assert.ok(cast > 0, 'never cast');
  assert.equal(t.log[cast + 1], 'Hezrou gains stunned');
});

test('C02 Invisibility outlasts an action that is no attack roll, damage or spell', () => {
  // p143, Invisibility: "The spell ends early immediately after the target makes an attack roll, deals damage, or casts
  // a spell." p317, Quasit: "Scare (1/Day). Wisdom Saving Throw: DC 10 ... Failure: The target has the Frightened
  // condition": an action, not a spell, and no damage. It reveals the Quasit on every use.
  const t = run('Chuul', 'Quasit', 'max30', 2);
  const scare = t.log.indexOf('Quasit uses Scare (1/Day)');
  assert.ok(t.log.indexOf('Quasit becomes invisible') > 0 && scare > t.log.indexOf('Quasit becomes invisible'), 'setup not reached');
  assert.notEqual(t.log[scare + 1], 'Quasit is revealed');
});

test('C02 control: an attack roll still ends it', () => {
  const t = run('Oni', 'Ogre', 'max30', 1);
  const revealed = t.log.indexOf('Oni is revealed');
  assert.ok(t.log.indexOf('Oni becomes invisible') > 0 && revealed > 0, 'setup not reached');
  assert.equal(t.log[revealed - 1], 'Oni uses Claw');
});

test('C03 an option that waits on a condition the foe can never have is no line: the creature keeps away', () => {
  // p335, Vampire Spawn: "Bite. Constitution Saving Throw: DC 14, one creature within 5 feet that is willing or that has
  // the Grappled, Incapacitated, or Restrained condition." Ochre Jelly: Immunities Slashing (the Claw), and the Grappled
  // and Restrained conditions; the spawn has nothing that Incapacitates. It Dodged beside the jelly for 39 rounds and
  // died in all 400 fights. Speed 30 with a Bonus Action Dash against the jelly's 20.
  const t = run('Vampire Spawn', 'Ochre Jelly', 'max600', 2);
  assert.equal(t.winner, -1);
  assert.equal(count(t.log, 'Vampire Spawn takes'), 0);
  // Ghost: Withering Touch is Necrotic (Shadow is immune), Horrific Visage takes no Undead, Possession one Humanoid.
  const ghost = run('Ghost', 'Shadow', 'max600', 1);
  assert.equal(ghost.winner, -1);
  assert.equal(count(ghost.log, 'Ghost takes'), 0);
});

test('C03 control: against a foe it can grapple the spawn closes and bites', () => {
  const t = run('Vampire Spawn', 'Gladiator', 'max600', 1);
  assert.ok(count(t.log, 'Vampire Spawn uses Bite') > 0);
});

test('C04 attacks made "in any combination" are chosen one at a time', () => {
  // p304: "The lich makes three attacks, using Eldritch Burst or Paralyzing Touch in any combination." Touch: 3d6 + 5
  // Cold and Paralyzed until the start of the lich's next turn, no save. Once it lands a second adds 15 Cold; an Eldritch
  // Burst (4d12 + 5) on a Paralyzed target within 5 feet is a Critical Hit.
  const first = round(run('Lich', 'Planetar', 'max30', 1).log, 1);
  assert.ok(first.includes('Planetar gains paralyzed'), 'setup not reached');
  assert.equal(count(first, 'Lich uses Paralyzing Touch'), 1);
  assert.equal(count(first, 'Lich uses Eldritch Burst'), 2);
});

test('C04 control: a Touch that misses is made again', () => {
  const second = round(run('Lich', 'Planetar', 'max30', 1).log, 2);
  assert.deepEqual(second.slice(1, 4), ['Lich uses Paralyzing Touch', 'Lich misses Planetar', 'Lich uses Paralyzing Touch']);
});

test('C05 a Multiattack\'s Restraining use goes before its attacks', () => {
  // p306: "The marilith makes six Pact Blade attacks and uses Constrict." p257, Multiattack: the entry "details the
  // attacks a creature can make, as well as any additional abilities it can use, as part of the Attack action", in no
  // set order. Constrict Restrains (Strength save DC 17); Pact Blade +10 against AC 17 is 70%, 91% with Advantage.
  const first = round(run('Marilith', 'Deva', 'max30', 1).log, 1);
  assert.equal(first.find((line) => line.startsWith('Marilith uses')), 'Marilith uses Constrict');
});

test('C05 control: against a target too large to Constrict the blades come first', () => {
  // "one Large or smaller creature"; a Balor is Huge.
  const first = round(run('Marilith', 'Balor', 'max30', 1).log, 1);
  assert.equal(first.find((line) => line.startsWith('Marilith uses')), 'Marilith uses Pact Blade');
});

const dummy = (name: string, change: Partial<CombatStatblock>): CombatStatblock => ({ ...structuredClone(block('Commoner')), name, id: `T:${name}`, hpAvg: 200, ...change });
const firstDamage = (attacker: CombatStatblock, defender: CombatStatblock): number =>
  Number(fight(attacker, defender, 1, true, 'max30').log.find((line) => line.startsWith(`${defender.name} takes`))!.match(/takes (\d+)/)![1]);
const flames = (action: object): Partial<CombatStatblock> => ({
  options: [{ name: 'Flames', sourceText: '', sourceRef: 'test', uses: { t: 'atWill' }, timing: 'action', action } as CombatStatblock['options'][number]],
  routines: [{ name: 'Flames', parts: [{ optionIdx: 0, count: 1 }] }],
});

test('C06 damage is rounded down at each step: adjustments, then Resistance, then Vulnerability', () => {
  // p17, Order of Application: "it takes 28 Fire damage, the damage is first reduced by 5 (to 23), then halved for the
  // creature's Resistance (and rounded down to 11), then doubled for its Vulnerability (to 22)". One rounding at the end
  // gave 23.
  const fire23 = dummy('Burner', flames({ kind: 'autohit', damage: [{ dice: { n: 0, d: 6, mod: 23 }, type: 'fire' }], riders: [], magical: false, range: 30 }));
  assert.equal(firstDamage(fire23, dummy('Both', { resist: ['fire'], vulnerable: ['fire'] })), 22);
  // A save for half is the first step: 9 Fire halved to 4, doubled to 8 (an Ice Mephit took 9 from a Death Burst it saved against).
  const fire9 = dummy('Burster', flames({ kind: 'save', ability: 'dex', dc: 1, damage: [{ dice: { n: 0, d: 6, mod: 9 }, type: 'fire' }], onSuccess: 'half', riders: [], magical: false, range: 30 }));
  assert.equal(firstDamage(fire9, dummy('Weak', { vulnerable: ['fire'] })), 8);
});

test('C06 control: with one modifier the figures are unchanged', () => {
  const fire23 = dummy('Burner', flames({ kind: 'autohit', damage: [{ dice: { n: 0, d: 6, mod: 23 }, type: 'fire' }], riders: [], magical: false, range: 30 }));
  assert.equal(firstDamage(fire23, dummy('Plain', {})), 23);
  assert.equal(firstDamage(fire23, dummy('Resists', { resist: ['fire'] })), 11);
  assert.equal(firstDamage(fire23, dummy('Weak', { vulnerable: ['fire'] })), 46);
});

test('C07 a step away is no safety from a foe whose Bonus Action carries it back', () => {
  // p343, Xorn: "Charge. The xorn moves up to its Speed without provoking Opportunity Attacks straight toward an enemy
  // it can sense." Speed 20 and 20 more. A Bugbear Stalker (Javelin "reach 10 ft. or range 30/120 ft.") walked from 5 to
  // 30 feet each round through an Opportunity Attack, to throw the Javelins it could thrust, and the Xorn charged back.
  const t = run('Bugbear Stalker', 'Xorn', 'max30', 1);
  const second = round(t.log, 2);
  assert.equal(count(second, 'Xorn makes an opportunity attack'), 0);
  assert.equal(count(second, 'Bugbear Stalker moves'), 0);
  assert.ok(second.includes('Bugbear Stalker uses bonus action Quick Grapple'));
});

test('C07 control: it still backs away from a slower foe with no such movement', () => {
  // Mummy: Speed 20 ft., no Bonus Action. (A Hobgoblin Captain: a Bugbear Stalker grapples a foe beside it.)
  assert.ok(round(run('Hobgoblin Captain', 'Mummy', 'max30', 1).log, 2).includes('Hobgoblin Captain moves (10 ft -> 30 ft)'));
});

test('C08 a failed Undead Fortitude save is logged with its DC', () => {
  // p343, Zombie: "If damage reduces the zombie to 0 Hit Points, it makes a Constitution saving throw (DC 5 plus the
  // damage taken) unless the damage is Radiant or from a Critical Hit." The log showed only the held saves.
  const t = run('Zombie', 'Ghoul', 'max30', 1);
  const failed = t.log.findIndex((line) => /^Zombie fails to hold on \(Undead Fortitude, DC \d+\)$/.test(line));
  assert.ok(failed > 0);
  const [, dc] = t.log[failed].match(/DC (\d+)/)!;
  assert.equal(t.log[failed + 1], `Zombie takes ${Number(dc) - 5} damage (0 hp left)`);
});

test('C08 control: a held save prints the held line and no failure', () => {
  const t = run('Ogre Zombie', 'Hell Hound', 'max30', 3);
  const held = t.log.indexOf('Ogre Zombie holds on (Undead Fortitude)');
  assert.ok(held > 0);
  assert.ok(!t.log[held - 1].includes('fails to hold on') && !t.log[held + 1].includes('fails to hold on'));
});

test('C07 the foe\'s Bonus Action movement is counted once in a race, not doubled with its Dash', () => {
  // p333, Troll: "Charge. The troll moves up to half its Speed straight toward an enemy it can see." Speed 30: a Dash
  // and a Charge cover 75 feet, an Ogre's Dash (Speed 40) 80. The Ogre has nothing that stops the regeneration, so it
  // keeps away for the draw; with the Charge counted twice (90 feet) it would stand and lose every fight.
  const t = run('Ogre', 'Troll', 'max600', 1);
  assert.equal(t.winner, -1);
  assert.ok(count(t.log, 'Ogre dashes') > 0);
});
