// The twelve SRD 5.2.1 classes at levels 1, 5, 11 and 17, as bestiary-format records plus post-compile patches.
// `raw` goes through the ordinary compiler. `patch` then sets compiled fields the engine reads but no stat-block
// wording reaches (once-a-turn damage, always-on Advantage, half damage on a miss). See README.md for every hack.
// `notes` says in plain words what the patch and the baked-in numbers do; markdown.mjs prints it under the block.
export const LEVELS = [1, 5, 11, 17];
const PB = [2, 3, 4, 6];
const ord = (n) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
const mod = (score) => Math.floor((score - 10) / 2);
const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);

/** "2d6 + 4" -> "11 ({@damage 2d6 + 4})" */
function dmg(expr, tag = "damage") {
  const m = String(expr).replace(/\s/g, "").match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!m) return `${expr}`;
  const avg = Math.floor(Number(m[1]) * (Number(m[2]) + 1) / 2 + Number(m[3] || 0));
  return `${avg} ({@${tag} ${m[1]}d${m[2]}${m[3] ? ` ${m[3][0]} ${m[3].slice(1)}` : ""}})`;
}
const dice = (n, d, bonus = 0) => `${n}d${d}${bonus ? `+${bonus}` : ""}`;
const act = (name, text) => ({ name, entries: [text] });
const melee = (name, hit, parts, tail = "") => act(name, `{@atkr m} {@hit ${hit}}, reach 5 ft. {@h}${parts}${tail}.`);
const ranged = (name, hit, range, parts, tail = "", spell = false) => act(name, `{@atkr ${spell ? "rs" : "r"}} {@hit ${hit}}, range ${range} ft. {@h}${parts}${tail}.`);
const thrown = (name, hit, range, parts) => act(name, `{@atkr m,r} {@hit ${hit}}, reach 5 ft. or range ${range} ft. {@h}${parts}.`);
const save = (name, ability, dc, target, fail, half = true) => act(name, `{@actSave ${ability}} {@dc ${dc}}, ${target}. {@actSaveFail} ${fail}${half ? " {@actSaveSuccess} Half damage." : ""}`);
const heal = (name, amount) => act(name, `The character regains ${/d/.test(String(amount)) ? dmg(amount, "dice") : amount} Hit Points.`);
const sp = (...names) => names.map((n) => { const m = n.match(/^(.*?) \((.*)\)$/); return m ? `{@spell ${m[1]}} (${m[2]})` : `{@spell ${n}}`; });
const up = (name, level) => `${name} (level ${level} version)`;
const EVASION = { name: "Evasion", entries: ["If the character is subjected to an effect that allows it to make a Dexterity saving throw to take only half damage, the character instead takes no damage if it succeeds on the save and only half damage if it fails. It can't use this trait if it has the {@condition Incapacitated} condition."] };
const HALVE = (name) => ({ name, entries: ["{@actTrigger} The character is hit by an attack roll from an attacker it can see. {@actResponse} The character halves the attack's damage against it."] });

const FULL_SLOTS = [[2], [4, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1]];
const HALF_SLOTS = [[2], [4, 2], [4, 3, 3], [4, 3, 3, 3, 1]];

/** A slot-list spellcasting block. `lists[k]` is the spell list for slot level k (0 = cantrips). */
function casting(i, ability, dc, hit, slots, lists, klass) {
  const spells = {};
  lists.forEach((list, level) => {
    if (!list?.length) return;
    spells[level] = level === 0 ? { spells: sp(...list) } : { slots: slots[level - 1], spells: sp(...list) };
  });
  const names = { int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
  return { name: "Spellcasting", type: "spellcasting", ability, spells,
    headerEntries: [`The character is ${LEVELS[i] === 11 ? "an" : "a"} ${ord(LEVELS[i])}-level spellcaster. Its spellcasting ability is ${names[ability]} (spell save {@dc ${dc}}, {@hit ${hit}} to hit with spell attacks). It has the following ${klass} spells prepared:`] };
}

/** Common frame: ability scores, hit points, saves. */
function frame(i, klass, sub, scores, hd, ac, saveProfs, extra = {}) {
  const L = LEVELS[i];
  const con = mod(scores.con);
  const all = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...scores };
  const saveBonus = extra.saveBonus || 0;
  const saves = {};
  for (const a of Object.keys(all)) {
    const total = mod(all[a]) + (saveProfs.includes(a) ? PB[i] : 0) + saveBonus;
    if (saveProfs.includes(a) || saveBonus) saves[a] = sign(total);
  }
  const hp = hd + con + (L - 1) * (hd / 2 + 1 + con) + (extra.hpBonus || 0);
  const raw = { name: `${klass} ${L} (${sub})`, source: "PC", size: ["M"], type: "humanoid", ...all,
    ac: [ac], hp: { average: hp, formula: `${L}d${hd} + ${L * con}` }, speed: extra.speed || { walk: 30 },
    save: saves, languages: ["Common"], cr: String(L) };
  if (all.str >= 14) raw.skill = { athletics: sign(mod(all.str) + PB[i]) };
  else if (all.dex >= 14) raw.skill = { acrobatics: sign(mod(all.dex) + PB[i]) };
  return raw;
}
const prim = [17, 18, 20, 20];
const conStd = [15, 16, 16, 18];
const conMartial = [15, 16, 18, 20];
const second = [15, 16, 16, 20];
const opt = (compiled, re) => compiled.options.filter((o) => re.test(o.name));
const topple = (dc) => `, and the target must succeed on a {@dc ${dc}} Constitution saving throw or have the {@condition Prone} condition`;

