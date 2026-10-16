import assert from "node:assert/strict";
import test from "node:test";
import { compileAllDetailed, compileMonster } from "../src/compile.ts";
import { parseActionVariants } from "../src/parse/actions.ts";
import { compileSpellOptions } from "../src/parse/spells.ts";
import { FightLog, saveRollForTest, slotRuleForTest } from "../src/engine/fight.ts";
import fs from "node:fs";
const monsters = JSON.parse(fs.readFileSync(new URL("../data/bestiary-srd-5.2.1.json", import.meta.url), "utf8")).monster;
const spellRecords = JSON.parse(fs.readFileSync(new URL("../data/spells-srd-5.2.1.json", import.meta.url), "utf8")).spell;
const spells = new Map<string, any>(spellRecords.map((s: any) => [s.name.toLowerCase(), s]));
const { blocks } = compileAllDetailed();
const block = (name: string) => blocks.find(b => b.name === name)!;
const option = (name: string, spell: string) => block(name).options.find(o => o.name === spell)!;

test("SRD teleport spells survive extraction at bonus-action timing", () => {
  for (const name of ["Cloud Giant", "Mage", "Archmage"]) {
    const o = option(name, "Misty Step");
    assert.ok(o, name);
    assert.equal(o.timing, "bonus");
    assert.equal(o.action.kind, "teleport");
    if (o.action.kind === "teleport") assert.equal(o.action.teleport.distance, 30);
  }
});

test("SRD auxiliary spellcasting inherits healing abilities and shares Divine Aid uses", () => {
  for (const [name, spell, n, d, mod] of [
    ["Deva", "Cure Wounds", 2, 8, 5], ["Planetar", "Cure Wounds", 2, 8, 7],
    ["Solar", "Cure Wounds", 4, 8, 10], ["Priest Acolyte", "Healing Word", 2, 4, 2],
    ["Priest", "Healing Word", 2, 4, 3], ["Guardian Naga", "Cure Wounds", 12, 8, 4],
  ] as const) {
    const o = option(name, spell);
    assert.ok(o, name);
    assert.equal(o.action.kind, "selfheal");
    if (o.action.kind === "selfheal") assert.deepEqual(o.action.healing, { n, d, mod }, name);
    assert.equal(o.timing, name === "Guardian Naga" ? "action" : "bonus");
  }
  assert.deepEqual(option("Planetar", "Cure Wounds").uses, option("Planetar", "Invisibility").uses);
  assert.deepEqual(option("Planetar", "Cure Wounds").uses, { t: "perDay", max: 2, pool: "daily-shared:Divine Aid (2/Day)" });
});

test("SRD Spiritual Weapon retains its attack modifier, ability damage and daily uses", () => {
  const o = option("Cultist Fanatic", "Spiritual Weapon");
  assert.ok(o);
  assert.equal(o.timing, "bonus");
  assert.deepEqual(o.uses, { t: "perDay", max: 2 });
  assert.equal(o.action.kind, "attack");
  if (o.action.kind === "attack") {
    assert.equal(o.action.toHit, 4);
    assert.deepEqual(o.action.damage, [{ dice: { n: 1, d: 8, mod: 2 }, type: "force" }]);
    assert.equal(o.action.concentration, true);
  }
});

test("SRD Sphinx roars advance through three separate effects with shared uses", () => {
  const b = block("Sphinx of Valor"), roars = b.options.filter(o => o.sequence);
  assert.equal(roars.length, 3);
  assert.deepEqual(roars.map(o => o.sequence!.position), [0, 1, 2]);
  const sequenceState = slotRuleForTest.initState(b);
  for (let step = 0; step < 3; step++) {
    assert.deepEqual(roars.map(o => slotRuleForTest.usable(sequenceState, b.options.indexOf(o), o)),
      roars.map((_, i) => i === step));
    slotRuleForTest.spend(sequenceState, b.options.indexOf(roars[step]), roars[step]);
  }
  assert.ok(roars.every(o => !slotRuleForTest.usable(sequenceState, b.options.indexOf(o), o)));
  assert.ok(roars.every(o => o.uses.t === "perDay" && o.uses.max === 3 && o.uses.pool === roars[0].sequence!.pool));
  assert.deepEqual(roars.map(o => o.action.kind === "save" ? o.action.ability : null), ["wis", "wis", "con"]);
  assert.deepEqual(roars.map(o => o.action.kind === "save" ? o.action.riders!.map(r => r.condition) : []), [["frightened"], ["paralyzed"], ["prone"]]);
  assert.ok(roars[2].action.kind === "save");
  if (roars[2].action.kind === "save") assert.deepEqual(roars[2].action.damage, [{ dice: { n: 8, d: 10, mod: 0 }, type: "thunder" }]);
  const target = { ...block("Guard"), hpAvg: 1000, saves: { wis: -40, con: -40 } };
  const as = saveRollForTest.initState(b), ds = saveRollForTest.initState(target);
  saveRollForTest.resolveAction(b, target, as, ds, roars[0].action, () => 0.5, 0, 5, new FightLog(false));
  assert.deepEqual(ds.conditions.map(c => c.name), ["frightened"]);
  assert.equal(ds.hp, 1000);
});

test("SRD upcast healing reaches the fight engine", () => {
  const b = block("Guardian Naga"), o = option(b.name, "Cure Wounds");
  assert.ok(o);
  const as = saveRollForTest.initState(b), ds = saveRollForTest.initState(b);
  as.hp = 1;
  saveRollForTest.resolveAction(b, b, as, ds, o.action, () => 0.5, 0, 5, new FightLog(false));
  assert.equal(as.hp, 65);
});

