import { parseDice } from "../dice.ts";
import { longAbility, normalizeDamageType } from "../tables.ts";
import type { RollEffect, Ability, ActionOption, CombatAction, DamageClause, DicePool, Rider, SightGate, Timing, Uses } from "../types.ts";
import { parseDamageClauses, parseSlayOnZeroHp } from "./actions.ts";
import { flattenEntries, tagName } from "./tags.ts";

const SPELL_SIGHT_RE = /(?:you can see|that you see)/i;
/**
 * A sight clause that names a place, not a creature: a storm centered on a point the caster can see, a lightning spell
 * with a point in range that it can see, a tentacle spell on ground it can see, a vine spell
 * with an unoccupied space it can see. A clause that names a creature or target before the sight is not one.
 */
const SPELL_PLACE_SIGHT_RE = /\b(?:points?|ground|space)\b(?! at\b)(?:(?!creature|target)[^.]){0,70}?\b(?:you can see|that you see)\b/gi;
/**
 * A spell's sight gate: `true` (the caster sees the target), `"point"` (every sight clause names a point, ground or space,
 * so the caster sees the place: its own Blindness and senses count, the foe's invisibility does not), or `false`.
 */
function spellSightGate(text: string): SightGate {
  if (!SPELL_SIGHT_RE.test(text)) return false;
  return SPELL_SIGHT_RE.test(text.replace(SPELL_PLACE_SIGHT_RE, " ")) ? true : "point";
}

/**
 * The components a casting still needs under the block's header: "requiring no spell components" drops all three,
 * "requiring no Material components" the Material one, "requiring no Somatic or Material components" both of those.
 * `components` is what Counterspell needs to notice the casting.
 */
function spellComponents(spell: any, header: string): { verbal: boolean; somatic: boolean; components: boolean } {
  const none = /requiring no spell components/i.test(header);
  const verbal = !!spell.components?.v && !none;
  const somatic = !!spell.components?.s && !none && !/requiring no Somatic\b/i.test(header);
  const material = !!spell.components?.m && !none && !/requiring no (?:Somatic or )?Material\b/i.test(header);
  return { verbal, somatic, components: verbal || somatic || material };
}

/** "Each creature in the area who can see the pattern must succeed on a Wisdom saving throw" (Hypnotic Pattern). */
const TARGET_MUST_SEE_RE = /\bcreature[^.]*?\bwho can see the\b/i;

/** 2014 spell names (used by older statblocks) that the 2024 rules renamed. */
export const SPELL_RENAMES: Record<string, string> = {
  feeblemind: "befuddlement",
  "branding smite": "shining smite",
};

/**
 * The spell a reference names, whatever trails it.
 *
 * A reference is a `{@spell …}` tag, and what follows the closing brace is decoration: the
 * concentration asterisk many 2014 blocks carry, a parenthetical like "(self only)" or
 * "(level 5 version)", or prose quoting the damage. Stripping a trailing `}` only at
 * end-of-string left the brace attached whenever anything followed it, so
 * `{@spell magic missile}*` was looked up as `magic missile}*` and reported not found — 60 such
 * references in the corpus, 14 of them spells the spell list already holds.
 *
 * Reading the tag's own contents ignores the tail, nested parentheses included:
 * `{@spell otiluke's freezing sphere} (45 ({@damage 13d6}) damage)`, where the old
 * non-greedy parenthetical strip stopped at the inner `)` and left ` damage)` behind.
 */
export function spellName(ref: string): string {
  const tagged = ref.match(/\{@spell\s+([^}]+)\}/i);
  // SRD PDF extraction puts descriptive notes inside the tag. Some notes contain
  // further parentheses, so remove the entire suffix before lookup.
  return tagName(tagged ? tagged[1] : ref).replace(/\s+\(.*$/s, "").trim();
}

/** The data sometimes wraps a spell ref as {entry, hidden} instead of storing a bare string. */
const FIXED_TYPE_NOTE_RE = /\}\s*\((acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\)/i;
function narrowTypeChoices(action: CombatAction, type: string): CombatAction {
  const narrow = (clauses: DamageClause[] | undefined) => clauses?.map((clause) => {
    if (!clause.typeChoices?.includes(type)) return clause;
    const { typeChoices: _choices, ...rest } = clause;
    return { ...rest, type };
  });
  const out: any = { ...action };
  if ("damage" in out && out.damage) out.damage = narrow(out.damage);
  if (out.extraSave?.damage) out.extraSave = { ...out.extraSave, damage: narrow(out.extraSave.damage) };
  return out as CombatAction;
}

export function spellRefText(ref: unknown): string | undefined {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && typeof (ref as { entry?: unknown }).entry === "string") return (ref as { entry: string }).entry;
  return undefined;
}

function scaledLevel(ref: string): number | undefined {
  const match = ref.match(/level\s+(\d+)\s+version/i);
  if (match) return Number(match[1]);
  // The older wordings of the same note, in the parenthesis after the spell: a 6th-level version note,
  // an "at 3rd level" note, or an "as a 5th-level spell" note. On a cantrip "at 11th
  // level" is the caster's level, not a slot (Eldritch Blast); a cantrip scales by `casterLevel`
  // and never reads the cast level (`cantripDice`, `projectileCount`), so the note changes nothing there.
  const note = ref.match(/\}\s*\((?:at (\d+)(?:st|nd|rd|th) level|(\d+)(?:st|nd|rd|th)-level version|as an? (\d+)(?:st|nd|rd|th)-level spell)/i);
  return note ? Number(note[1] ?? note[2] ?? note[3]) : undefined;
}

/**
 * A shared daily pool: a spellcasting entry whose name prints N/Day and whose list is keyed with the bare number (not the
 * each-form) gives the list that many uses in all, not that many of each (the planetar's cure-or-restore list is one
 * example). One shared `perDay` pool key (`Uses`, read by the engine) on the list's spells. Only
 * when the entry's own name prints the same N/Day: a list whose sharing rests on the data key alone (a bare "1" under a plain
 * Spellcasting entry) is not pooled.
 */
const SHARED_DAILY_POOL = "daily-shared:";
function sharedDailyUses(block: any, bucket: string, refs: unknown): Uses | undefined {
  if (!/^\d+$/.test(bucket) || !Array.isArray(refs) || refs.length < 2) return undefined;
  const printed = String(block.name ?? "").match(/\((\d+)\/Day\b/i);
  if (!printed || printed[1] !== bucket) return undefined;
  return { t: "perDay", max: Number(bucket), pool: `${SHARED_DAILY_POOL}${block.name}` };
}

function usesFromBucket(bucket: "will" | string): Uses {
  if (bucket === "will") return { t: "atWill" };
  const match = bucket.match(/^(\d+)/);
  return { t: "perDay", max: match ? Number(match[1]) : 1 };
}

function spellRangeFeet(spell: any): number {
  const distance = spell.range?.distance;
  if (!distance) return 5;
  if (distance.type === "feet" && typeof distance.amount === "number") return distance.amount;
  if (distance.type === "touch") return 5;
  if (distance.type === "self") {
    // A Self-range spell that makes a ranged spell attack reaches as far as the attack prints: Produce
    // Flame's ranged fire throw (60 feet) compiled at 5 ft for three casters.
    const hurl = spell.spellAttack?.includes("R") && /within (\d+) feet of you\b/i.exec(JSON.stringify(spell.entries));
    if (hurl) return Number(hurl[1]);
    const area = Array.isArray(spell.area) ? spell.area[0] : spell.area;
    return typeof area?.amount === "number" ? area.amount : 5;
  }
  return 120;
}

/**
 * A melee spell attack the caster makes itself (a touch, a self-range blade, a 30-ft vine) is a
 * melee attack whose reach is the spell's range. One made by a conjured object placed 60 ft away or more
 * (Spiritual Weapon, Arcane Hand) stays a ranged attack from the caster's square: the
 * caster is not in melee with its target. Compiling Shocking Grasp as ranged put every cast within 5 ft at
 * Disadvantage, so no caster ever chose it.
 */
function spellAttackMode(spell: any, range: number): { melee: boolean; ranged: boolean; reach?: number; conjuredMelee?: true } {
  const distance = spell.range?.distance;
  const casterMade = distance?.type === "touch" || distance?.type === "self" || (distance?.type === "feet" && range <= 30);
  if (spell.spellAttack?.includes("M") && casterMade) return { melee: true, ranged: false, reach: range };
  return spell.spellAttack?.includes("M") ? { melee: false, ranged: true, conjuredMelee: true } : { melee: false, ranged: true };
}

function projectileCount(name: string, castLevel: number, casterLevel: number): number {
  if (name === "Magic Missile") return 2 + castLevel; // 3 darts at level 1
  if (name === "Scorching Ray") return 1 + castLevel; // 3 rays at level 2
  if (name === "Eldritch Blast") return casterLevel >= 17 ? 4 : casterLevel >= 11 ? 3 : casterLevel >= 5 ? 2 : 1;
  return 1;
}

/** Cantrip dice at the highest scalingLevelDice tier <= casterLevel. */
function cantripDice(spell: any, casterLevel: number): DicePool | undefined {
  const entry = Array.isArray(spell.scalingLevelDice) ? spell.scalingLevelDice[0] : spell.scalingLevelDice;
  if (!entry?.scaling) return undefined;
  let best: string | undefined;
  for (const [level, dice] of Object.entries(entry.scaling)) {
    if (Number(level) <= casterLevel) best = dice as string;
  }
  try {
    return best ? parseDice(best) : undefined;
  } catch {
    return undefined;
  }
}

/** Apply {@scaledamage base|range|perLevel} from entriesHigherLevel for "(level N version)" refs. */
function upcastDamage(spell: any, castLevel: number, damage: DamageClause[]): DamageClause[] {
  if (!damage.length || castLevel <= spell.level) return damage;
  const text = flattenEntries(spell.entriesHigherLevel || []);
  const match = text.match(/\{@scaledamage [^|}]+\|[^|}]+\|([^|}]+)\}/);
  if (!match) return damage;
  let per: DicePool;
  try {
    per = parseDice(match[1].trim());
  } catch {
    return damage;
  }
  const steps = castLevel - spell.level;
  const grow = (clause: DamageClause): DamageClause =>
    ({ ...clause, dice: { ...clause.dice, n: clause.dice.n + per.n * steps, mod: clause.dice.mod + per.mod * steps } });
  // An upcast that names more than one damage ("The Fire damage and the Radiant damage increase",
  // "Both types of damage increase") scales every clause of that die: Flame Strike's level 6 version
  // compiled 6d6 Fire + 5d6 Radiant for three blocks.
  const everyClause = /\bboth\b|\bdamage and the \w+ damage\b/i.test(text);
  if (everyClause && damage.length > 1 && damage.every((clause) => clause.dice.d === per.d)) return damage.map(grow);
  if (damage[0].dice.d === per.d) {
    const scaled = { ...damage[0], dice: { ...damage[0].dice, n: damage[0].dice.n + per.n * steps, mod: damage[0].dice.mod + per.mod * steps } };
    return [scaled, ...damage.slice(1)];
  }
  return [...damage, { dice: { n: per.n * steps, d: per.d, mod: per.mod * steps }, type: damage[0].type }];
}

