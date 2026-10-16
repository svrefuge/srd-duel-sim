// Tactics against regenerators, Legendary Resistance, Fear and unseen foes, and the pricing of Concentration buffs
// and daily spells. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding
// id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { fight, FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
const logOf = (a: string, b: string, scenario: 'max30' | 'max120' | 'max600', seed: number) => fight(block(a), block(b), seed, true, scenario);
const count = (lines: string[], text: string) => lines.filter((line) => line.includes(text)).length;
const round = (lines: string[], n: number) => lines.slice(lines.indexOf(`Round ${n}`), lines.indexOf(`Round ${n + 1}`) < 0 ? undefined : lines.indexOf(`Round ${n + 1}`));
const lines = () => new FightLog(true);

/** One turn of `name` against a Mage, with `name` under the Fear spell and `ground` feet away in a 30-foot arena. */
function fearedTurn(name: string, ground: number) {
  const user = block(name), foe = block('Mage'), a = e.initState(user), d = e.initState(foe), out = lines();
  a.conditions.push({ name: 'fearSpell', duration: 'permanent', source: 1, appliedTurn: 0 } as any);
  const engagement = { ...e.startingEngagement('max30'), distance: ground, ground };
  e.takeTurn([user, foe], [a, d], 0, () => 0.5, engagement, out, e.createPairEvaluator(user, foe, true), true);
  return { log: out.lines as string[], max: engagement.maxDistance };
}

test('BS01 a Legendary Resistance is spent on a failed save against Command', () => {
  // p331, Tarrasque: "Legendary Resistance (6/Day). If the tarrasque fails a saving throw, it can choose to succeed
  // instead." p116, Command (Grovel): "The target has the Prone condition and then ends its turn": the whole turn, for a Tarrasque a
  // Bite, two Claws, a Tail and its Legendary Actions. Before, it grovelled four times in eight rounds with 6 unspent.
  const log = logOf('Ancient Red Dragon', 'Tarrasque', 'max30', 2).log;
  assert.ok(count(log, 'Tarrasque uses Legendary Resistance') > 0);
  assert.equal(count(log, 'Tarrasque obeys Command'), 0);
});

test('BS01 control: a creature with no Legendary Resistance still obeys', () => {
  const log = logOf('Ancient Red Dragon', 'Storm Giant', 'max30', 2).log;
  assert.equal(count(log, 'Storm Giant uses Legendary Resistance'), 0);
  assert.ok(count(log, 'Storm Giant obeys Command') > 0);
});

test('BS02 a creature under Fear with nowhere to move has its turn', () => {
  // p130, Fear: "A Frightened creature takes the Dash action and moves away from you by the safest route on each of
  // its turns unless there is nowhere to move." Against the arena wall the Dash is not taken.
  const cornered = fearedTurn('Storm Giant', 30);
  assert.equal(cornered.max, 30);
  assert.equal(count(cornered.log, 'flees in fear'), 0);
  assert.ok(count(cornered.log, 'Storm Giant uses') > 0, cornered.log.join(' / '));
});

test('BS02 control: with room behind it, it Dashes away and does nothing else', () => {
  const free = fearedTurn('Storm Giant', 10);
  assert.equal(count(free.log, 'flees in fear'), 1);
  assert.equal(count(free.log, 'Storm Giant uses'), 0);
});

test('BS03 a breather does not leave an adjacent foe it is about to kill', () => {
  // Young Red Dragon (p318) Fire Breath: 30-foot Cone, Dex DC 17, 56 (16d6), half on a success. Behir on 23 hit
  // points dies to the half. Before (max600, seed 3, round 4) the dragon on 18 flew off to breathe and the Behir's
  // opportunity attack killed it.
  const trace = logOf('Young Red Dragon', 'Behir', 'max600', 3);
  assert.equal(count(trace.log, 'Behir makes an opportunity attack'), 0);
  assert.equal(trace.winner, 0);
});

