// Swallow against breath, grapple order in a Multiattack, Opportunity Attacks in the log, and Dashing out of a
// shooter's range. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding
// id is in the test name.
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

test('I04 a Behir takes hold of a Troll and swallows it instead of breathing Lightning at it', () => {
  // Swallow (p263): "one Large or smaller creature Grappled by the behir ... takes 21 (6d6) Acid damage at the start of
  // each of the behir's turns." Acid stops a Troll's Regeneration and Lightning does not; only Constrict Grapples. It
  // breathed three rounds running at a Troll that stood back up each time.
  for (const seed of [1, 2, 3]) {
    const log = run('Behir', 'Troll', 'max30', seed).log;
    assert.equal(count(log, 'Behir uses Lightning Breath'), 0);
    assert.equal(count(log, 'Troll regenerates back up'), 0);
    assert.equal(count(log, 'Behir uses bonus action Swallow'), 1);
  }
});

test('I04 control: a Behir still opens with Lightning Breath on a Hill Giant', () => {
  for (const seed of [1, 2]) assert.equal(rounds(run('Behir', 'Hill Giant', 'max30', seed).log)[0][0], 'Behir uses Lightning Breath');
});

test('I05 a Giant Frog swallows a held foe that its least digestion kills', () => {
  // Swallow (p351): "The frog swallows a Small or smaller target it is grappling", no roll, and 2d4 Acid follows: at
  // least 2. A Bite at +3 hits a Kobold Warrior (AC 14) half the time. It bit a kobold on 2 Hit Points for two rounds
  // and died.
  const log = run('Giant Frog', 'Kobold Warrior', 'max30', 2).log;
  assert.equal(count(log, 'Giant Frog uses Swallow'), 1);
  assert.equal(log.at(-1), 'Kobold Warrior takes 3 damage (0 hp left)');
});

test('I05 control: a Giant Frog still opens with its Bite', () => {
  for (const seed of [2, 5, 6]) assert.ok(rounds(run('Giant Frog', 'Kobold Warrior', 'max30', seed).log)[0].includes('Giant Frog uses Bite'));
});

test('I07 a Will-o\'-Wisp that cannot bring a Troll to 0 Hit Points stays out of its reach', () => {
  // Consume Life (p342): "one living creature the wisp can see within 5 feet that has 0 Hit Points ... Failure: The
  // target dies". Shock is 0.6 x 9 = 5.4 a round against a Troll that regains 15: the finisher never comes up. It fought
  // beside the Troll and lost all 400 fights; aloft it draws them.
  for (const seed of [1, 2]) {
    const result = run('Will-o\'-Wisp', 'Troll', 'max30', seed);
    assert.equal(result.winner, -1);
    assert.equal(count(result.log, 'Will-o\'-Wisp takes'), 0);
  }
});

test('I07 control: a Will-o\'-Wisp still Shocks an Ogre to death', () => {
  for (const seed of [1, 2]) {
    const result = run('Will-o\'-Wisp', 'Ogre', 'max30', seed);
    assert.equal(result.winner, 0);
    assert.ok(count(result.log, 'Will-o\'-Wisp uses Shock') >= 5);
  }
});

test('I08 a creature that cannot hurt a shooter Dashes out of its range where there is room', () => {
  // Force Bolt (p330): "Ranged Attack Roll: +9, range 120 ft." A Stone Golem is immune to a Succubus's Psychic damage and
  // walks 30: two Dashes of 120 put the Succubus beyond 150 feet after one volley. It flew 60 and Dodged in range.
  for (const seed of [1, 2, 3]) assert.equal(rounds(run('Succubus', 'Stone Golem', 'max600', seed).log)[0][0], 'Succubus dashes (30 ft -> 150 ft)');
});

test('I08 control: in a room of 120 feet there is nowhere to Dash to', () => {
  for (const seed of [1, 2, 3]) assert.equal(count(run('Succubus', 'Stone Golem', 'max120', seed).log, 'Succubus dashes'), 0);
});

test('I09 an Opportunity Attack that drops the mover says the mover was leaving', () => {
  const log = run('Mimic', 'Scout', 'max600', 1).log;
  assert.deepEqual(log.slice(-3), ['Mimic makes an opportunity attack', 'Scout takes 19 damage (0 hp left)', 'Scout falls as it moves away']);
});

test('I09 control: one that does not drop the mover is followed by the move', () => {
  // A Hill Giant stepping back from a Shield Guardian to throw (a Centaur Trooper Dashes clear before the Guardian arrives, N07).
  const log = run('Hill Giant', 'Shield Guardian', 'max120', 1).log;
  const swing = log.indexOf('Shield Guardian makes an opportunity attack');
  assert.ok(swing > 0);
  assert.equal(log[swing + 2], 'Hill Giant moves (5 ft -> 45 ft)');
});

test('I10 a Bugbear Stalker beside its foe makes its Quick Grapple before it attacks', () => {
  // Quick Grapple (p271, a Bonus Action): "Failure: The target has the Grappled condition". Morningstar: "Advantage if
  // the target is Grappled by the bugbear". Against a Sea Hag: 0.55 x 20.2 + 0.45 x 16.2 = 18.4 against two Javelins' 16.2.
  for (const seed of [1, 3]) {
    const second = rounds(run('Bugbear Stalker', 'Sea Hag', 'max30', seed).log)[1];
    assert.deepEqual(second.slice(0, 3), ['Bugbear Stalker uses bonus action Quick Grapple', 'Sea Hag gains grappled', 'Bugbear Stalker uses Morningstar']);
  }
});

test('I10 control: from 30 feet, out of the grapple\'s 10, it throws its Javelins first', () => {
  for (const seed of [1, 3]) assert.equal(rounds(run('Bugbear Stalker', 'Sea Hag', 'max30', seed).log)[0][0], 'Bugbear Stalker uses Javelin');
});

test('I12 a made save\'s push does not move a target its half damage killed', () => {
  // Deadly Leap (p272): "Success: Half damage, and the target is pushed 5 feet straight away."
  const log = run('Bulette', 'Knight', 'max30', 3).log;
  assert.deepEqual(log.slice(-2), ['Bulette uses Deadly Leap', 'Knight takes 12 damage (0 hp left)']);
});

test('I12 control: the same made save still pushes a Knight it does not kill', () => {
  const log = run('Bulette', 'Knight', 'max30', 7).log;
  const pushed = log.indexOf('Knight is pushed (5 ft -> 10 ft)');
  assert.ok(pushed > 0);
  assert.equal(log[pushed - 1], 'Knight takes 8 damage (32 hp left)');
});
