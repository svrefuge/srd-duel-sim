// Grapple pricing, Shield and Counterspell slot budgets, fliers against leapers, melee casters, and Dash or
// Disengage. Each test is judged by the printed SRD 5.2.1 rule or the arithmetic quoted above it; the finding id is
// in the test name.
import assert from "node:assert/strict";
import test from "node:test";
import { compileAll } from "../src/compile.ts";
import { bestRoutineEvAtDistance, routineEvAtDistance } from "../src/engine/pairContext.ts";

const blocks = compileAll();
const get = (name: string) => blocks.find((b) => b.name === name)!;

test("SZ02: an action on a Grappled target is worth nothing beyond the block's hold", () => {
  // Kraken, Fling: "The kraken throws a Large or smaller creature Grappled by it to a space ... within 60 feet".
  // Its only grapple is the Tentacle, reach 30 ft, so a creature 45 ft away cannot be flung. An Ogre that
  // Lightning Strike cannot hurt is threatened by nothing there.
  const kraken = get("Kraken");
  const ogre = { ...get("Ogre"), immune: ["lightning"] };
  const fling = kraken.routines.find((r) => r.name === "Fling")!;
  assert.equal(routineEvAtDistance(fling, kraken, ogre, 45), 0);
  assert.equal(bestRoutineEvAtDistance(kraken, ogre, 45), 0);
  // Negative control: within the Tentacle's 30 ft the Ogre may be held, and Fling keeps its price.
  assert.ok(routineEvAtDistance(fling, kraken, ogre, 30) > 20);
});

test("PC01: a Shield cast from level 1 spell slots is not charged to Counterspell's slots", async () => {
  // A legacy slot list: Shield among the level 1 spells (4 slots), Counterspell among the level 3 spells (2 slots).
  // Each spends a slot of its own level, so Shield is 4 a day from the level 1 pool.
  const fs = await import("node:fs");
  const { compileMonster, dataDir, SPELLS_FILE } = await import("../src/compile.ts");
  const path = await import("node:path");
  const records = JSON.parse(fs.readFileSync(new URL("../data/bestiary-srd-5.2.1.json", import.meta.url), "utf8")).monster;
  const spellData = JSON.parse(fs.readFileSync(path.join(dataDir, SPELLS_FILE), "utf8"));
  const spells = new Map<string, any>((spellData.spell || []).map((s: any) => [s.name.toLowerCase(), s]));
  const caster = (third: string[]) => {
    const raw = structuredClone(records.find((r: any) => r.name === "Mage"));
    raw.name = "Slot Caster";
    raw.reaction = undefined;
    raw.spellcasting = [{
      headerEntries: ["spell save {@dc 14}, {@hit 6} to hit"],
      spells: {
        "0": { spells: ["{@spell Fire Bolt}"] },
        "1": { slots: 4, spells: ["{@spell Magic Missile}", "{@spell Shield}"] },
        "3": { slots: 2, spells: third.map((name) => `{@spell ${name}}`) },
      },
    }];
    return compileMonster(raw, spells);
  };
  const both = caster(["Fireball", "Counterspell"]);
  assert.ok(both.counterspell, "the block compiles a Counterspell");
  assert.deepEqual(both.reaction?.uses, { t: "perDay", max: 4, pool: "spell-slots:1" });
  // Negative controls: the same list without Counterspell compiles the same Shield, and the printed Mage, whose two
  // spells share one "Protective Magic (3/Day)" list, still shares one budget.
  assert.deepEqual(caster(["Fireball"]).reaction?.uses, { t: "perDay", max: 4, pool: "spell-slots:1" });
  const mage = blocks.find((b) => b.name === "Mage")!;
  assert.ok(mage.counterspell && mage.reaction?.uses && "pool" in mage.reaction.uses && mage.reaction.uses.pool !== undefined);
  assert.deepEqual(mage.reaction.uses, mage.counterspell.option.uses);
});