/**
 * High-impact control spells hand-modeled as save-riders. Domination remains unsupported.
 * The lasting conditions retain their Concentration link in the fight engine.
 */
const CONTROL_SPELLS: Record<string, {
  condition: string;
  duration: Rider["duration"];
  endsOnDamage?: boolean;
  saveOnDamage?: boolean;
  saveOnDamageAdvantage?: true;
  escapeAbilities?: Ability[];
  targetGroundOnly?: true;
  targetTypes?: string[];
  blockedByConditions?: string[];
  transitionOnFailedSave?: string;
  transitionEndsOnDamage?: boolean;
  speedZero?: boolean;
}> = {
  "hold person": { blockedByConditions: ["paralyzed"], condition: "paralyzed", duration: "saveEndsEachTurn", targetTypes: ["humanoid"] },
  "hold monster": { blockedByConditions: ["paralyzed"], condition: "paralyzed", duration: "saveEndsEachTurn" },
  "command": { condition: "commandedGrovel", duration: "permanent" },
  "sleep": {
    condition: "sleepDrowsy",
    duration: "saveEndsEachTurn",
    endsOnDamage: true,
    transitionOnFailedSave: "unconscious",
    transitionEndsOnDamage: true,
    blockedByConditions: ["exhaustion"],
  },
  // "Grasping plants sprout from the ground in a 20-foot square": a creature in the air is not in the area.
  "entangle": { condition: "restrained", duration: "untilEscape", escapeAbilities: ["str"], targetGroundOnly: true },
  // "A creature Restrained by the webs can take an action to make a Strength (Athletics) check against your spell save
  // DC." Webs layered over a floor are 5 feet deep, so a creature in the air above them is not in them. The webs as
  // terrain (Difficult Terrain, the save again on entering, burning) are not modeled.
  "web": { condition: "restrained", duration: "untilEscape", escapeAbilities: ["str"], targetGroundOnly: true },
  "fear": { condition: "fearSpell", duration: "permanent", blockedByConditions: ["frightened"] },
  "hypnotic pattern": {
    condition: "hypnotized",
    duration: "permanent",
    endsOnDamage: true,
    speedZero: true,
    blockedByConditions: ["charmed"],
  },
  "blindness/deafness": { condition: "blinded", duration: "saveEndsEachTurn" },
  "hideous laughter": {
    condition: "hideousLaughter",
    duration: "saveEndsEachTurn",
    saveOnDamage: true,
    saveOnDamageAdvantage: true,
  },
  "suggestion": {
    condition: "suggested",
    duration: "permanent",
    endsOnDamage: true,
    blockedByConditions: ["charmed"],
  },
};

/**
 * Conditions a damaging spell applies alongside its damage. The generic attack and save
 * branches below (read there; no hybrid spell needs one) compile a spell's damage and nothing else, so Ray of Sickness
 * never poisoned and Sunburst never blinded. A generic read of the spell text was tried and rejected (it pulled in the
 * smites and zone spells, gave wrong durations and no save DC), so these are hand-keyed by name, like `CONTROL_SPELLS`,
 * with the repeat save or escape DC taken from the caster's own spell save DC. Every shape is one the engine already
 * runs:
 * - Ray of Sickness: Poisoned until the end of your next turn, on a hit.
 * - A wave spell: Prone on a failed save.
 * - Sunburst: Blinded on a failed save, with another Constitution save at the end of each of its turns.
 * - Black Tentacles: Restrained until the spell ends, escaped by an action to make a Strength (Athletics) check
 *   against your spell save DC (the Entangle shape; the Concentration link ends it with the spell).
 * - A vine spell: Grappled on a hit if Huge or smaller, with an escape DC equal to your spell save DC, held by the vine
 *   rather than the caster.
 * - Weird: Frightened on a failed save; at the end of each of its turns a Wisdom save, 5d10 Psychic on a failure, the
 *   spell ending on a success (the engine resolves the save before the end-of-turn damage, so a success takes none).
 * Not here, and so unchanged: Contagion, the smites, a darkness-zone spell, Conjure Elemental, a radiant storm spell,
 * Arcane Hand; Prismatic Spray carries its own through `rayTableAction`.
 */
const SPELL_RIDERS: Partial<Record<string, (dc: number, damage: DamageClause[]) => Rider[]>> = {
  "ray of sickness": () => [{ condition: "poisoned", duration: "endOfSourceNextTurn" }],
  "sunburst": (dc) => [{ condition: "blinded", duration: "saveEndsEachTurn", save: { ability: "con", dc } }],
  "black tentacles": (dc) => [{ condition: "restrained", duration: "untilEscape", escapeDc: dc, escapeAbilities: ["str"] }],
  "weird": (dc) => [{
    condition: "frightened", duration: "saveEndsEachTurn", save: { ability: "wis", dc },
    endTurnDamage: [{ dice: parseDice("5d10"), type: "psychic" }],
  }],
  // Conjure Elemental: on a failed save the target takes 8d8 damage of the spirit's type
  // and is Restrained until the spell ends; at the start of each of its turns the Restrained target repeats the save,
  // taking 4d8 damage of the spirit's type on a failure and shaking off the Restrained condition on a success. The Weird
  // shape: a repeat Dexterity save, 4d8 of the spirit's type (the same four choices as the 8d8)
  // when it fails. The engine repeats saves at the end of the target's turn, not the start (as for every "start of each
  // of its turns" repeat save in the data), and the Concentration link ends the Restrained with the spell.
  "conjure elemental": (dc) => [{
    condition: "restrained", duration: "saveEndsEachTurn", save: { ability: "dex", dc },
    endTurnDamage: [{ dice: parseDice("4d8"), type: "lightning", typeChoices: ["lightning", "thunder", "fire", "cold"] }],
  }],
  // Phantasmal Killer: on a failed save the target takes 4d10 Psychic damage, then makes a
  // Wisdom save at the end of each of its turns for the duration, taking the Psychic damage again on a failure and
  // ending the spell on a success. The Weird shape with no condition
  // of its own: the repeat save and damage ride on the synthetic tick holder "afflicted" (a label the engine only
  // tracks), and the repeated damage is the cast's own damage, upcast as cast. Its
  // Disadvantage on ability checks and attack rolls for the duration rides on the same holder.
  "phantasmal killer": (dc, damage) => [{
    condition: "afflicted", duration: "saveEndsEachTurn", save: { ability: "wis", dc },
    endTurnDamage: damage.map((clause) => ({ ...clause })),
    rollEffects: [{ roll: "attack", mode: "disadvantage" }, { roll: "check", mode: "disadvantage" }],
  }],
  // Guiding Bolt: on a hit, the first attack against this target gets Advantage if it lands before your next turn ends.
  "guiding bolt": () => [{
    condition: "guidingBolt", duration: "endOfSourceNextTurn",
    rollEffects: [{ roll: "attackAgainst", mode: "advantage", nextRollOnly: true }],
  }],
  // Vicious Mockery: on a failed save, the target has Disadvantage on the next attack roll it makes before the end of
  // its next turn.
  "vicious mockery": () => [{
    condition: "nextAttackDisadvantage", duration: "endOfTargetNextTurn",
    rollEffects: [{ roll: "attack", mode: "disadvantage", nextRollOnly: true }],
  }],
  // Chill Touch (2024 printing): on a hit the target takes 1d10 Necrotic damage and cannot heal until your next turn
// ends. The `healBlocked` rider the action-form Chill Touches carry, with this printing's end.
  "chill touch": () => [{ condition: "healBlocked", duration: "endOfSourceNextTurn", blocksHealing: true }],
  // Ray of Frost (2024 printing): on a hit 1d8 Cold damage lands and the target's Speed drops by
  // 10 feet until the start of your next turn. The `speedCut` rider the stat-block Rays of Frost carry.
  "ray of frost": () => [{ condition: "speedCut", duration: "startOfSourceNextTurn", speedCut: 10 }],
  // Thunderwave: "On a failed save, a creature takes 2d8 Thunder damage and is pushed 10 feet away from you."
  "thunderwave": () => [{ condition: "forcedPush", push: 10, duration: "endOfTargetTurn" }],
};

