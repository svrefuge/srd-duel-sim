import assert from "node:assert/strict";
import test from "node:test";
import { FightLog, saveRollForTest as csa, mythicResetRestoresForTest as mrr, runUpFirstAttackForTest } from "../src/engine/fight.ts";
import { parseAction } from "../src/parse/actions.ts";
import { compileAllDetailed } from "../src/compile.ts";
import type { ActionOption, CombatStatblock, CombatAction, AttackAction, SaveAction, Rider } from "../src/types.ts";
function makeBlock(partial: Partial<CombatStatblock> & { name: string }): CombatStatblock {
  const options: ActionOption[] = partial.options || [{
    name: "Slam",
    sourceText: "",
    sourceRef: "test",
    action: { kind: "attack", toHit: 4, damage: [{ dice: { n: 1, d: 6, mod: 2 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
    uses: { t: "atWill" },
    timing: "action",
  }];
  return {
    id: `T:${partial.name}`,
    source: "T",
    cr: 1,
    ac: 12,
    hpAvg: 20,
    abilityMods: { str: 2, dex: 1, con: 1, int: 0, wis: 0, cha: 0 },
    saves: {},
    skills: {},
    initiativeBonus: 1,
    immune: [],
    resist: [],
    vulnerable: [],
    qualifiedDefenses: [],
    conditionImmune: [],
    speed: 30,
    size: 2,
    creatureType: "humanoid",
    creatureTags: [],
    truesight: false,
    flyby: false,
    reaction: undefined,
    undeadFortitude: false,
    magicResistance: false,
    legendaryResistances: 0,
    legendaryOptions: [],
    regeneration: undefined,
    routines: options.filter((o) => o.timing === "action").map((o, i) => ({ name: o.name, parts: [{ optionIdx: i, count: 1 }] })),
    skipped: [],
    ...partial,
    options,
  };
}
const slayHit = (amount: number, slay: AttackAction["slaysOnZeroHp"] | null = {}): AttackAction => ({
  kind: "attack", toHit: 30, damage: [{ dice: { n: 0, d: 1, mod: amount }, type: "necrotic" }], riders: [], magical: false,
  melee: true, ranged: false, reach: 5, range: 5, ...(slay ? { slaysOnZeroHp: slay } : {}),
});

const drainOption = (action: CombatAction): ActionOption => ({ name: "Drain", sourceText: "", sourceRef: "test", action, uses: { t: "atWill" }, timing: "action" });
const trollRule = { regeneration: { amount: 20, suppressedBy: ["fire"], deathRule: true } } as Partial<CombatStatblock>;
const oaaFlat = (n: number, extra: Record<string, unknown> = {}) => ({ dice: { n: 0, d: 1, mod: n }, type: "piercing", ...extra });
// ---- Undead Fortitude under a slay ----
// Ruling: a successful save leaves the holder up under a slay. "If damage
// reduces the zombie to 0 Hit Points, it makes a Constitution saving throw (DC 5 plus the damage taken) unless the damage
// is Radiant or from a Critical Hit. On a successful save, the zombie drops to 1 Hit Point instead": the save is rolled
// before the slay (an effect that kills a target it reduces to 0 Hit Points) reads the 0. The packets deal a fixed 10.
const ufsDuel = (action: CombatAction, hp: number, defenderExtra: Partial<CombatStatblock>, opts: { roll?: number; setup?: (d: ReturnType<typeof csa.initState>) => void } = {}) => {
  const attacker = makeBlock({ name: "Slayer", options: [drainOption(action)] });
  const defender = makeBlock({ name: "Target", hpAvg: 200, ...defenderExtra });
  const aState = csa.initState(attacker), dState = csa.initState(defender);
  dState.hp = hp;
  opts.setup?.(dState);
  const log = new FightLog(true);
  let dice = 0;
  csa.resolveAction(attacker, defender, aState, dState, action, () => { dice++; return opts.roll ?? 0.5; }, 0, 5, log);
  return { defender, dState, log: log.lines, dice };
};
const ufsSure = { undeadFortitude: true, saves: { con: 40 } } as Partial<CombatStatblock>;
const ufsHopeless = { undeadFortitude: true, saves: { con: -40 } } as Partial<CombatStatblock>;
const UFS_HOLDS = "Target holds on (Undead Fortitude)";
const UFS_DIES = "Target dies (reduced to 0 hit points by this damage)";

test("Undead Fortitude under a slay: a made save leaves the holder at 1 hit point under a slay; the slay has no trigger", () => {
  const r = ufsDuel(slayHit(10), 10, ufsSure);
  assert.equal(r.dState.hp, 1, r.log.join("\n"));
  assert.equal(r.dState.slain, false);
  assert.ok(r.log.includes(UFS_HOLDS), r.log.join("\n"));
  assert.ok(!r.log.includes(UFS_DIES), r.log.join("\n"));
  // The packet's whole damage sets the DC, as for any packet: 30 damage from 10 hit points is still held by +40.
  const big = ufsDuel(slayHit(30), 10, ufsSure);
  assert.equal(big.dState.hp, 1);
  assert.equal(big.dState.slain, false);
});

test("Undead Fortitude under a slay: a failed save leaves the holder at 0 and the slay kills; the save was rolled", () => {
  const r = ufsDuel(slayHit(10), 10, ufsHopeless);
  assert.equal(r.dState.slain, true, r.log.join("\n"));
  assert.ok(r.dState.hp <= 0);
  assert.ok(r.log.includes(UFS_DIES), r.log.join("\n"));
  assert.ok(!r.log.includes(UFS_HOLDS), r.log.join("\n"));
  // One more die than the same packet draws against a creature without the trait: the save.
  const plain = ufsDuel(slayHit(10), 10, {});
  assert.equal(plain.dState.slain, true);
  assert.equal(r.dice, plain.dice + 1);
  // A margin: +4 against DC 15 with a roll of 11 makes it exactly; +3 fails.
  assert.equal(ufsDuel(slayHit(10), 10, { undeadFortitude: true, saves: { con: 4 } }).dState.slain, false);
  assert.equal(ufsDuel(slayHit(10), 10, { undeadFortitude: true, saves: { con: 3 } }).dState.slain, true);
});

test("Undead Fortitude under a slay: a Radiant slay and a critical slay still kill with no save", () => {
  const beam: AttackAction = { ...slayHit(10), damage: [{ dice: { n: 0, d: 1, mod: 10 }, type: "radiant" }] };
  const radiant = ufsDuel(beam, 10, ufsSure);
  const radiantPlain = ufsDuel(beam, 10, {});
  assert.equal(radiant.dState.slain, true, radiant.log.join("\n"));
  assert.ok(radiant.log.includes(UFS_DIES) && !radiant.log.includes(UFS_HOLDS), radiant.log.join("\n"));
  assert.equal(radiant.dice, radiantPlain.dice);
  // A Radiant clause beside another type bypasses the trait too (the trait's test reads every clause).
  const mixed: AttackAction = { ...slayHit(10), damage: [{ dice: { n: 0, d: 1, mod: 5 }, type: "fire" }, { dice: { n: 0, d: 1, mod: 5 }, type: "radiant" }] };
  assert.equal(ufsDuel(mixed, 10, ufsSure).dState.slain, true);
  // A natural 20 (the rng at its top) is a critical hit.
  const crit = ufsDuel(slayHit(10), 10, ufsSure, { roll: 0.999 });
  const critPlain = ufsDuel(slayHit(10), 10, {}, { roll: 0.999 });
  // (With a certain save, only the critical keeps the trait from holding: `slain` below shows the hit was one.)
  assert.equal(crit.dState.slain, true, crit.log.join("\n"));
  assert.ok(!crit.log.includes(UFS_HOLDS), crit.log.join("\n"));
  assert.equal(crit.dice, critPlain.dice);
});

test("Undead Fortitude under a slay: controls: a slay on a non-holder, a non-slay packet on a holder, temporary hit points, a packet short of 0", () => {
  const plain = ufsDuel(slayHit(10), 10, {});
  assert.equal(plain.dState.slain, true);
  assert.ok(plain.log.includes(UFS_DIES));
  const ordinary = ufsDuel(slayHit(10, null), 10, ufsSure);
  assert.equal(ordinary.dState.hp, 1);
  assert.ok(ordinary.log.includes(UFS_HOLDS));
  const ordinaryFail = ufsDuel(slayHit(10, null), 10, ufsHopeless);
  assert.equal(ordinaryFail.dState.slain, false);
  assert.ok(ordinaryFail.dState.hp <= 0);
  // Temporary hit points absorb the packet: no hit point is lost, so neither the trait nor the slay has a trigger.
  const temp = ufsDuel(slayHit(10), 10, ufsHopeless, { setup: (d) => { d.tempHp = 10; } });
  const tempPlain = ufsDuel(slayHit(10), 10, {}, { setup: (d) => { d.tempHp = 10; } });
  assert.equal(temp.dState.hp, 10, temp.log.join("\n"));
  assert.equal(temp.dState.slain, false);
  assert.equal(temp.dice, tempPlain.dice);
  const short = ufsDuel(slayHit(10), 11, ufsHopeless);
  assert.equal(short.dState.hp, 1);
  assert.equal(short.dState.slain, false);
  assert.equal(short.dice, plain.dice);
  // The slay's own gates still apply before the trait matters: a type gate that misses the holder is no slay at all.
  const gated = ufsDuel(slayHit(10, { targetTypes: ["humanoid"] }), 10, { ...ufsHopeless, creatureType: "undead" });
  assert.equal(gated.dState.slain, false);
  assert.ok(gated.dState.hp <= 0);
});

test("Undead Fortitude under a slay: a death-rule regenerator with the trait: slain on a failed save, up on a made one; held at 0 it is not slain", () => {
  const lich = (con: number) => ({ undeadFortitude: true, saves: { con }, ...trollRule }) as Partial<CombatStatblock>;
  const failed = ufsDuel(slayHit(10), 10, lich(-40));
  assert.equal(failed.dState.slain, true, failed.log.join("\n"));
  assert.equal(mrr.isDown(failed.defender, failed.dState), true);
  const made = ufsDuel(slayHit(10), 10, lich(40));
  assert.equal(made.dState.hp, 1);
  assert.equal(mrr.isDown(made.defender, made.dState), false);
  // A holder already at 0 hit points is not slain by a further slay packet, and the trait's block, which has no
  // "was above 0" test, rolls again.
  const heldFail = ufsDuel(slayHit(10), 0, lich(-40));
  assert.equal(heldFail.dState.slain, false, heldFail.log.join("\n"));
  assert.ok(!heldFail.log.includes(UFS_DIES));
  assert.equal(mrr.isDown(heldFail.defender, heldFail.dState), false);
  const heldMade = ufsDuel(slayHit(10), 0, lich(40));
  assert.equal(heldMade.dState.slain, false);
  assert.equal(heldMade.dState.hp, 1);
});

test("Undead Fortitude under a slay: a random-branch slay on a holder rolls the save", () => {
  const rays: CombatAction = { kind: "random", branches: [slayHit(10)] };
  const made = ufsDuel(rays, 10, ufsSure);
  assert.equal(made.dState.hp, 1, made.log.join("\n"));
  assert.equal(made.dState.slain, false);
  const failed = ufsDuel(rays, 10, ufsHopeless);
  assert.equal(failed.dState.slain, true, failed.log.join("\n"));
  assert.ok(failed.log.includes(UFS_DIES));
});

// ---- run-up on the first attack (field-gated) ----
// "If the target is a Huge or smaller creature and the mammoth moved 20+ feet straight toward it immediately before the
// hit, the target has the Prone condition" (SRD Mammoth, Gore; a Multiattack of two Gores). Ruling: the phrase
// covers only the first attack after the approach. `requiresMovementImmediate` marks such a gate; a gate without it (the
// older "and then hits it … on the same turn") reads the whole turn's approach. State built directly; flat
// damage (5, and 7 more behind a 20-ft run-up), a to-hit no d20 can miss (40) or hit (-40) on an rng that rolls 11.
const ruf = runUpFirstAttackForTest;
const rufOpt = (name: string, immediate: boolean | undefined, toHit = 40, timing: "action" | "bonus" = "action"): ActionOption => {
  const gate = immediate === undefined ? undefined : { requiresMovement: 20, ...(immediate ? { requiresMovementImmediate: true } : {}) };
  return {
    name, sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing,
    action: {
      kind: "attack", toHit, melee: true, ranged: false, magical: false, reach: 5,
      damage: gate ? [oaaFlat(5), oaaFlat(7, gate)] : [oaaFlat(5)],
      riders: gate ? [{ condition: "prone", duration: "permanent", ...gate } as Rider] : [],
    } as AttackAction,
  };
};
const rufCharger = (options: ActionOption[], parts: { optionIdx: number; count: number }[], extra: Partial<CombatStatblock> = {}) =>
  makeBlock({ name: "Charger", hpAvg: 200, speed: 40, options, routines: [{ name: "Multiattack", parts }], ...extra });
const rufTarget = () => makeBlock({ name: "Target", hpAvg: 500, speed: 0, options: [], routines: [] });
const rufDuel = (a: CombatStatblock, distance: number) => {
  const b = rufTarget();
  const states: any = [ruf.initState(a), ruf.initState(b)];
  const engagement: any = { ...ruf.startingEngagement("max120"), distance, ground: distance };
  const log = new FightLog(true);
  const evaluator = ruf.createPairEvaluator(a, b, false);
  const rng = () => 0.5;
  return {
    a, b, states, engagement, log, evaluator, rng,
    turn: () => ruf.takeTurn([a, b], states, 0, rng, engagement, log, evaluator),
    prone: () => states[1].conditions.some((c: any) => c.name === "prone"),
    text: () => log.lines.join("\n"),
  };
};
const RUF_CLOSED = /Charger moves \(30 ft -> 5 ft\)/;

test("run-up on the first attack: the first attack after the approach carries the run-up and a second attack does not", () => {
  const duel = rufDuel(rufCharger([rufOpt("Gore", true)], [{ optionIdx: 0, count: 2 }]), 30);
  duel.turn();
  const text = duel.text();
  assert.match(text, RUF_CLOSED, `setup not reached: the charger did not close\n${text}`);
  assert.equal(text.split("Charger uses Gore").length - 1, 2, `setup not reached: two Gores\n${text}`);
  // 12 for the first Gore (5 and the run-up's 7), 5 for the second.
  assert.equal(duel.states[1].hp, 500 - 12 - 5, text);
  assert.ok(duel.prone(), `the first Gore's run-up did not knock the target Prone\n${text}`);
  assert.equal(duel.states[0].runUpSpent, 0, "the spend is zeroed with the run-up at the turn's end");
});

test("run-up on the first attack: a first attack that misses spends the run-up", () => {
  // Horn cannot hit; Gore cannot miss. Both print the immediate run-up.
  const duel = rufDuel(rufCharger([rufOpt("Horn", true, -40), rufOpt("Gore", true)], [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 1 }]), 30);
  duel.turn();
  const text = duel.text();
  assert.match(text, RUF_CLOSED, `setup not reached\n${text}`);
  assert.match(text, /Charger misses Target/, `setup not reached: the first attack did not miss\n${text}`);
  assert.equal(duel.states[1].hp, 500 - 5, `the attack after a miss carried the run-up\n${text}`);
  assert.ok(!duel.prone(), `the attack after a miss knocked the target Prone\n${text}`);
});

test("run-up on the first attack: a first attack by another option spends the run-up; an effect that is no attack does not", () => {
  // A Bite with no run-up clause, then the Gore.
  const bite = rufDuel(rufCharger([rufOpt("Bite", undefined), rufOpt("Gore", true)], [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 1 }]), 30);
  bite.turn();
  assert.match(bite.text(), RUF_CLOSED, `setup not reached\n${bite.text()}`);
  assert.equal(bite.states[1].hp, 500 - 5 - 5, `the Gore after a Bite carried the run-up\n${bite.text()}`);
  assert.ok(!bite.prone(), bite.text());
  // Negative control: a save effect before the Gore is not an attack, and the Gore is the first attack after the approach.
  const roar: ActionOption = {
    name: "Roar", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
    action: { kind: "save", ability: "wis", dc: 30, damage: [oaaFlat(3)], onSuccess: "half", riders: [], magical: false, range: 60 } as SaveAction,
  };
  const roared = rufDuel(rufCharger([roar, rufOpt("Gore", true)], [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 1 }]), 30);
  roared.turn();
  const text = roared.text();
  assert.match(text, RUF_CLOSED, `setup not reached\n${text}`);
  assert.match(text, /Charger uses Roar/, `setup not reached: no Roar\n${text}`);
  const roarDamage = 500 - 12 - roared.states[1].hp;
  assert.ok(roarDamage >= 1 && roarDamage <= 3, `the Gore after a save effect lost its run-up\n${text}`);
  assert.ok(roared.prone(), text);
});

test("run-up on the first attack: a gate without the flag still reads the whole turn's approach (the older print)", () => {
  const duel = rufDuel(rufCharger([rufOpt("Claw", false)], [{ optionIdx: 0, count: 2 }]), 30);
  duel.turn();
  const text = duel.text();
  assert.match(text, RUF_CLOSED, `setup not reached\n${text}`);
  assert.equal(duel.states[1].hp, 500 - 12 - 12, `an unflagged run-up was spent\n${text}`);
  // And after a first attack by another option.
  const mixed = rufDuel(rufCharger([rufOpt("Bite", undefined), rufOpt("Claw", false)], [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 1 }]), 30);
  mixed.turn();
  assert.equal(mixed.states[1].hp, 500 - 5 - 12, mixed.text());
});