test('BS03 control: a ranged creature still backs away from a healthy foe', () => {
  const log = logOf('Scout', 'Ogre', 'max600', 2).log;
  assert.ok(round(log, 1).includes('Scout moves (30 ft -> 60 ft)'));
});

test('BS04 a Roper does not step back from a creature its own Reel brings back', () => {
  // Roper (p320) Multiattack: "two Tentacle attacks, uses Reel, and makes two Bite attacks"; Reel: "pulls each creature
  // Grappled by it up to 30 feet straight toward it". Before (max600, seed 1, round 2): Gargoyle opportunity attack,
  // "Roper moves (5 ft -> 10 ft)", "Roper reels Gargoyle from 10 to 5 ft".
  for (const [foe, seed] of [['Gargoyle', 1], ['Owlbear', 3]] as const) {
    const log = logOf('Roper', foe, 'max600', seed).log;
    assert.equal(count(log, 'makes an opportunity attack'), 0, foe);
    assert.equal(count(log, 'Roper moves (5 ft -> 10 ft)'), 0, foe);
  }
});

test('BS05 a reach creature does not step back from a foe that teleports to it', () => {
  // Sphinx of Lore (p328) Arcane Prowl (Legendary Action): "teleports up to 30 feet ... and makes one Claw attack".
  // Before (max30, seeds 1 to 3) the Aboleth stepped from 5 to 10 feet each round and took an opportunity attack.
  for (const seed of [1, 2, 3]) assert.equal(count(logOf('Aboleth', 'Sphinx of Lore', 'max30', seed).log, 'Sphinx of Lore makes an opportunity attack'), 0);
});

test('BS06 a flier does not climb to a height the foe still reaches', () => {
  // p182, Flying: "you fall if you have the Incapacitated or Prone condition or your Fly Speed is reduced to 0",
  // unless you can hover. A Huge snake's reach covers a Griffon 20 feet up. Before (max30, seed 3): "[altitude 0 ft to 20 ft]",
  // "Griffon gains grappled", "Griffon falls 20 ft", 11 damage.
  const log = logOf('Griffon', 'Giant Constrictor Snake', 'max30', 3).log;
  assert.equal(count(log, 'altitude'), 0);
  assert.equal(count(log, 'Griffon falls'), 0);
});

test('BS06 control: a flier still climbs out of a foe\'s reach', () => {
  assert.ok(round(logOf('Manticore', 'Ogre', 'max30', 1).log, 1).some((line) => line.includes('[altitude 0 ft to 40 ft]')));
});

test('BS07 a heal with daily uses waits for a wound its own size', () => {
  // Solar (p316) Divine Aid (3/Day): Cure Wounds, 4d8 + 10 = 28. Before (max30, seed 1): "regains 5 hp (297 hp)".
  const heals = logOf('Solar', 'Lich', 'max30', 2).log.filter((line) => line.startsWith('Solar regains'));
  assert.ok(heals.length > 0);
  for (const line of heals) {
    const [, gained, after] = line.match(/regains (\d+) hp \((\d+) hp\)/)!.map(Number);
    assert.ok(after - gained <= 297 - 28, line);
  }
});

test('BS07 control: a wound of the heal\'s size is healed', () => {
  const user = block('Solar'), foe = block('Lich'), a = e.initState(user), d = e.initState(foe), evaluator = e.createPairEvaluator(user, foe, true);
  const cure = user.options.find((o) => o.name === 'Cure Wounds')!.action;
  a.hp = a.maxHp - 27;
  assert.equal(e.dynamicEv(cure, user, foe, d, a, 0, 5, evaluator, 'bonus'), 0);
  a.hp = a.maxHp - 28;
  assert.ok(e.dynamicEv(cure, user, foe, d, a, 0, 5, evaluator, 'bonus') > 0);
});

