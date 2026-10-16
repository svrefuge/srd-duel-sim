// Spell choices (Faerie Fire, Web, Invisibility, Charm Monster) and when fliers climb or wait. Each test is judged by
// the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the test name.
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

test('G01 a dragon held by a foe that chains it again every turn attacks instead of escaping', () => {
  // Chain (p273): "Melee Attack Roll: +7, reach 10 ft. ... the target has the Grappled condition (escape DC 14) ... and
  // it has the Restrained condition." Two Chains a turn against AC 18 both miss 0.5 x 0.5 = 0.25 of the time, so an
  // escape (an action) buys a free turn one time in four; three Rends at Disadvantage are worth more. It tried 7, 8 and
  // 6 times in seeds 1 to 3.
  for (const seed of [1, 2, 3]) {
    const log = run('Chain Devil', 'Young Red Dragon', 'max120', seed).log;
    assert.equal(count(log, 'Young Red Dragon escapes') + count(log, 'Young Red Dragon fails to escape'), 0);
    assert.ok(count(log, 'Young Red Dragon uses Rend') >= 20);
  }
});

test('G01 control: a hold its foe puts back half the time is still worth escaping', () => {
  // Constrict (p277): "Strength Saving Throw: DC 15", which a Gold Dragon Wyrmling (Str +4) makes half the time: a free turn for
  // each failure in a row, 0.5 / (1 - 0.5) = 1 turn of its full attacks.
  const tries = [1, 2, 3].reduce((sum, seed) => {
    const log = run('Couatl', 'Gold Dragon Wyrmling', 'max30', seed).log;
    return sum + count(log, 'Gold Dragon Wyrmling escapes') + count(log, 'Gold Dragon Wyrmling fails to escape');
  }, 0);
  assert.ok(tries >= 6);
});

test('G02 a Drider does not cast Faerie Fire over the Web that Restrains its foe', () => {
  // Concentration (p179): "You lose Concentration on an effect the moment you start casting a spell that requires
  // Concentration."
  // Web's Restrained gives Advantage on the Drider's attacks and stops the Ettin; Faerie Fire's Advantage adds nothing
  // to that and ends it. It cast Faerie Fire on a Restrained Ettin at 9 and 12 Hit Points in seeds 2 and 5.
  for (const seed of [2, 5]) {
    const log = run('Drider', 'Ettin', 'max120', seed).log;
    assert.equal(count(log, 'Drider uses bonus action Web'), 1);
    assert.equal(count(log, 'Drider uses bonus action Faerie Fire'), 0);
    assert.equal(count(log, 'Drider loses Concentration'), 0);
  }
});

test('G02 control: with no Web up (a hovering foe it cannot Web), the Drider casts Faerie Fire', () => {
  const log = run('Drider', 'Invisible Stalker', 'max30', 2).log;
  assert.equal(count(log, 'Drider uses bonus action Web'), 0);
  assert.equal(count(log, 'Drider uses bonus action Faerie Fire'), 1);
});

test('G03 an Efreeti does not turn Invisible against attacks already made at Disadvantage', () => {
  // Hammer Throw (p285) is a ranged attack, "range 60/240 ft."; pushed to 65 feet the Efreeti is at long range, and
  // "if multiple situations impose Disadvantage on a roll, you roll only two d20s" (p8): Invisibility takes nothing more from the giant's throws and costs the
  // Efreeti its three Heated Blades (about 40). It cast it in round 2 of every seed.
  for (const scenario of ['max120', 'max30'] as const) {
    for (const seed of [1, 2]) assert.equal(count(run('Efreeti', 'Fire Giant', scenario, seed).log, 'Efreeti uses Invisibility'), 0);
  }
});

test('G03 control: against a foe whose attacks would be made normally, it still turns Invisible', () => {
  const log = run('Efreeti', 'Chain Devil', 'max30', 1).log;
  assert.equal(count(log, 'Efreeti uses Invisibility'), 1);
});

test('G05 a flier without Hover does not climb over a foe whose thrown rock knocks it Prone', () => {
  // Boulder (p330): "If the target is a Large or smaller creature, it has the Prone condition." Flying (p182): "you fall
  // if you have the Incapacitated or Prone condition", and "1d6 Bludgeoning damage ... for every 10 feet it fell". At 35 or 40 feet up each
  // Boulder that hit cost the dragon 3d6 or 4d6 more, where the Stone Club reaches 15.
  for (const seed of [1, 2, 3]) {
    const log = run('Young Copper Dragon', 'Stone Giant', 'max120', seed).log;
    assert.equal(rounds(log)[0][0], 'Young Copper Dragon moves (30 ft -> 40 ft)');
  }
});

test('G05 control: over a foe with nothing that knocks it down, a flier still climbs', () => {
  const log = run('Green Dragon Wyrmling', 'Ankylosaurus', 'max120', 2).log;
  assert.equal(rounds(log)[0][0], 'Green Dragon Wyrmling moves (30 ft -> 15 ft) [altitude 0 ft to 30 ft]');
});

test('G07 a Dryad does not cast Charm Monster again on the creature it has Charmed', () => {
  // Charm Monster (p282, the dryad's Spellcasting): "lasts 24 hours; ends early if the dryad casts the spell
  // again". The Gargoyle was Charmed in round 2 and the Dryad rolled the spell at it again in rounds 3, 4 and 5.
  const log = run('Dryad', 'Gargoyle', 'max30', 1).log;
  const charm = log.indexOf('Gargoyle gains charmed');
  assert.ok(charm > 0);
  const next = log.indexOf('Gargoyle gains charmed', charm + 1);
  assert.equal(count(log.slice(charm + 1, next - 1), 'Dryad uses Charm Monster'), 0);
});

test('G07 control: a casting the target saved against is followed by another', () => {
  const log = run('Dryad', 'Gargoyle', 'max30', 1).log;
  assert.equal(count(log.slice(0, log.indexOf('Gargoyle gains charmed')), 'Dryad uses Charm Monster'), 2);
});

test('G12 a wyrmling out of reach overhead waits for its breath instead of landing to lose the exchange', () => {
  // Poison Breath is "Recharge 5-6"; the Ankylosaurus has no ranged attack and its Tail reaches 10 feet. Two Rends
  // (0.5 x 11 x 2 = 11 of its 68 Hit Points, 6 rounds) against two Tails (0.5 x 9.5 x 2 = 9.5 of the wyrmling's 38,
  // 4 rounds, and a knock-down). It landed in round 2 and lost 246 fights of 400; waiting, it wins 336.
  const log = run('Green Dragon Wyrmling', 'Ankylosaurus', 'max120', 2).log;
  const second = rounds(log)[1];
  assert.ok(second.includes('Green Dragon Wyrmling dodges'));
  assert.equal(count(second, 'Green Dragon Wyrmling uses Rend'), 0);
  assert.equal(count(rounds(log)[2], 'Green Dragon Wyrmling uses Poison Breath'), 1);
});

test('G12 control: it does not wait above a foe that answers it there', () => {
  // Bandit Captain, Pistol (range 30/90 ft.): no height is out of its reach, so the wyrmling lands and Rends.
  const log = run('Green Dragon Wyrmling', 'Bandit Captain', 'max30', 2).log;
  assert.equal(count(rounds(log)[1], 'Green Dragon Wyrmling uses Rend'), 2);
});
