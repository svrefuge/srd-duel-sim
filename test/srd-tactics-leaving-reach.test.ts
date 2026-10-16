// Leaving reach through Opportunity Attacks, holds by size, Dash against faster foes, and Fly against Concentration.
// Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is in the test
// name.
import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { fight } from "../src/engine/fight.ts";
import type { Scenario } from "../src/types.ts";

const blocks = compileAll();
const get = (name: string) => blocks.find((b) => b.name === name)!;
const log = (a: string, b: string, scenario: Scenario, seed: number): string[] => fight(get(a), get(b), seed, true, scenario).log;
/** The lines of one round. */
const round = (lines: string[], n: number): string[] => {
  const from = lines.indexOf(`Round ${n}`);
  const to = lines.indexOf(`Round ${n + 1}`);
  return from < 0 ? [] : lines.slice(from + 1, to < 0 ? undefined : to);
};

test("K01: a no-damage breath that replaces an attack gives the slot back when a hit would drop the foe", () => {
  // Young Silver Dragon, Multiattack: "three Rend attacks. It can replace one attack with a use of Paralyzing Breath".
  // Seed 1: the breath leaves the Guard Captain at 19 hp, the first Rend misses and the second leaves it at 3. A Rend
  // (2d8+6, 15) drops it; the breath deals nothing.
  const lines = round(log("Young Silver Dragon", "Guard Captain", "max30", 1), 2);
  assert.ok(lines.includes("Guard Captain takes 16 damage (3 hp left)"));
  assert.deepEqual(lines.filter((line) => line.startsWith("Young Silver Dragon uses")), ["Young Silver Dragon uses Rend", "Young Silver Dragon uses Rend", "Young Silver Dragon uses Rend"]);
  // Negative control: an Ogre at 29 hp is not dropped by one Rend, and the breath keeps its slot.
  const ogre = log("Young Silver Dragon", "Ogre", "max30", 1);
  const breath = ogre.indexOf("Young Silver Dragon uses Paralyzing Breath");
  assert.ok(breath > 0 && ogre.slice(0, breath).includes("Ogre takes 17 damage (29 hp left)"));
});

test("K03: no step out of reach through an Opportunity Attack that holds the creature it hits", () => {
  // Kraken, Tentacle: reach 30 ft, +17, "the target has the Grappled condition ... and it has the Restrained condition".
  // A Cloud Giant (AC 14) 30 ft away is hit 95% of the time, so the step back ends where it began and the Thunderclouds
  // are thrown Restrained. It throws from where it stands.
  const lines = log("Cloud Giant", "Kraken", "max120", 1);
  assert.equal(lines[2], "Cloud Giant uses Thundercloud");
  assert.equal(lines.filter((line) => line === "Kraken makes an opportunity attack").length, 0);
  // Negative control: an Opportunity Attack that does not hold is still walked through (a Hill Giant leaving a Shield Guardian; a Centaur Trooper now Dashes clear of an Owlbear before it arrives, N07).
  assert.ok(log("Hill Giant", "Shield Guardian", "max120", 1).filter((line) => line === "Shield Guardian makes an opportunity attack").length >= 2);
});

test("K05: Command's Grovel gives no Prone condition to a creature immune to it", () => {
  // Command (p16885 of the text): "Grovel. The target has the Prone condition and then ends its turn." An Air Elemental
  // is immune to Prone; it only ends its turn.
  assert.ok(get("Air Elemental").conditionImmune.includes("prone"));
  const lines = log("Air Elemental", "Vampire", "max30", 1);
  assert.ok(lines.includes("Air Elemental obeys Command and ends its turn"));
  assert.ok(!lines.some((line) => line.includes("Air Elemental obeys Command, falls Prone")));
  // Negative control: a Stone Giant falls Prone.
  assert.ok(log("Stone Giant", "Vampire", "max30", 1).includes("Stone Giant obeys Command, falls Prone, and ends its turn"));
});

test("K07: no Concentration spell over the Fly that is the caster's only way up to a flier that shoots", () => {
  // Glabrezu (no fly Speed; Fly and Confusion, both Concentration) against an Oni (hovers, Nightmare Ray 60 ft at
  // will). With Fly gone the Oni rises and shoots it. It must not cast Confusion over Fly.
  for (const seed of [1, 2, 3]) {
    const lines = log("Glabrezu", "Oni", "max120", seed);
    const flew = lines.indexOf("Glabrezu uses Fly");
    lines.forEach((line, i) => {
      if (line === "Glabrezu uses Confusion" && flew >= 0 && flew < i) assert.notEqual(lines[i + 1], "Glabrezu loses Concentration", `seed ${seed}`);
    });
  }
  // Negative control: a Young Red Dragon has nothing to shoot at will and must come down, so Confusion still replaces Fly.
  const dragon = log("Glabrezu", "Young Red Dragon", "max30", 9);
  const cast = dragon.indexOf("Glabrezu uses Confusion");
  assert.ok(cast > 0 && dragon[cast + 1] === "Glabrezu loses Concentration");
});

