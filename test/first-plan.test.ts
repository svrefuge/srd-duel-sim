import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { runPair } from "../src/engine/fight.ts";
import { mulberry32 } from "../src/rng.ts";
import type { ActionOption, CombatStatblock } from "../src/types.ts";

const blocks = compileAll();

test("reusing a pair's opening plan gives the same fights as planning each one afresh (SPD02)", () => {
  // The opening turn's square search reads nothing a die has touched, so a pair plans it once per
  // side to move first and reuses it. Every count and average of the pair row must come out the same
  // with the reuse switched off, over pairs drawn across the corpus and both standard scenarios.
  const rng = mulberry32(20261012);
  for (let n = 0; n < 120; n++) {
    const a = blocks[Math.floor(rng() * blocks.length)];
    const b = blocks[Math.floor(rng() * blocks.length)];
    if (a === b) continue;
    const scenario = n % 2 ? "max30" : "max120";
    const reused = runPair(a, b, 12, 7, scenario);
    const afresh = runPair(a, b, 12, 7, scenario, { reuseFirstPlan: false });
    assert.deepEqual(reused, afresh, `${a.name} vs ${b.name} (${scenario})`);
  }
});

test("the opening plan is taken from the pair's store on every fight after the first of each order (SPD02)", () => {
  // Without this the equality above would pass with the reuse never happening. Two plain melee
  // blocks and no start count: one stored plan per side that moves first, so of 40 opening turns
  // at most 2 are planned and the rest are reused. Switched off, none is.
  const knight = blocks.find((b) => b.name === "Knight")!;
  const giant = blocks.find((b) => b.name === "Hill Giant")!;
  const stats = () => ({ immutableHits: 0, immutableMisses: 0, movementActionHits: 0, movementActionMisses: 0, movementThreatHits: 0, movementThreatMisses: 0, movementMetaBuilds: 0, firstPlanHits: 0 });
  const on = stats();
  runPair(knight, giant, 40, 3, "max30", { cacheStats: on });
  assert.ok(on.firstPlanHits >= 38 && on.firstPlanHits <= 40, `expected 38 to 40 reused opening turns, got ${on.firstPlanHits}`);
  const off = stats();
  runPair(knight, giant, 40, 3, "max30", { cacheStats: off, reuseFirstPlan: false });
  assert.equal(off.firstPlanHits, 0);
});

test("a fighter that rolls what it starts with plans each start separately (SPD02)", () => {
  // Negative control for the key. No SRD block rolls a start count, so one is built here: a Knight
  // whose longbow-range attack needs a start count of 3 or more on 1d4. With it the Knight shoots
  // from where it stands; without it the Knight has to close. One start's plan must not serve the other.
  const knight = blocks.find((b) => b.name === "Knight")!;
  const giant = blocks.find((b) => b.name === "Hill Giant")!;
  const volley: ActionOption = {
    name: "Volley", sourceText: "", sourceRef: "test", uses: { t: "atWill" }, timing: "action", requiresStartCount: 3,
    action: { kind: "attack", toHit: 9, damage: [{ dice: { n: 6, d: 10, mod: 5 }, type: "piercing" }], riders: [], magical: false, melee: false, ranged: true, range: 600 },
  };
  const rolled: CombatStatblock = {
    ...knight, id: "T:Rolled", name: "Rolled", startCount: { name: "Quiver", dice: { n: 1, d: 4, mod: 0 } },
    options: [...knight.options, volley],
    routines: [...knight.routines, { name: "Volley", parts: [{ optionIdx: knight.options.length, count: 1 }] }],
  };
  const reused = runPair(rolled, giant, 200, 3, "max120");
  assert.deepEqual(reused, runPair(rolled, giant, 200, 3, "max120", { reuseFirstPlan: false }));
  // The control only bites if the Quiver matters: the plain Knight does worse against the Hill Giant.
  const plain = runPair(knight, giant, 200, 3, "max120");
  assert.ok(reused.winsA > plain.winsA + 20, `Volley should win fights the plain Knight loses, ${reused.winsA} vs ${plain.winsA}`);
});