function spellRiders(spell: any, dc: number, damage: DamageClause[] = []): Rider[] {
  const riders = SPELL_RIDERS[String(spell.name).toLowerCase()];
  return riders && dc ? riders(dc, damage) : [];
}

const ROUNDS_PER: Record<string, number> = { round: 1, minute: 10, hour: 600, day: 14400 };

/**
 * Whether a spell needs Concentration, and how many rounds it can last when that is fewer than a duel's
 * hundred. The engine used to hold every Concentration effect until the caster was broken, so a
 * one-minute spell nothing interrupted lasted the whole fight: one fiend routed an angry opponent
 * with one Fear for the rest of a 42-round fight and won all ten, and with the minute enforced the
 * opponent comes back and wins nine. A minute is ten rounds. Ten minutes and longer outlast the
 * round cap and are left unset, so no block that cannot change a fight changes.
 */
export function concentrationOf(spell: any): { concentration: boolean; concentrationRounds?: number } {
  const timed = spell.duration?.find((d: any) => d.concentration);
  if (!timed) return { concentration: false };
  const per = ROUNDS_PER[timed.duration?.type];
  const rounds = per !== undefined && timed.duration?.amount ? per * timed.duration.amount : undefined;
  return rounds !== undefined && rounds < 100 ? { concentration: true, concentrationRounds: rounds } : { concentration: true };
}

/** A control with no printed distance ("while the two of you are on the same plane of existence"): farther than any duel. */
const CONTROL_ANYWHERE = 1_000_000;
function controlSpellAction(spell: any, dc: number, range: number | undefined, castLevel = 0): CombatAction | undefined {
  // Charm Monster is Charm Person with no Humanoid limit: "One creature you can see within range makes a Wisdom saving
  // throw. It does so with Advantage if you or your allies are fighting it. On a failed save, the target has the Charmed
  // condition until the spell ends or until you or your allies damage it." Neither needs Concentration.
  if (spell.name === "Charm Person" || spell.name === "Charm Monster") return {
    kind: "save", ability: "wis", dc, magical: true, range, requiresSight: true,
    ...(spell.name === "Charm Person" ? { targetTypes: ["humanoid"] } : {}), blockedByConditions: ["charmed"], saveAdvantageInCombat: true,
    damage: [], onSuccess: "none", concentration: false,
    riders: [{ condition: "charmed", duration: "permanent", rounds: 600, endsOnSourceDamage: true }],
  };
  // Dominate Person: "One Humanoid you can see within range must succeed on a Wisdom saving throw or have the Charmed
  // condition for the duration. The target has Advantage on the save if you or your allies are fighting it. Whenever the
  // target takes damage, it repeats the save, ending the spell on itself on a success." The caster commands it on its
  // turns, at no action, wherever the two are on the same plane (`Rider.controlRange`, here unbounded). Concentration.
  if (spell.name === "Dominate Person") return {
    kind: "save", ability: "wis", dc, magical: true, range, requiresSight: true, targetTypes: ["humanoid"],
    blockedByConditions: ["charmed"], saveAdvantageInCombat: true, damage: [], onSuccess: "none",
    // "Your Concentration can last longer with a spell slot of level 6 (up to 10 minutes), 7 (up to 1 hour), or 8+".
    ...(castLevel >= 6 ? { concentration: true } : concentrationOf(spell)),
    riders: [{ condition: "charmed", save: { ability: "wis", dc }, duration: "permanent", controlRange: CONTROL_ANYWHERE, saveOnDamage: true, saveOnDamageAdvantage: true }],
  };
  // Telekinesis, the Creature option: "You can try to move a Huge or smaller creature. The target must succeed on a
  // Strength saving throw, or you move it up to 30 feet in any direction within the spell's range. Until the end of your
  // next turn, the creature has the Restrained condition, and if you lift it into the air, it is suspended there. It
  // falls at the end of your next turn unless you use this option on it again and it fails the save." The move is
  // always the lift (`Rider.lift`); the spell is used again on later turns while it lasts (`SaveAction.sustained`).
  if (spell.name === "Telekinesis" && dc) {
    const text = flattenEntries(spell.entries);
    const creature = text.match(/try to move an? (Tiny|Small|Medium|Large|Huge|Gargantuan) or smaller creature\b[^.]*\.\s*The target must succeed on an? (\w+) saving throw, or you move it up to (\d+) feet/i);
    const ability = creature && ABILITY_WORDS[creature[2].toLowerCase()] as Ability | undefined;
    if (creature && ability && /later turns before the spell ends/i.test(text) && /end of your next turn, the creature has the Restrained/i.test(text.replace(/\{@condition ([^}|]+)[^}]*\}/g, "$1"))) return {
      kind: "save", ability, dc, magical: true, range, requiresSight: true, damage: [], onSuccess: "none", ...concentrationOf(spell),
      targetMaxSize: ["tiny", "small", "medium", "large", "huge", "gargantuan"].indexOf(creature[1].toLowerCase()),
      sustained: true,
      riders: [{ condition: "restrained", duration: "endOfSourceNextTurn", lift: Number(creature[3]) }],
    };
  }
  if (spell.name === "Power Word Stun") return {
    kind: "autohit", magical: true, range, requiresSight: true, damage: [], riders: [
      { condition: "stunned", targetHpMax: 150, duration: "saveEndsEachTurn", save: { ability: "con", dc } },
      { condition: "powerWordSlowed", requiresTargetHpAbove: 150, speedZero: true, duration: "startOfSourceNextTurn" },
    ],
  };
  if (spell.name === "Slow") return {
    kind: "save", ability: "wis", dc, magical: true, range, damage: [], onSuccess: "none", ...concentrationOf(spell),
    riders: [{ condition: "slowed", duration: "saveEndsEachTurn", save: { ability: "wis", dc },
      speedHalved: true, noReactions: true, actionOrBonus: true, oneAttack: true, slowCasting: true, acAdjustment: -2,
      rollEffects: [{ roll: "save", ability: "dex", mode: "penalty", dice: { n: 0, d: 1, mod: 2 } }],
    }],
  };
  // Confusion: "that target can't take Bonus Actions or Reactions and must roll 1d10 at the start of each of its turns
  // to determine its behavior for that turn ... At the end of each of its turns, an affected target repeats the save".
  // The table is the engine's (`takeTurn`, the `confused` condition).
  if (spell.name === "Confusion") return {
    kind: "save", ability: "wis", dc, magical: true, range, damage: [], onSuccess: "none", ...concentrationOf(spell),
    riders: [{ condition: "confused", duration: "saveEndsEachTurn", save: { ability: "wis", dc }, noReactions: true, noBonusActions: true }],
  };
  if (spell.name === "Counterspell") return { kind: "save", ability: "con", dc, magical: true, range, damage: [], riders: [], onSuccess: "none" };
  // "Each creature in the Cube is also outlined if it fails a Dexterity saving throw. For the duration, ... affected
  // creatures ... can't benefit from the Invisible condition. Attack rolls against an affected creature or object have
  // Advantage if the attacker can see it."
  if (spell.name === "Faerie Fire" && dc) return {
    kind: "save", ability: "dex", dc, magical: true, range, damage: [], onSuccess: "none", ...concentrationOf(spell),
    riders: [{ condition: "outlined", duration: "permanent", rollEffects: [{ roll: "attackAgainst", mode: "advantage", requiresSight: true }] }],
  };
  const control = CONTROL_SPELLS[spell.name.toLowerCase()];
  if (!control || !dc || !spell.savingThrow?.length) return undefined;
  const ability = longAbility[spell.savingThrow[0]] as Ability;
  return {
    kind: "save",
    ability,
    dc,
    damage: [],
    onSuccess: "none",
    magical: true,
    requiresSight: spellSightGate(flattenEntries(spell.entries)),
    ...concentrationOf(spell),
    range,
    ...(control.targetGroundOnly ? { targetGroundOnly: true as const } : {}),
    ...(TARGET_MUST_SEE_RE.test(flattenEntries(spell.entries)) ? { targetMustSee: true as const } : {}),
    targetTypes: control.targetTypes,
    blockedByConditions: control.blockedByConditions,
    riders: [{
      condition: control.condition,
      duration: control.duration,
      save: control.duration === "saveEndsEachTurn" ? { ability, dc } : undefined,
      escapeDc: control.escapeAbilities ? dc : undefined,
      endsOnDamage: control.endsOnDamage,
      ...(control.escapeAbilities ? { escapeAbilities: control.escapeAbilities } : {}),
      ...(control.saveOnDamage ? { saveOnDamage: true } : {}),
      ...(control.saveOnDamageAdvantage ? { saveOnDamageAdvantage: true as const } : {}),
      ...(control.transitionOnFailedSave ? { transitionOnFailedSave: control.transitionOnFailedSave } : {}),
      ...(control.transitionEndsOnDamage ? { transitionEndsOnDamage: true } : {}),
      ...(control.speedZero ? { speedZero: true } : {}),
      ...(control.blockedByConditions ? { blockedByConditions: control.blockedByConditions } : {}),
    }],
  };
}

