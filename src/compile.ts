import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { avgDice, parseDice } from "./dice.ts";
import { abilityMod, abilities, crToNumber, damageTypes, impactfulConditions, longAbility, numberWords, proficiencyFromCr } from "./tables.ts";
import type { LegendaryEntry, Routine, SlayOnZeroHp } from "./types.ts";
import type { ActionOption, Ability, AttackAdvantageCondition, AttackAdvantageTrait, AttacksAgainstDisadvantage, Aura, CombatAction, CombatStatblock, DamageClause, DamageGate, DeathBurst, Evasion, Fury, QualifiedDamageDefense, Reaction, Rebuke, Regeneration, Retaliation, Rider, SkipLog, SuccessImmunity, Uses } from "./types.ts";
import { FAIL_MARGIN_RE, ROLL_PENALTY_RE, criticalClauseEffect, hasNonFoeDamage, hasSaveMarginTier, parseAction, parseObjectStats, parseActionVariants, parseDamageClauses, parseRiders, parseSaveMarginTier, parseTeleport, ridersCappedAtOwnSize, parseUses, targetCappedAtOwnSize, targetMaxSize, withHealBlock } from "./parse/actions.ts";
import { buildRoutines, findOption, findOptions, isMultiattack } from "./parse/multiattack.ts";
import { castsTwiceSpell, compileSpellOptions, startCountTrait, type SpellReaction } from "./parse/spells.ts";
import { flattenEntries, stripTags } from "./parse/tags.ts";
import { parseSenses } from "./parse/senses.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");
export const dataDir = path.join(projectRoot, "data");
export const outDir = path.join(projectRoot, "out");
export const statblocksPath = path.join(outDir, "statblocks.json");
export const excludedPath = path.join(outDir, "excluded.json");

/** The bundled SRD 5.2.1 bestiary is the complete duel corpus. */
export const BESTIARY_FILES = ["bestiary-srd-5.2.1.json"] as const;
export const SPELLS_FILE = "spells-srd-5.2.1.json";

export interface ExcludedMonster {
  name: string;
  source: string;
  file: string;
  reason: string;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeList);
  if (typeof value === "string") return [value.toLowerCase()];
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return normalizeList(obj.resist || obj.immune || obj.vulnerable || obj.conditionImmune || obj.special);
  }
  return [];
}

function normalizeUnqualifiedDamageList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeUnqualifiedDamageList);
  if (typeof value === "string") return [value.toLowerCase()];
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.note || obj.cond) return [];
    return normalizeUnqualifiedDamageList(obj.resist || obj.immune || obj.vulnerable);
  }
  return [];
}

/**
 * Qualifiers the engine can represent. Only the magical/non-magical axis changes an outcome
 * in a duel — no monster wields a silvered or adamantine weapon — but a note naming those
 * materials is still a *weapon-quality* qualifier and so is understood. Anything else
 * ("while in dim light or darkness") describes a situation the simulation has no notion of.
 */
const WEAPON_QUALIFIER = /nonmagical|silver|adamantine/;

function parseQualifiedDefenses(
  value: unknown,
  kind: QualifiedDamageDefense["kind"],
  unmodeled?: string[],
): QualifiedDamageDefense[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((v) => parseQualifiedDefenses(v, kind, unmodeled));
  if (typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const note = String(obj.note || "").toLowerCase();
  const types = normalizeList(kind === "resist" ? obj.resist : obj.immune);
  const nested = Object.values(obj).flatMap((v) => v === obj.resist || v === obj.immune ? [] : parseQualifiedDefenses(v, kind, unmodeled));
  if (!types.length || !note) return nested;
  // A condition with no representation is skipped, not approximated. Keeping it would make a
  // situational defense unconditional — a dim-light resistance applied in
  // broad daylight — which overstates the creature. Dropping it can only understate.
  if (!WEAPON_QUALIFIER.test(note)) {
    unmodeled?.push(`${kind} ${types.join("/")} (${note})`);
    return nested;
  }
  return [{
    kind,
    types,
    nonmagicalOnly: /nonmagical/.test(note),
  }, ...nested];
}

function parseSigned(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.replace("+", ""));
  return undefined;
}