test("L04: a flier one answer would half kill keeps out of a leaper's reach with its breath ready", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Copper Dragon Wyrmling (22 hp, Acid Breath 20 ft) against a Hezrou (three Rends of about 15, and a Leap that goes
  // up 30 ft): every square the breath reaches is one the Hezrou reaches, and its answer is more than the wyrmling has.
  // Seed 8 has the wyrmling move first. It climbs clear and the fight is a draw; breathing once would get it killed.
  const kept = fight(get("Hezrou"), get("Copper Dragon Wyrmling"), 8, true, "max120");
  assert.match(kept.log[0], /Hezrou 10, Copper Dragon Wyrmling 16/);
  assert.equal(kept.winner, -1);
  assert.ok(!kept.log.some((line) => line.includes("uses Acid Breath")));
  // Negative control: a Young White Dragon (123 hp) is not half killed by that answer. It opens with Cold Breath as
  // before (seed 1, the dragon first) and wins by breathing and climbing away in turn.
  const fought = fight(get("Young White Dragon"), get("Hezrou"), 1, true, "max120");
  assert.ok(fought.log.slice(0, 5).some((line) => line.includes("Young White Dragon uses Cold Breath")));
});

test("E14: a melee caster lays a condition it means to follow up from where it can walk back", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Cultist Fanatic (Speed 30, Pact Blade reach 5, Hold Person 60 ft) 30 ft from a Berserker. From 60 ft it cannot reach
  // the Paralyzed Berserker next turn; from 30 ft it can, and every hit within 5 ft is a Critical Hit (Paralyzed).
  // Seed 2: it casts from where it stands and closes on the held Berserker, not stepping back to 60 ft first.
  const fanatic = get("Cultist Fanatic");
  const held = fight(fanatic, get("Berserker"), 2, true, "max120").log;
  assert.deepEqual(held.slice(1, 3), ["Round 1", "Cultist Fanatic uses Hold Person"]);
  assert.ok(held.includes("Cultist Fanatic moves (30 ft -> 5 ft)"));
  // Negative control: the same Fanatic with its blade made a 60 ft ranged attack has no follow-up to walk back for,
  // and steps away before casting.
  const options = fanatic.options.map((option) => option.name === "Pact Blade" && option.action.kind === "attack"
    ? { ...option, action: { ...option.action, melee: false, ranged: true, reach: undefined, range: 60 } } : option);
  const thrown = fight({ ...fanatic, options }, get("Berserker"), 2, true, "max120").log;
  assert.deepEqual(thrown.slice(1, 4), ["Round 1", "Cultist Fanatic moves (30 ft -> 60 ft)", "Cultist Fanatic uses Hold Person"]);
  // And against a flier there is no walking back to count on: a Giant Spider keeps its distance from a Sprite 40 ft up
  // when it throws its Web (seed 2, round 4), and wins the fight.
  const web = fight(get("Sprite"), get("Giant Spider"), 2, true, "max120");
  assert.ok(web.log.includes("Giant Spider moves (40 ft -> 45 ft)"));
  assert.equal(web.winner, 1);
});

test("E13: a condition that takes the foe's turns is priced from the pair, not as a quarter of its Hit Points", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Hold Person on a Bandit Captain (52 hp): a quarter of its Hit Points is 13, under one Pact Blade turn, so it was
  // never cast. The Captain's lost turns and the Fanatic's Advantage meanwhile are worth four tenths (20.8).
  const held = fight(get("Cultist Fanatic"), get("Bandit Captain"), 1, true, "max120").log;
  assert.ok(held.includes("Cultist Fanatic uses Hold Person"));
  // A Silver Dragon Wyrmling opens on a Werewolf with the breath that holds it.
  const breath = fight(get("Silver Dragon Wyrmling"), get("Werewolf"), 1, true, "max120").log;
  assert.ok(breath.includes("Silver Dragon Wyrmling uses Paralyzing Breath"));
  // Negative control: a Ghast's Claw paralyses until the end of the target's next turn only. It keeps the flat price
  // and the Ghast keeps to its Bite.
  const ghast = fight(get("Ghast"), get("Bandit Captain"), 1, true, "max120").log;
  assert.ok(!ghast.includes("Ghast uses Claw") && ghast.includes("Ghast uses Bite"));
});