/**
 * A spell that rolls a die to pick what each target suffers, and prints the outcomes as a table:
 * Prismatic Spray, the only one in the resolved lists. Its "roll {@dice 1d8} to determine which
 * color ray affects it" was read as the damage, and the table rows (flattened away) with it: three
 * casters had a 7th-level spell that dealt 1d8 acid, save for none.
 *
 * Every row becomes an equally likely branch on the spell's one Dexterity save. A damage row is its
 * damage, halved on a success. A condition row lands on a failed save with its own repeat save:
 * Indigo's Restrained ends after three successful Constitution saves, and Violet's Blinded lasts to
 * the start of the caster's next turn. What follows a failure is not modelled: Indigo's petrification
 * after three failed saves (the engine counts successes, not failures) and Violet's banishment to
 * another plane. The "struck by two rays" row is a nested draw over every ordered pair of the others,
 * both on the same save; a row the reader does not recognise leaves the spell to the old path.
 */
function rayTableAction(spell: any, dc: number, range: number | undefined): CombatAction | undefined {
  const lead = typeof spell.entries?.[0] === "string" ? spell.entries[0] : "";
  const table = spell.entries?.find((e: any) => e?.type === "table");
  if (!dc || !table || !/\broll \{@dice 1?d\d+\} to determine\b/i.test(lead)) return undefined;
  const ability = longAbility[spell.savingThrow?.[0]] as Ability | undefined;
  if (!ability) return undefined;
  const base = { kind: "save" as const, ability, dc, magical: true, range, requiresSight: false, concentration: false };
  const counts: Record<string, number> = { two: 2, three: 3 };
  const rays: Extract<CombatAction, { kind: "save" }>[] = [];
  let doubleRow = false;
  for (const row of table.rows || []) {
    const text = flattenEntries([row[1]]);
    if (/\broll twice\b/i.test(text)) {
      doubleRow = true;
      continue;
    }
    const damage = parseDamageClauses(text);
    if (damage.length) {
      rays.push({ ...base, damage, onSuccess: /half as much damage/i.test(text) ? "half" : "none", riders: [] });
      continue;
    }
    const condition = String(row[1]).match(/\{@condition ([^}]+)\}/)?.[1];
    const repeat = text.match(/\bmakes an? (\w+) saving throw\b/i)?.[1]?.toLowerCase();
    const duration = /\bat the end of each of its turns\b/i.test(text) ? "saveEndsEachTurn" as const
      : /\bat the start of your next turn\b/i.test(text) ? "startOfSourceNextTurn" as const : undefined;
    const repeatAbility = repeat ? longAbility[repeat] as Ability | undefined : undefined;
    if (!condition || !repeatAbility || !duration) return undefined;
    const successes = text.match(/\bsuccessfully saves (\w+) times\b/i)?.[1]?.toLowerCase();
    rays.push({
      ...base,
      damage: [],
      onSuccess: "none",
      riders: [{
        condition: tagName(condition).toLowerCase(),
        save: { ability: repeatAbility, dc },
        duration,
        ...(successes && counts[successes] ? { savesToEnd: counts[successes] } : {}),
      }],
    });
  }
  if (!rays.length) return undefined;
  const branches: CombatAction[] = [...rays];
  if (doubleRow) {
    const pairs: CombatAction[] = [];
    for (const a of rays) {
      for (const b of rays) {
        const damage = [...a.damage, ...b.damage];
        const riders = a === b ? a.riders : [...a.riders, ...b.riders];
        pairs.push({ ...base, damage, onSuccess: damage.length ? "half" : "none", riders });
      }
    }
    branches.push({ kind: "random", branches: pairs });
  }
  return { kind: "random", branches };
}

/**
 * Hybrid spell (attack roll AND a save burst, e.g. Ice Knife): the damage before the
 * saving-throw clause is the on-hit damage, the damage after it is the auto burst.
 */
/** A spell that offers a list of alternative effects, not an attack and then a save. */
const SPELL_MODE_LIST_RE = /\bone of the following effects\b/i;

function splitHybrid(text: string): { hit: DamageClause[]; save: DamageClause[] } | undefined {
  const i = text.search(/saving throw/i);
  if (i < 0) return undefined;
  const hit = parseDamageClauses(text.slice(0, i));
  const save = parseDamageClauses(text.slice(i));
  return hit.length && save.length ? { hit, save } : undefined;
}

/**
 * Teleport spells, with the distance the spell text states rather than the `range` field —
 * Misty Step is a "self" range spell that moves you 30 feet, so the field is useless here.
 *
 * Deliberately absent: **Teleport** and **Word of Recall** send the caster hundreds of miles
 * to a remembered place, which is leaving the fight rather than repositioning inside it;
 * **Tree Stride** needs scenery the duel has no notion of; and **Blink** is a defensive
 * phase-out, not a jump the movement AI can aim. All four stay in `out/coverage.md`.
 */
const TELEPORT_SPELLS: Record<string, { distance: number; timing?: Timing }> = {
  "misty step": { distance: 30, timing: "bonus" },
  "dimension door": { distance: 500 },
};

/**
 * A bonus-action spell whose attack comes with the cast, so the compiled attack is the bonus action:
 * Spiritual Weapon (you can immediately make one melee spell attack) and a vine spell (an entry that
 * opens with making a melee spell attack). Not one whose damage takes a later Magic action (Produce Flame's
 * Magic action to hurl fire, Flame Blade's Magic action to make a melee spell
 * attack): casting it is the bonus action, the attack is not. Smites print no attack of their own.
 * These compiled at action timing from a daily or slot list.
 */
function bonusCastAttack(spell: any): boolean {
  const times = (spell.time || []) as { unit: string }[];
  if (!times.some((time) => time.unit === "bonus") || times.some((time) => time.unit === "action")) return false;
  return (spell.entries || []).some((entry: unknown) => typeof entry === "string"
    && (/\bimmediately make (?:one|an?) (?:melee|ranged) spell attack\b/i.test(entry)
      || /^Make an? (?:melee|ranged) spell attack\b/i.test(entry)));
}

/**
 * Spells whose damage comes in stages the duel does not model as one packet: a wall or zone that deals
 * damage when it appears and again when a creature moves through it, or a sphere whose acid burns a turn
 * later. Their whole text was read as one save, so each option added a later trigger's clause to the
 * on-cast one (Wall of Ice 10d6 + 5d6, Wall of Thorns 7d8 + 7d8) and put a no-save clause behind the
 * save (a darkness-zone spell). The option keeps only the first packet the target meets, under that trigger's
 * own save or no save; the other clause is a skip line (no persistent-zone model). Every clause list
 * these spells compile to has the kept trigger first.
 */
const STAGED_SPELLS: Record<string, { reason: string; noSave?: boolean }> = {
  // Kept: the wall appearing in the creature's space (Dexterity, half on a success).
  "wall of ice": { reason: "later trigger not modeled (no persistent zone): the frigid-air sheet's Constitution save for Cold damage on moving through a destroyed section" },
  // Kept: the wall appearing (Dexterity, Piercing, half on a success).
  "wall of thorns": { reason: "later trigger not modeled (no persistent zone): the Slashing damage for entering or ending a turn in the wall" },
  // Kept: the explosion (Dexterity; half the initial damage on a success).
  "vitriolic sphere": { reason: "later trigger not modeled: the Acid damage at the end of the target's next turn after a failed save" },
  // Kept: the first bolt (Dexterity, half on a success). The extra die needs an existing storm outdoors.
  "call lightning": { reason: "environment not modeled: the extra damage die when cast outdoors in a storm (no weather in the duel)" },
};