test("run-up on the first attack: no approach, no run-up, flagged or not", () => {
  for (const immediate of [true, false]) {
    // Speed 5: no room to back off and come in again (B07 gives the back-off search the square a run-up asks for, and a
    // charger beside a foe with no opportunity attack takes it).
    const duel = rufDuel(rufCharger([rufOpt("Gore", immediate)], [{ optionIdx: 0, count: 2 }], { speed: 5 }), 5);
    duel.turn();
    assert.equal(duel.states[1].hp, 500 - 5 - 5, duel.text());
    assert.ok(!duel.prone(), duel.text());
  }
});

test("run-up on the first attack: a Legendary attack after the turn reads no run-up, and a later bonus attack none either", () => {
  // The Legendary Gore follows the foe's turn: the charger's own run-up ended with its turn, spent or not.
  const legendary = rufDuel(rufCharger([rufOpt("Gore", true)], [{ optionIdx: 0, count: 1 }], { legendaryOptions: [{ optionIdx: 0, count: 1 }] } as Partial<CombatStatblock>), 30);
  legendary.turn();
  assert.match(legendary.text(), RUF_CLOSED, `setup not reached\n${legendary.text()}`);
  assert.equal(legendary.states[1].hp, 500 - 12, legendary.text());
  legendary.states[1].conditions = [];
  ruf.legendaryStep([legendary.a, legendary.b], legendary.states, 1, legendary.rng, legendary.engagement, legendary.log, legendary.evaluator);
  const text = legendary.text();
  assert.match(text, /legendary/i, `setup not reached: no Legendary action\n${text}`);
  assert.equal(legendary.states[1].hp, 500 - 12 - 5, `the Legendary Gore read a run-up\n${text}`);
  assert.ok(!legendary.prone(), text);
  // A bonus-action attack after the routine's attack is a later attack of the turn.
  const bonus = rufDuel(rufCharger([rufOpt("Bite", undefined), rufOpt("Kick", true, 40, "bonus")], [{ optionIdx: 0, count: 1 }]), 30);
  bonus.turn();
  const bonusText = bonus.text();
  assert.match(bonusText, /Charger uses bonus action Kick/, `setup not reached: no bonus attack\n${bonusText}`);
  assert.equal(bonus.states[1].hp, 500 - 5 - 5, `the bonus attack after an attack carried the run-up\n${bonusText}`);
});