// ---------------------------------------------------------------------------------------------------------------
function fighter(i) {
  // Heroic Warrior (level 10): a reroll each turn, spent on the first miss, is worth about +3 to hit with three swings.
  const heroic = i >= 2 ? 3 : 0;
  const str = mod(prim[i]), hit = PB[i] + str + heroic, n = [1, 2, 3, 3][i];
  const raw = frame(i, "Fighter", "Champion", { str: prim[i], con: conMartial[i], dex: 13, wis: 12, cha: 8 }, 10, [17, 19, 19, 19][i], ["str", "con"]);
  // Great Weapon Fighting is +1 from 11. Superior Critical (crit on 18-20) is +1 more at 17: the engine has no
  // critical-range field, and Improved Critical alone is under half a point a hit.
  const gwf = i >= 2 ? 1 : 0, crit = i >= 3 ? 1 : 0;
  raw.trait = [];
  const indomitable = [0, 0, 1, 3][i];
  if (indomitable) raw.trait.push({ name: "Indomitable", entries: [`Written as Legendary Resistance (${indomitable}/Day): if the character fails a saving throw, it can choose to succeed instead.`] });
  raw.action = [
    ...(n > 1 ? [act("Multiattack", `The character makes ${["", "", "two", "three"][n]} attacks, using Maul or Javelin in any combination.`)] : []),
    melee("Maul", hit, `${dmg(dice(2, 6, str + gwf + crit))} Bludgeoning damage`, topple(8 + PB[i] + str)),
    thrown("Javelin", hit, "30/120", `${dmg(dice(1, 6, str))} Piercing damage`),
  ];
  raw.bonus = [heal(`Second Wind (${[2, 3, 4, 4][i]}/Day)`, dice(1, 10, LEVELS[i]))];
  // Action Surge: a second Attack action in the same turn. A limited copy of the Maul holds one use per extra swing
  // (the engine charges each swing), and one routine makes the ordinary swings and then the surge swings. Two surges
  // at level 17 are six uses, three a turn.
  const patch = (c) => {
    // Remarkable Athlete (level 3): Advantage on Initiative, as +3.
    if (i >= 1) c.initiativeBonus += 3;
    const uses = [0, 2, 3, 6][i];
    const maul = c.options.findIndex((o) => o.name === "Maul");
    if (!uses || maul < 0) return;
    c.options.push({ ...structuredClone(c.options[maul]), name: "Action Surge (Maul)", uses: { t: "perDay", max: uses } });
    c.routines.unshift({ name: "Action Surge", parts: [{ optionIdx: maul, count: n }, { optionIdx: c.options.length - 1, count: n }] });
  };
  const notes = [i >= 3 ? "Superior Critical is +1 Maul damage; the engine scores a Critical Hit only on a 20." : "Improved Critical is not modelled (under half a point a hit)."];
  if (i) notes.push("Remarkable Athlete is +3 Initiative.", `Action Surge (${i >= 3 ? 2 : 1}/Day): the ${n} Maul attacks of a turn are followed by ${n} more.`);
  if (gwf) notes.push("Great Weapon Fighting is +1 in the Maul's damage.");
  if (heroic) notes.push("Heroic Warrior is +3 to hit: a reroll each turn, spent on the first miss.", "Indomitable is written as Legendary Resistance, an automatic success; the printed reroll with the fighter's level added sometimes fails.");
  return { raw, patch, notes };
}

function barbarian(i) {
  const str = mod(prim[i]), hit = PB[i] + str, rage = [2, 2, 3, 4][i], reckless = i >= 1;
  // Unarmoured at level 1, half plate after. Reckless Attack is always on from level 2: Advantage on its own attacks
  // (patched) and AC lowered by 4 to stand for the Advantage it hands the foe.
  const raw = frame(i, "Barbarian", "Berserker", { str: prim[i], con: conStd[i], dex: 13, wis: 12, cha: 8 }, 12, [13, 16, 16, 16][i] - (reckless ? 4 : 0), ["str", "con"], { speed: { walk: i ? 40 : 30 } });
  if (i >= 2) raw.conditionImmune = ["charmed", "frightened"];
  // Relentless Rage (level 11) is the patch's one-time Hit Point reset; this trait is printed for reading and the parser drops it.
  const relentless = [0, 0, 39, 81][i];
  raw.trait = i >= 2 ? [{ name: "Relentless Rage", entries: [`If the character drops to 0 Hit Points while raging and doesn't die outright, it can make a DC 10 Constitution saving throw (DC 5 higher each later use). On a success, its Hit Points instead change to twice its Barbarian level. Modelled as one reset to ${relentless} Hit Points.`] }] : [];
  const raging = (type) => ` plus ${dmg(dice(1, 1, rage - 1))} ${type} damage while raging`;
  raw.action = [
    ...(i ? [act("Multiattack", "The character makes two attacks, using Maul or Javelin in any combination.")] : []),
    melee("Maul", hit, `${dmg(dice(2, 6, str))} Bludgeoning damage${raging("Bludgeoning")}`, topple(8 + PB[i] + str)),
    thrown("Javelin", hit, "30/120", `${dmg(dice(1, 6, str))} Piercing damage${raging("Piercing")}`),
  ];
  raw.bonus = [act(`Rage (${[2, 3, 4, 6][i]}/Day)`, "The character enters a rage that lasts for 10 minutes. While raging, it has resistance to Bludgeoning, Piercing, and Slashing damage.")];
  // Intimidating Presence: one free use, then a Rage use restores it; one Rage runs the fight, so six uses at 17.
  if (i >= 3) raw.bonus.push(save("Intimidating Presence (6/Day)","wis", 8 + PB[i] + str, "one creature within 30 feet that the character can see", "The target has the {@condition Frightened} condition for 1 minute. At the end of each of its turns, the target repeats the save, ending the effect on itself on a success.", false));
  if (i >= 2) raw.reaction = [act("Retaliation", "{@actTrigger} The character takes damage from a creature within 5 feet of it. {@actResponse} The character makes one Maul attack against that creature.")];
  const patch = (c) => {
    if (reckless) c.attackAdvantage = true;
    // Frenzy: the first hit of a turn while raging and reckless. At 17 it also carries Improved Brutal Strike's worth
    // (+5): the engine can't drop Advantage on one swing, and all once-a-turn clauses share one flag a turn.
    if (reckless) for (const o of opt(c, /^Maul$/)) o.action.damage.push({ dice: { n: rage, d: 6, mod: i >= 3 ? 5 : 0 }, type: "bludgeoning", oncePerTurn: true, requiresAttackerCondition: "raging" });
    // Danger Sense (level 2): Advantage on Dexterity saves, as +4. Feral Instinct (level 7): Advantage on Initiative, as +3.
    if (i >= 1) c.saves.dex = (c.saves.dex ?? c.abilityMods.dex) + 4;
    if (i >= 2) c.initiativeBonus += 3;
    if (relentless) { c.undeadFortitude = false; c.mythicResetHp = relentless; c.mythicResetReplaces = true; }
  };
  const notes = reckless ? [
    "Reckless Attack is always on: Advantage on every attack roll, and the AC shown is half plate's 16 less 4 for the Advantage it gives the foe.",
    `Frenzy: the first Maul hit of each turn while raging deals ${rage}d6${i >= 3 ? " + 5" : ""} more Bludgeoning damage${i >= 3 ? " (the +5 is Improved Brutal Strike's net worth over keeping Advantage)" : ""}.`,
    "Danger Sense is +4 on Dexterity saves.",
  ] : [];
  if (i >= 2) notes.push("Feral Instinct is +3 Initiative.", `Relentless Rage is one reset to ${relentless} Hit Points, the expected total of its repeated saves; it is not tied to raging.`);
  if (i === 2) notes.push("Brutal Strike is left out: giving up Advantage for 1d10 is worth about nothing with Frenzy.");
  if (i >= 3) notes.push("Intimidating Presence: one free use and five more from spare Rage uses. The planner rarely or never chooses it.");
  return { raw, patch, notes };
}