/** "You can take a Magic action on later turns to move the Cylinder up to 60 feet": an area its caster moves. */
const MOVABLE_ZONE_RE = /\btake a Magic action on later turns to move the (?:\{@\w+ )?\w+/i;

/** Spells that need an environment the duel does not have; each compiles no option, only a skip line. */
const ENVIRONMENT_SPELLS: Record<string, string> = {
  "control water": "environment not modeled: needs a body of water in the area (no terrain in the duel)",
};

/** A spell that fills an area, or takes every creature in one. */
const SPELL_AREA_RE = /\{@variantrule (?:Sphere|Cone|Cube|Cylinder|Line|Emanation)\b|\b(?:each|any) creature\b|\bcreate a wall\b/i;

/** "the target gains a Fly Speed of 60 feet and can hover": the Speed a spell grants, and whether it hovers. */
function grantedFly(text: string): { speed: number; hover: boolean } {
  const plain = text.replace(/\{@\w+ ([^}|]+)[^}]*\}/g, "$1");
  return { speed: Number(plain.match(/\bgains a Fly Speed of (\d+) feet\b/i)?.[1] ?? 0), hover: /\bcan hover\b/i.test(plain) };
}

/** "has Truesight with a range of 120 feet": the range a spell grants. */
function grantedTruesight(text: string): number {
  return Number(text.replace(/\{@\w+ ([^}|]+)[^}]*\}/g, "$1").match(/\bhas Truesight with a range of (\d+) feet\b/i)?.[1] ?? 0);
}

/** Self-buff spells that apply a lasting condition to the caster. */
const SELF_BUFF_SPELLS: Record<string, { condition: string; breaksOnAttackOrSpell: boolean; rollEffects?: RollEffect[]; images?: number; rounds?: number; ward?: true; fly?: true; truesight?: true }> = {
  // "You touch a willing creature. For the duration, the target gains a Fly Speed of 60 feet and can hover." The caster
  // itself: it has no ally in a duel. The Speed and the hover are read from the spell's text.
  "fly": { condition: "flying", breaksOnAttackOrSpell: false, fly: true },
  // "For the duration, the willing creature you touch has Truesight with a range of 120 feet." The caster itself; the
  // range is read from the spell's text. Duration 1 hour, no Concentration.
  "true seeing": { condition: "trueSeeing", breaksOnAttackOrSpell: false, truesight: true },
  "invisibility": { condition: "invisible", breaksOnAttackOrSpell: true },
  "greater invisibility": { condition: "invisible", breaksOnAttackOrSpell: false },
  // "Whenever a target makes an attack roll or a saving throw before the spell ends, the target adds 1d4 to the attack
  // roll or save." The caster blesses itself: it has no ally in a duel.
  "bless": { condition: "blessed", breaksOnAttackOrSpell: false, rollEffects: [
    { roll: "attack", mode: "bonus", dice: { n: 1, d: 4, mod: 0 } }, { roll: "save", mode: "bonus", dice: { n: 1, d: 4, mod: 0 } }] },
  // "You ward a creature within range" (the caster: it has no ally in a duel). Duration 1 minute, no Concentration. The
  // ward's save is at the caster's spell save DC (`SelfBuffAction.wardDc`).
  "sanctuary": { condition: "sanctuary", breaksOnAttackOrSpell: false, rounds: 10, ward: true },
  // "Three illusory duplicates of yourself appear in your space." Duration 1 minute, no Concentration.
  "mirror image": { condition: "mirrorImage", breaksOnAttackOrSpell: false, images: 3, rounds: 10 },
  // "For the duration, Celestials, Elementals, Fey, Fiends, and Undead have Disadvantage on attack rolls against you."
  // Break Enchantment and Dismissal are not compiled (a sending to another plane has no place in the duel).
  "dispel evil and good": { condition: "wardedFromEvilAndGood", breaksOnAttackOrSpell: false, rollEffects: [
    { roll: "attackAgainst", mode: "disadvantage", attackerTypes: ["celestial", "elemental", "fey", "fiend", "undead"] }] },
};

/**
 * "The pit fiend casts Fireball (level 5 version) twice ... It can replace one Fireball with Hold Monster (level 7
 * version) or Wall of Fire": the spell a Recharge feature casts twice a use, or undefined. The compiler pairs it with
 * itself and with each replacement (`castsTwiceRoutines`).
 */
export function castsTwiceSpell(monster: any): string | undefined {
  for (const block of monster.spellcasting || []) {
    const header = flattenEntries(block.headerEntries);
    const name = block.recharge && header.match(/\bcasts \{@spell ([^}|]+)[^}]*\}[^.]*?\btwice\b/i)?.[1];
    if (name) return name.trim();
  }
  return undefined;
}

const ABILITY_WORDS: Record<string, string> = {
  strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha",
};

/**
 * A block that prints no DC still has one: 8 + proficiency bonus + the spellcasting ability's
 * modifier, which is how every printed DC is made. Some blocks name only the casting ability, and
 * nothing more, so their Fireballs and Hold Persons
 * compiled with nothing to save against and were never cast. The ability comes from the data's
 * `ability` field, or failing that from the header's own words; with neither, there is no DC.
 */
function derivedSpellDc(monster: any, block: any, header: string, cr: number): number {
  const modifier = spellcastingModifier(monster, block, header);
  if (modifier === undefined) return 0;
  const proficiency = 2 + Math.floor((Math.max(cr, 1) - 1) / 4);
  return 8 + proficiency + modifier;
}

/** The spellcasting ability's modifier: the data's `ability` field, or failing that the header's own words. */
function spellcastingModifier(monster: any, block: any, header: string): number | undefined {
  const named = header.match(/\b(strength|dexterity|constitution|intelligence|wisdom|charisma)\b(?= as (?:(?:its|the) )?spellcasting ability)|spellcasting ability is (strength|dexterity|constitution|intelligence|wisdom|charisma)\b/i);
  const ability = typeof block.ability === "string" ? block.ability
    : named ? ABILITY_WORDS[(named[1] || named[2]).toLowerCase()] : undefined;
  const score = ability ? Number(monster[ability]) : NaN;
  if (!Number.isFinite(score)) {
    // Auxiliary SRD features explicitly borrow the primary Spellcasting ability.
    // Do not borrow it for an unrelated block that merely omits an ability.
    if (/\busing the same spellcasting ability as Spellcasting\b/i.test(header)) {
      const primary = (monster.spellcasting || []).find((candidate: any) => candidate !== block && /^Spellcasting$/i.test(candidate.name || ""));
      if (primary) return spellcastingModifier(monster, primary, flattenEntries(primary.headerEntries));
    }
    return undefined;
  }
  return Math.floor((score - 10) / 2);
}

/**
 * Healing spells a duellist can cast on itself: regaining Hit Points equal to 2d8 plus your spellcasting ability
 * modifier, compiled as the existing `selfheal` with the list's uses (a daily count or a spell-slot pool). The
 * modifier is the block's spellcasting ability; a "level N version" adds the `{@scaledice}` step per slot level.
 * Not compiled when the print puts the spell on another creature (a blessing that touches another creature
 * and casts Cure Wounds on that creature) or restricts it to a variant ("(... medic only)"): those stay
 * skipped as before. `healing-spells`; before it these were skipped as "non-damage or unsupported".
 */
const HEALING_SPELLS = new Set(["cure wounds", "healing word", "mass cure wounds"]);

function healingSpellAction(spell: any, ref: string, header: string, castLevel: number, modifier: number | undefined): CombatAction | undefined {
  if (!HEALING_SPELLS.has(spell.name.toLowerCase()) || modifier === undefined) return undefined;
  if (/\banother creature\b/i.test(header) || /\}\s*\([^)]*\bonly\)/i.test(ref)) return undefined;
  const base = flattenEntries(spell.entries).match(/\bregains?\b[^.]*?\{@dice\s+([^}]+)\}\s+plus your spellcasting ability modifier/i);
  if (!base) return undefined;
  const healing = parseDice(base[1]);
  const per = flattenEntries(spell.entriesHigherLevel || []).match(/\{@(?:scaledice|scaledamage) [^|}]+\|[^|}]+\|([^|}]+)\}/);
  const steps = Math.max(0, castLevel - spell.level);
  if (per && steps) {
    const step = parseDice(per[1].trim());
    if (step.d === healing.d) healing.n += step.n * steps;
  }
  return { kind: "selfheal", spell: true, healing: { ...healing, mod: healing.mod + modifier } };
}

/** A spell cast with a bonus action and never with an action. */
function bonusOnly(spell: any): boolean {
  const times = (spell.time || []) as { unit: string }[];
  return times.some((time) => time.unit === "bonus") && !times.some((time) => time.unit === "action");
}

