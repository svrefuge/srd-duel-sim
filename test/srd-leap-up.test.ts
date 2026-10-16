// A printed Leap made upward. Each test names its finding id and quotes the printed SRD 5.2.1
// rule or the arithmetic the behaviour is judged by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const run = (a: string, b: string, scenario: 'max30' | 'max120' | 'max600', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;

test('L01 a Giant Ape Leaps up at a dragon in the air, makes its attacks and falls', () => {
  // Leap (p349, a Bonus Action): "The ape jumps up to 30 feet by spending 10 feet of movement." Jumping (p184): "you make
  // either a Long Jump (horizontal) or a High Jump (vertical)". Falling (p182): "1d6 Bludgeoning damage at the end of the
  // fall for every 10 feet it fell". A Young Red Dragon 40 feet up is 25 above a Huge ape's 15; a Fist reaches 10, so
  // the jump is 15 and the fall 1d6. It Dodged under the dragon.
  for (const seed of [1, 2]) {
    const log = run('Giant Ape', 'Young Red Dragon', 'max120', seed).log;
    const leap = log.indexOf('Giant Ape leaps up [altitude 0 ft to 15 ft]');
    assert.ok(leap > 0);
    assert.equal(log[leap - 1], 'Giant Ape uses bonus action Leap');
    assert.equal(log[leap + 1], 'Giant Ape uses Fist');
    const fall = log.indexOf('Giant Ape falls 15 ft');
    assert.ok(fall > leap);
    assert.match(log[fall + 1], /^Giant Ape takes [1-6] damage/);
    assert.ok(log.includes('Giant Ape spends half its Speed to stand'));
  }
});

test('L01 a Bulette makes its Deadly Leap from the top of its Leap', () => {
  // Deadly Leap (p272): "The bulette spends 5 feet of movement to jump to a space within 15 feet that contains one or
  // more Large or smaller creatures." A Young Brass Dragon 50 feet up is 40 above a Large bulette: 25 by the Leap,
  // 15 by the Deadly Leap. (A wyrmling does not come within that reach of a Bulette: L04.)
  const log = run('Bulette', 'Young Brass Dragon', 'max120', 1).log;
  const leap = log.indexOf('Bulette leaps up [altitude 0 ft to 25 ft]');
  assert.ok(leap > 0);
  assert.deepEqual(log.slice(leap + 1, leap + 3), ['Bulette uses Deadly Leap', 'Young Brass Dragon takes 10 damage (61 hp left)']);
  assert.ok(log.slice(leap + 3, leap + 8).includes('Bulette falls 25 ft'));
});

test('L01 control: a Lamia fighting an Owlbear on the ground never Leaps upward', () => {
  for (const seed of [1, 2]) assert.equal(count(run('Lamia', 'Owlbear', 'max30', seed).log, 'leaps up'), 0);
});

test('L02 a flier keeps clear of the height a foe\'s Leap carries it to', () => {
  // A Hezrou (Large, 10 feet tall, reach 5) with a 30-foot Leap reaches 45 feet up: a Chimera leaving it climbs to 50.
  for (const seed of [1, 2, 3]) assert.ok(run('Hezrou', 'Chimera', 'max120', seed).log.includes('Chimera moves (5 ft -> 40 ft) [altitude 0 ft to 50 ft]'));
});

test('L02 control: over an Owlbear, which has no Leap, a Young Red Dragon hovers 20 feet up', () => {
  for (const seed of [1, 2]) {
    const log = run('Young Red Dragon', 'Owlbear', 'max120', seed).log;
    assert.ok(count(log, 'altitude 0 ft to 20 ft') >= 1);
    assert.equal(count(log, 'to 50 ft]'), 0);
  }
});

test('L03 a flier waiting on its breath pays one Opportunity Attack to leave a losing exchange', () => {
  // Beside a Hezrou with Fire Breath spent, a Chimera's Ram and Bite are worth 8 a round against three Rends at 38. The
  // Opportunity Attack is paid once and the exchange every round. It stayed and lost all 400 fights.
  for (const seed of [1, 2, 3]) {
    const log = run('Hezrou', 'Chimera', 'max120', seed).log;
    const swing = log.indexOf('Hezrou makes an opportunity attack');
    assert.ok(swing > 0);
    assert.equal(log[swing + 2], 'Chimera moves (5 ft -> 40 ft) [altitude 0 ft to 50 ft]');
    assert.equal(log[swing + 3], 'Chimera dodges');
  }
});

test('L03 control: a Chimera winning its exchange with a Hill Giant stays beside it', () => {
  for (const seed of [1, 2]) {
    const result = run('Chimera', 'Hill Giant', 'max120', seed);
    assert.equal(result.winner, 0);
    assert.equal(count(result.log, 'opportunity attack'), 0);
    assert.equal(count(result.log, 'altitude'), 0);
  }
});