function rogue(i) {
  const dex = mod(prim[i]), hit = PB[i] + dex, sa = [1, 3, 6, 9][i];
  const raw = frame(i, "Rogue", "Thief", { dex: prim[i], con: conMartial[i], wis: 13, int: 12, str: 8 }, 8, 11 + (i ? 1 : 0) + dex, i >= 3 ? ["dex", "int", "wis", "cha"] : ["dex", "int"]);
  const sneak = (type) => ` plus ${dmg(dice(sa, 6))} ${type} damage if the attack roll had {@variantrule Advantage}`;
  const vex = ", and the character has {@variantrule Advantage} on the next attack roll it makes before the end of this turn";
  raw.trait = i >= 2 ? [EVASION] : [];
  raw.action = [
    act("Multiattack", "The character makes one Shortsword attack and one Scimitar attack."),
    melee("Shortsword", hit, `${dmg(dice(1, 6, dex))} Piercing damage${sneak("Piercing")}`, vex),
    melee("Scimitar", hit, `${dmg(dice(1, 6))} Slashing damage${sneak("Slashing")}`),
    ranged("Shortbow", hit, "80/320", `${dmg(dice(1, 6, dex))} Piercing damage${sneak("Piercing")}`, vex),
  ];
  // Steady Aim (level 3) compiles to the engine's "aiming" buff, taken before the action. The engine cannot check that
  // the rogue has not moved this turn.
  if (i) raw.bonus = [act("Cunning Action", "The character takes the Dash, Disengage, or Hide action."), act("Steady Aim", "The character has {@variantrule Advantage} on the next attack roll it makes this turn.")];
  if (i) raw.reaction = [HALVE("Uncanny Dodge")];
  const patch = (c) => {
    for (const o of opt(c, /^(Shortsword|Scimitar|Shortbow)$/)) {
      for (const clause of o.action.damage) if (clause.requiresAttackAdvantage) clause.oncePerTurn = true;
      // Vex lasts to the end of the rogue's next turn, not this one.
      for (const r of o.action.selfRidersOnHit || []) { delete r.endsThisTurn; r.duration = "endOfSourceNextTurn"; }
    }
    // Thief's Reflexes (level 17): a second turn in round 1, as a 1/Day routine like the fighter's Action Surge. The
    // second turn's Shortsword carries its own Sneak Attack (all once-a-turn clauses share one flag a turn) and swings
    // second, on the Vex Advantage of the first; its Scimitar carries none.
    if (i >= 3) {
      const ss = c.options.findIndex((o) => o.name === "Shortsword"), sc = c.options.findIndex((o) => o.name === "Scimitar");
      const copy = (idx, name, keepSneak) => {
        const o = structuredClone(c.options[idx]);
        o.name = o.action.actionName = name; o.uses = { t: "perDay", max: 1 };
        o.action.damage = o.action.damage.filter((d) => !d.requiresAttackAdvantage || keepSneak).map((d) => ({ ...d, oncePerTurn: false }));
        c.options.push(o); return c.options.length - 1;
      };
      const ss2 = copy(ss, "Thief's Reflexes (Shortsword)", true), sc2 = copy(sc, "Thief's Reflexes (Scimitar)", false);
      c.routines.unshift({ name: "Thief's Reflexes", parts: [{ optionIdx: ss, count: 1 }, { optionIdx: ss2, count: 1 }, { optionIdx: sc, count: 1 }, { optionIdx: sc2, count: 1 }] });
    }
  };
  const notes = ["Sneak Attack applies once a turn.", "Vex: the Advantage from a Shortsword or Shortbow hit lasts to the end of the rogue's next turn, not this one."];
  if (i) notes.push("Steady Aim gives Advantage on the first attack of a turn; the engine does not check that the rogue has not moved, so it over-reads on turns the rogue closes to melee.");
  if (i >= 3) notes.push("Thief's Reflexes is a 1/Day routine of both turns' attacks at once, whenever the rogue chooses, not at Initiative minus 10 in round 1.");
  return { raw, patch, notes };
}

