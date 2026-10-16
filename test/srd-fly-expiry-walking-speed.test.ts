// A caster whose Fly ends mid-move keeps only the walking Speed the turn has not used. Each test is written from the
// printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;

/** Feet moved by `name` on the turn it casts Fly, per fight, with whether an opportunity attack ended the spell mid-move. */
function flyTurns(name: string, foe: string, scenario: 'max30' | 'max120' | 'max600', seeds: number[]): { seed: number; moved: number; lost: boolean; stood: boolean }[] {
  const out = [];
  for (const seed of seeds) {
    const [first, second] = [name, foe].sort(); // the scan's order
    const log = fight(block(first), block(second), seed, true, scenario).log;
    const cast = log.indexOf(`${name} uses Fly`);
    if (cast < 0) continue;
    let start = cast, end = cast;
    while (start > 0 && !/^Round /.test(log[start]) && !log[start].startsWith(`${foe} uses`) && !log[start].startsWith(`${foe} moves`)) start--;
    while (end < log.length - 1 && !/^Round /.test(log[end + 1]) && !log[end + 1].startsWith(`${foe} uses`) && !log[end + 1].startsWith(`${foe} moves`)) end++;
    const turn = log.slice(start, end + 1);
    let moved = 0;
    for (const line of turn) {
      const m = line.match(new RegExp(`^${name} (moves|flies) \\((\\d+) ft -> (\\d+) ft\\)(?: \\[altitude (\\d+) ft to (\\d+) ft\\])?`));
      if (m) moved += Math.max(Math.abs(+m[3] - +m[2]), Math.abs(+(m[5] ?? 0) - +(m[4] ?? 0)));
    }
    out.push({ seed, moved, lost: turn.includes(`${name} loses Concentration`), stood: turn.includes(`${name} spends half its Speed to stand`) });
  }
  return out;
}
const seeds = Array.from({ length: 40 }, (_, i) => i + 1);

test('RS36 a caster whose Fly ends mid-move has its walking Speed less what the turn already moved', () => {
  // p188, Speed: "Whenever you switch, subtract the distance already moved from the new speed. The result determines
  // how much farther you can move." Rakshasa: Speed 40 ft. Fly: "the target gains a Fly Speed of 60 feet".
  // It walks 25 ft, casts Fly (60 - 25 = 35 ft left), and the opportunity attack ends the spell: 40 - 25 = 15 ft left,
  // 40 ft in the turn. Before, the 35 ft was scaled by 40/60 to 23 ft (Marilith, max30, seed 31: 48 ft).
  const turns = flyTurns('Rakshasa', 'Marilith', 'max30', [31, ...seeds]);
  const lost = turns.filter((t) => t.lost);
  assert.ok(lost.length > 0, 'some fight loses Fly to the opportunity attack');
  for (const t of lost) assert.ok(t.moved <= 40, `seed ${t.seed}: moved ${t.moved} ft on a Speed of 40`);
  assert.equal(turns.find((t) => t.seed === 31)!.moved, 40);
});

test('RS36 the half Speed spent standing comes off the walking Speed too', () => {
  // p188 as above; Prone: "spend an amount of movement equal to half your Speed (round down) to right yourself".
  // Mage: Speed 30 ft. It stands (15 ft), casts Fly (60 - 15 = 45 ft left), loses it: 30 - 15 = 15 ft left.
  // Mammoth, max120, seed 25: the Mammoth ends beside the Mage (BS11), so the Mage stands (15 ft) and walks 5 ft before it casts: 30 - 20 = 10.
  const log = fight(block('Mage'), block('Mammoth'), 25, true, 'max120').log;
  const cut = log.findIndex((line) => line.startsWith("Mage's Speed is cut mid-move"));
  assert.ok(cut > 0 && log.slice(cut - 8, cut).includes('Mage spends half its Speed to stand'), 'the fight still stands, casts and loses Fly');
  assert.ok(log.slice(cut - 8, cut).includes('Mage moves (5 ft -> 10 ft)'));
  assert.equal(log[cut], "Mage's Speed is cut mid-move (10 ft of movement left)");
  const move = log.slice(cut).find((line) => /^Mage (moves|flies) \(/.test(line))!.match(/\((\d+) ft -> (\d+) ft\)/)!;
  assert.equal(Math.abs(+move[2] - +move[1]), 10, move[0]);
});

test('RS36 control: a caster that keeps its Fly moves on with the Fly Speed less what it had moved', () => {
  // The same turn with the spell intact: 60 ft in all, more than the walking Speed of 40.
  const kept = flyTurns('Rakshasa', 'Marilith', 'max30', seeds).filter((t) => !t.lost);
  assert.ok(kept.length > 0, 'some fight keeps Fly');
  assert.ok(kept.some((t) => t.moved > 40), 'a caster still flying moves past its walking Speed');
  for (const t of kept) assert.ok(t.moved <= 60, `seed ${t.seed}: moved ${t.moved} ft on a Fly Speed of 60`);
});
