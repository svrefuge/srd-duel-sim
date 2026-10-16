// Greater Restoration on a curse, fliers and legendary attacks, Command's Grovel, safe shooting squares, and
// Opportunity Attacks by attached creatures. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic
// quoted above it; the finding id is in the test name.
import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { fight } from "../src/engine/fight.ts";
import type { Scenario } from "../src/types.ts";

const blocks = compileAll();
const get = (name: string) => blocks.find((b) => b.name === name)!;
const run = (a: string, b: string, scenario: Scenario, seed: number) => fight(get(a), get(b), seed, true, scenario);
const log = (a: string, b: string, scenario: Scenario, seed: number): string[] => run(a, b, scenario, seed).log;

test("M01: an action Teleport is not spent leaving a hold when every square to fight from is in the holder's walk", () => {
  // Nalfeshnee (Rend, reach 10; Teleport, an action) in a Remorhaz's Bite (Grappled and Restrained on a hit; Speed 40).
  // It lands 10 ft away to Rend from, the Remorhaz steps in and bites again. It teleported four turns running for no
  // damage; three Rends at Disadvantage (49% x 27) are about 40 a turn.
  assert.ok(!log("Nalfeshnee", "Remorhaz", "max120", 2).includes("Nalfeshnee uses Teleport"));
  // Negative control: a Spirit Naga fights from 60 ft, beyond the Remorhaz's walk and reach, and still jumps there.
  const naga = log("Spirit Naga", "Remorhaz", "max120", 1);
  assert.ok(naga.includes("Spirit Naga teleports free of the grapple") && naga.includes("Spirit Naga teleports (5 ft -> 60 ft)"));
});

test("M02: Greater Restoration ends the curse, and what the curse gives ends with it", () => {
  // Lamia, Corrupting Touch: "the target is cursed for 1 hour. Until the curse ends, the target has the Charmed and
  // Poisoned conditions." Greater Restoration removes one effect, "a curse" among them. Ending Charmed alone
  // would let the next Touch put Charmed back with no save, the curse still being there.
  const lines = log("Couatl", "Lamia", "max30", 1);
  const cast = lines.indexOf("Couatl uses Greater Restoration");
  assert.ok(cast > 0);
  assert.deepEqual(lines.slice(cast + 1, cast + 3), ["Couatl is no longer cursed", "Couatl is no longer charmed or poisoned"]);
  assert.ok(!lines.slice(cast).some((line, i, rest) => line === "Couatl gains charmed" && rest[i - 1] !== "Couatl gains cursed"));
  // Negative control: Poisoned that hangs on nothing is still what Lesser Restoration ends (Priest, Bearded Devil's Beard).
  const priest = log("Priest", "Bearded Devil", "max30", 1);
  assert.equal(priest[priest.indexOf("Priest uses bonus action Lesser Restoration") + 1], "Priest is no longer poisoned");
});

test("M03: a flier out of the foe's answer does not come down for a legendary attack it must pay an Opportunity Attack to leave", () => {
  // Adult White Dragon, Pounce ("moves up to half its Speed, and it makes one Rend attack": 70% x 17.5 = 12), above a
  // Purple Worm (no ranged attack, reach 10; Tail Stinger 85% x 51 = 43 as the Opportunity Attack).
  for (const seed of [1, 5]) assert.ok(!log("Adult White Dragon", "Purple Worm", "max30", seed).includes("Adult White Dragon closes for legendary Rend"), `seed ${seed}`);
  // Negative control: against a Hezrou (reach 5) the Adult Black Dragon's Pounce still closes.
  assert.ok(log("Adult Black Dragon", "Hezrou", "max30", 1).includes("Adult Black Dragon closes for legendary Rend"));
});

test("M05: a foe under Command's Grovel answers nothing on its next turn, so the caster comes in to attack", () => {
  // Adult Red Dragon, Commanding Presence (legendary Command; Grovel: "The target has the Prone condition and then
  // ends its turn"). With the Dragon Turtle commanded it neither Dodges aloft nor lands to cast Command and leaves
  // through an Opportunity Attack.
  const lines = log("Dragon Turtle", "Adult Red Dragon", "max30", 1);
  const grovels = lines.flatMap((line, i) => line === "Dragon Turtle gains commandedGrovel" && lines[i - 1] === "Adult Red Dragon uses legendary Command" ? [i] : []);
  assert.ok(grovels.length > 3);
  assert.ok(!lines.includes("Adult Red Dragon dodges"));
  assert.ok(grovels.some((i) => lines.slice(i + 1, i + 3).includes("Adult Red Dragon uses Rend")));
  // Negative control: after a made save the Turtle will act, and the dragon does not stay to Rend.
  const saved = lines.flatMap((line, i) => line === "Dragon Turtle saves" && lines[i - 1] === "Adult Red Dragon uses legendary Command" ? [i] : []);
  assert.ok(saved.length > 3 && saved.every((i) => lines[i + 1] !== "Adult Red Dragon uses Rend"));
});

test("M07: a creature that loses the exchange shoots from a square the foe can never answer", () => {
  // Sprite (10 hp, fly 40, Needle Sword 1d4+4, Enchanting Bow 1) against a Gray Ooze (22 hp, Speed 10, Pseudopod
  // 2d8+1 at +3, no ranged attack): in melee the Ooze needs about two rounds and the Sprite four.
  for (const scenario of ["max30", "max600"] as const) {
    const result = run("Gray Ooze", "Sprite", scenario, 1);
    assert.equal(result.winner, 1, scenario);
    assert.equal(result.log.find((line) => line.startsWith("Sprite uses")), "Sprite uses Enchanting Bow", scenario);
  }
  // Negative control: it wins the exchange with a Lemure, which hits AC 15 seldom and for little, and still uses the sword.
  assert.ok(log("Lemure", "Sprite", "max120", 1).includes("Sprite uses Needle Sword"));
});

test("M08: an Opportunity Attack that attaches its maker goes with the mover, which opens no distance", () => {
  // Darkmantle, Crush: "the darkmantle attaches to the target." The Sprite must not finish its move 40 ft away with the
  // Darkmantle still attached, and the Darkmantle must not Dash to the creature it is on.
  const lines = log("Darkmantle", "Sprite", "max600", 4);
  const attached = lines.indexOf("Sprite gains attached");
  assert.equal(lines[attached + 1], "Sprite moves with Darkmantle attached and opens no distance");
  assert.ok(!lines.slice(attached).some((line) => line.startsWith("Darkmantle dashes")));
  // Negative control: the Opportunity Attack that missed in round 1 stops nothing.
  const missed = lines.indexOf("Darkmantle makes an opportunity attack");
  assert.deepEqual(lines.slice(missed + 1, missed + 3), ["Darkmantle misses Sprite", "Sprite moves (5 ft -> 40 ft)"]);
});