test('BS08 a swallower Swallows a regenerator it has dropped', () => {
  // Troll (p333) Regeneration: "If the troll takes Acid or Fire damage, this trait doesn't function on the troll's next
  // turn. The troll dies only if it starts its turn with 0 Hit Points and doesn't regenerate." Behir Swallow (p263):
  // "21 (6d6) Acid damage at the start of each of the behir's turns". Before (max30, seed 1): ten rounds of
  // "Troll regenerates back up (15 hp)", no Swallow, and the CR 11 Behir lost.
  const log = logOf('Behir', 'Troll', 'max30', 1).log;
  // (The Behir Constricts and Swallows at once, before the Troll is down; the Acid still finishes it.)
  assert.ok(log.includes('Behir uses bonus action Swallow'));
  assert.equal(log.filter((line) => line.startsWith('Troll regenerates back up')).length, 0);
  assert.equal(log.at(-1), 'Troll fails to regenerate and dies');
});

test('BS08 control: Swallow is worth nothing against an unconscious creature that does not regenerate', () => {
  const user = block('Behir'), swallow = user.options.find((o) => o.name === 'Swallow')!.action;
  const price = (name: string) => {
    const foe = block(name), a = e.initState(user), d = e.initState(foe);
    d.conditions.push({ name: 'unconscious', duration: 'permanent', source: 0, appliedTurn: 0 } as any);
    d.conditions.push({ name: 'grappled', duration: 'untilEscape', source: 0, appliedTurn: 0 } as any);
    return e.dynamicEv(swallow, user, foe, d, a, 0, 5, e.createPairEvaluator(user, foe, true), 'bonus');
  };
  assert.equal(price('Ogre'), 0);
  assert.ok(price('Troll') > 0);
});

test('BS09 a daily fire spell is kept for the turn that finishes a regenerator', () => {
  // Mage (p305): Fireball 2/Day, 8d6 Fire; Arcane Burst is Force. Before (max30, seed 1): Fireball in rounds 1 and 2 at
  // a Troll on 94, three "regenerates back up", Mage dead in round 5. Of 2,000 fights the Mage won none.
  const trace = logOf('Mage', 'Troll', 'max30', 1);
  assert.equal(count(round(trace.log, 1), 'Mage uses Fireball') + count(round(trace.log, 2), 'Mage uses Fireball'), 0);
  assert.ok(trace.log.includes('Troll fails to regenerate and dies'));
  assert.equal(trace.winner, 0);
});

test('BS09 control: a recharging fire breath keeps its priority against a Troll at full hit points', () => {
  // Half the Troll's 94 hit points is the priority a suppressor carries. The Mage's Fireball (2/Day) does not have it at
  // 94; the dragon's Fire Breath (Recharge 5-6) does.
  const price = (name: string, option: string) => {
    const user = block(name), foe = block('Troll'), a = e.initState(user), d = e.initState(foe);
    return e.dynamicEv(user.options.find((o) => o.name === option)!.action, user, foe, d, a, 0, 10, e.createPairEvaluator(user, foe, true));
  };
  assert.ok(price('Young Red Dragon', 'Fire Breath') > 47);
  assert.ok(price('Mage', 'Fireball') < 47 / 2);
});

test('BS11 a reach attacker that knocks Prone ends beside its foe', () => {
  // p186, Prone: "attack rolls against you have Advantage if the attacker is within 5 feet of you. Otherwise, that
  // attack roll has Disadvantage." Mammoth (p357) Trample (Bonus Action) needs a Prone creature within 5 feet.
  // Before (max120, seed 1): "Mammoth moves (30 ft -> 10 ft)", two Gores, no Trample.
  const first = round(logOf('Mammoth', 'Triceratops', 'max120', 1).log, 1);
  assert.ok(first.includes('Mammoth moves (30 ft -> 5 ft)') && first.includes('Mammoth uses bonus action Trample'), first.join(' / '));
});

test('BS11 control: a reach attacker with no knock-down holds at its reach', () => {
  assert.ok(round(logOf('Troll', 'Giant Crocodile', 'max30', 3).log, 1).includes('Troll moves (30 ft -> 10 ft)'));
});

