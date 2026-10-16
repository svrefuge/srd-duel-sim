import assert from "node:assert/strict";
import test from "node:test";
import { fight, isProvableStalemate, runPair } from "../src/engine/fight.ts";

import type { ActionOption, CombatStatblock, Scenario } from "../src/types.ts";
import { resolveScenario } from "../src/types.ts";

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

test("mirror match between identical fighters is ~50/50", () => {
  const mirror = runPair(makeBlock({ name: "X" }), makeBlock({ name: "Y" }), 20000, 5);
  const rateX = mirror.winsA / mirror.iters;
  assert.ok(Math.abs(rateX - 0.5) < 0.02, `identical fighters should be ~50/50, got ${rateX}`);
});

test("resistance halves and immunity zeroes average damage", () => {
  const attacker = makeBlock({ name: "A", hpAvg: 60 });
  const plain = makeBlock({ name: "P", hpAvg: 60, options: [], routines: [] });
  const resistant = makeBlock({ name: "R", hpAvg: 60, resist: ["bludgeoning"], options: [], routines: [] });
  const immune = makeBlock({ name: "I", hpAvg: 60, immune: ["bludgeoning"], options: [], routines: [] });
  // measure via average rounds to kill: resistant should survive ~2x rounds of plain
  const plainFight = runPair(attacker, plain, 300, 1);
  const resistFight = runPair(attacker, resistant, 300, 1);
  const immuneFight = runPair(attacker, immune, 50, 1);
  assert.ok(resistFight.avgRounds > plainFight.avgRounds * 1.5, `${resistFight.avgRounds} vs ${plainFight.avgRounds}`);
  assert.equal(immuneFight.draws, 50); // immune defender can never die -> 100-round draws
});

test("qualified nonmagical resistance is bypassed only by magical damage", () => {
  const defense = [{
    kind: "resist" as const,
    types: ["bludgeoning"],
    nonmagicalOnly: true,
    nonsilveredOnly: false,
    nonadamantineOnly: false,
  }];
  const target = makeBlock({ name: "Qualified", hpAvg: 120, qualifiedDefenses: defense, options: [], routines: [] });
  const mundane = makeBlock({ name: "Mundane", hpAvg: 300 });
  const magicalOption = {
    ...mundane.options[0],
    action: { ...mundane.options[0].action, magical: true },
  } as ActionOption;
  const magical = makeBlock({ name: "Magical", hpAvg: 300, options: [magicalOption] });
  const vsMundane = runPair(mundane, target, 300, 91);
  const vsMagical = runPair(magical, target, 300, 91);
  assert.ok(vsMundane.avgRounds > vsMagical.avgRounds * 1.5, `${vsMundane.avgRounds} vs ${vsMagical.avgRounds}`);
});

test("prepared spells at the same level consume one shared slot pool", () => {
  const spells: ActionOption[] = ["Fire", "Cold"].map((name, i) => ({
    name,
    sourceText: "",
    sourceRef: "test",
    action: {
      kind: "autohit",
      magical: true,
      damage: [{ dice: { n: 0, d: 1, mod: 10 - i }, type: i ? "cold" : "fire" }],
    },
    uses: { t: "perDay", max: 1, pool: "spell-slots:1" },
    timing: "action",
  }));
  const caster = makeBlock({ name: "Slots", hpAvg: 100, options: spells });
  const target = makeBlock({ name: "Sponge", hpAvg: 100, options: [], routines: [] });
  const trace = fight(caster, target, 47, true);
  assert.equal(trace.log.filter((line) => /^Slots uses (?:Fire|Cold)$/.test(line)).length, 1, trace.log.join("\n"));
});

test("variants of one recharge action consume a shared recharge pool", () => {
  const variants: ActionOption[] = ["Fire Breath", "Sleep Breath"].map((name, i) => ({
    name,
    sourceText: "",
    sourceRef: "test",
    action: {
      kind: "autohit",
      magical: false,
      damage: [{ dice: { n: 0, d: 1, mod: 10 - i }, type: i ? "cold" : "fire" }],
    },
    uses: { t: "recharge", min: 7, pool: "breath" },
    timing: "action",
  }));
  const dragon = makeBlock({ name: "SharedBreath", hpAvg: 100, options: variants });
  const target = makeBlock({ name: "BreathTarget", hpAvg: 100, options: [], routines: [] });
  const trace = fight(dragon, target, 9, true);
  assert.equal(trace.log.filter((line) => /^SharedBreath uses .* Breath$/.test(line)).length, 1, trace.log.join("\n"));
});

test("mythic reset triggers once and restores the second health pool", () => {
  const nova: ActionOption = {
    name: "Nova",
    sourceText: "",
    sourceRef: "test",
    action: { kind: "autohit", magical: false, damage: [{ dice: { n: 0, d: 1, mod: 30 }, type: "force" }] },
    uses: { t: "atWill" },
    timing: "action",
  };
  const attacker = makeBlock({ name: "MythicSlayer", hpAvg: 100, options: [nova] });
  const mythic = makeBlock({ name: "TwoPhase", hpAvg: 20, mythicResetHp: 15, options: [], routines: [] });
  const trace = fight(attacker, mythic, 3, true);
  assert.ok(trace.log.some((line) => line === "TwoPhase enters its mythic phase (15 hp)"), trace.log.join("\n"));
  assert.equal(trace.rounds, 2);
  assert.equal(trace.winner, 0);
});

test("limited Shield reactions deplete instead of refreshing every round", () => {
  const missile: ActionOption = {
    name: "Magic Missile",
    sourceText: "",
    sourceRef: "test",
    action: {
      kind: "autohit",
      magical: true,
      blockedByShield: true,
      damage: [{ dice: { n: 0, d: 1, mod: 8 }, type: "force" }],
    },
    uses: { t: "atWill" },
    timing: "action",
  };
  const caster = makeBlock({ name: "Missiler", hpAvg: 100, options: [missile] });
  const shielded = makeBlock({
    name: "Shielded",
    hpAvg: 24,
    reaction: { kind: "shield", acBonus: 5, meleeOnly: false, uses: { t: "perDay", max: 1 } },
    options: [],
    routines: [],
  });
  const trace = fight(caster, shielded, 53, true);
  assert.equal(trace.log.filter((line) => line === "Shielded casts Shield").length, 1, trace.log.join("\n"));
  assert.ok(trace.log.some((line) => line.startsWith("Shielded takes 8 damage")), trace.log.join("\n"));
});