/**
 * A spell whose casting time is a reaction, compiled like any other and set aside: it answers the
 * spell's own trigger rather than spending a turn. Hellish Rebuke was a turn action for four
 * blocks — one at will — and a caster that prints it in a spellcasting reaction dropped it.
 * The compiler turns it into the block's rebuke (`spellRebuke`, `compile.ts`).
 */
export interface SpellReaction {
  option: ActionOption;
  /** The spell's `time[].condition`: "which you take in response to taking damage from …". */
  trigger: string;
}

/**
 * A trait that rolls a count when the creature is first met (a d10 for how many brains it has already consumed). The engine rolls it
 * at the fight's start (`CombatStatblock.startCount`).
 */
export function startCountTrait(monster: any): { name: string; dice: DicePool } | undefined {
  for (const trait of monster.trait || []) {
    const dice = flattenEntries(trait.entries || []).match(/roll \{@dice (\d+)d(\d+)\} to determine the number of brains it has already consumed/i);
    if (dice) return { name: String(trait.name), dice: { n: Number(dice[1]), d: Number(dice[2]), mod: 0 } };
  }
  return undefined;
}

const CASTS_TWICE_RE = /\btwice\b/i;
const CAST_ON_ANOTHER_RE = /\btouches another creature\b[^.]*\bcasts\b[^.]*\bon that creature\b/i;
export function compileSpellOptions(
  monster: any,
  spells: Map<string, any>,
  cr: number,
  skipped: { name: string; where: string; reason: string }[],
  reactions: SpellReaction[] = [],
  actionRefs: { name: string; uses: Uses }[] = [],
): ActionOption[] {
  const out: ActionOption[] = [];
  const allHeaders = flattenEntries((monster.spellcasting || []).flatMap((block: any) => block.headerEntries || []));
  const sharedDc = Number(allHeaders.match(/\{@dc\s+(\d+)\}/i)?.[1] || 0);
  const sharedToHit = Number(allHeaders.match(/\{@hit\s+([+-]?\d+)\}/i)?.[1] || 0) || (sharedDc ? sharedDc - 8 : 0);
  for (const block of monster.spellcasting || []) {
    // A spellcasting block printed as a reaction (the creature casts a reaction spell in response to
    // that spell's trigger) is read only for a reaction spell that compiles. Its Shield is
    // `parseReaction`'s; Counterspell is carried to the compiler's interrupt feature, while
    // unsupported utility reactions such as Feather Fall stay out of the ordinary option list.
    const reactionBlock = block.displayAs === "reaction";
    const skip = (entry: { name: string; where: string; reason: string }) => {
      if (!reactionBlock) skipped.push(entry);
    };
    const header = flattenEntries(block.headerEntries);
    // "a 5th-level <Word> spellcaster" (a guild caster) is the same level: one or two capitalised words may stand
    // between.
    const explicitCasterLevel = Number((header.match(/\b(\d+)(?:st|nd|rd|th)-level spellcaster\b/i)
      ?? header.match(/\b(\d+)(?:st|nd|rd|th)-level (?:[A-Z][a-z]+ ){1,2}spellcaster\b/))?.[1] || block.level || 0);
    const casterLevel = Math.min(20, Math.max(1, explicitCasterLevel || Math.round(cr)));
    const dc = Number(header.match(/\{@dc\s+(\d+)\}/i)?.[1] || 0) || sharedDc || derivedSpellDc(monster, block, header, cr);
    const toHit = Number(header.match(/\{@hit\s+([+-]?\d+)\}/i)?.[1] || 0) || sharedToHit || (dc ? dc - 8 : 0);
    const spellRefs: [string, Uses][] = [];
    const addRefs = (refs: unknown, uses: Uses) => {
      if (!Array.isArray(refs)) return;
      for (const raw of refs) {
        const ref = spellRefText(raw);
        if (ref) spellRefs.push([ref, uses]);
      }
    };
    const brainGated = /must have consumed the requisite number of brains/i.test(header);
    const startCount = startCountTrait(monster);
    // A feature that prints "(Recharge after a Short or Long Rest)" is one use a fight, however its list is filed.
    addRefs(block.will, /\(Recharge after a (?:Short or )?Long Rest\)/i.test(String(block.name ?? "")) ? { t: "perDay", max: 1 } : usesFromBucket("will"));
    for (const [bucket, refs] of Object.entries(block.daily || {})) {
      addRefs(refs, sharedDailyUses(block, bucket, refs) ?? usesFromBucket(bucket));
    }
    // Legacy prepared-spell blocks group spells by level. Every spell at that level consumes
    // the same pool; treating each spell as having its own copy of the slots greatly
    // overstates a caster's endurance.
    for (const [level, raw] of Object.entries(block.spells || {})) {
      const prepared = raw as { slots?: number; spells?: unknown[] };
      const uses: Uses = Number(level) === 0
        ? { t: "atWill" }
        : { t: "perDay", max: prepared.slots || 1, pool: `spell-slots:${level}` };
      addRefs(prepared.spells, uses);
    }
    for (const [minimum, refs] of Object.entries(block.recharge || {})) {
      // A printed Recharge feature that casts one of several spells is one use: its spells share one recharge (`Uses.pool`,
      // which the engine already keys a recharge by). Each spell used to recharge alone, so a spent Entangle left the
      // other spell charged. Not a feature that casts twice a use (a Spellcasting feature that casts two spells in one
      // action): the compile casts once, and pooling alone would take it further below the print.
      // A feature that casts twice a use shares the recharge too, and one use covers two casts (`Uses.casts`).
      const twice = CASTS_TWICE_RE.test(header);
      const onePool = Array.isArray(refs) && (refs.length > 1 || twice);
      addRefs(refs, { t: "recharge", min: Number(minimum) || 6, ...(onePool ? { pool: `recharge:${String(block.name ?? "Spellcasting")}` } : {}), ...(twice ? { casts: 2 } : {}) });
    }
    for (const refs of Object.values(block.legendary || {})) {
      addRefs(refs, { t: "atWill" });
    }
    for (const [ref, uses] of spellRefs) {
      const name = spellName(ref);
      // A feature whose spells go on someone else: "The unicorn touches another creature with its horn and casts Cure Wounds
      // or Lesser Restoration on that creature". The only other creature in a duel is the foe, so nothing is cast.
      if (CAST_ON_ANOTHER_RE.test(header)) {
        skip({ name, where: `${monster.name}.spellcasting`, reason: "cast on another creature: no ally in a duel" });
        continue;
      }
      // "{@spell lightning bolt} (see "Actions" below)": the block prints the spell as its own
      // action, with its own dice. Compiling the list entry as well gave several blocks a second
      // copy from the 2024 spell (at different dice from the printed action),
      // and left the printed action (which requires a spell slot) at will. The list entry compiles
      // nothing; its uses are handed to the printed action (`compileMonster`).
      if (/\(\s*see\s+"?actions"?\s+below\s*\)/i.test(ref)) {
        skip({ name, where: `${monster.name}.spellcasting`, reason: 'printed as its own action (see "Actions" below)' });
        if (!reactionBlock) actionRefs.push({ name, uses });
        continue;
      }
      const record = spells.get(SPELL_RENAMES[name.toLowerCase()] ?? name.toLowerCase());
      // Accept older SRD extractions as well as the canonical unit.
      const spell = record ? { ...record, time: (record.time || []).map((time: any) => time.unit === "bonusaction" ? { ...time, unit: "bonus" } : time) } : undefined;
      if (!spell) {
        skip({ name, where: `${monster.name}.spellcasting`, reason: "spell not found" });
        continue;
      }
      // A spell that works only on water in the area has nothing to act on: the duel has no terrain
      // (Control Water). Its Whirlpool option compiled as a per-day 2d8 at 300 ft
      // for fourteen blocks.
      const envReason = ENVIRONMENT_SPELLS[spell.name.toLowerCase()];
      if (envReason) {
        skip({ name: spell.name, where: `${monster.name}.spellcasting`, reason: envReason });
        continue;
      }
      const text = flattenEntries(spell.entries);
      // A save the spell's own text fixes at a DC and hands to "you" is the caster's risk, not an
      // attack: Contact Other Plane's save (made by the caster when casting) compiled as 6d6 psychic against the
      // caster's opponent for seven creatures.
      if (/\byou\b[^.]{0,40}?\b(?:must\s+)?(?:make|succeed on)\s+a\s+\{@dc\s+\d+\}/i.test(text)) {
        skip({ name, where: `${monster.name}.spellcasting`, reason: "the caster makes this spell's save, not its target" });
        continue;
      }
      const castLevel = scaledLevel(ref) ?? spell.level;
      const range = spellRangeFeet(spell);
      const type = normalizeDamageType(spell.damageInflict?.[0]);
      let damage = parseDamageClauses(text);
      if (spell.level === 0) {
        const scaled = cantripDice(spell, casterLevel);
        if (scaled && damage.length) damage = [{ ...damage[0], dice: scaled }, ...damage.slice(1)];
      } else {
        damage = upcastDamage(spell, castLevel, damage);
      }
      damage = damage.map((d) => (d.type === "untyped" ? { ...d, type } : d));
      const count = projectileCount(spell.name, castLevel, casterLevel);
      let action: CombatAction | undefined = controlSpellAction(spell, dc, range, castLevel) ?? rayTableAction(spell, dc, range);
      if (action?.kind === "save" && (spell.name === "Charm Person" || spell.name === "Charm Monster")) {
        const hours = header.match(/duration is (\d+) hours?/i) ?? header.match(/Charm Monster[^}]*\}? \(lasts (\d+) hours?\b/i);
        const exception = header.match(/willing recipient of the [^.]*?['’]s (\w+), the damage of which doesn['’]t end the spell/i);
        action.riders = action.riders.map(r => ({ ...r, ...(hours ? { rounds: Number(hours[1]) * 600 } : {}),
          ...(exception ? { willingFor: exception[1], sourceDamageException: exception[1] } : {}) }));
      }
      const teleportSpell = TELEPORT_SPELLS[spell.name.toLowerCase()];
      if (!action && teleportSpell) {
        action = { kind: "teleport", teleport: { distance: teleportSpell.distance }, magical: true };
      }
      if (!action && SELF_BUFF_SPELLS[spell.name.toLowerCase()]) {
        const buff = SELF_BUFF_SPELLS[spell.name.toLowerCase()];
        action = {
          kind: "selfbuff",
          condition: buff.condition,
          breaksOnAttackOrSpell: buff.breaksOnAttackOrSpell,
          ...(buff.rollEffects ? { rollEffects: buff.rollEffects } : {}),
          ...(buff.images ? { images: buff.images } : {}),
          ...(buff.rounds ? { rounds: buff.rounds } : {}),
          ...(buff.ward ? { wardDc: dc } : {}),
          ...(buff.fly ? { fly: grantedFly(flattenEntries(spell.entries)) } : {}),
          ...(buff.truesight ? { truesight: grantedTruesight(flattenEntries(spell.entries)) } : {}),
          ...concentrationOf(spell),
        };
      }
      // "You touch a creature and end one condition on it: Blinded, Deafened, Paralyzed, or Poisoned." The caster's own.
      const cures = !action ? text.match(/\bend one condition on it:([^.]*)\./i)?.[1] : undefined;
      if (cures) {
        action = { kind: "selfheal", healing: { n: 0, d: 1, mod: 0 }, spell: true,
          curesConditions: [...cures.matchAll(/\{@condition\s+([^}|]+)[^}]*\}/gi)].map((m) => m[1].toLowerCase()) };
      }
      // "You touch a creature and magically remove one of the following effects from it: 1 Exhaustion level; the Charmed
      // or Petrified condition; a curse; any reduction to one of the target's ability scores; any reduction to the
      // target's Hit Point maximum." The caster's own. A restored maximum returns no hit points, so it is not carried.
      const removes = !action ? text.match(/\bremove one of the following effects from it:([\s\S]*)$/i)?.[1] : undefined;
      if (removes) {
        action = { kind: "selfheal", healing: { n: 0, d: 1, mod: 0 }, spell: true,
          curesConditions: [...[...removes.matchAll(/\{@condition\s+([^}|]+)[^}]*\}/gi)].map((m) => m[1].toLowerCase()),
            .../\bA curse\b/i.test(removes) ? ["cursed"] : []],
          .../\breduction to one of the target['’]s ability scores\b/i.test(removes) ? { restoresAbilityScores: true } : {} };
      }
      // "Choose one creature, object, or magical effect within range. Any ongoing spell of level 3 or lower on the target
      // ends. For each ongoing spell of level 4 or higher on the target, make an ability check using your spellcasting
      // ability (DC 10 plus that spell's level)." The effects in a duel sit on the two creatures.
      if (!action && spell.name === "Dispel Magic") {
        const mod = spellcastingModifier(monster, block, header);
        if (mod !== undefined) action = { kind: "selfheal", healing: { n: 0, d: 1, mod: 0 }, dispels: { mod, range } };
      }
      if (!action) action = healingSpellAction(spell, ref, header, castLevel, spellcastingModifier(monster, block, header));
      // A spell whose attack and save are alternatives of a list (one of several listed effects, such as a fist attack or a
      // grasping save with a later crush) is not an attack followed by a save. Read as a hybrid it dealt both modes'
      // damage in one cast. It falls to the plain spell-attack branch below (the first listed mode), which also reads
      // the spell's sight clause and its Concentration. Ice Knife (an attack, then a burst) stays a hybrid.
      const hybrid = !action && spell.spellAttack && spell.savingThrow?.length && dc && toHit && !SPELL_MODE_LIST_RE.test(text) ? splitHybrid(text) : undefined;
      if (action) {
        // handled by the control-spell / self-buff table
      } else if (hybrid) {
        const ability = longAbility[spell.savingThrow[0]] as Ability;
        action = {
          kind: "attack", toHit, magical: true, ...spellAttackMode(spell, range), spell: true, range, damage: hybrid.hit, riders: [],
          extraSave: { ability, dc, damage: upcastDamage(spell, castLevel, hybrid.save), onSuccess: /or half/i.test(text) ? "half" : "none", onMiss: true },
        };
      } else if (spell.name === "Magic Missile") {
        action = {
          kind: "autohit",
          magical: true,
          range,
          requiresSight: true,
          blockedByShield: true,
          damage: Array.from({ length: count }, () => ({ dice: parseDice("1d4 + 1"), type })),
        };
      } else if (spell.name === "Power Word Kill") {
        // The 2024 spell adds a clause that deals extra Psychic damage to a target that fails otherwise. The text's own
        // clause carries it, gated `requiresTargetHpAbove: 100`; it was dropped here, so the spell did nothing to a foe
        // above 100 HP.
        action = { kind: "autohit", magical: true, range, requiresSight: true, damage, instantDeathHpThreshold: 100 };
      } else if (spell.spellAttack && toHit && damage.length) {
        // A hit that deals Force damage equal to a die "plus your spellcasting ability modifier" (Spiritual Weapon; Flame
        // Blade's 3d6 the same). The modifier was dropped. Added only when it follows the die the attack deals (a later
        // crush's modifier does not ride on an earlier attack's damage).
        const firstDie = text.match(/\{@(?:damage|dice) [^}]+\}(\s+plus your spellcasting ability modifier\b)?/i);
        const modifier = firstDie?.[1] ? spellcastingModifier(monster, block, header) : undefined;
        if (modifier !== undefined) damage = [{ ...damage[0], dice: { ...damage[0].dice, mod: damage[0].dice.mod + modifier } }, ...damage.slice(1)];
        action = {
          kind: "attack",
          toHit,
          magical: true,
          ...spellAttackMode(spell, range),
          spell: true,
          range,
          requiresSight: spellSightGate(text),
          ...concentrationOf(spell),
          // "As a Bonus Action on your later turns, you can move the force up to 20 feet and repeat the attack": one
          // casting attacks every turn while its Concentration lasts (`AttackAction.sustained`).
          ...(concentrationOf(spell).concentration && /\bon your later turns, you can move the \w+ up to \d+ feet and repeat the attack\b/i.test(text) ? { sustained: true as const } : {}),
          damage: Array.from({ length: count }, () => damage[0]),
          riders: spellRiders(spell, dc),
          ...(spell.name.toLowerCase() === "acid arrow" && damage[1] ? {
            missDamageFactor: 0.5,
            riders: [{ condition: "acidArrow", duration: "permanent" as const, delayedDamage: { damage: [damage[1]], clock: "target" as const } }],
          } : {}),
        };
      } else if (spell.savingThrow?.length && spell.damageInflict?.length && dc && damage.length) {
        const ability = longAbility[spell.savingThrow[0]] as Ability;
        action = {
          kind: "save",
          ability,
          dc,
          magical: true,
          range,
          requiresSight: spellSightGate(text),
          ...concentrationOf(spell),
          damage,
          // A half-cover mention is not a half-damage clause: a cantrip's text about no benefit from half cover
          // compiled half damage on a success for seven casters.
          onSuccess: /\bhalf\b(?!\s+cover)/i.test(text) ? "half" : "none",
          riders: spellRiders(spell, dc, damage),
        };
      }
      if (!action) {
        skip({ name: spell.name, where: `${monster.name}.spellcasting`, reason: "non-damage or unsupported spell" });
        continue;
      }
      if (action.kind === "save" && spell.name === "Shatter") action.saveDisadvantageTypes = ["construct"];
      // Mind Spike: "On a failed save, you also always know the target's location until the spell ends ... if it has the
      // Invisible condition, it gains no benefit from that condition against you." The outline without Faerie Fire's
      // Advantage; in a duel "against you" is against the only other creature.
      if (action.kind === "save" && spell.name === "Mind Spike") action.riders = [...action.riders, { condition: "outlined", duration: "permanent" }];
      action = { ...action, spell: true, spellName: spell.name, ...(SPELL_AREA_RE.test(text) ? { area: true as const } : {}), ...spellComponents(spell, header) };
      // What Dispel Magic ends is read from the level the spell is cast at.
      if (action.kind === "selfbuff") action = { ...action, spellLevel: castLevel };
      else if ("riders" in action && action.riders) action = { ...action, riders: action.riders.map((rider) => ({ ...rider, spellLevel: castLevel })) };
      if (spell.name === "Vitriolic Sphere" && action.kind === "save" && action.damage[1]) {
        action = { ...action, damage: [action.damage[0]], riders: [...action.riders,
          { condition: "vitriolicAcid", duration: "permanent", delayedDamage: { damage: [action.damage[1]], clock: "target" } }],
        };
      }
      const staged = spell.name === "Vitriolic Sphere" ? undefined : STAGED_SPELLS[spell.name.toLowerCase()];
      if (staged && action.kind === "save" && action.damage.length > 1) {
        const first = action.damage.slice(0, 1);
        action = staged.noSave
          ? {
            kind: "autohit", magical: true, range: action.range, requiresSight: action.requiresSight,
            ...concentrationOf(spell), damage: first,
          }
          : { ...action, damage: first };
        skip({ name: spell.name, where: `${monster.name}.spellcasting`, reason: staged.reason });
      }
      // A spell that takes a minute or longer to cast cannot be cast in the fight: Geas and Dream
      // compiled as a 1-minute cast's psychic save burst taken as an action, for sixteen blocks.
      if (!(spell.time || []).some((time: any) => ["action", "bonus", "reaction"].includes(time.unit))) {
        const time = spell.time?.[0];
        skip({ name: spell.name, where: `${monster.name}.spellcasting`, reason: `casting time ${time?.number ?? "?"} ${time?.unit ?? "?"}: cannot be cast in the fight` });
        continue;
      }
      // Misty Step is a bonus action wherever it is printed, which is the whole point of it:
      // the caster steps out of a grapple and still swings.
      // Disintegrate: a target reduced to 0 Hit Points by its damage is disintegrated into dust; the same reader as a
      // printed action's slay-on-zero.
      // Harm: "On a failed save, it takes 14d6 Necrotic damage, and its Hit Point maximum is reduced by an amount equal
      // to the Necrotic damage it took. On a successful save, it takes half as much damage only."
      const maxHpCut = action.kind === "save" ? text.match(/\bfailed save, [^.]*?(?:\{@variantrule )?Hit Point(?:\|[^}]*\})? maximum is reduced by an amount equal to the (\w+) damage it took/i) : null;
      // "This spell can't reduce a target's Hit Point maximum below 1."
      const maxHpFloor = text.match(/\bcan['’]t reduce a target['’]s (?:\{@variantrule )?Hit Point(?:\|[^}]*\})? maximum below (\d+)/i);
      if (maxHpCut && action.kind === "save") {
        action = { ...action, damage: action.damage.map((clause) => clause.type === maxHpCut[1].toLowerCase()
          ? { ...clause, reducesMaxHp: true, reducesMaxHpSave: "action" as const, ...(maxHpFloor ? { reducesMaxHpFloor: Number(maxHpFloor[1]) } : {}) } : clause) };
      }
      // Spirit Guardians: an Emanation around the caster for the duration, whose save a creature makes when the
      // Emanation enters its space and when it enters the Emanation or ends its turn there, once a turn.
      const emanates = action.kind === "save" && !!action.concentration
        ? text.match(/\bin a (\d+)-foot (?:\{@variantrule )?Emanation(?:\|[^}]*)?\}? for the duration\b/i) : null;
      if (emanates && action.kind === "save" && /\benters the (?:\{@variantrule )?Emanation(?:\|[^}]*)?\}? or ends its turn there\b/i.test(text)) {
        action = { ...action, range: Number(emanates[1]), emanation: { radius: Number(emanates[1]),
          ...(/\bSpeed is halved in the (?:\{@variantrule )?Emanation/i.test(text) ? { speedHalved: true as const } : {}) } };
      }
      const slay = parseSlayOnZeroHp(text);
      if (slay && (action.kind === "attack" || action.kind === "save")) action = { ...action, slaysOnZeroHp: slay };
      // A list entry that prints the damage type after the spell, as in "{@spell <name>} (Necrotic)", fixes the
      // spell's choice ("Radiant or Necrotic damage (your choice)") at that type. A clause whose choices include it
      // takes it and loses the choice.
      const fixedType = ref.match(FIXED_TYPE_NOTE_RE)?.[1]?.toLowerCase();
      if (fixedType) action = narrowTypeChoices(action, fixedType);
      const timing: Timing = teleportSpell?.timing
        ?? (block.displayAs === "bonus" ? "bonus" : block.displayAs === "legendary" ? "legendary"
          : bonusCastAttack(spell) || (action.kind === "selfheal" && bonusOnly(spell)) ? "bonus" : "action");
      // A spell entry can require the caster to have consumed a number of brains, each entry printing "(N brains)". A
      // creature that prints no starting count starts at 0, so an entry needing any brain compiles nothing; one that
      // rolls its count (`startCountTrait`) carries the entry's count for the engine's gate.
      const brains = brainGated ? Number(ref.match(/(\d+)(?:\s+or\s+more)?\s+brains?\s*\)/i)?.[1] ?? 0) : 0;
      if (brains > 0 && !startCount) {
        skip({ name: spell.name, where: `${monster.name}.spellcasting`, reason: `needs ${brains} brains; no starting count is printed, so it starts with 0` });
        continue;
      }
      // A feature that casts one spell and has a name of its own ("Charm. The succubus casts Dominate Person") is that
      // spell under the feature's name, which is what a Multiattack calls it ("uses Charm or Draining Kiss").
      const featureName = String(block.name ?? "");
      const featureAlias = spellRefs.length === 1 && featureName && !/spellcasting/i.test(featureName) ? featureName.replace(/\s*(?:\([^)]*\)|\{@recharge[^}]*\})\s*$/, "") : undefined;
      const option: ActionOption = {
        name: spell.name,
        ...(featureAlias && featureAlias.toLowerCase() !== spell.name.toLowerCase() ? { aliases: [featureAlias] } : {}),
        sourceText: ref,
        sourceRef: `${monster.name}.spellcasting`,
        action,
        uses,
        timing,
        oncePerRound: /can't take this action again until the start of its next turn/i.test(header) || undefined,
        ...(brains > 0 ? { requiresStartCount: brains } : {}),
      };
      const reactionTime = (spell.time || []).find((time: any) => time.unit === "reaction");
      // An area the caster keeps up and moves (Moonbeam): "you can take a Magic action on later turns to move the
      // Cylinder up to 60 feet", and a creature makes the save again "when the spell's area moves into its space and
      // when it enters the spell's area or ends its turn there". The cast option puts the area down; a second option,
      // usable while the area is up, moves it onto the target for the same save and expends nothing.
      const movable = action.kind === "save" && !!action.concentration && !reactionTime && !reactionBlock && timing === "action"
        && MOVABLE_ZONE_RE.test(text) && /\bends its turn there\b/i.test(text);
      if (movable && action.kind === "save") option.action = action = { ...action, zone: { key: spell.name } };
      if (reactionTime) reactions.push({ option, trigger: String(reactionTime.condition || "") });
      else if (!reactionBlock) out.push(option);
      if (movable && action.kind === "save") {
        out.push({
          name: `${spell.name} (move)`,
          sourceText: ref,
          sourceRef: `${monster.name}.spellcasting`,
          action: { ...action, concentration: undefined, concentrationRounds: undefined, spell: undefined, components: undefined, verbal: undefined, somatic: undefined, actionName: `${spell.name} (move)` },
          uses: { t: "atWill" },
          timing: "action",
          requiresZone: spell.name,
        });
      }
    }
  }
  // A shared list's pool matters only when two or more of its spells compile; one alone
  // keeps its plain count, as before, so the compile changes only where the uses are really shared.
  const carriers = [...out.map((option) => option.uses), ...reactions.map((reaction) => reaction.option.uses), ...actionRefs.map((ref) => ref.uses)];
  const sharedCount = (key: string) => carriers.filter((uses) => uses.t === "perDay" && uses.pool === key).length;
  const unshare = (uses: Uses): Uses => uses.t === "perDay" && uses.pool?.startsWith(SHARED_DAILY_POOL) && sharedCount(uses.pool) < 2 ? { t: "perDay", max: uses.max } : uses;
  for (const option of out) option.uses = unshare(option.uses);
  for (const reaction of reactions) reaction.option.uses = unshare(reaction.option.uses);
  for (const ref of actionRefs) ref.uses = unshare(ref.uses);
  return out;
}
