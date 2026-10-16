// Not attacking foes that answer every melee hit, Bonus Action Disengage distance, landing for the last hit, and
// Dashing clear. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id
// is in the test name.
import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { fight } from "../src/engine/fight.ts";
import type { Scenario } from "../src/types.ts";

const blocks = compileAll();
const get = (name: string) => blocks.find((b) => b.name === name)!;
const run = (a: string, b: string, scenario: Scenario, seed: number) => fight(get(a), get(b), seed, true, scenario);
const log = (a: string, b: string, scenario: Scenario, seed: number): string[] => run(a, b, scenario, seed).log;

test("N01: a melee swing worth nothing is not made into a foe that answers every melee hit", () => {
  // Black Pudding: immune to Slashing, Grappled and Restrained; Corrosive Form: "A creature that hits the pudding with
  // a melee attack roll takes 4 (1d8) Acid damage." A Chain Devil's two Chains (2d6+4 Slashing, Grappled and
  // Restrained) did 0 and cost it 2 x 95% x 4.5 = 8.6 a round; Conjure Infernal Chain (Fire) is the whole of its damage.
  const lines = log("Black Pudding", "Chain Devil", "max30", 1);
  assert.ok(!lines.includes("Chain Devil uses Chain") && !lines.includes("Chain Devil is hurt by Black Pudding's Corrosive Form"));
  assert.ok(lines.includes("Chain Devil uses Conjure Infernal Chain"));
  // Negative control: against a Vrock (no such response, not immune) the Chains are swung.
  assert.ok(log("Chain Devil", "Vrock", "max30", 1).includes("Chain Devil uses Chain"));
});

test("N02: a Bonus Action Disengage steps only as far as clears the foe's walk and reach", () => {
  // Panther (Speed 50, Nimble Escape) and Mimic (Speed 20, reach 5): 30 ft is clear, and 25 in and 25 out is one turn's
  // movement. From 50 ft the walk back took 45 and it ended beside the Mimic every other round.
  const result = run("Panther", "Mimic", "max120", 1);
  const steps = result.log.filter((line) => line.startsWith("Panther moves (5 ft -> "));
  assert.ok(steps.length > 5 && steps.every((line) => line === "Panther moves (5 ft -> 30 ft)"));
  assert.ok(!result.log.includes("Mimic uses Bite") && result.winner === 0);
  // Negative control: a Swarm of Venomous Snakes walks 30, so a Saber-Toothed Tiger still goes to 40 ft.
  assert.ok(log("Saber-Toothed Tiger", "Swarm of Venomous Snakes", "max120", 1).includes("Saber-Toothed Tiger moves (5 ft -> 40 ft)"));
});

test("N03: a creature shooting from where the foe cannot hurt it does not land for the last hit", () => {
  // Sprite (10 hp; Enchanting Bow 1, Needle Sword 1d4+4) over a Mummy (Rotting Fist 1d10+3 plus 3d6; Dreadful Glare,
  // range 60, deals no damage). With the Mummy at 3 hp it landed for one Needle Sword roll and died to the Fist on a miss.
  for (const seed of [2, 4]) {
    const result = run("Sprite", "Mummy", "max30", seed);
    assert.ok(!result.log.includes("Sprite uses Needle Sword") && result.winner === 0, `seed ${seed}`);
  }
  // Negative control: against a Rat (1 hp, Bite 1) the exchange is won outright and the sword is used.
  assert.ok(log("Sprite", "Rat", "max30", 1).includes("Sprite uses Needle Sword"));
});

test("N05: a damaging Bonus Action is not spent on the target of the caster's own Hypnotic Pattern", () => {
  // Hypnotic Pattern: "The effect ends for a creature if it takes any damage". The Incubus cast it and woke the
  // Manticore with Nightmare (4d8) in the same turn.
  const lines = log("Manticore", "Incubus", "max120", 3);
  const held = lines.indexOf("Manticore gains hypnotized");
  assert.ok(held > 0 && lines[held + 1] !== "Incubus uses bonus action Nightmare");
  assert.ok(lines.slice(held, held + 3).includes("Manticore loses its turn"));
  // Negative control: with no Pattern on the target Nightmare is used (the Incubus acting first).
  const first = log("Manticore", "Incubus", "max120", 8);
  assert.ok(first.indexOf("Incubus uses bonus action Nightmare") > 0 && first.indexOf("Incubus uses bonus action Nightmare") < 12);
});

test("N07: a faster shooter Dashes clear before a slower melee foe's Dash reaches it, not through an Opportunity Attack after", () => {
  // Scout (Speed 30, Longbow) and Archelon (Speed 20, Bite, reach 5; Dash 40). From 10 ft a step and a volley leaves
  // the Archelon's Dash ending beside the Scout; a Dash to 70 ft from there provokes nothing.
  const lines = log("Scout", "Archelon", "max600", 1);
  assert.ok(lines.includes("Scout dashes (10 ft -> 70 ft)"));
  assert.ok(!lines.includes("Archelon makes an opportunity attack"));
  // Negative control: a Black Bear (Speed 40) is not outrun, and the Scout does not Dash from it.
  const bear = log("Scout", "Black Bear", "max600", 1);
  assert.ok(!bear.some((line) => line.startsWith("Scout dashes")) && bear.some((line) => line.startsWith("Scout uses")));
});