function monk(i) {
  const dex = mod(prim[i]), wis = mod(second[i]), hit = PB[i] + dex, die = [6, 8, 10, 12][i], dc = 8 + PB[i] + wis;
  const type = i >= 2 ? "Force" : "Bludgeoning"; // Empowered Strikes is level 6
  const raw = frame(i, "Monk", "Open Hand", { dex: prim[i], wis: second[i], con: 13, str: 12, cha: 8 }, 8, 10 + dex + wis, i >= 3 ? ["str", "dex", "con", "int", "wis", "cha"] : ["str", "dex"], { speed: { walk: [30, 40, 50, 55][i] } });
  const strike = `${dmg(dice(1, die, dex))} ${type} damage`;
  raw.trait = i >= 2 ? [EVASION] : [];
  raw.action = [
    act("Multiattack", `The character makes ${i ? "three" : "two"} Unarmed Strike attacks.${i ? " It can replace one attack with a use of Stunning Strike." : ""}`),
    melee("Unarmed Strike", hit, strike),
  ];
  raw.bonus = [];
  if (i) {
    // Quivering Palm's two uses (4 Focus Points each) come out of the pool before the split.
    const focus = LEVELS[i] - (i >= 3 ? 8 : 0);
    raw.action.push(melee(`Stunning Strike (${Math.ceil(focus / 2)}/Day)`, hit, strike, `, and the target must succeed on a {@dc ${dc}} Constitution saving throw or have the {@condition Stunned} condition until the start of the character's next turn`));
    // Open Hand Technique (Topple) rides on Flurry of Blows hits.
    raw.action.push(melee("Flurry Strike", hit, strike, `, and the target must succeed on a {@dc ${dc}} Dexterity saving throw or have the {@condition Prone} condition`));
    raw.bonus.push(act(`Flurry of Blows (${Math.floor(focus / 2)}/Day)`, "The character takes the Dash action, or it makes one Flurry Strike attack."));
    // Deflect Attacks reduces a hit by 1d10 + Dexterity + monk level (14.5, 21.5, 27.5), about a whole hit from the
    // monsters these monks duel. Written as a reaction that reduces the damage to 0; the engine also lets it cancel a
    // spell or breath packet, which the printed feature does not.
    raw.reaction = [act("Deflect Attacks", "{@actTrigger} The character is hit by an attack roll from an attacker it can see. {@actResponse} The character reduces the damage to 0.")];
  }
  if (i >= 2) raw.bonus.push(heal(`Wholeness of Body (${wis}/Day)`, dice(1, die, wis)));
  if (i >= 3) raw.action.push(save("Quivering Palm (2/Day)", "con", dc, "one creature within 5 feet", `${dmg(dice(10, 12))} Force damage.`));
  // Heightened Focus (level 10): Flurry of Blows makes three strikes, so the bonus copy carries one more strike as a
  // follow-up. The engine makes a follow-up only after a hit, so this slightly understates it.
  const patch = (c) => {
    if (i < 2) return;
    const fl = c.options.find((o) => /^Flurry of Blows/.test(o.name));
    if (fl) {
      const strike = structuredClone(fl.action); delete strike.followUp;
      fl.action.followUp = { name: "Flurry Strike", action: strike };
    }
    // Quivering Palm forgoes one attack of the Attack action, so it replaces one strike instead of the whole action.
    const qp = c.options.findIndex((o) => /^Quivering Palm/.test(o.name));
    const us = c.options.findIndex((o) => o.name === "Unarmed Strike");
    if (qp >= 0 && us >= 0) c.routines.push({ name: "Quivering Palm", parts: [{ optionIdx: us, count: 2 }, { optionIdx: qp, count: 1, replacesAttack: true }] });
  };
  const notes =i ? [`The uses of Stunning Strike and Flurry of Blows${i >= 3 ? ", and Quivering Palm at 4 Focus Points a use," : ""} come out of the monk's Focus Points, one a level.`,i >= 2 ? "Heightened Focus: Flurry of Blows adds two strikes, the second only if the first hits." : "Flurry of Blows adds one strike.", "Deflect Attacks cancels one hit of any size (the printed reduction is about a whole hit at these CRs); the engine also lets it cancel a spell or breath.", ...(i >= 3 ? ["Quivering Palm replaces one strike of the Multiattack. Its printed set-up hit is not required."] : [])] : ["The Bonus Action Unarmed Strike is the second attack of the Multiattack."];
  return { raw, patch, notes };
}

function paladin(i) {
  const str = mod(prim[i]), cha = mod(second[i]), hit = PB[i] + str + (i ? cha : 0);
  const raw = frame(i, "Paladin", "Devotion", { str: prim[i], cha: second[i], con: 13, wis: 12, int: 8 }, 10, i ? 21 : 18, ["wis", "cha"], { saveBonus: i >= 2 ? cha : 0 });
  if (i >= 2) raw.conditionImmune = ["charmed", "frightened"];
  const sap = ", and the target has Disadvantage on its next attack roll before the start of the character's next turn";
  const radiant = i >= 2 ? ` plus ${dmg(dice(1, 8))} Radiant damage` : "";
  const sword = `${dmg(dice(1, 8, str))} Slashing damage${radiant}`;
  // Divine Smite is printed once at the top slot's size; the patch adds a copy for each lower slot level.
  // A swing that misses still spends the use, so each level has slots x 1.25 uses (the paladin hits about four
  // times in five with Sacred Weapon). Level 1 has no Sacred Weapon and few slots: its smite draws on the slots.
  const smiteSlots = HALF_SLOTS[i], top = smiteSlots.length;
  const smiteUses = (level) => Math.round(smiteSlots[level - 1] * 1.25);
  const smite = i ? { uses: smiteUses(top), d: dice(top + 1, 8) } : null;
  raw.action = [
    ...(i ? [act("Multiattack", "The character makes two Longsword attacks. It can replace one attack with a use of Divine Smite.")] : []),
    melee("Longsword", hit, sword, sap),
    thrown("Javelin", hit, "30/120", `${dmg(dice(1, 6, str))} Piercing damage${radiant}`),
    ...(smite ? [melee(`Divine Smite (${smite.uses}/Day)`, hit, `${sword} plus ${dmg(smite.d)} Radiant damage`, sap)]
      // Level 1: both slots go to the smite (Bless never beats it in a duel), 3 uses so about two land at 65%.
      : [melee("Divine Smite (3/Day)", hit, `${sword} plus ${dmg(dice(2, 8))} Radiant damage`, sap)]),
  ];
  const layOnHands = 5 * LEVELS[i];
  raw.bonus = i ? [heal("Lay on Hands (2/Day)", Math.floor(layOnHands / 2))] : [heal("Lay on Hands (1/Day)", layOnHands)];
  const patch = (c) => {
    const s = c.options.findIndex((o) => /^Divine Smite/.test(o.name));
    if (s < 0) return;
    const withSmite = c.routines.filter((r) => r.parts.some((p) => p.optionIdx === s));
    // The smite dice are the last printed clause (Radiant Strikes, from level 11, sits before them).
    const smiteClause = c.options[s].action.damage.length - 1;
    // The extra 1d8 against a Fiend or an Undead.
    c.options[s].action.damage.push({ dice: { n: 1, d: 8, mod: 0 }, type: "radiant", targetTypes: ["fiend", "undead"] });
    for (let level = top - 1; level >= 1; level--) {
      const copy = structuredClone(c.options[s]);
      copy.name = copy.action.actionName = `Divine Smite, level ${level} (${smiteUses(level)}/Day)`;
      copy.uses = { t: "perDay", max: smiteUses(level) };
      copy.action.damage[smiteClause].dice.n = level + 1;
      c.options.push(copy);
      for (const r of withSmite) c.routines.push({ name: r.name.replace(/Divine Smite \(\d+\/Day\)/, copy.name), parts: r.parts.map((p) => (p.optionIdx === s ? { ...p, optionIdx: c.options.length - 1 } : p)) });
    }
  };
  const notes = ["Divine Smite deals 1d8 more Radiant damage to a Fiend or an Undead."];
  if (!i) notes.push("Divine Smite is chosen before the attack roll, so a miss spends a use: its 2 level 1 slots are 3 uses, about two landing at a 65% hit rate. Bless is not cast.");
  else {
    const lower = []; for (let level = top - 1; level >= 1; level--) lower.push(`level ${level} (${level + 1}d8 Radiant, ${smiteUses(level)}/Day)`);
    notes.push(`Divine Smite is printed at slot level ${top}. It also has ${lower.join(", ")}. One smite a turn. The smite is chosen before the attack roll, so a miss spends a use; each level has its slots x 1.25 uses so that about as many smites land as it has slots.`);
    notes.push("Sacred Weapon is in the attack bonus." + (i >= 2 ? " Aura of Protection is in every saving throw, and Radiant Strikes is the 1d8 Radiant in each weapon hit." : ""));
  }
  return { raw, patch, notes };
}

