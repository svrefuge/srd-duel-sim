// Chasing foes that Disengage or teleport, outlining unseen targets, and Dashing to catch a foe. Each test is judged
// by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the test name.
import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { fight } from "../src/engine/fight.ts";
import type { Scenario } from "../src/types.ts";

const blocks = compileAll();
const get = (name: string) => blocks.find((b) => b.name === name)!;
const log = (a: string, b: string, scenario: Scenario, seed: number): string[] => fight(get(a), get(b), seed, true, scenario).log;

test("L01: no Dash after a melee-only foe that strikes and slips away with a Bonus Action Disengage", () => {
  // Tiger (Speed 40, Rend, Nimble Escape: "takes the Disengage action") against a Berserker (Speed 30, Greataxe only).
  // After each Rend the Tiger steps to 45 ft. A Dash ends beside it with no action left, and it steps away again for
  // nothing. Held at 45 ft, the Tiger spends its whole Speed coming back and is in reach on the Berserker's turn.
  const lines = log("Berserker", "Tiger", "max120", 1);
  assert.ok(lines.includes("Tiger moves (5 ft -> 40 ft)"));
  assert.ok(!lines.some((line) => line.startsWith("Berserker dashes")));
  const back = lines.indexOf("Tiger moves (40 ft -> 5 ft)");
  assert.ok(back > 0 && lines[back - 1] === "Berserker dodges");
  // Negative control: a Spy (Cunning Action, Hand Crossbow) shoots from where it stepped to, so the Awakened Tree
  // still Dashes after it.
  assert.ok(log("Awakened Tree", "Spy", "max120", 1).includes("Awakened Tree dashes (35 ft -> 5 ft)"));
});

test("L02: a teleport that takes the action is not spent on a hold the foe puts straight back", () => {
  // Nalfeshnee, Teleport (an action, 120 ft) in a Remorhaz's Bite ("the target has the Grappled condition ... and it
  // has the Restrained condition"). The Remorhaz walks after it and bites again; three Rends at Disadvantage (+10 v
  // AC 17, 49% each, 27 a hit) are worth more than teleporting turn after turn.
  for (const seed of [1, 2]) {
    assert.ok(!log("Nalfeshnee", "Remorhaz", "max600", seed).includes("Nalfeshnee uses Teleport to break free"), `seed ${seed}`);
  }
  // Negative control: a Bonus Action teleport keeps the action and still frees its user (Blink Dog in a Giant Octopus's Tentacles).
  assert.ok(log("Blink Dog", "Giant Octopus", "max120", 2).includes("Blink Dog uses bonus action Teleport to break free"));
});

test("L03: a Bonus Action that outlines an unseen target goes before the action and the move", () => {
  // Drider, Faerie Fire (Bonus Action, 60 ft): "Attack rolls against an affected creature have Advantage if the
  // attacker can see it, and the affected creature can't benefit from the Invisible condition." Against an Invisible
  // Oni it is cast as soon as it recharges, before the Drider steps back out of its range.
  const lines = log("Drider", "Oni", "max120", 1);
  const cast = lines.indexOf("Drider uses bonus action Faerie Fire");
  assert.ok(cast > 0 && lines[cast - 1] === "Drider recharges Faerie Fire, Web" && lines[cast + 1] === "Oni gains outlined");
  assert.ok(lines.slice(0, cast).includes("Oni becomes invisible"));
  // Negative control: against a Stone Giant in plain sight the Web, from the same Recharge, keeps the slot.
  const giant = log("Drider", "Stone Giant", "max120", 1);
  assert.ok(giant.includes("Drider uses bonus action Web") && !giant.includes("Drider uses bonus action Faerie Fire"));
});

test("L15: one Dash to catch a foe for good replaces a ranged action that deals it nothing", () => {
  // Guardian Naga (Speed 40, Bite reach 10 ft, Poisonous Spittle 60 ft: Poison damage, Blinded on a failed save)
  // against a Spirit Naga (Speed 40, Immunity to Poison) that keeps 60 ft off. A walk leaves it at 20 ft with only the
  // Spittle; a Dash puts it beside the Spirit Naga, whose step away then ends within a walk of two Bites a turn (at HEAD it never Bit).
  const lines = log("Guardian Naga", "Spirit Naga", "max120", 4);
  const dash = lines.indexOf("Guardian Naga dashes (60 ft -> 5 ft)");
  assert.ok(dash > 0 && lines.slice(dash).filter((line) => line === "Guardian Naga uses Bite").length >= 2);
  assert.ok(!lines.slice(dash).includes("Guardian Naga uses Poisonous Spittle"));
  // Negative control: a Stone Giant takes the Poison damage, and the Spittle is kept from range.
  const giant = log("Guardian Naga", "Stone Giant", "max120", 1);
  assert.ok(giant.includes("Guardian Naga uses Poisonous Spittle") && !giant.some((line) => line.startsWith("Guardian Naga dashes")));
});