test('BS13 Entangle does not reach a creature in the air', () => {
  // p128, Entangle: "Grasping plants sprout from the ground in a 20-foot square within range. ... Each creature ... in
  // the area". Before (max30, seed 1): the Unicorn dropped Dispel Evil and Good to cast it at an Oni 20 feet up.
  for (const name of ['Unicorn', 'Druid', 'Dryad']) {
    assert.equal((block(name).options.find((o) => o.name === 'Entangle')!.action as any).targetGroundOnly, true, name);
  }
  assert.equal(count(logOf('Unicorn', 'Oni', 'max30', 1).log, 'Unicorn uses Entangle'), 0);
});

test('BS13 control: Entangle can be cast at a creature on the ground', () => {
  const user = block('Unicorn'), foe = block('Oni'), a = e.initState(user), d = e.initState(foe);
  const entangle = user.options.find((o) => o.name === 'Entangle')!.action;
  assert.equal(e.actionTargetable(entangle, user, foe, 30, d, a), true);
  d.height = 20;
  assert.equal(e.actionTargetable(entangle, user, foe, 30, d, a), false);
});

test('BS14 attack rolls at an unseen foe are priced at Disadvantage', () => {
  // p184, Invisible: "Attack rolls against you have Disadvantage". Mage against an Invisible Oni (AC 17, Dex +3):
  // Arcane Burst 3 x 0.25 x 16.5 = 12.4 at Disadvantage; Fireball (DC 14) 0.5 x 28 + 0.5 x 14 = 21. Before (arena,
  // seed 1): nine Bursts, all missed, both Fireballs unspent.
  const first = round(logOf('Oni', 'Mage', 'max30', 1).log, 1);
  assert.ok(first.includes('Oni becomes invisible') && first.includes('Mage uses Fireball'), first.join(' / '));
});

test('BS14 control: against a foe it sees, the Mage keeps Arcane Burst', () => {
  // Stone Giant AC 17, Dex +2: Burst 3 x 0.5 x 16.5 = 24.8 against Fireball 28 x (0.55 + 0.45 / 2) = 21.7.
  assert.ok(round(logOf('Mage', 'Stone Giant', 'max30', 1).log, 1).includes('Mage uses Arcane Burst'));
});

/** `user`'s price for its option against `foe`, and the foe's best routine against it, after `prepare` has set the states. */
function priced(userName: string, foeName: string, optionName: string, distance: number, prepare?: (a: any, d: any) => void) {
  const user = block(userName), foe = block(foeName), a = e.initState(user), d = e.initState(foe), evaluator = e.createPairEvaluator(user, foe, true);
  prepare?.(a, d);
  const option = user.options.find((o) => o.name === optionName)!;
  return { ev: e.dynamicEv(option.action, user, foe, d, a, 0, distance, evaluator, option.timing as any), foeRoutine: evaluator.bestRoutineEvAtDistance(foe, user, distance, false) };
}

test('BS12 a Concentration buff is priced for the attacks it lasts through', () => {
  // p179, Concentration: damage forces a Constitution save (DC 10 or half the damage). Archmage (p305): four Arcane
  // Bursts a turn. Each is taken to hit half the time; the Mage (Con +0) fails DC 10 on 9 of 20: 0.225 a swing, so
  // (1 + 0.775 + 0.775^2 + 0.775^3) / 4 = 0.71 of the routine is hampered, not all of it.
  const four = priced('Mage', 'Archmage', 'Invisibility', 30);
  assert.ok(Math.abs(four.ev / (four.foeRoutine * 0.35) - (1 + 0.775 + 0.775 ** 2 + 0.775 ** 3) / 4) < 1e-9);
  // Before (max30, seeds 1 and 2): Invisibility twice, lost to the first hit each time, no damage dealt.
  assert.equal(count(logOf('Mage', 'Archmage', 'max30', 1).log, 'Mage uses Invisibility'), 0);
});

test('BS12 control: against one attack a turn the buff keeps its whole price', () => {
  const one = priced('Mage', 'Ogre', 'Invisibility', 5);
  assert.ok(Math.abs(one.ev - one.foeRoutine * 0.35) < 1e-9);
});

