// U01 and U03: the altitude cap. A scenario's name is the most the two creatures can be
// apart, so the sky is that far above the other creature's body, as the ground between them is that long (`skyRoof`).
// It is not a roof the flier's own body has to fit under, which would give 15 feet of climb for a Huge flier in `max30`, 10 for a
// Gargantuan one, and neither clears a Large foe's 5-foot reach (10 + 5 + 5 = 20 feet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight, srdMechanicsForTest as e } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const run = (a: string, b: string, scenario: 'max30' | 'max120', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;

test('U03 a Huge flier climbs clear of a Large foe\'s 5-foot reach in max30', () => {
  // Marilith: Large, Pact Blade reach 5 ft., no ranged attack. Adult Blue Dragon: Huge, Rend reach 10 ft., Fly 80 ft.
  // 20 feet up is 10 feet above her: inside its reach and outside hers. Staying on the ground it dies in round 3,
  // where at max120 it climbs and wins.
  for (const seed of [1, 2, 3]) {
    const t = run('Marilith', 'Adult Blue Dragon', 'max30', seed);
    assert.ok(t.log.some((line) => line.includes('Adult Blue Dragon') && line.includes('ft to 20 ft]')), `seed ${seed}`);
    assert.equal(t.winner, 1, `seed ${seed}`);
  }
});

test('U03 control: the cap still binds, 30 feet above the foe\'s body', () => {
  const dragon = block('Adult Blue Dragon'), marilith = block('Marilith');
  const roof = e.startingEngagement('max30').ceiling + e.bodyHeight(marilith);
  assert.equal(roof, 40);
  assert.equal(Math.max(...e.moveHeights(dragon, 0, marilith, 0, 80, roof)), 40);
  assert.equal(e.verticalGap(dragon, 40, marilith, 0), 30);
  for (const seed of [1, 2, 3]) {
    const heights = run('Marilith', 'Adult Blue Dragon', 'max30', seed).log.flatMap((line) => [...line.matchAll(/ft to (\d+) ft\]/g)].map((m) => Number(m[1])));
    assert.ok(Math.max(...heights) <= 40, `seed ${seed}: ${Math.max(...heights)}`);
  }
});

test('U01 a flier with nothing to finish its foe holds out of reach and draws', () => {
  // Troll (p333): "The troll dies only if it starts its turn with 0 Hit Points and doesn't regenerate", and only Acid
  // or Fire stops that; an Ancient Blue Dragon has Slashing and Lightning. Large, Rend reach 10 ft.: 10 + 10 + 5 = 25
  // feet up is clear. It died in round 42 to about one Rend a round.
  const dragon = run('Ancient Blue Dragon', 'Troll', 'max30', 1);
  assert.equal(dragon.winner, -1);
  assert.equal(count(dragon.log, 'Ancient Blue Dragon takes'), 0);
  // Ochre Jelly: Immunities Lightning, Slashing, and every attack a Storm Giant prints is one or both. It flew in and
  // out through an Opportunity Attack each round and died in round 49.
  const giant = run('Storm Giant', 'Ochre Jelly', 'max30', 1);
  assert.equal(giant.winner, -1);
  assert.ok(count(giant.log, 'Storm Giant takes') <= 1, String(count(giant.log, 'Storm Giant takes')));
});

test('U01 control: a dragon whose breath stops the regeneration fights and wins', () => {
  assert.equal(run('Ancient Red Dragon', 'Troll', 'max30', 1).winner, 0);
});

test('U01 a lift stops short of bringing a source overhead into the target\'s reach', () => {
  // Telekinesis (p167): "move it up to 30 feet in any direction within the spell's range". A Cloud Giant 35 feet up
  // and 5 feet off, with nothing to finish a Troll Limb (Small, Rend reach 5 ft.), raised it 30 feet into its own space
  // (0 feet apart) and was Rent there. 25 feet leaves it 5 feet below the giant, in reach; 20 feet leaves it 10 below.
  const giant = block('Cloud Giant'), limb = block('Troll Limb'), a = e.initState(giant), d = e.initState(limb);
  const engagement = { ...e.startingEngagement('max30'), ground: 5, distance: 30 };
  a.height = 35;
  assert.equal(e.verticalGap(giant, 35, limb, 0), 30);
  assert.equal(e.liftHeight(giant, a, limb, d, engagement, 30, 60), 20);
});

test('U01 control: from the ground, and from overhead beyond the target\'s reach, the lift is the full 30 feet', () => {
  const giant = block('Cloud Giant'), limb = block('Troll Limb'), a = e.initState(giant), d = e.initState(limb);
  assert.equal(e.liftHeight(giant, a, limb, d, { ...e.startingEngagement('max30'), ground: 5, distance: 5 }, 30, 60), 30);
  // 30 feet off along the ground, the limb 30 feet up is no nearer than it was.
  a.height = 35;
  assert.equal(e.liftHeight(giant, a, limb, d, { ...e.startingEngagement('max30'), ground: 30, distance: 30 }, 30, 60), 30);
  const log = run('Cloud Giant', 'Troll Limb', 'max30', 21).log;
  assert.ok(log.includes('Troll Limb is lifted 30 ft (altitude 30 ft)'), log.slice(0, 20).join('\n'));
});

test('U05 a flier holds the lowest height clear of a foe with nothing that reaches farther', () => {
  // Owlbear: Large (10 ft tall), Rend reach 5 ft., no ranged attack: 10 + 5 + 5 = 20 feet. Height beyond that buys
  // nothing, and a non-hovering flier owes 1d6 for each 10 feet if it is dropped. The Manticore climbed to the cap.
  for (const scenario of ['max30', 'max120'] as const) {
    const heights = run('Manticore', 'Owlbear', scenario, 1).log.flatMap((line) => [...line.matchAll(/ft to (\d+) ft\]/g)].map((m) => Number(m[1])));
    assert.ok(heights.includes(20), `${scenario}: ${heights}`);
    assert.ok(Math.max(...heights) <= 20, `${scenario}: ${heights}`);
  }
});

test('U05 control: it still climbs beyond the longest range of a foe that shoots', () => {
  // Pirate Captain: Pistol 30/90 ft. Getting past 90 feet takes two turns of climbing, which the threat a turn ahead
  // does not show: held at 15 feet the Manticore lost all its fights, where from 100 feet it wins 319 of 400.
  const heights = run('Manticore', 'Pirate Captain', 'max120', 1).log.flatMap((line) => [...line.matchAll(/ft to (\d+) ft\]/g)].map((m) => Number(m[1])));
  assert.ok(Math.max(...heights) >= 95, String(heights));
});

test('U05 control: over a foe with Fly still to cast, the height is left as it was', () => {
  // Rakshasa: "1/Day Each: Fly". An Adult White Dragon 35 feet up costs it the spell's movement and a longer fall when
  // its Concentration breaks: 374 wins of 400 from there, 319 from 15 feet.
  const first = run('Adult White Dragon', 'Rakshasa', 'max30', 1).log.find((line) => line.includes('[altitude'));
  assert.ok(first?.includes('[altitude 0 ft to 35 ft]'), String(first));
});
