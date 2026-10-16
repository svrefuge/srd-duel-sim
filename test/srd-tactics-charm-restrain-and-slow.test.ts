// Creatures Charmed by a song, Restrained dragons breathing rather than escaping, pushes that buy nothing, and Slow.
// Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the test
// name.
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

// A Harpy with only its song: with Claws to come back to it sings from 35 feet, over the Spy's head (E15).
const harpy = block('Harpy');
const singer = { ...harpy, routines: harpy.routines.filter((r) => r.parts.every((p) => harpy.options[p.optionIdx].name === 'Luring Song')) };

test('J01 a creature Charmed by a Harpy\'s Luring Song walks toward the Harpy', () => {
  // Luring Song (p297): "If the target is more than 5 feet from the harpy, the target moves on its turn toward the
  // harpy by the most direct route, trying to get within 5 feet of the harpy." A Spy (Speed 30) Charmed at 70 feet
  // ends its turn at 40; it walked to 100.
  const song = block('Harpy').options.find((o) => o.name === 'Luring Song')!.action;
  assert.ok('riders' in song && song.riders?.[0].drawnToSource);
  for (const seed of [2, 4]) {
    const log = fight(singer, block('Spy'), seed, true, 'max120').log;
    assert.ok(log.includes('Spy is drawn toward Harpy (70 ft -> 40 ft)'));
    assert.equal(count(log, 'Spy is incapacitated but moves'), 0);
  }
});

test('J01 control: a Spy that makes the save moves as it chooses', () => {
  const log = fight(singer, block('Spy'), 3, true, 'max120').log;
  assert.ok(rounds(log)[0].includes('Spy saves'));
  assert.ok(rounds(log)[0].includes('Spy moves (70 ft -> 100 ft)'));
  assert.equal(count(log, 'is drawn toward'), 0);
});

test('J02 a Restrained dragon with its breath ready breathes instead of rolling to escape', () => {
  // Restrained: "your attack rolls have Disadvantage". Lightning Breath is a Dexterity save (DC 15, 9d10), about 37
  // against a Drider, and no attack roll: the Web takes nothing from it. It rolled to escape for two rounds at 30 feet.
  const first = rounds(run('Young Bronze Dragon', 'Drider', 'max30', 5).log)[0];
  assert.ok(first.includes('Young Bronze Dragon gains restrained'));
  assert.ok(first.includes('Young Bronze Dragon uses Lightning Breath'));
  assert.equal(count(first, 'escape'), 0);
});

test('J02 control: a Restrained Giant Ape at 10 feet, whose Fists are attack rolls, still rolls to escape', () => {
  const second = rounds(run('Giant Ape', 'Drider', 'max30', 3).log)[1];
  assert.equal(second[0], 'Giant Ape fails to escape (DC 14)');
});

test('J04 a push is not used on a foe that has nothing to do to the pusher', () => {
  // A Will-o'-Wisp's Shock is Lightning and a Bronze Dragon Wyrmling is immune: the Wisp only Dodges. Two Rends at
  // Disadvantage against AC 19 are 2 x 0.35^2 x 4 = about 1 a round against 19 Hit Points, a win; Repulsion Breath
  // deals nothing. It breathed 99 times in a 30-foot room and drew.
  for (const seed of [1, 2, 4]) {
    const result = run('Bronze Dragon Wyrmling', 'Will-o\'-Wisp', 'max30', seed);
    assert.equal(result.winner, 0);
    assert.equal(count(result.log, 'uses Repulsion Breath'), 0);
  }
});

test('J04 control: a Young Bronze Dragon still pushes a Chain Devil whose Chains hold it', () => {
  for (const seed of [1, 2]) assert.ok(count(run('Young Bronze Dragon', 'Chain Devil', 'max30', seed).log, 'uses Repulsion Breath') > 0);
});

test('J09 under Slow, a part that replaces an attack is made in place of the one attack, not beside it', () => {
  // Slow (p163): "it can make only one attack if it takes the Attack action". Young Copper Dragon (p276): "It can
  // replace one attack with a use of Slowing Breath"; Wight: "It can replace one attack with a use of Life Drain". The
  // one attack is the one replaced: a Slowed dragon made its Rend and breathed as well.
  const dragon = rounds(run('Young Copper Dragon', 'Stone Golem', 'max30', 1).log)[1];
  assert.equal(count(dragon, 'Young Copper Dragon uses Rend'), 1);
  assert.equal(count(dragon, 'Young Copper Dragon uses Slowing Breath'), 0);
  const wight = rounds(run('Wight', 'Stone Golem', 'max30', 1).log)[1];
  assert.equal(count(wight, 'Wight uses'), 1);
});

test('J09 control: a part the Multiattack adds is not a replacement, and an attack that replaces one needs no mark', () => {
  // Chuul: "The chuul makes two Pincer attacks and uses Paralyzing Tentacles."
  assert.ok(block('Chuul').routines.every((routine) => routine.parts.every((part) => !part.replacesAttack)));
  assert.ok(block('Wight').routines.some((routine) => routine.parts.some((part) => part.replacesAttack && block('Wight').options[part.optionIdx].name === 'Life Drain')));
  for (const b of blocks) for (const routine of b.routines) for (const part of routine.parts) if (part.replacesAttack) assert.notEqual(b.options[part.optionIdx].action.kind, 'attack');
});
