import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPair } from "../src/engine/fight.ts";
import { writeRanking } from "../src/report/elo.ts";
import type { ActionOption, CombatStatblock, PairResult } from "../src/types.ts";

function option(name: string, dice = 6): ActionOption {
  return {
    name, sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action",
    action: { kind: "attack", toHit: 6, damage: [{ dice: { n: 2, d: dice, mod: 3 }, type: "slashing" }], riders: [], magical: false, melee: true, ranged: false },
  };
}
function block(name: string, options: ActionOption[], extra: Partial<CombatStatblock> = {}): CombatStatblock {
  return {
    id: `T:${name}`, name, source: "T", cr: 1, ac: 13, hpAvg: 40,
    abilityMods: { str: 2, dex: 1, con: 1, int: 0, wis: 0, cha: 0 }, saves: {}, skills: {}, initiativeBonus: 1,
    immune: [], resist: [], vulnerable: [], qualifiedDefenses: [], conditionImmune: [], speed: 30, size: 2,
    creatureType: "beast", creatureTags: [], truesight: false, flyby: false, reaction: undefined,
    undeadFortitude: false, magicResistance: false, legendaryResistances: 0, legendaryOptions: [],
    regeneration: undefined, skipped: [], options,
    routines: options.map((o, i) => ({ name: o.name, parts: [{ optionIdx: i, count: 1 }] })),
    ...extra,
  };
}
const pair = (a: string, b: string, iters: number, winsA: number, winsB: number): PairResult =>
  ({ a, b, iters, winsA, winsB, draws: iters - winsA - winsB, avgRounds: 4, avgWinnerHpPct: 0.5, drawHpA: 0, drawHpB: 0 });

function rank(blocks: CombatStatblock[], pairs: PairResult[]): { name: string; elo: number }[] {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcsim-srd-rank-")), "r.csv");
  writeRanking(blocks, pairs, file);
  return fs.readFileSync(file, "utf8").trim().split("\n").slice(1)
    .map((l) => { const c = l.split(","); return { name: c[1], elo: Number(c[3]) }; });
}

test("the fit reads a pair's rate, not how many fights measured it", () => {
  // Four creatures, a fixed set of outcomes, and the same outcomes measured at three different
  // sample counts. The ranking has to come out identical: a pair settled in 50 fights is one
  // matchup's worth of evidence, exactly as a pair that took 800 is.
  const names = ["A", "B", "C", "D"];
  const blocks = names.map((n) => block(n, [option(n)]));
  // Shares as exact whole wins per 20 fights, so scaling to any multiple of 20 stays integral —
  // decimals would drift (0.55 * 800 is 440.00000000000006) and compare different data.
  const PER = 20;
  const shares: [string, string, number][] = [["A", "B", 18], ["A", "C", 16], ["A", "D", 19],
                                              ["B", "C", 12], ["B", "D", 15], ["C", "D", 11]];
  const at = (n: number) => {
    assert.equal(n % PER, 0, `${n} must be a multiple of ${PER}`);
    return shares.map(([a, b, w]) => pair(a, b, n, w * (n / PER), n - w * (n / PER)));
  };
  const base = rank(blocks, at(800));
  for (const n of [40, 200, 1000]) {
    assert.deepEqual(rank(blocks, at(n)), base, `sample count ${n} must not change the fit`);
  }
  // The case that matters, and the one weighting by sample count gets wrong: the same rates
  // measured at *different* counts per pair. A/B settled in 40 fights is the same evidence as
  // A/B settled in 800. Compare the Elo values, not just the order — the order can survive a
  // distorted fit, the numbers cannot.
  const mixed = shares.map(([a, b, w], i) => { const n = [40, 800, 120, 640, 100, 800][i]; return pair(a, b, n, w * (n / PER), n - w * (n / PER)); });
  assert.deepEqual(rank(blocks, mixed), base, "a pair's weight must not depend on its sample count");
});

test("adaptive sampling sizes a pair from its pilot and never overruns the budget", () => {
  const strong = block("Strong", [option("Maul", 12)], { hpAvg: 200, ac: 18 });
  const weak = block("Weak", [option("Poke", 4)], { hpAvg: 8, ac: 8 });
  const even = block("Even", [option("Blade")]);
  const evenToo = block("EvenToo", [option("Blade")]);
  const adaptive = { pilot: 50, targetSe: 0.02 };

  // A settled pair needs few fights; an even one needs many more.
  const settled = runPair(strong, weak, 800, 1, "max120", { adaptive });
  const close = runPair(even, evenToo, 800, 1, "max120", { adaptive });
  assert.ok(settled.iters < 200, `a decided pair should stop early, took ${settled.iters}`);
  assert.ok(close.iters > settled.iters * 2, `an even pair should cost more, ${close.iters} vs ${settled.iters}`);
  assert.ok(close.iters <= 800 && settled.iters <= 800, "never more than the caller asked for");
  assert.ok(settled.iters >= adaptive.pilot, "never fewer than the pilot");

  // The count is part of the result, so a row records what it actually cost.
  assert.equal(settled.winsA + settled.winsB + settled.draws, settled.iters);

  // Same seed, same budget: the rule is deterministic, so a run is reproducible.
  assert.deepEqual(runPair(strong, weak, 800, 1, "max120", { adaptive }), settled);
  // A tighter target buys more fights; a looser one fewer.
  assert.ok(runPair(even, evenToo, 800, 1, "max120", { adaptive: { pilot: 50, targetSe: 0.01 } }).iters
    >= close.iters, "a tighter target cannot cost less");

  // Off by default: the same call without the flag runs the full count and agrees on the winner.
  const fixed = runPair(strong, weak, 800, 1, "max120");
  assert.equal(fixed.iters, 800);
  assert.equal(Math.sign(fixed.winsA - fixed.winsB), Math.sign(settled.winsA - settled.winsB));
});

test("adaptive sampling sizes a pair that always draws as a settled one (SPD01)", () => {
  // Neither can hurt the other: every fight runs to the round cap and ends level. The ranking reads
  // each of those fights as exactly 0.5, so there is nothing left to measure after the pilot. Counting
  // a draw as half a win made this a coin flip: 0.25 / 0.02² + 20 = 645 fights of 100 rounds each.
  const stone = block("Stone", [option("Chip")], { immune: ["slashing"] });
  const stoneToo = block("StoneToo", [option("Chip")], { immune: ["slashing"] });
  const adaptive = { pilot: 50, targetSe: 0.02 };
  const level = runPair(stone, stoneToo, 800, 1, "max30", { adaptive, shortCircuitStalemates: false });
  assert.equal(level.draws, level.iters, "the pair must always draw for this test to mean anything");
  // The floor is the budget of a 50-0 pilot: share 51/52, 51/52 × 1/52 / 0.02² = 47.2, so 48 + 20.
  assert.equal(level.iters, 68);

  // Negative control: with no draws the score variance is p(1-p), so a decided pair gets the same 68
  // and an even one still gets several hundred.
  const strong = block("Strong", [option("Maul", 12)], { hpAvg: 200, ac: 18 });
  const weak = block("Weak", [option("Poke", 4)], { hpAvg: 8, ac: 8 });
  const settled = runPair(strong, weak, 800, 1, "max30", { adaptive });
  assert.equal(settled.draws, 0);
  assert.equal(settled.iters, 68);
  const close = runPair(block("Even", [option("Blade")]), block("EvenToo", [option("Blade")]), 800, 1, "max30", { adaptive });
  assert.equal(close.draws, 0);
  assert.ok(close.iters > 500, `an even pair still needs most of the budget, took ${close.iters}`);
});
