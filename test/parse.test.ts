import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAction, parseActionVariants } from "../src/parse/actions.ts";
import { buildRoutines } from "../src/parse/multiattack.ts";
import { compileSpellOptions, spellName } from "../src/parse/spells.ts";
import { BESTIARY_FILES, compileAllDetailed } from "../src/compile.ts";
import type { ActionOption, SkipLog } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const spellData = JSON.parse(fs.readFileSync(path.resolve(here, "../data/spells-srd-5.2.1.json"), "utf8"));
const spells = new Map<string, any>(spellData.spell.map((s: any) => [s.name.toLowerCase(), s]));

test("SRD spell references discard nested descriptive notes", () => {
  assert.equal(spellName("{@spell Shapechange (Beast or Humanoid form only, no Temporary Hit Points gained from the spell, and no Concentration or Temporary Hit Points required to maintain the spell)}"), "Shapechange");
  assert.equal(spellName("Charm Monster (lasts 24 hours; ends early if the dryad casts the spell again)"), "Charm Monster");
});

// --- attack / save parsing (fixtures representative of the SRD data format) ---

test("dragon Rend: to-hit and typed damage clauses", () => {
  const { option } = parseAction({
    name: "Rend",
    entries: ["{@atkr m} {@hit 14}, reach 10 ft. {@h}13 ({@damage 1d10 + 8}) Slashing damage plus 5 ({@damage 2d4}) Fire damage."],
  }, "action", "test");
  assert.ok(option);
  assert.equal(option.action.kind, "attack");
  const action = option.action as any;
  assert.equal(action.toHit, 14);
  assert.deepEqual(action.damage, [
    { dice: { n: 1, d: 10, mod: 8 }, type: "slashing" },
    { dice: { n: 2, d: 4, mod: 0 }, type: "fire" },
  ]);
});

test("dragon Fire Breath: save action with half on success and recharge", () => {
  const { option } = parseAction({
    name: "Fire Breath {@recharge 5}",
    entries: ["{@actSave dex} {@dc 21}, each creature in a 60-foot {@variantrule Cone}. {@actSaveFail} 59 ({@damage 17d6}) Fire damage. {@actSaveSuccess} Half damage."],
  }, "action", "test");
  assert.ok(option);
  assert.equal(option.name, "Fire Breath");
  assert.deepEqual(option.uses, { t: "recharge", min: 5 });
  const action = option.action as any;
  assert.equal(action.kind, "save");
  assert.equal(action.ability, "dex");
  assert.equal(action.dc, 21);
  assert.equal(action.onSuccess, "half");
  assert.deepEqual(action.damage, [{ dice: { n: 17, d: 6, mod: 0 }, type: "fire" }]);
});

test("legacy dice tags compile as attack damage", () => {
  const { option } = parseAction({
    name: "Magical Strike",
    entries: ["{@atk ms} {@hit 8} to hit against one target, reach 10 ft. {@h}22 ({@dice 5d6 + 5}) poison damage."],
  }, "action", "test");
  assert.ok(option);
  assert.deepEqual((option.action as any).damage, [{ dice: { n: 5, d: 6, mod: 5 }, type: "poison" }]);
});

test("ghoul Claw: paralysis rider carries its embedded save", () => {
  const { option } = parseAction({
    name: "Claw",
    entries: ["{@atkr m} {@hit 4}, reach 5 ft. {@h}4 ({@damage 1d4 + 2}) Slashing damage. If the target is a creature that isn't an Undead or elf, it is subjected to the following effect. {@actSave con} {@dc 10}. {@actSaveFail} The target has the {@condition Paralyzed} condition until the end of its next turn."],
  }, "action", "test");
  assert.ok(option);
  const riders = (option.action as any).riders;
  assert.equal(riders.length, 1);
  assert.equal(riders[0].condition, "paralyzed");
  assert.deepEqual(riders[0].save, { ability: "con", dc: 10 });
});

test("attack secondary damage and condition share one saving throw", () => {
  const { option } = parseAction({
    name: "Venomous Bite",
    entries: ["{@atkr m} {@hit 8}, reach 5 ft. {@h}9 ({@damage 1d8 + 5}) Piercing damage, after which the target makes a {@actSave con} {@dc 16} saving throw. {@actSaveFail} 14 ({@damage 4d6}) Poison damage, and the target has the {@condition Poisoned} condition for 1 minute. {@actSaveSuccess} Half damage only."],
  }, "action", "test");
  const action = option!.action as any;
  assert.equal(action.riders.length, 0);
  assert.equal(action.extraSave.ability, "con");
  assert.equal(action.extraSave.riders.length, 1);
  assert.equal(action.extraSave.riders[0].condition, "poisoned");
  assert.deepEqual(action.extraSave.riders[0].save, { ability: "con", dc: 16 });
  assert.equal(action.extraSave.riders[0].duration, "permanent");
});

