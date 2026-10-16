// Poisonous Spittle and True Seeing, spell-component wording, Hypnotic Pattern needing sight, and Nightmare Haunting.
// Each test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const option = (monster: string, name: string) => block(monster).options.find((o) => o.name === name)!;
const action = (monster: string, name: string) => option(monster, name).action;
/** A Medium Humanoid bystander with 1000 hit points, AC 16 and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
/** An rng that returns the listed values in order, then repeats the last. A d20 shows 1 + floor(value * 20). */
const rolls = (...values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const log = () => new FightLog(true);
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
/** One turn of `user` against `foe` at `distance`, with every die in the middle; returns the log and both states. */
function turnOf(user: CombatStatblock, foe: CombatStatblock, distance: number, prepare?: (a: ReturnType<typeof e.initState>, d: ReturnType<typeof e.initState>) => void) {
  const a = e.initState(user), d = e.initState(foe), lines = log();
  prepare?.(a, d);
  e.takeTurn([user, foe], [a, d], 0, rolls(0.5), at(distance), lines, e.createPairEvaluator(user, foe, true), false);
  return { lines: lines.lines, a, d };
}
const routineParts = (monster: string) => block(monster).routines.map((r) => r.parts.map((p) => `${block(monster).options[p.optionIdx].name} x${p.count}`).join(' + '));

test('V02 Guardian Naga may replace both Bites with Poisonous Spittle', () => {
  // p.296: "Multiattack. The naga makes two Bite attacks. It can replace any attack with a use of Poisonous Spittle."
  // Any attack, so: Bite x2, Bite + Spittle, and Spittle x2.
  const parts = routineParts('Guardian Naga');
  assert.ok(parts.includes('Bite x2'), parts.join(' | '));
  assert.ok(parts.includes('Bite x1 + Poisonous Spittle x1'), parts.join(' | '));
  assert.ok(parts.includes('Poisonous Spittle x2'), parts.join(' | '));
});

test('V02 at 60 feet, out of its Bite\'s reach, the naga spits twice in one action', () => {
  // Spittle: "one creature the naga can see within 60 feet"; Bite: "reach 10 ft." Speed 40 from 60 ft would reach,
  // so the foe is put in the air above its reach instead: only the Spittle can be used, and it is used twice.
  const naga = block('Guardian Naga');
  const { lines } = turnOf(naga, tank({ flySpeed: 60, canHover: true }), 60, (_, d) => { d.height = 55; });
  assert.equal(lines.filter((line) => /uses Poisonous Spittle/.test(line)).length, 2, lines.join('\n'));
});

test('V02 control: "replace one attack" still gives up one attack only', () => {
  // Gladiator p.289: "The gladiator makes three Spear attacks. It can replace one attack with a use of Shield Bash."
  const parts = routineParts('Gladiator');
  assert.ok(parts.some((p) => /Shield Bash x1/.test(p)), parts.join(' | '));
  assert.ok(!parts.some((p) => /Shield Bash x[23]/.test(p)), parts.join(' | '));
});

test('V03 "requiring no Somatic or Material components" leaves a spell its Verbal component only', () => {
  // Guardian Naga p.296 and Spirit Naga p.329: "requiring no Somatic or Material components". Flame Strike is V, S, M.
  for (const [monster, spell] of [['Guardian Naga', 'Flame Strike'], ['Guardian Naga', 'Cure Wounds'], ['Spirit Naga', 'Hold Person'], ['Spirit Naga', 'Lightning Bolt']] as const) {
    const a = action(monster, spell);
    assert.equal(a.somatic, false, `${monster} ${spell}`);
    assert.equal(a.verbal, true, `${monster} ${spell}`);
    assert.equal(a.components, true, `${monster} ${spell}`);
  }
});

test('V03 controls: "no Material components" keeps Somatic, "no spell components" keeps none', () => {
  // Night Hag p.311: "requiring no Material components". Magic Missile is V, S.
  const missile = action('Night Hag', 'Magic Missile');
  assert.equal(missile.somatic, true);
  assert.equal(missile.verbal, true);
  // Couatl p.277: "requiring no spell components".
  const couatl = block('Couatl').options.find((o) => o.action.spell)!.action;
  assert.deepEqual([couatl.verbal, couatl.somatic, couatl.components], [false, false, false]);
});

test('V04 Hypnotic Pattern does nothing to a creature that cannot see the pattern', () => {
  // p.141: "Each creature in the area who can see the pattern must succeed on a Wisdom saving throw or have the Charmed
  // condition for the duration."
  const incubus = block('Incubus'), foe = tank(), pattern = action('Incubus', 'Hypnotic Pattern');
  assert.equal((pattern as { targetMustSee?: true }).targetMustSee, true);
  const a = e.initState(incubus), sighted = e.initState(foe), blind = e.initState(foe);
  e.applyRiders(blind, foe, a, [{ condition: 'blinded', duration: 'permanent' }], 0, false, rolls(0), log());
  assert.equal(e.actionTargetable(pattern, incubus, foe, 30, sighted, a), true);
  assert.equal(e.actionTargetable(pattern, incubus, foe, 30, blind, a), false);
  // Blindsight is sight enough for the engine's other gates, and here too.
  assert.equal(e.actionTargetable(pattern, incubus, tank({ blindsight: 10 }), 30, blind, a), true);
});

test('V04 control: a spell with no such clause still takes a Blinded target', () => {
  // Hold Person p.141: "Choose a Humanoid that you can see within range" is the caster's sight, not the target's.
  const naga = block('Spirit Naga'), foe = tank(), hold = action('Spirit Naga', 'Hold Person');
  assert.equal((hold as { targetMustSee?: true }).targetMustSee, undefined);
  const a = e.initState(naga), blind = e.initState(foe);
  e.applyRiders(blind, foe, a, [{ condition: 'blinded', duration: 'permanent' }], 0, false, rolls(0), log());
  assert.equal(e.actionTargetable(hold, naga, foe, 30, blind, a), true);
});

test('V08 True Seeing is compiled for the Guardian Naga with the spell\'s 120-foot Truesight', () => {
  // p.296: "1/Day Each: Clairvoyance, Cure Wounds (level 6 version), Flame Strike (level 6 version), Geas, True Seeing".
  // p.171: "For the duration, the willing creature you touch has Truesight with a range of 120 feet." Duration 1 hour.
  const a = action('Guardian Naga', 'True Seeing') as { kind: string; truesight: number; concentration: boolean };
  assert.equal(a.kind, 'selfbuff');
  assert.equal(a.truesight, 120);
  assert.equal(a.concentration, false);
  assert.equal((option('Guardian Naga', 'True Seeing').uses as { max: number }).max, 1);
  assert.deepEqual(block('Guardian Naga').skipped.filter((s) => s.name === 'True Seeing'), []);
});

test('V08 against an Invisible Stalker the naga casts True Seeing and then sees it', () => {
  // Invisible Stalker p.301: "The stalker has the Invisible condition." Truesight p.190 sees Invisible creatures.
  const naga = block('Guardian Naga'), stalker = block('Invisible Stalker');
  const a = e.initState(naga), d = e.initState(stalker);
  assert.equal(e.canSee(naga, d, a, 30), false);
  // Poisonous Spittle needs "one creature the naga can see": not usable yet.
  assert.equal(e.actionTargetable(action('Guardian Naga', 'Poisonous Spittle'), naga, stalker, 30, d, a), false);
  // Its first choice is Flame Strike, an area that needs no sight (1/Day); with that spent it casts True Seeing.
  const first = log(), lines = log();
  e.takeTurn([naga, stalker], [a, d], 0, rolls(0.5), at(30), first, e.createPairEvaluator(naga, stalker, true), false);
  assert.ok(first.lines.some((line) => /uses Flame Strike/.test(line)), first.lines.join('\n'));
  e.takeTurn([naga, stalker], [a, d], 0, rolls(0.5), at(30), lines, e.createPairEvaluator(naga, stalker, true), false);
  assert.ok(lines.lines.some((line) => /uses True Seeing/.test(line)), lines.lines.join('\n'));
  assert.equal(e.canSee(naga, d, a, 30), true);
  assert.equal(e.canSee(naga, d, a, 125), false); // beyond 120 feet
  assert.equal(e.actionTargetable(action('Guardian Naga', 'Poisonous Spittle'), naga, stalker, 30, d, a), true);
  // 1/Day, and nothing to gain while it lasts.
  const again = log();
  e.takeTurn([naga, stalker], [a, d], 0, rolls(0.5), at(30), again, e.createPairEvaluator(naga, stalker, true), false);
  assert.ok(!again.lines.some((line) => /uses True Seeing/.test(line)), again.lines.join('\n'));
});

test('V08 control: against a foe it already sees the naga does not cast True Seeing', () => {
  const { lines } = turnOf(block('Guardian Naga'), tank(), 30);
  assert.ok(!lines.some((line) => /True Seeing/.test(line)), lines.join('\n'));
});

test('V07 the Night Hag casts neither spell that Nightmare Haunting only names', () => {
  // p.311: "The spell fails and is wasted if the target is under the effect of the Protection from Evil and Good spell
  // or within a Magic Circle spell." Her Spellcasting lists Detect Magic, Etherealness, Magic Missile, Phantasmal
  // Killer and Plane Shift; Nightmare Haunting casts Dream.
  const hag = block('Night Hag'), named = [...hag.options.map((o) => o.name), ...hag.skipped.map((s) => s.name)];
  assert.ok(!named.includes('Protection from Evil and Good'), named.join(', '));
  assert.ok(!named.includes('Magic Circle'), named.join(', '));
  // Control: the spell the entry does cast is still read (and skipped: its casting time is 1 minute).
  assert.ok(hag.skipped.some((s) => s.name === 'Dream'));
});
