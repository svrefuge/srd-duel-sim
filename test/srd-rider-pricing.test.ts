// Rider pricing by the pair and the position (I11). Each test names its finding id
// and quotes the printed SRD 5.2.1 rule or the arithmetic the behaviour is judged by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const run = (a: string, b: string, scenario: 'max30' | 'max120' | 'max600', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;

test('R01 a Fire Giant beside a Stone Golem swings its Flame Sword instead of throwing its hammer', () => {
  // Hammer Throw (p285): "23 (3d10 + 7) Bludgeoning damage plus 4 (1d8) Fire damage, and the target is pushed up to 15
  // feet ... and has Disadvantage on the next attack roll it makes before the end of its next turn." One roll: 0.35 of
  // one Slam, not 8% of the golem's 220 Hit Points (17.6). Flame Sword is 31.5 a hit against the hammer's 28, and the
  // golem walks back from the push. It threw 4 or 5 hammers a fight and won 78 of 400; with swords, 144.
  for (const seed of [1, 2, 3]) {
    const log = run('Fire Giant', 'Stone Golem', 'max30', seed).log;
    assert.ok(count(log, 'Fire Giant uses Hammer Throw') <= 1);
    assert.ok(count(log, 'Fire Giant uses Flame Sword') >= 6);
  }
});

test('R01 control: against a Young Gold Dragon, immune to the sword\'s Fire, it throws two hammers a turn', () => {
  // The push the dragon flies back from is taken out of each throw once, and the repeat discount is taken on what is left.
  for (const seed of [1, 2, 3]) {
    const log = run('Fire Giant', 'Young Gold Dragon', 'max30', seed).log;
    assert.equal(count(log, 'Fire Giant uses Flame Sword'), 0);
    assert.ok(count(log, 'Fire Giant uses Hammer Throw') >= 8);
  }
});

test('R02 a Bulette beside a Half-Dragon bites twice instead of leaping on it', () => {
  // Deadly Leap (p272) is 19.5 (3d12) and Prone on a failed save; two Bites are 2 x 17. Prone (p186): "An attack roll
  // against you has Advantage if the attacker is within 5 feet of you", and the Leap is the turn's only attack, so the
  // knock-down buys no swing behind it. It leapt every turn and won 30 of 400; biting, 132.
  for (const seed of [1, 2, 3]) {
    const log = run('Bulette', 'Half-Dragon', 'max120', seed).log;
    assert.equal(count(log, 'Bulette uses Deadly Leap'), 0);
    assert.ok(count(log, 'Bulette uses Bite') >= 7);
  }
});

test('R02 control: against a Knight in plate (AC 18) the Leap\'s save is still worth more than two Bites', () => {
  for (const seed of [1, 2, 3]) assert.ok(count(run('Bulette', 'Knight', 'max30', seed).log, 'Bulette uses Deadly Leap') >= 3);
});

test('R03 a knock-down from range keeps its price against a foe it stops from closing', () => {
  // Storm Bolt (p280): "If the target is a Large or smaller creature, it has the Prone condition." Prone (p186): "spend
  // an amount of movement equal to half your Speed ... to right yourself". From 95 feet a Young Silver Dragon stands
  // and Dashes and never attacks. Priced as Advantage on the Bolts behind it, the Djinni closed to use its Storm Blade
  // and won 272 of 400 instead of 339.
  for (const seed of [1, 2, 3]) {
    const log = run('Djinni', 'Young Silver Dragon', 'max120', seed).log;
    assert.ok(count(log, 'Djinni uses Storm Bolt') >= 18);
    assert.ok(count(log, 'Djinni uses Storm Blade') <= 3);
  }
});

test('R04 an Adult Bronze Dragon does not give up a Rend to push a foe that fights as well from range', () => {
  // Repulsion Breath (p270): "The target is pushed up to 30 feet straight away from the dragon and has the Prone
  // condition." No damage. An Adult Black Dragon pushed 60 feet stood, kept its distance and cast Vitriolic Sphere:
  // the push is worth what the foe loses on its way back, not 8% of its Hit Points. With the flat share the Bronze
  // breathed 2 or 3 times a fight and won 266 of 400 instead of 298.
  for (const seed of [1, 2, 3]) assert.equal(count(run('Adult Bronze Dragon', 'Adult Black Dragon', 'max120', seed).log, 'uses Repulsion Breath'), 0);
});

test('R03 R04 control: a flier still stays down under a thrower whose rock would knock it out of the air', () => {
  // Flying (p182): "you fall if you have the Incapacitated or Prone condition". The same case as G05.
  assert.ok(run('Young Copper Dragon', 'Stone Giant', 'max120', 1).log.includes('Young Copper Dragon moves (30 ft -> 40 ft)'));
});

test('R05 an Ancient Gold Dragon does not spend Legendary Actions on a Banish that ends before the foe acts', () => {
  // Banish (p292): "the target has the Incapacitated condition and is transported to a harmless demiplane until the
  // start of the dragon's next turn". A Legendary Action is taken "immediately after another creature's turn", and in
  // a duel the dragon's own turn is next: the foe loses nothing. Guiding Bolt is 24.5 (7d6) on a hit. It Banished an
  // Ancient Red Dragon ten times in one fight.
  for (const seed of [1, 2, 3]) {
    const log = run('Ancient Gold Dragon', 'Ancient Red Dragon', 'max30', seed).log;
    assert.equal(count(log, 'uses legendary Banish'), 0);
  }
});

test('R05 control: it still spends them on Guiding Bolt', () => {
  for (const seed of [1, 2, 3]) assert.ok(count(run('Ancient Gold Dragon', 'Ancient Red Dragon', 'max30', seed).log, 'uses legendary Guiding Bolt') >= 6);
});