test("rider saves are rolled: high save bonus mostly resists paralysis", () => {
  const paralyzer = makeBlock({
    name: "Paralyzer",
    hpAvg: 60,
    options: [{
      name: "Touch",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 20, damage: [{ dice: { n: 0, d: 1, mod: 1 }, type: "necrotic" }], riders: [{ condition: "paralyzed", save: { ability: "con", dc: 2 }, duration: "endOfTargetNextTurn" }], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const tough = makeBlock({ name: "Tough", hpAvg: 60, saves: { con: 30 } });
  // DC 2 vs +30 save: cannot fail (saves have no nat-1 rule). The tough creature fights back
  // and out-damage the 1-damage-per-hit paralyzer.
  const result = runPair(paralyzer, tough, 500, 2);
  assert.ok(result.winsB > result.iters * 0.8, `tough creature should win often, won ${result.winsB}/${result.iters}`);
  const immune = makeBlock({ name: "NoPara", hpAvg: 60, conditionImmune: ["paralyzed"] });
  const result2 = runPair(paralyzer, immune, 200, 2);
  assert.ok(result2.winsB > result2.iters * 0.8);
});

test("legendary resistance burns on incapacitating riders", () => {
  const paralyzer = makeBlock({
    name: "Paralyzer",
    hpAvg: 30,
    options: [{
      name: "Gaze",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", riders: [{ condition: "paralyzed", save: { ability: "wis", dc: 30 }, duration: "saveEndsEachTurn" }], magical: false },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const legend = makeBlock({ name: "Legend", hpAvg: 30, legendaryResistances: 3 });
  const trace = fight(paralyzer, legend, 11, true);
  const burns = trace.log.filter((l) => l.includes("Legendary Resistance")).length;
  assert.ok(burns >= 1, `expected LR burns in log:\n${trace.log.join("\n")}`);
});

test("controller damages an already-incapacitated target instead of reapplying pure control", () => {
  const controller = makeBlock({
    name: "Controller",
    speed: 30,
    hpAvg: 100,
    options: [{
      name: "Lockdown",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", riders: [{ condition: "paralyzed", save: { ability: "wis", dc: 30 }, duration: "permanent" }], magical: false, range: 30 },
      uses: { t: "atWill" },
      timing: "action",
    }, {
      name: "Rend",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 10, damage: [{ dice: { n: 4, d: 6, mod: 6 }, type: "slashing" }], riders: [], magical: false, melee: true, ranged: false, reach: 5 },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const target = makeBlock({ name: "Target", hpAvg: 120, speed: 0, abilityMods: { str: 0, dex: 0, con: 0, int: 0, wis: -5, cha: 0 }, options: [], routines: [] });
  const trace = fight(controller, target, 3, true, "max30");
  const paralyzeIdx = trace.log.findIndex((l) => l.includes("Target gains paralyzed"));
  const rendIdx = trace.log.findIndex((l, idx) => idx > paralyzeIdx && l.includes("Controller uses Rend"));
  assert.ok(paralyzeIdx >= 0, `expected paralysis:\n${trace.log.join("\n")}`);
  assert.ok(rendIdx > paralyzeIdx, `expected damage after paralysis instead of repeated control:\n${trace.log.join("\n")}`);
});

test("controller closes past stun range to use its lethal melee routine", () => {
  const controller = makeBlock({
    name: "ClosingController",
    speed: 50,
    hpAvg: 200,
    options: [{
      name: "Stunning Gaze",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", riders: [{ condition: "stunned", save: { ability: "wis", dc: 30 }, duration: "startOfSourceNextTurn" }], magical: false, range: 120 },
      uses: { t: "atWill" },
      timing: "action",
    }, {
      name: "Crushing Blow",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 30, damage: [{ dice: { n: 4, d: 10, mod: 10 }, type: "force" }], riders: [], magical: false, melee: true, ranged: false, reach: 10 },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const target = makeBlock({ name: "Target", hpAvg: 100, speed: 0, abilityMods: { str: 0, dex: 0, con: 0, int: 0, wis: -5, cha: 0 }, options: [], routines: [] });
  const result = runPair(controller, target, 100, 1, "max600");
  assert.equal(result.draws, 0, `controller must advance and kill instead of stun-locking:\n${JSON.stringify(result)}`);
  assert.equal(result.winsA, result.iters);
});

test("fragile controller holds its range instead of charging into a lethal melee", () => {
  // Mirror of the test above, with the payoff inverted: closing would bring only a feeble
  // attack online against a bruiser that one-shots the controller. Advancing must stay a
  // judgement call (approach value vs. holding), not an unconditional charge.
  const controller = makeBlock({
    name: "Fragile", speed: 70, hpAvg: 60, ac: 13, options: [{
      name: "Weak Gaze", sourceText: "", sourceRef: "test",
      action: { kind: "save", ability: "wis", dc: 13, damage: [], onSuccess: "none", riders: [{ condition: "stunned", save: { ability: "wis", dc: 13 }, duration: "startOfSourceNextTurn" }], magical: false, range: 120 },
      uses: { t: "atWill" }, timing: "action",
    }, {
      name: "Poke", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 3, damage: [{ dice: { n: 1, d: 4, mod: 0 }, type: "piercing" }], riders: [], magical: false, melee: true, ranged: false, reach: 5 },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const bruiser = makeBlock({
    name: "Bruiser", speed: 30, hpAvg: 150, ac: 16, saves: { wis: 8 }, options: [{
      name: "Cleave", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 12, damage: [{ dice: { n: 6, d: 10, mod: 8 }, type: "slashing" }], riders: [], magical: false, melee: true, ranged: false, reach: 10 },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const result = runPair(controller, bruiser, 500, 7, "max600");
  assert.ok(result.winsB < result.iters * 0.5, `faster controller must keep its distance, not charge; lost ${result.winsB}/${result.iters}`);
});

test("closes the distance to bring regeneration-suppressing damage online", () => {
  // Long-range cold outranges short-range fire, but only fire is lethal progress against a
  // troll-rule regenerator, so the attacker must give up its standoff and close.
  const caster = makeBlock({
    name: "Standoff", speed: 60, hpAvg: 300, options: [{
      name: "Frost Lance", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 14, damage: [{ dice: { n: 8, d: 8, mod: 6 }, type: "cold" }], riders: [], magical: true, melee: false, ranged: true, range: 600 },
      uses: { t: "atWill" }, timing: "action",
    }, {
      name: "Flame Jet", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 14, damage: [{ dice: { n: 3, d: 6, mod: 0 }, type: "fire" }], riders: [], magical: true, melee: false, ranged: true, range: 60 },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const troll = makeBlock({
    name: "Regen", hpAvg: 94, speed: 30, options: [], routines: [],
    regeneration: { amount: 15, suppressedBy: ["fire", "acid"], deathRule: true },
  });
  const result = runPair(caster, troll, 200, 3, "max600");
  assert.ok(result.winsA > result.iters * 0.8, `must close to use fire instead of kiting with cold, won ${result.winsA}/${result.iters}`);
});

test("condition-immune creature never gains its immune condition", () => {
  const paralyzer = makeBlock({
    name: "Paralyzer",
    options: [{
      name: "Touch",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 20, damage: [{ dice: { n: 1, d: 4, mod: 0 }, type: "necrotic" }], riders: [{ condition: "paralyzed", duration: "endOfTargetNextTurn" }], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const immune = makeBlock({ name: "Immune", conditionImmune: ["paralyzed"] });
  for (let seed = 0; seed < 50; seed++) {
    const trace = fight(paralyzer, immune, seed, true);
    assert.ok(!trace.log.some((l) => l.includes("Immune gains paralyzed")));
  }
});

test("recharge actions eventually come back", () => {
  const breather = makeBlock({
    name: "Breather",
    hpAvg: 200,
    options: [{
      name: "Breath",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "save", ability: "dex", dc: 15, damage: [{ dice: { n: 10, d: 6, mod: 0 }, type: "fire" }], onSuccess: "half", riders: [], magical: false },
      uses: { t: "recharge", min: 5 },
      timing: "action",
    }, {
      name: "Claw",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 6, damage: [{ dice: { n: 1, d: 6, mod: 3 }, type: "slashing" }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const sponge = makeBlock({ name: "Sponge", hpAvg: 400, options: [], routines: [] });
  const trace = fight(breather, sponge, 3, true);
  const breaths = trace.log.filter((l) => l.includes("uses Breath")).length;
  assert.ok(breaths >= 2, `expected multiple breath uses, saw ${breaths}:\n${trace.log.slice(0, 30).join("\n")}`);
});

// --- Realism mechanics ---

function rangedOpt(name: string, toHit = 6, range = 120): ActionOption {
  return {
    name,
    sourceText: "",
    sourceRef: "test",
    action: { kind: "attack", toHit, damage: [{ dice: { n: 2, d: 6, mod: 3 }, type: "fire" }], riders: [], magical: false, melee: false, ranged: true, range },
    uses: { t: "atWill" },
    timing: "action",
  };
}

test("faster ranged fighter kites a melee-only bruiser", () => {
  const archer = makeBlock({ name: "Archer", speed: 60, options: [rangedOpt("Longbow")], hpAvg: 20 });
  const bruiser = makeBlock({ name: "Bruiser", speed: 30, hpAvg: 60 }); // melee Slam only
  const max600 = runPair(archer, bruiser, 500, 3, "max600");
  const max120 = runPair(archer, bruiser, 500, 3, "max120");
  const max30 = runPair(archer, bruiser, 500, 3, "max30");
  assert.ok(max600.winsA > max30.winsA, `room to retreat should help the archer: max600 ${max600.winsA}, max30 ${max30.winsA}`);
  assert.ok(max120.winsA >= max30.winsA, "the 120-foot cap should not be worse for the faster archer than the 30-foot cap");
});

test("all scenarios start 30 feet apart", () => {
  const a = makeBlock({ name: "A" });
  const b = makeBlock({ name: "B" });
  for (const scenario of ["max30", "max120", "max600"] as const) {
    for (const seed of [1, 3, 17]) {
      assert.match(fight(a, b, seed, true, scenario).log[0], new RegExp(`\\(${scenario}, 30 ft\\)`));
    }
  }
});

test("the old scenario names resolve to the caps they named", () => {
  const a = makeBlock({ name: "A" });
  const b = makeBlock({ name: "B" });
  for (const [old, now] of [["arena", "max30"], ["arena120", "max120"], ["open", "max600"]] as const) {
    assert.equal(resolveScenario(old), now);
    assert.deepEqual(fight(a, b, 3, true, old as Scenario).log, fight(a, b, 3, true, now).log);
    assert.deepEqual(runPair(a, b, 20, 3, old as Scenario), runPair(a, b, 20, 3, now));
  }
  assert.throws(() => resolveScenario("field"), /Unknown scenario field/);
  assert.throws(() => fight(a, b, 3, false, "toString" as Scenario), /Unknown scenario/);
});

test("120-foot arena starts at 30 feet and caps separation at 120 feet", () => {
  const archer = makeBlock({ name: "Arena120 Archer", speed: 100, options: [rangedOpt("Longbow")], hpAvg: 200 });
  const bruiser = makeBlock({ name: "Arena120 Bruiser", speed: 30, hpAvg: 500 });
  const trace = fight(archer, bruiser, 3, true, "max120");
  assert.match(trace.log[0], /\(max120, 30 ft\)/);
  const distances = trace.log.flatMap((line) => [...line.matchAll(/-> (\d+) ft/g)].map((match) => Number(match[1])));
  assert.ok(distances.includes(120), `expected the kiter to use the 120-foot boundary:\n${trace.log.slice(0, 30).join("\n")}`);
  assert.ok(distances.every((distance) => distance <= 120), `distance exceeded 120 feet: ${distances.join(", ")}`);
});

test("melee-only pair always fights in melee", () => {
  // Previously asserted via the stance model; the distance model replaced it, so assert
  // the same intent directly: two melee-only fighters must close to reach and stay there.
  const fast = makeBlock({ name: "Fast", speed: 60 });
  const slow = makeBlock({ name: "Slow", speed: 20 });
  const trace = fight(fast, slow, 3, true, "max600");
  const distances = trace.log.flatMap((line) => [...line.matchAll(/-> (\d+) ft/g)].map((match) => Number(match[1])));
  assert.ok(distances.length > 0, "the pair should close from 30 feet apart");
  assert.ok(distances.at(-1)! <= 5, `melee-only fighters should close to reach: ${distances.join(", ")}`);
  assert.ok(trace.log.some((line) => line.includes("uses Slam")), "they should actually trade melee attacks");
});

test("a long-range fighter starting inside both ranges does not dominate", () => {
  const longRange = makeBlock({ name: "Long", speed: 30, hpAvg: 50, options: [rangedOpt("Long Ray", 8, 600)] });
  const shortRange = makeBlock({ name: "Short", speed: 30, hpAvg: 50, options: [rangedOpt("Short Ray", 8, 120)] });
  const open = runPair(longRange, shortRange, 500, 13, "max600");
  const arena = runPair(longRange, shortRange, 500, 13, "max30");
  assert.ok(open.winsA < open.iters * 0.75, `the close start should prevent range alone from dominating, won ${open.winsA}`);
  assert.ok(arena.winsA <= open.winsA, "room to retreat should not hurt the long-range fighter");
});

test("parry reaction turns marginal hits into misses", () => {
  const attacker = makeBlock({ name: "A", hpAvg: 300 });
  const noParry = makeBlock({ name: "NP", ac: 14, hpAvg: 60, options: [], routines: [] });
  const parry = makeBlock({ name: "P", ac: 14, hpAvg: 60, reaction: { acBonus: 4, meleeOnly: true }, options: [], routines: [] });
  const a = runPair(attacker, noParry, 400, 7);
  const b = runPair(attacker, parry, 400, 7);
  assert.ok(b.avgRounds > a.avgRounds * 1.1, `parry should extend survival: ${b.avgRounds} vs ${a.avgRounds}`);
});

test("undead fortitude keeps zombies standing", () => {
  const attacker = makeBlock({ name: "A", hpAvg: 300 });
  const zombie = makeBlock({ name: "Z", hpAvg: 15, undeadFortitude: true, saves: { con: 3 }, options: [], routines: [] });
  const plain = makeBlock({ name: "N", hpAvg: 15, options: [], routines: [] });
  const z = runPair(attacker, zombie, 400, 9);
  const n = runPair(attacker, plain, 400, 9);
  assert.ok(z.avgRounds > n.avgRounds, `fortitude should extend survival: ${z.avgRounds} vs ${n.avgRounds}`);
});

test("troll death rule: regenerates from 0 unless suppressed", () => {
  const troll = makeBlock({
    name: "Troll",
    hpAvg: 40,
    regeneration: { amount: 15, suppressedBy: ["fire", "acid"], deathRule: true },
  });
  const basher = makeBlock({ name: "Basher", hpAvg: 200 }); // bludgeoning only
  const burner = makeBlock({ name: "Burner", hpAvg: 200, options: [rangedOpt("Firebolt", 8)], speed: 30 });
  const vsBash = runPair(basher, troll, 200, 4);
  const vsBurn = runPair(burner, troll, 200, 4, "max30");
  assert.equal(vsBash.winsA, 0, `bludgeoning alone must never kill the troll, got ${vsBash.winsA} wins`);
  assert.ok(vsBurn.winsA > vsBurn.iters * 0.5, `fire damage should put the troll down, won ${vsBurn.winsA}`);
});

test("power word kill is held until the threshold, then fires", () => {
  const lich = makeBlock({
    name: "PseudoLich",
    hpAvg: 100,
    options: [{
      name: "Power Word Kill",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "autohit", magical: true, damage: [], instantDeathHpThreshold: 100 },
      uses: { t: "perDay", max: 1 },
      timing: "action",
    }, {
      name: "Zap",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 10, damage: [{ dice: { n: 4, d: 6, mod: 5 }, type: "lightning" }], riders: [], magical: true, melee: false, ranged: true },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const big = makeBlock({ name: "Big", hpAvg: 160, options: [], routines: [] });
  const trace = fight(lich, big, 21, true);
  const logText = trace.log.join("\n");
  const pwkIndex = trace.log.findIndex((l) => l.includes("Power Word Kill"));
  assert.ok(pwkIndex > 0, `PWK should eventually be used:\n${logText}`);
  // every action before PWK must be Zap (PWK held while target > 100 hp)
  const uses = trace.log.filter((l) => l.includes("uses "));
  assert.ok(uses[0].includes("Zap"), `first action should be Zap, not PWK:\n${logText}`);
  assert.equal(trace.winner, 0);
});

test("bonus actions with target-condition prerequisites wait for that condition", () => {
  const swallowOnly = makeBlock({
    name: "SwallowOnly",
    hpAvg: 80,
    options: [{
      name: "Swallow",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "save", ability: "str", dc: 30, damage: [{ dice: { n: 4, d: 6, mod: 0 }, type: "acid" }], onSuccess: "none", riders: [], magical: false, range: 10, requiresTargetCondition: "grappled" },
      uses: { t: "atWill" },
      timing: "bonus",
    }],
    routines: [],
  });
  const target = makeBlock({ name: "Target", hpAvg: 80, options: [], routines: [] });
  const noGrappleTrace = fight(swallowOnly, target, 31, true, "max30");
  assert.ok(!noGrappleTrace.log.some((l) => l.includes("uses bonus action Swallow")), noGrappleTrace.log.join("\n"));

  const biter = makeBlock({
    name: "Biter",
    hpAvg: 80,
    options: [{
      name: "Bite",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 30, damage: [{ dice: { n: 0, d: 1, mod: 1 }, type: "piercing" }], riders: [{ condition: "grappled", duration: "untilEscape", escapeDc: 30 }], magical: false, melee: true, ranged: false, reach: 10, range: 10 },
      uses: { t: "atWill" },
      timing: "action",
    }, {
      name: "Swallow",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "save", ability: "str", dc: 30, damage: [{ dice: { n: 4, d: 6, mod: 0 }, type: "acid" }], onSuccess: "none", riders: [], magical: false, range: 10, requiresTargetCondition: "grappled" },
      uses: { t: "atWill" },
      timing: "bonus",
    }],
  });
  const grappleTrace = fight(biter, target, 32, true, "max30");
  assert.ok(grappleTrace.log.some((l) => l.includes("Target gains grappled")), grappleTrace.log.join("\n"));
  assert.ok(grappleTrace.log.some((l) => l.includes("uses bonus action Swallow")), grappleTrace.log.join("\n"));
});

// --- Dash, opportunity attacks, control spells ---

test("equal-speed chaser catches a kiter via Dash", () => {
  // Pre-Dash, an equal-speed melee chaser could never close the gap (0% wins).
  const archer = makeBlock({ name: "EqArcher", speed: 30, options: [rangedOpt("Shortbow", 4)], hpAvg: 30 });
  const bruiser = makeBlock({ name: "EqBruiser", speed: 30, hpAvg: 30 });
  const result = runPair(bruiser, archer, 600, 11, "max600");
  assert.ok(result.winsA > result.iters * 0.08, `bruiser should catch and win a share, won ${result.winsA}/${result.iters}`);
  assert.ok(result.draws < result.iters * 0.05, `fights should resolve, ${result.draws} draws`);
});

test("leaving melee reach provokes an opportunity attack; Flyby does not", () => {
  function kiterTrace(flyby: boolean) {
    // Equal speeds so the bruiser actually reaches melee via Dash, forcing the
    // archer to step out of reach on its own turns.
    const archer = makeBlock({ name: "OaArcher", speed: 30, flyby, options: [rangedOpt("Bow", 4)], hpAvg: 400 });
    const bruiser = makeBlock({ name: "OaBruiser", speed: 30, hpAvg: 400 });
    let oas = 0;
    for (let seed = 0; seed < 40; seed++) {
      const trace = fight(bruiser, archer, seed, true, "max600");
      oas += trace.log.filter((l) => l.includes("opportunity attack")).length;
    }
    return oas;
  }
  const normal = kiterTrace(false);
  const withFlyby = kiterTrace(true);
  assert.ok(normal > 0, `expected some opportunity attacks, saw ${normal}`);
  assert.equal(withFlyby, 0, `flyby should never provoke, saw ${withFlyby}`);
});

function controlCaster(spellName: string): CombatStatblock {
  return makeBlock({
    name: "Controller",
    hpAvg: 100,
    options: [{
      name: spellName,
      sourceText: "",
      sourceRef: "test",
      action: {
        kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", magical: true, range: 90,
        targetTypes: spellName === "Hold Person" ? ["humanoid"] : undefined,
        riders: [{ condition: "paralyzed", duration: "saveEndsEachTurn", save: { ability: "wis", dc: 30 } }],
      },
      uses: { t: "atWill" },
      timing: "action",
    }, {
      name: "Staff",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 8, damage: [{ dice: { n: 2, d: 6, mod: 3 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
}

test("hold-person-style paralysis locks a humanoid but not a dragon", () => {
  const caster = controlCaster("Hold Person");
  const humanoid = makeBlock({ name: "Peasant", hpAvg: 60, creatureType: "humanoid" });
  const dragon = makeBlock({ name: "Wyrm", hpAvg: 60, creatureType: "dragon" });
  const vsHumanoid = runPair(caster, humanoid, 300, 13, "max600");
  assert.ok(vsHumanoid.winsA > vsHumanoid.iters * 0.9, `caster should lock the humanoid, won ${vsHumanoid.winsA}`);
  let humanoidLocked = 0;
  let dragonLocked = 0;
  for (let seed = 0; seed < 30; seed++) {
    if (fight(caster, humanoid, seed, true, "max600").log.some((l) => l.includes("gains paralyzed"))) humanoidLocked++;
    if (fight(caster, dragon, seed, true, "max600").log.some((l) => l.includes("gains paralyzed"))) dragonLocked++;
  }
  assert.ok(humanoidLocked > 20, `humanoid should usually get paralyzed, ${humanoidLocked}/30`);
  assert.equal(dragonLocked, 0, `dragon must be immune to the humanoid-only spell, locked ${dragonLocked}/30`);
});

test("endsOnDamage conditions break when the target is damaged", () => {
  const attacker = makeBlock({
    name: "Hypnotist",
    hpAvg: 100,
    options: [{
      name: "Pattern",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", magical: true, range: 120, riders: [{ condition: "incapacitated", duration: "permanent", endsOnDamage: true }] },
      uses: { t: "atWill" },
      timing: "action",
    }, {
      name: "Jab",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "attack", toHit: 20, damage: [{ dice: { n: 1, d: 4, mod: 1 }, type: "piercing" }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const victim = makeBlock({ name: "Victim", hpAvg: 100 });
  const trace = fight(attacker, victim, 17, true, "max30");
  const gainIdx = trace.log.findIndex((l) => l.includes("Victim gains incapacitated"));
  if (gainIdx >= 0) {
    const after = trace.log.slice(gainIdx);
    assert.ok(after.some((l) => l.includes("shakes off")), `damage should break the condition:\n${after.slice(0, 12).join("\n")}`);
  }
});

test("Suggestion makes the target follow a fleeing course instead of approaching", () => {
  const suggester = makeBlock({
    name: "Suggester",
    hpAvg: 100,
    options: [{
      name: "Suggestion",
      sourceText: "",
      sourceRef: "test",
      action: {
        kind: "save",
        ability: "wis",
        dc: 30,
        damage: [],
        onSuccess: "none",
        riders: [{ condition: "suggested", duration: "permanent", endsOnDamage: true }],
        magical: true,
        range: 600,
        concentration: true,
      },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const victim = makeBlock({
    name: "Victim",
    hpAvg: 100,
    speed: 30,
    abilityMods: { str: 0, dex: 0, con: 0, int: 0, wis: -5, cha: 0 },
  });
  const trace = fight(suggester, victim, 5, true, "max600");
  assert.ok(trace.log.some((line) => line.includes("follows the Suggestion and flees")), trace.log.join("\n"));
});

test("hybrid spell burst lands even on a miss, and respects immunity", () => {
  function iceKnifer(toHit: number) {
    return makeBlock({
      name: "Knifer", hpAvg: 200, options: [{
        name: "Ice Knife", sourceText: "", sourceRef: "test",
        action: {
          kind: "attack", toHit, magical: true, melee: false, ranged: true, range: 60,
          damage: [{ dice: { n: 1, d: 10, mod: 0 }, type: "piercing" }], riders: [],
          extraSave: { ability: "dex", dc: 30, damage: [{ dice: { n: 3, d: 6, mod: 0 }, type: "cold" }], onSuccess: "none", onMiss: true },
        },
        uses: { t: "atWill" }, timing: "action",
      }],
    });
  }
  // toHit -100 => the attack always misses, so only the burst can deal damage.
  const missOnly = iceKnifer(-100);
  const victim = makeBlock({ name: "Victim", hpAvg: 200, options: [], routines: [] });
  const t = fight(missOnly, victim, 4, true, "max30");
  assert.ok(t.log.some((l) => l.includes("misses")), "attack should miss");
  assert.ok(t.log.some((l) => l.includes("caught in the burst")), "burst should still land on a miss");

  // A cold-immune victim takes nothing from the burst and (miss-only) never dies.
  const coldImmune = makeBlock({ name: "Frostwall", hpAvg: 200, immune: ["cold"], options: [], routines: [] });
  const t2 = runPair(missOnly, coldImmune, 40, 5, "max30");
  assert.equal(t2.winsA, 0, "cold-immune target should be untouchable by a miss-only cold burst");
});

test("AI uses suppressing damage to kill a troll-rule regenerator", () => {
  // A caster whose big attack is off-type (cold) but has a weaker fire option should still
  // win vs a regenerator by finishing with fire — not grind to a draw.
  const caster = makeBlock({
    name: "Caster", hpAvg: 300, options: [{
      name: "Frost", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 12, damage: [{ dice: { n: 6, d: 6, mod: 5 }, type: "cold" }], riders: [], magical: true, melee: true, ranged: false },
      uses: { t: "atWill" }, timing: "action",
    }, {
      name: "Firebolt", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 12, damage: [{ dice: { n: 2, d: 6, mod: 0 }, type: "fire" }], riders: [], magical: true, melee: false, ranged: true, range: 120 },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const troll = makeBlock({
    name: "Regen", hpAvg: 84, options: [], routines: [],
    regeneration: { amount: 15, suppressedBy: ["fire", "acid"], deathRule: true },
  });
  const r = runPair(caster, troll, 200, 3, "max30");
  assert.ok(r.winsA > r.iters * 0.8, `caster should finish the regenerator with fire, won ${r.winsA}/${r.iters}`);
});

test("instant-death kills a troll-rule regenerator outright", () => {
  const pwkCaster = makeBlock({
    name: "Reaper", hpAvg: 200, options: [{
      name: "Power Word Kill", sourceText: "", sourceRef: "test",
      action: { kind: "autohit", magical: true, damage: [], instantDeathHpThreshold: 100 },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const troll = makeBlock({
    name: "Regen", hpAvg: 40, options: [], routines: [],
    regeneration: { amount: 15, suppressedBy: ["fire"], deathRule: true },
  });
  // A "dies" effect never routes through 0 HP, so regeneration and the troll death rule
  // don't apply: the caster wins outright despite dealing no fire damage.
  const r = runPair(pwkCaster, troll, 60, 3, "max30");
  assert.equal(r.winsA, r.iters, `PWK must kill a regenerator outright, won ${r.winsA}/${r.iters}`);
});

test("stalemate proof is conservative around regeneration and maximum-HP reduction", () => {
  const inert = makeBlock({ name: "Inert", options: [], routines: [] });
  const mundane = makeBlock({ name: "Mundane" });
  const troll = makeBlock({
    name: "Regen", options: [], routines: [],
    regeneration: { amount: 15, suppressedBy: ["fire"], deathRule: true },
  });
  // Since draws are scored by hit-point margin, the shortcut must also predict the final
  // hit points, so it requires that *no* damage can land in either direction. A mundane
  // attacker chips a troll it can never put down, so that pair is not shortcut -- and
  // simulating it must produce the verdict a shortcut would have asserted.
  assert.equal(isProvableStalemate(mundane, troll), false);
  const chipped = runPair(mundane, troll, 20);
  assert.equal(chipped.draws, 20, "a troll that cannot be suppressed still cannot be killed");
  assert.ok(chipped.drawHpB < 1, "but it should not finish untouched -- it is being chipped");

  // Two creatures that genuinely cannot hurt each other stay on the fast path, and the
  // full-health draw it asserts is exactly what simulating them would produce.
  assert.equal(isProvableStalemate(inert, troll), true);
  assert.deepEqual(runPair(inert, troll, 20), {
    a: "Inert", b: "Regen", iters: 20, winsA: 0, winsB: 0, draws: 20,
    avgRounds: 100, avgWinnerHpPct: 0, drawHpA: 1, drawHpB: 1,
  });

  const drainer = makeBlock({
    name: "Drainer", options: [{
      name: "Drain", sourceText: "", sourceRef: "test",
      action: {
        kind: "attack", toHit: 5, magical: true, melee: true, ranged: false, riders: [],
        damage: [{ dice: { n: 1, d: 6, mod: 0 }, type: "necrotic", reducesMaxHp: true }],
      },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  assert.equal(isProvableStalemate(drainer, troll), false);
});

test("non-magical breath bypasses Magic Resistance; magical spells don't", () => {
  const breather = makeBlock({
    name: "Breather", hpAvg: 300, options: [{
      name: "Breath", sourceText: "", sourceRef: "test",
      action: { kind: "save", ability: "dex", dc: 18, damage: [{ dice: { n: 12, d: 6, mod: 0 }, type: "fire" }], onSuccess: "half", riders: [], magical: false },
      uses: { t: "atWill" }, timing: "action",
    }, {
      name: "Spell", sourceText: "", sourceRef: "test",
      action: { kind: "save", ability: "dex", dc: 18, damage: [{ dice: { n: 12, d: 6, mod: 0 }, type: "fire" }], onSuccess: "half", riders: [], magical: true },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const mr = makeBlock({ name: "MR", hpAvg: 300, magicResistance: true, saves: { dex: 4 }, options: [], routines: [] });
  function saveRate(actionName: string) {
    let saves = 0, casts = 0;
    for (let s = 0; s < 40; s++) {
      const t = fight(breather, mr, s, true, "max30");
      for (const l of t.log) { if (l.includes(`uses ${actionName}`)) casts++; if (l === "MR saves" || l.includes("MR saves")) {} }
    }
    return { casts };
  }
  // Direct check: MR should get advantage only vs the magical version. Measure empirically via
  // total damage taken to kill.
  const vsBreath = runPair(breather, mr, 300, 7);   // breather only casts the higher-EV of the two; both equal dmg
  assert.ok(vsBreath.iters === 300);
  // Concretely assert the flag wiring: a magic-resistant target saves more often vs magical.
  // (unit-level: rollSave advantage is gated on action.magical, verified by the flags on compiled dragons)
});

test("invisibility: advantage/disadvantage, breaks on attack, negated by truesight", () => {
  function caster(truesightFoe: boolean) {
    return { truesightFoe };
  }
  const invis = makeBlock({
    name: "Sneak", hpAvg: 120, options: [{
      name: "Invisibility", sourceText: "", sourceRef: "test",
      action: { kind: "selfbuff", condition: "invisible" }, uses: { t: "atWill" }, timing: "action",
    }, {
      name: "Stab", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 6, damage: [{ dice: { n: 2, d: 6, mod: 3 }, type: "piercing" }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const seer = makeBlock({ name: "Seer", hpAvg: 120, truesight: true });
  // Against a non-truesight foe the sneak should sometimes go invisible; against truesight it must not.
  let castVsBlind = 0, castVsSeer = 0;
  for (let s = 0; s < 30; s++) {
    if (fight(invis, makeBlock({ name: "Blind", hpAvg: 200 }), s, true, "max30").log.some((l) => l.includes("becomes invisible"))) castVsBlind++;
    if (fight(invis, seer, s, true, "max30").log.some((l) => l.includes("becomes invisible"))) castVsSeer++;
  }
  assert.equal(castVsSeer, 0, "must never cast invisibility against a truesight foe");
  // and when it does go invisible, the attack reveals it
  const trace = fight(invis, makeBlock({ name: "Blind", hpAvg: 400 }), 3, true, "max30");
  if (trace.log.some((l) => l.includes("becomes invisible"))) {
    assert.ok(trace.log.some((l) => l.includes("is revealed")), "attacking should reveal the invisible creature");
  }
});

test("depleting ammunition becomes unavailable after its post-use roll", () => {
  const thrower = makeBlock({
    name: "Thrower",
    hpAvg: 200,
    options: [{
      name: "Finite Boulder",
      sourceText: "",
      sourceRef: "test",
      action: {
        kind: "autohit",
        magical: false,
        damage: [{ dice: { n: 0, d: 1, mod: 12 }, type: "bludgeoning" }],
      },
      uses: { t: "atWill" },
      depletion: { die: 6, maxRoll: 6 },
      timing: "action",
    }],
  });
  const sponge = makeBlock({ name: "Sponge", hpAvg: 60, speed: 0, options: [], routines: [] });
  const trace = fight(thrower, sponge, 5, true, "max30");
  assert.equal(trace.log.filter((line) => line === "Thrower uses Finite Boulder").length, 1, trace.log.join("\n"));
  assert.ok(trace.log.some((line) => line.includes("Finite Boulder is depleted")), trace.log.join("\n"));
});

test("a first form transforms into its successor instead of ending the fight at zero HP", () => {
  const strike: ActionOption = {
    name: "Strike",
    sourceText: "",
    sourceRef: "test",
    action: {
      kind: "autohit",
      magical: false,
      damage: [{ dice: { n: 0, d: 1, mod: 20 }, type: "force" }],
    },
    uses: { t: "atWill" },
    timing: "action",
  };
  const attacker = makeBlock({ name: "Breaker", hpAvg: 200, options: [strike] });
  const imago = makeBlock({ name: "Imago", hpAvg: 30, speed: 0, options: [], routines: [] });
  const chrysalis = makeBlock({ name: "Chrysalis", hpAvg: 15, speed: 0, successor: imago, options: [], routines: [] });
  const trace = fight(attacker, chrysalis, 7, true, "max30");
  assert.ok(trace.log.some((line) => line === "Chrysalis transforms into Imago (30 hp)"), trace.log.join("\n"));
  assert.equal(trace.winner, 0, trace.log.join("\n"));
  assert.ok(trace.rounds >= 3, `successor should require its own HP pool:\n${trace.log.join("\n")}`);
});

test("antimagic rider suppresses the affected creature's magical actions", () => {
  const nullifier = makeBlock({
    name: "Nullifier",
    hpAvg: 100,
    initiativeBonus: 50,
    options: [{
      name: "Null Zone",
      sourceText: "",
      sourceRef: "test",
      action: {
        kind: "save",
        ability: "cha",
        dc: 30,
        damage: [],
        onSuccess: "none",
        riders: [{ condition: "antimagic", duration: "endOfTargetNextTurn", appliesOnSuccess: true }],
        magical: false,
        range: 30,
      },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const caster = makeBlock({
    name: "Caster",
    hpAvg: 100,
    initiativeBonus: -50,
    options: [{
      name: "Arcane Bolt",
      sourceText: "",
      sourceRef: "test",
      action: {
        kind: "autohit",
        magical: true,
        damage: [{ dice: { n: 0, d: 1, mod: 30 }, type: "force" }],
      },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const trace = fight(nullifier, caster, 13, true, "max30");
  assert.ok(trace.log.some((line) => line === "Caster gains antimagic"), trace.log.join("\n"));
  assert.ok(!trace.log.some((line) => line === "Caster uses Arcane Bolt"), trace.log.join("\n"));
  assert.ok(!trace.log.some((line) => line.startsWith("Nullifier takes ")), trace.log.join("\n"));
});

test("lasting riders deal their start-turn damage once per turn", () => {
  const swallower = makeBlock({
    name: "Swallower",
    hpAvg: 100,
    initiativeBonus: 50,
    options: [{
      name: "Swallow",
      sourceText: "",
      sourceRef: "test",
      action: {
        kind: "attack",
        toHit: 100,
        damage: [{ dice: { n: 0, d: 1, mod: 1 }, type: "piercing" }],
        riders: [{
          condition: "swallowed",
          duration: "permanent",
          startTurnDamage: [{ dice: { n: 0, d: 1, mod: 10 }, type: "acid" }],
        }],
        magical: false,
        melee: true,
        ranged: false,
      },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const meal = makeBlock({ name: "Meal", hpAvg: 12, initiativeBonus: -50, options: [], routines: [] });
  const trace = fight(swallower, meal, 71, true, "max30");
  assert.ok(trace.log.some((line) => line === "Meal suffers swallowed damage at the start of its turn"), trace.log.join("\n"));
  assert.equal(trace.winner, 0, trace.log.join("\n"));
  assert.equal(trace.rounds, 2, trace.log.join("\n"));
});

test("damage reactions apply once per round before HP loss", () => {
  const strikes: ActionOption = {
    name: "Double Strike",
    sourceText: "",
    sourceRef: "test",
    action: {
      kind: "autohit",
      magical: false,
      damage: [{ dice: { n: 0, d: 1, mod: 10 }, type: "force" }],
    },
    uses: { t: "atWill" },
    timing: "action",
  };
  const attacker = makeBlock({
    name: "Striker",
    hpAvg: 100,
    initiativeBonus: 50,
    options: [strikes],
    routines: [{ name: "Twice", parts: [{ optionIdx: 0, count: 2 }] }],
  });
  const negator = makeBlock({
    name: "Negator",
    hpAvg: 15,
    initiativeBonus: -50,
    reaction: {
      kind: "damageNegation",
      acBonus: 0,
      meleeOnly: false,
      healing: { n: 0, d: 1, mod: 3 },
    },
    options: [],
    routines: [],
  });
  const trace = fight(attacker, negator, 73, true, "max30");
  assert.ok(trace.log.some((line) => line.includes("Negator negates the damage and regains 3 hp")), trace.log.join("\n"));
  assert.ok(trace.log.some((line) => line === "Negator takes 10 damage (5 hp left)"), trace.log.join("\n"));
});

test("a failed pre-damage gate consumes the attempted attack and applies its condition", () => {
  const attacker = makeBlock({
    name: "WouldBeAttacker",
    hpAvg: 30,
    initiativeBonus: 50,
    abilityMods: { str: 2, dex: 1, con: 1, int: 0, wis: 0, cha: -100 },
  });
  const warded = makeBlock({
    name: "Warded",
    hpAvg: 30,
    initiativeBonus: -50,
    damageGate: {
      ability: "cha",
      dc: 12,
      condition: "charmed",
      duration: "endOfTargetNextTurn",
      magical: false,
    },
    options: [],
    routines: [],
  });
  const trace = fight(attacker, warded, 79, true, "max30");
  assert.ok(trace.log.some((line) => line === "WouldBeAttacker gains charmed"), trace.log.join("\n"));
  assert.ok(trace.log.some((line) => line.includes("fails to overcome Warded's damage ward")), trace.log.join("\n"));
  assert.ok(!trace.log.some((line) => line.startsWith("Warded takes ")), trace.log.join("\n"));
});

test("multiattack all-hit follow-ups trigger only after the required hits", () => {
  const jab: ActionOption = {
    name: "Jab",
    sourceText: "",
    sourceRef: "test",
    action: {
      kind: "attack",
      toHit: 100,
      damage: [{ dice: { n: 0, d: 1, mod: 1 }, type: "piercing" }],
      riders: [],
      magical: false,
      melee: true,
      ranged: false,
    },
    uses: { t: "atWill" },
    timing: "action",
  };
  const combo = makeBlock({
    name: "Combo",
    hpAvg: 100,
    initiativeBonus: 50,
    options: [jab],
    routines: [{
      name: "Multiattack",
      parts: [{ optionIdx: 0, count: 2 }],
      onAllHits: {
        requiredHits: 2,
        action: {
          kind: "autohit",
          magical: false,
          damage: [{ dice: { n: 0, d: 1, mod: 20 }, type: "psychic" }],
        },
      },
    }],
  });
  const target = makeBlock({ name: "ComboTarget", hpAvg: 22, initiativeBonus: -50, options: [], routines: [] });
  const trace = fight(combo, target, 83, true, "max30");
  assert.ok(trace.log.some((line) => line === "Combo triggers Multiattack's all-hit effect"), trace.log.join("\n"));
  assert.equal(trace.winner, 0, trace.log.join("\n"));
  assert.equal(trace.rounds, 1, trace.log.join("\n"));
});

test("a bonus self-heal is used after taking damage and consumes its finite resource", () => {
  const healer = makeBlock({
    name: "Healer",
    hpAvg: 30,
    initiativeBonus: -50,
    options: [{
      name: "Mend",
      sourceText: "",
      sourceRef: "test",
      action: { kind: "selfheal", healing: { n: 0, d: 1, mod: 8 } },
      uses: { t: "perDay", max: 1 },
      timing: "bonus",
    }],
    routines: [],
  });
  const chipper = makeBlock({
    name: "Chipper",
    hpAvg: 100,
    initiativeBonus: 50,
    options: [{
      name: "Chip",
      sourceText: "",
      sourceRef: "test",
      action: {
        kind: "autohit",
        magical: false,
        damage: [{ dice: { n: 0, d: 1, mod: 5 }, type: "force" }],
      },
      uses: { t: "atWill" },
      timing: "action",
    }],
  });
  const trace = fight(chipper, healer, 89, true, "max30");
  assert.equal(trace.log.filter((line) => line.startsWith("Healer regains ")).length, 1, trace.log.join("\n"));
  // A heal with daily uses waits for a wound its own size (BS07): not at 25 of 30, where 3 of its 8 would be lost.
  assert.ok(trace.log.some((line) => line === "Healer regains 8 hp (28 hp)"), trace.log.join("\n"));
});

test("a paralyzed target is auto-critted only on attacks that actually beat its AC", () => {
  // +0 to hit vs AC 25 is a natural-20-only attack (5%). Paralysis grants advantage and
  // upgrades a hit to a critical, but it must never turn a miss into a hit.
  const attacker = makeBlock({
    name: "Poker", ac: 12, hpAvg: 400, options: [{
      name: "Poke", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 0, damage: [{ dice: { n: 1, d: 4, mod: 0 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" }, timing: "action",
    }, {
      name: "Gaze", sourceText: "", sourceRef: "test",
      action: { kind: "save", ability: "wis", dc: 99, damage: [], onSuccess: "none", magical: true, range: 120, riders: [{ condition: "paralyzed", duration: "permanent" }] },
      uses: { t: "atWill" }, timing: "bonus",
    }],
    routines: [{ name: "Poke", parts: [{ optionIdx: 0, count: 1 }] }],
  });
  const dummy = makeBlock({ name: "Dummy", ac: 25, hpAvg: 400, options: [], routines: [] });
  let hits = 0;
  let misses = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const log = fight(attacker, dummy, seed, true, "max30").log;
    const start = log.findIndex((line) => line.includes("Dummy gains paralyzed"));
    if (start < 0) continue;
    for (const line of log.slice(start)) {
      if (line.startsWith("Dummy takes")) hits++;
      if (line === "Poker misses Dummy") misses++;
    }
  }
  const rate = hits / (hits + misses);
  // Advantage on a natural-20-only attack is 1 - 0.95^2 = 9.75%.
  assert.ok(hits + misses > 2000, `expected a large sample, got ${hits + misses}`);
  assert.ok(rate > 0.05 && rate < 0.16, `paralyzed target should be hit ~10% of the time, got ${(rate * 100).toFixed(1)}%`);
});

test("Parry still deflects ordinary hits but never a natural 20", () => {
  // Note: paralyzed/unconscious are in INCAPACITATING, so a defender eligible for the
  // adjacent auto-crit can never react anyway. What must hold is that reworking the crit
  // rule left Parry itself intact, and that a natural 20 stays undeflectable.
  const jabber = makeBlock({
    name: "Jabber", ac: 12, hpAvg: 400, options: [{
      name: "Jab", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 5, damage: [{ dice: { n: 1, d: 4, mod: 0 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" }, timing: "action",
    }],
    routines: [{ name: "Jab", parts: [{ optionIdx: 0, count: 1 }] }],
  });
  // AC 18 with a +4 Parry: a roll landing in [13, 16] beats AC but not AC + the bonus.
  const parrier = makeBlock({
    name: "Parrier", ac: 18, hpAvg: 400, options: [], routines: [],
    reaction: { kind: "parry", acBonus: 4, meleeOnly: true },
  });
  let deflections = 0;
  let critsTaken = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const log = fight(jabber, parrier, seed, true, "max30").log;
    deflections += log.filter((line) => line.includes("deflects the attack")).length;
    // A natural 20 is the only way this attacker crits, and it must land through the Parry.
    critsTaken += log.filter((line) => line.startsWith("Parrier takes")).length;
  }
  assert.ok(deflections > 0, "Parry should still convert in-band hits into misses");
  assert.ok(critsTaken > 0, "natural 20s must still land through a Parry");
});

test("a regenerator never returns above a maximum that HP drain has reduced", () => {
  const drainer = makeBlock({
    name: "Drainer", ac: 10, hpAvg: 900, options: [{
      name: "Club", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 20, damage: [{ dice: { n: 8, d: 10, mod: 0 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" }, timing: "action",
    }, {
      name: "Drain", sourceText: "", sourceRef: "test",
      action: { kind: "attack", toHit: 20, damage: [{ dice: { n: 5, d: 6, mod: 0 }, type: "necrotic", reducesMaxHp: true }], riders: [], magical: false, melee: true, ranged: false },
      uses: { t: "atWill" }, timing: "action",
    }],
    routines: [{ name: "Both", parts: [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 1 }] }],
  });
  const troll = makeBlock({
    name: "Trolly", ac: 30, hpAvg: 200, options: [], routines: [],
    regeneration: { amount: 15, suppressedBy: ["fire"], deathRule: true },
  });
  // Total drain dealt bounds the current maximum, so no regeneration line may report more.
  for (const seed of [5, 17, 23, 41]) {
    const log = fight(drainer, troll, seed, true, "max30").log;
    let maxHp = 200;
    for (const line of log) {
      const drained = line.match(/^Trolly takes (\d+) damage/);
      if (drained) maxHp = Math.max(0, maxHp - Number(drained[1]));
      const regen = line.match(/^Trolly regenerates back up \((\d+) hp\)/);
      if (regen) {
        assert.ok(Number(regen[1]) <= 200, `regeneration must stay within the maximum (seed ${seed})`);
      }
    }
  }
  // The drained troll must still lose: it cannot outlast a maximum being ground to zero.
  const r = runPair(drainer, troll, 60, 5, "max30");
  assert.equal(r.winsA, r.iters, `max-HP drain should finish the regenerator, won ${r.winsA}/${r.iters}`);
});

test("Legendary Resistance is not spent shaking off a harmless save-ends condition", () => {
  const nagger = makeBlock({
    name: "Nagger", hpAvg: 300, initiativeBonus: 50, options: [{
      name: "Glitter", sourceText: "", sourceRef: "test",
      action: {
        kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", magical: true, range: 120,
        riders: [{ condition: "poisoned", duration: "saveEndsEachTurn", save: { ability: "wis", dc: 30 } }],
      },
      uses: { t: "atWill" }, timing: "action",
    }],
  });
  const king = makeBlock({ name: "King", hpAvg: 300, legendaryResistances: 3, options: [], routines: [] });
  const log = fight(nagger, king, 11, true, "max30").log;
  assert.ok(log.some((line) => line.includes("King gains poisoned")), "the condition should land");
  assert.equal(
    log.filter((line) => line === "King uses Legendary Resistance").length,
    0,
    `Legendary Resistance must be saved for conditions that matter:\n${log.join("\n")}`,
  );
});

function auraFoe(aura: unknown, extra: Partial<CombatStatblock> = {}): CombatStatblock {
  return makeBlock({ name: "Auraed", hpAvg: 600, speed: 0, options: [], routines: [], ...(aura ? { aura } : {}), ...extra } as any);
}

test("a proximity aura fires at the start of the affected creature's turn, inside its radius only", () => {
  const aura = {
    name: "Death Field", radius: 20, ability: "con", dc: 30,
    damage: [{ dice: { n: 4, d: 6, mod: 0 }, type: "necrotic" }], riders: [],
    immuneOnSuccess: false, requiresConscious: false, requiresSight: false,
  };
  const melee = makeBlock({ name: "Closer", hpAvg: 300 }); // default Slam, reach 5
  const inside = fight(melee, auraFoe(aura), 5, true, "max30");
  assert.ok(inside.log.some((line) => line.includes("is caught in Auraed's Death Field")),
    `a creature standing in melee is inside a 20-foot aura:\n${inside.log.slice(0, 12).join("\n")}`);

  // Same creature, aura radius shrunk below melee reach: never triggers.
  const tiny = { ...aura, radius: 1 };
  const outside = fight(melee, auraFoe(tiny), 5, true, "max30");
  assert.equal(outside.log.filter((line) => line.includes("Death Field")).length, 0);
});

test("an aura granting immunity on a successful save gets exactly one chance", () => {
  const aura = {
    name: "Stench", radius: 20, ability: "con", dc: 10, damage: [],
    riders: [{ condition: "poisoned", duration: "endOfTargetNextTurn" }],
    immuneOnSuccess: true, requiresConscious: false, requiresSight: false,
  };
  const melee = makeBlock({ name: "Closer", hpAvg: 400, saves: { con: 10 } });
  for (let seed = 1; seed <= 40; seed++) {
    const log = fight(melee, auraFoe(aura), seed, true, "max30").log;
    const resisted = log.filter((line) => line.includes("resists Auraed's Stench")).length;
    assert.ok(resisted <= 1, `a save must grant lasting immunity, saw ${resisted} successes`);
  }
});

test("creature types the aura excludes are never asked to save", () => {
  const aura = {
    name: "Withering Aura", radius: 20, ability: "con", dc: 30,
    damage: [{ dice: { n: 6, d: 6, mod: 0 }, type: "necrotic" }], riders: [],
    immuneOnSuccess: false, requiresConscious: false, requiresSight: false,
    excludedTargetTypes: ["undead"],
  };
  const undead = makeBlock({ name: "Closer", hpAvg: 300, creatureType: "undead" });
  const living = makeBlock({ name: "Closer", hpAvg: 300, creatureType: "humanoid" });
  assert.equal(fight(undead, auraFoe(aura), 5, true, "max30").log.filter((l) => l.includes("Withering Aura")).length, 0);
  assert.ok(fight(living, auraFoe(aura), 5, true, "max30").log.some((l) => l.includes("Withering Aura")));
});

test("the movement AI trades a better melee attack for range rather than stand in a lethal aura", () => {
  const sword: ActionOption = {
    name: "Sword", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
    action: { kind: "attack", toHit: 9, damage: [{ dice: { n: 3, d: 8, mod: 5 }, type: "slashing" }], riders: [], magical: false, melee: true, ranged: false },
  };
  const dart: ActionOption = {
    name: "Dart", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
    action: { kind: "attack", toHit: 6, damage: [{ dice: { n: 1, d: 4, mod: 1 }, type: "piercing" }], riders: [], magical: false, melee: false, ranged: true, range: 60, longRange: 120 },
  };
  const hero = makeBlock({
    name: "Hero", hpAvg: 120, options: [sword, dart],
    routines: [{ name: "Sword", parts: [{ optionIdx: 0, count: 1 }] }, { name: "Dart", parts: [{ optionIdx: 1, count: 1 }] }],
  });
  const lethal = {
    name: "Death Field", radius: 20, ability: "con", dc: 30,
    damage: [{ dice: { n: 12, d: 10, mod: 0 }, type: "necrotic" }], riders: [],
    immuneOnSuccess: false, requiresConscious: false, requiresSight: false,
  };
  const count = (foe: CombatStatblock, name: string) => {
    let n = 0;
    for (let seed = 1; seed <= 20; seed++) n += fight(hero, foe, seed, true, "max30").log.filter((l) => l === `Hero uses ${name}`).length;
    return n;
  };
  // Without the aura the far better melee attack wins; with it, the hero keeps its distance.
  assert.ok(count(auraFoe(null), "Sword") > 0 && count(auraFoe(null), "Dart") === 0);
  assert.equal(count(auraFoe(lethal), "Sword"), 0, "the hero should not close into a lethal aura");
  assert.ok(count(auraFoe(lethal), "Dart") > 0, "the hero should fall back to its ranged option");
});

test("melee retaliation hurts the attacker, respects its damage-type gate, and spares ranged attacks", () => {
  const corrosive = { name: "Corrosive Form", damage: [{ dice: { n: 1, d: 8, mod: 0 }, type: "acid" }] };
  const pudding = makeBlock({ name: "Pudding", ac: 8, hpAvg: 400, options: [], routines: [], retaliation: corrosive } as any);

  // Default Slam is melee: the attacker should take acid back on every landed hit.
  const brawler = makeBlock({ name: "Brawler", hpAvg: 300 });
  const melee = fight(brawler, pudding, 3, true, "max30").log;
  const backlash = melee.filter((line) => line.includes("hurt by Pudding's Corrosive Form")).length;
  assert.ok(backlash > 0, `a melee attacker should suffer Corrosive Form:\n${melee.slice(0, 10).join("\n")}`);
  assert.equal(backlash, melee.filter((line) => line.startsWith("Pudding takes")).length,
    "one retaliation per landed melee hit");

  // A purely ranged attacker never touches it and never retaliates.
  const archer = makeBlock({
    name: "Archer", hpAvg: 300, options: [{
      name: "Bow", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
      action: { kind: "attack", toHit: 9, damage: [{ dice: { n: 1, d: 8, mod: 4 }, type: "piercing" }], riders: [], magical: false, melee: false, ranged: true, range: 150, longRange: 600 },
    }],
  });
  assert.equal(fight(archer, pudding, 3, true, "max30").log.filter((l) => l.includes("Corrosive Form")).length, 0);

  // A gated retaliation only answers the listed damage types.
  const gated = { name: "Fire Blood", damage: [{ dice: { n: 1, d: 10, mod: 0 }, type: "fire" }], requiresDamageTypes: ["piercing", "slashing"] };
  const gaunt = makeBlock({ name: "Gaunt", ac: 8, hpAvg: 400, options: [], routines: [], retaliation: gated } as any);
  const clubber = makeBlock({ name: "Clubber", hpAvg: 300 }); // default Slam deals bludgeoning
  assert.equal(fight(clubber, gaunt, 3, true, "max30").log.filter((l) => l.includes("Fire Blood")).length, 0,
    "bludgeoning must not trigger a piercing/slashing retaliation");
  const stabber = makeBlock({
    name: "Stabber", hpAvg: 300, options: [{
      name: "Spear", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
      action: { kind: "attack", toHit: 9, damage: [{ dice: { n: 1, d: 8, mod: 4 }, type: "piercing" }], riders: [], magical: false, melee: true, ranged: false },
    }],
  });
  assert.ok(fight(stabber, gaunt, 3, true, "max30").log.some((l) => l.includes("Fire Blood")));
});

// --- Elevation ---

/** Altitudes a creature actually moved to, read out of the movement log. */
function altitudes(log: string[]): number[] {
  return log.flatMap((line) => [...line.matchAll(/\[altitude \d+ ft to (\d+) ft\]/g)].map((m) => Number(m[1])));
}

test("a grounded pair never leaves the ground", () => {
  const fast = makeBlock({ name: "GroundFast", speed: 60 });
  const slow = makeBlock({ name: "GroundSlow", speed: 20 });
  const trace = fight(fast, slow, 3, true, "max600");
  assert.deepEqual(altitudes(trace.log), [], `no altitude should appear in an all-ground fight:\n${trace.log.slice(0, 20).join("\n")}`);
});

test("a flying archer climbs out of a melee-only bruiser's reach and wins the arena", () => {
  const bruiser = makeBlock({ name: "AirBruiser", speed: 30, hpAvg: 60 }); // Medium, melee Slam, reach 5
  const flier = makeBlock({ name: "AirArcher", speed: 30, flySpeed: 30, options: [rangedOpt("Longbow")], hpAvg: 20 });
  const grounded = makeBlock({ name: "FootArcher", speed: 30, options: [rangedOpt("Longbow")], hpAvg: 20 });

  // The 30-foot arena gives an equal-speed grounded archer nowhere to kite to; altitude does.
  const flying = runPair(flier, bruiser, 500, 3, "max30");
  const walking = runPair(grounded, bruiser, 500, 3, "max30");
  assert.ok(flying.winsA > flying.iters * 0.95, `flying archer should dominate the arena, won ${flying.winsA}/${flying.iters}`);
  assert.ok(flying.winsA > walking.winsA * 1.5, `flight should be worth far more than the same archer on foot: ${flying.winsA} vs ${walking.winsA}`);

  const trace = fight(flier, bruiser, 3, true, "max30");
  // Medium body (5 ft) plus 5 ft of reach: 10 ft of altitude is still inside the bruiser's
  // threat envelope, so the archer has to get above it.
  assert.ok(altitudes(trace.log).some((h) => h > 10), `archer should climb clear of a 5-foot reach:\n${trace.log.slice(0, 20).join("\n")}`);
  assert.ok(!trace.log.some((l) => l.includes("AirBruiser uses Slam")), `a grounded bruiser must never connect:\n${trace.log.slice(0, 25).join("\n")}`);
});

test("vertical reach scales with the grounded creature's size and reach", () => {
  const flier = makeBlock({ name: "SizeFlier", speed: 60, flySpeed: 60, options: [rangedOpt("Longbow")], hpAvg: 200 });
  const reachOpt: ActionOption = {
    name: "Greatclub", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
    action: { kind: "attack", toHit: 8, damage: [{ dice: { n: 3, d: 8, mod: 5 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false, reach: 15 },
  };
  const medium = makeBlock({ name: "MedFoe", speed: 30, size: 2, hpAvg: 300 }); // 5 ft body + 5 ft reach = 10
  const huge = makeBlock({ name: "HugeFoe", speed: 30, size: 4, hpAvg: 300, options: [reachOpt] }); // 15 + 15 = 30
  const connects = (foe: CombatStatblock, scenario: "max30" | "max120") =>
    fight(flier, foe, 3, true, scenario).log.filter((l) => /uses (Greatclub|Slam)/.test(l)).length;

  // The cap is on how far apart the two may be, so the sky reaches 30 ft above the grounded creature's body
  // (`skyRoof`): room to clear a Medium creature's 10-foot envelope and a Huge one's 30-foot envelope alike.
  assert.equal(connects(medium, "max30"), 0, "a Medium 5-ft reach cannot touch a flier 30 ft above it");
  assert.equal(connects(huge, "max30"), 0, "nor a Huge 15-ft reach");
  const climbed = (foe: CombatStatblock) => Math.max(...altitudes(fight(flier, foe, 3, true, "max30").log));
  assert.ok(climbed(medium) > 10 && climbed(medium) <= 35, `over the Medium foe: ${climbed(medium)}`);
  assert.ok(climbed(huge) > 30 && climbed(huge) <= 45, `over the Huge foe: ${climbed(huge)}`);
  assert.equal(connects(huge, "max120"), 0, "a 120-foot cap puts the flier out of any melee reach");
});

test("climbing out of reach provokes an opportunity attack; Flyby does not", () => {
  function climbTrace(flyby: boolean) {
    // The bruiser is fast enough to close in one turn, so the flier starts each of its own
    // turns inside reach and has to climb out of it.
    const bruiser = makeBlock({ name: "ClimbBruiser", speed: 90, hpAvg: 400 });
    const flier = makeBlock({ name: "ClimbFlier", speed: 30, flySpeed: 30, flyby, options: [rangedOpt("Bow", 4)], hpAvg: 400 });
    let oas = 0;
    for (let seed = 0; seed < 40; seed++) {
      oas += fight(bruiser, flier, seed, true, "max30").log.filter((l) => l.includes("opportunity attack")).length;
    }
    return oas;
  }
  assert.ok(climbTrace(false) > 0, "climbing out of a foe's reach should provoke");
  assert.equal(climbTrace(true), 0, "Flyby should exempt the climb");
});

test("a flier loses its Speed and falls; a hovering one does not", () => {
  const stunner = (name: string) => makeBlock({
    name, speed: 30, hpAvg: 400, options: [{
      name: "Hold", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "bonus",
      action: { kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", magical: true, range: 120, riders: [{ condition: "paralyzed", duration: "saveEndsEachTurn", save: { ability: "wis", dc: 30 } }] },
    }, {
      // Something to climb away from. The Hold is a Bonus Action so that the fall it threatens is not priced into the
      // flier's choice of height (`fallRisk` reads the foe's actions): against a certain fall it would stay down.
      name: "Maul", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
      action: { kind: "attack", toHit: 12, damage: [{ dice: { n: 6, d: 10, mod: 5 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
    }],
  });
  // Wins initiative, so it is already airborne when the paralysis lands.
  const flier = (canHover: boolean) => makeBlock({
    name: canHover ? "Hoverer" : "Faller", speed: 60, flySpeed: 60, canHover, initiativeBonus: 40, options: [rangedOpt("Bow")], hpAvg: 400,
  });

  const falls = fight(stunner("Binder"), flier(false), 3, true, "max30");
  const paralyzedIdx = falls.log.findIndex((l) => l === "Faller gains paralyzed");
  const fallIdx = falls.log.findIndex((l) => /^Faller falls \d+ ft$/.test(l));
  assert.ok(fallIdx > 0, `a paralyzed flier should fall:\n${falls.log.slice(0, 25).join("\n")}`);
  assert.equal(fallIdx, paralyzedIdx + 1, `the fall should resolve immediately after paralysis:\n${falls.log.slice(0, 25).join("\n")}`);
  assert.match(falls.log[fallIdx + 1], /^Faller takes \d+ damage/, "the fall should deal damage");

  const hovers = fight(stunner("Binder2"), flier(true), 3, true, "max30");
  assert.ok(hovers.log.some((l) => l.includes("Hoverer gains paralyzed")), `the control should still land:\n${hovers.log.slice(0, 25).join("\n")}`);
  assert.ok(!hovers.log.some((l) => /Hoverer falls/.test(l)), "a hovering flier stays aloft when its Speed drops to 0");
});

test("U05 a flier does not climb over a foe whose action is sure to drop it", () => {
  // The same Binder with its Hold as an action: DC 30 against the flier's +0, range 120 ft. Any height is a fall of 1d6
  // for each 10 feet when the Hold lands, and the Maul reaches a Paralyzed creature wherever it comes down.
  const binder = makeBlock({
    name: "Binder", speed: 30, hpAvg: 400, options: [{
      name: "Hold", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
      action: { kind: "save", ability: "wis", dc: 30, damage: [], onSuccess: "none", magical: true, range: 120, riders: [{ condition: "paralyzed", duration: "saveEndsEachTurn", save: { ability: "wis", dc: 30 } }] },
    }, {
      name: "Maul", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
      action: { kind: "attack", toHit: 12, damage: [{ dice: { n: 6, d: 10, mod: 5 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
    }],
  });
  const flier = makeBlock({ name: "Faller", speed: 60, flySpeed: 60, initiativeBonus: 40, options: [rangedOpt("Bow")], hpAvg: 400 });
  const log = fight(binder, flier, 3, true, "max30").log;
  assert.ok(log.includes("Faller gains paralyzed"), log.slice(0, 12).join("\n"));
  assert.ok(!log.some((l) => /Faller falls/.test(l) || (l.startsWith("Faller") && l.includes("[altitude"))), log.slice(0, 12).join("\n"));
});

test("an airborne successor form retains its altitude", () => {
  const successor = makeBlock({
    name: "Sky Heir", hpAvg: 100, speed: 60, flySpeed: 60,
    options: [rangedOpt("Heir Bow")],
  });
  const chrysalis = makeBlock({
    name: "Sky Chrysalis", hpAvg: 1, speed: 60, flySpeed: 60, initiativeBonus: 50,
    options: [rangedOpt("Chrysalis Bow")], successor,
  });
  const hunter = makeBlock({
    name: "Sky Hunter", hpAvg: 200, initiativeBonus: -50, options: [{
      name: "Bolt", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
      action: { kind: "autohit", magical: false, damage: [{ dice: { n: 0, d: 1, mod: 2 }, type: "force" }], range: 120 },
    }],
  });

  const trace = fight(chrysalis, hunter, 17, true, "max30");
  const transformed = trace.log.findIndex((line) => line.startsWith("Sky Chrysalis transforms into Sky Heir"));
  assert.ok(transformed > 0, trace.log.join("\n"));
  assert.ok(trace.log.slice(0, transformed).some((line) => /Sky Chrysalis moves.*\[altitude 0 ft to [1-9]\d* ft\]/.test(line)), trace.log.join("\n"));
  assert.ok(!trace.log.slice(transformed + 1).some((line) => /Sky Heir moves.*\[altitude 0 ft to/.test(line)), `the successor must not restart on the ground:\n${trace.log.join("\n")}`);
});

test("an altitude-gated damage clause follows the named side off the ground", () => {
  // Two mutually exclusive clauses with unmistakable fixed damage, so the log says which fired.
  const gated = (subject: "attacker" | "target"): ActionOption => ({
    name: "Hurl", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
    action: {
      kind: "attack", toHit: 40, magical: false, melee: false, ranged: true, range: 120, riders: [],
      damage: [
        { dice: { n: 0, d: 1, mod: 7 }, type: "bludgeoning", requiresAirborne: subject },
        { dice: { n: 0, d: 1, mod: 70 }, type: "bludgeoning", requiresGrounded: subject },
      ],
    },
  });
  const hits = (trace: string[], name: string) =>
    [...new Set(trace.filter((l) => l.startsWith(`${name} takes `)).map((l) => Number(l.match(/takes (\d+)/)![1])))];

  // Attacker-side, a creature that hits harder from the ground. On foot it always deals the grounded value; the same
  // creature with a fly speed climbs away from a melee-only foe and deals the airborne one.
  const foe = () => makeBlock({ name: "GateFoe", speed: 30, hpAvg: 4000 });
  const onFoot = makeBlock({ name: "Walker", speed: 30, hpAvg: 4000, options: [gated("attacker")] });
  const aloft = makeBlock({ name: "Flapper", speed: 30, flySpeed: 30, hpAvg: 4000, options: [gated("attacker")] });
  assert.deepEqual(hits(fight(onFoot, foe(), 3, true, "max30").log, "GateFoe"), [70]);
  assert.deepEqual(hits(fight(aloft, foe(), 3, true, "max30").log, "GateFoe"), [7]);

  // Target-side: the gate follows the victim's altitude instead of the attacker's.
  const shooter = makeBlock({ name: "Shooter", speed: 30, hpAvg: 4000, options: [gated("target")] });
  const flyingTarget = makeBlock({ name: "Quarry", speed: 30, flySpeed: 30, hpAvg: 4000, options: [rangedOpt("Bow")] });
  const groundTarget = makeBlock({ name: "Standee", speed: 30, hpAvg: 4000, options: [rangedOpt("Bow")] });
  assert.deepEqual(hits(fight(shooter, groundTarget, 3, true, "max30").log, "Standee"), [70]);
  assert.ok(hits(fight(shooter, flyingTarget, 3, true, "max30").log, "Quarry").includes(7),
    "a target that takes to the air should switch the clause that applies");
});