test("R07: Prone on a faster foe that shoots from out of reach keeps the hampering share", () => {
  // Dragon Turtle, Tail: "If the target is a Huge or smaller creature, it has the Prone condition." A Djinni (Speed 90,
  // Storm Bolt 120 ft) stands on half its Speed and leaves through a Tail made as an Opportunity Attack. Two Bites and
  // a Tail must outbid three Bites: the Bite's 9.5 more damage against 0.08 x 218 = 17.4 for the Prone.
  const turtle = get("Dragon Turtle");
  const bites = turtle.routines.find((r) => r.name === "Multiattack (Bite)")!;
  const tail = turtle.routines.find((r) => r.name === "Multiattack (Bite) + Tail")!;
  const gap = (foe: string) => routineEvAtDistance(tail, turtle, get(foe), 15) - routineEvAtDistance(bites, turtle, get(foe), 15);
  assert.ok(gap("Djinni") > 0);
  assert.ok(gap("Storm Giant") > 0);
  // Negative control: a Purple Worm is faster on land but has nothing to shoot with, so it comes back by itself.
  // Three Bites stay ahead.
  assert.ok(gap("Purple Worm") < 0);
});

test("R06: the Advantage a Bonus Action grapple gives an attack is part of the threat a foe weighs", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Bugbear Stalker: Quick Grapple (Bonus Action, 10 ft, DC 13 Dexterity) and Morningstar, "Advantage if the target is
  // Grappled by the bugbear". Against a Tough Boss (AC 16, hit chance 0.5) the held Morningstar hits 0.75 of the time.
  // The Boss shoots its Heavy Crossbow from 60 ft instead of walking in with its Warhammer (253 wins of 400 against 216).
  const boss = get("Tough Boss");
  const stalker = get("Bugbear Stalker");
  assert.deepEqual(fight(boss, stalker, 1, true, "max120").log.slice(1, 4), ["Round 1", "Tough Boss moves (30 ft -> 60 ft)", "Tough Boss uses Heavy Crossbow"]);
  // Negative control: against the same Stalker with no Advantage printed on its Morningstar the Boss walks in.
  const plain = { ...stalker, options: stalker.options.map((o) => o.name === "Morningstar" && o.action.kind === "attack" ? { ...o, action: { ...o.action, advantageWhen: undefined } } : o) };
  assert.deepEqual(fight(boss, plain, 1, true, "max120").log.slice(1, 4), ["Round 1", "Tough Boss moves (30 ft -> 5 ft)", "Tough Boss uses Warhammer"]);
});

test("E15: a Harpy sings its Luring Song from where it can fly back to its Claws", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Luring Song (range 300 ft): a Charmed target is Incapacitated and walks to the harpy. From 70 ft a Spy that saves
  // is out of the Harpy's 40 ft flight and shoots it on the way back; it rises out of reach and sings from 35 ft.
  const harpy = get("Harpy");
  assert.equal(fight(harpy, get("Spy"), 1, true, "max120").log[2], "Harpy moves (30 ft -> 35 ft) [altitude 0 ft to 40 ft]");
  // Negative control: a song that does not draw its target in is not a follow-up to stay near for.
  const plain = { ...harpy, options: harpy.options.map((o) => o.name === "Luring Song" && o.action.kind === "save"
    ? { ...o, action: { ...o.action, riders: o.action.riders?.map((r) => ({ ...r, drawnToSource: undefined })) } } : o) };
  assert.equal(fight(plain, get("Spy"), 1, true, "max120").log[2], "Harpy moves (30 ft -> 70 ft) [altitude 0 ft to 40 ft]");
});