function ranger(i) {
  const dex = mod(prim[i]), wis = 1, hit = PB[i] + dex;
  // Roving (level 6): Speed 40 ft. in light armor.
  const raw = frame(i, "Ranger", "Hunter", { dex: prim[i], con: conStd[i], wis: 13, str: 12, cha: 8 }, 10, 12 + dex, ["str", "dex"], { speed: { walk: i >= 2 ? 40 : 30 } });
  // Hunter's Mark is taken as already cast: 1d6 Force on every hit.
  const mark = ` plus ${dmg(dice(1, 6))} Force damage`;
  raw.action = [
    ...(i ? [act("Multiattack", "The character makes two attacks, using Longbow or Shortsword in any combination.")] : []),
    ranged("Longbow", hit + (i ? 2 : 0), "150/600", `${dmg(dice(1, 8, dex))} Piercing damage${mark}`, ", and the target's Speed decreases by 10 feet until the start of the character's next turn"),
    melee("Shortsword", hit, `${dmg(dice(1, 6, dex))} Piercing damage${mark}`),
  ];
  if (i >= 3) raw.reaction = [HALVE("Superior Hunter's Defense")];
  const slots = HALF_SLOTS[i];
  raw.spellcasting = [casting(i, "wis", 8 + PB[i] + wis, PB[i] + wis, slots, [[], ...slots.map((_, k) => [k ? up("Cure Wounds", k + 1) : "Cure Wounds"])], "ranger")];
  const patch = (c) => {
    // Colossus Slayer: 1d8 once a turn against a target missing Hit Points. Precise Hunter (level 17): Advantage against the marked foe.
    if (i) for (const o of opt(c, /^(Longbow|Shortsword)$/)) o.action.damage.push({ dice: { n: 1, d: 8, mod: 0 }, type: "piercing", oncePerTurn: true, requiresTargetHurt: true });
    if (i >= 3) c.attackAdvantage = true;
    // Nature's Veil (level 14): Invisible until the end of its next turn, Wisdom modifier (1) uses. Taken after the
    // attacks, it covers the foe's turn and the ranger's next one.
    if (i >= 3) c.options.push({ name: "Nature's Veil (1/Day)", sourceText: "", sourceRef: "PC", timing: "bonus", uses: { t: "perDay", max: wis },
      action: { kind: "selfbuff", condition: "invisible", breaksOnAttackOrSpell: false, duration: "endOfSourceNextTurn" } });
  };
  const notes = ["Hunter's Mark is already cast: it is the 1d6 Force in every hit."];
  if (i >= 2) notes.push("Roving is the 40 ft. Speed.");
  if (i) notes.push("Archery is in the Longbow's attack bonus.", "Colossus Slayer: once a turn, a hit on a target missing Hit Points deals 1d8 more Piercing damage.");
  if (i >= 3) notes.push("Precise Hunter: Advantage on every attack roll.");
  return { raw, patch, notes };
}

