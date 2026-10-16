// Checks on the compiled pilot blocks: `node pc-pilot/check.mjs`. Each one names a mistake that was made once.
import assert from "node:assert/strict";
import { compilePilot } from "./compile.mjs";

const blocks = compilePilot();
const get = (name) => blocks.find((b) => b.name.startsWith(`${name} `));
const LEVELS = [1, 5, 11, 17];

assert.equal(blocks.length, 48);
for (const b of blocks) {
  // A routine or reaction must point at an option that exists.
  for (const r of b.routines) for (const p of r.parts) assert.ok(b.options[p.optionIdx], `${b.name}: routine ${r.name}`);
  // Only the skips the README names: a spell printed as its own action, Shield (it is the reaction), and three spells the compiler has no model for.
  for (const s of b.skipped) assert.match(`${s.name}: ${s.reason}`, /printed as its own action|^Shield:|^(Eyebite|Sleet Storm|Wall of Thorns):/, b.name);
}

// Divine Smite: (slot level + 1)d8 Radiant, and 1d8 more against a Fiend or an Undead, at every slot level.
for (const L of LEVELS) {
  const smites = get(`Paladin ${L}`).options.filter((o) => /^Divine Smite/.test(o.name));
  const slotLevels = { 1: 1, 5: 2, 11: 3, 17: 5 }[L];
  assert.equal(smites.length, slotLevels, `Paladin ${L}: one smite a slot level`);
  for (const o of smites) {
    const level = Number(o.name.match(/level (\d)/)?.[1] ?? slotLevels);
    const typed = o.action.damage.filter((d) => d.targetTypes);
    const smite = o.action.damage.filter((d) => d.type === "radiant" && !d.targetTypes).at(-1);
    assert.equal(smite.dice.n, level + 1, `Paladin ${L}: ${o.name}`);
    assert.deepEqual(typed.map((d) => d.dice.n), [1], `Paladin ${L}: ${o.name} against a Fiend`);
  }
}

// Shield is paid from level 1 slots, also where the block has Counterspell.
for (const b of blocks.filter((x) => x.reaction?.kind === "shield")) assert.equal(b.reaction.uses.pool, "spell-slots:1", b.name);

// The monk's Focus Points: Stunning Strike, Flurry of Blows and Quivering Palm (4 each) fit in one point a level.
for (const L of LEVELS.slice(1)) {
  const uses = (re) => get(`Monk ${L}`).options.find((o) => re.test(o.name))?.uses.max ?? 0;
  assert.ok(uses(/^Stunning Strike/) + uses(/^Flurry of Blows/) + 4 * uses(/^Quivering Palm/) <= L, `Monk ${L}`);
}
assert.equal(get("Monk 5").options[0].action.damage[0].type, "bludgeoning");
assert.equal(get("Monk 11").options[0].action.damage[0].type, "force");

// Subclass features start after level 1.
assert.equal(get("Sorcerer 1").ac, 11);
assert.equal(get("Sorcerer 1").hpAvg, 8);

// Mystic Arcanum: one spell at level 11, four at 17.
const arcana = (L) => get(`Warlock ${L}`).options.filter((o) => /^(Circle of Death|Finger of Death|Power Word (Stun|Kill))$/.test(o.name) && !o.uses.pool).length;
assert.deepEqual([arcana(5), arcana(11), arcana(17)], [0, 1, 4]);

// Rage damage is on both Strength attacks; Colossus Slayer needs a hurt target.
for (const o of get("Barbarian 5").options.filter((x) => /^(Maul|Javelin)$/.test(x.name))) assert.ok(o.action.damage.some((d) => d.requiresAttackerCondition === "raging" && !d.oncePerTurn), o.name);
assert.ok(get("Ranger 5").options[0].action.damage.some((d) => d.oncePerTurn && d.requiresTargetHurt));

// Level 11 and 17 martial features.
// Relentless Rage is a one-time reset, not Undead Fortitude; Danger Sense and Feral Instinct are baked in.
for (const [L, hp] of [[11, 39], [17, 81]]) {
  const b = get(`Barbarian ${L}`);
  assert.equal(b.undeadFortitude, false, `Barbarian ${L}`);
  assert.equal(b.mythicResetHp, hp, `Barbarian ${L}`);
  assert.equal(b.initiativeBonus, 4, `Barbarian ${L}: Feral Instinct`);
}
assert.equal(get("Barbarian 5").saves.dex, 5, "Danger Sense");
assert.equal(get("Barbarian 17").options.find((o) => /^Intimidating Presence/.test(o.name)).action.riders[0].duration, "saveEndsEachTurn");
// Steady Aim is the engine's aiming buff at Bonus Action timing.
for (const L of [5, 11, 17]) assert.ok(get(`Rogue ${L}`).options.some((o) => o.timing === "bonus" && o.action.condition === "aiming"), `Rogue ${L}: Steady Aim`);
assert.ok(get("Rogue 17").routines.some((r) => r.name === "Thief's Reflexes" && r.parts.length === 4));
// Heightened Focus: the Flurry carries one more strike; Deflect Attacks cancels a hit.
for (const L of [11, 17]) assert.ok(get(`Monk ${L}`).options.find((o) => /^Flurry of Blows/.test(o.name)).action.followUp, `Monk ${L}`);
for (const L of [5, 11, 17]) assert.equal(get(`Monk ${L}`).reaction.kind, "damageNegation", `Monk ${L}`);
assert.ok(get("Monk 17").routines.some((r) => r.name === "Quivering Palm" && r.parts.some((p) => p.replacesAttack)));
// Roving, Nature's Veil, Remarkable Athlete, the level 1 smite pool.
assert.deepEqual([5, 11, 17].map((L) => get(`Ranger ${L}`).speed), [30, 40, 40]);
assert.ok(get("Ranger 17").options.some((o) => /^Nature's Veil/.test(o.name) && o.action.condition === "invisible"));
assert.equal(get("Fighter 5").initiativeBonus, 4);
assert.deepEqual(get("Paladin 1").options.find((o) => /^Divine Smite/.test(o.name)).uses, { t: "perDay", max: 3 });

console.log("pc-pilot checks passed");