test("K13: no Dash at a faster melee-only foe by a creature with more than melee", () => {
  // Adult Black Dragon (Speed 80, Acid Breath) and a Roc (Speed 120, melee only), max600 seed 1. When the dragon's
  // Fear ends the Roc is 600 ft away and comes back. A Dash to 40 ft puts the dragon where the Roc walks in and makes
  // both attacks; held beyond 130 ft, the Roc must Dash and make none.
  const lines = log("Adult Black Dragon", "Roc", "max600", 1);
  assert.ok(!lines.includes("Adult Black Dragon dashes (200 ft -> 40 ft)"));
  const arrives = lines.indexOf("Roc dashes (200 ft -> 5 ft)");
  assert.ok(arrives > 0 && lines[arrives - 1] === "Adult Black Dragon dodges");
  // Negative control: the Roc, which has only melee, still Dashes at the dragon.
  assert.ok(lines.includes("Roc dashes (520 ft -> 280 ft)"));
});

test("K14: one Dash at a slower flying kiter where melee is worth twice the ranged attack", () => {
  // Adult Bronze Dragon (fly 80; three Rends about 48 a turn, Guiding Bolt about 11) and a Horned Devil (fly 60) that
  // steps back to 150 ft each turn to Hurl Flame. Stepping to 120 ft for Guiding Bolt every round is worth less.
  const lines = log("Adult Bronze Dragon", "Horned Devil", "max600", 1);
  assert.ok(round(lines, 2).includes("Adult Bronze Dragon dashes (150 ft -> 5 ft)"));
  assert.ok(round(lines, 3).filter((line) => line === "Adult Bronze Dragon uses Rend").length === 3);
  // Negative control: on round 1 its Lightning Breath is worth more than half the Rends, and it breathes.
  assert.ok(round(lines, 1).includes("Adult Bronze Dragon uses Lightning Breath"));
});

test("K16: a condition that ends with this turn does not hold the foe on its own turn", () => {
  // Mummy Lord, Dreadful Glare as a Legendary Action: Paralyzed "until the end of the mummy's next turn". The Roc is
  // free on its own turn (Speed 120), so a step back to 30 ft keeps nothing off and gives up the Critical Hit a
  // Paralyzed creature takes within 5 ft: Rotting Fist 0.94 x 47 against Channel Negative Energy 0.94 x 25.
  const lines = log("Mummy Lord", "Roc", "max30", 33);
  const glare = lines.indexOf("Mummy Lord uses legendary Dreadful Glare");
  assert.ok(glare > 0 && lines.slice(glare, glare + 4).includes("Roc gains paralyzed"));
  const next = lines.slice(glare).find((line) => /^Mummy Lord (moves|uses (Rotting Fist|Channel Negative Energy))/.test(line));
  assert.equal(next, "Mummy Lord uses Rotting Fist");
  // Negative control: Thundercloud's Incapacitated lasts through the Kraken's own turn, and the Cloud Giant still walks off.
  assert.ok(log("Cloud Giant", "Kraken", "max600", 1).some((line) => line.startsWith("Cloud Giant moves (60 ft -> 100 ft)")));
});

test("K17: a use that Stuns without a roll opens the Multiattack", () => {
  // Glabrezu: "two Pincer attacks and uses Pummel or Spellcasting"; Power Word Stun needs no roll on a target with 150
  // Hit Points or fewer (a Stone Giant has 126). Stunned gives the Pincers Advantage, so it goes first.
  const lines = log("Glabrezu", "Stone Giant", "max30", 1);
  const stun = lines.indexOf("Glabrezu uses Power Word Stun");
  assert.deepEqual(lines.slice(stun, stun + 3), ["Glabrezu uses Power Word Stun", "Stone Giant gains stunned", "Glabrezu uses Pincer"]);
  // Negative control: a target in the air falls out of the Pincers' reach when Stunned, so they are made first.
  const dragon = log("Glabrezu", "Young Red Dragon", "max30", 8);
  const late = dragon.indexOf("Glabrezu uses Power Word Stun");
  assert.equal(dragon[late + 2], "Young Red Dragon falls 40 ft");
  assert.ok(dragon.slice(late - 5, late).filter((line) => line === "Glabrezu uses Pincer").length === 2);
});

test("K03b: a hold with a size limit does not keep a bigger creature from stepping out of reach", () => {
  // Aboleth, Tentacle: "If the target is a Large or smaller creature, it has the Grappled condition". A Behir is Huge:
  // the Opportunity Attack cannot hold it, so it steps from 5 to 30 ft, beyond the Tentacles' 15 ft, before it breathes.
  const holdLimit = (name: string) => {
    const action = get(name).options.find((option) => option.name === "Tentacle")!.action;
    return action.kind === "attack" ? action.riders[0].targetMaxSize : undefined;
  };
  assert.equal(holdLimit("Aboleth"), 3);
  assert.equal(get("Behir").size, 4);
  const lines = round(log("Aboleth", "Behir", "max30", 2), 3);
  assert.equal(lines[lines.indexOf("Behir uses Lightning Breath") - 1], "Behir moves (5 ft -> 30 ft)");
  // Negative control: the Kraken's Tentacle has no size limit, and the Cloud Giant stays where it is (K03).
  assert.equal(holdLimit("Kraken"), undefined);
  assert.equal(log("Cloud Giant", "Kraken", "max120", 1).filter((line) => line === "Kraken makes an opportunity attack").length, 0);
});