function parseRegeneration(monster: any): Regeneration | undefined {
  const text = flattenEntries(monster.trait || []);
  // A trait whose print says the creature gains Hit Points when each of its turns begins is also read, alongside one that
// says it regains them.
  const match = text.match(/Regeneration.*?\b(?:re)?gains\s+(\d+).*?Hit Points/i);
  // A trait that restores 10 Hit Points at the start of the creature's turn while its Hit Points are below half but still
  // positive. It is a regeneration under another name, which the Regeneration-anchored match above cannot see. Read
  // as its own pattern rather than by loosening that one: every other trait that says it regains hit points is a
  // 0-HP escape hatch or a mythic reset, and both are other mechanics.
  const survivor = match ? null
    : text.match(/regains\s+(\d+)[^.]{0,40}?[Hh]it [Pp]oints at the start of (?:each of )?its turns?[^.]{0,60}?(?:fewer|less) than half/i);
  if (!match && !survivor) return undefined;
  // A troll-style trait that stops working on the creature's next turn after it takes Acid or Fire damage.
  const clause = text.match(/if [^.]{0,80}?takes? ([^.]+?), this trait doesn't function/i)?.[1] || "";
  const suppressedBy = [...new Set(
    (clause.toLowerCase().match(new RegExp(`\\b(?:${damageTypes.join("|")})\\b`, "g")) || []),
  )];
  // Named creatures are written with gendered pronouns (the 0-HP death clause says he/his, not it/its), so
  // anchoring on "it/its" silently dropped the troll rule for them.
  let deathRule = /(?:dies|destroyed) only if (?:it|he|she|they) starts? (?:its|his|her|their) turn with 0/i.test(text);
  // Regeneration gated on already having hit points cannot fire at 0, so the print's clause that the creature dies only
  // when it fails to regenerate can never save it: it simply dies. A creature can read both ways at once;
  // the gate is what actually governs.
  if (/regains[^.]{0,120}\bif it has at least 1 (?:\{@variantrule\s+)?[Hh]it [Pp]oint/i.test(text)) deathRule = false;
  // A trait that reduces the regeneration rather than suppressing it (a listed damage type cuts the next regain to a
  // smaller fixed amount). Also a death threshold: at 0 hit points the creature is finished only by a single attack
  // dealing at least 10 acid or fire damage, or by at least 20 of it in total. Its holder stays up at 0 HP, which is
  // what `deathRule` says to the engine, with nothing in
  // `suppressedBy`.
  const typesIn = (list: string): string[] => [...new Set(list.toLowerCase().match(new RegExp(`\\b(?:${damageTypes.join("|")})\\b`, "g")) || [])];
  const reduced = match ? text.match(/if [^.]{0,80}?takes? ([^.]+?) damage, (?:it|he|she|they) regains? only (\d+) hit points? at the start of (?:its|his|her|their) next turn/i) : null;
  const threshold = match ? text.match(/dies only if (?:it|he|she|they) (is hit by an attack that deals|takes) (\d+) or more ([^.]+?) damage while [^.]{0,40}?\b0 hit points/i) : null;
  if (threshold && typesIn(threshold[3]).length) deathRule = true;
  return {
    amount: Number((match ?? survivor!)[1]),
    suppressedBy,
    suppressedByCritical: /critical hit/i.test(clause),
    // The Survivor wording says nothing whatever about dying, so the troll rule stays off.
    deathRule: match ? deathRule : false,
    ...(survivor ? { requiresBelowHalf: true } : {}),
    ...(reduced && typesIn(reduced[1]).length ? { reducedBy: { types: typesIn(reduced[1]), amount: Number(reduced[2]) } } : {}),
    ...(threshold && typesIn(threshold[3]).length
      ? { deathThreshold: { amount: Number(threshold[2]), types: typesIn(threshold[3]), attackOnly: /hit by an attack/i.test(threshold[1]) } }
      : {}),
  };
}

/** Creature type; nested forms include {type: "dragon", tags} and {type: {choose: [...]}} (Empyrean). */
function creatureType(monster: any): string {
  let t = monster.type;
  if (t && typeof t === "object") t = t.type;
  if (t && typeof t === "object" && Array.isArray(t.choose)) t = t.choose[0];
  return (typeof t === "string" ? t : "unknown").toLowerCase();
}

/** "If the elemental takes Cold damage, its Speed decreases by 20 feet until the end of its next turn." (Freeze) */
const SPEED_LOSS_ON_DAMAGE_RE = /^If the [a-z' -]+ takes ([A-Za-z]+) damage, its Speed decreases by (\d+) feet until the end of its next turn\./i;
function speedLossOnDamage(monster: any): { types: string[]; feet: number } | undefined {
  for (const trait of monster.trait || []) {
    const match = stripTags(flattenEntries(trait.entries ?? [])).match(SPEED_LOSS_ON_DAMAGE_RE);
    if (match) return { types: [match[1].toLowerCase()], feet: Number(match[2]) };
  }
  return undefined;
}

/** Max chase/escape speed across movement modes; speed values may be numbers or {number, condition}. */
function effectiveSpeed(monster: any): number {
  let best = 0;
  for (const [mode, num] of speedRatings(monster)) {
    // Every scenario is terrestrial. Swimming isn't interchangeable with land movement.
    if (mode === "swim") continue;
    // Nor is climbing: a Climb Speed needs a surface to climb, and the duel's ground has none ("Speed 10 ft., Climb 20 ft.").
    if (mode === "climb") continue;
    if (num > best) best = num;
  }
  return best;
}

/** A single movement mode's rating; values may be numbers or {number, condition}. */
function speedMode(monster: any, mode: string): number | undefined {
  const ratings = speedRatings(monster).filter(([m]) => m === mode).map(([, num]) => num);
  if (!ratings.length) return undefined;
  const num = Math.max(...ratings);
  return num > 0 ? num : undefined;
}

/**
 * Every [mode, feet] rating the print gives, its forms' included. A form's speeds sit in `speed.alternate`
 * ({ fly: [{ number: 60, condition: <text naming the form> }] }), which was read as a mode named "alternate" with
 * no number, so a creature with a flying form never flew. A block's speeds are the union of its forms, except for a
 * block that fights in its hybrid form (`fightsInHybridForm`), which has no Speed printed for another form only.
 */
const ROLLING_SPEED_RE = /\b(\d+) ft\. when rolling\b/i;
/**
 * Changing form is not modelled, so a shape-shifter fights in one form. A block that prints attacks for its humanoid
 * form and for its animal form, each "or Hybrid Form Only", is compiled with all of them, and the hybrid is the one form
 * that has them all. Its statistics are then the hybrid's: no Speed printed for another form only ("40 ft. (bear form
 * only)"), and the hybrid's size (`sizeRank`).
 */
function fightsInHybridForm(monster: any): boolean {
  const names: string[] = (monster.action || []).map((a: any) => String(a.name || ""));
  return names.some((n) => /\(Humanoid or Hybrid Form Only\)/i.test(n)) && names.some((n) => /\((?!Humanoid)[A-Za-z]+ or Hybrid Form Only\)/i.test(n));
}
function speedRatings(monster: any): [string, number][] {
  const out: [string, number][] = [];
  const hybridOnly = fightsInHybridForm(monster);
  const otherFormOnly = (value: any) => hybridOnly && /\((?!hybrid)[a-z]+ form only\)/i.test(String(value?.condition ?? ""));
  // A speed's condition can carry a second rating, such as a rolling speed and a faster downhill rolling speed. The
  // rolling rating is always available, so it is a rating of that mode. The downhill rating needs a slope the duel does
  // not have and stays out, as does every other condition's number (a form's lower walk, a bonus action's state).
  const rolling = (value: any) => Number(String(value?.condition ?? "").match(ROLLING_SPEED_RE)?.[1] ?? 0);
  const rating = (value: any) => typeof value === "number" ? value : Math.max(value?.number || 0, rolling(value));
  for (const [mode, value] of Object.entries(monster.speed || {})) {
    if (mode === "alternate" && value && typeof value === "object") {
      for (const [altMode, list] of Object.entries(value as Record<string, unknown>)) {
        for (const entry of ([] as unknown[]).concat(list)) if (!otherFormOnly(entry)) out.push([altMode, rating(entry)]);
      }
      continue;
    }
    if (!otherFormOnly(value)) out.push([mode, rating(value)]);
  }
  return out;
}

/**
 * Hover is tagged two ways in the data: a `canHover` flag on the speed object, and a
 * `(hover)` condition on the fly rating itself. Every hovering creature in the current
 * bestiaries carries both, but read either so a one-sided record still compiles correctly.
 */
function canHover(monster: any): boolean {
  const speed = monster.speed || {};
  if (speed.canHover === true) return true;
  const fly = speed.fly;
  return typeof fly === "object" && /hover/i.test(String(fly?.condition || ""));
}

/**
 * "The swarm can occupy another creature's space and vice versa." Every swarm says it in a trait named Swarm,
 * and a mist creature's form trait says the same of the mist.
 * Read from the sentence, not the trait's name. It is what lets such a pair stand closer than five feet
 * (`MIN_SEPARATION`), which three of those swarms need to bite at all: their attacks reach only into their
 * own space.
 */
/** A trait that lets the creature move up to its Speed, or cover its Speed in a straight line: the option's own move. */
const OWN_SPEED_MOVE_RE = /\b(?:the [\w-]+(?: [\w-]+){0,2}|it|he|she) (?:then )?(?:moves|flies|swims|rolls) up to (?:its|his|her) speed\b/i;
/** The same move with a printed distance, such as a straight-line move of up to 80 feet. */
const OWN_FEET_MOVE_RE = /\b(?:the [\w-]+(?: [\w-]+){0,2}|it|he|she) (?:then )?(?:moves|flies|swims|rolls) up to (\d+) feet\b/i;

/** Damage a creature deals by moving into its foe's space (`CombatStatblock.spaceEntry`). */
function parseSpaceEntry(monster: any): CombatStatblock["spaceEntry"] {
  for (const trait of monster.trait || []) {
    const text = flattenEntries(trait.entries || []);
    if (!/\bcan enter (?:a|another) creature'?s space\b/i.test(text)) continue;
    const sentence = text.split(/(?<=\.)\s+/).find((part) => /\bfirst time it enters a creature'?s space on a turn, that creature takes\b/i.test(part));
    if (!sentence || !/\{@damage/.test(sentence)) continue;
    const damage = parseDamageClauses(sentence);
    if (damage.length) return { name: trait.name, damage };
  }
  return undefined;
}

/** Difficult Terrain a creature carries around itself (`CombatStatblock.difficultGround`). */
function parseDifficultGround(monster: any): CombatStatblock["difficultGround"] {
  for (const trait of monster.trait || []) {
    const text = flattenEntries(trait.entries || []).replace(/\{@\w+ ([^}|]+)[^}]*\}/g, "$1");
    const radius = text.match(/\bThe ground in a (\d+)-foot Emanation originating from [^.]*? is Difficult Terrain\b/i);
    if (radius) return { name: trait.name, radius: Number(radius[1]) };
  }
  return undefined;
}

function sharesSpace(monster: any): boolean {
  return (monster.trait || []).some((trait: any) => /can occupy another creature'?s space/i.test(flattenEntries(trait.entries || [])));
}

const AURA_CREATURE_TYPES = [
  "aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey",
  "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead",
];

/**
 * Any creature that starts its turn within 30 feet of the source must succeed on a Constitution saving throw or take
 * necrotic damage.
 *
 * A passive proximity effect belongs to the creature rather than to an action, so it is
 * modelled separately from riders and resolved from the engagement distance. Only the
 * start-of-turn form is handled; auras that key off entering a space, or that grant allies
 * bonuses, have nothing to act on in a duel.
 */
/**
 * One branch of a randomly-rolled table is not a trait the creature always has. One creature
 * rolls 1d6 on revival for one of six boons, each named with its number and a boon name;
 * compiling the first as an always-on aura would hand it a permanent Frightened emanation it
 * actually gets one time in six, and only after it has already been dropped to 0 hit points.
 * These six are the only entries in the corpus named this way.
 */
function isRolledBranch(name: unknown): boolean {
  return /^\d+:\s/.test(String(name ?? ""));
}

/**
 * Where an aura's print grants its success immunity beyond the aura's own save (`Aura.successImmunity`):
 * - Immunity tied to either a made save (the repeat included) or the effect's end, however it ends.
 * - Immunity on a success, printed after a repeat save: the repeat is the same save, so its success counts.
 * An immunity worded as granted by the first save alone stays the aura's own save alone (`immuneOnSuccess`).
 */
function auraSuccessImmunity(name: string, text: string): { successImmunity?: SuccessImmunity } {
  if (/\bsaving throw is successful or the effect ends for it\b/i.test(text)) return { successImmunity: { key: name, trigger: "saveOrEnd" } };
  if (/\bonce it succeeds on the saving throw\b[^.]{0,80}\bimmune\b/i.test(text)) return { successImmunity: { key: name, trigger: "anySave" } };
  return {};
}

function parseAura(monster: any): Aura | undefined {
  for (const trait of monster.trait || []) {
    if (trait.name === "Gibbering" && /rolls? \{@dice 1d8\}/i.test(flattenEntries(trait.entries))) return {
      name: trait.name, magical: false, radius: 20, ability: "wis", dc: 10, damage: [],
      riders: [{ condition: "gibbering", duration: "endOfTargetTurn" }],
      requiresConscious: true, requiresSight: false, immuneOnSuccess: false,
    };
    if (isRolledBranch(trait.name)) continue;
    const text = flattenEntries([trait]);
    // The source may be named rather than referred to by a definite phrase (a pronoun, or a plural of the creature's
    // name), so don't require a definite article.
    //
    // Newer stat blocks restate the same mechanic in Emanation terms (an aura of a given radius,
    // then any enemy that starts its turn in the aura), which put the radius
    // in a different clause from the trigger and so matched nothing. That silently cost some fear
    // auras.
    const legacy = text.match(/starts its turn within (\d+) feet of\b/i);
    const emanation = legacy ? null : text.match(/(\d+)-foot \{@variantrule Emanation[^}]*\}/i)
      // The legacy books state the reach in prose instead: an aura of
      // corruption extending a number of feet in every direction, with the trigger clause a sentence later.
      ?? (legacy ? null : text.match(/(\d+) feet in every direction/i));
    // Newer blocks phrase the emanation two ways. One introduces it in one sentence
    // and refers back to it (an enemy that starts its turn in the aura); the other
    // puts the radius inside the trigger clause itself (a 5-foot Emanation radius written into the trigger clause: a
    // creature starting its turn in it). Only the first was read, so
    // every stench-style aura on several creatures was dropped whole.
    // The newer books write the referring-back clause with the Emanation tag left in place
    // (the tag sits right after the words about starting its turn), which the bare-word patterns
    // below never matched.
    const inTrigger = /starts its turn in the (?:aura|emanation)\b/i.test(text)
      || /starts its turn in an? \d+-foot \{@variantrule Emanation/i.test(text)
      || /starts its turn in the \{@variantrule Emanation/i.test(text);
    const trigger = legacy ?? (emanation && inTrigger ? emanation : null);
    if (!trigger) continue;
    // "The target suffers one of the following effects:" is a chooser, and an Aura carries one
    // outcome. Taking every branch would give one such creature a Charmed *and* an Incapacitated
    // *and* a Frightened *and* 3d6 psychic every turn, off one DC 20 save.
    if (/suffers? one of the following effects/i.test(text)) continue;
    // Two notations: prose ("DC 22 Wisdom saving throw") and the 2024 action shorthand
    // ("{@actSave wis} {@dc 10}").
    const actSave = text.match(/\{@actSave (\w+)\}\s*\{@dc (\d+)\}/i);
    const save = actSave || text.match(/\{@dc (\d+)\}\s*([A-Za-z]+) saving throw/i)
      || text.match(/([A-Za-z]+) saving throw[^.]{0,40}?\{@dc (\d+)\}/i);

    // An aura need not offer a save: some creatures' auras (a warping-geometry field, a whirlwind
    // of weapons) simply deal their damage to anyone standing in them. `Aura.ability` and
    // `Aura.dc` are optional for exactly this case, but requiring a save here meant the engine
    // never received one — every saveless damage aura in the corpus was dropped whole.
    const dc = save ? Number(save[1].match(/^\d+$/) ? save[1] : save[2]) : undefined;
    const ability = save ? longAbility[(save[1].match(/^\d+$/) ? save[2] : save[1]).toLowerCase()] : undefined;
    if (save && (!ability || !Number.isFinite(dc))) continue;

    // Everything after the failure keyword; a leading clause often describes an ally buff.
    const markerAt = text.search(/\bon a failed save\b|\bor take\b|\bor be\b|\bor it takes\b|\bsaving throw or\b/i);
    // The marker usually introduces the outcome ("... or take 14 (4d6) poison damage"), but it can
    // trail it: a gaze may read that a creature takes psychic damage on a
    // failed save, where slicing from the marker threw the damage away. Take the whole sentence
    // the marker sits in, so the outcome is included either way round.
    const failAt = markerAt < 0 ? -1 : text.lastIndexOf(". ", markerAt) + 1;
    // Drop sentences describing a *different* trigger. An aura may be followed
    // by a sentence about a creature that touches the source or strikes it in melee and takes acid damage, which
    // is retaliation, not aura damage.
    // Also drop the escape clause that lets a creature succeed automatically if the owner is Incapacitated,
    // whose condition describes the aura's owner rather than anything inflicted.
    const outcome = (failAt >= 0 ? text.slice(failAt) : text)
      .split(/(?<=\.)\s+/)
      .filter((sentence) => !/\b(?:touch(?:es)?|hits it with a melee attack)\b/i.test(sentence))
      .filter((sentence) => !/succeeds? on (?:this|the) saving throw automatically/i.test(sentence))
      // A graduated failure tier is a rarer, separate outcome, and `parseRiders` already drops
      // it for actions. One creature's gaze restrains on a failed save and petrifies only on a save
      // missed by five or more; taking both would petrify on every ordinary failure.
      .filter((sentence) => !/fails by \d+ or more/i.test(sentence))
      .join(" ");
    // Only real {@damage} tags count. parseDamageClauses falls back to {@dice} for legacy
    // stat blocks, which would read the Gibbering Mouther's roll-1d8 behaviour table
    // as 1d8 damage.
    const damage = /\{@damage/.test(outcome) ? parseDamageClauses(outcome) : [];
    // A condition named inside the aura's own precondition (the source must not be Incapacitated, or must not have the
    // Incapacitated condition) describes the
    // source, not the victim.
    const conditions = [...outcome.matchAll(/(\bisn't\s+|\bis not\s+|\bdoesn't have the\s+|\bdoes not have the\s+)?\{@condition ([^}|]+)/gi)]
      .filter((m) => !m[1])
      .map((m) => m[2].trim().toLowerCase())
      .filter((c) => impactfulConditions.has(c));
    if (!damage.length && !conditions.length) continue;

    // "until the start of its next turn" is the common wording; a stated minute or a repeat
    // save is modelled as lasting, since a 1v1 rarely runs long enough for either to lapse.
    // The aura lands at the start of the creature's turn, so "its next turn" is the one after:
    // the condition covers the turn it lands on and is gone before the aura rolls again.
    const repeats = /repeat the saving throw at the end of each of its turns/i.test(text);
    const shortLived = /until the start of (?:the creature's|its) next turn/i.test(text);
    const duration = repeats ? "saveEndsEachTurn" : shortLived ? "startOfTargetNextTurn" : "permanent";
    let riders: Rider[] = [...new Set(conditions)].map((condition) => ({
      condition,
      duration: duration as Rider["duration"],
      // A repeat save needs a save to repeat; a saveless aura has none to carry.
      ...(repeats && ability && dc !== undefined ? { save: { ability, dc } } : {}),
    }));
    // A heal block the outcome prints (the creature can't regain hit points, possibly until the start of its next turn),
    // read as an action's is.
    riders = withHealBlock(outcome, riders);
    // One creature's gaze is the two-stage petrification the action parser already understands,
    // written as a trait: the victim is held, repeats the save, and turns to stone only if it
    // fails again. Taken as two simultaneous conditions the gaze petrified on first contact.
    // A repeated-save petrification presupposes a save; a saveless aura cannot take this branch.
    if (ability && dc !== undefined
      && (/repeats? the saving throw[^.]{0,140}becoming \{@condition petrified/i.test(text)
        || /repeats? the saving throw[\s\S]{0,240}?on a fail[^.]{0,140}\{@condition petrified/i.test(text))) {
      const held = riders.find((rider) => rider.condition !== "petrified");
      if (held) {
        held.duration = "saveEndsEachTurn";
        held.save = { ability, dc };
        held.transitionOnFailedSave = "petrified";
      }
      riders = riders.filter((rider) => rider.condition !== "petrified");
    }
    // A gaze that petrifies outright on a save failed by 5 or more, and holds (Restrained, then Petrified on a failed
    // repeat save) only otherwise: the margin tier, read the way an action's is. A gaze that drops the victim to 0
    // hit points there has no field to carry that, so its tier yields no rider and its aura is unchanged.
    if (ability && dc !== undefined) {
      const tier = parseSaveMarginTier(text, riders, { ability, dc });
      if (tier?.riders.length) {
        riders = [
          ...(tier.replacesBase ? riders.map((rider) => ({ ...rider, saveFailMarginBelow: tier.margin })) : riders),
          ...tier.riders,
        ];
      }
    }

    const exclusionText = text.slice(0, trigger.index! + trigger[0].length + 120);
    // A clause that excludes several creature types at once (a Construct or an Undead, say) lists them in one clause.
    const unlessClause = text.match(/\bunless the creature is [^.]{0,60}/i)?.[0] || "";
    const excludedTargetTypes = AURA_CREATURE_TYPES.filter((type) =>
      new RegExp(`(?:other than|isn't|is not|non-)[^.]{0,40}\\b${type}s?\\b`, "i").test(exclusionText)
      || new RegExp(`\\b${type}s?\\b`, "i").test(unlessClause)
      || new RegExp(`\\b${type}s? are immune to (?:this|the)\\b`, "i").test(text));
    // "any Beast or Humanoid that starts its turn within 30 feet of the hag" (the Sea Hag's Vile Appearance): only those
    // types are subject to it. Not after "other than", as in an exclusion of one type, which is read above as an
    // exclusion.
    const typeList = `(?:${AURA_CREATURE_TYPES.join("|")})s?(?:\\s*(?:,|or|and)\\s*(?:${AURA_CREATURE_TYPES.join("|")})s?)*`;
    const positive = exclusionText.match(new RegExp(`(?<!\\b(?:other than|isn't|is not|except)\\s+)\\b(?:any|each|every|an?)\\s+(${typeList})\\s+(?:that|who|which)\\s+(?:starts?|begins)\\b`, "i"));
    const targetTypes = positive ? AURA_CREATURE_TYPES.filter((type) => new RegExp(`\\b${type}s?\\b`, "i").test(positive[1])) : [];

    return {
      name: trait.name || "Aura",
      // Magic Resistance answers only "spells and other magical effects": an aura is magical where its text says so,
      // and a Hezrou's Stench or a Pit Fiend's Fear Aura does not (O08).
      magical: /\bmagical\b/i.test(stripTags(text)),
      radius: Number(trigger[1]),
      ability,
      dc,
      damage,
      riders,
      immuneOnSuccess: /on a success(?:ful)?[^.]{0,60}immune|immune to[^.]{0,80}for (?:the next )?(?:24 hours|1 hour)/i.test(text),
      ...auraSuccessImmunity(trait.name || "Aura", text),
      requiresConscious: /isn't \{@condition incapacitated|doesn't have the \{@condition incapacitated/i.test(text),
      requiresSight: /that can see the|can see it\b|can see the creature/i.test(text),
      ...(targetTypes.length ? { targetTypes } : {}),
      ...(excludedTargetTypes.length ? { excludedTargetTypes } : {}),
    };
  }
  // A heal block held by place: a trait whose whole text says that creatures within 60 feet of the owner can't
  // regain Hit Points. No save,
  // no damage, no rider and no duration: the aura carries the radius and `blocksHealing`, and the engine reads the
  // distance wherever a regain is checked (`healBlocked`). Read only when the block has no other aura (a block holds one).
  for (const trait of monster.trait || []) {
    if (isRolledBranch(trait.name)) continue;
    const zone = flattenEntries(trait.entries).match(HEAL_BLOCK_ZONE_RE);
    if (!zone) continue;
    return {
      name: trait.name || "Aura",
      radius: Number(zone[1]),
      damage: [],
      riders: [],
      immuneOnSuccess: false,
      requiresConscious: false,
      requiresSight: false,
      blocksHealing: true,
    };
  }
  return undefined;
}

/** The whole text of a place-held heal block: "Creatures within N feet of <the owner> can't regain Hit Points." */
const HEAL_BLOCK_ZONE_RE = /^\s*Creatures within (\d+) feet of [^.]+? can['’]t regain (?:\{@variantrule Hit Points[^}]*\}|Hit Points)\.?\s*$/i;

/**
 * "At the end of each of the balor's turns, each creature in a 5-foot Emanation originating from
 * the balor takes 13 (3d8) Fire damage."
 *
 * The same passive proximity effect `parseAura` reads, on the other side of the round. Three
 * things separate the family from the one above and all three matter in a duel: it fires on the
 * *owner's* turn rather than the victim's, most of it offers no saving throw at all, and the
 * end-of-turn members land a full opponent turn earlier than a start-of-turn one would. So the
 * timing is recorded on the `Aura` rather than folded into it, and the save is optional.
 *
 * Two members carry no radius at all — the Barbed Devil's Barbed Hide and a plant creature's
 * thorny trait deal their damage to a creature the owner is grappling or is grappled by, and the
 * hold is the gate. They are the same owner-turn mechanism with a different proximity test, which
 * is cheaper than a third resolution site for two creatures.
 *
 * `claimed` holds the trait names another parser already took. One trait carries one mechanic
 * here: one creature's fire trait is both an emanation and a retaliation in one paragraph,
 * `parseRetaliation` reads the retaliation half, and taking the other half as well would stack a
 * third form-gated effect on a block that already carries the other form's aura.
 */
function parseSourceTurnAura(monster: any, claimed: Set<string>): Aura | undefined {
  for (const trait of monster.trait || []) {
    const name: string = trait.name || "";
    if (claimed.has(name.toLowerCase()) || isRolledBranch(name)) continue;
    const text = flattenEntries([trait]);
    // The victim-turn wording belongs to `parseAura`; a trait never carries both.
    if (/starts its turn (?:within \d+ feet|in the (?:aura|emanation)|in an? \d+-foot)/i.test(text)) continue;
    // The Aboleth's Mucus Cloud runs "while underwater" and its acid lands "at the end of every
    // 10 minutes" out of water. Neither scenario is wet and no duel lasts ten minutes.
    if (/\bwhile underwater\b/i.test(text)) continue;
    // One creature's aura makes its victim spend a Reaction attacking whoever
    // is in reach, and deals its 2d6 only when nobody is. Forcing an attack has no field, and
    // taking the fallback branch as though it always applied would invent the trait's damage.
    if (/takes? a \{@variantrule Reaction/i.test(text)) continue;
    for (const sentence of text.split(/(?<=\.)\s+/)) {
      // A poisoned creature that gets a repeat save as each of its turns ends is
      // a duration clause on the victim, not a trigger.
      if (/repeats? the saving throw/i.test(sentence)) continue;
      // A named owner may be referred to by pronoun, including a gendered one: an aura can tick on each of
      // the owner's turns worded with "his". Those read exactly as "its" does for every purpose below.
      const trigger = sentence.match(/\bat the (start|end) of (?:each of )?(its|his|her|their|the [\w'’ -]{1,30}?'s) turns?\b/i);
      if (!trigger) continue;
      const onSourceTurn = trigger[1].toLowerCase() as "start" | "end";
      // The owner as the prose names it, for telling an effect that lasts until the start of the owner's next
      // turn (one round of this effect) from one that runs out as the target's next turn begins.
      const owner = /^(?:its|his|her|their)$/i.test(trigger[2]) ? "its" : trigger[2].toLowerCase().replace(/'s$/, "");
      // Radius: the 2024 Emanation, the legacy "within N feet", or no distance at all where a
      // grapple is what puts the victim in reach.
      // The radius usually sits in the trigger sentence. Some blocks state it in the sentence
      // before (an aura surrounding a named creature in a 10 foot radius), so fall back to the trait's own
      // text for that wording rather than dropping an aura whose reach is plainly given.
      const emanation = sentence.match(/(\d+)-foot \{@variantrule Emanation[^}]*\}/i)
        ?? sentence.match(/\bwithin (\d+) feet\b/i)
        ?? text.match(/\bin an? (\d+)[- ]foot radius\b/i);
      const holdsVictim = /\bcreature it is grappling\b/i.test(sentence);
      const heldByVictim = /\bcreature grappling it\b/i.test(sentence);
      // Only the two directions the corpus actually writes. A hypothetical trait naming the
      // owner's own hold and nothing else would fall through and stay logged, which understates
      // it; inventing a third value for a creature that does not exist would not.
      const requiresGrapple = holdsVictim && heldByVictim ? "either" : heldByVictim ? "grappler" : undefined;
      // The trigger has to name creatures, not scenery or allies. Without this, a trait that befouls
      // exposed water within 30 feet and one that ends an effect on itself and all allied kobolds within 30
      // feet both read as emanations, and neither touches an opponent at all.
      if (!/\b(?:each|any)(?: other)? creature\b/i.test(sentence)) continue;
      if (!emanation && !requiresGrapple) continue;
      // Both notations, exactly as `parseAura` reads them.
      const actSave = text.match(/\{@actSave (\w+)\}\s*\{@dc (\d+)\}/i);
      const save = actSave || text.match(/\{@dc (\d+)\}\s*([A-Za-z]+) saving throw/i)
        || text.match(/([A-Za-z]+) saving throw[^.]{0,40}?\{@dc (\d+)\}/i);
      const dc = save ? Number(save[1].match(/^\d+$/) ? save[1] : save[2]) : undefined;
      const ability = save ? longAbility[(save[1].match(/^\d+$/) ? save[2] : save[1]).toLowerCase()] : undefined;
      if (save && (!ability || !Number.isFinite(dc))) continue;
      // Where there is a save, only the failure branch is an effect; where there is none the
      // whole trait is. Both then lose the clauses that describe the *owner's* own state — "unless
      // the azer has the Incapacitated condition" names a condition, and it is the azer's.
      const failAt = save ? text.search(/\{@actSaveFail\}|\bon a failed save\b|\bor take\b|\bor be\b|\bor it takes\b|\bsaving throw or\b/i) : -1;
      const outcome = (failAt >= 0 ? text.slice(failAt) : text)
        .replace(/\b(?:unless|provided that)\b[^.]{0,80}?\{@condition [^}]*\}[^.]{0,40}/gi, " ")
        .replace(/\bunless\b[^.]{0,60}?has taken [^.]{0,60}?since the end of its last turn/gi, " ")
        // And the trigger clause itself. `parseDamageClauses` reads "at the end of each of the
        // balor's turns" as a rider's per-turn tick and drops the damage that follows it — quite
        // right for an action, where a tick belongs to the condition it rides on, and quite wrong
        // here, where the recurrence *is* the trait.
        .replace(/\bat the (?:start|end) of (?:each of )?(?:its|his|her|their|the [\w'’ -]{1,30}?'s) turns?,?\s*/gi, " ")
        .split(/(?<=\.)\s+/)
        .filter((part) => !/\{@actSaveSuccess\}/i.test(part))
        .join(" ");
      const damage = /\{@damage/.test(outcome) ? parseDamageClauses(outcome) : [];
      const conditions = [...new Set([...outcome.matchAll(/\{@condition ([^}|]+)/gi)]
        .map((m) => m[1].trim().toLowerCase())
        .filter((c) => impactfulConditions.has(c)))];
      if (!damage.length && !conditions.length) continue;
      // An effect that lasts until the start of the owner's next turn is one round of the owner's own
      // effect and expires when it comes round again. One that runs only to the beginning of the target's next turn
      // ends as the victim's turn begins, so it covers the rest of the owner's turn and none of the
      // victim's; "until the end of its next turn" bounds the victim's
      // own turn instead.
      const repeats = /repeat the saving throw at the end of each of its turns/i.test(text);
      const ownerBounded = owner !== "its"
        && new RegExp(`until the start of ${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'s next turn`, "i").test(outcome);
      const targetStart = /until the start of (?:the target's|the creature's|its) next turn/i.test(outcome);
      const bounded = /until the (?:start|end) of/i.test(outcome);
      const duration: Rider["duration"] = repeats ? "saveEndsEachTurn"
        : ownerBounded ? "startOfSourceNextTurn"
        : targetStart ? "startOfTargetNextTurn"
        : bounded ? "endOfTargetNextTurn"
        : "permanent";
      const suppression = text.match(/\bhas taken ([^.]{0,60}?) damage since the end of its last turn/i)?.[1] || "";
      const suppressedBy = damageTypes.filter((type) => new RegExp(`\\b${type}\\b`, "i").test(suppression));
      return {
        name: name || "Emanation",
        magical: /\bmagical\b/i.test(stripTags(text)),
        ...(emanation ? { radius: Number(emanation[1]) } : {}),
        ...(ability && dc !== undefined ? { ability, dc } : {}),
        damage,
        riders: conditions.map((condition) => ({
          condition,
          duration,
          ...(repeats && ability && dc !== undefined ? { save: { ability, dc } } : {}),
        })),
        immuneOnSuccess: /on a success(?:ful)?[^.]{0,60}immune|immune to[^.]{0,80}for (?:the next )?(?:24 hours|1 hour)/i.test(text),
        ...auraSuccessImmunity(name || "Emanation", text),
        // "unless the azer has the Incapacitated condition" is the same gate `parseAura` reads
        // in its two other wordings.
        requiresConscious: /isn't \{@condition incapacitated|doesn't have the \{@condition incapacitated|unless the [\w' -]{1,30} has the \{@condition incapacitated/i.test(text),
        // No member of this family gates on sight; `parseAura`'s three gaze wordings appear only
        // on the victim-turn side, where a creature has to be looking at the thing to be caught.
        requiresSight: false,
        onSourceTurn,
        ...(suppressedBy.length ? { suppressedBy } : {}),
        ...(requiresGrapple ? { requiresGrapple } : {}),
      };
    }
  }
  return undefined;
}

/**
 * "A creature that hits the pudding with a melee attack roll takes 4 (1d8) Acid damage."
 *
 * Only the melee-attack trigger is taken. Traits that also fire on merely touching the
 * creature are folded in, since in a duel the only way to touch it is to attack it.
 */
/** Damage a creature takes itself for touching the ground. */
const SELF_GROUND_DAMAGE_RE = /\btouch(?:es)? the ground\b[^.]{0,40}\b(?:it|he|she|they) takes?\s+\d+/i;

function parseRetaliation(monster: any): Retaliation | undefined {
  for (const trait of monster.trait || []) {
    const text = flattenEntries([trait]);
    const sentences = text.split(/(?<=\.)\s+/);
    // Either clause order. A trait may state the consequence first (a creature within 5 feet
    // takes lightning damage whenever it hits the source with a
    // melee attack), which the hit-then-takes pattern never saw.
    // A trait that damages the creature itself when it first touches the ground on a turn is damage
    // to the creature itself, and it compiled as the block's retaliation, dealt to whoever hit it. What is
    // touched is the ground and the one who takes the damage is the creature itself: not a retaliation. The trait is
    // passed over, so the block's printed retaliation (a creature that touches it or strikes it in melee takes
    // lightning damage) is the one read.
    const onHit = sentences.find((s) =>
      !SELF_GROUND_DAMAGE_RE.test(s)
      && (/\b(?:hits?|touch(?:es)?)\b[^.]{0,120}\btakes?\s+\d+/i.test(s)
        || /\btakes?\s+\d+[^.]{0,120}\bwhen(?:ever)? it (?:hits?|touch(?:es)?)\b/i.test(s))
      && /melee attack|touch/i.test(s));
    // The other half of the same mechanic, written from the victim's side: when the creature
    // takes damage of certain types, each creature within 5 feet of it takes acid
    // damage. It answers the damage rather than the attacker, and it is a radius
    // rather than a response to a blow, so it carries its own distance and is resolved on its
    // own path; see `Retaliation.radius`.
    // The gate may name the types that fire it or the one
    // that does not (every type but one), so the words between "damage" and
    // the comma belong to the gate too.
    const onWound = onHit ? undefined : sentences.find((s) =>
      /\btakes? [^.]{0,60}?damage(?:[^.,]{0,40})?, each creature within \d+ feet of [^.]{0,40}takes?\s+\d+/i.test(s));
    const sentence = onHit ?? onWound;
    if (!sentence || !/\{@damage/.test(sentence)) continue;
    // "the first time it enters a creature's space" is positional, not a response to a hit.
    if (/enters? (?:a|the) [\w' ]*space/i.test(sentence)) continue;
    const damage = parseDamageClauses(sentence);
    if (!damage.length) continue;
    // A blow in melee that does piercing or slashing damage. The print names
    // the same gate on the other side of the blow, from the victim's view.
    const gate = sentence.match(/melee attack that deals ([^.]{0,60}?) damage/i)?.[1]
      ?? (onWound ? sentence.match(/\btakes? ([^.]{0,60}?damage(?:[^.,]{0,40})?),/i)?.[1] : undefined) ?? "";
    // A gate naming the one type that does NOT fire it. `Retaliation`
    // carries only the firing list, so the exclusion is written out as every other type.
    const excluded = gate.match(/any type (?:but|except|other than) ([\w ,]+?)(?:\s+damage)?$/i)?.[1];
    const requiresDamageTypes = excluded
      ? damageTypes.filter((type) => !new RegExp(`\\b${type}\\b`, "i").test(excluded))
      : damageTypes.filter((type) => new RegExp(`\\b${type}\\b`, "i").test(gate));
    // The "each creature within 5 feet" wording is the distance the spray reaches, and the field
    // that tells a damage-triggered radius apart from a melee-hit response.
    const radius = onWound ? Number(sentence.match(/each creature within (\d+) feet/i)?.[1]) : undefined;
    return {
      name: trait.name || "Retaliation",
      damage,
      ...(requiresDamageTypes.length ? { requiresDamageTypes } : {}),
      ...(Number.isFinite(radius) ? { radius } : {}),
    };
  }
  return undefined;
}

/**
 * A trait where, once another creature has damaged the creature, its attack rolls have advantage through its next
 * turn's end, and its first hit with a named attack on that turn adds extra psychic damage to the target. On its turn
 * it has disadvantage on attack rolls unless some other creature has damaged it.
 *
 * Only the being-damaged trigger is read. It is the one a duel observes directly, and it is
 * very nearly always on: an opponent that is fighting back satisfies it every round, which is
 * why the trait is worth so much more here than the page suggests. The extra damage is
 * returned separately so the caller can hang it on the option the trait names.
 */
function parseFury(monster: any): { fury: Fury; bonus?: { option: string; damage: DamageClause[] } } | undefined {
  for (const trait of monster.trait || []) {
    const text = flattenEntries([trait]);
    if (!/deals? damage to (?:it|the [\w' -]+)\b/i.test(text)) continue;
    if (!/attack rolls have advantage/i.test(text)) continue;
    const fury: Fury = {
      name: trait.name || "Fury",
      trigger: "tookDamage",
      // The creature attacks with disadvantage until some other creature has damaged it.
      ...(/disadvantage on attack rolls/i.test(text) ? { disadvantageWhenInactive: true } : {}),
    };
    // Its first hit with a named attack deals extra psychic damage to the target.
    const bonusAt = text.match(/first time it hits with (?:a|an|its)\s+([A-Z][A-Za-z' -]*?)\s+attack/i);
    const extraAt = text.search(/takes an extra/i);
    const damage = extraAt < 0 ? [] : parseDamageClauses(text.slice(extraAt));
    // The attack-roll swing stands on its own; a trait with no extra damage still compiles.
    if (!bonusAt || !damage.length) return { fury };
    return {
      fury,
      bonus: {
        option: bonusAt[1].trim(),
        damage: damage.map((clause) => ({ ...clause, requiresAttackerFury: true, oncePerTurn: true })),
      },
    };
  }
  return undefined;
}

/**
 * A charge trait: the creature closes 20 feet or more in a line on a target and then lands a named attack that turn,
 * dealing extra damage.
 *
 * The damage-clause layer has carried `requiresMovement` for some time, and the movement
 * engine already tracks `movedToward`; nothing was reading the trait that feeds them. So a whole
 * class of chargers swung for their base damage and never once charged.
 *
 * Most of the carriers end with a Strength save whose failure knocks the target prone, and that half was attached to
 * nothing: the parser took the damage and stopped. The rider inherits the same `requiresMovement`, so the knockdown
 * costs a run-up exactly as the extra die does.
 *
 * Pounce is the same sentence with the extra die left out (after the move and a claw hit that turn, a failed Strength
 * save leaves the target prone),
 * and requiring "takes an extra" is what kept the parser off its carriers.
 * The clause is optional now and a trait qualifies on damage *or* riders, which reaches those carriers and changes
 * nothing for the ones that state a die: every trait that gates on a run-up was read against the
 * relaxed pattern, and those that state a die compile to the same damage and the same riders as before.
 *
 * Two things stay out. Pounce's third sentence, a bonus-action bite against a prone target, is a bonus action
 * conditional on both the knockdown and the claw that caused it, and nothing in the block expresses an option that
 * exists only after another option hit this turn; it is logged as a partial rather than
 * approximated. And a charge that hangs its save on the movement alone with no attack to ride on (the creature covers
 * 20 feet or more in a line and stops near a Large or smaller creature) is not this
 * shape at all and stays in the trait log.
 */
function parseCharge(monster: any): { name: string; option: string; damage: DamageClause[]; riders: Rider[]; unmodeled?: string } | undefined {
  for (const trait of monster.trait || []) {
    const text = flattenEntries([trait]);
    // The named attack usually ends in the word "attack" (a gore attack, say), but some
    // creatures write the weapon bare (hits it with a named weapon on the same
    // turn), which resolves against the option of that name once the pronoun and the
    // missing noun are allowed for. Before this, such a Charge attached nothing at all.
    const match = text.match(
      /moves? at least (\d+) feet (?:straight )?toward[^.]{0,60}?hits? it with (?:a|an|its|his|her|their)\s+([A-Za-z' -]+?)\s+(?:attack|on the same turn)/i,
    );
    if (!match) continue;
    const extraAt = text.search(/takes? an extra/i);
    const damage = extraAt < 0 ? [] : parseDamageClauses(text.slice(extraAt));
    const distance = Number(match[1]);
    const riders = parseRiders(text).map((rider) => ({ ...rider, requiresMovement: distance }));
    if (!damage.length && !riders.length) continue;
    return {
      name: trait.name || "Charge",
      option: match[2].trim(),
      damage: damage.map((clause) => ({ ...clause, requiresMovement: distance })),
      riders,
      ...(/can make one [\w' -]{1,20} attack against it as a bonus action/i.test(text)
        ? { unmodeled: "prone-gated bonus-action follow-up attack" }
        : {}),
    };
  }
  return undefined;
}

/**
 * A trait that kills whatever the creature reduces to 0 hit points. One form kills any creature the source drops to 0
 * hit points; another kills only a Giant or a Humanoid the source drops to 0.
 * The engine has read `slaysOnZeroHp` on an attack or save option, where the print is the
 * option's own; here the trait sets it on every damaging attack and save option of the block, with the creature types
 * the sentence names. An aura's damage is also "by" the creature, and `Aura` has no such field: not covered.
 */
const SLAY_TRAIT_TYPES = ["aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey", "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"];

export function parseSlayTrait(monster: any): { name: string; slay: SlayOnZeroHp } | undefined {
  for (const trait of monster.trait || []) {
    const text = stripTags(flattenEntries(trait.entries ?? [])).replace(/\s+/g, " ");
    const match = text.match(/^An? ([A-Za-z]+(?: or an? [A-Za-z]+)*) dies if (?:it is )?reduced to 0 hit points by the [a-z][a-z' -]*?(?: and\b|,|\.)/i)
      ?? text.match(/^An? ([A-Za-z]+(?: or an? [A-Za-z]+)*) (?:that is )?reduced to 0 hit points by the [a-z][a-z' -]*? dies\b/i);
    if (!match) continue;
    const subjects = match[1].toLowerCase().split(/ or an? /);
    if (subjects.length === 1 && subjects[0] === "creature") return { name: trait.name || "", slay: {} };
    if (subjects.every((subject) => SLAY_TRAIT_TYPES.includes(subject))) return { name: trait.name || "", slay: { targetTypes: subjects } };
  }
  return undefined;
}

/**
 * The blur trait: attack rolls against the creature have Disadvantage, and the print says the trait is suppressed
 * while the creature is Incapacitated.
 *
 * Several creatures carry that under different names, and they differ only in what switches the illusion off: most
 * have the Incapacitated clause, one is not fooling anyone who steps inside 15 feet,
 * and one's blur is its own speed. One more, a storm's winds, is the odd one,
 * reaching ranged attack rolls alone, which is why that case is a field here rather
 * than the separate boolean it used to be.
 *
 * Note the newer version has no clause disrupting the effect until the end of its next turn when hit;
 * the older block does, and the older block is not read.
 */
const ATTACKS_AGAINST_DISADVANTAGE_RE = /attack rolls against (?:the|this|it)[\w' -]{0,30}(?:have|are made with) disadvantage/i;
function parseAttacksAgainstDisadvantage(monster: any): AttacksAgainstDisadvantage | undefined {
  for (const trait of monster.trait || []) {
    const text = stripTags(flattenEntries([trait]));
    if (/winds impose disadvantage on ranged attack rolls/i.test(text)) {
      return { name: trait.name || "Winds", rangedOnly: true };
    }
    // Deliberately anchored on the creature being the *target* of the roll. Some traits impose
    // disadvantage on attacks the creature makes, and one creature's aura hobbles attacks
    // against everyone else.
    if (!ATTACKS_AGAINST_DISADVANTAGE_RE.test(text)) continue;
    // A light-gated defence (a shadowy form that applies while the creature is in dim light or darkness) is
    // skipped with the light-gate line, as the other light-gated features are
    // (`lightGatedAttacksAgainst`).
    if (LIGHT_GATE_RE.test(text)) continue;
    const within = text.match(/unless the attacker is within (\d+) feet/i);
    return {
      name: trait.name || "Displacement",
      ...(within ? { minDistance: Number(within[1]) } : {}),
      ...(/incapacitated/i.test(text) ? { requiresConscious: true } : {}),
      ...(/its speed is 0/i.test(text) ? { requiresSpeed: true } : {}),
    };
  }
  return undefined;
}

/**
 * "If the assassin is subjected to an effect that allows it to make a Dexterity saving throw to
 * take only half damage, the assassin instead takes no damage if it succeeds on the save and only
 * half damage if it fails."
 *
 * One creature's avoidance trait is the same sentence with the ability struck out, so it is this
 * field with no `ability` rather than a second one. Both halves of the sentence are required: a
 * trait that merely mentions a half-damage save is not this trait. Named characters print the
 * sentence with "her"/"him" and "she"/"he".
 */
function parseEvasion(monster: any): Evasion | undefined {
  for (const trait of monster.trait || []) {
    const text = stripTags(flattenEntries([trait]));
    const match = text.match(
      /allows (?:it|her|him) to make a (?:(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) )?saving throw to take only half (?:the )?damage/i,
    );
    if (!match || !/instead takes no damage if (?:it|she|he) succeeds/i.test(text)) continue;
    const ability = match[1] ? longAbility[match[1].toLowerCase()] : undefined;
    return { name: trait.name || "Evasion", ...(ability ? { ability } : {}) };
  }
  return undefined;
}

/**
 * A trait whose only reachable branch in a duel is its penalty. A creature's
 * pack trait grants Advantage when at least two other creatures are within 30 feet of it and imposes Disadvantage
 * otherwise; a 1v1 never fields two other creatures, so
 * the creature attacks at Disadvantage for the whole fight.
 *
 * Deliberately narrow: it requires the ally count to be *stated*, so it cannot swallow a
 * trait gated on something the duel merely fails to model (light level, terrain), which stays
 * unmodelled and gets logged.
 */
function alwaysAttacksAtDisadvantage(monster: any): boolean {
  for (const trait of monster.trait || []) {
    const text = flattenEntries([trait]);
    if (!/\bwithin \d+ feet of at least (?:two|three|four|\d+) (?:other )?creatures\b/i.test(text)) continue;
    if (/\botherwise has disadvantage on attack rolls\b/i.test(text)) return true;
  }
  return false;
}

/**
 * "While in a 10-foot Emanation originating from the hobgoblin, the hobgoblin and its allies have Advantage on attack
 * rolls and saving throws, provided the hobgoblin doesn't have the Incapacitated condition" (Aura of Authority). The
 * creature is always inside an Emanation that originates from itself, so in a duel only the Incapacitated proviso gates it.
 */
const OWN_AURA_ADVANTAGE_RE = /\bwhile in a \d+-foot emanation originating from the ([\w-]+), the \1 and its allies have advantage on attack rolls( and saving throws)?, provided the \1 doesn't have the incapacitated condition\b/i;

/** The saving-throw half of that aura. */
export function ownAuraSaveAdvantageTrait(monster: any): boolean {
  return (monster.trait || []).some((trait: any) => !!stripTags(flattenEntries([trait])).match(OWN_AURA_ADVANTAGE_RE)?.[2]);
}

/** "The stalker has the Invisible condition.": a trait that is that sentence and nothing else. */
export function innateInvisibleTrait(monster: any): boolean {
  return (monster.trait || []).some((trait: any) => /^The [\w-]+ has the Invisible condition\.$/i.test(stripTags(flattenEntries(trait.entries)).trim()));
}

/** "While Bloodied, the berserker has Advantage on attack rolls and saving throws": the saving-throw half. */
export function bloodiedSaveAdvantageTrait(monster: any): boolean {
  return (monster.trait || []).some((trait: any) =>
    /\bwhile bloodied, [^.]{0,60}\bhas advantage on [^.]{0,40}\bsaving throws\b/i.test(stripTags(flattenEntries([trait]))));
}

/**
 * A trait that grants Advantage on the creature's own attack rolls in a state the engine tracks: Blood Frenzy (against
 * any creature that doesn't have all its Hit Points), the Bloodied-gated traits (while Bloodied), a Frightened-target
 * trait, Ambusher
 * and Assassinate (a creature yet to act). "Melee attack rolls" narrows it to melee attacks. A trait whose
 * Advantage needs an ally, a choice or an unmodelled state matches none of these and stays in the audit.
 */
export function attackAdvantageTrait(monster: any): AttackAdvantageTrait | undefined {
  for (const trait of monster.trait || []) {
    const text = stripTags(flattenEntries([trait]));
    const when: AttackAdvantageCondition | undefined =
      /\bhas advantage on (?:melee )?attack rolls against any creature that doesn't have all its hit points\b/i.test(text) ? "targetMissingHp"
      : /\bwhile bloodied, [^.]{0,60}\bhas advantage on (?:melee )?attack rolls\b|\bhas advantage on (?:melee )?attack rolls while it is bloodied\b/i.test(text) ? "attackerBloodied"
      : /\bhas advantage on attack rolls against (?:targets that have the frightened condition|any creature that has the frightened condition|frightened creatures)\b/i.test(text) ? "targetFrightened"
      : /\b(?:in the first round of (?:a )?combat|during its first turn), [^.]{0,60}\bhas advantage on attack rolls against any creature that hasn't taken a turn\b/i.test(text) ? "targetNoTurnYet"
      : OWN_AURA_ADVANTAGE_RE.test(text) ? "attackerNotIncapacitated"
      : undefined;
    if (!when) continue;
    return { name: trait.name || "Advantage", when, ...(/\badvantage on melee attack rolls\b/i.test(text) ? { melee: true } : {}) };
  }
  return undefined;
}

/**
 * A Multiattack follow-up that inflicts a condition and nothing else (the target is Grappled,
 * with an escape DC), expressed as an autohit so the existing rider machinery carries it. There
 * is no attack roll and no save to model: the two hits that triggered it were the roll.
 */
function conditionOnlyFollowUp(text: string): CombatAction | undefined {
  const riders = parseRiders(text);
  if (!riders.length) return undefined;
  return { kind: "autohit", damage: [], riders, magical: false, range: 5 };
}

/** Passive immediate death effects. Delayed hazards remain in the skip audit. */
function parseDeathBurst(monster: any, skipped: SkipLog[]): DeathBurst | undefined {
  for (const trait of monster.trait || []) {
    const raw = flattenEntries(trait.entries || []);
    const clean = stripTags(raw);
    const zeroHp = /^(?:when|if) [^.]{1,100}\b(?:drops|is reduced) to 0 hit points\b/i.test(clean);
    const dies = /^(?:when|if) [\w'’ -]{1,60} dies\b/i.test(clean)
      || /^[\w'’ -]{1,60} (?:explodes|bursts) when it dies\b/i.test(clean)
      || /originating from [\w'’ -]{1,40} when it dies\b/i.test(clean);
    if (!zeroHp && !dies) continue;
    if (!/(?:each|any) creature|creatures within/i.test(clean)) continue;
    // Persistent hazards and delayed petrification need a post-combat model. A revival's
    // burst is a different trigger from the terminal effects implemented here.
    if (/moves into the area|starts its turn there|petrif|covered in (?:the )?acid|regains \d+ hit points/i.test(clean)) continue;
    const radius = Number(clean.match(/(?:within (\d+) feet|(\d+)-foot(?:-radius| radius| Emanation))/i)?.slice(1).find(Boolean));
    if (!Number.isFinite(radius)) continue;
    // Keep the immediate outcome, not a phoenix-like creature's touchable cinder, a spore creature's hours-later
    // infection, or a balor's off-plane restoration. These omissions remain explicit below.
    const immediate = raw.split(/\{@actSaveSuccessOrFail\}|The explosion destroys|Unless the \{@condition Poisoned/i)[0];
    const parsed = parseAction({ name: trait.name, entries: [immediate] }, "action", `${monster.name}.trait.${trait.name}`).option?.action;
    if (!parsed || (parsed.kind !== "save" && parsed.kind !== "autohit")) continue;
    if (!parsed.damage.length && !parsed.riders?.length) continue;
    const action = parsed.kind === "save"
      ? { kind: "save" as const, ability: parsed.ability, dc: parsed.dc, onSuccess: parsed.onSuccess,
          damage: parsed.damage, riders: parsed.riders, magical: /\bmagical\b/i.test(stripTags(immediate)), range: radius }
      : { kind: "autohit" as const, damage: parsed.damage, riders: parsed.riders,
          magical: /\bmagical\b/i.test(stripTags(immediate)), range: radius };
    const omissions = [
      /suffers a critical hit/i.test(clean) ? "critical-hit trigger" : "",
      /unless the .*poisoned.*removed/i.test(clean) ? "delayed infection and spawning" : "",
      /the cinder deals/i.test(clean) ? "cinder contact damage and rebirth" : "",
    ].filter(Boolean);
    if (omissions.length) skipped.push({ name: trait.name, where: `${monster.name}.trait`,
      reason: `partially modeled death burst: unmodeled ${omissions.join("; ")}` });
    return { name: trait.name, trigger: zeroHp ? "zeroHp" : "dies", radius, action,
      ...(/creature(?:s)? on the ground/i.test(clean) ? { requiresGrounded: true } : {}) };
  }
  return undefined;
}

/**
 * Traits are recognized by pattern, one mechanic at a time, and anything no pattern claims is
 * dropped. That much is deliberate — an effect with no representation is skipped rather than
 * approximated — but until now it was dropped *silently*, while every unparsed action and
 * defence was logged. `coverage.md` therefore reported the parser as cleaner than it was, and
 * the corpus's largest CR underperformer turned out to be a trait nothing had ever reported:
 * an anger-driven damage bonus, worth roughly 60% of its creature's offence.
 *
 * So: name the traits that carry duel-relevant mechanics and that no parser above consumed.
 * The filter is deliberately mechanical — damage dice, an impactful condition, a swing on
 * attack rolls, healing — because a trait with none of those cannot change a 1v1, and listing
 * it would bury the ones that can.
 */
function unmodeledTraits(monster: any, block: {
  aura?: Aura;
  sourceTurnAura?: Aura;
  retaliation?: Retaliation;
  fury?: Fury;
  charge?: string;
  attacksAgainstDisadvantage?: AttacksAgainstDisadvantage;
  evasion?: Evasion;
  deathBurst?: DeathBurst;
  saveTraits?: string[];
  attackAdvantageWhen?: AttackAdvantageTrait;
  spaceEntry?: CombatStatblock["spaceEntry"];
}): SkipLog[] {
  // Consumed by a parser that matches on the trait's *name*, or handled outside the stat block
  // entirely (Spellcasting becomes options; the sense/movement traits become scalars). One
  // survivor trait sits beside Regeneration because it *is* one, under the corpus's one other name for it —
  // only a single creature carries it.
  const byName = /^(Flyby|Undead Fortitude|Magic Resistance|Legendary Resistance|Regeneration|Survivor|Magic Weapons|Spellcasting|Innate Spellcasting|Amphibious|Hold Breath|Spider Climb|Web Walker|Keen |Pack Tactics|Standing Leap|Siege Monster|Sure-Footed|Speak with|Telepathic|Incorporeal Movement|Ethereal Sight|Devil's Sight|Sunlight Sensitivity|Light Sensitivity|Sunlight Weakness)/i;
  // Consumed by a parser that matches on the trait's *content*.
  const byContent = [
    /attempts? to damage [^.]{0,80}?must first succeed/i,   // damageGate
    /container for (?:the )?\{@creature/i,                   // successor form
    /uses the \{@creature[^}]*\}[^.]{0,80}in place of its own/i,
    /(?:would be reduced|drops?) to 0 hit points[^.]{0,180}(?:resets? to|instead)/i, // mythic reset
    /\bcontains? the corpses? of \{@dice/i,
  ];
  const consumedName = new Set(
    [
      block.aura?.name, block.sourceTurnAura?.name, block.retaliation?.name, block.fury?.name, block.charge,
      block.attacksAgainstDisadvantage?.name, block.evasion?.name, block.deathBurst?.name, ...(block.saveTraits || []),
      block.attackAdvantageWhen?.name, block.spaceEntry?.name,
    ].filter(Boolean).map((n) => (n as string).toLowerCase()),
  );
  const findings: SkipLog[] = [];
  for (const trait of monster.trait || []) {
    const name = trait.name || "";
    if (["Greater Magic Resistance", "Reflective Carapace", "Aversion to Fire"].includes(name) || byName.test(name) || consumedName.has(name.toLowerCase())) continue;
    if (lightGatedAttacksAgainst(trait)) continue; // skipped with the light-gate line in compileMonster
    if (SPEED_LOSS_ON_DAMAGE_RE.test(stripTags(flattenEntries(trait.entries ?? [])))) continue; // speedLossOnDamage
    if ((name === "Multiple Heads" && parseHeads(monster)) || (name === "Reactive Heads" && parseHeads(monster)?.reactive)) continue;
    const text = flattenEntries([trait]);
    if (byContent.some((pattern) => pattern.test(text))) continue;
    // Would it change a duel at all?
    const condition = [...text.matchAll(/\{@condition\s+([^}|]+)/gi)]
      .some((match) => impactfulConditions.has(match[1].trim().toLowerCase()));
    const reason = /\{@damage/.test(text) ? "unmodeled trait: deals damage"
      : /\battack rolls have advantage|\b(?:advantage|disadvantage) on (?:its |the )?attack rolls/i.test(text) ? "unmodeled trait: swings attack rolls"
      : /\bregains?\s+\d+[^.]{0,40}[Hh]it [Pp]oints/.test(text) ? "unmodeled trait: heals"
      // Deliberately non-committal: the audit knows the trait names a condition the engine
      // models, not whether it inflicts one, wards against one, or keys off one. Demogorgon's
      // Two Heads is Advantage on saves *against* a list of conditions, and calling that an
      // application would be a diagnosis the scan has not earned.
      : condition ? "unmodeled trait: condition text"
      : undefined;
    if (reason) findings.push({ name, where: `${monster.name}.trait`, reason });
  }
  return findings;
}

/**
 * "each creature in a 15-foot Emanation originating from the kraken while it is underwater": the action reaches no one
 * out of the water, and the duel is fought on land (as for the Aboleth's Mucus Cloud).
 */
const UNDERWATER_ONLY_RE = /\bwhile (?:it is|the [\w' -]+? is) underwater\b/i;
const UNDERWATER_ONLY_REASON = "environment not modeled: works only while the creature is underwater (the duel is on land)";

/**
 * A Recharge feature that casts one spell twice a use and may replace one cast with another spell (`castsTwiceSpell`):
 * the routines are the spell twice, and the spell with each replacement in either order. The single casts go.
 */
function castsTwiceRoutines(monster: any, options: ActionOption[], routines: Routine[]): Routine[] {
  const name = castsTwiceSpell(monster);
  const twice = (idx: number) => { const uses = options[idx]?.uses; return uses?.t === "recharge" && uses.casts === 2 && options[idx].timing === "action"; };
  const main = options.findIndex((option, idx) => twice(idx) && option.name === name);
  if (main < 0) return routines;
  const others = options.map((_, idx) => idx).filter((idx) => twice(idx) && idx !== main);
  return [
    ...routines.filter((routine) => !(routine.parts.length === 1 && routine.parts[0].count === 1 && twice(routine.parts[0].optionIdx))),
    { name: `${options[main].name} x2`, parts: [{ optionIdx: main, count: 2 }] },
    ...others.flatMap((idx) => [
      { name: `${options[idx].name} + ${options[main].name}`, parts: [{ optionIdx: idx, count: 1 }, { optionIdx: main, count: 1 }] },
      { name: `${options[main].name} + ${options[idx].name}`, parts: [{ optionIdx: main, count: 1 }, { optionIdx: idx, count: 1 }] },
    ]),
  ];
}

function sizeRank(monster: any): number {
  // "Medium or Small Humanoid": the size printed first, the larger (the data lists the pair smallest first).
  const ranks = { T: 0, S: 1, M: 2, L: 3, H: 4, G: 5 } as Record<string, number>;
  // A creature that fights in its hybrid form has that form's size ("shape-shifts into a Large bear-humanoid hybrid form").
  const hybrid = fightsInHybridForm(monster)
    && flattenEntries(monster.bonus || []).match(/shape-shifts into a (Tiny|Small|Medium|Large|Huge|Gargantuan) [a-z]+-humanoid hybrid\b/i);
  if (hybrid) return ranks[hybrid[1][0].toUpperCase()];
  return Math.max(...(Array.isArray(monster.size) ? monster.size : [monster.size]).map((raw: string) => ranks[raw] ?? 2));
}

function creatureTags(monster: any): string[] {
  const type = monster.type && typeof monster.type === "object" ? monster.type : {};
  return (type.tags || []).flatMap((tag: unknown) => {
    if (typeof tag === "string") return [tag.toLowerCase()];
    if (tag && typeof tag === "object" && typeof (tag as any).tag === "string") return [(tag as any).tag.toLowerCase()];
    return [];
  });
}

function markMagicalAttacks(action: CombatAction): CombatAction {
  if (action.kind === "random") return { ...action, branches: action.branches.map(markMagicalAttacks) };
  if (action.kind !== "attack") return action;
  return { ...action, magical: true };
}

/**
 * A defensive reaction the print makes depend on seeing the attacker. Two places carry it: a closing sentence (the
 * creature must see the attacker, or must be able to see it) and the trigger itself (an attacker the creature can see
 * hits it, or a sighted creature makes an attack roll against it). A teleport whose destination must be visible is not
 * a gate on the attacker and does not match.
 */
export const REACTION_SIGHT_GATE = /\bmust (?:be able to )?see the attacker\b|\b(?:provided|if) (?:it|he|she|they) can see the attacker\b|\b(?:creature|attacker) the [\w' -]{1,40}? can see (?:hits|makes)\b/i;

/** The complete five-head SRD contract; partial head prose stays in the coverage report. */
function parseHeads(monster: any): CombatStatblock["heads"] {
  const text = flattenEntries((monster.trait || []).filter((t: any) => t.name === "Multiple Heads"));
  if (!/has five heads/i.test(text) || !/takes 25 damage or more on a single turn/i.test(text)
    || !/grows two heads for each/i.test(text) || !/regains 20/i.test(text)
    || !/dies if all its heads are dead/i.test(text) || !/unless it has taken Fire damage since its last turn/i.test(text)) return undefined;
  return { initial: 5, threshold: 25, regrow: 2, healing: 20,
    reactive: (monster.trait || []).some((t: any) => t.name === "Reactive Heads"
      && /extra Reaction that can be used only for Opportunity Attacks/i.test(flattenEntries(t.entries))) };
}


/**
 * Common defensive reactions: AC boosts, damage halving, damage negation and missile deflection.
 *
 * `consumed` collects the name of the raw reaction entry this claimed, so that
 * `unmodeledReactions` can report every entry that nothing represents. A `Reaction` carries no
 * name of its own, and only one entry survives per creature, so the name is pushed at the end
 * rather than as each pattern matches.
 */

function parseReaction(monster: any, consumed: string[], options: ActionOption[]): Reaction | undefined {
  let best: Reaction | undefined;
  let bestName: string | undefined;
  for (const raw of monster.reaction || []) {
    const text = flattenEntries(raw.entries);
    // A reaction that only shields somebody else does nothing in a duel: a plant
    // may halve the blow only while a small plant ally stands within 5 feet, and none ever does.
    if (/while (?:a|an|another) [\w' -]{1,30} is within \d+ feet/i.test(text)) continue;
    const uses = parseUses(raw.name || "");
    if (/starts its turn within 30 feet.*can see the devil/i.test(text)) {
      const parsed = parseAction(raw, "action", "reaction").option?.action;
      if (parsed?.kind === "save") {
        parsed.range = 30; parsed.requiresSight = true;
        parsed.riders = parsed.riders.map(r => ({ ...r, duration: "endOfTargetTurn" }));
        parsed.immuneOnSuccess = { key: "unnervingGaze", trigger: "save" };
        best = { kind: "turnStart", acBonus: 0, meleeOnly: false, turnStart: parsed };
        bestName = raw.name; continue;
      }
    }
    // Only claim the complete SRD trigger/reduction/return-shot contract.
    const reduction = text.match(/reduces the damage it takes from the attack by \d+ \(\{@dice ([^}]+)\}/i);
    if (/hit by a ranged attack roll/i.test(text) && /Bludgeoning, Piercing, or Slashing damage/i.test(text)
      && reduction && /if that damage is reduced to 0/i.test(text)) {
      const dc = text.match(/\{@dc (\d+)\}/i);
      const range = text.match(/within (\d+) feet/i);
      const damage = text.match(/\{@damage ([^}]+)\}\) Force damage/i);
      if (dc && range && damage) {
        best = { kind: "deflectMissile", acBonus: 0, meleeOnly: false, uses,
          reduction: parseDice(reduction[1]), redirect: { kind: "save", ability: "dex", dc: Number(dc[1]),
            range: Number(range[1]), magical: false, requiresSight: true,
            damage: [{ dice: parseDice(damage[1]), type: "force" }], onSuccess: "none", riders: [] } };
        bestName = raw.name;
        continue;
      }
    }

    // Only a per-day limit is carried: `reactionAvailable` understands that one, and no
    // reaction this parser claims recharges, so a `recharge` here would read as at-will.
    const limited = uses.t === "perDay" ? { uses } : {};
    // Carried with whichever defensive shape this entry compiles to; a Shield spell that displaces it below carries none.
    const sight = REACTION_SIGHT_GATE.test(text) ? { requiresSight: true as const } : {};
    // A wording that adds 5 to the creature's AC (with "its", or a gendered possessive for a named creature), which
    // the legendary resolver also had to handle. The other wording is
    // a bonus rather than an addition: a +5 to its own AC for that one attack,
    // taken only where the creature wards *itself*, since a shield guardian shields the wearer
    // of its amulet and another construct its neighbour.
    const match = text.match(/adds\s+(\d+)\s+to (?:its|his|her|their) (?:AC|Armor Class)/i)
      ?? (/\bitself\b/i.test(text) ? text.match(/\+(\d+) bonus to (?:its |his |her |their )?(?:AC|Armor Class)/i) : null);
    if (match) {
      // A barrier that lasts until the creature's next turn begins is the Shield spell's duration
      // and not a parry's one attack, so it goes in the slot that keeps the bonus up.
      const kind = /lasts until the start of its next turn/i.test(text) ? "shield" as const : "parry" as const;
      best = { kind, acBonus: Number(match[1]), meleeOnly: /melee attack/i.test(text), ...limited, ...sight };
      if (/On a miss, the pirate makes one Rapier attack/i.test(text)) {
        const idx = options.findIndex(o => o.name === "Rapier");
        if (idx >= 0) best.counterOptionIdx = idx;
      }
      if (/the mummy teleports up to 60 feet/i.test(text)) {
        best.response = { kind: "autohit", damage: [], magical: false, range: 5, requiresSight: true,
          teleport: { distance: 60, anchor: "destination", requiresSight: true },
          riders: [{ condition: "blinded", duration: "endOfSourceNextTurn" }] };
      }
      bestName = raw.name;
    }
    // A reaction that halves the damage, one that halves the attack's damage to the creature itself, and a wording that
// cuts the damage it takes to half.
    if (/\bhalves the [\w' ]{0,20}damage\b|\btakes half (?:the )?damage\b|\breduc(?:es|ing) the damage[^.]{0,30}by half\b/i.test(text)) {
      best = { kind: "damageHalf", acBonus: 0, meleeOnly: false, ...limited, ...sight };
      bestName = raw.name;
    }
    if (/\breduces? the damage to 0\b/i.test(text)) {
      const healing = text.match(/\{@dice\s+([^}]+)\}/i);
      best = {
        kind: "damageNegation",
        acBonus: 0,
        meleeOnly: false,
        healing: healing ? parseDice(healing[1]) : undefined,
        ...limited,
        ...sight,
      };
      bestName = raw.name;
    }
  }
  const shieldBlock = (monster.spellcasting || []).find(
    (block: any) => /\{@spell shield(?:\||\})/i.test(JSON.stringify(block)),
  );
  if (shieldBlock) {
    const nameLimit = Number(String(shieldBlock.name || "").match(/\((\d+)\/Day\)/i)?.[1] || 0);
    // A `daily` key is a per-day count, not a spell level, and it only budgets Shield when Shield
    // is in that bucket. Reading the largest key of any daily bucket charged one archmage's
    // Shield to his 1/Day fly-and-lightning-bolt group — one cast, while the four 1st-level slots
    // it actually comes from went on budgeting his Magic Missile at four.
    const shieldDaily = Object.entries(shieldBlock.daily || {}).find(([, refs]) =>
      /\{@spell shield(?:\||\})/i.test(JSON.stringify(refs))
    );
    const bucketLimit = shieldDaily ? Number(shieldDaily[0].match(/\d+/)?.[0] || 0) : 0;
    const shieldLevel = Object.entries(shieldBlock.spells || {}).find(([, bucket]) =>
      /\{@spell shield(?:\||\})/i.test(JSON.stringify(bucket))
    )?.[0];
    const spellSlots = shieldLevel ? Number(shieldBlock.spells?.[shieldLevel]?.slots || 0) : 0;
    // Only a slot-borne Shield shares a pool. A named limit or a daily bucket is its own budget,
    // and giving it a pool would have it spend slots it never drew on.
    const uses: Uses = nameLimit || bucketLimit
      ? { t: "perDay", max: nameLimit || bucketLimit }
      : spellSlots && shieldLevel
        ? { t: "perDay", max: spellSlots, pool: `spell-slots:${shieldLevel}` }
        : { t: "atWill" };
    // Shield displaces a weaker parry, and with it the reaction entry that parry came from:
    // that entry is then represented by nothing and belongs in the audit like any other.
    if (!best || best.acBonus < 5) {
      best = { kind: "shield", acBonus: 5, meleeOnly: false, uses };
      bestName = undefined;
    }
  }
  if (bestName) consumed.push(bestName);
  return best;
}

/**
 * Split a reaction entry into what fires it and what it does. 2024 blocks mark the boundary
 * themselves; 2014 prose puts the trigger in the entry's opening clause and the response after
 * the comma that closes it, and every reaction in the corpus is written that way.
 *
 * Keeping the two apart is what lets the distances come out right. One sahuagin leader's trigger
 * names no distance at all while its response is a 5-foot Emanation; one cockatrice-like creature's
 * trigger and response share one range of 120 feet; and one undead creature is hurt from anywhere
 * and sprays only what stands next to it.
 */
function reactionClauses(text: string): { trigger: string; response: string } {
  const tagged = text.match(/\{@actTrigger\}([\s\S]*?)\{@actResponse/i);
  if (tagged) return { trigger: stripTags(tagged[1]), response: stripTags(text.slice(text.indexOf("{@actResponse"))) };
  const comma = text.indexOf(",");
  if (comma < 0) return { trigger: stripTags(text), response: stripTags(text) };
  return { trigger: stripTags(text.slice(0, comma)), response: stripTags(text.slice(comma + 1)) };
}

/** The trigger the reaction answers, with the gates the trigger clause states on it. */
function parseRebukeTrigger(trigger: string): Pick<Rebuke, "trigger" | "triggerRange" | "requiresDamageTypes" | "requiresSight"> | undefined {
  const within = trigger.match(/within (\d+) feet/i);
  const triggerRange = within ? Number(within[1]) : undefined;
  // A target phrased as one the creature can see, or "a visible creature". An unseen attacker is safe from either.
  const requiresSight = /\bcan see\b|\bvisible creature\b/i.test(trigger) || undefined;
  const typed = trigger.match(/tak(?:es|ing) ([A-Za-z]+(?: or [A-Za-z]+)?) damage/i);
  const requiresDamageTypes = typed
    ? typed[1].toLowerCase().split(/ or /).filter((word) => damageTypes.includes(word))
    : [];
  const base = {
    ...(triggerRange !== undefined ? { triggerRange } : {}),
    ...(requiresSight ? { requiresSight } : {}),
    ...(requiresDamageTypes.length ? { requiresDamageTypes } : {}),
  };
  // Ordered: one vampire's trigger clause also says "takes damage", and it is the foe's
  // damage rather than its own that answers.
  if (/enter(?:s|ing) a space within \d+ feet/i.test(trigger)) return { trigger: "enteredReach", ...base };
  if (/\bbloodied creature\b[^.]*\btakes damage/i.test(trigger)) return { trigger: "foeBloodiedDamaged", ...base };
  if (/\bbeing hit by a melee attack\b/i.test(trigger)) return { trigger: "hitByMeleeAttack", ...base };
  if (/\bhits it with an attack roll\b/i.test(trigger)) return { trigger: "hitByAttack", ...base };
  if (/\btak(?:es|ing) (?:[A-Za-z]+ (?:or [A-Za-z]+ )?)?damage\b|\b(?:is|being) damaged\b|\bdeals damage to it\b/i.test(trigger)) {
    return { trigger: "tookDamage", ...base };
  }
  return undefined;
}

/**
 * Attack references inside a reaction's response, resolved against the compiled options exactly
 * as a legendary action's are. The name guard is the same one the legendary resolver and the
 * Multiattack parser use — a referenced name may never contain the word "attack" itself — and
 * alternatives ("one Bite or Greatsword attack") all join, to be chosen between by expected
 * value at the distance the reaction actually fires from.
 */
function rebukeAttackRefs(text: string, options: ActionOption[]): { optionIdx: number; count: number }[] {
  const ref = text.match(/\bmakes?\s+(a|an|one|two|three|four|\d+)\s+((?!attacks?\b)[A-Za-z](?:(?!attacks?\b)[A-Za-z', -])*?) attacks?\b/i);
  if (!ref) return [];
  const count = refCount(ref[1]);
  const out: { optionIdx: number; count: number }[] = [];
  for (const name of ref[2].split(/\s+or\s+/).map((part) => part.trim()).filter(Boolean)) {
    const optionIdx = findOption(options, name);
    if (optionIdx >= 0) out.push({ optionIdx, count });
  }
  return out;
}

/**
 * A reaction that answers damage taken by making one named attack against a randomly chosen creature in reach; or, when
 * a creature in its sight within 60 feet deals damage to it, forcing that creature to make an Intelligence save or take
 * psychic damage. Two shapes, one slot: both
 * spend the creature's single reaction.
 *
 * The saving-throw shape needs no parser of its own: it is an ordinary save action written in
 * a reaction entry, and `parseAction` already reads both the older prose and the newer tags, down
 * to an autohit gated on the victim being Grappled. Only the attack
 * references and the trigger are new.
 *
 * Deliberately not claimed, and left to `unmodeledReactions`: responses that only blunt the
 * incoming blow (Parry, Deflect Missile, Uncanny Dodge: `parseReaction`'s territory), those
 * that teleport or turn invisible, those that need an ally, and those whose only effect is a
 * condition the engine cannot hold for the duration the text states.
 */
function parseRebuke(monster: any, options: ActionOption[]): { rebuke: Rebuke; name: string } | undefined {
  for (const raw of monster.reaction || []) {
    const text = flattenEntries(raw.entries);
    const { trigger: triggerText, response } = reactionClauses(text);
    const trigger = parseRebukeTrigger(triggerText);
    if (!trigger) continue;
    const uses = parseUses(raw.name || "");
    const attacks = rebukeAttackRefs(response, options);
    if (attacks.length) {
      // A reaction usable when no creature is within reach, making two attacks.
      const fallbackText = response.match(/\bif no creature is within reach[^.]*/i)?.[0];
      const fallbackAttacks = fallbackText ? rebukeAttackRefs(fallbackText, options) : [];
      return {
        name: raw.name,
        rebuke: {
          name: raw.name,
          ...trigger,
          uses,
          attacks,
          ...(fallbackAttacks.length ? { fallbackAttacks } : {}),
          ...(/\bwith advantage\b/i.test(response) ? { advantage: true } : {}),
        },
      };
    }
    // The response keeps the partial Speed cut its print carries (a cursed creature's Speed decreases by 10 feet);
    // it had been held out.
    const action = rebukeResponseAction(raw, response, text);
    if (action) return { name: raw.name, rebuke: { name: raw.name, ...trigger, uses, action } };
  }
  return undefined;
}

/**
 * A rebuke cast as a spell: Hellish Rebuke, listed under Spellcasting or in a spellcasting block
 * printed as a reaction. The spell's casting-time condition is the trigger, read exactly as a
 * reaction's trigger clause is, and its compiled action is the response. The block holds one
 * rebuke, so the first spell whose trigger reads takes it; the rest are reported.
 *
 * The uses are the spell's own. A prepared caster's slot pool is shared with its other spells of
 * that level, but a rebuke keeps its own count: one knight's Hellish Rebuke has four uses
 * beside its four first-level slots for Command and its other spells.
 */
function spellRebuke(
  monster: any,
  printed: { rebuke: Rebuke; name: string } | undefined,
  reactions: SpellReaction[],
  skipped: SkipLog[],
): { rebuke: Rebuke; name: string } | undefined {
  let found = printed;
  for (const { option, trigger: text } of reactions) {
    const where = `${monster.name}.spellcasting`;
    // The Oread lists Hellish Rebuke under Innate Spellcasting "(see Reactions below)", and the
    // reaction it points to is the rebuke already read.
    if (found) {
      skipped.push({ name: option.name, where, reason: `reaction spell: the block's rebuke is ${found.name}` });
      continue;
    }
    const trigger = parseRebukeTrigger(text);
    if (!trigger) {
      skipped.push({ name: option.name, where, reason: "unmodeled reaction spell: trigger not read" });
      continue;
    }
    found = { name: option.name, rebuke: { name: option.name, ...trigger, uses: option.uses, action: option.action } };
  }
  return found;
}

/**
 * The non-attack half of a rebuke: a saving-throw burst, or damage dealt to a creature the
 * reactor is already holding. Everything here comes out of `parseAction`; what this adds is the
 * decision about which of its results a *reaction* may carry.
 */
function rebukeResponseAction(raw: any, response: string, text: string): CombatAction | undefined {
  // A response that blunts a blow rather than answering it. A wizard's damage-absorbing ward
  // (a barrier that takes 21 off the damage the protected creature suffers) is a damage
  // *reduction*, and read as a burst it would fling 26 points at the opponent every fourth
  // round. `parseReaction` owns this whole family (Parry, Uncanny Dodge, Deflect Missile); what
  // it cannot read stays unmodelled rather than being turned inside out.
  if (/\breduc(?:es?|ing) (?:the |any |that )?damage\b/i.test(response)) return undefined;
  // Success on the save makes the creature immune to this effect for 24 hours.
  // Only `Aura` represents that, so a reaction resting on it would re-roll every round it fired
  // and be worth several times what the page grants. Only one creature has it.
  if (/immune to [^.]{0,60}for 24 hours/i.test(text)) return undefined;
  // A reaction where the creature heals and deals force damage to each creature it has swallowed: the same mechanic as
  // another creature's swallow reaction, but with the gate
  // buried in the verb and a heal attached, so `parseAction` reads only the heal. One carrier.
  const held = response.match(/deals?\s+\d+\s*\(([^)]+)\)\s+([a-z]+) damage to each (swallowed|grappled|restrained) creature/i);
  if (held) {
    const heal = Number(response.match(/regains?\s+(\d+)\s+hit points/i)?.[1] || 0);
    return {
      kind: "autohit",
      damage: [{ dice: parseDice(held[1]), type: held[2].toLowerCase(), ...(heal ? { healsAttackerFlat: heal } : {}) }],
      magical: false,
      range: 5,
      requiresTargetCondition: held[3].toLowerCase(),
    };
  }
  const parsed = parseAction({ name: raw.name, entries: raw.entries }, "action", `${raw.name}.reaction`).option?.action;
  if (!parsed || (parsed.kind !== "save" && parsed.kind !== "autohit")) return undefined;
  const riders = parsed.riders || [];
  if (!parsed.damage.length && !riders.some((rider) => impactfulConditions.has(rider.condition))) return undefined;
  const action = structuredClone(parsed);
  // The jump a reaction may also make is out of scope: performing it needs the engagement and
  // the movement evaluator, neither of which a reaction resolution holds. A storm-themed
  // creature's reaction therefore deals its thunder and stays where it is.
  delete action.teleport;
  // An area of damage worded as every creature in a 5-foot Emanation originating from the creature, followed by a curse
  // clause that mentions 120 feet. `parseRange` takes the first "within N feet" it sees, which is
  // the curse's; the emanation is the area the damage actually covers.
  const emanation = text.match(/(\d+)-foot \{@variantrule Emanation[^}]*\} originating from/i);
  if (emanation) action.range = Number(emanation[1]);
  return action;
}

/**
 * A Reaction that adds a number to a roll the creature itself makes (`CombatStatblock.rollBoost`): "Trigger: The sphinx
 * or another creature within 30 feet makes an ability check or a saving throw. Response: The sphinx adds 2 to the roll."
 */
function rollBoostReaction(monster: any): { raw: string; name: string; bonus: number; perDay: number } | undefined {
  for (const raw of monster.reaction || []) {
    const text = stripTags(flattenEntries(raw.entries));
    const bonus = text.match(/\bThe [a-z' -]+ or another creature within \d+ feet makes an ability check or a saving throw\.\s*(?:Response:)?\s*The [a-z' -]+ adds (\d+) to the roll\b/i)?.[1];
    const perDay = String(raw.name ?? "").match(/\((\d+)\/Day\)/i)?.[1];
    if (bonus && perDay) return { raw: String(raw.name), name: String(raw.name).replace(/\s*\([^)]*\)\s*$/, ""), bonus: Number(bonus), perDay: Number(perDay) };
  }
  return undefined;
}

/**
 * Every raw reaction that neither `parseReaction` nor `parseRebuke` claimed. Reactions were the
 * last section of a stat block still dropped in silence — traits stopped being on 2026-09-03 —
 * so `coverage.md` reported nothing at all about the hundred the compiler could not read, and
 * the corpus's damage-triggered rebukes went unnoticed for as long as they did.
 */
function unmodeledReactions(monster: any, consumed: Set<string>): SkipLog[] {
  const findings: SkipLog[] = [];
  for (const raw of monster.reaction || []) {
    if (consumed.has(raw.name || "")) continue;
    const text = flattenEntries(raw.entries);
    const condition = [...text.matchAll(/\{@condition\s+([^}|]+)/gi)]
      .some((match) => impactfulConditions.has(match[1].trim().toLowerCase()));
    const reason = /\bmakes?\s+(?:a|an|one|two|three|four|\d+)\s+[A-Za-z][A-Za-z', -]*attacks?\b/i.test(stripTags(text))
      ? "unmodeled reaction: makes an attack"
      : /\{@damage/.test(text) ? "unmodeled reaction: deals damage"
      : condition ? "unmodeled reaction: condition text"
      : "unmodeled reaction: no duel-relevant effect";
    findings.push({ name: raw.name, where: `${monster.name}.reaction`, reason });
  }
  return findings;
}

function parseDamageGate(monster: any): DamageGate | undefined {
  const text = flattenEntries(monster.trait || []);
  const match = text.match(
    /attempts? to damage [^.]{0,80}?must first succeed on a \{@dc\s+(\d+)\}\s+([A-Za-z]+)\s+saving throw or be \{@condition\s+([^}|]+)/i,
  );
  if (!match) return undefined;
  const ability = abilities.find((candidate) => candidate === match[2].slice(0, 3).toLowerCase());
  if (!ability) return undefined;
  return {
    dc: Number(match[1]),
    ability,
    condition: match[3].toLowerCase(),
    duration: /until the end of the creature's next turn/i.test(text) ? "endOfTargetNextTurn" : "permanent",
    magical: /\bmagical(?:ly)?\b/i.test(match[0]),
  };
}

function legendaryResistance(monster: any): number {
  const text = flattenEntries(monster.trait || []);
  // Some blocks print the plural: "Legendary Resistances (3/Day)".
  const match = text.match(/Legendary Resistances? \((\d+)\/Day/i);
  return match ? Number(match[1]) : 0;
}

/**
 * Damage absorption, printed as a trait: "Whenever the golem is subjected to Fire damage, it regains a number of Hit
 * Points equal to the Fire damage dealt" (one giant construct regains half). Only the trait form: a reaction that grants
 * resistance is not healing.
 */
function parseAbsorption(monster: any): CombatStatblock["absorption"] {
  for (const trait of monster.trait || []) {
    if (!/Absorption/i.test(trait.name || "")) continue;
    const text = stripTags(flattenEntries(trait.entries));
    const heal = text.match(/regains? a number of hit points equal to (half )?the ([a-z]+) damage/i);
    const subject = text.match(/subjected to ([a-z]+) damage/i);
    if (!heal || !subject || heal[2].toLowerCase() !== subject[1].toLowerCase()) continue;
    return { name: trait.name, types: [subject[1].toLowerCase()], fraction: heal[1] ? 0.5 : 1 };
  }
  return undefined;
}

/**
 * A feature that works only in some light: a teleport while the creature is in dim light or darkness, or a defence
 * that applies if it is in dim light or darkness. There is no
 * lighting model, so a light-gated feature is dropped with a skip line rather than assumed, as the conditional
 * defences already are. A negated gate (one that applies unless the creature is in sunlight) is not one: with no
 * light model it always holds.
 */
const LIGHT_GATE_RE = /\b(?:while|if|only)\b(?![^.]{0,40}\b(?:isn't|is not|aren't|are not)\b)[^.]{0,40}\bin\s+(?:dim light|darkness|bright light|sunlight)\b/i;
const LIGHT_GATE_REASON = "light-gated feature: no lighting model";
/**
 * Three more wordings of the light gate, read for options only (the two trait readers keep `LIGHT_GATE_RE`): a move
 * gated on the creature being in dim light or darkness, one that requires both the starting space and the destination to
 * be dim or dark, one that says the creature must be in such light, and one that sends it to an unoccupied space
 * of such light. The
 * negated gate stays unread, as in `LIGHT_GATE_RE`.
 */
const OPTION_LIGHT_GATE_RES = [
  LIGHT_GATE_RE,
  /\b(?:when|provided that)\b(?![^.]{0,40}\b(?:isn't|is not|aren't|are not)\b)[^.]{0,80}\b(?:is|are|be)\s+in\s+(?:dim light|darkness|bright light|sunlight)\b/i,
  /\bmust be in\s+(?:dim light|darkness|bright light|sunlight)\b/i,
  /\bspace of (?:dim light|darkness|bright light)\b/i,
];
const optionLightGated = (text: string) => OPTION_LIGHT_GATE_RES.some((re) => re.test(text));

/**
 * An option that acts on a corpse: a feast on the corpse of an enemy that died within the past minute, followed by a
 * save for nearby creatures; a corpse made to do something unnatural (possessing a corpse needs an intact corpse and is
 * not compiled); and a corpse caused to burst. A duel starts with two living creatures and ends when one is down, so
 * there is no corpse to use: each compiled as a save usable from the first round. It is dropped with a skip line, as is
 * a spell that needs brains that were never eaten. Read in the option's first sentence, so the
 * aftermath an effect leaves (a swallowed creature escaping from the corpse, a Shadow rising from it) is not a
 * gate; a self-heal on the creature's own printed stock of corpses keeps its `corpse-stock` uses.
 */
const CORPSE_GATE_REASON = "needs a corpse: none exists in a duel before it ends";

function needsCorpse(raw: { entries?: unknown }, parsed: ActionOption[]): boolean {
  if (parsed.some((option) => option.action.kind === "selfheal")) return false;
  return /\bcorpse\b/i.test(stripTags(flattenEntries(raw.entries)).split(/\.(?:\s|$)/)[0]);
}
// The damage goes to a ship or to the creature itself, and the parser leaves it out (`hasNonFoeDamage`): a ship-attaching
// attack, an incorporeal dash. With nothing else to compile, the entry is skipped.
const NON_FOE_DAMAGE_REASON = "damage to a ship or to the creature itself not modeled (not dealt to the foe); nothing else to compile";
const lightGatedMagicResistance = (trait: any) =>
  /^Magic Resistance/i.test(trait.name || "") && LIGHT_GATE_RE.test(flattenEntries(trait.entries));

/** A trait that would compile `attacksAgainstDisadvantage` but is light-gated: skipped. */
const lightGatedAttacksAgainst = (trait: any) => {
  const text = stripTags(flattenEntries([trait]));
  return ATTACKS_AGAINST_DISADVANTAGE_RE.test(text) && LIGHT_GATE_RE.test(text);
};

function hasMagicResistance(monster: any): boolean {
  return /Magic Resistance/i.test(flattenEntries((monster.trait || []).filter((trait: any) => !lightGatedMagicResistance(trait))));
}

/** The printed conditions a condition-save Advantage can name, in the words a trait uses for them. */
const SAVE_ADVANTAGE_CONDITIONS = [
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "paralyzed", "petrified",
  "poisoned", "prone", "restrained", "stunned", "unconscious",
];

/**
 * Condition-specific save Advantage and magical-sleep immunity, from the traits that print them:
 * Fey Ancestry (Advantage on saves against being charmed, plus a sleep immunity;
 * newer wording: to avoid or end the Charmed condition), a dwarvish resilience trait, and their kin. Only a trait whose
 * sentence gives Advantage on saves followed
 * by the conditions counts; its clause runs to the sentence end or to the clause about magical sleep.
 *
 * Left out, deliberately: a clause that holds only with an ally nearby or on a
 * dice roll (a 25 percent chance of an extra head); Advantage against
 * spells or magical effects in general (the first half of the dwarvish trait; recorded as a partial skip);
 * effects that would knock it prone (Sure-Footed, which names Strength and Dexterity saves).
 */
function conditionSaveTraits(monster: any): {
  conditionSaveAdvantage?: string[];
  sleepImmune?: true;
  consumed: string[];
  partial: SkipLog[];
} {
  const conditions = new Set<string>();
  let sleepImmune = false;
  const consumed: string[] = [];
  const partial: SkipLog[] = [];
  for (const trait of monster.trait || []) {
    const text = stripTags(flattenEntries([trait]));
    let used = false;
    if (!/\bwithin \d+ feet of (?:at least )?(?:one|an?) all(?:y|ies)|\b\d+\s*(?:%|percent)?\s*chance of\b/i.test(text)) {
      for (const match of text.matchAll(/\badvantage on (?:saving throws|saves)\b([^.]*)/gi)) {
        // The creature's own saves only: a trait that gives Advantage to allies in an Emanation is not.
        const subject = text.slice(text.lastIndexOf(".", match.index) + 1, match.index);
        if (/\b(?:allies|creatures|each creature|any creature|others?)\b/i.test(subject)) continue;
        const clause = match[1].split(/,? and magic can(?:'|’)t|,? and (?:is|has) immun/i)[0];
        if (!/^\s*(?:it makes\s+)?(?:against|to avoid or end)\b/i.test(clause)) continue;
        const named = SAVE_ADVANTAGE_CONDITIONS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(clause));
        if (!named.length) continue;
        for (const c of named) conditions.add(c);
        used = true;
        if (/\bagainst spells\b/i.test(clause)) {
          partial.push({ name: trait.name || "", where: `${monster.name}.trait`,
            reason: "partially modeled: Advantage on saves against spells in general is not modelled" });
        }
      }
    }
    // Also a mind-shielding trait: magic can't read the creature's thoughts or put it to sleep.
    if (/\bmagic can(?:'|’)t (?:[^.]{0,40}? or )?put [^.]{0,40}? to sleep\b/i.test(text)) {
      sleepImmune = true;
      used = true;
    }
    if (used) consumed.push(trait.name || "");
  }
  return {
    ...(conditions.size ? { conditionSaveAdvantage: SAVE_ADVANTAGE_CONDITIONS.filter((c) => conditions.has(c)) } : {}),
    ...(sleepImmune ? { sleepImmune: true as const } : {}),
    consumed,
    partial,
  };
}

/**
 * The same second life printed as: if the creature drops to 0 hit points, it neither dies nor falls unconscious, and
 * instead sheds its skin and regains 199 hit points, or it regains 30 hit points. The riders those traits add (a free
 * move, temporary hit points, a radiant burst) are not carried.
 */
const RESET_REGAINS_RE = /\b(?:is|would be) reduced to 0 hit points, (?:[a-z]+ (?:doesn't|does not) die or fall (?:\{@condition )?unconscious\}?\. Instead, [^.]{0,60}?|(?:it|he|she|they) )regains (\d+) hit points/i;

function mythicResetHp(monster: any): number | undefined {
  const text = flattenEntries(monster.trait || []);
  const match = text.match(/(?:would be reduced|drops?) to 0 hit points[^.]{0,180}(?:resets? to|instead (?:has|regains))\s+(\d+)\s+hit points/i)
    ?? text.match(RESET_REGAINS_RE);
  return match ? Number(match[1]) : undefined;
}

/**
 * Is the reset printed as a replacement? One form replaces the drop to 0: the creature's hit points are set to 400
 * instead, so it never reaches 0 and an effect keyed on a drop to 0 (a slay) has no trigger. Not the other wordings,
 * where the creature does hit 0 and then stays up and regains hit points: those are reduced to 0.
 */
function mythicResetReplaces(monster: any): boolean {
  const text = flattenEntries(monster.trait || []);
  // The "is reduced to 0 hit points ... regains" wordings answer a slay too (the creature doesn't die or fall
  // unconscious and instead regains hit points, which resolves before the slay).
  return /\bwould be reduced to 0 hit points[^.]{0,180}\binstead (?:resets? to|has|regains)\s+\d+\s+hit points/i.test(text) || RESET_REGAINS_RE.test(text);
}

/** The one trait that prints the reset (`mythicResetHp` reads all the traits at once; these read the trait itself). */
function mythicResetTrait(monster: any): string | undefined {
  for (const trait of monster.trait || []) {
    const text = flattenEntries([trait]);
    if (/(?:would be reduced|drops?) to 0 hit points[^.]{0,180}(?:resets? to|instead (?:has|regains))\s+(\d+)\s+hit points/i.test(text) || RESET_REGAINS_RE.test(text)) return text;
  }
  return undefined;
}

/**
 * The reset is printed as a regain (the creature sheds its skin and regains 199 hit
 * points, or regains 30 hit points), so a heal block stops it. A wording that sets its hit points to 400 as a
 * replacement is not a regain.
 */
function mythicResetRegains(monster: any): boolean {
  const text = mythicResetTrait(monster);
  return text !== undefined && /\bregains\s+\d+\s+hit points/i.test(text);
}

/**
 * What the reset's print does not restore. Some prints name both a recharged Breath Weapon and regained
 * Legendary Resistance uses; one names only the recharge of its Steam Breath; others name neither. A recharge option is
 * printed as recharged when the trait names it, or names the printed action its shared pool was split from (the metallic
 * dragons' "Breath Weapon" compiles as Elemental Breath and Sapping Breath on one pool).
 */
function mythicResetKeeps(monster: any, options: ActionOption[], pool: number): CombatStatblock["mythicResetKeeps"] {
  const text = mythicResetTrait(monster);
  if (text === undefined) return undefined;
  const clean = stripTags(text).toLowerCase();
  const said = [...clean.matchAll(/\brecharges? (?:its|her|his|their) ([^.,]*?)(?=\.|,| and |$)/g)].map((m) => m[1].trim());
  const base = (name: string) => name.replace(/\s*\(.*\)$/, "").toLowerCase();
  const kept = options
    .filter((option) => option.uses.t === "recharge")
    .filter((option) => !said.some((name) => name === base(option.name)
      || (option.uses.t === "recharge" && typeof option.uses.pool === "string" && option.uses.pool.toLowerCase().includes(`.${name} `))))
    .map((option) => option.name);
  const keepsPool = pool > 0 && !/legendary resistance/i.test(clean);
  if (!keepsPool && !kept.length) return undefined;
  return { ...(keepsPool ? { legendaryResistance: true as const } : {}), ...(kept.length ? { recharge: [...new Set(kept)] } : {}) };
}

/** The count word in an attack reference: "a"/"an" are one, the rest are spelled or digits. */
function refCount(word: string): number {
  return /^an?$/i.test(word) ? 1 : (numberWords[word.toLowerCase()] ?? Number(word)) || 1;
}

/** Reference-plus-rider actions: one named attack, and on a hit a save or a condition such as frightened. */
function mergeReferencedAttack(raw: any, parsed: ActionOption, options: ActionOption[]): ActionOption {
  const text = flattenEntries(raw.entries);
  const ref = text.match(/\bmakes?\s+(?:a\s+separate|a|one|separate)\s+([A-Za-z][A-Za-z' -]+?) attack\b/i)
    || text.match(/\bmakes?\s+one\s+attack with (?:its|the)\s+([A-Za-z][A-Za-z' -]+?)(?:\.|,|$)/i);
  if (!ref || parsed.action.kind !== "save") return parsed;
  const optionIdx = findOption(options, ref[1].trim());
  const base = options[optionIdx]?.action;
  if (!base || base.kind !== "attack") return parsed;
  const action = structuredClone(base);
  if (parsed.action.damage.length) {
    action.extraSave = {
      ability: parsed.action.ability,
      dc: parsed.action.dc,
      damage: parsed.action.damage,
      onSuccess: parsed.action.onSuccess === "half" ? "half" : "none",
      riders: parsed.action.riders,
      onMiss: false,
    };
  } else {
    // Makes one bite attack against a grappled target. A hit also swallows the target and ends the grapple: the bite's own
    // grapple, and the Restrained that lasts
    // as long as it, are what the swallow ends, so they are not applied again on the way in.
    const swallowEnds = parsed.action.riders.find((rider) => rider.condition === "swallowed")?.endsConditions ?? [];
    if (swallowEnds.includes("grappled")) {
      const grappleDc = action.riders.find((rider) => rider.condition === "grappled" && rider.duration === "untilEscape")?.escapeDc;
      action.riders = action.riders.filter((rider) => rider.duration !== "untilEscape"
        || (rider.condition !== "grappled" && rider.escapeDc !== grappleDc));
    }
    action.riders.push(...parsed.action.riders);
  }
  // The swallow's target is one "it is grappling", which the referenced bite does not demand.
  if (parsed.action.requiresTargetCondition && !action.requiresTargetCondition) {
    action.requiresTargetCondition = parsed.action.requiresTargetCondition;
  }
  return { ...parsed, action };
}

/**
 * A bonus action that offers one attack with a named action as one of its choices (Dash, Disengage, or one named
 * attack) is a bonus-action
 * copy of that attack. Only the "or it makes" alternative: the triggered bonus attacks (a bonus Bite attack granted for
 * dropping a creature to 0 hit points) stay out.
 */
function bonusAttackCopy(raw: any, options: ActionOption[], sourceRef: string): ActionOption | undefined {
  const text = flattenEntries(raw.entries);
  const rampage = /^Rampage\b/i.test(raw.name) && /Immediately after dealing damage to a creature that (?:is|was) already (?:\{@status )?Bloodied/i.test(text);
  const ref = rampage ? text.match(/makes one ([A-Za-z][A-Za-z' -]+?) attack\b/i) : text.match(/\bor (?:it|he|she|they) makes? one ([A-Za-z][A-Za-z' -]+?) attack\b/i);
  if (!ref) return undefined;
  const base = options[findOption(options, ref[1].trim())];
  if (!base || base.action.kind !== "attack") return undefined;
  return { ...structuredClone(base), name: raw.name, sourceText: text, sourceRef, uses: parseUses(raw.name || ""), timing: "bonus", ...(rampage ? { requiresBloodiedDamage: true as const } : {}) };
}

/**
 * Reattach branch entries that the data flattened into siblings of the action they belong to.
 *
 * A ray-table action states the save and the d6 table, and its three
 * rays (numbered ranges) follow as *separate top-level actions* that open with
 * a failed-save phrase and carry no saving throw of their own. Parsed alone each ray became an unavoidable
 * 35-damage autohit; parsed as branches of their parent they behave as printed: one random
 * ray on a Dexterity save, half on a success.
 *
 * The parent's header is prepended to each branch so the branch inherits its save, range and
 * damage-on-success wording, which is the same trick `parseActionVariants` uses for choice lists.
 */
function foldOrphanSaveBranches(list: any[]): any[] {
  const isOrphanBranch = (entry: any) => {
    const text = flattenEntries(entry?.entries);
    return /^\s*On a (?:failed|successful) save\b/i.test(text) && !/\{@dc\s+\d+\}/.test(text);
  };
  if (!list.some(isOrphanBranch)) return list;
  // Built as copies rather than by mutation: `compileMonster` can run twice over the same raw
  // record (a creature that fights through a referenced shell form compiles both), and a folded
  // parent must not collect a second set of branches on the way through.
  const out: any[] = [];
  const branches = new Map<number, any[]>();
  for (const entry of list) {
    if (!isOrphanBranch(entry)) {
      out.push(entry);
      continue;
    }
    // Attach to the most recent action that both rolls a save and rolls for a branch.
    let parentIdx = -1;
    for (let i = out.length - 1; i >= 0 && parentIdx < 0; i--) {
      const text = flattenEntries(out[i]?.entries);
      if (/\{@dc\s+\d+\}/.test(text) && /roll a \{@dice 1?d\d+\}/i.test(text)) parentIdx = i;
    }
    if (parentIdx < 0) {
      out.push(entry);
      continue;
    }
    const header = flattenEntries(out[parentIdx].entries);
    branches.set(parentIdx, [...(branches.get(parentIdx) || []), {
      name: entry.name,
      entries: [header, flattenEntries(entry.entries)],
    }]);
  }
  return out.map((entry, idx) => {
    const items = branches.get(idx);
    return items ? { ...entry, entries: [...entry.entries, { type: "list", items }] } : entry;
  });
}

/** The auras' own reading of "immune ... for 24 hours" (`parseAura`, `parseSourceTurnAura`), applied to an option. */
const SUCCESS_IMMUNITY_RE = /on a success(?:ful)?[^.]{0,60}immune|immune to[^.]{0,80}for (?:the next )?(?:24 hours|1 hour)/i;
/** The 2024 "Success:" line granting the immunity, and a repeat save that prints its own outcome. */
const SUCCESS_LINE_IMMUNITY_RE = /\{@actSaveSuccess\}[^{.]{0,80}\bimmune\b/i;
const OLDER_SUCCESS_IMMUNITY_RE = /\bon a successful save\b[^.]{0,100}\bimmune\b/i;
const REPEAT_ENDS_ON_SUCCESS_RE =/\bending the effect on (?:itself|themself|himself|herself) on a success\b/i;

/**
 * What a printed success immunity on an option covers and what grants it (`SuccessImmunity`). Only an option whose
 * clause stands against a saving throw it compiles: a save action, or an attack whose rider carries its own save.
 * - Immunity after the effect's end (the target becomes immune once the effect lapses at the end of its next turn): the
 * effect's
 *   end, and never a made save.
 * - Immunity granted on a made save or on the effect's end (a possession's end included), however it ends.
 * - Immunity on a success, where the print also offers a repeat save: the repeat is the same saving throw, so its
 * success counts.
 * - Otherwise (the success line of a save tag says the target is immune, or a successful save leaves it immune): the
 * initial save.
 */
function successImmunity(option: ActionOption): SuccessImmunity | undefined {
  const text = option.sourceText || "";
  if (!SUCCESS_IMMUNITY_RE.test(text)) return undefined;
  const action = option.action;
  const saveRiders = action.kind === "attack" ? action.riders.filter((rider) => rider.save) : [];
  if (action.kind !== "save" && !saveRiders.length) return undefined;
  const trigger: SuccessImmunity["trigger"] = /\bafter which the target is immune\b/i.test(text) ? "end"
    // Not an effect that ends if the creature deals damage to the target, which ends a charm and grants nothing.
    : /\beffect ends (?:on|for) \w|\bpossession ends\b/i.test(text) ? "saveOrEnd"
    : /\brepeats? the sav/i.test(text) && /\bsucceeds on (?:a|the) saving throw|\bmakes a successful saving throw/i.test(text) ? "anySave"
    // The 2024 "Success:" line is the
    // outcome of a made repeat too where the Failure text only repeats the save and prints no outcome of its own for
    // the repeat (ending the effect on itself on a success). This revises
    // the earlier reading, which took the line as the initial save's alone.
    : SUCCESS_LINE_IMMUNITY_RE.test(text) && /\brepeats? the sav/i.test(text) && !REPEAT_ENDS_ON_SUCCESS_RE.test(text) ? "anySave"
    // The older "On a successful
    // save, ... immune" sentence beside a printed repeat save. A successful repeat grants the immunity, whether or not
    // the repeat prints its own "ending the effect on itself on a success".
    : OLDER_SUCCESS_IMMUNITY_RE.test(text) && /\brepeats? the sav/i.test(text) ? "anySave"
    : "save";
  const curse = action.kind === "attack" && /\bimmune to [^.]{0,40}\bcurse\b/i.test(text) && saveRiders.some((rider) => rider.condition === "cursed");
  return { key: curse ? "curse" : option.name, trigger };
}

/** The action with `magicalSleep` on every Unconscious rider, in its branches and its save burst too (copies, not edits). */
function tagMagicalSleep<A extends CombatAction>(action: A): A {
  const tag = (riders: Rider[]): Rider[] => riders.map((rider) => rider.condition === "unconscious" ? { ...rider, magicalSleep: true as const } : rider);
  if (action.kind === "random") return { ...action, branches: action.branches.map(tagMagicalSleep) };
  if (!("riders" in action) || !action.riders) return action;
  const tagged: any = { ...action, riders: tag(action.riders) };
  if (action.kind === "attack" && action.extraSave?.riders) tagged.extraSave = { ...action.extraSave, riders: tag(action.extraSave.riders) };
  return tagged;
}

const VERSATILE_RE = /\(\{@damage ([^}]+)\}\)\s+([A-Za-z]+) damage,? or \d+\s*\(\{@damage ([^}]+)\}\)\s+([A-Za-z]+) damage,? (?:if|when) used with two hands/gi;

// The creature provokes no Opportunity Attacks for leaving an enemy's reach: the rule Flyby prints, and
// what the `flyby` field means to the engine, which reads it with no flight gate.
const NO_PROVOKE_TRAIT_RE = /(?:doesn't|does not) provoke (?:an )?(?:\{@action )?opportunity attack[^.]*when it moves out of/i;

/**
 * An option that needs a creature this block holds ("one creature Grappled by the chuul") and prints no range of its own
 * gets the 5-ft contact range (`contactRange` in `parse/actions.ts`). But the hold is made at the holder's reach (a
 * Pincer at 10 ft, a harpoon-like arm at 60 ft), and a held creature stays within it, so the option
 * reaches as far as the hold does. A printed reach or range stands (a Bite with "reach 5 ft.").
 */
function holdReachContactRange(options: ActionOption[]): void {
  const acts = (a: any): any[] => (a ? [a, ...(a.branches || []).flatMap(acts), ...(a.extraSave ? acts(a.extraSave) : [])] : []);
  const riders = (a: any): any[] => acts(a).flatMap((x) => [...(x.riders || []), ...(x.choiceRiders || []).flat()]);
  for (const option of options) {
    const action: any = option.action;
    if (action.range !== 5 || /\b(?:reach|range) \d+/i.test(option.sourceText || "")) continue;
    const need = [action.requiresTargetCondition, ...(action.requiresAnyTargetConditions || [])].filter(Boolean);
    if (!need.length) continue;
    const holders = options.filter((p) => p !== option
      && riders(p.action).some((r) => need.includes(r.condition) && r.duration === "untilEscape"));
    const reach = Math.max(0, ...holders.map((p: any) => p.action.reach || p.action.range || 0));
    if (reach > 5) action.range = reach;
  }
}

/**
 * A holder that bars itself while it holds: until the grapple ends, the holder can't make certain attacks, or, while
 * grappling the target, can't take a certain action. In a duel the only creature that can grapple the foe is the
 * holder, so each barred option
 * requires the foe to be missing the Grappled condition this block applied (`requiresTargetMissingConditions`; the engine
 * counts only conditions the attacker applied). The bar is read from the grappling option's own print and names options
 * of the same block. Before, the barred attack was used again while its grapple held. A self-bar that says the holder
 * can't take this action again while grappling a target is the same rule, and is not yet covered.
 */
const HOLDER_BAR_RE = /\b[Uu]ntil (?:this|the) grapple(?:d condition)? ends\b[^.]*?\bcan't make ((?:[A-Z][\w' -]*? attacks?)(?:,? or (?:[A-Z][\w' -]*? attacks?))*)(?! (?:against|on) another)/;
const HOLDER_SELF_BAR_RE = /\bwhile grappling the target\b[^.]*\bcan't take this action\b/i;
/** The same bar printed from the target's side: "While Grappled, the target ... can't be targeted by the crocodile's Tail." */
const HELD_TARGET_BAR_RE = /\bWhile Grappled, the target\b[^.]*\bcan't be targeted by the [a-z' -]+?'s ([A-Z][\w' -]*?)\./;

/**
 * A hold that lasts "until the rope is destroyed", where the rope is the creature's own item and a trait prints its
 * statistics: "The rope has AC 20, HP 90, and Immunity to Poison and Psychic damage". The trait's object is attached
 * to the hold as `Rider.breakable` with `item` set.
 */
function itemHolds(monster: any, options: ActionOption[]): void {
  for (const option of options) {
    const riders: Rider[] = (option.action as any).riders || [];
    const held = riders.filter((r) => r.duration === "untilEscape" && r.escapeDc === undefined && !r.breakable);
    const noun = held.length ? stripTags(option.sourceText || "").match(/\buntil the ([a-z' -]{1,30}?) is destroyed\b/i)?.[1] : undefined;
    if (!noun) continue;
    for (const trait of monster.trait || []) {
      const sentence = stripTags(flattenEntries(trait.entries || [])).match(new RegExp(`\\bThe ${noun} has ([^.]*)\\.`, "i"))?.[1];
      const object = sentence ? parseObjectStats(sentence, noun.toLowerCase()) : undefined;
      if (object) for (const rider of held) rider.breakable = { ...object, item: true };
    }
  }
}

/**
 * A Multiattack names its attacks without an order ("makes one Bite attack and one Tail attack"), and the attacker picks
 * one. Where one part grapples on a hit and another cannot be used on a creature this block has Grappled
 * (`holderSelfLock`), the barred part goes first: taken in printed order, a Bite that hit left no Tail to make.
 */
function barredBeforeGrab(options: ActionOption[], routines: Routine[]): void {
  const grapples = (idx: number): boolean => ((options[idx]?.action as any)?.riders || []).some((r: Rider) => r.condition === "grappled" && r.duration === "untilEscape");
  const barred = (idx: number): boolean => !!(options[idx]?.action as any)?.requiresTargetMissingConditions?.includes("grappled");
  for (const routine of routines) {
    const grab = routine.parts.findIndex((part) => grapples(part.optionIdx) && !barred(part.optionIdx));
    if (grab < 0) continue;
    const late = routine.parts.filter((part, i) => i > grab && barred(part.optionIdx) && !grapples(part.optionIdx));
    if (!late.length) continue;
    const rest = routine.parts.filter((part) => !late.includes(part));
    routine.parts = [...rest.slice(0, grab), ...late, ...rest.slice(grab)];
  }
}

/**
 * The same freedom of order, for a part that needs its target to hold a condition no part of the routine gives (a kiss
 * for "one creature Charmed by" the user, beside a damaging touch): it goes first, since the damage of an earlier part
 * can end the condition and leave it no target. A part whose condition another part supplies (a Bite on a creature the
 * Claw grappled) keeps its printed place.
 */
function conditionUserBeforeDamage(options: ActionOption[], routines: Routine[]): void {
  const needs = (idx: number): string[] => {
    const action: any = options[idx]?.action;
    return [...(action?.requiresTargetCondition ? [action.requiresTargetCondition] : []), ...(action?.requiresAnyTargetConditions || [])];
  };
  const gives = (idx: number, conditions: string[]): boolean => ((options[idx]?.action as any)?.riders || []).some((r: Rider) => conditions.includes(r.condition));
  for (const routine of routines) {
    const early = routine.parts.filter((part, i) => i > 0 && needs(part.optionIdx).length
      && !routine.parts.some((other) => gives(other.optionIdx, needs(part.optionIdx))));
    if (early.length) routine.parts = [...early, ...routine.parts.filter((part) => !early.includes(part))];
  }
}

function holderSelfLock(options: ActionOption[]): void {
  const grapples = (a: any): boolean => (a?.riders || []).some((r: Rider) => r.condition === "grappled" && r.duration === "untilEscape");
  const bar = (option: ActionOption) => {
    const action: any = option.action;
    if (action.kind !== "attack" && action.kind !== "save" && action.kind !== "autohit") return;
    const missing: string[] = action.requiresTargetMissingConditions || [];
    if (!missing.includes("grappled")) action.requiresTargetMissingConditions = [...missing, "grappled"];
  };
  for (const option of options) {
    if (!grapples(option.action)) continue;
    const text = stripTags(option.sourceText || "");
    if (HOLDER_SELF_BAR_RE.test(text)) bar(option);
    const barred = text.match(HELD_TARGET_BAR_RE)?.[1];
    if (barred) for (const idx of findOptions(options, barred)) bar(options[idx]);
    const names = text.match(HOLDER_BAR_RE)?.[1];
    if (!names) continue;
    for (const name of names.split(/,? or /)) for (const idx of findOptions(options, name)) bar(options[idx]);
  }
}

/**
 * A hit that can trade its damage for a condition: a spear hit that lets the attacker forgo the damage and instead
 * knock a Medium or smaller target prone, or to give the target the Grappled condition (with an escape DC) instead of
 * dealing damage. Compiled as one attack, each hit dealt the damage and
 * applied the condition. It compiles as two options that share the attack roll's numbers: the printed attack with its
 * damage and no rider, and a damage-less attack "<name> (no damage)" with the riders (as a tentacle grab and webs
 * compile), appended after the block's printed options. The chooser picks between them by EV like any two options.
 * Read only on an attack that compiles both damage
 * and a rider, so an attack that can cut a cord instead of dealing damage
 * (no rider) stays whole. It runs after `holderSelfLock`, so both halves of such a Smother carry its "can't take this
 * action" bar. A Legendary entry is not split (none prints the wording).
 */
const RIDER_INSTEAD_OF_DAMAGE_RE = /\bcan choose to deal no damage\b|\binstead of dealing damage\b/i;

function riderInsteadOfDamage(options: ActionOption[]): ActionOption[] {
  const riderOptions: ActionOption[] = [];
  for (const option of options) {
    const action = option.action;
    if (action.kind !== "attack" || option.timing === "legendary" || !action.damage.length || !action.riders.length) continue;
    if (!RIDER_INSTEAD_OF_DAMAGE_RE.test(stripTags(option.sourceText || ""))) continue;
    riderOptions.push({ ...option, name: `${option.name} (no damage)`, sourceRef: `${option.sourceRef}.no damage`, action: { ...action, damage: [] } });
    option.action = { ...action, riders: [] };
  }
  return riderOptions;
}

const LEGENDARY_BARE_MOVE_RE = /^[^.]{0,40}\bmoves up to (?:half )?(?:its|his|her|their) speed\b[^.]*\.(?:\s*This movement doesn't provoke opportunity attacks\.)?$/i;

function twoHandedVersatile(option: ActionOption): void {
  const action = option.action;
  if (action.kind !== "attack" || action.spell || !action.melee || action.ranged) return;
  const pairs = [...(option.sourceText || "").matchAll(VERSATILE_RE)];
  if (pairs.length !== 1) return;
  const [, oneDice, oneType, twoDice, twoType] = pairs[0];
  const one = JSON.stringify({ dice: parseDice(oneDice), type: oneType.toLowerCase() });
  const clause = action.damage.find((d) => JSON.stringify({ dice: d.dice, type: d.type }) === one);
  if (!clause) return;
  clause.dice = parseDice(twoDice);
  clause.type = twoType.toLowerCase();
}

/**
 * A few blocks are
 * several creatures in one: a trait says that a variant chosen when the creature is made decides which traits in
 * the block apply, and each variant's features carry an "(X only)" tag.
 * The variant is fixed before any fight, so no form model is needed. Previously the compile took every variant's
 * features at once. The variant the list prints first is compiled: its tags are removed where they sit inside text that
 * is read (a spell, a sense, a speed's condition), and the other variants' tagged features (named entries, list items,
 * spells, senses, speeds) are dropped and logged as skipped. A reach printed as conditional on a named mutation
 * follows the kept variant. Tags that name no variant of the list (such as a self-only tag) are not touched, and a
 * block without such a trait (a shape-changer's form-only tag) is returned as it is.
 */
const CREATION_VARIANT_RE = /\bdetermines certain traits in this stat block\b/i;
const VARIANT_TAG_RE = /\s*\(([^()]*?)\s+only\)/gi;
const VARIANT_REACH_RE = /\breach (\d+) ft\. \(or (\d+) ft\. if the [^()]*? has the ([^()]+?) (?:mutation|design|variety)\)/gi;

function variantTagNames(tag: string): string[] {
  return tag.replace(/^.*;\s*/, "").toLowerCase().split(/\s*,\s*|\s+and\s+|\s+or\s+/).filter(Boolean);
}

export function firstCreationVariant(monster: any, skipped: SkipLog[]): any {
  const trait = (monster.trait || []).find((t: any) => CREATION_VARIANT_RE.test(flattenEntries(t.entries || [])));
  if (!trait) return monster;
  const list = flattenEntries(trait.entries || []).toLowerCase();
  const names = [...new Set([...JSON.stringify(monster).matchAll(VARIANT_TAG_RE)].flatMap((m) => variantTagNames(m[1])))]
    .filter((name) => list.includes(name));
  if (names.length < 2) return monster;
  const kept = [...names].sort((a, b) => list.indexOf(a) - list.indexOf(b))[0];
  const reason = `creation variant not compiled: the ${kept} variant is`;
  // "drop" when a tag names only variants other than the kept one.
  const dropped = (text: string): boolean => [...text.matchAll(VARIANT_TAG_RE)].some((m) => {
    const own = variantTagNames(m[1]).filter((name) => names.includes(name));
    return own.length > 0 && !own.includes(kept);
  });
  const clean = (text: string): string => text
    .replace(VARIANT_TAG_RE, (whole, tag: string) => {
      const own = variantTagNames(tag).filter((name) => names.includes(name));
      if (!own.includes(kept)) return whole;
      const rest = tag.includes(";") ? tag.slice(0, tag.lastIndexOf(";")).trim() : "";
      return rest ? ` (${rest})` : "";
    })
    .replace(VARIANT_REACH_RE, (whole, base: string, alt: string, variant: string) =>
      !names.includes(variant.toLowerCase()) ? whole : `reach ${variant.toLowerCase() === kept ? alt : base} ft.`);
  const walk = (value: any, where: string): any => {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) {
      return value.filter((item) => {
        const label = typeof item === "string" ? item : typeof item?.name === "string" ? item.name : undefined;
        if (label === undefined || !dropped(label)) return true;
        skipped.push({ name: stripTags(label).replace(VARIANT_TAG_RE, "").trim(), where: where === "senses" ? "senses" : `${monster.name}.${where}`, reason });
        return false;
      }).map((item) => walk(item, where));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) =>
        [key, key === "name" && typeof inner === "string" ? inner : walk(inner, where)]));
    }
    return value;
  };
  const out: any = { ...monster };
  for (const field of ["senses", "trait", "action", "bonus", "reaction", "legendary", "mythic", "spellcasting"]) {
    if (monster[field] !== undefined) out[field] = walk(monster[field], field);
  }
  if (monster.speed && typeof monster.speed === "object") {
    const speed: any = {};
    for (const [mode, value] of Object.entries(monster.speed)) {
      const condition = (value as any)?.condition;
      if (typeof condition === "string" && dropped(condition)) {
        skipped.push({ name: `${mode} ${(value as any).number} ft. ${condition}`, where: `${monster.name}.speed`, reason });
        continue;
      }
      speed[mode] = typeof condition === "string" ? { ...(value as any), condition: clean(condition).trim() } : value;
    }
    out.speed = speed;
  }
  return out;
}

export function compileMonster(monster: any, spells: Map<string, any>, config: { draconicOrigin?: import("./types.ts").DraconicOrigin } = {}): CombatStatblock {
  const skipped: SkipLog[] = [];
  monster = firstCreationVariant(monster, skipped);
  const originTrait = (monster.trait ?? []).some((t: any) => t.name === "Draconic Origin");
  const draconicOrigin = originTrait ? config.draconicOrigin ?? "acid" : undefined;
  if (draconicOrigin) {
    if (!["acid", "cold", "fire", "lightning", "poison"].includes(draconicOrigin)) throw new Error("Invalid Draconic Origin");
    monster = structuredClone(monster);
    monster.resist = (monster.resist ?? []).map((r: any) => r?.special?.includes("Draconic Origin") ? draconicOrigin : r);
    for (const raw of monster.action ?? []) raw.entries = raw.entries.map((s: string) => typeof s === "string"
      ? s.replace(/damage of the type chosen for the Draconic Origin trait/gi, `${draconicOrigin} damage`) : s);
  }
  const senses = parseSenses(monster.senses, skipped);
  const cr = crToNumber(monster.cr);
  const prof = proficiencyFromCr(cr);
  const abilityScores = Object.fromEntries(abilities.map((a) => [a, monster[a] || 10])) as Record<Ability, number>;
  const abilityMods = Object.fromEntries(abilities.map((a) => [a, abilityMod(abilityScores[a])])) as Record<Ability, number>;
  const saves: Partial<Record<Ability, number>> = {};
  for (const ability of abilities) {
    const explicit = parseSigned(monster.save?.[ability]);
    if (explicit !== undefined) saves[ability] = explicit;
  }

  const options: ActionOption[] = [];
  const legendaryOptions: LegendaryEntry[] = [];
  const unresolvedLegendary: { name: string; text: string; requiresMythic?: boolean }[] = [];
  const activationChildren = new Map<any, ActionOption["activation"]>();
  const representedActivationParents = new Set<any>();
  const bonusActions = monster.bonus || [];
  // An Enlarge trait (the creature magically increases in size for 1 minute and doubles its damage dice) is
  // the self-condition its attacks gate on (extra force damage while enlarged, `requiresAttackerCondition: "enlarge"`).
  // Unparsed, nothing ever applied it, so the enlarged dice never rolled.
  // It compiles as a self-buff of that condition, as Rage does for the raging gate, and only where an attack prints the
  // gate.
  // Its size change and Strength advantage are not modelled.
  const enlargeGated = /\bwhile under the effect of Enlarge\b/i.test(flattenEntries([...(monster.action || []), ...bonusActions]));
  for (let i = 0; i < bonusActions.length; i++) {
    const parent = bonusActions[i];
    const text = flattenEntries(parent.entries);
    if (!/\{@recharge(?:\s+\d+)?\}/i.test(parent.name || "") || !/as a bonus action on later turns/i.test(text)) continue;
    const min = Number(String(parent.name).match(/\{@recharge(?:\s+(\d+))?\}/i)?.[1] || 6);
    const group = `${monster.source || "SRD"}:${monster.name}:${parent.name}`;
    for (const child of bonusActions.slice(i + 1)) activationChildren.set(child, { group, min, noRepeat: /can't choose the same effect two rounds in a row/i.test(text) });
    representedActivationParents.add(parent);
  }
  const actionList = foldOrphanSaveBranches(monster.action || []);
  const groups: { timing: "action" | "bonus" | "legendary"; list: any[]; requiresMythic?: boolean }[] = [
    { timing: "action", list: actionList },
    { timing: "bonus", list: monster.bonus || [] },
    { timing: "legendary", list: monster.legendary || [] },
    { timing: "legendary", list: monster.mythic || [], requiresMythic: true },
  ];
  for (const { timing, list, requiresMythic } of groups) {
    for (const raw of list) {
      if (isMultiattack(raw.name)) continue;
      const sourceRef = `${monster.name}.${requiresMythic ? "mythic" : timing}.${raw.name}`;
      const parsedOutcomes = parseActionVariants(raw, timing, sourceRef);
      let parsedOptions = parsedOutcomes.flatMap((outcome) => outcome.option ? [{
        ...mergeReferencedAttack(raw, outcome.option, options),
        activation: activationChildren.get(raw),
        requiresMythic: requiresMythic || /(?:Gem )?Awakening Only/i.test(raw.name || ""),
        depletion: (() => {
          const match = flattenEntries(raw.entries).match(/roll a \{@dice d(\d+)\}; on a roll of (\d+) or lower[^.]*no more/i);
          return match ? { die: Number(match[1]), maxRoll: Number(match[2]) } : undefined;
        })(),
      }] : []);
      if (/Dash(?: or|,) Disengage(?:, or Hide)? action/i.test(flattenEntries(raw.entries))) {
        parsedOptions = parsedOptions.flatMap(option => option.action.kind !== "selfbuff" ? [option] : [
          { ...option, name: `${option.name} (Dash)`, aliases: [option.name] },
          { ...option, name: `${option.name} (Disengage)`, aliases: [option.name], action: { ...option.action,
            condition: "disengaged", movement: { mode: "dash" as const, distance: 0, noProvoke: true } } },
        ]);
      }
      if (parsedOptions.length && UNDERWATER_ONLY_RE.test(flattenEntries(raw.entries).split(/\{@h\}|\{@actSaveFail/)[0])) {
        skipped.push({ name: raw.name, where: `${monster.name}.${timing}`, reason: UNDERWATER_ONLY_REASON });
      } else if (parsedOptions.length && optionLightGated(flattenEntries(raw.entries).split(/\{@h\}|\{@actSaveFail/)[0])) {
        skipped.push({ name: raw.name, where: `${monster.name}.${timing}`, reason: LIGHT_GATE_REASON });
      } else if (parsedOptions.length && needsCorpse(raw, parsedOptions)) {
        skipped.push({ name: raw.name, where: `${monster.name}.${timing}`, reason: CORPSE_GATE_REASON });
      } else if (parsedOptions.length) {
        for (const parsed of parsedOptions) {
          options.push(parsed);
          if (timing === "legendary") legendaryOptions.push({ optionIdx: options.length - 1, count: 1, requiresMythic });
        }
      } else if (timing === "legendary") {
        unresolvedLegendary.push({ name: raw.name, text: flattenEntries(raw.entries), requiresMythic });
      } else if (representedActivationParents.has(raw)) {
        // Its activation cost and persistence are represented on the child effect options.
      } else if (timing === "bonus" && bonusAttackCopy(raw, options, sourceRef)) {
        options.push(bonusAttackCopy(raw, options, sourceRef)!);
      } else if (enlargeGated && /^Enlarge\b/i.test(raw.name || "") && /\bmagically increases in size\b/i.test(flattenEntries(raw.entries))) {
        options.push({
          name: raw.name,
          sourceText: flattenEntries(raw.entries),
          sourceRef,
          action: { kind: "selfbuff", condition: "enlarge", breaksOnAttackOrSpell: false },
          uses: parseUses(raw.name),
          timing,
          requiresMythic: false,
        });
      } else {
        const reason = hasNonFoeDamage(flattenEntries(raw.entries)) ? NON_FOE_DAMAGE_REASON : parsedOutcomes[0]?.reason || "unparsed";
        // A save whose only die was a roll penalty now has no damage; say why (gold dragons' Weakening Breath).
        const penalty = reason === "save action has no parseable damage" && ROLL_PENALTY_RE.test(flattenEntries(raw.entries));
        skipped.push({ name: raw.name, where: `${monster.name}.${timing}`, reason: penalty ? "roll penalty not modeled (subtracts a die from the target's rolls); nothing else to compile" : reason });
      }
    }
  }
  // A target limited to the creature's own size or smaller caps the target at
  // the block's own size. An option that already compiles a cap from a size word keeps it.
  for (const option of options) {
    const action = option.action;
    if ((action.kind === "attack" || action.kind === "save") && action.targetMaxSize === undefined && targetCappedAtOwnSize(option.sourceText)) {
      action.targetMaxSize = sizeRank(monster);
    }
    // The cap printed on the condition alone, after the outcome (the target is Grappled if no larger than the creature):
    // the rider's cap, not the action's. A rider that
    // already compiles a cap from a size word keeps it.
    if (action.kind === "attack" || action.kind === "save") {
      const capped = ridersCappedAtOwnSize(option.sourceText);
      for (const rider of capped.length ? action.riders ?? [] : []) {
        if (rider.targetMaxSize === undefined && capped.includes(rider.condition)) rider.targetMaxSize = sizeRank(monster);
      }
    }
  }
  // A versatile weapon prints both dice (a one-handed die, then a larger die when used with two
  // hands); `parseDamageClauses` keeps the first. A creature with no shield (its AC names none) wields a melee-only
  // weapon two-handed, so it rolls the second. A melee-or-thrown weapon (Spear, Trident) keeps the one-handed die: the
  // option carries one damage profile for both modes.
  if (!/shield/i.test(JSON.stringify(monster.ac ?? ""))) {
    for (const option of options) twoHandedVersatile(option);
  }
  holdReachContactRange(options);
  holderSelfLock(options);
  itemHolds(monster, options);
  options.push(...riderInsteadOfDamage(options));
  const corpseStock = flattenEntries(monster.trait || []).match(/\bcontains? the corpses? of \{@dice\s+([^}]+)\}/i);
  if (corpseStock) {
    const uses = Math.max(1, Math.floor(avgDice(parseDice(corpseStock[1]))));
    for (const option of options) {
      if (option.action.kind === "selfheal" && /\bdigests? one corpse\b/i.test(option.sourceText)) {
        option.uses = { t: "perDay", max: uses, pool: `${monster.source || "SRD"}:${monster.name}:corpse-stock` };
      }
    }
  }
  const spellStartIdx = options.length;
  const spellReactions: SpellReaction[] = [];
  const spellActionRefs: { name: string; uses: Uses }[] = [];
  // A spell the block prints as an action entry of its own
  // ("Fire Bolt (Cantrip)", "Chromatic Orb (1/Day)") and
  // lists under its spellcasting too, with no "see Actions below" on the list entry, compiled twice: the printed entry with
  // its own dice, and a second copy from the spell list (a Chromatic Orb twice a day, 4d8 and 3d8). The list
  // copy compiles nothing, as the "see Actions below" entries do (`compileSpellOptions`); the printed entry keeps its own
  // uses, and takes the list's only where it prints none (the loop below).
  const spellEntryKey = (option: ActionOption) => `${option.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim()}|${option.timing}`;
  const printedEntryKeys = new Set(options.map(spellEntryKey));
  for (const listed of compileSpellOptions(monster, spells, cr, skipped, spellReactions, spellActionRefs)) {
    if (!printedEntryKeys.has(spellEntryKey(listed))) {
      options.push(listed);
      continue;
    }
    skipped.push({ name: listed.name, where: `${monster.name}.spellcasting`, reason: "printed as its own action (an action entry carries the same spell)" });
    spellActionRefs.push({ name: listed.name, uses: listed.uses });
  }
  // A spell-list entry printed as its own action ("see Actions below") spends the list's uses:
  // a 3rd-level Lightning Bolt entry draws on
  // the creature's 3rd-level slots instead of casting 8d6 every turn.
  // The printed action also stands in for the list entry wherever a legendary action casts from
  // the list (a cantrip cast keeps the printed 4d8 Chill Touch).
  const spellActionIdxs: number[] = [];
  for (const ref of spellActionRefs) {
    const key = ref.name.toLowerCase();
    for (let optionIdx = 0; optionIdx < spellStartIdx; optionIdx++) {
      const option = options[optionIdx];
      const name = option.name.toLowerCase();
      if (option.timing !== "action" || (name !== key && !name.startsWith(`${key} (`))) continue;
      if (ref.uses.t !== "atWill" && option.uses.t === "atWill") option.uses = { ...ref.uses };
      spellActionIdxs.push(optionIdx);
    }
  }
  if (/Magic Weapons|Weapon Attacks are magical|attacks count as magical/i.test(flattenEntries(monster.trait || []))) {
    for (const option of options) option.action = markMagicalAttacks(option.action);
  }
  // An action that needs a magic item is that item's effect, and magical for Magic Resistance ("spells and other
  // magical effects"): the Erinyes's "Entangling Rope (Requires Magic Rope)", whose trait reads "has a magic rope" (O09).
  const magicItems = new Set((monster.trait || [])
    .filter((trait: any) => /\bhas an? magic\b/i.test(stripTags(flattenEntries(trait.entries ?? []))))
    .map((trait: any) => String(trait.name).toLowerCase()));
  for (const option of options) {
    const required = option.name.match(/\(Requires ([^)]+)\)/i)?.[1].toLowerCase();
    if (required && magicItems.has(required) && "magical" in option.action) option.action = { ...option.action, magical: true } as CombatAction;
  }
  for (let optionIdx = spellStartIdx; optionIdx < options.length; optionIdx++) {
    if (options[optionIdx].timing === "legendary") legendaryOptions.push({ optionIdx, count: 1 });
  }

  // Reference-style legendary actions (the creature makes one named attack, makes one attack out of a short list of
  // named attacks, or uses Spellcasting) resolve against
  // already-compiled options; alternatives all join legendaryOptions and compete by EV.
  let legendaryMove: CombatStatblock["legendaryMove"];
  for (const raw of unresolvedLegendary) {
    const before = legendaryOptions.length;
    // A legendary entry that teleports and then makes one named attack.
    // The attack resolves by reference below; the jump belongs to *this* entry and not to the
    // plain Claw, so the resolved options are cloned with it attached rather than shared.
    const refTeleport = parseTeleport(raw.text, true);
    // An entry whose text has the jump first and then the attack: the attack is made from the
    // landing (`anchor: "destination"`). Read by order: the jump verb before the first "make". The act-first entries keep
    // the jump after (an entry that makes one attack, then teleports, and one that allows the jump either before
    // or after the attack, read as after).
    const jumpAt = stripTags(raw.text).search(/\bteleports?\b/i);
    const makeAt = stripTags(raw.text).search(/\bmakes?\b/i);
    const jumpFirst = jumpAt >= 0 && makeAt > jumpAt;
    // Attack references are read off tag-stripped text. An inline data tag carries its own prose
    // (a rules-glossary tag for a term such as Speed, or one for an action such as Opportunity Attack), which
    // both pushed the reference past the offset guard below (one entry has
    // "makes" at 138 tagged and 83 stripped) and broke the name capture whenever a tag sat inside
    // the attack's own name (a tagged word at the start of a Slam attack's name). The patterns
    // further down that key off a tag keep the raw text.
    const refText = stripTags(raw.text);
    // A referenced name may never contain the word "attack" itself, the same guard the
    // Multiattack parser uses: without it the lazy capture spans whole clauses, and an entry whose
    // text runs on through a mount's reaction attack resolved to the first of two named attacks alone.
    const attackRefMatch = refText.match(/\bmakes?\s+(a|an|one|two|three|four|\d+)\s+(?:separate\s+)?((?!attacks?\b)[A-Za-z](?:(?!attacks?\b)[A-Za-z', -])*?) attacks?\b/);
    // The offset keeps the reference inside the entry's opening clause. Every entry in the data
    // it turns away hands the attack to somebody else (the target makes a melee weapon
    // attack, or the creature's mount uses its reaction to make one), which would reach the generic
    // weapon branch below and give an ally-commanding creature every attack it owns as a
    // legendary action of its own. The one true positive past it is the trample below.
    const attackRef = attackRefMatch && (attackRefMatch.index ?? Infinity) < 100 ? attackRefMatch : null;
    // A legendary entry that makes one melee attack with a named weapon names the melee mode of a weapon that can also be
    // thrown. The entry points at a melee-only,
    // Legendary-timed copy of the at-will referent (as the jump clones below are Legendary-timed), so it is not thrown from
    // 20 feet. A limited-use referent is not copied: a copy would get its own pool.
    const meleeOnlyReferent = (optionIdx: number): number => {
      const referent = options[optionIdx];
      if (referent.action.kind !== "attack" || !referent.action.ranged || referent.uses.t !== "atWill") return optionIdx;
      const { longRange: _longRange, ...melee } = referent.action;
      options.push({ ...referent, name: raw.name, sourceText: raw.text, action: { ...melee, ranged: false, range: referent.action.reach ?? 5 }, timing: "legendary" });
      return options.length - 1;
    };
    if (attackRef) {
      const count = refCount(attackRef[1]);
      if (/^(?:melee |ranged )?weapon$/i.test(attackRef[2].trim())) {
        options.forEach((option, optionIdx) => {
          if (option.timing !== "action" || option.action.kind !== "attack") return;
          if (/^melee /i.test(attackRef[2]) && !option.action.melee) return;
          if (/^ranged /i.test(attackRef[2]) && !option.action.ranged) return;
          legendaryOptions.push({ optionIdx: /^melee /i.test(attackRef[2]) ? meleeOnlyReferent(optionIdx) : optionIdx, count, requiresMythic: raw.requiresMythic });
        });
      } else if (/^melee$/i.test(attackRef[2].trim())) {
        // A legendary entry that makes one melee attack, possibly with advantage on the attack roll, or one melee attack with a
        // named weapon. Any melee attack the block prints as an
        // action; a spell cast from the Spellcasting list is not an attack it makes. The Advantage is not carried.
        options.forEach((option, optionIdx) => {
          if (option.timing !== "action" || option.action.kind !== "attack" || !option.action.melee || option.action.spell) return;
          legendaryOptions.push({ optionIdx: meleeOnlyReferent(optionIdx), count, requiresMythic: raw.requiresMythic });
        });
      } else {
        for (const name of attackRef[2].split(/,\s*|\s+or\s+|\s+and\s+/).map((s) => s.replace(/^(?:or|and)\s+/, "").trim()).filter(Boolean)) {
          const optionIdx = findOption(options, name);
          if (optionIdx >= 0) legendaryOptions.push({ optionIdx, count, requiresMythic: raw.requiresMythic });
        }
      }
      // A legendary entry that makes a spear-like attack or casts a spell stopped once the attack resolved, so the spell was never a
      // Legendary choice. The spell joins as a second alternative, once: an entry that makes one weapon attack or casts
      // a spell already holds that spell through the weapon branch above.
      const orCasts = legendaryOptions.length > before ? raw.text.match(/\battacks?\s+or\s+casts?\s+\{@spell ([^}|]+)[|}]/i) : null;
      const castIdx = orCasts ? findOption(options, orCasts[1].trim()) : -1;
      if (castIdx >= 0 && !legendaryOptions.slice(before).some((entry) => entry.optionIdx === castIdx)) {
        legendaryOptions.push({ optionIdx: castIdx, count: 1, requiresMythic: raw.requiresMythic });
      }
    }
    if (legendaryOptions.length === before) {
      const splitAttack =refText.match(/\bmakes?\s+(two|three|four|\d+)\s+attacks? with (?:its|his|her|their)\s+([A-Za-z][A-Za-z' -]+?) or one attack with (?:its|his|her|their)\s+([A-Za-z][A-Za-z' -]+?)(?:\.|,|$)/i);
      if (splitAttack) {
        const count = refCount(splitAttack[1]);
        const first = findOption(options, splitAttack[2]);
        const second = findOption(options, splitAttack[3]);
        if (first >= 0) legendaryOptions.push({ optionIdx: first, count, requiresMythic: raw.requiresMythic });
        if (second >= 0) legendaryOptions.push({ optionIdx: second, count: 1, requiresMythic: raw.requiresMythic });
      }
    }
    if (legendaryOptions.length === before) {
      // An entry that makes one attack with named weapons, or an attack using one of two named features.
      // The possessive is whatever gender the text gives the creature (a pattern that accepted only *its* and *the*
      // lost a creature's reference-style legendary actions), and
      // the count may be more than one, as in a mythic Swipe.
      const withRef = refText.match(/\bmakes?\s+(a|an|one|two|three|four|\d+)\s+attacks?\s+(?:with|using)\s+(?:its|his|her|their|the)\s+([A-Za-z][A-Za-z' -]+?(?:\s+or\s+(?:(?:its|his|her|their|the)\s+)?[A-Za-z][A-Za-z' -]+?)*)(?:\.|,|$)/i);
      if (withRef) {
        const count = refCount(withRef[1]);
        for (const name of withRef[2].split(/\s+or\s+/).map((s) => s.replace(/^(?:its|his|her|their|the)\s+/i, "").trim())) {
          const optionIdx = findOption(options, name);
          if (optionIdx >= 0) legendaryOptions.push({ optionIdx, count, requiresMythic: raw.requiresMythic });
        }
      }
    }
    if (legendaryOptions.length === before) {
      // An entry that makes two attacks, each by a different named feature — one of each
      // rather than a choice, so every slot in the list joins with its own count.
      const slotList = refText.match(/\bmakes?\s+(?:a|an|one|two|three|four|\d+)\s+attacks?:\s*([^.]+)/i);
      for (const slot of slotList?.[1].matchAll(/\b(a|an|one|two|three|four|\d+)\s+with\s+(?:its|his|her|their|the)\s+([A-Za-z][A-Za-z' -]+?)(?=,|\s+and\b|\s+or\b|$)/gi) ?? []) {
        const optionIdx = findOption(options, slot[2].trim());
        if (optionIdx >= 0) legendaryOptions.push({ optionIdx, count: refCount(slot[1]), requiresMythic: raw.requiresMythic });
      }
    }
    if (legendaryOptions.length === before && /\bmoves?\b[^.]{0,80}\bthrough the space of\b/i.test(refText)) {
      // A trample: the creature runs through the spaces it passes and attacks each occupant once.
      // In a duel there is exactly one occupant to run through, so it is one attack, and the
      // clause sits in a second sentence well past the offset guard above.
      const trample = refText.match(/\bcan make (?:a|an|one) ([A-Za-z][A-Za-z' -]+?) attack against (?:that|each) creature\b/i);
      const optionIdx = trample ? findOption(options, trample[1].trim()) : -1;
      if (optionIdx >= 0) legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic });
    }
    if (legendaryOptions.length === before && /uses? Spellcasting to cast/i.test(raw.text)) {
      for (const spellRef of raw.text.matchAll(/\{@spell ([^}|]+)[|}]/g)) {
        const optionIdx = findOption(options, spellRef[1].trim());
        if (optionIdx >= 0) legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic });
      }
    } else if (legendaryOptions.length === before && /(?:\buses?|or) Spellcasting\b/i.test(raw.text)) {
      // "Cast a Spell" style: any compiled spell option is a candidate.
      for (let optionIdx = spellStartIdx; optionIdx < options.length; optionIdx++) {
        legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic });
      }
      for (const optionIdx of spellActionIdxs) legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic });
    }
    if (legendaryOptions.length === before && /\bcasts? a cantrip\b/i.test(raw.text)) {
      for (let optionIdx = spellStartIdx; optionIdx < options.length; optionIdx++) {
        if (options[optionIdx].uses.t === "atWill") legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic });
      }
      for (const optionIdx of spellActionIdxs) {
        if (options[optionIdx].uses.t === "atWill") legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic });
      }
    }
    if (legendaryOptions.length === before) {
      for (const usesRef of raw.text.matchAll(/\buses? (?:either\s+)?(?:(?:its|his|her)\s+)?([A-Z][A-Za-z' -]+?(?:\s+or\s+[A-Z][A-Za-z' -]+?)*)(?=\.|,|;|\s+(?:if|to|when|and|once)\b|$)/g)) {
        for (const name of usesRef[1].split(/\s+or\s+/).map((s) => s.trim())) {
          const optionIdx = findOption(options, name);
          if (optionIdx >= 0) legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic });
        }
      }
    }
    if (legendaryOptions.length === before) {
      const rechargeAndUse = raw.text.match(/\brecharges? (?:its|his|her)\s+([A-Za-z][A-Za-z' -]+?) and uses? it\b/i);
      const optionIdx = rechargeAndUse ? findOption(options, rechargeAndUse[1]) : -1;
      if (optionIdx >= 0) legendaryOptions.push({ optionIdx, count: 1, requiresMythic: raw.requiresMythic, refreshesUse: true });
    }
    // An entry that moves and then shakes the ground: "The tarrasque moves up to its Speed. At the end of this movement,
    // the tarrasque creates an instantaneous shock wave in a 60-foot Emanation originating from itself. Creatures in that
    // area lose Concentration and, if Medium or smaller, have the Prone condition." No roll and no save.
    const shockWave = legendaryOptions.length === before
      ? refText.match(/^[A-Z][a-z]+(?: [a-z]+)? moves up to (?:its|his|her|their) Speed\. At the end of this movement,[^.]*?\b(\d+)-foot Emanation originating from (?:itself|himself|herself|themself)\. Creatures in that area lose Concentration and, if ([A-Z][a-z]+ or smaller), have the Prone condition\./)
      : null;
    if (shockWave) {
      options.push({
        name: raw.name,
        sourceText: raw.text,
        sourceRef: `${monster.name}.legendary.${raw.name}`,
        action: {
          kind: "autohit", damage: [], magical: false, range: Number(shockWave[1]), endsTargetConcentration: true,
          riders: [{ condition: "prone", targetMaxSize: targetMaxSize(shockWave[2]), duration: "permanent" }],
        },
        uses: { t: "atWill" },
        timing: "legendary",
        requiresMythic: false,
      });
      legendaryOptions.push({ optionIdx: options.length - 1, count: 1, requiresMythic: raw.requiresMythic, move: { when: "before", feet: effectiveSpeed(monster), noProvoke: false } });
    }
    // An entry that moves and then makes its attack ("The dragon moves up to half its Speed, and it makes one Rend
    // attack"), or uses its action and may then fly ("...to cast Invisibility on itself, and it can fly up to half its Fly
    // Speed"). "Its Speed" is the creature's one Speed, its fastest mode (the reading used here: a creature with a
    // Speed and a Fly Speed uses the faster); "its Fly Speed" is the Fly Speed.
    const moveThen = refText.match(/^[A-Z][a-z]+(?: [a-z]+)? moves up to (half )?(?:its|his|her|their) Speed( without provoking Opportunity Attacks)?, and (?:it|he|she|they) makes?\b/);
    const thenFly = refText.match(/, and (?:it|he|she|they) can fly up to (half )?(?:its|his|her|their) Fly Speed\./);
    const printedSpeed = moveThen ? effectiveSpeed(monster) : thenFly ? speedMode(monster, "fly") : undefined;
    const entryMove = moveThen ?? thenFly;
    if (entryMove && printedSpeed) {
      for (let i = before; i < legendaryOptions.length; i++) {
        legendaryOptions[i].move = { when: moveThen ? "before" : "after", feet: Math.floor(printedSpeed * (entryMove[1] ? 0.5 : 1)), noProvoke: !!moveThen?.[2] };
      }
    }
    // "...it uses Consume Memories and regains 5 (1d10) Hit Points": the healing belongs to the entry, not the referent.
    const refHeal = raw.text.match(/\band regains \d+ \(\{@dice ([^}]+)\}\) (?:\{@variantrule )?Hit Points\b/i);
    if (refHeal) for (let i = before; i < legendaryOptions.length; i++) legendaryOptions[i].selfHeal = parseDice(refHeal[1]);
    if (refTeleport && legendaryOptions.length > before) {
      // Clone only at-will referents: a limited-use option cloned under a fresh index would
      // get its own pool and silently double the creature's allowance of it.
      for (let i = before; i < legendaryOptions.length; i++) {
        const entry = legendaryOptions[i];
        const referent = options[entry.optionIdx];
        if (!referent || referent.uses.t !== "atWill") continue;
        if (referent.action.kind === "random" || referent.action.kind === "selfheal") continue;
        // The clone is the Legendary entry, not an action: kept at the referent's timing it got a routine of its own
        // and served as the action and the teleport escape (a spike attack after a
        // 30-foot jump was taken on its own turn).
        options.push({
          ...referent,
          name: raw.name,
          sourceText: raw.text,
          action: { ...referent.action, teleport: jumpFirst ? { ...refTeleport, anchor: "destination" } : refTeleport },
          timing: "legendary",
        });
        entry.optionIdx = options.length - 1;
      }
    }
    // A bare Legendary Move (the creature moves up to its speed without provoking opportunity attacks). Only the entry
    // named Move: compound entries that move and then attack compile as their attack with the move on the entry (`LegendaryEntry.move`), and a
    // shock-wave movement entry carries an effect this field does not model. The no-provoke clause must be in the
    // first sentence; one ancient dragon's is conditional on swimming, which the line never offers.
    // The same bare move is printed under other names (Sprint, Charge, Skitter, ...),
    // some with the no-provoke clause as a second sentence of its own. Those
    // compile too when the whole entry is the move. An entry that has a creature move itself or command its mount to move is not
    // modelled: the creature moves itself.
    const namedMove = /^Move$/i.test(raw.name)
      && /\bmoves\b(?: up to (?:half )?(?:its|his|her|their) speed)?(?: without provoking[^.]*)?\./i.test(raw.text);
    const bareMove = !namedMove && LEGENDARY_BARE_MOVE_RE.test(raw.text.trim())
      && !/\battack\b|\bmakes\b/i.test(raw.text.replace(/opportunity attacks/gi, ""));
    if (legendaryOptions.length === before && (namedMove || bareMove)) {
      const first = raw.text.split(".")[0];
      legendaryMove = {
        name: raw.name,
        halfSpeed: /\bhalf (?:its|his|her|their) speed\b/i.test(first),
        noProvoke: /\bwithout provoking\b/i.test(first) || /\.\s*This movement doesn't provoke opportunity attacks\./i.test(raw.text),
      };
      continue;
    }
    if (legendaryOptions.length === before) {
      // Movement, ally commands, summons, buffs, etc. are out of scope by design;
      // only flag entries that carry parseable damage as genuine parser misses.
      const reason = hasNonFoeDamage(raw.text) ? NON_FOE_DAMAGE_REASON
        : /\{@(?:damage|atkr|h\b)/.test(raw.text) ? "unresolved legendary reference" : "non-damage legendary action";
      skipped.push({ name: raw.name, where: `${monster.name}.legendary`, reason });
    }
  }

  // "...the target has the Prone condition, and the allosaurus can make one Bite attack against it": the free attack
  // rides on the hit under the gates of the rider printed in the same sentence.
  for (const option of options) {
    if (option.action.kind !== "attack") continue;
    const follow = stripTags(option.sourceText).match(/\b(If the target is [^.]*?), and the [a-z' -]+ can make one ([A-Z][A-Za-z' -]+?) attack against it\./);
    const referent = follow ? options.find((other) => other !== option && other.name === follow[2] && other.action.kind === "attack") : undefined;
    if (!follow || !referent || referent.action.kind !== "attack") continue;
    const gate = option.action.riders.find((rider) => rider.requiresMovement !== undefined || rider.targetMaxSize !== undefined);
    option.action.followUp = {
      name: referent.name, action: referent.action,
      ...(gate?.targetMaxSize !== undefined ? { targetMaxSize: gate.targetMaxSize } : {}),
      ...(gate?.requiresMovement !== undefined ? { requiresMovement: gate.requiresMovement } : {}),
      ...(gate?.requiresMovementImmediate ? { requiresMovementImmediate: true as const } : {}),
    };
  }
  // Two readings of a Multiattack can build the same parts in the same order (a mixed volley with one attack replaced);
  // the first is kept.
  const routines = castsTwiceRoutines(monster, options, buildRoutines(monster.action || [], options, skipped, monster.name))
    .filter((routine, i, all) => all.findIndex((other) => JSON.stringify({ ...other, name: "" }) === JSON.stringify({ ...routine, name: "" })) === i);
  barredBeforeGrab(options, routines);
  conditionUserBeforeDamage(options, routines);
  // "The golem makes two Slam attacks, or it makes three Slam attacks if it used Hasten this turn."
  const hastenGated = (monster.action || []).some((a: any) => /^Multiattack/.test(a.name) && /\bthree\b[^.]*\bif it used Hasten this turn\b/i.test(flattenEntries(a.entries)));
  if (hastenGated) for (const routine of routines) {
    if (/^Multiattack/.test(routine.name) && routine.parts.reduce((sum, p) => sum + p.count, 0) === 3) routine.requiresCondition = "hastened";
  }
  for (const option of options) if (/can't take this action again until the start of its next turn/i.test(option.sourceText)) option.oncePerRound = true;
  if (parseHeads(monster)) for (const routine of routines) {
    if (/^Multiattack/.test(routine.name)) for (const part of routine.parts) {
      if (options[part.optionIdx]?.name === "Bite") part.perHead = true;
    }
  }
  for (const raw of monster.action || []) {
    if (!isMultiattack(raw.name)) continue;
    const text = flattenEntries(raw.entries);
    // The data spells this three ways and the difference is cosmetic: the noun may be the
    // generic "attacks" or the weapon itself (both claws hit), and the victim may be a
    // "target" or a "creature". Matching only "attacks ... the same target" silently dropped
    // one creature's grapple (the sole route to its own Bite prerequisite, which left its
    // biggest attack unusable) and another's poison.
    const trigger = text.match(/\bif (both|all|two|three|four|\d+) [a-z]+ hit the same (?:target|creature)\b/i);
    if (!trigger) continue;
    const requiredHits = trigger[1].toLowerCase() === "both" || trigger[1].toLowerCase() === "all"
      ? 2
      : ({ two: 2, three: 3, four: 4 } as Record<string, number>)[trigger[1].toLowerCase()] || Number(trigger[1]);
    // `parseAction` insists on a *damaging* action, which is the wrong test here: the whole
    // point of one creature's clause is that both claws landing grapples the victim, with
    // no damage and no save. Fall back to a bare autohit carrying the follow-up's riders,
    // which is the only way its Bite — gated on Grappled — is ever reachable.
    const parsed = parseAction(raw, "action", `${monster.name}.action.Multiattack follow-up`).option?.action
      ?? conditionOnlyFollowUp(text.slice(trigger.index!));
    const routine = routines.find((candidate) =>
      candidate.name.startsWith("Multiattack")
      && candidate.parts.reduce((sum, part) => sum + part.count, 0) >= requiredHits);
    if (parsed && routine) routine.onAllHits = { requiredHits, action: parsed };
  }
  if (!routines.length) skipped.push({ name: monster.name, where: `${monster.name}.action`, reason: "no damaging action routine" });

  // An anger-driven trait's extra damage rides on the attack the trait names rather than on the trait,
  // so it goes onto that option's own clauses and inherits every gate the engine already
  // applies to damage — resistance, immunity, the crit doubling.
  const aura = parseAura(monster);
  const retaliation = parseRetaliation(monster);
  // Read after the other two so a trait either of them already claimed stays with its owner.
  const sourceTurnAura = parseSourceTurnAura(monster, new Set(
    [aura?.name, retaliation?.name].filter(Boolean).map((n) => (n as string).toLowerCase()),
  ));
  // "Creatures and flammable objects in the Emanation start burning": the Burning hazard, 1d4 Fire a turn (p. 178).
  const ignites = (monster.trait || []).some((t: any) => t.name === sourceTurnAura?.name && /\bcreatures\b[^.]*\bin the (?:\{@variantrule )?Emanation\}? start burning\b/i.test(flattenEntries(t.entries)));
  if (sourceTurnAura && ignites && !sourceTurnAura.riders.some(r => r.condition === "burning")) sourceTurnAura.riders.push({ condition: "burning", duration: "permanent", startTurnDamage: [{ dice: { n: 1, d: 4, mod: 0 }, type: "fire" }] });
  const fury = parseFury(monster);
  // Reactions are read after the option list is complete, because an attack rebuke resolves
  // against it by name exactly as a legendary reference does.
  const counterspell = spellReactions.find(r => r.option.name === "Counterspell");
  const pursuitRaw = (monster.reaction || []).find((r: any) => r.name === "Pursuit" && /uses Teleport/.test(flattenEntries(r.entries)));
  const pursuit = pursuitRaw ? { range: 120, distance: 120, beside: 10 } : undefined;
  const reactionConsumed: string[] = pursuitRaw ? [pursuitRaw.name] : [];
  const reaction = parseReaction(monster, reactionConsumed, options);
  // One daily list for both ("Protective Magic 3/Day") is one budget. A Shield cast from its own level's spell slots
  // keeps them: Counterspell's level 3 slots are not what it spends (PC01).
  const shieldOwnSlots = reaction?.kind === "shield" && reaction.uses?.t === "perDay" && reaction.uses.pool !== undefined;
  if (counterspell && reaction?.kind === "shield" && !shieldOwnSlots && counterspell.option.uses.t === "perDay") {
    const uses = counterspell.option.uses;
    const pool = uses.pool ?? `${monster.name}:protective-magic`;
    counterspell.option.uses = { ...uses, pool };
    reaction.uses = { ...uses, pool };
  }
  const rebuke = spellRebuke(monster, parseRebuke(monster, options), spellReactions.filter(r => r.option.name !== "Counterspell"), skipped);
  // Charge hangs its bonus on the attack the trait names, resolved through `findOption` because
  // the prose says "a gore attack" where the option is "Gore" and, for one creature,
  // "a claw attack" where the option is "Claws", which an exact-name test dropped whole.
  const charge = parseCharge(monster);
  let chargeConsumed: string | undefined;
  if (charge) {
    const target = options[findOption(options, charge.option)];
    if (target && target.action.kind === "attack") {
      target.action.damage = [...target.action.damage, ...charge.damage];
      target.action.riders = [...(target.action.riders ?? []), ...charge.riders];
      chargeConsumed = charge.name;
      // Pounce's follow-up is a bonus-action attack that exists only if the knockdown landed,
      // and no option can say that. Claiming the trait removes it from the audit, so the half
      // that is not modelled is put back explicitly rather than disappearing with it.
      if (charge.unmodeled) {
        skipped.push({ name: charge.name, where: `${monster.name}.trait`,
          reason: `partially modeled charge: unmodeled ${charge.unmodeled}` });
      }
    } else skipped.push({ name: "Charge", where: `${monster.name}.trait`, reason: `charge names an unknown attack (${charge.option})` });
  }
  if (fury?.bonus) {
    const target = options.find((option) => option.name.toLowerCase() === fury.bonus!.option.toLowerCase());
    const action = target?.action;
    if (action && action.kind === "attack") action.damage = [...action.damage, ...fury.bonus.damage];
    else if (!target) {
      skipped.push({
        name: fury.fury.name,
        where: `${monster.name}.trait`,
        reason: `fury bonus names an unknown option (${fury.bonus.option})`,
      });
    }
  }

  // The trait's death at 0 hit points rides every damaging attack and save option. An
  // option that prints its own slay keeps it.
  const slayTrait = parseSlayTrait(monster);
  if (slayTrait) {
    for (const option of options) {
      const action = option.action;
      if ((action.kind !== "attack" && action.kind !== "save") || action.slaysOnZeroHp) continue;
      if (!action.damage.length && !(action.kind === "attack" && action.extraSave?.damage.length)) continue;
      action.slaysOnZeroHp = { ...slayTrait.slay };
    }
  }

  for (const option of options) option.action.actionName = option.name;

  // "The toad can have only one target swallowed at a time, and it can't use Bite while it has a
  // swallowed target." A swallower with a full mouth cannot keep biting with it, and without the
  // restriction the toad swallowed its victim and then went on biting a creature that was inside
  // it. Read off the action that does the swallowing, and applied to the option it names.
  for (const option of options) {
    const action = option.action;
    if (!("riders" in action) || !(action.riders || []).some((rider) => rider.condition === "swallowed")) continue;
    const blocked = option.sourceText.match(/\bcan'?t use ([A-Z][A-Za-z' -]{2,24}?)(?:\s+while|,|\.)/);
    if (!blocked) continue;
    const target = options.find((candidate) => candidate.name.toLowerCase() === blocked[1].trim().toLowerCase());
    if (!target || !("requiresTargetMissingConditions" in target.action)) {
      skipped.push({ name: option.name, where: `${monster.name}.action`,
        reason: `swallow blocks an unknown option (${blocked[1].trim()})` });
      continue;
    }
    target.action.requiresTargetMissingConditions = [
      ...(target.action.requiresTargetMissingConditions ?? []), "swallowed",
    ];
  }

  // A pod-style trap: the trapped target is Blinded and Paralyzed and has Total Cover from anything outside the pod. The
  // pod is the only thing inside it, so the plant's own options cannot reach the trapped target
  // either; without the gate its Vine grappled and struck the creature inside its own pod. The trap is carried by the
  // conditions that sentence names, so every targeting option of the block needs the target free of them (as the toad's
  // Bite needs a target it has not swallowed, above; `meetsCondition` reads them from this block only).
  for (const option of options) {
    const sentence = option.sourceText.split(/(?<=\.)\s+/).find((s) => /\bTotal Cover\b[^.]*\boutside the pod\b/i.test(s));
    if (!sentence) continue;
    const trapped = [...sentence.matchAll(/\{@condition ([A-Za-z]+)/g)].map((m) => m[1].toLowerCase());
    if (!trapped.length) continue;
    for (const target of options) {
      const action = target.action;
      if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport" || action.kind === "random") continue;
      const missing = action.requiresTargetMissingConditions ?? [];
      action.requiresTargetMissingConditions = [...missing, ...trapped.filter((name) => !missing.includes(name))];
    }
  }

  // A target that succeeds on the save is immune to this creature's named effect for 24 hours. A target that made the save is
  // never caught by the same effect again in a duel. A save action is immune as a whole; a damaging attack keeps its
  // hit and loses only the effect named, which in the data is always a lycanthrope's curse.
  for (const option of options) {
    const immunity = successImmunity(option);
    if (!immunity) continue;
    const action = option.action;
    if (action.kind === "save") {
      option.action = { ...action, immuneOnSuccess: immunity };
    } else if (action.kind === "attack") {
      action.riders = action.riders.map((rider) => rider.save && (immunity.key !== "curse" || rider.condition === "cursed")
        ? { ...rider, immuneOnSuccess: immunity } : rider);
    }
  }

  // A magical sleep does not land on a creature that magic cannot put to sleep (Fey Ancestry, a mind-shielding trait). Every
  // option whose name or text says sleep, slumber or dream and that applies Unconscious puts its target to sleep by
  // magic (a breath or grenade that sleeps counts, not only "magical rays"). The
  // tag goes on the Unconscious rider wherever it sits, so a sleep ray is tagged and the other rays are not.
  // An option whose sleep fails against a charm-immune creature is the Sleep and
  // Hypnotic Pattern spells' gate, on the action.
  for (const option of options) {
    if (!/\bsleep|slumber|dream/i.test(`${option.name} ${option.sourceText || ""}`)) continue;
    option.action = tagMagicalSleep(option.action);
    const action = option.action;
    if (action.kind === "save" && /\bhas no effect on (?:a creature|creatures) immune to being (?:\{@condition )?charmed\b/i.test(option.sourceText || "")) {
      option.action = { ...action, blockedByConditions: [...new Set([...(action.blockedByConditions ?? []), "charmed"])] };
    }
  }

  // A penalty that subtracts a die from the creature's damage rolls: the parser leaves the die out of the damage
  // (`ROLL_PENALTY_AFTER_RE`), and the penalty itself is not modelled unless a rider carries it (a roll-effect rider
  // covers a damage penalty).
  for (const option of options) {
    const carried = "riders" in option.action
      && !!option.action.riders?.some((rider) => rider.rollEffects?.some((effect) => effect.roll === "damage" && effect.mode === "penalty"));
    if (ROLL_PENALTY_RE.test(option.sourceText) && !carried) {
      skipped.push({ name: option.name, where: `${monster.name}.${option.timing}`, reason: "roll penalty not modeled (subtracts a die from the target's rolls)" });
    }
  }

  // A margin tier (an extra condition when the save is failed by 5 or more): one the parser could not read
// (`parseSaveMarginTier`) is left out, since it would otherwise apply on every failed save.
  for (const option of options) {
    if (FAIL_MARGIN_RE.test(option.sourceText) && !hasSaveMarginTier(option.action)) {
      skipped.push({ name: option.name, where: `${monster.name}.${option.timing}`, reason: "save-margin tier not modeled (fails by 5 or more)" });
    }
  }

  // A clause that applies the Poisoned condition on a critical hit only: the parser leaves it out
  // (`withoutCriticalClause`), since no compiled field gates an effect on a critical hit.
  for (const option of options) {
    if (criticalClauseEffect(option.sourceText)) {
      skipped.push({ name: option.name, where: `${monster.name}.${option.timing}`, reason: "critical-hit clause not modeled (applies only on a critical hit)" });
    }
  }

  // An action or bonus action that moves the
  // creature up to its Speed and hits what it passes (a Speed-length straight dash that targets every creature passing
  // within 5 feet) compiled the 5-ft reach of its targeting clause and no move of
  // its own, so it reached only what the turn's ordinary move reached. Its range is a proxy equal to the creature's Speed:
  // approach and save in one action. An option whose target clause gave contact range (5 ft or less), or (see
  // below) one that states no range. A printed range above 5 ft stands.
  const ownSpeed = effectiveSpeed(monster);
  for (const [i, option] of options.entries()) {
    if (option.timing !== "action" && option.timing !== "bonus") continue;
    const action = option.action;
    if ((action.kind !== "save" && action.kind !== "autohit") || action.teleport) continue;
    const printed = flattenEntries([option.sourceText]).replace(/\{@\w+ ([^}|]*)[^}]*\}/g, "$1");
    // A move-through option that prints no range at all (the creature moves up to its Speed and
    // each time it enters a creature's space something happens) took the 120-ft default for a save, so a
    // Speed-40 charge was made from 70 ft. Its range is the same proxy: the Speed, or the feet the print gives its move
    // (a straight-line move of 80 feet, or of 30 feet).
    if (action.range === undefined) {
      const moved = OWN_SPEED_MOVE_RE.test(printed) ? ownSpeed : Number(printed.match(OWN_FEET_MOVE_RE)?.[1] ?? 0);
      if (moved > 0) options[i] = { ...option, action: { ...action, range: moved } };
      continue;
    }
    if (action.range > 5 || ownSpeed <= action.range) continue;
    if (!OWN_SPEED_MOVE_RE.test(printed)) continue;
    options[i] = { ...option, action: { ...action, range: ownSpeed } };
  }

  const attacksAgainstDisadvantage = parseAttacksAgainstDisadvantage(monster);
  const evasion = parseEvasion(monster);
  const deathBurst = parseDeathBurst(monster, skipped);
  // Regeneration, Magic Resistance, Legendary Resistance and the rest are matched by name or by
  // content inside `unmodeledTraits`; only the ones that record the trait's own name need
  // passing, so a trait it consumed is not then reported as missing. Charge passes its name
  // only when the bonus actually landed on an attack, so a trait naming something the parser
  // cannot resolve still shows up in the audit.
  const saveTraits = conditionSaveTraits(monster);
  skipped.push(...saveTraits.partial);
  const attackAdvantageWhen = attackAdvantageTrait(monster);
  skipped.push(...unmodeledTraits(monster, {
    aura, sourceTurnAura, retaliation, fury: fury?.fury, charge: chargeConsumed,
    attacksAgainstDisadvantage, evasion, deathBurst, saveTraits: saveTraits.consumed, attackAdvantageWhen, spaceEntry: parseSpaceEntry(monster),
  }));
  const rollBoost = rollBoostReaction(monster);
  skipped.push(...unmodeledReactions(monster, new Set([...reactionConsumed, ...(rebuke ? [rebuke.name] : []), ...(rollBoost ? [rollBoost.raw] : [])])));

  const unmodeledDefenses: string[] = [];
  const qualifiedDefenses = [
    ...parseQualifiedDefenses(monster.resist, "resist", unmodeledDefenses),
    ...parseQualifiedDefenses(monster.immune, "immune", unmodeledDefenses),
  ];
  for (const defense of unmodeledDefenses) {
    skipped.push({ name: defense, where: `${monster.name}.defenses`, reason: "conditional defense with unmodeled condition" });
  }
  for (const trait of (monster.trait || []).filter((trait: any) => lightGatedMagicResistance(trait) || lightGatedAttacksAgainst(trait))) {
    skipped.push({ name: trait.name, where: `${monster.name}.trait`, reason: LIGHT_GATE_REASON });
  }
  // A legacy AC line that gives a second value with mage armor in parentheses compiles the Mage Armor AC, as newer blocks print AC with it
  // applied. Every other conditional AC keeps the first entry.
  const mageArmorAc = (monster.ac || []).find((a: any) => a && typeof a === "object" && /mage armor/i.test(String(a.condition || "")))?.ac;
  // An at-will Mage
  // Armor with a printed AC of exactly 10 + Dex and no "with mage armor" alternative is an AC printed without the spell
  // (several spellcaster blocks print it this way), so it compiles the Mage Armor AC, 13 + Dex, as the conditional-AC rule above does.
  const atWillMageArmor = (monster.spellcasting || []).some((entry: any) =>
    (entry?.will || []).some((spell: unknown) => typeof spell === "string" && /\{@spell mage armor[|}]/i.test(spell)));
  const bareAc = monster.ac?.length === 1 && typeof monster.ac[0] === "number" ? monster.ac[0] : undefined;
  const ac = typeof mageArmorAc === "number" ? mageArmorAc
    : atWillMageArmor && bareAc === 10 + abilityMods.dex ? 13 + abilityMods.dex
    : typeof monster.ac?.[0] === "number" ? monster.ac[0] : monster.ac?.[0]?.ac || 10;
  // initiative.proficiency is a multiplier (1 = proficient, 2 = expertise). initiative.initiative is the printed bonus,
  // present only where no multiplier gives it (Archmage: "Initiative +7" on Dex +2 and PB +4).
  const initiativeBonus = typeof monster.initiative?.initiative === "number" ? monster.initiative.initiative
    : abilityMods.dex + prof * (monster.initiative?.proficiency || 0);
  // Read once: each reads the flattened traits through a regex.
  const mythicReset = mythicResetHp(monster);
  const mythicKeeps = mythicReset !== undefined ? mythicResetKeeps(monster, options, legendaryResistance(monster)) : undefined;
  return {
    id: `${monster.source || "SRD"}:${monster.name}`,
    source: monster.source || "SRD",
    name: monster.name,
    draconicOrigin,
    cr,
    ac,
    hpAvg: monster.hp?.average || 1,
    abilityMods,
    abilityScores,
    saves,
    skills: {
      athletics: parseSigned(monster.skill?.athletics),
      acrobatics: parseSigned(monster.skill?.acrobatics),
      medicine: parseSigned(monster.skill?.medicine),
    },
    initiativeBonus,
    immune: normalizeUnqualifiedDamageList(monster.immune),
    resist: normalizeUnqualifiedDamageList(monster.resist),
    vulnerable: normalizeUnqualifiedDamageList(monster.vulnerable),
    qualifiedDefenses,
    conditionImmune: normalizeList(monster.conditionImmune),
    speed: effectiveSpeed(monster),
    flySpeed: speedMode(monster, "fly"),
    canHover: canHover(monster) || undefined,
    sharesSpace: sharesSpace(monster) || undefined,
    spaceEntry: parseSpaceEntry(monster),
    difficultGround: parseDifficultGround(monster),
    size: sizeRank(monster),
    creatureType: creatureType(monster),
    creatureTags: creatureTags(monster),
    truesight: senses.truesightRange !== undefined,
    ...senses,
    flyby: (monster.trait || []).some((t: any) => /^Flyby/i.test(t.name || "") || NO_PROVOKE_TRAIT_RE.test(flattenEntries([t]))),
    freeCarry: (monster.trait || []).some((t: any) => /\bneedn['’]t spend extra movement to move a creature it is grappling\b/i.test(flattenEntries([t]))) || undefined,
    attacksAgainstDisadvantage,
    evasion,
    reaction,
    rebuke: rebuke?.rebuke,
    deathBurst,
    damageGate: parseDamageGate(monster),
    undeadFortitude: (monster.trait || []).some((t: any) => /^Undead Fortitude/i.test(t.name || "")),
    magicResistance: hasMagicResistance(monster),
    ...((monster.trait || []).some((t: any) => t.name === "Greater Magic Resistance") ? { greaterMagicResistance: true as const } : {}),
    ...((monster.trait || []).some((t: any) => t.name === "Reflective Carapace") ? { reflectiveCarapace: true as const } : {}),
    ...((monster.trait || []).some((t: any) => t.name === "Aversion to Fire") ? { aversionToFire: true as const } : {}),
    ...(speedLossOnDamage(monster) ? { speedLossOnDamage: speedLossOnDamage(monster) } : {}),
    ...(pursuit ? { pursuit } : {}),
    ...(counterspell ? { counterspell: { option: counterspell.option, dc: counterspell.option.action.kind === "save" ? counterspell.option.action.dc : 8 + prof + abilityMods.int } } : {}),
    ...(parseAbsorption(monster) ? { absorption: parseAbsorption(monster) } : {}),
    ...(saveTraits.conditionSaveAdvantage ? { conditionSaveAdvantage: saveTraits.conditionSaveAdvantage } : {}),
    ...(saveTraits.sleepImmune ? { sleepImmune: true } : {}),
    legendaryResistances: legendaryResistance(monster),
    ...(startCountTrait(monster) ? { startCount: startCountTrait(monster) } : {}),
    legendaryOptions,
    ...(legendaryMove ? { legendaryMove } : {}),
    mythicResetHp: mythicReset,
    ...(mythicReset !== undefined && mythicResetReplaces(monster) ? { mythicResetReplaces: true as const } : {}),
    ...(mythicKeeps ? { mythicResetKeeps: mythicKeeps } : {}),
    ...(mythicReset !== undefined && mythicResetRegains(monster) ? { mythicResetRegains: true as const } : {}),
    ...(parseHeads(monster) ? { heads: parseHeads(monster) } : {}),
    regeneration: parseRegeneration(monster),
    aura,
    sourceTurnAura,
    retaliation,
    attackDisadvantage: alwaysAttacksAtDisadvantage(monster) || undefined,
    ...(attackAdvantageWhen ? { attackAdvantageWhen } : {}),
    ...(bloodiedSaveAdvantageTrait(monster) ? { bloodiedSaveAdvantage: true as const } : {}),
    ...(ownAuraSaveAdvantageTrait(monster) ? { saveAdvantageUnlessIncapacitated: true as const } : {}),
    ...(innateInvisibleTrait(monster) ? { innateInvisible: true as const } : {}),
    ...((monster.trait || []).some((trait: any) => /\bcan take one Reaction on every turn\b/i.test(flattenEntries(trait.entries))) ? { reactionEveryTurn: true as const } : {}),
    ...(rollBoost ? { rollBoost: { name: rollBoost.name, bonus: rollBoost.bonus, perDay: rollBoost.perDay } } : {}),
    fury: fury?.fury,
    options,
    routines,
    skipped,
  };
}

function bestiaryFiles(): string[] {
  const missing = BESTIARY_FILES.filter((file) => !fs.existsSync(path.join(dataDir, file)));
  if (missing.length) throw new Error(`Missing configured bestiary files: ${missing.join(", ")}`);
  return [...BESTIARY_FILES];
}

function fixedAc(monster: any): boolean {
  return typeof monster.ac?.[0] === "number" || typeof monster.ac?.[0]?.ac === "number";
}

function exclusionReason(monster: any): string | undefined {
  if (monster.cr == null || !fixedAc(monster) || typeof monster.hp?.average !== "number") {
    return "no fixed CR/AC/HP (summon, companion, or dependent statblock)";
  }
  return undefined;
}

function uniqueDisplayNames(blocks: CombatStatblock[]): CombatStatblock[] {
  const used = new Set<string>();
  return blocks.map((block) => {
    let name = block.name;
    if (used.has(name.toLowerCase())) name = `${name} [${block.source}]`;
    let suffix = 2;
    while (used.has(name.toLowerCase())) name = `${block.name} [${block.source} ${suffix++}]`;
    used.add(name.toLowerCase());
    return name === block.name ? block : { ...block, name };
  });
}

export function compileAllDetailed(): { blocks: CombatStatblock[]; excluded: ExcludedMonster[] } {
  const files = bestiaryFiles();
  const inputs = files.flatMap((file) => (readJson(path.join(dataDir, file)).monster || []).map((monster: any) => ({ monster, file })));
  const excluded: ExcludedMonster[] = [];
  const monsters = inputs.flatMap(({ monster, file }) => {
    const reason = exclusionReason(monster);
    if (!reason) return [monster];
    excluded.push({ name: monster.name, source: monster.source || "unknown", file, reason });
    return [];
  });
  const spellData = readJson(path.join(dataDir, SPELLS_FILE));
  const spells = new Map<string, any>((spellData.spell || []).map((s: any) => [s.name.toLowerCase(), s] as [string, any]));
  const blocks = uniqueDisplayNames(monsters.map((monster: any) => compileMonster(monster, spells)));
  const byId = new Map(blocks.map((block) => [block.id.toLowerCase(), block]));
  for (let i = 0; i < monsters.length; i++) {
    const text = flattenEntries(monsters[i].trait || []);
    const successor = text.match(/container for (?:the )?\{@creature\s+([^|}]+)\|([^}]+)\}/i);
    if (!successor) continue;
    const target = byId.get(`${successor[2]}:${successor[1]}`.toLowerCase());
    if (target) blocks[i].successor = target;
  }
  // Some ranked creatures fight through an otherwise dependent/unranked stat block.
  // Start in that referenced shell, then restore the original creature as the successor
  // when the shell reaches 0 HP (a statue-shell wording is the canonical case).
  const rawById = new Map(inputs.map(({ monster }) => [
    `${monster.source || "SRD"}:${monster.name}`.toLowerCase(),
    monster,
  ]));
  for (let i = 0; i < monsters.length; i++) {
    const text = flattenEntries(monsters[i].trait || []);
    const form = text.match(/uses the \{@creature\s+([^|}]+)\|([^|}]+)(?:\|[^}]*)?\}[^.]{0,80}stat block\}?\s+in place of its own/i)
      || text.match(/uses the \{@creature\s+([^|}]+)\|([^|}]+)(?:\|[^}]*)?\} in place of its own/i);
    if (!form) continue;
    const rawForm = rawById.get(`${form[2]}:${form[1]}`.toLowerCase());
    if (!rawForm) continue;
    const original = structuredClone(blocks[i]);
    const shell = compileMonster(rawForm, spells);
    blocks[i] = {
      ...shell,
      id: original.id,
      source: original.source,
      name: original.name,
      cr: original.cr,
      successor: original,
    };
  }
  return { blocks, excluded };
}

export function compileAll(): CombatStatblock[] {
  return compileAllDetailed().blocks;
}

export function writeCompiled(): CombatStatblock[] {
  fs.mkdirSync(outDir, { recursive: true });
  const { blocks, excluded } = compileAllDetailed();
  fs.writeFileSync(statblocksPath, JSON.stringify(blocks, null, 2));
  fs.writeFileSync(excludedPath, JSON.stringify(excluded, null, 2));
  return blocks;
}

export function loadCompiled(): CombatStatblock[] {
  // The compiler's own sources are inputs too: a parser fix reaches `fight` and `run` without a hand recompile.
  const sources = fs.readdirSync(here, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
  const inputs = [...bestiaryFiles().map((file) => path.join(dataDir, file)), path.join(dataDir, SPELLS_FILE), ...sources];
  const stale = !fs.existsSync(statblocksPath) || inputs.some((file) => fs.statSync(file).mtimeMs > fs.statSync(statblocksPath).mtimeMs);
  if (stale) return writeCompiled();
  return readJson(statblocksPath);
}
