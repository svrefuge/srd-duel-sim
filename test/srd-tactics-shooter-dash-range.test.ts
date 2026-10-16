// Shooters' Dash decisions, gazes that are saved against, and Magic Resistance against items and auras. Each test is
// judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the test name.
import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { fight } from "../src/engine/fight.ts";
import type { Scenario } from "../src/types.ts";

const blocks = compileAll();
const get = (name: string) => blocks.find((b) => b.name === name)!;
const run = (a: string, b: string, scenario: Scenario, seed: number) => fight(get(a), get(b), seed, true, scenario);
const log = (a: string, b: string, scenario: Scenario, seed: number): string[] => run(a, b, scenario, seed).log;

test("O01: a shooter does not Dash away when the foe's Dash brings it back to the same gap every round", () => {
  // Horned Devil (fly 60, Hurl Flame range 150) and Tyrannosaurus Rex (Speed 50, melee only). In the 120 ft room the
  // Devil's Dash reached the wall, the Rex's Dash (100) left it at 20 ft, and neither attacked for 100 rounds.
  const result = run("Horned Devil", "Tyrannosaurus Rex", "max120", 1);
  assert.ok(!result.log.includes("Horned Devil dashes (20 ft -> 120 ft)"));
  assert.ok(result.log.includes("Horned Devil uses Hurl Flame") && result.winner === 0 && result.rounds < 10);
  // Negative control: a Scout (Speed 30) still Dashes clear of an Archelon (Dash 40) there, which buys it volleys (N07).
  assert.ok(log("Scout", "Archelon", "max120", 1).includes("Scout dashes (10 ft -> 70 ft)"));
});

test("O03: a gaze the creature has saved against is no answer that keeps it from Dashing clear", () => {
  // Mummy (Speed 20, Rotting Fist reach 5; Dreadful Glare, Wisdom save, range 60, "immune to this mummy's Dreadful
  // Glare for 24 hours" on a success). A Hobgoblin Warrior that had saved walked and shot until the Mummy's Dash caught
  // it, and died to the Opportunity Attack as it left.
  const result = run("Hobgoblin Warrior", "Mummy", "max600", 1);
  assert.ok(result.log.includes("Hobgoblin Warrior is immune to Dreadful Glare"));
  assert.ok(result.log.some((line) => line.startsWith("Hobgoblin Warrior dashes")));
  assert.ok(!result.log.includes("Mummy makes an opportunity attack") && result.winner === 0);
  // Negative control: a Warrior that failed the save is not immune, the Glare still counts, and it does not Dash.
  const failed = log("Hobgoblin Warrior", "Mummy", "max600", 3);
  assert.ok(failed.includes("Hobgoblin Warrior gains frightened") && !failed.some((line) => line.startsWith("Hobgoblin Warrior dashes")));
});

test("O06: a move stopped by a grappling Opportunity Attack chooses its action again where it stands", () => {
  // Mimic's Pseudopod Opportunity Attack Grapples (Speed 0). The Wight had planned to walk off and shoot; stopped beside
  // the Mimic it Dodged (max120) or shot at Disadvantage from 5 ft (max30), where Necrotic Sword reaches.
  for (const scenario of ["max120", "max30"] as Scenario[]) {
    const lines = log("Mimic", "Wight", scenario, 1);
    const stopped = lines.indexOf("Wight's movement is stopped");
    assert.ok(stopped > 0 && lines[stopped + 1] === "Wight uses Necrotic Sword", scenario);
  }
  // Negative control: a move nothing stops keeps the plan made before it (the Wight walks off an Ogre and shoots).
  const free = log("Wight", "Ogre", "max120", 1);
  assert.ok(free.indexOf("Wight uses Necrotic Bow") === free.indexOf("Wight moves (30 ft -> 60 ft)") + 1);
});

test("O08 and O09: Magic Resistance answers a magic item's effect and not a creature's own aura", () => {
  // Hezrou Stench (p. 298): "Constitution Saving Throw: DC 16, any creature that starts its turn in a 10-foot
  // Emanation" — nothing magical. Efreeti (Con +7, Magic Resistance) saves 60% without Advantage, 84% with it.
  assert.equal(get("Hezrou").aura?.magical, false);
  let saved = 0, failed = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const lines = log("Hezrou", "Efreeti", "max30", seed);
    saved += lines.filter((line) => line === "Efreeti resists Hezrou's Stench").length;
    failed += lines.filter((line) => line === "Efreeti is caught in Hezrou's Stench").length;
  }
  assert.ok(saved / (saved + failed) < 0.72, `${saved} of ${saved + failed}`);
  // Erinyes "has a magic rope. While bearing it, the erinyes can use the Entangling Rope action" (p. 283): the rope is
  // a magic item's effect. Horned Devil (Str +10, Magic Resistance) against DC 16 fails 25% without Advantage, 6% with.
  const rope = get("Erinyes").options.find((option) => option.name.startsWith("Entangling Rope"))!;
  assert.equal((rope.action as { magical?: boolean }).magical, true);
  let made = 0, uses = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const lines = log("Erinyes", "Horned Devil", "max30", seed);
    lines.forEach((line, i) => {
      if (line !== "Erinyes uses Entangling Rope (Requires Magic Rope)") return;
      uses++;
      if (lines[i + 1] === "Horned Devil saves") made++;
    });
  }
  assert.ok(uses > 30 && made / uses > 0.85, `${made} of ${uses}`);
  // Negative control: the Erinyes's sword, which needs no magic item, is not made magical.
  assert.notEqual((get("Erinyes").options.find((option) => option.name === "Withering Sword")!.action as { magical?: boolean }).magical, true);
});

test("O12: a shooter does not Dash beyond the range of the volley the Dash is meant to buy", () => {
  // Brass Dragon Wyrmling (fly 60; Fire Breath, range 20) and Animated Rug of Smothering (Speed 10, Smother grapples).
  // It must not Dash 110 ft away with the breath ready, then Dash back to 5 ft to use it and be smothered.
  const result = run("Animated Rug of Smothering", "Brass Dragon Wyrmling", "max120", 1);
  assert.ok(!result.log.some((line) => line.startsWith("Brass Dragon Wyrmling dashes")));
  assert.ok(result.log.includes("Brass Dragon Wyrmling uses Fire Breath") && result.winner === 1);
  // Negative control: the Scout's Longbow reaches from where its Dash lands, and it still Dashes (O01's control, max600).
  assert.ok(log("Scout", "Archelon", "max600", 1).includes("Scout dashes (10 ft -> 70 ft)"));
});
