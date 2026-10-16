import assert from "node:assert/strict";
import test from "node:test";
import { compileMonster } from "../src/compile.ts";
import { parseSenses } from "../src/parse/senses.ts";
import { seesTarget, sightRange } from "../src/engine/senses.ts";
import { fight } from "../src/engine/fight.ts";
import type { Aura, CombatStatblock, CombatAction, SkipLog } from "../src/types.ts";

function block(name: string, senses: string[] = [], action?: CombatAction): CombatStatblock {
  const b = compileMonster({ name, source: "TEST", cr: "1", ac: [12], hp: { average: 200 }, speed: { walk: 0 }, senses }, new Map());
  b.initiativeBonus = 40;
  b.options = action ? [{ name: "Strike", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action", action }] : [];
  b.routines = action ? [{ name: "Strike", parts: [{ optionIdx: 0, count: 1 }] }] : [];
  return b;
}
const strike: CombatAction = { kind: "attack", melee: true, ranged: false, reach: 120, toHit: 3, magical: false,
  damage: [{ dice: { n: 0, d: 1, mod: 9 }, type: "force" }], riders: [] };
const ray: CombatAction = { kind: "autohit", range: 120, requiresSight: true, magical: true,
  damage: [{ dice: { n: 0, d: 1, mod: 9 }, type: "force" }], riders: [] };
const blindness: Aura = { name: "Blindness", radius: 120, damage: [], riders: [{ condition: "blinded", duration: "permanent" }],
  immuneOnSuccess: false, requiresConscious: false, requiresSight: false };

function summary(b: CombatStatblock, foe: CombatStatblock, seed: number) {
  const { log, ...result } = fight(b, foe, seed, true, "max30");
  return { ...result, attacks: log.filter(l => /misses|damage|hits/.test(l)) };
}

test("senses parser: mixed senses, tags, case, qualifiers and absence", () => {
  assert.deepEqual(parseSenses(), {});
  assert.deepEqual(parseSenses(["Darkvision 120 ft.", "Tremorsense 60 ft."]), { tremorsense: 60 });
  assert.deepEqual(parseSenses(["{@sense Blindsight} 10 ft., truesight 60 ft.", "BLINDSIGHT 30 ft"]), { blindsight: 30, truesightRange: 60 });
  for (const suffix of ["blind beyond this radius", "blind beyond this distance", "can't see beyond this radius"]) {
    assert.deepEqual(parseSenses([`blindsight 60 ft. (${suffix})`]), { blindsight: 60, blindBeyond: 60 });
  }
  const skipped: SkipLog[] = [];
  assert.deepEqual(parseSenses(["blindsight 120 ft. while the creature's eye is closed", "truesight 30 ft. (requires cloud rune)", "blindsight unknown", "blindsight 0 ft."], skipped), {});
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every(s => s.where === "senses"));
});

test("senses compiler: ranges and unsupported conditional senses reach compiled output", () => {
  const b = block("Seer", ["Blindsight 30 ft.", "Truesight 120 ft."]);
  assert.equal(b.blindsight, 30); assert.equal(b.truesightRange, 120); assert.equal(b.truesight, true);
  const conditional = block("Conditional", ["truesight 30 ft. (requires cloud rune)"]);
  assert.equal(conditional.truesight, false); assert.equal(conditional.truesightRange, undefined);
  assert.equal(conditional.skipped.filter(s => s.where === "senses").length, 1);
});

test("senses visibility: inside, at and outside range, blindness, invisibility and ordinary sight", () => {
  const blind = block("Blind", ["Blindsight 30 ft."]);
  const trueSight = block("True", ["Truesight 30 ft."]);
  const limited = block("Limited", ["Blindsight 30 ft. (blind beyond this radius)"]);
  for (const d of [25, 30, 35]) {
    assert.equal(seesTarget(blind, true, false, d), d <= 30);
    assert.equal(seesTarget(blind, true, true, d), d <= 30);
    assert.equal(seesTarget(blind, false, true, d), d <= 30);
    assert.equal(seesTarget(trueSight, false, true, d), d <= 30);
    assert.equal(seesTarget(trueSight, true, false, d), false);
    assert.equal(seesTarget(limited, false, false, d), d <= 30);
    assert.equal(seesTarget(blind, false, false, d), true, "ordinary vision survives outside blindsight");
  }
  assert.equal(seesTarget(block("Tremor", ["Tremorsense 60 ft."]), true, false, 5), false);
  assert.equal(seesTarget(block("None"), false, true, 0), false, "no sense at zero distance");
  assert.equal(seesTarget(blind, true, true, 0), true, "swallowed geometry can be zero distance");
  assert.equal(sightRange(block("Both", ["Blindsight 10 ft.", "Truesight 60 ft."]), true, true), 10);
});

test("senses combat: compiled blindsight restores sight-required targeting while Blinded at the boundary", () => {
  const foe = block("Foe"); foe.aura = blindness;
  for (const range of [29, 30, 31]) {
    const b = block("Seer", [`Blindsight ${range} ft.`], ray);
    const r = fight(b, foe, 1, true);
    assert.equal(r.winner, range >= 30 ? 0 : -1);
  }
  assert.equal(fight(block("True", ["Truesight 120 ft."], ray), foe).winner, -1);
  assert.equal(fight(block("Tremor", ["Tremorsense 120 ft."], ray), foe).winner, -1);
});

test("senses combat: Blinded attack rolls and attacks against a Blinded defender use their blindsight", () => {
  for (const range of [29, 30, 31]) {
    const b = block("Seer", [`Blindsight ${range} ft.`], strike);
    const foe = block("Foe", [], strike); foe.initiativeBonus = -40; foe.aura = blindness;
    const control = structuredClone(b), controlFoe = structuredClone(foe); delete controlFoe.aura;
    if (range < 30) { control.attackDisadvantage = true; controlFoe.attackAdvantage = true; }
    for (let seed = 1; seed <= 12; seed++) assert.deepEqual(summary(b, foe, seed), summary(control, controlFoe, seed), `range=${range} seed=${seed}`);
  }
});

test("senses combat: blind-beyond radius constrains sight-required targeting but not ordinary vision", () => {
  for (const range of [29, 30, 31]) {
    const foe = block("Foe");
    assert.equal(fight(block("Limited", [`Blindsight ${range} ft. (blind beyond this radius)`], ray), foe).winner, range >= 30 ? 0 : -1);
    assert.equal(fight(block("Normal", [`Blindsight ${range} ft.`], ray), foe).winner, 0);
  }
});

test("senses combat: Invisibility choice respects Blindsight and Truesight range", () => {
  const sneak = block("Sneak", [], strike);
  sneak.options.unshift({ name: "Vanish", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "bonus", action: { kind: "selfbuff", condition: "invisible" } });
  sneak.routines[0].parts[0].optionIdx = 1;
  for (const sense of ["Blindsight", "Truesight"]) for (const range of [29, 30, 31]) {
    const foe = block("Seer", [`${sense} ${range} ft.`], strike); foe.initiativeBonus = -40;
    const trace = fight(sneak, foe, 1, true);
    assert.equal(trace.log.some(l => l.includes("becomes invisible")), range < 30, `${sense} ${range}`);
  }
});

test("senses combat: sight-gated rebukes use the blinded reactor's range", () => {
  for (const range of [29, 30, 31]) {
    const attacker = block("Attacker", [], { ...ray, requiresSight: false }); attacker.sourceTurnAura = { ...blindness, onSourceTurn: "start" };
    const reactor = block("Reactor", [`Blindsight ${range} ft.`]); reactor.initiativeBonus = -40;
    reactor.rebuke = { name: "Answer", trigger: "tookDamage", requiresSight: true, uses: { t: "atWill" }, action: ray };
    const trace = fight(attacker, reactor, 1, true);
    assert.equal(trace.log.some(l => l.includes("Answer")), range >= 30, `range=${range}`);
  }
});

test("senses combat: gaze auras use both observers' sense ranges", () => {
  for (const range of [29, 30, 31]) {
    const attacker = block("Attacker", [], { ...ray, requiresSight: false });
    const reactor = block("Reactor", [`Blindsight ${range} ft. (blind beyond this radius)`]);
    reactor.aura = { ...blindness, name: "Gaze", requiresSight: true, riders: [], damage: [{ dice: { n: 0, d: 1, mod: 1 }, type: "force" }] };
    const trace = fight(attacker, reactor, 1, true);
    assert.equal(trace.hpPct[0] < 1, range >= 30);
  }
});

test("senses combat: attacks by and against an Invisible creature use the observer's range", () => {
  for (const sense of ["Blindsight", "Truesight"]) for (const range of [29, 30, 31]) {
    const b = block("Seer", [`${sense} ${range} ft.`], strike);
    const foe = block("Invisible", [], strike); foe.initiativeBonus = -40;
    b.sourceTurnAura = { ...blindness, name: "Invisibility", onSourceTurn: "start", riders: [{ condition: "invisible", duration: "permanent" }] };
    const control = structuredClone(b), controlFoe = structuredClone(foe); delete control.sourceTurnAura;
    if (range < 30) { control.attackDisadvantage = true; controlFoe.attackAdvantage = true; }
    for (let seed = 1; seed <= 12; seed++) assert.deepEqual(summary(b, foe, seed), summary(control, controlFoe, seed), `${sense}=${range} seed=${seed}`);
  }
});

test("senses combat: opportunity attacks require sight at the departure distance", () => {
  for (const range of [29, 30, 31]) {
    const mover = block("Mover", [], { ...strike, melee: false, ranged: true, range: 120 }); mover.speed = 30;
    mover.sourceTurnAura = { ...blindness, onSourceTurn: "start" };
    const reactor = block("Reactor", [`Blindsight ${range} ft.`], { ...strike, reach: 30 }); reactor.initiativeBonus = -40;
    const trace = fight(mover, reactor, 1, true, "max120");
    assert.ok(trace.log.some(l => l.includes("Mover moves")), "must exercise movement");
    assert.equal(trace.log.some(l => l.includes("opportunity attack")), range >= 30, `range=${range}`);
  }
});

test("senses combat: a sight-required attacker closes to its sense range, including random branches", () => {
  for (const action of [ray, { kind: "random", branches: [ray] } as CombatAction]) {
    const attacker = block("Seer", ["Blindsight 10 ft. (blind beyond this radius)"], action); attacker.speed = 5;
    const trace = fight(attacker, block("Foe"), 1, true);
    assert.equal(trace.winner, 0);
    assert.ok(trace.log.some(l => /Seer (moves|dashes)/i.test(l)));
  }
});


test("senses combat: approach planning prices a sight-limited option at its sense range, not its printed range", () => {
  // A weak non-sight control holds the Seer at range unless the approach search knows the ray comes online at 10 ft.
  const first = (dc: number) => {
    const stare: CombatAction = { kind: "save", ability: "wis", dc, damage: [], onSuccess: "none", magical: false, range: 120,
      riders: [{ condition: "stunned", save: { ability: "wis", dc }, duration: "startOfSourceNextTurn" }] };
    const seer = block("Seer", ["Blindsight 10 ft. (blind beyond this radius)"], ray); seer.speed = 5;
    seer.options.push({ ...seer.options[0], name: "Stare", action: stare });
    seer.routines.push({ name: "Stare", parts: [{ optionIdx: 1, count: 1 }] });
    const foe = block("Foe", [], { ...strike, reach: 5, toHit: 5 });
    return fight(seer, foe, 1, true).log.filter(l => l.startsWith("Seer")).slice(0, 2);
  };
  assert.deepEqual(first(3), ["Seer moves (30 ft -> 25 ft)", "Seer uses Stare"]);
  // Negative control: a control option worth more than the distant ray still holds the standoff.
  const held = first(10);
  assert.equal(held[0], "Seer uses Stare");
  assert.ok(!held.some(l => /moves|dashes/.test(l)), held.join("\n"));
});

test("senses combat: movement considers the exact sight boundary", () => {
  const attacker = block("Seer", ["Blindsight 10 ft. (blind beyond this radius)"], ray); attacker.speed = 30;
  const trace = fight(attacker, block("Foe"), 1, true);
  assert.ok(trace.log.some(l => l.includes("30 ft -> 10 ft")), trace.log.slice(0, 8).join("\n"));
});

test("senses combat: a sense range is a movement candidate only while it limits its owner's sight", () => {
  // A useless 15 ft square scores -15 in the damaging search and beats biting squares near a heavy hitter, which
  // sends the snake down the approach branch to 5 ft. Without Blinded, Invisible or a blind-beyond limit the range
  // marks nothing, so the snake must move exactly as the same creature without senses does.
  const first = (senses: string[], foeSenses: string[] = []) => {
    const snake = block("Snake", senses, { ...strike, reach: 10, toHit: 5 }); snake.speed = 30;
    const foe = block("Foe", foeSenses, { ...strike, reach: 5, toHit: 5, damage: [{ dice: { n: 0, d: 1, mod: 60 }, type: "force" }] });
    foe.initiativeBonus = 0; foe.speed = 30;
    foe.options.push({ ...foe.options[0], name: "Claw", action: { ...strike, melee: false, ranged: true, range: 120, toHit: 5,
      damage: [{ dice: { n: 0, d: 1, mod: 30 }, type: "force" }] } });
    foe.routines.push({ name: "Claw", parts: [{ optionIdx: 1, count: 1 }] });
    return fight(snake, foe, 1, true).log.find(l => l.startsWith("Snake"));
  };
  assert.equal(first([]), "Snake moves (30 ft -> 10 ft)");
  assert.equal(first(["Blindsight 10 ft."]), first([]));
  // The foe's own blind-beyond limit is a live boundary, but it does not make the snake's Blindsight one.
  const farLimit = ["Blindsight 300 ft. (blind beyond this radius)"];
  assert.equal(first([], farLimit), "Snake moves (30 ft -> 10 ft)");
  assert.equal(first(["Blindsight 10 ft."], farLimit), first([], farLimit));
});