test("run-up on the first attack: the chooser prices the first swing with the run-up and later attacks without", () => {
  const price = (options: ActionOption[], parts: { optionIdx: number; count: number }[], runUp?: number) => {
    const a = rufCharger(options, parts);
    const duel = rufDuel(a, 5);
    const ev = (idx: number, run?: number) => ruf.dynamicEv(a.options[idx].action, a, duel.b, duel.states[1], duel.states[0], 0, 5, duel.evaluator, "action", run);
    return { routine: ruf.bestUsableRoutinesAtDistance(a, duel.b, duel.states[0], duel.states[1], 0, 5, duel.evaluator, runUp).any.ev, ev, a, duel };
  };
  const near = (x: number, y: number, what: string) => assert.ok(Math.abs(x - y) < 1e-9, `${what}: ${x} vs ${y}`);
  const twoGores = [{ optionIdx: 0, count: 2 }];
  // Two flagged Gores at a square that gives the run-up: the first with it, the second without.
  const flagged = price([rufOpt("Gore", true)], twoGores, 25);
  assert.ok(flagged.ev(0, 25) > flagged.ev(0, 0), "setup: the run-up is worth something");
  near(flagged.routine, flagged.ev(0, 25) + flagged.ev(0, 0), "two flagged Gores");
  // Negative control: the same routine unflagged prices both swings with the run-up (less the repeated rider).
  const plain = price([rufOpt("Claw", false)], twoGores, 25);
  near(plain.routine, plain.ev(0, 25) * plain.duel.evaluator.repeatFactor(plain.a.options[0].action, plain.a, plain.duel.b, 2, undefined, 25), "two unflagged Claws");
  assert.ok(plain.routine > flagged.routine + 1, `the flag did not lower the price: ${plain.routine} vs ${flagged.routine}`);
  // A single flagged swing keeps its price exactly (the single-attack carriers).
  const single = price([rufOpt("Gore", true)], [{ optionIdx: 0, count: 1 }], 25);
  assert.equal(single.routine, single.ev(0, 25));
  // A flagged part after an attack part is priced without the run-up; after a part that is no attack, with it.
  const afterBite = price([rufOpt("Bite", undefined), rufOpt("Gore", true)], [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 1 }], 25);
  near(afterBite.routine, afterBite.ev(0, 25) + afterBite.ev(1, 0), "a Gore after a Bite");
  // No square (the static coin flip): unchanged, the same as the unflagged twin's.
  assert.equal(price([rufOpt("Gore", true)], twoGores).routine, price([rufOpt("Gore", false)], twoGores).routine);
  // No run-up at the square: both swings plain, flagged or not.
  assert.equal(price([rufOpt("Gore", true)], twoGores, 0).routine, price([rufOpt("Gore", false)], twoGores, 0).routine);
});

