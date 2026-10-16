// Legendary jumps, chargers leaving through Opportunity Attacks, and Bonus Action Dash for shooters. Each test is
// judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the test name.
import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { fight } from "../src/engine/fight.ts";
import type { Scenario } from "../src/types.ts";

const blocks = compileAll();
const get = (name: string) => blocks.find((b) => b.name === name)!;
const log = (a: string, b: string, scenario: Scenario, seed: number): string[] => fight(get(a), get(b), seed, true, scenario).log;

test("N10: a legendary jump is not made into the reach of a foe the creature must then leave through an Opportunity Attack", () => {
  // Solar (Flying Sword, range 120; Radiant Teleport: up to 60 ft, then 2d10 in a 10-foot Emanation, DC 25) and Ancient
  // Green Dragon (Bite, reach 15). From 60 ft the jump was worth about 9 and the Bite on the way back out about 19.
  for (const seed of [1, 2]) {
    const lines = log("Solar", "Ancient Green Dragon", "max120", seed);
    assert.ok(!lines.includes("Solar teleports (60 ft -> 10 ft)") && !lines.includes("Ancient Green Dragon makes an opportunity attack"), `seed ${seed}`);
  }
  // Negative control: already inside an Ancient Gold Dragon's reach, the jump costs nothing more and is made.
  assert.ok(log("Solar", "Ancient Gold Dragon", "max30", 1).includes("Solar teleports (15 ft -> 10 ft)"));
});

test("M12: a charger walks out through an Opportunity Attack and back when the knock-down opens its Trample", () => {
  // Gorgon (Speed 40; Gore 2d12+5, Prone after 20 ft straight toward the target; Bonus Action Trample 2d10+5 on a Prone
  // target) and Wight (two Necrotic Swords, +4 against AC 19). 20 ft out and back: 75% x 13.2 = 9.9 more for one Sword
  // at 30% x 11 = 3.3, which is half the Wight's turn against three quarters of the Gorgon's.
  const lines = log("Gorgon", "Wight", "max120", 1);
  const out = lines.indexOf("Gorgon moves (5 ft -> 25 ft)");
  assert.ok(out > 0 && lines[out + 1] === "Gorgon moves (25 ft -> 5 ft)" && lines[out + 2] === "Gorgon uses Gore");
  assert.ok(lines.slice(0, out).includes("Wight makes an opportunity attack"));
  assert.ok(lines.filter((line) => line === "Gorgon uses bonus action Trample").length >= 2);
  // Negative control: a Minotaur of Baphomet has one Abyssal Glaive, so the attack on the way out is its whole turn
  // again. The Gorgon stays and Gores.
  const stays = log("Gorgon", "Minotaur of Baphomet", "max30", 2);
  assert.ok(stays.includes("Gorgon uses Gore") && !stays.includes("Minotaur of Baphomet makes an opportunity attack"));
});

test("M10: a Bonus Action Dash takes a shooter out of a faster many-attack foe's walk", () => {
  // Assassin (Speed 30; three Light Crossbow shots, 80/320; Cunning Action) and Hydra (Speed 40, five Bites, reach 10).
  // A Disengage and 30 ft leaves the Hydra walking up to Bite five times; 60 ft through one Bite makes it Dash.
  const lines = log("Assassin", "Hydra", "max120", 1);
  const dash = lines.indexOf("Assassin uses bonus action Cunning Action (Dash)");
  assert.ok(dash > 0 && lines.slice(dash, dash + 5).includes("Assassin uses bonus movement (5 ft -> 35 ft)"));
  assert.ok(lines.slice(dash, dash + 6).includes("Assassin moves (35 ft -> 65 ft)") && lines.includes("Hydra dashes (65 ft -> 5 ft)"));
  // Negative control: a Spy's Hand Crossbow (30/120) shoots with Disadvantage from 65 ft, and one of a Lion's two
  // Rends is half its turn. It Disengages.
  const spy = log("Spy", "Lion", "max120", 2);
  assert.ok(spy.includes("Spy uses bonus action Cunning Action (Disengage)") && !spy.includes("Spy uses bonus action Cunning Action (Dash)"));
});