test("D15: a creature whose reach attack knocks Prone makes its later swings from beside the foe", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Prone: "attack rolls against you have Advantage if the attacker is within 5 feet of you. Otherwise, that attack
  // roll has Disadvantage." A Hill Giant's two Tree Clubs (reach 10 ft, Prone on a hit) from 10 ft put the second at
  // Disadvantage once the first lands; from 5 ft it has Advantage.
  const giant = get("Hill Giant");
  assert.equal(fight(giant, get("Manticore"), 1, true, "max30").log[2], "Hill Giant moves (30 ft -> 5 ft)");
  // Negative control: a Manticore that cannot be knocked Prone is clubbed from 10 ft, out of its reach.
  assert.equal(fight(giant, { ...get("Manticore"), conditionImmune: ["prone"] }, 1, true, "max30").log[2], "Hill Giant moves (30 ft -> 10 ft)");
});

test("D17: a slow creature lets a melee-only foe come to it and Dodges instead of Dashing into its attacks", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Dodge: "any attack roll made against you has Disadvantage". A Mimic (Speed 20) 30 ft from a Polar Bear (Speed 40,
  // Rend only) cannot attack this turn either way; the Bear closes and Rends twice whether it Dashed or not.
  const mimic = get("Mimic");
  assert.deepEqual(fight(mimic, get("Polar Bear"), 1, true, "max120").log.slice(1, 4), ["Round 1", "Mimic moves (30 ft -> 10 ft)", "Mimic dodges"]);
  // Negative control: an Ogre can throw its Javelin from where it stands, so the Mimic still Dashes to it.
  assert.equal(fight(mimic, get("Ogre"), 1, true, "max120").log[2], "Mimic dashes (30 ft -> 5 ft)");
});

test("C18: a faster shooter Dashes clear of a melee foe whose Dash catches it every round", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Opportunity Attacks: "when a creature that you can see leaves your reach". A Centaur Trooper (Speed 50, Longbow
  // 150 ft) stepping away from a Flesh Golem (Speed 30) each round takes a Slam for every volley. One Dash to 100 ft
  // and more costs the Golem several Dashes to close, each of them a volley without that Slam.
  const dashes = (a: string, b: string, scenario: "max30" | "max120") => fight(get(a), get(b), 2, true, scenario).log.filter((l) => l.startsWith(`${a} dashes`)).length;
  assert.ok(dashes("Centaur Trooper", "Flesh Golem", "max120") > 0);
  // Negative controls: a room of 30 feet has nowhere to Dash to, and a Bandit Captain's Pistol (30/90 ft) cannot be
  // fired whole from the gap a Dash opens, so it keeps stepping away.
  assert.equal(dashes("Centaur Trooper", "Flesh Golem", "max30"), 0);
  assert.equal(dashes("Bandit Captain", "Basilisk", "max120"), 0);
});

test("D12: a melee creature with a Bonus Action Disengage strikes and steps out of a slower foe's walk", async () => {
  const { fight } = await import("../src/engine/fight.ts");
  // Nimble Escape: "The tiger takes the Disengage or Hide action." A Saber-Toothed Tiger (Speed 40) beside a Swarm of
  // Venomous Snakes (Speed 30, Bites reach 5) Rends twice, Disengages and walks 40 ft: the swarm must Dash to follow
  // and bites every second round (111 wins of 400 before, 400 after).
  const escapes = (foe: string, scenario: "max30" | "max120") => fight(get("Saber-Toothed Tiger"), get(foe), 1, true, scenario).log;
  const log = escapes("Swarm of Venomous Snakes", "max120");
  const at = log.indexOf("Saber-Toothed Tiger uses bonus action Nimble Escape");
  assert.ok(at > 0);
  assert.equal(log[at - 1].startsWith("Saber-Toothed Tiger "), true);
  assert.equal(log[at + 2], "Saber-Toothed Tiger moves (5 ft -> 40 ft)");
  // Negative controls: a room of 30 feet leaves the swarm's walk in reach, and an Owlbear (Speed 40) walks to wherever
  // the tiger stops. It stands and trades.
  assert.ok(!escapes("Swarm of Venomous Snakes", "max30").includes("Saber-Toothed Tiger uses bonus action Nimble Escape"));
  assert.ok(!escapes("Owlbear", "max120").includes("Saber-Toothed Tiger uses bonus action Nimble Escape"));
});