test("run-up on the first attack: Legendary Resistance is not spent for a follow-on rider whose run-up an earlier attack spent", () => {
  // Poisoned (a save, no gate) with a follow-on Stunned behind the run-up: the policy spends Legendary Resistance on the
  // Poisoned save only where the Stunned could land (`couldLand`).
  const gore = (): ActionOption => {
    const option = rufOpt("Gore", undefined);
    const save = { ability: "con", dc: 30 };
    (option.action as AttackAction).riders = [
      { condition: "poisoned", duration: "saveEndsEachTurn", save } as Rider,
      { condition: "stunned", duration: "saveEndsEachTurn", save, requiresTargetCondition: "poisoned", requiresMovement: 20, requiresMovementImmediate: true } as Rider,
    ];
    return option;
  };
  const run = (options: ActionOption[], parts: { optionIdx: number; count: number }[]) => {
    const duel = rufDuel(rufCharger(options, parts), 30);
    duel.states[1].legendaryResistances = 1;
    duel.turn();
    assert.match(duel.text(), RUF_CLOSED, `setup not reached\n${duel.text()}`);
    return duel;
  };
  // Negative control: the Gore is the first attack after the approach, the Stunned could land, the Resistance is spent.
  const first = run([gore()], [{ optionIdx: 0, count: 1 }]);
  assert.equal(first.states[1].legendaryResistances, 0, first.text());
  // After a Bite the run-up is spent: the failed save lands Poisoned alone, and no Resistance is spent on it.
  const second = run([rufOpt("Bite", undefined), gore()], [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 1 }]);
  const text = second.text();
  assert.equal(second.states[1].legendaryResistances, 1, `Legendary Resistance spent for a rider that could not land\n${text}`);
  assert.ok(second.states[1].conditions.some((c: any) => c.name === "poisoned"), text);
  assert.ok(!second.states[1].conditions.some((c: any) => c.name === "stunned"), text);
});