// Foresight lasts 8 hours, so the level 17 wizard has it running and has no level 9 slot left. PILOT_FORESIGHT=0 gives Meteor Swarm instead.
const FORESIGHT = process.env.PILOT_FORESIGHT !== "0";
function wizard(i) {
  const int = mod(prim[i]), dc = 8 + PB[i] + int, hit = PB[i] + int, emp = i >= 2 ? int : 0;
  const raw = frame(i, "Wizard", "Evoker", { int: prim[i], con: conStd[i], dex: 13, wis: 12, str: 8 }, 6, 14, ["int", "wis"]);
  const slots = [...FULL_SLOTS[i]]; slots[0] -= 1; // Mage Armor, already cast and in the AC
  if (i >= 3) slots[4] -= 1; // the Overchannel cast
  if (i >= 3 && FORESIGHT) slots.pop();
  const lists = [
    [["Fire Bolt", "Ray of Frost"], ["Magic Missile", "Shield"]],
    [["Fire Bolt", "Ray of Frost"], ["Magic Missile", "Shield"], ["Mirror Image", "Misty Step", "Scorching Ray", "Web"], ["Fireball", "Counterspell", "Hypnotic Pattern"]],
    [["Fire Bolt", "Ray of Frost"], ["Magic Missile", "Shield"], ["Mirror Image", "Misty Step"], ["Fireball", "Counterspell", "Fly"], ["Greater Invisibility", "Dimension Door", "Blight", "Ice Storm"], ["Cone of Cold", "Hold Monster"], ["Disintegrate", "Chain Lightning"]],
    [["Fire Bolt", "Ray of Frost"], ["Magic Missile", "Shield"], ["Mirror Image", "Misty Step"], ["Fireball", "Counterspell", "Fly"], ["Greater Invisibility", "Dimension Door", "Blight"], ["Cone of Cold", "Hold Monster"], ["Disintegrate", "Chain Lightning"], ["Finger of Death", "Delayed Blast Fireball"], ["Sunburst", "Power Word Stun"], ["Meteor Swarm", "Power Word Kill"]],
  ][i];
  if (lists.length > slots.length + 1) lists.pop();
  raw.spellcasting = [casting(i, "int", dc, hit, slots, lists, "wizard")];
  // Empowered Evocation: the evocations are printed as their own actions with the bonus in the dice.
  if (emp) raw.action = [
    ranged("Fire Bolt", hit, "120", `${dmg(dice(i >= 3 ? 4 : 3, 10, emp))} Fire damage`, "", true),
    save("Fireball", "dex", dc, "each creature in a 20-foot-radius {@variantrule Sphere} centered on a point within 150 feet", `${dmg(dice(8, 6, emp))} Fire damage from the magical explosion.`),
    save("Cone of Cold", "con", dc, "each creature in a 60-foot {@variantrule Cone}", `${dmg(dice(8, 8, emp))} Cold damage from the magical blast.`),
    save("Chain Lightning", "dex", dc, "one creature within 150 feet that the character can see", `${dmg(dice(10, 8, emp))} Lightning damage from the magical bolt.`),
  ];
  if (i === 2) raw.action.push(save("Ice Storm", "dex", dc, "each creature in a 20-foot-radius {@variantrule Cylinder} centered on a point within 300 feet", `${dmg(dice(2, 10, emp))} Bludgeoning damage plus ${dmg(dice(4, 6))} Cold damage from the magical hail.`));
  if (i >= 3) {
    raw.action.push(save("Overchannel Cone of Cold (1/Day)", "con", dc, "each creature in a 60-foot {@variantrule Cone}", `${dmg(dice(69, 1))} Cold damage from the magical blast.`));
    if (!FORESIGHT) raw.action.push(save("Meteor Swarm", "dex", dc, "each creature in a 40-foot-radius {@variantrule Sphere} centered on a point within 1 mile", `${dmg(dice(20, 6, emp))} Fire damage plus ${dmg(dice(20, 6))} Bludgeoning damage from the magical meteors.`));
  }
  const patch = (c) => {
    // Potent Cantrip (level 3): half damage on a miss.
    if (i) for (const o of opt(c, /^(Fire Bolt|Ray of Frost)$/)) o.action.missDamageFactor = 0.5;
    if (i >= 3 && FORESIGHT) {
      c.attackAdvantage = true;
      c.saveAdvantageUnlessIncapacitated = true;
      c.attacksAgainstDisadvantage = { name: "Foresight", requiresConscious: true };
    }
  };
  const notes = ["Mage Armor is already cast: it is in the AC, and its level 1 slot is spent."];
  if (i) notes.push("Potent Cantrip: Fire Bolt and Ray of Frost deal half damage on a miss.");
  if (emp) notes.push("Empowered Evocation is the bonus in the dice of the spells printed as actions.");
  if (i >= 3) notes.push("Overchannel is the 1/Day Cone of Cold at maximum damage; its level 5 slot is spent.");
  if (i >= 3 && FORESIGHT) notes.push("Foresight is already cast with the level 9 slot: Advantage on attack rolls and saving throws, and attack rolls against the wizard have Disadvantage.");
  return { raw, patch, notes };
}

/** Give a printed action the slot pool of its spell level. */
function pool(c, re, level, slots) {
  for (const o of opt(c, re)) o.uses = { t: "perDay", max: slots[level - 1], pool: `spell-slots:${level}` };
}

function cleric(i) {
  const wis = mod(prim[i]), dc = 8 + PB[i] + wis, hit = PB[i] + wis, life = i >= 1, potent = i >= 2 ? wis : 0;
  // Aid is taken as already cast from level 5 (5 Hit Points, one level 2 slot).
  const raw = frame(i, "Cleric", "Life", { wis: prim[i], con: conStd[i], dex: 13, str: 12, cha: 8 }, 8, i ? 18 : 16, ["wis", "cha"], { hpBonus: i ? 5 : 0 });
  const slots = [...FULL_SLOTS[i]]; if (i) slots[1] -= 1;
  const first = ["Bless", "Cure Wounds", "Healing Word", "Guiding Bolt", "Inflict Wounds", "Sanctuary"];
  const second2 = ["Spiritual Weapon", "Hold Person", "Lesser Restoration", up("Inflict Wounds", 2)];
  const lists = [
    [["Sacred Flame"], first],
    [["Sacred Flame"], first, second2, ["Spirit Guardians", "Dispel Magic"]],
    [["Sacred Flame"], first, second2, ["Spirit Guardians", "Dispel Magic"], [up("Spirit Guardians", 4), up("Guiding Bolt", 4)], ["Flame Strike", "Insect Plague", "Mass Cure Wounds", "Greater Restoration"], ["Harm", "Blade Barrier"]],
    [["Sacred Flame"], first, second2, ["Spirit Guardians", "Dispel Magic"], [up("Spirit Guardians", 4), up("Guiding Bolt", 4)], ["Flame Strike", "Insect Plague", "Mass Cure Wounds", "Greater Restoration"], ["Harm", "Blade Barrier"], ["Fire Storm"], ["Sunburst"], []],
  ][i];
  raw.spellcasting = [casting(i, "wis", dc, hit, slots, lists, "cleric")];
  const supreme = i >= 3; // Supreme Healing: dice are maximised
  raw.action = [melee("Mace", PB[i] + 1, `${dmg(dice(1, 6, 1))} Bludgeoning damage`)];
  if (i) raw.action.push(save(`Divine Spark (${[0, 2, 3, 3][i]}/Day)`, "con", dc, "one creature within 30 feet that the character can see", `${dmg(dice(i, 8, wis))} Radiant damage.`));
  if (potent) raw.action.push(save("Sacred Flame", "dex", dc, "one creature within 60 feet that the character can see", `${dmg(dice(i >= 3 ? 4 : 3, 8, potent))} Radiant damage from the magical flame.`, false));
  // Disciple of Life: 2 + the slot level on each healing spell.
  if (life) raw.action.push(heal("Cure Wounds", supreme ? 16 + wis + 3 : dice(2, 8, wis + 3)));
  if (i >= 2) raw.action.push(heal("Mass Cure Wounds", supreme ? 40 + wis + 7 : dice(5, 8, wis + 7)), heal("Heal", 78));
  if (i >= 3) raw.action.push(heal("Mass Heal (1/Day)", 300));
  const patch = (c) => { if (i >= 2) pool(c, /^Heal$/, 6, slots); };
  const notes = [];
  if (i) notes.push("Aid is already cast: 5 Hit Points, and one level 2 slot spent.", "Disciple of Life is in the healing spells printed as actions.");
  if (potent) notes.push("Potent Spellcasting is the bonus in Sacred Flame.");
  if (i >= 2) notes.push("Heal spends a level 6 slot." + (supreme ? " Mass Heal is the level 9 slot. Supreme Healing: the healing dice are maximised." : ""));
  return { raw, patch, notes };
}