test("a declinable stun is modeled as stun-or-extra-damage choice", () => {
  const { option } = parseAction({
    name: "Stunning Blade",
    entries: ["{@atkr m} {@hit 17}, reach 10 ft. {@h}31 ({@damage 6d6 + 10}) Force damage, whereupon the target has the {@condition Stunned} condition until the start of the attacker's next turn. Anyone struck can choose not to be {@condition Stunned}; doing so costs an extra 21 Force damage, and that damage bypasses Resistance and Immunity alike."],
  }, "action", "test");
  assert.ok(option);
  const action = option.action as any;
  assert.equal(action.riders.length, 0);
  assert.equal(action.choiceRiders.length, 1);
  assert.deepEqual(action.choiceRiders[0], {
    condition: "stunned",
    duration: "startOfSourceNextTurn",
    damage: [{ dice: { n: 0, d: 1, mod: 21 }, type: "force", bypassResistance: true }],
  });
});

test("legacy versatile damage and later-turn damage are not added to the immediate hit", () => {
  const spear = parseAction({
    name: "Storm Spear",
    entries: ["{@atk mw,rw} {@hit 16} to hit against one target, reach 15 ft., or range 200/600 ft. {@h}23 ({@damage 4d6 + 9}) thunder damage, or 27 ({@damage 4d8 + 9}) thunder damage when used with two hands for a melee thrust."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(spear.damage, [{ dice: { n: 4, d: 6, mod: 9 }, type: "thunder" }]);

  const flames = parseAction({
    name: "Flames {@recharge}",
    entries: ["The burning foe makes a {@dc 24} Dexterity saving throw; a failed save means 36 ({@damage 8d8}) fire damage, a successful one half as much. It repeats the save at the end of each of its turns, and each further failure means 18 ({@damage 4d8}) fire damage."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(flames.damage, [{ dice: { n: 8, d: 8, mod: 0 }, type: "fire" }]);
});

test("legacy attack followed by a prose save becomes an on-hit save burst", () => {
  const boulder = parseAction({
    name: "Hurled Rock",
    entries: ["{@atk rw} {@hit 16} to hit against one target, range 120/480 ft. {@h}27 ({@damage 4d8 + 9}) bludgeoning damage. The one struck makes a {@dc 22} Dexterity saving throw against the rock's impact. On a failed save, the impact deals it 19 ({@damage 3d12}) force damage and leaves it with the {@condition prone} condition as well. On a successful save, it takes half as much damage only."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(boulder.damage, [{ dice: { n: 4, d: 8, mod: 9 }, type: "bludgeoning" }]);
  assert.equal(boulder.extraSave.ability, "dex");
  assert.equal(boulder.extraSave.onSuccess, "half");
  assert.equal(boulder.extraSave.riders[0].condition, "prone");
});

test("choice-list action variants retain separate saves and share their recharge", () => {
  const outcomes = parseActionVariants({
    name: "Breath Weapon {@recharge 5}",
    entries: [
      "The wyrm exhales one of the following breaths:",
      {
        type: "list",
        items: [
          { type: "item", name: "Fire Breath", entries: ["Each creature in a 60-foot cone makes a {@dc 20} Dexterity saving throw; a failed save means 28 ({@damage 8d6}) fire damage, a successful one half as much."] },
          { type: "item", name: "Sleep Breath", entries: ["Each creature in a 60-foot cone makes a {@dc 20} Constitution saving throw and, on a failed save, falls {@condition unconscious} for 1 minute. It repeats the save at the end of each of its turns, and a success ends the effect."] },
        ],
      },
    ],
  }, "action", "test");
  assert.equal(outcomes.length, 2);
  assert.equal((outcomes[0].option!.action as any).ability, "dex");
  assert.equal((outcomes[1].option!.action as any).ability, "con");
  assert.equal((outcomes[1].option!.action as any).riders[0].duration, "saveEndsEachTurn");
  assert.equal((outcomes[0].option!.uses as any).pool, (outcomes[1].option!.uses as any).pool);
});

test("choice branches inherit a saving throw declared in the common header", () => {
  const outcomes = parseActionVariants({
    name: "Gaze",
    entries: [
      "The target makes a {@dc 23} Wisdom saving throw. Should it fail, the source picks one of the following effects to impose:",
      {
        type: "list",
        items: [
          { type: "item", name: "Stunning Gaze", entries: ["The target stays {@condition stunned} until the start of the source's next turn."] },
          { type: "item", name: "Charming Gaze", entries: ["The target is {@condition charmed} by the source until the start of the source's next turn."] },
        ],
      },
    ],
  }, "action", "test");
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map(({ option }) => ({
    name: option!.name,
    ability: (option!.action as any).ability,
    dc: (option!.action as any).dc,
    rider: (option!.action as any).riders[0].condition,
  })), [
    { name: "Stunning Gaze", ability: "wis", dc: 23, rider: "stunned" },
    { name: "Charming Gaze", ability: "wis", dc: 23, rider: "charmed" },
  ]);
});

test("damage-type choices are one damage clause rather than additive hits", () => {
  const action = parseAction({
    name: "Elemental Burst",
    entries: ["{@atkr m,r} {@hit 15}, reach 30 ft. or range 150 ft. {@h}The burst deals {@damage 5d6 + 8} damage of a type the attacker picks: Acid, Cold, Fire, Lightning, or Thunder."],
  }, "action", "test").option!.action as any;
  assert.equal(action.damage.length, 1);
  assert.deepEqual(action.damage[0].typeChoices, ["acid", "cold", "fire", "lightning", "thunder"]);

  const spellDamage = parseAction({
    name: "Spirit Aura",
    entries: ["The target makes a {@dc 18} Wisdom saving throw, taking {@damage 3d8} Radiant damage or {@damage 3d8} Necrotic damage on a failed save."],
  }, "action", "test").option!.action as any;
  assert.equal(spellDamage.damage.length, 1);
  assert.deepEqual(spellDamage.damage[0].typeChoices, ["radiant", "necrotic"]);
});

// --- multiattack routines ---

function opt(name: string): ActionOption {
  return {
    name,
    sourceText: "",
    sourceRef: "test",
    action: { kind: "attack", toHit: 5, damage: [{ dice: { n: 1, d: 6, mod: 2 }, type: "slashing" }], riders: [], magical: false, melee: true, ranged: false },
    uses: { t: "atWill" },
    timing: "action",
  };
}

function routinesFor(multiText: string, options: ActionOption[]) {
  const skipped: SkipLog[] = [];
  const routines = buildRoutines([{ name: "Multiattack", entries: [multiText] }], options, skipped, "Test");
  return { routines, skipped };
}

test("simple multiattack: makes two Bite attacks", () => {
  const { routines } = routinesFor("The ghoul makes two Bite attacks.", [opt("Bite"), opt("Claw")]);
  assert.deepEqual(routines[0], { name: "Multiattack (Bite)", parts: [{ optionIdx: 0, count: 2 }] });
  // single-action routines always appended so recharge/limited actions stay reachable
  assert.ok(routines.some((r) => r.name === "Claw"));
});

test("alternative names: makes two Javelin or Morningstar attacks", () => {
  const { routines } = routinesFor("The bugbear makes two Javelin or Morningstar attacks.", [opt("Javelin"), opt("Morningstar")]);
  const names = routines.map((r) => r.name);
  assert.ok(names.includes("Multiattack (Javelin)"));
  assert.ok(names.includes("Multiattack (Morningstar)"));
});

test("form-suffixed names resolve; replacement variant built", () => {
  const options = [opt("Handaxe (Humanoid or Hybrid Form Only)"), opt("Rend (Bear or Hybrid Form Only)"), opt("Bite (Bear or Hybrid Form Only)")];
  const { routines, skipped } = routinesFor(
    "The werebear makes two attacks, using Handaxe or Rend in any combination. It can replace one attack with a Bite attack.",
    options,
  );
  assert.equal(skipped.length, 0);
  const names = routines.map((r) => r.name);
  assert.ok(names.some((n) => n.startsWith("Multiattack (Handaxe")));
  assert.ok(names.some((n) => n.includes("+ Bite")));
});

test("lettered replacement variants resolve plain actions and spellcasting", () => {
  const options = [opt("Rend"), opt("Paralyzing Breath"), opt("Ice Knife")];
  const { routines, skipped } = routinesFor(
    "The dragon makes three Rend attacks. It can replace one attack with a use of (A) Paralyzing Breath or (B) Spellcasting to cast {@spell Ice Knife} (level 2 version).",
    options,
  );
  assert.equal(skipped.length, 0);
  assert.ok(routines.some((r) => r.name === "Multiattack (Rend) + Paralyzing Breath"
    && JSON.stringify(r.parts) === JSON.stringify([{ optionIdx: 0, count: 2 }, { optionIdx: 1, count: 1 }])));
  assert.ok(routines.some((r) => r.name === "Multiattack (Rend) + Ice Knife"
    && JSON.stringify(r.parts) === JSON.stringify([{ optionIdx: 0, count: 2 }, { optionIdx: 2, count: 1 }])));
  assert.ok(!routines.some((r) => r.name.includes("Ice Knife + Paralyzing Breath")));
});

test("combined clause plus uses: mummy", () => {
  const options = [opt("Rotting Fist"), opt("Channel Negative Energy"), opt("Dreadful Glare")];
  const { routines } = routinesFor("The mummy makes one Rotting Fist or Channel Negative Energy attack, and it uses Dreadful Glare.", options);
  const fist = routines.find((r) => r.name === "Multiattack (Rotting Fist)");
  assert.ok(fist);
  assert.deepEqual(fist.parts, [{ optionIdx: 0, count: 1 }, { optionIdx: 2, count: 1 }]);
});

test("hydra: as many Bite attacks as it has heads = 5", () => {
  const { routines } = routinesFor("The hydra makes as many Bite attacks as it has heads.", [opt("Bite")]);
  assert.deepEqual(routines[0].parts, [{ optionIdx: 0, count: 5 }]);
});

test("legacy multiattack phrasing resolves named, mixed, and generic attacks", () => {
  const named = routinesFor("The creature makes two attacks with its claws.", [opt("Claw")]);
  assert.equal(named.routines[0].parts[0].count, 2);

  const mixed = routinesFor("The creature makes three attacks: one with its gore and two with its stomps.", [opt("Gore"), opt("Stomp")]);
  assert.deepEqual(mixed.routines[0].parts, [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 2 }]);

  const generic = routinesFor("The warrior makes three melee weapon attacks.", [opt("Sword"), opt("Spear")]);
  assert.ok(generic.routines.some((routine) => routine.parts[0].count === 3));

  const times = routinesFor("The soldier attacks three times with any one of its weapons.", [opt("Longsword")]);
  assert.equal(times.routines[0].parts[0].count, 3);
});

test("mixed-slot, fixed-plus-flex, and alternatively multiattacks remain separate", () => {
  const primaryPlus = routinesFor(
    "The brute makes one attack using Shock Blade or Ice Shard, as well as two Slam attacks.",
    [opt("Shock Blade"), opt("Ice Shard"), opt("Slam")],
  ).routines;
  assert.deepEqual(primaryPlus[0].parts, [{ optionIdx: 0, count: 1 }, { optionIdx: 2, count: 2 }]);
  assert.deepEqual(primaryPlus[1].parts, [{ optionIdx: 1, count: 1 }, { optionIdx: 2, count: 2 }]);

  const fixedFlex = routinesFor(
    "The tarrasque makes one Bite attack and three other attacks, using Claw or Tail in any combination.",
    [opt("Bite"), opt("Claw"), opt("Tail")],
  ).routines;
  assert.deepEqual(fixedFlex[0].parts, [{ optionIdx: 0, count: 1 }, { optionIdx: 1, count: 3 }]);

  const alternatives = routinesFor(
    "The brute makes one Stone Club attack and two Fist attacks, then uses Crushing Grip if available. Alternatively, the brute makes two Hurled Rock attacks.",
    [opt("Stone Club"), opt("Fist"), opt("Crushing Grip"), opt("Hurled Rock")],
  ).routines;
  assert.ok(alternatives.some((routine) => routine.parts.length === 3));
  assert.ok(alternatives.some((routine) => routine.parts.length === 1 && routine.parts[0].optionIdx === 3 && routine.parts[0].count === 2));
});

test("generic melee multiattack carries a melee-distance restriction", () => {
  const spear = opt("Spear");
  spear.action = { ...(spear.action as any), ranged: true, range: 200, longRange: 600, reach: 15 };
  const routines = routinesFor("The creature makes two melee attacks.", [spear]).routines;
  assert.equal(routines[0].maxDistance, 15);
});

// --- spell compilation against the SRD spell data ---

function spellMonster(refs: { will?: string[]; daily?: Record<string, string[]> }, cr = 12) {
  return {
    name: "Test Caster",
    cr: String(cr),
    spellcasting: [{
      name: "Spellcasting",
      headerEntries: ["casts spells (spell save {@dc 17}):"],
      ...refs,
      ability: "int",
    }],
  };
}

test("Fireball level 5 version upcasts to 10d6 fire", () => {
  const skipped: SkipLog[] = [];
  const out = compileSpellOptions(spellMonster({ will: ["{@spell Fireball} (level 5 version)"] }), spells, 12, skipped);
  assert.equal(out.length, 1);
  assert.deepEqual((out[0].action as any).damage, [{ dice: { n: 10, d: 6, mod: 0 }, type: "fire" }]);
});

test("Scorching Ray gets 3 rays and DC-8 attack fallback", () => {
  const out = compileSpellOptions(spellMonster({ will: ["{@spell Scorching Ray}"] }), spells, 12, []);
  assert.equal(out.length, 1);
  const action = out[0].action as any;
  assert.equal(action.kind, "attack");
  assert.equal(action.toHit, 9); // dc 17 - 8
  assert.equal(action.damage.length, 3);
  assert.equal(action.damage[0].type, "fire");
});

test("Magic Missile: 3 darts at base, force damage", () => {
  const out = compileSpellOptions(spellMonster({ daily: { "1": ["{@spell Magic Missile}"] } }), spells, 12, []);
  assert.equal(out.length, 1);
  const action = out[0].action as any;
  assert.equal(action.kind, "autohit");
  assert.equal(action.damage.length, 3);
  assert.deepEqual(out[0].uses, { t: "perDay", max: 1 });
});

test("legacy prepared spell slots and object-valued refs compile", () => {
  const monster = {
    name: "Legacy Caster",
    spellcasting: [{
      headerEntries: ["spell save {@dc 17}, {@hit 9} to hit"],
      will: [{ entry: "{@spell Fire Bolt}", hidden: true }],
      spells: {
        "0": { spells: ["{@spell Ray of Frost}"] },
        "1": { slots: 4, spells: ["{@spell Magic Missile}"] },
      },
    }],
  };
  const out = compileSpellOptions(monster, spells, 12, []);
  assert.deepEqual(out.find((o) => o.name === "Fire Bolt")?.uses, { t: "atWill" });
  assert.deepEqual(out.find((o) => o.name === "Ray of Frost")?.uses, { t: "atWill" });
  assert.deepEqual(out.find((o) => o.name === "Magic Missile")?.uses, {
    t: "perDay",
    max: 4,
    pool: "spell-slots:1",
  });
});

test("Fire Bolt cantrip scales with caster level ~ CR", () => {
  const out = compileSpellOptions(spellMonster({ will: ["{@spell Fire Bolt}"] }, 12), spells, 12, []);
  assert.equal(out.length, 1);
  assert.deepEqual((out[0].action as any).damage[0].dice, { n: 3, d: 10, mod: 0 }); // 3d10 at levels 11-16
});

test("non-damage utility spell is skipped and logged", () => {
  const skipped: SkipLog[] = [];
  const out = compileSpellOptions(spellMonster({ will: ["{@spell Detect Magic}"] }), spells, 12, skipped);
  assert.equal(out.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /non-damage/);
});

test("control spells compile as save-riders", () => {
  const out = compileSpellOptions(spellMonster({ will: ["{@spell Hold Monster}", "{@spell Command}", "{@spell Hold Person}"] }), spells, 12, []);
  assert.equal(out.length, 3);
  const holdMonster = out.find((o) => o.name === "Hold Monster")!.action as any;
  assert.equal(holdMonster.kind, "save");
  assert.equal(holdMonster.ability, "wis");
  assert.equal(holdMonster.dc, 17);
  assert.deepEqual(holdMonster.riders[0], { blockedByConditions: ["paralyzed"], condition: "paralyzed", duration: "saveEndsEachTurn", save: { ability: "wis", dc: 17 }, escapeDc: undefined, endsOnDamage: undefined, spellLevel: 5 });
  const command = out.find((o) => o.name === "Command")!.action as any;
  assert.equal(command.riders[0].condition, "commandedGrovel");
  const holdPerson = out.find((o) => o.name === "Hold Person")!.action as any;
  assert.deepEqual(holdPerson.targetTypes, ["humanoid"]);
  assert.equal(holdPerson.range, 60);
});

test("Ice Knife compiles as a hybrid attack + upcast save burst", () => {
  const out = compileSpellOptions(spellMonster({ will: ["{@spell Ice Knife} (level 2 version)"] }), spells, 20, []);
  assert.equal(out.length, 1);
  const a = out[0].action as any;
  assert.equal(a.kind, "attack");
  assert.deepEqual(a.damage, [{ dice: { n: 1, d: 10, mod: 0 }, type: "piercing" }]); // on-hit piercing, correctly typed
  assert.ok(a.extraSave, "should carry a save burst");
  assert.equal(a.extraSave.ability, "dex");
  assert.deepEqual(a.extraSave.damage, [{ dice: { n: 3, d: 6, mod: 0 }, type: "cold" }]); // 2d6 -> 3d6 at level 2
  assert.equal(a.extraSave.onSuccess, "none");
});

test("spell prose damage types parse (not just statblock format)", () => {
  const out = compileSpellOptions(spellMonster({ will: ["{@spell Chromatic Orb}"] }), spells, 12, []);
  // Chromatic Orb is a plain ranged spell attack; its damage should not fall back to untyped
  if (out.length) assert.notEqual((out[0].action as any).damage[0].type, "untyped");
});

test("0-HP-gated riders are dropped (Phase Spider bite)", () => {
  const { option } = parseAction({
    name: "Bite",
    entries: ["{@atkr m} {@hit 5}, reach 5 ft. {@h}8 ({@damage 1d10 + 3}) Piercing damage plus 9 ({@damage 2d8}) Poison damage. If this damage reduces the target to 0 {@variantrule Hit Points}, the target becomes {@variantrule Stable}, and it has the {@condition Poisoned} condition for 1 hour. While {@condition Poisoned}, the target also has the {@condition Paralyzed} condition."],
  }, "action", "test");
  assert.ok(option);
  assert.deepEqual((option.action as any).riders, []); // paralysis only at 0 HP => no combat rider
});

test("dependent 'While X, also Y' inherits the parent's persistence (Giant Octopus)", () => {
  const { option } = parseAction({
    name: "Tentacles",
    entries: ["{@atkr m} {@hit 5}, reach 10 ft. {@h}10 ({@damage 2d6 + 3}) Bludgeoning damage. If the target is a Medium or smaller creature, it has the {@condition Grappled} condition (escape {@dc 13}) from all eight tentacles. While {@condition Grappled}, the target has the {@condition Restrained} condition."],
  }, "action", "test");
  const riders = (option!.action as any).riders;
  assert.equal(riders.length, 2);
  assert.equal(riders[1].condition, "restrained");
  assert.equal(riders[1].duration, "untilEscape"); // tied to the grapple, not permanent
  assert.equal(riders[1].escapeDc, 13);
  assert.equal(riders[1].targetMaxSize, 2);
  assert.equal(riders[1].requiresTargetCondition, "grappled");
});

test("alternative damage clauses remain mutually exclusive (Mimic and swarm)", () => {
  const mimic = parseAction({
    name: "Bite",
    entries: ["{@atkr m} {@hit 5}, reach 5 ft. {@h}7 ({@damage 1d8 + 3}) Piercing damage, or 12 ({@damage 2d8 + 3}) Piercing damage if the target is in the {@condition Grappled} condition, plus 4 ({@damage 1d8}) Acid damage."],
  }, "action", "test").option!.action as any;
  assert.equal(mimic.damage[0].requiresTargetMissingCondition, "grappled");
  assert.equal(mimic.damage[0].requiresTargetCondition, undefined);
  assert.equal(mimic.damage[1].requiresTargetCondition, "grappled");
  assert.equal(mimic.damage[2].requiresTargetCondition, undefined);

  const swarm = parseAction({
    name: "Bites",
    entries: ["{@atkr m} {@hit 4}, reach 0 ft. {@h}5 ({@damage 2d4}) Piercing damage, or 2 ({@damage 1d4}) Piercing damage if the swarm is {@status Bloodied}."],
  }, "action", "test").option!.action as any;
  assert.equal(swarm.damage[0].requiresAttackerNotBloodied, true);
  assert.equal(swarm.damage[0].requiresAttackerBloodied, undefined);
  assert.equal(swarm.damage[1].requiresAttackerBloodied, true);

  const legacySwarm = parseAction({
    name: "Swarm of Bites",
    entries: ["{@atk mw} {@hit 5} to hit against one creature in the swarm's space, reach 0 ft. {@h}13 ({@damage 3d6 + 3}) piercing damage, or 6 ({@damage 1d6 + 3}) piercing damage if by then the thinned swarm has half of their hit points or fewer."],
  }, "action", "test").option!.action as any;
  assert.equal(legacySwarm.damage[0].requiresAttackerNotBloodied, true);
  assert.equal(legacySwarm.damage[1].requiresAttackerBloodied, true);

  // "on the ground" names its own subject; the named creature is the attacker, not the target. The
  // combat model has a vertical axis now, so this is a real gate rather than a given.
  const grounded = parseAction({
    name: "Greatclub",
    entries: ["{@atk mw} {@hit 9} to hit against one target, reach 5 ft. {@h}10 ({@damage 1d8 + 6}) bludgeoning damage, or 19 ({@damage 3d8 + 6}) bludgeoning damage if the brute is on the ground."],
  }, "action", "test").option!.action as any;
  assert.equal(grounded.damage[0].requiresAirborne, "attacker");
  assert.equal(grounded.damage[0].requiresGrounded, undefined);
  assert.equal(grounded.damage[1].requiresGrounded, "attacker");
  assert.equal(grounded.damage[1].requiresAirborne, undefined);

  const overTarget = parseAction({
    name: "Stomp",
    entries: ["{@atk mw} {@hit 9} to hit against one target, reach 5 ft. {@h}10 ({@damage 1d8 + 6}) bludgeoning damage, or 19 ({@damage 3d8 + 6}) bludgeoning damage if the target is on the ground."],
  }, "action", "test").option!.action as any;
  assert.equal(overTarget.damage[1].requiresGrounded, "target");
  assert.equal(overTarget.damage[0].requiresAirborne, "target");
});

test("charge prerequisites govern both extra damage and knockdown", () => {
  const action = parseAction({
    name: "Gore",
    entries: ["{@atkr m} {@hit 3}, reach 5 ft. {@h}4 ({@damage 1d6 + 1}) Piercing damage. If the boar moved 20+ feet straight toward it immediately before the hit, the target takes an extra 3 ({@damage 1d6}) Piercing damage and has the {@condition Prone} condition, the latter only when it is Medium or smaller."],
  }, "action", "test").option!.action as any;
  assert.equal(action.damage[1].requiresMovement, 20);
  assert.equal(action.riders[0].requiresMovement, 20);
  assert.equal(action.riders[0].targetMaxSize, 2);
});

test("sight-dependent target prose is retained", () => {
  const action = parseAction({
    name: "Possession",
    entries: ["{@actSave cha} {@dc 14}, one creature within 5 feet that the apparition can see. {@actSaveFail} The target has the {@condition Incapacitated} condition."],
  }, "action", "test").option!.action as any;
  assert.equal(action.requiresSight, true);
});

test("fail-by-5 escalation is gated separately from a normal fail (Homunculus bite)", () => {
  const { option } = parseAction({
    name: "Bite",
    entries: ["{@atkr m} {@hit 4}, reach 5 ft. {@h}1 Piercing damage, and the target is subjected to the following effect. {@actSave con} {@dc 12}. {@actSaveFail} The target has the {@condition Poisoned} condition until the end of the homunculus's next turn. {@actSaveFailBy 5} The target has the {@condition Poisoned} condition for 1 hour and the {@condition Unconscious} condition while poisoned this way."],
  }, "action", "test");
  const riders = (option!.action as any).riders;
  assert.equal(riders.length, 3);
  assert.equal(riders[0].condition, "poisoned");
  assert.equal(riders[0].saveFailMarginBelow, 5);
  assert.equal(riders[1].condition, "poisoned");
  assert.equal(riders[1].saveFailMargin, 5);
  assert.equal(riders[2].condition, "unconscious");
  assert.equal(riders[2].saveFailMargin, 5);
});

test("target exclusions, object sizes, collision effects, and HP drain stay attached to the right subject", () => {
  const root = parseAction({
    name: "Grasping Vine",
    entries: ["{@atk mw} {@hit 14} to hit against one creature not {@condition grappled} by the vine, reach 30 ft. {@h}The target has the {@condition grappled} condition (escape {@dc 17})."],
  }, "action", "test").option!.action as any;
  assert.equal(root.requiresTargetCondition, undefined);
  assert.deepEqual(root.requiresTargetMissingConditions, ["grappled"]);

  const fling = parseAction({
    name: "Hurl Object",
    entries: ["The brute hurls one Medium or smaller object from somewhere within 60 feet of itself. One creature within 60 feet of the brute makes a {@dc 20} Strength saving throw; a failed save means 21 ({@damage 6d6}) force damage."],
  }, "action", "test").option!.action as any;
  assert.equal(fling.targetMaxSize, undefined);

  const gale = parseAction({
    name: "Howling Gust",
    entries: ["Objects in the gust's area take 22 ({@damage 4d10}) thunder damage apiece. A creature there makes a {@dc 21} Dexterity saving throw or, failing it, will take 22 ({@damage 4d10}) thunder damage too. If the target then collides with a bystander, that other creature is dealt 3 ({@damage 1d6}) bludgeoning damage and lands {@condition prone}."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(gale.damage, [{ dice: { n: 4, d: 10, mod: 0 }, type: "thunder" }]);
  assert.deepEqual(gale.riders, []);

  const drain = parseAction({
    name: "Tentacle",
    entries: ["{@actSave con} {@dc 25}, one creature {@condition Grappled} by the horror. {@actSaveFail} 21 ({@damage 6d6}) Acid damage, plus a further 13 ({@damage 3d8}) Psychic damage. {@actSaveSuccess} Half damage. {@actSaveSuccessOrFail} The target's Hit Point maximum decreases by an amount equal to Psychic damage taken, and the horror regains {@variantrule Hit Points} equal to that amount."],
  }, "action", "test").option!.action as any;
  const psychic = drain.damage.find((d: any) => d.type === "psychic");
  assert.equal(psychic.reducesMaxHp, true);
  assert.equal(psychic.healsAttacker, true);
});

test("an 'or' alternative replaces the base damage instead of adding to it", () => {
  // Unmodelable gate: keep the base value only, never the sum.
  const beak = parseAction({
    name: "Beak",
    entries: ["{@atk mw} {@hit 5} to hit against one target, reach 5 ft. {@h}10 ({@damage 2d6 + 3}) piercing damage, or 17 ({@damage 4d6 + 3}) piercing damage if what the beak strikes is an object."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(beak.damage, [{ dice: { n: 2, d: 6, mod: 3 }, type: "piercing" }]);

  // Attacker Bloodied, phrased with the creature's own name rather than "the swarm".
  const bloodied = parseAction({
    name: "Fang",
    entries: ["{@atkr m} {@hit 5}, reach 5 ft. {@h}6 ({@damage 1d6 + 3}) Piercing damage, or 13 ({@damage 3d6 + 3}) Piercing damage if the brute is {@status Bloodied}."],
  }, "action", "test").option!.action as any;
  assert.equal(bloodied.damage[0].requiresAttackerNotBloodied, true);
  assert.equal(bloodied.damage[1].requiresAttackerBloodied, true);

  // A named attacker effect becomes a mutually exclusive condition pair.
  const enlarged = parseAction({
    name: "Frost Blade",
    entries: ["{@atk mw} {@hit 6} to hit against one target, reach 5 ft. {@h}7 ({@damage 1d6 + 4}) cold damage, or 11 ({@damage 2d6 + 4}) cold damage while it is under the effect of Enlarge."],
  }, "action", "test").option!.action as any;
  assert.equal(enlarged.damage[0].requiresAttackerMissingCondition, "enlarge");
  assert.equal(enlarged.damage[1].requiresAttackerCondition, "enlarge");

  // The alternative branch can restate several values before its gating phrase.
  const reduced = parseAction({
    name: "Poisoned Dagger",
    entries: ["{@atk mw} {@hit 5} to hit against one target, reach 5 ft. {@h}5 ({@damage 1d4 + 3}) piercing damage plus 10 ({@damage 3d6}) poison damage, or 1 piercing damage plus the same 10 ({@damage 3d6}) poison damage while it is under the effect of Reduce."],
  }, "action", "test").option!.action as any;
  assert.equal(reduced.damage.length, 3);
  assert.equal(reduced.damage[1].requiresAttackerMissingCondition, "reduce");
  assert.equal(reduced.damage[2].requiresAttackerCondition, "reduce");
});

test("recurring damage is not also counted as immediate damage", () => {
  // The trigger phrase trails several damage values, so the whole sentence must be judged.
  const constrict = parseAction({
    name: "Constrict",
    entries: ["{@atk mw} {@hit 10} to hit against one Large or smaller creature, reach 15 ft. {@h}16 ({@damage 3d6 + 6}) bludgeoning damage plus 7 ({@damage 2d6}) acid damage, and the coils hold the target {@condition grappled} (escape {@dc 16}). The held target is also {@condition restrained} for as long as the coils hold, that is until this grapple ends, and the squeeze deals it 16 ({@damage 3d6 + 6}) bludgeoning damage plus 7 ({@damage 2d6}) acid damage more at the start of each of its turns."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(constrict.damage, [
    { dice: { n: 3, d: 6, mod: 6 }, type: "bludgeoning" },
    { dice: { n: 2, d: 6, mod: 0 }, type: "acid" },
  ]);
  assert.deepEqual(constrict.riders[0].startTurnDamage, [
    { dice: { n: 3, d: 6, mod: 6 }, type: "bludgeoning" },
    { dice: { n: 2, d: 6, mod: 0 }, type: "acid" },
  ]);
});

test("'N X attacks, N Y attacks, or a combination thereof' are alternatives, not a sum", () => {
  const { routines } = routinesFor(
    "The mage makes three Staff attacks, three Arcane Bolt attacks, or a combination thereof.",
    [opt("Staff"), opt("Arcane Bolt")],
  );
  const multi = routines.filter((r) => r.name.startsWith("Multiattack"));
  assert.deepEqual(multi, [
    { name: "Multiattack (Staff)", parts: [{ optionIdx: 0, count: 3 }] },
    { name: "Multiattack (Arcane Bolt)", parts: [{ optionIdx: 1, count: 3 }] },
  ]);
  // The creature gets three swings, not six.
  for (const routine of multi) {
    assert.equal(routine.parts.reduce((sum, part) => sum + part.count, 0), 3);
  }
});

test("recurring-only damage is kept when it is the action's only damage", () => {
  // A zone whose damage is worded purely as a recurring trigger must not be emptied out;
  // dropping every clause would remove the action entirely.
  const cylinder = parseAction({
    name: "Light Column",
    entries: ["A 30-foot-radius Cylinder of light fills a spot within 60 feet. Each creature that is in the Cylinder as it appears, or that later ends its turn there, makes a {@dc 17} Constitution saving throw, suffering 36 ({@damage 8d8}) radiant damage if it fails, or half as much damage on a successful one."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(cylinder.damage, [{ dice: { n: 8, d: 8, mod: 0 }, type: "radiant" }]);

  // But when an immediate hit exists, the recurring value stays out of it.
  const wall = parseAction({
    name: "Wall of Fire",
    entries: ["When the wall appears, each creature in its area makes a Dexterity saving throw, taking 22 ({@damage 5d8}) Fire damage on a failed save or half as much damage on a successful one. One side of the wall deals 22 ({@damage 5d8}) Fire damage to each creature that ends its turn within 10 feet of that side."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(wall.damage, [{ dice: { n: 5, d: 8, mod: 0 }, type: "fire" }]);
});

test("a hit and its ongoing tick in one sentence stay separated", () => {
  // A hit of 35 (10d6) Fire damage that also sets the target burning for 5 (1d10) Fire damage as each of its turns begins
// is one immediate blast plus a tick, not one recurring effect.
  const blast = parseAction({
    name: "Inferno Blast",
    entries: ["{@actSave dex} {@dc 18}, each creature in a 30-foot-radius Sphere. {@actSaveFail} 35 ({@damage 10d6}) Fire damage, and whatever failed also starts burning, which deals it 5 ({@damage 1d10}) Fire damage more at the start of each of its turns."],
  }, "action", "test").option!.action as any;
  assert.deepEqual(blast.damage, [{ dice: { n: 10, d: 6, mod: 0 }, type: "fire" }]);
});

test("the bundled corpus contains only SRD 5.2.1 monsters", () => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(here, "../data/bestiary-srd-5.2.1.json"), "utf8"));
  const { blocks, excluded } = compileAllDetailed();
  assert.deepEqual(BESTIARY_FILES, ["bestiary-srd-5.2.1.json"]);
  // Every stat block printed in the SRD 5.2.1 bestiary, and nothing else.
  assert.equal(raw.monster.length, 330);
  assert.equal(blocks.length, 330);
  assert.equal(blocks.every((block) => block.source === "SRD"), true);
  assert.deepEqual(excluded, []);
});

test("the bundled data carries no reference to non-SRD sources", () => {
  for (const file of ["bestiary-srd-5.2.1.json", "spells-srd-5.2.1.json"]) {
    const text = fs.readFileSync(path.resolve(here, "../data", file), "utf8");
    for (const marker of ["XMM", "XPHB", "XDMG", "\"page\"", "referenceSources", "otherSources", "soundClip"]) {
      assert.equal(text.includes(marker), false, `${file} should not mention ${marker}`);
    }
    // The SRD says "GM"; the source books say "DM".
    assert.equal(/\bDM\b/.test(text), false, `${file} should not say DM`);
  }
});

test("representative SRD monsters compile their special mechanics", () => {
  const { blocks } = compileAllDetailed();
  const byName = (name: string) => blocks.find((block) => block.name === name)!;

  const tarrasque = byName("Tarrasque");
  assert.ok(tarrasque.routines.some((routine) =>
    routine.parts.reduce((sum, part) => sum + part.count, 0) === 4));

  assert.deepEqual(byName("Troll").regeneration, {
    amount: 15,
    suppressedBy: ["acid", "fire"],
    suppressedByCritical: false,
    deathRule: true,
  });

  assert.deepEqual(byName("Sea Hag").aura?.riders.map((rider) => rider.condition), ["frightened"]);
  assert.deepEqual(byName("Black Pudding").retaliation?.damage, [
    { dice: { n: 1, d: 8, mod: 0 }, type: "acid" },
  ]);
});