test("run-up on the first attack: the flag is the gate's own sentence's, in each wording", () => {
  const parse = (text: string) => parseAction({ name: "Gore", entries: [text] }, "action", "test").option!.action as any;
  const head = "{@atkr m} {@hit 6}, reach 5 ft. {@h}8 ({@damage 1d8 + 4}) Piercing damage.";
  const immediate = parse(`${head} If the target is a Large or smaller creature and the bull moved 20+ feet straight toward it immediately before the hit, the target takes an extra 9 ({@damage 2d8}) Piercing damage and has the {@condition Prone} condition.`);
  assert.equal(immediate.damage[1].requiresMovement, 20);
  assert.equal(immediate.damage[1].requiresMovementImmediate, true);
  assert.equal(immediate.riders[0].requiresMovementImmediate, true);
  assert.equal(immediate.damage[0].requiresMovementImmediate, undefined);
  const she = parse(`${head} If the bull moved at least 10 feet straight at the target immediately before she hit, then the target takes an extra 4 ({@damage 1d8}) piercing damage.`);
  assert.equal(she.damage[1].requiresMovementImmediate, true);
  // Negative controls: a run-up printed without the phrase, and the phrase with no run-up gate.
  const sameTurn = parse(`${head} If the bull moved at least 20 feet straight at the target on the same turn, then the target takes an extra 9 ({@damage 2d8}) Piercing damage and has the {@condition Prone} condition.`);
  assert.equal(sameTurn.damage[1].requiresMovement, 20);
  assert.equal(sameTurn.damage[1].requiresMovementImmediate, undefined);
  assert.equal(sameTurn.riders[0].requiresMovement, 20);
  assert.equal(sameTurn.riders[0].requiresMovementImmediate, undefined);
  assert.ok(!JSON.stringify(sameTurn).includes("requiresMovementImmediate"));
  const noGate = parse(`${head} If the bull drank a potion immediately before the hit, the target has the {@condition Prone} condition.`);
  assert.ok(!JSON.stringify(noGate).includes("requiresMovementImmediate"));
  // A dependent rider ("While Prone, …") inherits its parent's gate, and the flag with it, however far on it is printed.
  const filler = "The bull then bellows, and the sound of it carries across the field for a long while after. ".repeat(5);
  const dependent = parse(`${head} If the target is a Large or smaller creature and the bull moved 20+ feet straight toward it immediately before the hit, the target has the {@condition Prone} condition. ${filler}While {@condition Prone}, the target has the {@condition Restrained} condition.`);
  const restrained = dependent.riders.find((r: any) => r.condition === "restrained");
  assert.equal(restrained.requiresMovement, 20, JSON.stringify(dependent.riders));
  assert.equal(restrained.requiresMovementImmediate, true, JSON.stringify(dependent.riders));
});

test("SRD charge gates are compiled and Green Hag retains Invisibility", () => {
  const { blocks } = compileAllDetailed();
  const flagged = blocks.filter(b => JSON.stringify(b).includes('requiresMovementImmediate'));
  assert.equal(flagged.length, 18); // 17, and Giant Seahorse's Ram (K06)
  for (const name of ['Wereboar', 'Mammoth', 'Minotaur Skeleton']) assert.ok(flagged.some(b => b.name === name));
  assert.ok(blocks.find(b => b.name === 'Green Hag')!.options.some(o => o.name === 'Invisibility'));
});