test("SRD healing and charge repairs preserve damage upcasting and Shield budgets", () => {
  for (const name of ["Ancient Gold Dragon", "Guardian Naga"]) {
    const a = option(name, "Flame Strike").action;
    assert.equal(a.kind, "save");
    if (a.kind === "save") assert.deepEqual(a.damage.map(d => d.dice), [{ n: 6, d: 6, mod: 0 }, { n: 6, d: 6, mod: 0 }]);
  }
  for (const name of ["Mage", "Archmage"]) {
    const uses = block(name).reaction?.uses;
    assert.equal(uses?.t, "perDay");
    if (uses?.t === "perDay") assert.equal(uses.max, 3);
    assert.deepEqual(uses, block(name).counterspell?.option.uses);
  }
  assert.equal(block("Lich").reaction?.uses?.t, "atWill");
  assert.ok(option("Green Hag", "Invisibility"));
});

test("compiler accepts older SRD extraction formats without mutating input", () => {
  const m = structuredClone(monsters.find((m: any) => m.name === "Cultist Fanatic"));
  const auxiliary = m.spellcasting.find((b: any) => b.name.startsWith("Spiritual Weapon"));
  delete auxiliary.ability;
  const oldSpell = structuredClone(spells.get("spiritual weapon"));
  oldSpell.time[0].unit = "bonusaction";
  oldSpell.entries = oldSpell.entries.map((s: any) => typeof s === "string" ? s.replace("{@damage 1d8}", "{@dice 1d8}") : s);
  const oldSpells = new Map(spells).set("spiritual weapon", oldSpell);
  const before = JSON.stringify({ m, oldSpell });
  const out = compileSpellOptions(m, oldSpells, 2, []);
  const o = out.find(o => o.name === "Spiritual Weapon")!;
  assert.equal(o.timing, "bonus");
  if (o.action.kind !== "attack") assert.fail("no spell attack");
  assert.equal(o.action.damage[0].dice.mod, 2);
  assert.equal(JSON.stringify({ m, oldSpell }), before);
  // An unrelated block without an ability must not silently borrow Wisdom.
  auxiliary.headerEntries = ["The cultist casts Spiritual Weapon."];
  const unrelated = compileSpellOptions(m, oldSpells, 2, []).find(o => o.name === "Spiritual Weapon")!;
  assert.equal(unrelated.action.kind, "attack");
  if (unrelated.action.kind === "attack") assert.equal(unrelated.action.damage[0].dice.mod, 0);
  // An explicit ability takes priority over inherited Wisdom.
  auxiliary.headerEntries = ["using the same spellcasting ability as Spellcasting"];
  auxiliary.ability = "cha";
  const explicit = compileSpellOptions(m, oldSpells, 2, []).find(o => o.name === "Spiritual Weapon")!;
  if (explicit.action.kind !== "attack") assert.fail("no explicit spell attack");
  assert.equal(explicit.action.damage[0].dice.mod, Math.floor((m.cha - 10) / 2));
});

test("compiler recovers a flattened Roar only when its sequence is explicitly announced", () => {
  const roar = monsters.find((m: any) => m.name === "Sphinx of Valor").action.find((a: any) => a.name === "Roar (3/Day)");
  const list = roar.entries.find((e: any) => e?.type === "list");
  assert.ok(list, "regenerated SRD must retain sequence structure");
  const text = roar.entries[0] + " " + list.items.map((i: any) => i.name + ". " + i.entries.join(" ")).join(" ");
  const recovered = parseActionVariants({ ...roar, entries: [text] }, "action", "test");
  assert.deepEqual(recovered.map(o => o.option?.sequence?.position), [0, 1, 2]);
  const plain = parseActionVariants({ name: "Roar", entries: [text.slice(text.indexOf("First Roar."))] }, "action", "test");
  assert.ok(plain.every(o => !o.option?.sequence));
});

test("regenerated SRD uses canonical time units, healing scaling, reaction triggers and inherited abilities", () => {
  assert.ok(spellRecords.every((s: any) => s.time.every((t: any) => t.unit !== "bonusaction")));
  for (const name of ["Cure Wounds", "Healing Word", "Mass Cure Wounds"]) {
    assert.match(JSON.stringify(spells.get(name.toLowerCase()).entriesHigherLevel), /scaledice/);
  }
  for (const name of ["Counterspell", "Feather Fall", "Hellish Rebuke", "Shield"]) {
    const s = spells.get(name.toLowerCase());
    assert.match(s.time[0].condition, /which you take/);
    assert.ok(!s.entries[0].startsWith("taking damage from"));
  }
  assert.match(spells.get("hellish rebuke").time[0].condition, /taking damage from a creature that you can see within 60 feet of yourself/);
  assert.match(JSON.stringify(spells.get("spiritual weapon").entries), /\{@damage 1d8\}/);
  for (const m of monsters) for (const b of m.spellcasting || []) {
    if (/same spellcasting ability/.test(JSON.stringify(b.headerEntries))) assert.ok(b.ability, m.name + ": " + b.name);
  }
});

test("compiler accepts older healing scaling tags", () => {
  const m = monsters.find((m: any) => m.name === "Guardian Naga");
  const oldSpell = JSON.parse(JSON.stringify(spells.get("cure wounds")).replaceAll("scaledice", "scaledamage"));
  const b = compileMonster(m, new Map(spells).set("cure wounds", oldSpell));
  const o = b.options.find(o => o.name === "Cure Wounds")!;
  if (o.action.kind !== "selfheal") assert.fail("no healing action");
  assert.deepEqual(o.action.healing, { n: 12, d: 8, mod: 4 });
});