function druid(i) {
  const wis = mod(prim[i]), dc = 8 + PB[i] + wis, hit = PB[i] + wis, potent = i >= 2 ? wis : 0;
  const raw = frame(i, "Druid", "Land", { wis: prim[i], con: conStd[i], dex: 13, int: 12, str: 8 }, 8, i ? 18 : 14, ["int", "wis"]);
  if (i >= 2) { raw.resist = ["fire"]; raw.conditionImmune = ["poisoned"]; }
  const slots = FULL_SLOTS[i];
  const first = ["Entangle", "Thunderwave", "Cure Wounds", "Healing Word"];
  const lists = [
    [["Starry Wisp", "Produce Flame"], [...first, "Ice Knife"]],
    [["Starry Wisp", "Produce Flame"], first, ["Moonbeam", "Flaming Sphere", "Hold Person"], ["Call Lightning", "Fireball", "Sleet Storm"]],
    [["Starry Wisp", "Produce Flame"], first, ["Moonbeam", "Flaming Sphere", "Hold Person"], ["Call Lightning", "Fireball"], ["Ice Storm", "Blight", "Wall of Fire"], ["Insect Plague", "Mass Cure Wounds", "Cone of Cold"], ["Sunbeam", "Wall of Thorns"]],
    [["Starry Wisp", "Produce Flame"], first, ["Moonbeam", "Flaming Sphere", "Hold Person"], ["Call Lightning", "Fireball"], ["Ice Storm", "Blight", "Wall of Fire"], ["Insect Plague", "Mass Cure Wounds", "Cone of Cold"], ["Sunbeam", "Wall of Thorns"], ["Fire Storm"], ["Sunburst"], ["Storm of Vengeance"]],
  ][i];
  raw.spellcasting = [casting(i, "wis", dc, hit, slots, lists, "druid")];
  raw.action = [];
  if (potent) raw.action.push(ranged("Starry Wisp", hit, "60", `${dmg(dice(i >= 3 ? 4 : 3, 8, potent))} Radiant damage`, "", true));
  if (i >= 2) raw.action.push(heal("Heal", 70));
  const patch = (c) => { if (i >= 2) pool(c, /^Heal$/, 6, slots); };
  const notes = ["Wild Shape is not modelled."];
  notes.push(i ? "Warden order: half plate and a shield." : "Warden order, in its starting leather armor and shield.");
  if (potent) notes.push("Potent Spellcasting is the bonus in Starry Wisp.", "Heal spends a level 6 slot.");
  return { raw, patch, notes };
}

function bard(i) {
  const cha = mod(prim[i]), dc = 8 + PB[i] + cha, hit = PB[i] + cha;
  const raw = frame(i, "Bard", "Lore", { cha: prim[i], con: conStd[i], dex: 13, wis: 12, str: 8 }, 8, i ? 13 : 12, ["dex", "cha"]);
  const first = ["Dissonant Whispers", "Healing Word", "Hideous Laughter"];
  const lists = [
    [["Vicious Mockery"], [...first, "Thunderwave", "Sleep"]],
    [["Vicious Mockery"], first, ["Hold Person", "Shatter", "Invisibility"], ["Hypnotic Pattern", "Fear"]],
    [["Vicious Mockery"], first, ["Hold Person", "Shatter", "Invisibility"], ["Hypnotic Pattern", "Fear", "Fireball", "Counterspell"], ["Greater Invisibility", "Dimension Door", "Confusion"], ["Hold Monster", "Cone of Cold", "Mass Cure Wounds"], ["Chain Lightning", "Disintegrate", "Eyebite"]],
    [["Vicious Mockery"], first, ["Hold Person", "Shatter", "Invisibility"], ["Hypnotic Pattern", "Fear", "Fireball", "Counterspell"], ["Greater Invisibility", "Dimension Door", "Confusion"], ["Hold Monster", "Cone of Cold", "Mass Cure Wounds"], ["Chain Lightning", "Disintegrate", "Eyebite"], ["Finger of Death"], ["Sunburst", "Power Word Stun"], ["Meteor Swarm", "Power Word Kill"]],
  ][i];
  raw.spellcasting = [casting(i, "cha", dc, hit, FULL_SLOTS[i], lists, "bard")];
  // Cutting Words: the mean of the Bardic Inspiration die off one attack roll.
  if (i) raw.reaction = [act(`Cutting Words (${cha}/Day)`, `{@actTrigger} The character is hit by an attack roll. {@actResponse} The character adds ${[0, 4, 5, 6][i]} to its AC against that attack, possibly causing it to miss.`)];
  const notes = i ? ["Cutting Words is worth the mean of the Bardic Inspiration die."] : [];
  return { raw, notes };
}

