// "Up to" pulls, Speed as the faster of two speeds, Pounce and Legendary movement. Each test is written from the
// printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e, legendaryMoveProneForTest as m } from '../src/engine/fight.ts';
import type { CombatStatblock, Rider } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const riders = (monster: string, name: string): Rider[] => (option(monster, name).action as { riders: Rider[] }).riders;
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
const prone = { name: 'prone', duration: 'permanent' } as never;

test('R01 a pull printed "up to" its feet is the attacker\'s to shorten; a flat pull is not', () => {
  // Balor p.261 "pulls the target up to 25 feet straight toward itself"; Merrow p.308 "pulls the target up to 15 feet
  // straight toward itself"; Chain Devil p.273 "moves the target up to 30 feet straight toward itself".
  assert.equal(riders('Balor', 'Flame Whip').find((r) => r.pull)!.pullUpTo, true);
  assert.equal(riders('Merrow', 'Harpoon').find((r) => r.pull)!.pullUpTo, true);
  assert.equal(riders('Chain Devil', 'Conjure Infernal Chain').find((r) => r.pull)!.pullUpTo, true);
});

test('R01 control: Shambling Mound prints a flat 5 feet', () => {
  // p.323: "the shambling mound pulls the target 5 feet straight toward itself."
  const pull = riders('Shambling Mound', 'Charged Tendril').find((r) => r.pull)!;
  assert.equal(pull.pull, 5);
  assert.equal(pull.pullUpTo, undefined);
});

/** One hit by `monster`'s pulling attack on a Brown Bear (Bite and Claw, reach 5 ft) of the given Speed, from `distance`. */
function pulled(monster: string, attack: string, bearSpeed: number, distance: number, size = 3): number {
  const puller = block(monster), bear: CombatStatblock = { ...block('Brown Bear'), hpAvg: 1000, speed: bearSpeed, size };
  const a = e.initState(puller), d = e.initState(bear), engagement = at(distance);
  e.resolveOptionWithTeleport(puller, bear, a, d, option(monster, attack).action, rolls(0.9), 0, engagement, new FightLog(true), e.createPairEvaluator(puller, bear, true));
  return engagement.distance;
}

test('R02 Merrow Harpoon: the merrow pulls a bear that could not otherwise reach it only as far as keeps it out of reach', () => {
  // Harpoon hits at 20 ft. A bear with Speed 5 reaches 5 ft with its Bite and Claw. Pulled 15 ft it stands at 5 ft and
  // attacks; pulled 10 ft it stands at 10 ft, steps 5 and attacks; pulled 5 ft it stands at 15 ft, steps to 10 and cannot.
  // The harpoon is as good from 15 ft as from 5, so the merrow pulls 5 ft: 20 - 5 = 15 ft.
  assert.equal(pulled('Merrow', 'Harpoon', 5, 20), 15);
});

test('R02 control: a bear that can close anyway is pulled the full 15 feet, and a flat pull is always made', () => {
  // Speed 40 covers the 20 ft whatever the pull, so no length is better than another and the pull is made in full: 5 ft.
  assert.equal(pulled('Merrow', 'Harpoon', 40, 20), 5);
  // Shambling Mound's 5 feet is not a choice (a Medium target; it pulls nothing larger): 10 - 5 = 5 ft, into the slow
  // bear's reach.
  assert.equal(pulled('Shambling Mound', 'Charged Tendril', 5, 10, 2), 5);
});

test('R03 "Speed" is the faster of a creature\'s speeds: standing from Prone costs half of it', () => {
  // Rules glossary p.186 (Prone): "spend an amount of movement equal to half your Speed (round down) to right yourself".
  // The reading used here: a creature with a Speed and a Fly Speed uses the faster. Adult Red Dragon, Speed 40 ft., Fly
  // 80 ft.: 80 / 2 = 40 ft. Air Elemental, Speed 10 ft., Fly 90 ft.: 45 ft.
  const dragon = block('Adult Red Dragon');
  assert.equal(dragon.speed, 80);
  assert.equal(m.standCost(dragon, m.initState(dragon)), 40);
  assert.equal(m.standCost(block('Air Elemental'), m.initState(block('Air Elemental'))), 45);
});

test('R03 control: a creature with one Speed pays half of it', () => {
  const guard = block('Guard');
  assert.equal(m.standCost(guard, m.initState(guard)), 15);
});

function pounce(startsProne: boolean, distance: number) {
  // The dragon's Legendary step after the guard's turn, with Pounce its only entry. Rend reaches 10 ft.
  const red = block('Adult Red Dragon'), dragon = { ...red, legendaryOptions: red.legendaryOptions.filter((l) => l.move?.when === 'before') }, foe = { ...block('Guard'), hpAvg: 1000 }, a = m.initState(dragon), d = m.initState(foe), lines = new FightLog(true);
  if (startsProne) a.conditions.push(prone);
  const engagement = at(distance);
  m.legendaryStep([dragon, foe], [a, d], 1, rolls(0.5), engagement, lines, m.createPairEvaluator(dragon, foe, true));
  return { prone: a.conditions.some((c) => c.name === 'prone'), distance: engagement.distance, stood: lines.lines.some((l) => l.includes('to stand')), pounced: lines.lines.some((l) => l.includes('uses legendary Rend')) };
}

test('R04 Pounce: a Prone dragon in reach stands with the 40-foot grant and makes its Rend standing', () => {
  // p.264: "The dragon moves up to half its Speed, and it makes one Rend attack." Half of 80 is 40 ft; standing costs
  // 40 ft; 40 - 40 = 0 ft left, and the Rend is made standing, from where the dragon is.
  const entry = block('Adult Red Dragon').legendaryOptions.find((l) => l.move?.when === 'before')!;
  const dragon = block('Adult Red Dragon'), state = m.initState(dragon);
  state.conditions.push(prone);
  assert.deepEqual(m.legendaryMoveBudget(dragon, state, entry.move!), { budget: 0, stands: true });
  assert.deepEqual(pounce(true, 10), { prone: false, distance: 10, stood: true, pounced: true });
});

test('R04 control: a standing dragon spends nothing to stand, and a Prone one out of reach crawls rather than stand short', () => {
  assert.deepEqual(pounce(false, 10), { prone: false, distance: 10, stood: false, pounced: true });
  // At 25 ft the stand leaves 0 ft and the Rend does not reach; crawling, the 40 ft covers 20 ft: 25 -> 10 ft (no closer
  // than the reach needs), still Prone.
  assert.deepEqual(pounce(true, 25), { prone: true, distance: 10, stood: false, pounced: true });
  // At 35 ft the crawl's 20 ft ends at 15 ft, out of reach: nothing is done.
  assert.deepEqual(pounce(true, 35), { prone: true, distance: 35, stood: false, pounced: false });
});

test('R05 a bare Legendary Move is up to the creature\'s Speed, the faster mode', () => {
  // No SRD block prints one; the path reads "its Speed" as Pounce does. Speed 40 ft., Fly 80 ft.
  const dragon = block('Adult Red Dragon'), state = m.initState(dragon);
  assert.deepEqual(m.legendaryMoveBudget(dragon, state, { halfSpeed: false }), { budget: 80, stands: false });
  assert.deepEqual(m.legendaryMoveBudget(dragon, state, { halfSpeed: true }), { budget: 40, stands: false });
});

test('R05 control: with one Speed the grant is that Speed', () => {
  const guard = block('Guard');
  assert.deepEqual(m.legendaryMoveBudget(guard, m.initState(guard), { halfSpeed: false }), { budget: 30, stands: false });
});