test('BS15 an instant-death save is not the top price against a Legendary Resistance', () => {
  // Solar (p316) Slaying Bow: "If the target has 100 Hit Points or fewer, it dies" on a failed save. Balor (p261):
  // Legendary Resistance (3/Day), and the engine always spends one on such a save. Before (max30, seed 1, round 4):
  // Balor on 22, "Solar uses Slaying Bow", "Balor uses Legendary Resistance", where a second Flying Sword killed.
  const resisted = priced('Solar', 'Balor', 'Slaying Bow', 30, (_a, d) => { d.hp = 76; });
  assert.ok(resisted.ev < block('Balor').hpAvg);
  for (const seed of [1, 2]) assert.equal(count(logOf('Solar', 'Balor', 'max30', seed).log, 'Solar uses Slaying Bow'), 0);
});

test('BS15 control: with no resistance left, or none printed, the Bow finishes', () => {
  assert.equal(priced('Solar', 'Balor', 'Slaying Bow', 30, (_a, d) => { d.hp = 76; d.legendaryResistances = 0; }).ev, block('Balor').hpAvg * 100);
  assert.equal(priced('Solar', 'Ogre', 'Slaying Bow', 30).ev, block('Ogre').hpAvg * 100);
});

test('BS18 the absorption line never prints hit points below 0', () => {
  // Before (Flesh Golem v Storm Giant, max30, seed 1, round 9): "absorbs the damage and regains 10 hp (-15 hp)".
  const absorbs = logOf('Flesh Golem', 'Storm Giant', 'max30', 1).log.filter((line) => line.includes('absorbs the damage and regains'));
  assert.ok(absorbs.length > 0 && absorbs.every((line) => !line.includes('(-')), absorbs.join(' / '));
});

test('BS23 damage that can never finish a regenerator is a tenth of its price', () => {
  // Troll (p333): "The troll dies only if it starts its turn with 0 Hit Points and doesn't regenerate." The Mage's
  // only Fire is Fireball (2/Day): with both spent, Arcane Burst postpones and nothing more.
  const fireball = block('Mage').options.findIndex((o) => o.name === 'Fireball');
  const full = priced('Mage', 'Troll', 'Arcane Burst', 30);
  const spent = priced('Mage', 'Troll', 'Arcane Burst', 30, (a) => { a.perDay.set((block('Mage').options[fireball].uses as any).pool ?? fireball, 0); });
  assert.ok(full.ev > 0 && Math.abs(spent.ev / full.ev - 0.1) < 1e-9);
  // Archmage (p305) has no Fire or Acid. Before: 0 wins and 0 draws of 2,000 in the arena, beside the Troll all fight.
  // Now it casts Fly (the Troll has no ranged attack) and the fight is a draw.
  const trace = logOf('Archmage', 'Troll', 'max30', 1);
  assert.equal(count(trace.log, 'Archmage uses Fly'), 1);
  assert.equal(trace.winner, -1);
});

test('BS24 a second Concentration spell is worth what it adds over the buff it ends', () => {
  // p179: "You lose Concentration on an effect the moment you start casting a spell that requires Concentration". Unicorn (p334)
  // against an Oni (a Fiend) on the ground: Entangle is worth 4.28 with nothing held, and less than the ward of Dispel
  // Evil and Good (0.35 of the Oni's routine) once that is up.
  const user = block('Unicorn'), foe = block('Oni'), a = e.initState(user), d = e.initState(foe), evaluator = e.createPairEvaluator(user, foe, true);
  const entangle = user.options.find((o) => o.name === 'Entangle')!.action, ward = user.options.find((o) => o.name === 'Dispel Evil and Good')!.action;
  const free = e.dynamicEv(entangle, user, foe, d, a, 0, 30, evaluator);
  e.resolveAction(user, foe, a, d, ward, () => 0.5, 0, 30, new FightLog(true));
  assert.ok(a.concentrating && free > 0);
  assert.equal(e.dynamicEv(entangle, user, foe, d, a, 0, 30, evaluator), 0);
});