function sorcerer(i) {
  const cha = mod(prim[i]), dc = 8 + PB[i] + cha + 1, hit = PB[i] + cha, aff = i >= 2 ? cha : 0;
  // Innate Sorcery is taken as active: +1 to the spell save DC and Advantage on spell attack rolls (patched).
  // Draconic Resilience (AC 10 + Dexterity + Charisma, 1 Hit Point a level) starts with the subclass, after level 1.
  const raw = frame(i, "Sorcerer", "Draconic", { cha: prim[i], con: conStd[i], dex: 13, wis: 12, str: 8 }, 6, 10 + 1 + (i ? cha : 0), ["con", "cha"], { hpBonus: i ? LEVELS[i] : 0, speed: i >= 3 ? { walk: 30, fly: 60 } : { walk: 30 } });
  if (i >= 2) raw.resist = ["fire"];
  const slots = FULL_SLOTS[i];
  const cant = ["Fire Bolt", "Ray of Frost"];
  const lists = [
    [cant, ["Chromatic Orb", "Shield", "Burning Hands", "Magic Missile"]],
    [cant, ["Chromatic Orb", "Shield", "Magic Missile"], ["Scorching Ray", "Mirror Image", "Misty Step"], ["Fireball", "Counterspell", "Fly"]],
    [cant, ["Chromatic Orb", "Shield", "Magic Missile"], ["Scorching Ray", "Mirror Image", "Misty Step"], ["Fireball", "Counterspell", "Fly"], ["Greater Invisibility", "Dimension Door", "Ice Storm"], ["Cone of Cold", "Hold Monster"], ["Disintegrate", "Chain Lightning"]],
    [cant, ["Chromatic Orb", "Shield", "Magic Missile"], ["Scorching Ray", "Mirror Image", "Misty Step"], ["Fireball", "Counterspell"], ["Greater Invisibility", "Dimension Door", "Ice Storm"], ["Cone of Cold", "Hold Monster"], ["Disintegrate", "Chain Lightning"], ["Finger of Death", "Delayed Blast Fireball"], ["Sunburst", "Power Word Stun"], ["Meteor Swarm", "Power Word Kill"]],
  ][i];
  raw.spellcasting = [casting(i, "cha", dc, hit, slots, lists, "sorcerer")];
  // Fire Bolt is printed so Quickened Spell can copy it; Elemental Affinity (fire) adds Charisma from level 6.
  raw.action = [ranged("Fire Bolt", hit, "120", `${dmg(dice([1, 2, 3, 4][i], 10, aff))} Fire damage`, "", true)];
  if (aff) raw.action.push(save("Fireball", "dex", dc, "each creature in a 20-foot-radius {@variantrule Sphere} centered on a point within 150 feet", `${dmg(dice(8, 6, aff))} Fire damage from the magical explosion.`));
  if (i >= 3) raw.action.push(save("Meteor Swarm", "dex", dc, "each creature in a 40-foot-radius {@variantrule Sphere} centered on a point within 1 mile", `${dmg(dice(20, 6, aff))} Fire damage plus ${dmg(dice(20, 6))} Bludgeoning damage from the magical meteors.`));
  const quick = [0, 2, 5, 8][i]; // 2 Sorcery Points a cast
  if (quick) raw.bonus = [act(`Quickened Spell (${quick}/Day)`, "The character takes the Dash action, or it makes one Fire Bolt attack.")];
  const patch = (c) => { c.attackAdvantage = true; };
  const notes = ["Innate Sorcery is taken as active all fight: Advantage on spell attack rolls, and the +1 in the spell save DC."];
  if (quick) notes.push("Quickened Spell is a Bonus Action Fire Bolt, one use for each 2 Sorcery Points.");
  if (aff) notes.push("Elemental Affinity is the bonus in the fire spells printed as actions.");
  if (i >= 3) notes.push("Dragon Wings is the Fly Speed.");
  return { raw, patch, notes };
}

function warlock(i) {
  const cha = mod(prim[i]), dc = 8 + PB[i] + cha, hit = PB[i] + cha, beams = [1, 2, 3, 4][i];
  // Armor of Shadows in the AC; Fiendish Vigor's 12 Temporary Hit Points in the Hit Points; Hex taken as already cast
  // (1d6 Necrotic a beam, one Pact slot gone).
  const raw = frame(i, "Warlock", "Fiend", { cha: prim[i], con: conStd[i], dex: 13, wis: 12, str: 8 }, 8, 14, ["wis", "cha"], { hpBonus: i ? 12 : 0 });
  const blast = `${dmg(dice(1, 10, i ? cha : 0))} Force damage plus ${dmg(dice(1, 6))} Necrotic damage`;
  raw.action = [
    ...(beams > 1 ? [act("Multiattack", `The character makes ${["", "", "two", "three", "four"][beams]} Eldritch Blast attacks.`)] : []),
    ranged("Eldritch Blast", hit, "120", blast, i ? ", and if the target is a Large or smaller creature, the target is pushed up to 10 feet straight away from the character" : "", true),
  ];
  const pact = [null, { level: 3, slots: 1, spells: ["Fireball", "Fear"] }, { level: 5, slots: 2, spells: [up("Fireball", 5), "Hold Monster"] }, { level: 5, slots: 3, spells: [up("Fireball", 5), "Hold Monster"] }][i];
  if (pact) {
    const lists = []; lists[pact.level] = pact.spells;
    const slots = []; slots[pact.level - 1] = pact.slots;
    raw.spellcasting = [casting(i, "cha", dc, hit, slots, lists, "warlock")];
    // Mystic Arcanum: one spell of level 6 from level 11, and of levels 7 to 9 by level 17.
    const arcanum = i >= 3 ? ["Circle of Death", "Finger of Death", "Power Word Stun", "Power Word Kill"] : i >= 2 ? ["Circle of Death"] : [];
    if (arcanum.length) raw.spellcasting.push({ name: "Mystic Arcanum", type: "spellcasting", ability: "cha", headerEntries: [`The character casts one of the following spells (spell save {@dc ${dc}}):`], daily: { "1e": sp(...arcanum) } });
  }
  if (i >= 3) raw.bonus = [save("Hurl Through Hell (1/Day)", "cha", dc, "one creature within 120 feet that the character can see", `${dmg(dice(8, 10))} Psychic damage.`, false)];
  const notes = ["Armor of Shadows (Mage Armor) is in the AC.", "Hex is already cast: it is the 1d6 Necrotic in each beam, and one Pact Magic slot is spent."];
  if (i) notes.push("Fiendish Vigor's 12 Temporary Hit Points are in the Hit Points. Agonizing Blast and Repelling Blast are in Eldritch Blast.");
  return { raw, notes };
}

const CLASSES = [barbarian, bard, cleric, druid, fighter, monk, paladin, ranger, rogue, sorcerer, warlock, wizard];
export const BUILDS = CLASSES.flatMap((build) => LEVELS.map((_, i) => build(i)));
