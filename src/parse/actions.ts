import { avgDice, parseDice } from "../dice.ts";
import { damageTypes, impactfulConditions, longAbility, normalizeDamageType, numberWords } from "../tables.ts";
import type { RollEffect } from "../types.ts";
import type { AbilityDrain, Ability, ActionOption, AttackAdvantageCondition, BreakableObject, ChoiceRider, CombatAction, DamageClause, MaxHpReduction, Rider, SelfCost, SelfTempHp, SlayOnZeroHp, Timing, Uses, TeleportSpec } from "../types.ts";
import { findTags, flattenEntries, tagName } from "./tags.ts";

export interface ParseOutcome {
  option?: ActionOption;
  reason?: string;
}

export function parseUses(name: string): Uses {
  const recharge = name.match(/\{@recharge(?:\s+(\d+))?\}/i);
  if (recharge) return { t: "recharge", min: recharge[1] ? Number(recharge[1]) : 6 };
  // The limit may sit behind a qualifier inside the same parenthesis: a reaction can be written with
  // a spell level and a "1/Day" limit together, and read as at-will it fires every round of the
  // fight. Two names in the data are written this way and both are reactions.
  const daily = name.match(/\((?:[^)]*;\s*)?(\d+)\/Day/i);
  if (daily) return { t: "perDay", max: Number(daily[1]) };
  // A recharge on a Short or Long Rest means one use in a single encounter.
  if (/Recharges after (?:a )?(?:Short(?: or Long)?|Long) Rest/i.test(name)) return { t: "perDay", max: 1 };
  return { t: "atWill" };
}

function cleanName(name: string): string {
  return name
    .replace(/\s*\{@recharge(?:\s+\d+)?\}/gi, "")
    // An option name with a parenthetical qualifier and a recharge tag leaves a dangling separator once the recharge tag
    // goes, and the leftover punctuation ends up in the compiled option name.
    .replace(/[;,]\s*\)/g, ")")
    .replace(/\s*\(\s*\)/g, "")
    .trim();
}

function damageTypeAfter(text: string, pos: number): string {
  // The type word immediately follows the damage value. `pos` is already past the
  // tag's closing brace, so allow a leading ) or } (statblock text) or a bare
  // space (spell prose) before the type word.
  const match = text.slice(pos, pos + 60).match(/^[\s)}]*([A-Za-z]+)\s+damage/i);
  const type = match?.[1]?.toLowerCase();
  return damageTypes.includes(type || "") ? type! : "untyped";
}

function parseReach(text: string): number {
  return Number(text.match(/reach\s+(\d+)\s*(?:ft|feet)/i)?.[1] || 5);
}

// A splash around the target is a radius, not a range: "within 10 feet of it" after a target, or
// "within 5 feet of the target", or "within 5 feet of that point". Read as the range, it held a 120-foot ray to
// 10 feet. Set aside, these print no range of their own, and a save with none reaches the engine's default 120 feet:
// that is the printed range of the list headers, and it falls short of a range stated as anywhere under a storm.
// A radius like "within 30 feet of it" with no target ahead of it is the creature's own emanation, where the radius is
// the reach, so "of it" counts as a splash only after a target in the same sentence.
const SPLASH_RADIUS_RE = /(\btarget\b[^.]{0,40}\beach (?:other )?creature) within \d+ (?:feet|ft\.) of (?:it|the target|that target|that point)\b|(\beach (?:other )?creature) within \d+ (?:feet|ft\.) of (?:the|that) (?:target|point)\b/gi;

/**
 * A conditional Advantage printed in the attack's header, after the bonus: "{@hit 5} (with Advantage if the target is
 * Grappled by the mimic)". Read only before the hit entry, and only where the condition is a state the engine tracks; any
 * other condition (the target being inside a particular space, the attacker being berserk, allies being nearby) compiles
 * nothing.
 */
export function attackHeaderAdvantage(text: string): AttackAdvantageCondition | undefined {
  const header = stripTags(text.split(/\{@h\}/i)[0]).match(/\(with advantage\b([^)]*)\)/i);
  // The same grant printed in the attack's body: "While attached to a target, the darkmantle can attack only the target
  // but has Advantage on its attack rolls."
  if (!header && /\bWhile attached to a target, the [\w'’ -]+ can attack only the target but has Advantage on its attack rolls\b/i.test(stripTags(text))) return "attackerAttached";
  if (!header) return undefined;
  const condition = header[1];
  if (/\bif the target is grappled by\b|\bagainst a creature the [\w'’ -]+ is grappling\b/i.test(condition)) return "targetGrappledByAttacker";
  if (/\bif the target (?:doesn't have all its hit points|is (?:a creature that is )?missing any (?:of its )?hit points)/i.test(condition)) return "targetMissingHp";
  if (/\bif the (?!target\b)[\w'’ -]+ is missing any hit points\b/i.test(condition)) return "attackerMissingHp";
  if (/\bif the [\w'’ -]+ is attached to the target\b/i.test(condition)) return "attackerAttached";
  if (/\bduring the first round of each combat\b/i.test(condition)) return "firstRound";
  return undefined;
}

/** The creature's own jump: teleport to any free visible space within N feet (not "within N feet of ..."). */
const OWN_JUMP_WITHIN_RE = /(\bteleports to an? (?:unoccupied )?space (?:it|he|she|they) can see) within \d+ feet\b(?! of\b)/i;

/** A hearing distance ("audible within 300 feet") that another "within N feet" follows. */
const AUDIBLE_WITHIN_RE = /\b(audible|heard) within \d+ feet\b(?=[\s\S]*\bwithin \d+ feet\b)/i;

/** An effect placed at a point described as "up to N feet away" (a thrown bomb): N is the range. */
const THROWN_POINT_RE = /\bpoint\b[^.]{0,40}?\bup to (\d+) feet away\b/i;
/**
 * A thrown object that names no point: a grenade lobbed 60 feet that bursts into a 20-foot-radius sphere. That compiled
 * the radius, 20, as the range. The thing thrown is "a <one or two words>", so
 * a throw whose object is the target (an outcome) is not read, and "up to N feet away" stays with the point reader and
 * the pushes.
 */
const THROWN_OBJECT_RE = /\bthrows an? (?:[a-z][a-z'-]* ){1,2}up to (\d+) feet\b(?! away\b)/i;

const DEPLOYED_TRAP_RE = /\bdeploys?\b[^.]{0,60}\btrap\b[^.]{0,40}\bwithin (\d+) feet of (?:itself|it|him|her)\b[\s\S]{0,300}?\bwithin (\d+) feet of the trap\b/i;

function parseRange(text: string): { range?: number; longRange?: number } {
  text = text.replace(SPLASH_RADIUS_RE, (_, targeted, bare) => `${targeted ?? bare} nearby`);
  // Books spell the unit three ways — "range 120 ft.", "range 120 feet", and "range 30/120," with
  // the unit left off entirely — and only the first was understood. The rest fell through to the
  // 120-foot default with no long-range band at all.
  const attackRange = text.match(/range\s+(\d+)(?:\s*(?:ft\.?|feet))?(?:\s*\/\s*(\d+))?\s*(?:ft\b\.?|feet\b|(?=\s*,))/i);
  if (attackRange) return { range: Number(attackRange[1]), longRange: attackRange[2] ? Number(attackRange[2]) : undefined };
  // Two ranged attacks print their range under the word "reach",
  // in a slash pair like 30/60 ft. or 30/120 ft., and compiled no range at
  // all. Only the slash pair, in the attack's header: a bare "reach 120 ft." on a ranged attack is not read here.
  const reachAsRange = text.split("{@h}")[0].match(/\breach\s+(\d+)\s*\/\s*(\d+)\s*ft\b/i);
  if (reachAsRange) return { range: Number(reachAsRange[1]), longRange: Number(reachAsRange[2]) };
  // A trap deployed within 5 feet of the creature that triggers
  // on an enemy within 10 feet of the trap reaches a foe up to placement
  // + radius away. Read as the placement alone it compiled range 5.
  const placedTrap = text.match(DEPLOYED_TRAP_RE);
  if (placedTrap) return { range: Number(placedTrap[1]) + Number(placedTrap[2]) };
  text = text.replace(OWN_JUMP_WITHIN_RE, "$1"); // The jump clause: see below. How far a sound carries is not the targeting when the text goes
  // on to print the targeting distance. A scream audible within 300 feet, followed by a save for creatures within
  // 30 feet of the screamer, compiled range 300. Only when another "within N feet" follows: a voice audible within
  // 300 feet that affects creatures able to hear it prints no other distance, and its hearing distance is its range.
  text = text.replace(AUDIBLE_WITHIN_RE, "$1");
  // "within N feet" is a *targeting* clause, so it is read from the part of the action that does
  // the targeting and not from anywhere the number happens to appear. Read over the whole text it
  // took a giant's 120-foot Inhale down to ten feet, off a "within 10 feet" in the regurgitation
  // sentence three sentences later — and a ten-foot Inhale is one the chooser never prefers to a
  // 120-foot Boulder.
  //
  // Everything after the action's first outcome is aftermath, cleanup or a second effect, and the
  // distances there are different quantities: a damage radius, an ejection distance, how far a
  // victim is thrown. The same boundary the size and creature-type readers already use.
  const outcomeAt = [
    text.indexOf("{@h}"),
    text.indexOf("{@actSaveFail"),
    text.search(/\bmust (?:succeed on|make)\b/i),
    text.search(/\bOn a failed save\b/i),
  ].filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? -1;
  // The user's own jump is not the targeting. A creature that jumps to a visible space within 30 feet and then forces a
  // save on each creature in a 5-foot Emanation around it, or one that
  // teleports within 120 feet and then affects each creature within 10 feet of the space it left, compiled the jump's
  // distance as the save's range (30 and 120 ft). The jump's "within N feet" is left out of the targeting text, so
  // the area clause is read (5 and 10 ft).
  const targeting = outcomeAt >= 0 ? text.slice(0, outcomeAt) : text;
  // Three tiers, in this order and for a reason. A "within N feet" in the targeting clause is the
  // action's own range and outranks everything. Failing that, the area the action names is the
  // range. Only when the targeting clause says neither does a "within" from anywhere in the text
  // stand in — which is what keeps a swallow action, whose prose gives no distance at all, at the
  // ten feet it has always had. Preferring every area over every "within" would be the opposite
  // error to the one being fixed.
  const within = targeting.match(/within\s+(\d+)\s+feet/i);
  if (within) return { range: Number(within[1]) };
  // An area centred on a spot whose distance is given as "up to N feet away" is thrown N feet, and its radius is not
  // the range. A bomb thrown 60 feet that bursts into a 10-foot-radius sphere of gas,
  // compiled range 10. Read in the targeting clause only, and only for a point: "pushed up to 10 feet away" is an
  // outcome.
  const thrown = targeting.match(THROWN_POINT_RE) ?? targeting.match(THROWN_OBJECT_RE);
  if (thrown) return { range: Number(thrown[1]) };
  const area = text.match(/(\d+)-foot(?:-long)?(?:,\s*\d+-foot-wide)?\s+\{@variantrule\s+(?:Cone|Line|Cube|Emanation|Sphere)/i);
  if (area) return { range: Number(area[1]) };
  const legacyArea = text.match(/(\d+)-foot(?:-long)?(?:,\s*\d+-foot-wide)?(?:-radius)?\s+(?:cone|line|cube|emanation|sphere|cylinder)/i);
  if (legacyArea) return { range: Number(legacyArea[1]) };
  const anyWithin = text.match(/within\s+(\d+)\s+feet/i);
  if (anyWithin) return { range: Number(anyWithin[1]) };
  return {};
}

// A save or auto-hit option whose target is bounded by the
// creature's own body (one creature in the creature's space, one creature it touches in its space, one creature
// directly underneath it) states no distance, and fell to the engine's 120-ft default: such a creature
// drained from 30 ft. Read from the targeting clause only (before the action's first outcome), after `parseRange`
// finds nothing. The range is contact, 5 ft (the separation floor for a pair that cannot share a space; the hold
// finishers' `contactRange`).
function targetingClause(text: string): string {
  const outcomeAt = [
    text.indexOf("{@h}"),
    text.indexOf("{@actSaveFail"),
    text.search(/\bmust (?:succeed on|make)\b/i),
    text.search(/\bOn a failed save\b/i),
  ].filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? -1;
  return outcomeAt >= 0 ? text.slice(0, outcomeAt) : text;
}

const OWN_SPACE_TARGET_RE = /\b(?:in|inside) (?:its|his|her|their|the [\w' -]+?'s|[A-Z][\w' -]+?'s) space\b|\btouches one creature\b|\bdirectly underneath\b/;

// A bounded line target: a line given as N feet long and M feet
// wide (a line 60 feet long and 10 feet wide, or 100 by 5). The area readers in `parseRange` know only "60-foot line"; a line's
// length is its reach. Only a line shorter than the engine's 120-ft default is read here (the family's bound); a longer
// one (a 300-ft line) is not read here.
const SHORT_LINE_TARGET_RE = /\bline (?:that is )?(\d+) feet long\b/i;

// A bounded self-area: an area around the creature itself (a radius centered on itself, a cloud
// of spores that extends out from the creature, or light shed in a 30-foot radius). With no point or target named elsewhere (`parseRange` found no "within"), the radius is the reach.
// Only a radius said to be centred on or to extend from the creature, or "in a N-foot radius": a radius placed elsewhere
// (a 10-foot-radius column up to 120 feet away) is not the reach.
const SELF_AREA_TARGET_RE = /\b(\d+)-foot[- ]radius\b[^.]*?(?:\bcentered on (?:it|itself|him|her|himself|herself|them|themselves)\b|\bextends out from\b|\bon itself\b)|\bin a (\d+)-foot radius\b/i;

function boundedTargetRange(text: string): number | undefined {
  const targeting = targetingClause(text);
  if (OWN_SPACE_TARGET_RE.test(targeting)) return 5;
  const line = targeting.match(SHORT_LINE_TARGET_RE);
  if (line && Number(line[1]) < 120) return Number(line[1]);
  const radius = targeting.match(SELF_AREA_TARGET_RE);
  const radiusFeet = radius ? Number(radius[1] ?? radius[2]) : undefined;
  if (radiusFeet !== undefined && radiusFeet < 120) return radiusFeet;
  return undefined;
}

const sizeRanks: Record<string, number> = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4, gargantuan: 5 };
const creatureTypes = [
  "aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey",
  "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead",
];

/** The size cap that opens a run-up sentence ahead of its extra damage (see `parseDamage`). */
const RUN_UP_SIZE_CAP_RE = /^\s*If (?:the )?target is (?:an? )?(Tiny|Small|Medium|Large|Huge|Gargantuan) or smaller(?: creature)? and\b/i;

/**
 * The run-up printed as moved 20+ feet straight toward the target immediately before the hit (or immediately
 * before she hit): the gate takes `requiresMovementImmediate`, and only the first attack after the
 * approach carries it. The older trait wording (close 20 feet or more in a line on a creature, then hit it that same
 * turn; a trait, read in `compile.ts`) does not.
 */
const IMMEDIATE_RUN_UP_RE = /\bimmediately\s+before\s+(?:the\s+hit|(?:she|he|it|they)\s+hits?)\b/i;

export function targetMaxSize(text: string): number | undefined {
  const match = text.match(/\b(Tiny|Small|Medium|Large|Huge|Gargantuan) or smaller\b/i);
  return match ? sizeRanks[match[1].toLowerCase()] : undefined;
}

function targetDescriptorMaxSize(text: string): number | undefined {
  const outcomeAt = [text.indexOf("{@h}"), text.indexOf("{@actSaveFail")]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0] ?? text.length;
  const descriptor = text.slice(0, outcomeAt);
  const match = descriptor.match(/\b(Tiny|Small|Medium|Large|Huge|Gargantuan) or smaller (?:creature|target)\b/i)
    || descriptor.match(/\b(?:creature|target)\b[^.;]{0,60}\b(Tiny|Small|Medium|Large|Huge|Gargantuan) or smaller\b/i);
  if (match) return sizeRanks[match[1].toLowerCase()];
  // A listed-size target descriptor: a descriptor that lists its sizes (two sizes joined by "or", before "creature"),
  // such as Medium or Small, or Small or Tiny. The cap is the
  // largest size listed. Only "one <sizes> creature | target" in the descriptor: size words about the attacker are not it.
  const listed = descriptor.match(LISTED_SIZE_TARGET_RE);
  return listed ? Math.max(...listed.slice(1).filter(Boolean).map((size) => sizeRanks[size.toLowerCase()])) : undefined;
}

/**
 * An own-size cap: a target descriptor that caps the target by the user's own size (a target
 * no larger than the creature). The parser does not know the block's size, so this only
 * says the print carries the cap; `compileMonster` sets `targetMaxSize` to the block's own size. Only "one target |
 * creature of <the user's | its> size or smaller" in the descriptor, before the outcome.
 */
const OWN_SIZE_TARGET_RE = /\bone (?:target|creature) of (?:the [a-z][a-z' -]*?'s|its|his|her|their) size or smaller\b/i;

export function targetCappedAtOwnSize(text: string): boolean {
  const outcomeAt = [text.indexOf("{@h}"), text.indexOf("{@actSaveFail")]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0] ?? text.length;
  return OWN_SIZE_TARGET_RE.test(text.slice(0, outcomeAt));
}

/**
 * A rider own-size cap: the same cap printed after the outcome, on
 * the condition alone (a Grappled condition with an escape DC that applies only if the target is no larger than the creature).
 * Returns the conditions
 * so capped; `compileMonster` sets those riders' `targetMaxSize` to the block's own size. The damage is not capped.
 */
const OWN_SIZE_RIDER_RE = /\bIf the target is (?:the [a-z][a-z' -]*?'s|its|his|her|their) size or smaller, it has the \{@condition ([A-Za-z]+)/g;

export function ridersCappedAtOwnSize(text: string): string[] {
  return [...text.matchAll(OWN_SIZE_RIDER_RE)].map((match) => match[1].toLowerCase());
}

const LISTED_SIZE_TARGET_RE =/\bone (Tiny|Small|Medium|Large|Huge|Gargantuan)(?:,| or) (?:(Tiny|Small|Medium|Large|Huge|Gargantuan),? or )?(Tiny|Small|Medium|Large|Huge|Gargantuan) (?:creature|target)\b/i;

/**
 * An option that moves the creature through or into the spaces of
 * "<Size> or smaller creatures" and affects each creature whose space it enters reaches only those: a Gelatinous Cube's
 * Engulf, which lets it move through the spaces of Large or smaller creatures, and a similar stride that lets a creature
 * enter the spaces of Medium and smaller creatures. The plural "creatures" escaped `targetDescriptorMaxSize`, so a Large
 * cube engulfed a Huge giant.
 */
function moveThroughMaxSize(text: string): number | undefined {
  if (!/\bwhose space\b|\benters a creature's space\b/i.test(text)) return undefined;
  const match = text.match(/\b(?:move through the spaces of|enter) (Tiny|Small|Medium|Large|Huge|Gargantuan) (?:or|and) smaller creatures\b/i);
  return match ? sizeRanks[match[1].toLowerCase()] : undefined;
}

/**
 * A jump into the target's own space: "spends 5 feet of movement to jump to a space within 15 feet that contains one or
 * more Large or smaller creatures". The creature ends there, so the effect is delivered from beside its target and a
 * push "straight away from" it starts there.
 */
const JUMP_TO_TARGET_RE = /\bspends (\d+) feet of movement to jump to a space within \d+ feet that contains one or more (?:(Tiny|Small|Medium|Large|Huge|Gargantuan) or smaller )?creatures\b/i;

function jumpToTarget(text: string): { cost: number } | undefined {
  const match = text.match(JUMP_TO_TARGET_RE);
  return match ? { cost: Number(match[1]) } : undefined;
}

function jumpDestinationMaxSize(text: string): number | undefined {
  const size = text.match(JUMP_TO_TARGET_RE)?.[2];
  return size ? sizeRanks[size.toLowerCase()] : undefined;
}

/** The destination of a jump: an unoccupied space the creature can see, or a space it can see. */
const JUMP_SPACE_SIGHT_RE = /\bspace (?:it|he|she|they|you|the [a-z-]+) can see\b/gi;

const SIGHT_RE = /\bcan see\b|\bthat (?:it|you|the \w+) sees\b/i;
/**
 * "A point <it> can see": sight of a place, not of the creature there. A sphere
 * centered on a point the creature can see was refused against an
 * invisible foe. "Points at" is a gesture, and a clause that names a creature or target before "can see" is sight of it.
 */
const POINT_SIGHT_RE = /\bpoints?\b(?! at\b)(?:(?!creature|target)[^.]){0,70}?\bcan see\b/gi;
/**
 * A magic item it can see is sight of the item, not of the target: an attack that lets the creature pick a magic item
 * in the target's possession names no sight of the creature it hits, and the item's suppression
 * is not compiled. The clause is taken out of the test, as the jump's landing space is (`JUMP_SPACE_SIGHT_RE`).
 */
const ITEM_SIGHT_RE = /\bmagic items? (?:it|he|she|they|the [a-z-]+) can see\b/gi;
/**
 * A second creature the effect passes to, seen near the target: lightning that arcs onward to a second creature of the
 * user's choice that lies within 30 feet of the target and in its sight, or to another creature in its sight lying
 * within 10 feet of the target. The creature named is not the target
 * (a duel has no second foe), so its sight is not the option's gate: the clause is taken out of the test, as the item's
 * is.
 */
const SECOND_CREATURE_SIGHT_RE = /\bcreatures?\b[^.]{0,70}?\bcan see within \d+ (?:feet|ft\.) of the (?:first )?target\b/gi;
/**
 * A destination space or an area of ground the source can see is sight of a place, as a point is: a fling to a
 * space it can see, a tentacle attack that moves a target to an unoccupied space the creature can see, a teleport,
 * a patch of ground, 20 feet square, within its sight. It compiles the point gate, not `false`:
 * a Blinded source cannot see the space either. A creature the source must see elsewhere in the print keeps the creature
 * gate. Case-sensitive, so a name is read only capitalised.
 */
const PLACE_SIGHT_RE = /\b(?:[Ss]pace (?:that )?|area of ground )(?:it|he|she|they|you|the [a-z'-]+(?: [a-z'-]+)?|[A-Z][a-z'-]+) can see\b/g;
/**
 * The target's sight of the source is not the source's sight of the target: a ghostly gaze that hits each creature in
 * a 60-foot Cone able to see the creature, a bite hitting each creature within 10 feet able to
 * see the user, or a creature able to see her. The clause is taken out of the source's gate, as the
 * item's and the second creature's are; a clause naming the target as the one seeing is not read, and a "<source> can see" clause elsewhere in
 * the print keeps the gate. The target-side gate (`requiresTargetMissingConditions`, the Blinded
 * exemption) is read elsewhere and is untouched.
 */
const TARGET_SEES_SOURCE_RE = /\b(?:that|who) can see (?!the target\b)(?:the [a-z][a-z' -]*?|it|him|her|them|[A-Z][a-z]+)(?=[\s,.;:)]|$)(?! (?:can|within)\b)/g;
/** The recipient of the source's own benefit, not a target: a creature the source picks, which it can see, gains an effect. */
const SIGHT_BENEFIT_RE = /\bcreature of (?:its|his|her|their) choice (?:it|he|she|they) can see gains\b/gi;

/**
 * The option's sight gate: `true` (the source sees the target), `"point"` (every sight clause names a point, so the
 * source sees the place: its own Blindness and senses count, the foe's invisibility does not), or `false`.
 */
function requiresSight(printed: string): boolean | "point" {
  const text = printed.replace(ITEM_SIGHT_RE, " ").replace(SECOND_CREATURE_SIGHT_RE, " ").replace(TARGET_SEES_SOURCE_RE, " ");
  if (!SIGHT_RE.test(text)) return false;
  if (!new RegExp(POINT_SIGHT_RE.source, "i").test(text) && !new RegExp(PLACE_SIGHT_RE.source).test(text)) return true;
  return SIGHT_RE.test(text.replace(POINT_SIGHT_RE, " ").replace(PLACE_SIGHT_RE, " ").replace(SIGHT_BENEFIT_RE, " ")) ? true : "point";
}

/** Two sight gates on one action: the creature gate is the stricter (sight of the foe implies sight of its place). */
function stricterSight(a: boolean | "point" | undefined, b: boolean | "point" | undefined): boolean | "point" {
  if (a === true || b === true) return true;
  return a === "point" || b === "point" ? "point" : false;
}

function explicitTargetTypes(text: string): string[] | undefined {
  const outcomeAt = [text.indexOf("{@h}"), text.indexOf("{@actSaveFail"), text.indexOf("{@damage"), text.search(/\bOn a failed save\b/i)]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0] ?? text.length;
  const descriptor = text.slice(0, outcomeAt);
  const typePattern = creatureTypes.join("|");
  const typedGroups = [
    // A condition may sit between the quantifier and the type (an incapacitated Humanoid
    // held by the creature), which used to break the match and cost the action
    // its type restriction entirely, so a brain-extraction attack worked on creatures with no brain.
    // A name or pronoun may sit between the type and "can see" (a Humanoid the creature can see, or one she
    // can see). The lookahead refused it, so those charms and a possession effect locked any foe.
    ...descriptor.matchAll(new RegExp(
      `\\b(?:one|an?|each|every|any|all|up to (?:one|two|three|four|\\d+))\\s+(?:\\{@condition\\s+[^}]*\\}\\s+)*(?:willing\\s+)?((?:${typePattern})s?(?:\\s*(?:,|and|or)\\s*(?:${typePattern})s?)*)\\b(?=\\s*(?:,|\\.|and|or|within|in|that|who|the|it|can|must|\\{|$|[\\w']+\\s+can see\\b))`,
      "gi",
    )),
    ...descriptor.matchAll(new RegExp(
      `\\b((?:${typePattern})s?(?:\\s*(?:,|and|or)\\s*(?:${typePattern})s?)+)\\s+(?:within|in|that|who)\\b`,
      "gi",
    )),
  ];
  const indexed = typedGroups.flatMap((match) => {
    const prefix = descriptor.slice(Math.max(0, (match.index || 0) - 40), match.index || 0);
    if (/\b(?:isn't|aren't|is not|are not|other than|except|excluding)\b[^.;]{0,60}$/i.test(prefix)
      || /\bautomatically\b[^.;]{0,60}$/i.test(prefix)) return [];
    return creatureTypes
      .filter((type) => new RegExp(`\\b${type}s?\\b`, "i").test(match[1]))
      .map((type) => ({ type, index: (match.index || 0) + match[0].toLowerCase().indexOf(type) }));
  });
  for (const match of descriptor.matchAll(new RegExp(
    `\\b(?:target|creature)\\s+(?:must be|is)\\s+(?:an?\\s+)?(${typePattern})\\b`,
    "gi",
  ))) {
    indexed.push({ type: match[1].toLowerCase(), index: match.index || 0 });
  }
  const types = [...new Map(indexed.sort((a, b) => a.index - b.index).map((item) => [item.type, item])).values()]
    .map(({ type }) => type);
  return types.length ? types : undefined;
}

/** A parenthetical saying certain kinds automatically succeed on the save: the kinds, when each is a tag and not a creature type. */
function autoSucceedTags(text: string): string[] | undefined {
  // Also the 2024 parenthesis in the targeting clause: "each creature in a 20-foot Emanation ... (demons succeed automatically)".
  const kind = (text.match(/\b([a-z]+?)s automatically succeed on this sav(?:e|ing throw)\b/i)
    ?? text.match(/\(([a-z]+?)s succeed automatically\)/i))?.[1]?.toLowerCase();
  if (!kind || creatureTypes.includes(kind)) return undefined;
  return [kind];
}

function explicitExcludedTargetTypes(text: string): string[] | undefined {
  const outcomeAt = [text.indexOf("{@h}"), text.indexOf("{@actSaveFail"), text.search(/\bOn a failed save\b/i)]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0] ?? text.length;
  const descriptor = text.slice(0, outcomeAt);
  const types = creatureTypes.filter((type) =>
    new RegExp(`\\b(?:isn't|is not|other than|except)\\s+(?:an?\\s+)?(?:[^.;]{0,40}\\bor\\s+)?(?:an?\\s+)?${type}\\b`, "i").test(descriptor)
    || new RegExp(`\\b${type}s?\\b[^).;]{0,80}\\bautomatically succeed\\b`, "i").test(text)
    || new RegExp(`\\b${type}s?\\b[^).;]{0,80}\\bsucceed automatically\\b`, "i").test(text)
    || new RegExp(`\\b(?:succeeds?|succeed) automatically if [^).;]{0,80}\\b${type}\\b`, "i").test(text)
    // A list of creature types that succeed on the save automatically (Constructs, Oozes, Plants and Undead).
    || new RegExp(`\\b${type}s?\\b[^).;]{0,80}\\bsucceed on (?:the|this) (?:save|saving throw) automatically\\b`, "i").test(text)
    || immuneTypeListTypes(text).includes(type)
  );
  return types.length ? types : undefined;
}

/**
 * Two more wordings of a whole-action type exclusion, read only when every item in the list is a creature type: a
 * sentence of its own giving Constructs and Undead immunity to the effect,
 * and one saying a ray does nothing to Constructs and Undead. A list with anything else in it is not
 * read: a list naming a subtype such as devils is not read, and its "this effect" can refer to a
 * soul in the sentence before, not the attack.
 */
function immuneTypeListTypes(text: string): string[] {
  const typePattern = creatureTypes.join("|");
  const list = `(?:${typePattern})s?(?:\\s*,\\s*(?:and\\s+|or\\s+)?(?:${typePattern})s?|\\s+(?:and|or)\\s+(?:${typePattern})s?)*`;
  const found: string[] = [];
  for (const match of [
    ...text.matchAll(new RegExp(`(?:^|[.!:]\\s+)(${list})\\s+are immune to this effect\\s*\\.`, "gi")),
    ...text.matchAll(new RegExp(`\\b(?:has|have) no effect on (${list})\\s*\\.`, "gi")),
  ]) {
    for (const type of creatureTypes) if (new RegExp(`\\b${type}s?\\b`, "i").test(match[1])) found.push(type);
  }
  return found;
}

const PROSE_SAVE_RE = /(?:must\s+(?:also\s+|each\s+)?(?:make|succeed on)|makes?)\s+(?:a\s+)?\{@dc\s+\d+\}\s+[A-Za-z]+\s+saving throw/i;

/**
 * The span of an action's text that says *who it targets*, as opposed to what happens to them.
 *
 * Newer stat blocks lead with the saving throw, then name the target (a creature, 5
 * feet away at most, that is Grappled), then give the failure outcome, so treating the first `{@actSave` as
 * the boundary left the descriptor *empty*, and every newer finisher silently lost its
 * prerequisite: a creature would extract a brain from a creature it had never grappled. The
 * leading save header describes the effect, not the target, so it is skipped rather than treated
 * as a boundary. A save that appears later still is one, because it introduces a new effect.
 */
const SAVE_HEADER_RE = /^\s*\{@actSave\s+[a-z]{3}\}\s*\{@dc\s+\d+\}/i;

function targetDescriptor(text: string, extraBoundary?: RegExp): string {
  const saveHeader = text.match(SAVE_HEADER_RE);
  const rest = text.slice(saveHeader ? saveHeader[0].length : 0);
  const marks = [
    rest.indexOf("{@h}"),
    rest.indexOf("{@actSaveFail"),
    rest.indexOf("{@actSaveSuccess"),
    saveHeader ? -1 : rest.indexOf("{@actSave"),
    // The legacy prose spelling of {@actSaveFail}. Without it, a failure sentence in the older
    // prose ("the creature ... is Blinded") read as a demand that the
    // target be Blinded already.
    rest.search(/\bOn a (?:failed|successful) save\b/i),
    extraBoundary ? rest.search(extraBoundary) : -1,
    // A later sentence that opens with "If" or "While" is about what happens once the action has
    // landed: a dinosaur's hit-then-swallowed text, with being Blinded while swallowed,
    // made being Blinded a condition of being swallowed, because the only other boundary in that
    // text is a regurgitation save three sentences on.
    rest.search(/(?<=\.\s+)(?:If|While)\b/),
  ].filter((n) => n >= 0);
  // With no outcome marker at all — a plain prose action such as the toad's Swallow — the whole
  // text would otherwise read as one long descriptor, and the *consequences* of being swallowed
  // ("has the Blinded and Restrained conditions") would become prerequisites for swallowing.
  // Whoever the action targets is named in its opening sentence.
  if (!marks.length) {
    const sentenceEnd = rest.search(/\.\s+[A-Z]/);
    return sentenceEnd >= 0 ? rest.slice(0, sentenceEnd) : rest;
  }
  return rest.slice(0, Math.min(...marks));
}

/**
 * A condition tag in the targeting span that is not a demand on the target. Each of these made an
 * action wait for a state nothing else on its creature could produce, so it was never used:
 *
 * - an outcome: a fling that throws a grappled creature and knocks it Prone, and a sphere
 *   whose creatures end up with the Blinded and Deafened conditions. A "has the" that follows a relative
 *   ("that has the", "who has the") or a
 *   condition ("if the target has the") is still a prerequisite; a main clause is not.
 * - a duration: a minute-long effect that also stops if the creature becomes Incapacitated.
 * - the attack itself: an eye that emits an Invisible, magical ray.
 */
function isOutcomeOrDescription(descriptor: string, tag: { index: number; end: number }): boolean {
  const before = descriptor.slice(Math.max(0, tag.index - 200), tag.index);
  if (/\buntil\b[^.,;]{0,60}$/i.test(before)) return true;
  if (/^,?\s+(?:magical\s+)?(?:ray|beam)\b/i.test(descriptor.slice(tag.end, tag.end + 30))) return true;
  return isOutcomeTag(descriptor, tag);
}

/** The outcome half of `isOutcomeOrDescription`: a state the action puts on its target. */
function isOutcomeTag(text: string, tag: { index: number }): boolean {
  const before = text.slice(Math.max(0, tag.index - 200), tag.index);
  if (/\b(?:knocked|becomes?)\s+$/i.test(before)) return true;
  const clause = before.split(/[.;,:]/).pop() || "";
  return /\b(?:has|have)\s+the\s+(?:\{@condition\s+[^}]*\}\s+(?:and|or)\s+)?$/i.test(clause)
    && !/\b(?:that|who|which|if|when|while|unless|until|whose)\b/i.test(clause);
}

/** "…that isn't Grappled", "…without the Prone condition": the tag is a *forbidden* state. */
const NEGATED_PREFIX_RE = /\b(?:not|isn't|is not|aren't|doesn't have|does not have|without)\s+(?:be\s+|have\s+)?(?:the\s+)?$/i;

/**
 * A prerequisite worded as the target having a named condition, the newer spelling.
 * The parser already understood the older wording in which the target simply is in that condition; without this
 * one, a giant's every ranged hit inflicted a permanent, save-less Frightened, and another
 * creature handed out permanent Charmed and Stunned together.
 */
const PREREQUISITE_HAS_RE = /\b(?:if|when|while|unless|until)\s+(?:the |an? )?[^,.;]{1,100}\s+(?:has|have|had)\s+(?:the\s+)?$/i;

/** A prerequisite that the target is already in some condition X, at the end of a lower-cased sentence prefix, with no other tag after X. */
const ALREADY_IS_RE = /\bif (?:the |an? )?(?:target|creature) is already \{@condition\s+([^}|]+)[^}]*\}[^.;{]*$/i;

/** The condition that a clause saying the target has condition X makes its sentence depend on. */
const DEPENDS_ON_RE = /\b(?:if|when|while)\s+(?:the |an? )?(?:target|creature|it)\s+(?:already\s+)?(?:has|have)\s+the\s+\{@condition\s+([^}|]+)/i;

export interface TargetPrerequisites {
  /** Every one of these must be present. */
  all: string[];
  /** At least one of these must be present. */
  any: string[];
  /** None of these may be present. */
  missing: string[];
}

function targetPrerequisites(text: string): TargetPrerequisites {
  const descriptor = targetDescriptor(text, PROSE_SAVE_RE);
  // The noun may be "creature" or the creature *type* itself (an incapacitated Humanoid
  // held by the creature). Requiring the literal word dropped the prerequisite from every
  // type-targeted finisher, so a brain-extracting creature extracted brains from anything, at any time, for
  // 10d10, including creatures that have no brain.
  const targetNoun = new RegExp(
    `\\b(?:one|an?|the|each|every|any|two|three|four|up to)\\b[^.]{0,180}\\b(?:creatures?|${creatureTypes.map((type) => `${type}s?`).join("|")})\\b`,
    "i",
  );
  const tags = findTags(descriptor, "condition")
    .filter((tag) => targetNoun.test(descriptor.slice(Math.max(0, tag.index - 180), tag.end + 40)))
    // "{@hit 5} (with Advantage if the target is Grappled by the ankheg)" qualifies the attack
    // roll, not the choice of target: the ankheg bites whoever it likes and merely bites better
    // at a target it already holds. Reading it as a requirement disarmed the creature entirely.
    .filter((tag) => !/\b(?:with|has)\s+(?:\{@variantrule\s+)?(?:Advantage|Disadvantage)\b[^)]{0,120}$/i
      .test(descriptor.slice(Math.max(0, tag.index - 160), tag.index)))
    .filter((tag) => !isOutcomeOrDescription(descriptor, tag));
  const negated = (tag: typeof tags[number]) => NEGATED_PREFIX_RE.test(descriptor.slice(Math.max(0, tag.index - 40), tag.index));
  const missing = [...new Set(tags.filter(negated).map((tag) => tagName(tag.body).toLowerCase()))];
  const present = tags.filter((tag) => !negated(tag));
  const names = [...new Set(present.map((tag) => tagName(tag.body).toLowerCase()))];
  // A target that is Incapacitated, or one the creature is grappling (the wording is a clause about each):
  // the hold is written out rather than tagged, and is the other way in. Read as Incapacitated
  // alone, the option waited for a state its companion attack never gives.
  if (names.length && /\bor\s+(?:that\s+)?(?:it|the [\w'’ -]{1,30}) is grappling\b/i.test(descriptor)) {
    return { all: [], any: [...new Set([...names, "grappled"])], missing };
  }
  if (names.length < 2) return { all: names, any: [], missing };
  // A list of alternatives (Grappled, Incapacitated, or Restrained) differs from a conjunction (an Incapacitated creature
  // held by <name>). What sits between the tags is what tells them apart.
  const between = descriptor.slice(present[0].end, present[present.length - 1].index);
  return /\bor\b/i.test(between) ? { all: [], any: names, missing } : { all: names, any: [], missing };
}

/**
 * Conditions whose prerequisite implies the target is already in contact with the attacker.
 * Restrained is deliberately absent: a web or a zone holds a creature at whatever distance it
 * was caught, so a restrained prerequisite says nothing about how far away the attacker is.
 */
const CONTACT_PREREQUISITES = new Set(["grappled", "swallowed", "attached"]);

/**
 * An effect that lands as a condition this creature applied ends: a creature picks any set of foes it can
 * see that are Charmed by it, and each takes psychic damage as that Charmed condition ends. The condition named is
 * a prerequisite (`requiresTargetCondition`, which the engine reads against
 * conditions this source applied), not a rider: compiled as a rider, the option charmed a foe a prior attack had missed, with
 * no save and no end. The end itself needs no field: the only charm the creature applies lasts until the
 * start of its next turn, and the option is a Legendary action taken after the foe's turn, so no foe turn falls between
 * the damage and the charm's own end.
 */
function endedOwnCondition(text: string): string | undefined {
  const match = text.match(/\bas the \{@condition\s+([^}|]+)[^}]*\} condition applied by [^.]{1,40}? ends on (?:it|the target|them)\b/i);
  return match ? tagName(match[1]).toLowerCase() : undefined;
}

/**
 * A save the print spares a target that cannot see its source: each creature in an area must make a save unless it
 * is Blinded, and the
 * newer save header's target clause naming creatures in a 30-foot radius with line of sight to the source. Compiled as
 * `requiresTargetMissingConditions: ["blinded"]`, which the engine
 * reads against a Blinded this creature applied: a creature's own follow-up attack or smother can blind its target.
 * Ungated, such a creature frightened a foe its own smother had wrapped blind. `requiresSight` (the user sees the target) is left as it was.
 * The older print has the same clause on a save with no attack: foes
 * within 60 feet who can see the creature must make a Wisdom save, a creature in bright
 * light able to see the user, or one able to see her. A print with an attack roll or a hit is
 * left out: there the clause gates a rider behind the hit, and this gate is the whole
 * action's.
 */
const BLINDED_EXEMPT_SAVE_RE = /\bsaving throw if it doesn['’]t have the \{@condition blinded\b/i;
const SEEING_TARGET_HEADER_RE = /\{@actSave [a-z]{3}\} \{@dc \d+\},[^.]*?\bthat can see the [a-z]/i;
const SEEING_TARGET_OLD_PRINT_RE = /\b(?:that can see|able to see) (?:it|her|him|the [a-z]+)\b[^.]{0,60}?\bmust succeed on a \{@dc/i;
const ATTACK_OR_HIT_RE = /\{@atkr? |\{@h\}/;
function unseeingTargetExempt(text: string): boolean {
  return BLINDED_EXEMPT_SAVE_RE.test(text) || SEEING_TARGET_HEADER_RE.test(text.split("{@actSaveFail}")[0])
    || !ATTACK_OR_HIT_RE.test(text) && SEEING_TARGET_OLD_PRINT_RE.test(text);
}

function requiredTargetCondition(text: string, prerequisites: TargetPrerequisites): string | undefined {
  // A large-creature finisher: a target held by the creature itself, named in the print.
  // Not the cap on how many it can hold: "can have only one creature Grappled by this action at a time" names no target.
  const match = text.match(/(?<!\bonly )one [^.]*?creature\s+\{@condition\s+([^}|]+)[^}]*\}\s+by (?:the )?[a-z -]+/i);
  if (match) return tagName(match[1]).toLowerCase();
  // Amphibian-style swallow: a target the creature is grappling.
  if (/target it is grappling|creature it is grappling/i.test(text)) return "grappled";
  // A hold-target gate that was dropped: the same hold with another subject, read in the targeting span
  // (a creature of limited size that a plant is grappling, or a target an aspect of the creature holds). Ungated, the option landed on a foe that had
  // escaped the grapple. An Advantage clause is not a gate: a bite that has advantage against a held creature
  // still bites anyone.
  const heldBy = targetDescriptor(text).match(/\b(?:an? |the )?(?:target|creature) (?:he|she|they|the [a-z][a-z' -]{0,30}) is grappling\b/i);
  if (heldBy?.index !== undefined
    && !/\badvantage (?:on [^.()]{0,40})?against\s*$/i.test(targetDescriptor(text).slice(0, heldBy.index))) return "grappled";
  // Read in the targeting span only: a tentacle's text ends with a clause about what happens when the creature dies
  // (it lets go of whatever it is holding), which is not whom it attacks.
  if (/creature (?:it|the [a-z -]+) is (?:physically )?attached to/i.test(targetDescriptor(text))) return "attached";
  // Modern save blocks often put the save tag before the target descriptor,
  // then a Humanoid that is cursed by an item of the creature.
  // Limit this check to the targeting header so an effect that applies a curse is
  // not mistaken for requiring one.
  const targetHeaderEnd = [text.indexOf("{@h}"), text.indexOf("{@actSaveFail"), text.indexOf("{@actSaveSuccess")]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0] ?? text.length;
  if (/\b(?:target|creature|humanoid)\b[^.;]{0,140}\b(?:that\s+is|that's|is)\s+cursed by\b/i.test(text.slice(0, targetHeaderEnd))) {
    return "cursed";
  }
  // A hag's strike aimed at every creature the hag has cursed that stands within 60 feet of it.
  if (/^\s*each creature cursed by\b/i.test(text)) return "cursed";
  return prerequisites.all[0];
}

/**
 * A non-spell option whose effect the print ends with its user's Concentration: a vortex that lasts as long as its
 * creator maintains concentration (as if concentrating on a spell), a whirlwind that lasts until the creature's
 * Concentration on it ends. The option compiled no `concentration`, so damage to
 * its user, its incapacitation or a second Concentration effect never ended what it held. Set only where the option
 * compiles a lasting rider (something for Concentration to end): a zone with none (a fog or a swarm of crows)
 * would only cost its user another effect. A minute printed in the same sentence (a duration of up to a minute, or a vanishing
 * after a minute) is the Concentration's clock, as a spell's is (`concentrationOf`).
 * The target's Concentration (broken, or its saves) is not read.
 */
const SOURCE_CONCENTRATION_RE = /[^.]*(?:\bas if (?:\{@status concentration[^}]*\}|concentrating) on a spell\b|\buntil [^.]{0,40}(?:'|’)s (?:\{@status concentration[^}]*\}|concentration) (?:on it )?ends\b|\b(?:\{@status concentration[^}]*\}|concentration) ends on it\b)[^.]*/i;
function printedConcentration(text: string, riders: Rider[]): { concentration?: true; concentrationRounds?: number } {
  const sentence = text.match(SOURCE_CONCENTRATION_RE)?.[0];
  // Left out: an option the print re-uses to move its effect (the creature can use the action on later turns to move the
  // vortex, and creatures restrained by it move with it). Each use would start a new Concentration and so end the
  // hold the print keeps: a held creature that then made the new save went free (a known narrowing).
  if (/\bcan use this action to move\b/i.test(text)) return {};
  if (!sentence || !riders.some((rider) => ["untilEscape", "permanent", "saveEndsEachTurn"].includes(rider.duration))) return {};
  return /\b(?:for (?:up to )?|after )1 minute\b/i.test(sentence) ? { concentration: true, concentrationRounds: 10 } : { concentration: true };
}

/**
 * Is damage printed before the save, so that it lands whatever the save does (`onSuccess: "full"`; a psychic hit
 * followed by an Intelligence save, say)? Damage to objects is not the creature's:
 * an area where objects take thunder damage and each creature there must save or take the same thunder
 * damage compiled "full", so a creature that made the
 * save took the damage anyway. A sentence whose subject is objects is left out of the test.
 */
const OBJECTS_DAMAGE_SENTENCE_RE = /(?:^|(?<=[.!?]\s))(?:(?!\bcreatures?\b)[^.])*\bobjects?\b(?:(?!\bcreatures?\b)[^.])*\btakes? \d+ \(\{@damage [^}]+\}\)[^.]*\./gi;
function damagePrintedBeforeSave(text: string, saveAt: number): boolean {
  const before = text.slice(0, saveAt).replace(OBJECTS_DAMAGE_SENTENCE_RE, "");
  return findTags(before, "damage").length > 0 || /\b(?:takes?|deals?)\s+\d+\s+[A-Za-z]+\s+damage\b/i.test(before);
}

function halfOnSuccess(text: string): boolean {
  return /\{@actSaveSuccess\}\s*Half damage|\{@actSaveSuccess\}\s*Half\b|half as much damage on (?:a|the) success|half as much damage on a successful one|on a successful save[^.]{0,100}half as much damage/i.test(text);
}

function instantDeathThreshold(text: string): number | undefined {
  // "…it dies" and "…it drops to 0 Hit Points" are the same execute in a duel. Without the
  // second spelling a sea hag's Death Glare did nothing at all below its own threshold, because
  // the damage clause is gated on being *above* it.
  const threshold = /(?:target|creature)\s+has\s+(\d+)\s+(?:\{@variantrule\s+Hit Points?[^}]*\}|Hit Points?)\s+or fewer,\s+(?:it|the target)\s+(?:dies|drops to 0)/i;
  return Number(text.match(threshold)?.[1]) || undefined;
}

function parseChoiceRiders(text: string): ChoiceRider[] {
  if (!/can choose not to be/i.test(text)) return [];
  const riders: ChoiceRider[] = [];
  for (const tag of findTags(text, "condition")) {
    const condition = tagName(tag.body).toLowerCase();
    if (!impactfulConditions.has(condition)) continue;
    const after = text.slice(tag.end, tag.end + 320);
    if (!new RegExp(`can choose not to be\\s+\\{@condition\\s+${condition}`, "i").test(after)) continue;
    const damage = after.match(/extra\s+(\d+)\s+([A-Za-z]+)\s+damage/i);
    if (!damage) continue;
    riders.push({
      condition,
      duration: conditionDuration(after),
      damage: [{ dice: { n: 0, d: 1, mod: Number(damage[1]) }, type: normalizeDamageType(damage[2]), bypassResistance: /bypasses/i.test(after) }],
    });
  }
  return riders;
}

/**
 * A damage line that gives one value, then a second value gated on a condition, offers an *alternative* value, not an
 * additional one. Summing both sides inflates damage: a hatchling was dealing
 * its anti-object damage to creatures, and six creatures were permanently Enlarged.
 *
 * Returns how to gate the alternative, or `undefined` when the condition cannot be expressed,
 * in which case the caller drops the alternative and keeps the base value. Dropping is the
 * conservative direction: it can understate a creature, never overstate it.
 */
interface AlternativeGate {
  attackerBloodied?: true;
  /** The alternative applies to a Bloodied target (the Blood Hawk's Beak). */
  targetBloodied?: true;
  attackerCondition?: string;
  targetCondition?: string;
  byCreatureType?: true;
  /** The alternative applies when the attack roll had Advantage. */
  attackAdvantage?: true;
  /** Which side the alternative requires to be on the ground. */
  grounded?: "attacker" | "target";
  /** Offset just past the gating phrase, so callers know where the alternative branch ends. */
  end: number;
}

/**
 * A damage clause's own gate on the attacker being Bloodied. Originally only the swarm, attacker or creature as subject, with
 * the `{@status Bloodied}` tag, was read. A later pass reads any subject but the target, and the
 * untagged "Bloodied": extra Necrotic damage when a knight is
 * Bloodied, or a Piercing die when a swarm is Bloodied.
 */
const ATTACKER_BLOODIED_IF = String.raw`if (?:the )?(?:(?!(?:the )?target\b)[a-z][a-z' -]{0,30}? is (?:\{@status Bloodied|Bloodied\b)|(?:swarm|attacker|creature) (?:is at|has) half of its hit points or fewer)`;

const TARGET_HURT = String.raw`(?:the )?target (?:is missing any (?:of its )?hit points|doesn't have all (?:of )?its hit points)`;
/** The clause saying that a target missing any of its hit points instead takes a larger amount, up to the damage tag. */
const TARGET_HURT_INSTEAD_RE = new RegExp(String.raw`\bif ${TARGET_HURT}, it instead takes \d+ \($`, "i");
/** The tail of that clause, from the damage tag's end: piercing damage if the target lacks some of its hit points. */
const TARGET_HURT_AFTER_RE = new RegExp(String.raw`^\)?\s*[A-Za-z]+ damage if ${TARGET_HURT}`, "i");

function alternativeDamageGate(after: string): AlternativeGate | undefined {
  const clause = after.split(".", 1)[0];
  const attempt = (re: RegExp, make: (m: RegExpMatchArray) => Omit<AlternativeGate, "end"> | undefined): AlternativeGate | undefined => {
    const match = clause.match(re);
    if (!match || match.index === undefined) return undefined;
    const gate = make(match);
    return gate ? { ...gate, end: match.index + match[0].length } : undefined;
  };
  // A creature-type alternative (a larger value if the creature is a Giant) keys off
  // targetTypes; the base clause picks up the matching excludedTargetTypes separately.
  return attempt(
    /\bif (?:the )?(?:target|creature) is (?:an? )?([A-Za-z -]+?)(?=[.,]|$)/i,
    (m) => creatureTypes.some((type) => new RegExp(`\\b${type}s?\\b`, "i").test(m[1])) ? { byCreatureType: true } : undefined,
  )
    // A named condition on the target is expressible. So is the target's Bloodied state (the Blood Hawk's "or 6
    // ({@damage 1d8 + 2}) Piercing damage if the target is {@status Bloodied}"): `requiresTargetBloodied`. Before
    // that, no gate read the target's relative health and the alternative
    // was dropped.
    ?? attempt(/\bif (?:the )?target is (?:\{@status Bloodied[^}]*\}|Bloodied\b)/i, () => ({ targetBloodied: true }))
    ?? attempt(/\bif (?:the )?target[^.,]{0,100}\{@condition ([^}|]+)[^.,{}]{0,40}/i,
      (m) => ({ targetCondition: m[1].trim().toLowerCase() }))
    // A condition-qualifier rider: a larger bludgeoning value that applies to a
    // {@condition prone} target. The condition is the alternative's gate.
    ?? attempt(/\bto an? \{@condition ([^}|]+)[^}]*\}\s+(?:target|creature)\b/i,
      (m) => ({ targetCondition: m[1].trim().toLowerCase() }))
    ?? attempt(/\bif [^.,]{0,60}?(?:is \{@status Bloodied[^}]*\}|(?:is at|has) half of (?:its|their) hit points or fewer)/i,
      (m) => /\btarget\b/i.test(m[0]) ? undefined : { attackerBloodied: true })
    ?? attempt(/\bwhile raging\b/i, () => ({ attackerCondition: "raging" }))
    // "...or 18 (4d6 + 4) Piercing damage if the chimera had Advantage on the attack roll."
    ?? attempt(/\bif (?:the )?[a-z][\w' -]{0,40}? had (?:\{@variantrule Advantage[^}]*\}|advantage) on the attack roll\b/i,
      () => ({ attackAdvantage: true }))
    ?? attempt(/\bwhile (?:it is )?under the effect of ([A-Za-z][\w' -]*)/i,
      (m) => ({ attackerCondition: m[1].trim().toLowerCase() }))
    // Now that combat has a vertical axis, "on the ground" is a real state rather than a
    // given. The prose names its own subject — every instance in the data today is the attacker
    // (the creature is on the ground) — so read which side it means instead of assuming.
    ?? attempt(/\b(?:the )?([A-Za-z][\w' -]*?) is on the ground\b/i,
      (m) => ({ grounded: /\b(?:target|creature)$/i.test(m[1].trim()) ? "target" : "attacker" }));
}

/**
 * The victim, however the prose names it: "its", "the target's", "the Poisoned target's", and the
 * plural "their" of a spray (acid or fire) whose failed savers take damage when
 * their turns end. Every
 * other possessive in a per-turn phrase names the creature that inflicted the tick.
 */
const VICTIM_TURN_OWNER = String.raw`their|its|the (?:\{@condition [^}]*\}\s*)?(?:target|creature)'s`;
/**
 * The possessive-noun spelling of the same tick: "at the start of each of the cube's turns".
 * Every swallow, engulf and attach in the data is written this way and none of them were read
 * while the patterns below took only "its" — 26 actions, from the smallest dice to the largest.
 * The noun is the *source*, which is why it is a separate alternative rather than another
 * name for the victim: `ticksOnSourceTurn` below turns that into the half-round it lands on.
 *
 * "each of" and the plural "turns" are both required of this half. The singular
 * form naming the creature's next turn is a one-off deadline rather than a tick, and it is how ten Regeneration
 * traits write their suppression window and how five creatures' delayed effects (petrification,
 * ice, a zombie, a banishment, a contraption) write their delay. The owner-turn emanations are written with the
 * plural and are protected elsewhere: `parseSourceTurnAura` strips the phrase before it reaches
 * `parseDamageClauses`, so widening here cannot take a Fire Aura's damage off it.
 */
const SOURCE_TURN_OWNER = String.raw`(?:the |an? )?[\w'’ -]{1,30}?'s`;
/** Either spelling, for one end of the turn. The victim's alternative is tried first. */
const turnPhrase = (phase: "start" | "end") => String.raw`\bat the ${phase} of `
  + String.raw`(?:(?:each of )?(?:${VICTIM_TURN_OWNER}) turns?|each of (?:${SOURCE_TURN_OWNER}) turns)\b`;
const START_OF_TURN_RE = new RegExp(turnPhrase("start"), "i");
/**
 * The one member of `OTHER_RECURRING_RE` that is a tick of its own rather than a trigger, and so
 * the one that can be re-attached to a rider. Kept separate because "ends its turn there" names a
 * zone the duel has no second creature to stand in, and a repeat save is not damage at all.
 */
const END_OF_TURN_RE = new RegExp(turnPhrase("end"), "i");
const OTHER_RECURRING_RE = new RegExp(
  String.raw`(?:${END_OF_TURN_RE.source}|\bends its turn(?: there| within| inside)|\benters the \w+ for the first time)`,
  "i",
);
/**
 * Whose turn a matched phrase lands on, and so which half-round the tick fires in. The two
 * combatants alternate strictly, so the start of the source's turn is the moment after the end of
 * the victim's, and the end of the source's turn the moment before the start of the victim's: a
 * source-keyed tick belongs on the *opposite* phase, not the same one. Reading a swallow's acid as
 * the victim's own start-of-turn damage would fire it before the victim's first turn inside the
 * gullet — a turn the prose gives it — and before it can try to escape.
 */
const GRIP_DAMAGE_RE = /\bAt the end of (?:the )?[\w' -]+?['’]s turn, it can [^.]*\.\s+In addition, it can choose any number of creatures \{@condition ([^}]+)\} in this way and deal \d+ \(\{@damage ([^}]+)\}\) ([A-Za-z]+) damage to each of them\b/i;

function ticksOnSourceTurn(phrase: string): boolean {
  return !new RegExp(String.raw`^at the (?:start|end) of (?:each of )?(?:${VICTIM_TURN_OWNER})\b`, "i").test(phrase);
}

/**
 * A harpoon's toll for struggling: slashing damage is taken either when the creature breaks free of the
 * grapple or when it tries and fails. Both halves are required, which is what separates it from
 * an ordinary conditional and keeps the pattern to the two creatures that write it.
 */
const ESCAPE_ATTEMPT_DAMAGE_RE = /\bif it escapes\b[^.]{0,80}\bif it tries and fails\b/i;

/**
 * A disease or curse whose effect waits for a day or a rest: Hit Point maximum decreasing by 10 ({@dice 3d6}) once
 * 24 hours pass, a poisoned creature repeating the saving throw each 24 hours and having its hit point
 * maximum reduced by 5 ({@damage 1d10}) on a failure, or a diseased creature rolling a {@dice d6} after each long rest
 * for a table of conditions. No duel lasts a day or reaches a rest, so nothing from the start of the sentence that names
 * the wait to the end of the text is compiled: its dice read as immediate damage, and its conditions as immediate
 * riders. Where the option's text begins, and what it does at once (poison damage and Poisoned, or a curse), is kept.
 */
// Also a Hit Point maximum that decreases by a die roll for every 24 hours that elapse, and a
// repeated save every 24 hours with subsequent failures that lower the maximum by a smaller die: each die compiled
// as untyped damage on the hit.
// Also a target that finishes a Long Rest while {@condition Poisoned} and is then subjected
// to a following effect with a Constitution save, and a target still {@condition Poisoned} after 1 hour that is subjected to a following effect. Each compiled its delayed
// save as the hit's own (see `parseAction`).
const REST_GATE_RE = /\bafter every 24 hours\b|\bevery 24 hours that elapse\b|\beach time the (?:diseased |cursed )?creature finishes a long rest\b|\bwhenever the (?:\{@condition [^}]+\}\s+)?target finishes a (?:\{@variantrule Long Rest[^}]*\}|long rest)|\bremains \{@condition [^}]+\}[^.]{0,30}\bafter 1 hour\b/i;

/** Where a rest- or day-gated effect's sentence starts in `text`, or -1. */
function restGatedFrom(text: string): number {
  const at = text.search(REST_GATE_RE);
  return at < 0 ? -1 : text.lastIndexOf(".", at - 1) + 1;
}

/**
 * Creature types a leading "if the target is a <type>" clause limits an effect to: a ray whose target must be a Humanoid and
 * then save, with incapacitation on a failure, a rider that gives the Stunned condition to an Undead target, and
 * an extra radiant damage clause for a fiend or an undead. Only the trailing form (radiant damage when the
 * target is a Fiend) was read before.
 */
function leadingTypeGate(span: string): string[] | undefined {
  const typePattern = creatureTypes.join("|");
  const match = span.match(new RegExp(
    // The article is optional: a clause that says the target is humanoid (no "a"), then a Charisma save or be
    // charmed.
    `\\bif the (?:target|creature) is (?:an? )?((?:${typePattern})s?(?:,? (?:or |and )?(?:an? )?(?:${typePattern})s?)*)\\b`, "i",
  ));
  if (!match) return undefined;
  const types = creatureTypes.filter((type) => new RegExp(`\\b${type}s?\\b`, "i").test(match[1]));
  return types.length ? types : undefined;
}

const FOLLOWING_EFFECT_GATE_RE = new RegExp(
  `\\bif the (?:target|creature) is (?:an? )?(?:${creatureTypes.join("|")})s?\\b[^.]*?, it(?:'s| is) subjected to the following effect\\b`, "i",
);

/** A rider with no type gate takes one printed before its condition tag, in its own sentence or the one before. */
function withLeadingTypeGates(text: string, riders: Rider[]): Rider[] {
  // A clause that says the target is a Humanoid the creature has not yet cursed, followed by a whole
  // effect (a Charisma save, with a curse and a Poisoned condition on failure). The
  // gate names a whole effect printed after it, several sentences before its riders, so every ungated rider printed after
  // the gate takes it (a rider with no condition tag, such as the curse, is placed by its name).
  const followingGate = text.match(FOLLOWING_EFFECT_GATE_RE);
  const followingTypes = followingGate?.index !== undefined ? leadingTypeGate(followingGate[0]) : undefined;
  for (const rider of riders) {
    if (rider.targetTypes || rider.excludedTargetTypes) continue;
    if (followingTypes) {
      const tagAt = text.search(new RegExp(`\\{@condition ${rider.condition}\\b`, "i"));
      const riderAt = tagAt >= 0 ? tagAt : text.search(new RegExp(`\\b${rider.condition}\\b`, "i"));
      if (riderAt > followingGate!.index!) {
        rider.targetTypes = followingTypes;
        continue;
      }
    }
    const at = text.search(new RegExp(`\\{@condition ${rider.condition}\\b`, "i"));
    if (at < 0) continue;
    const start = text.lastIndexOf(".", text.lastIndexOf(".", at) - 1) + 1;
    const types = leadingTypeGate(text.slice(start, at));
    if (types) rider.targetTypes = types;
  }
  return riders;
}

/**
 * Creature types an effect's own clause rules out (a gate that excludes a Construct and an Undead, say). Read from the
 * clause rather than matched against one spelling, because the data writes the exclusion with one type and with two.
 */
function excludedTypesIn(clause: string): string[] | undefined {
  const match = clause.match(/\bisn't (?:an? )?([A-Za-z]+)(?: or (?:an? )?([A-Za-z]+))?\b/i);
  if (!match) return undefined;
  const types = [match[1], match[2]].filter(Boolean).map((t) => t!.toLowerCase());
  return types.length ? types : undefined;
}

/**
 * States a per-turn tick can hang on. A tick lasts as long as whatever the prose says it lasts as
 * long as — "until the grapple ends", "while wounded" — and these are the conditions that express
 * one; the first rider carrying any of them takes it, and an action with none falls back to its
 * first rider. The synthetic wound and burning states are the only rider their action has.
 */
const HOLDER_CONDITIONS = ["swallowed", "frightened", "restrained", "grappled", "wound", "burning"];

/**
 * Does the recurring-damage phrasing in this sentence govern the damage value at `offset`?
 *
 * Position matters in both directions. A trailing phrase qualifies only the values introduced
 * by the verb nearest to it: a sentence that deals one immediate hit and then says the target starts burning for a
 * smaller tick each turn is one hit plus one tick, so
 * treating the whole sentence as recurring erased a creature's blast. A
 * *leading* phrase instead lists the triggers on which the damage applies (each creature in
 * an area when it appears or when it ends its turn there, then the damage), and that
 * damage is immediate.
 */
function recurringScope(sentence: string, offset: number): "startOfTurn" | "other" | undefined {
  for (const [re, kind] of [[START_OF_TURN_RE, "startOfTurn"], [OTHER_RECURRING_RE, "other"]] as const) {
    const phrase = sentence.match(re);
    if (!phrase || phrase.index === undefined || offset > phrase.index) continue;
    const introducer = [...sentence.slice(0, phrase.index).matchAll(/\b(?:tak(?:es|ing)|deals?|suffers?)\b/gi)].at(-1);
    if (!introducer || offset > introducer.index!) return kind;
  }
  return undefined;
}

/** `recurringScope` for a tag at a known position, on the sentence that encloses it. */
function recurringScopeAt(text: string, index: number, end: number): "startOfTurn" | "other" | undefined {
  const start = text.lastIndexOf(".", index - 1) + 1;
  const stop = text.indexOf(".", end) < 0 ? text.length : text.indexOf(".", end);
  return recurringScope(text.slice(start, stop), index - start);
}

/** The tail of a die that is a roll penalty ("subtracts 3 ({@dice 1d6}) from its damage rolls"), read after the tag. */
export const ROLL_PENALTY_AFTER_RE = /^\)?\s*from (?:its|their|the target's) (?:damage|attack) rolls\b/i;
/** The same penalty, anywhere in an option's text, for the skip line. */
// A save failed by a margin (a print that says a failure by 5 or more adds an effect): the condition it gives is a
// rarer, separate tier that is not modelled (`parseRiders` drops it). One wording of the margin
// was already dropped; this is the other, and compile
// records a skip line for it.
export const FAIL_MARGIN_RE = /\bfails? (?:the save|the saving throw|it) by \d+ or more\b/i;

/** Every margin marker: the 2024 `{@actSaveFailBy 5}`, the "fails by 5 or more" wording with the save as subject, and `FAIL_MARGIN_RE`'s wording. */
const MARGIN_MARKER_RE = /\{@actSaveFailBy\s+(\d+)\}|\bsaving throw fails by (\d+) or more\b|\bfails? (?:the save|the saving throw|it) by (\d+) or more\b/i;
/**
 * Where a print that states its margin tier first resumes the base tier: a print opening with "Otherwise" and then
 * naming the failed save, in either of two phrasings.
 */
export const BASE_TIER_RESUMES_RE = /\.\s+Otherwise,\s+(?:on a failed save|a creature that fails the save)\b/i;

/** What a save-margin tier adds (`Rider.saveFailMargin`, `SaveAction.marginDamage`). */
export interface SaveMarginTier {
  margin: number;
  /** The tier's own riders, each gated on the margin. */
  riders: Rider[];
  /** The tier replaces the base tier ("instead", "Otherwise", the 2024 separate tier): the base riders go below the gate. */
  replacesBase: boolean;
  /** The tier's damage where it replaces the base damage (a print that says "instead" and gives a new amount); none when the base damage is printed only in the "Otherwise" tier. */
  damage?: DamageClause[];
}

/**
 * The save-margin tier of an action or aura. `baseRiders` are the riders the base tier compiled (a "while poisoned" or
 * "for the same duration" tier links to one of them); `save` is the save that governs the tier.
 */
export function parseSaveMarginTier(text: string, baseRiders: readonly Rider[], save: { ability: Ability; dc: number } | undefined): SaveMarginTier | undefined {
  const marker = text.match(MARGIN_MARKER_RE);
  if (!marker || marker.index === undefined) return undefined;
  const margin = Number(marker[1] ?? marker[2] ?? marker[3]);
  const from = marker.index + marker[0].length;
  const tagged = marker[1] !== undefined;
  const rest = text.slice(from);
  const resumes = rest.search(BASE_TIER_RESUMES_RE);
  // The 2024 tier runs to the next outcome tag; a prose tier is the marker's sentence.
  const nextOutcome = rest.search(/\{@actSave/);
  const sentenceEnd = rest.search(/\.(?:\s|$)/);
  const end = tagged
    ? (nextOutcome >= 0 ? nextOutcome : rest.length)
    : resumes >= 0 ? resumes + 1 : sentenceEnd >= 0 ? sentenceEnd + 1 : rest.length;
  const tier = rest.slice(0, end);
  const sentenceOf = (index: number): string => {
    const start = tier.lastIndexOf(".", index - 1) + 1;
    const stop = tier.indexOf(".", index);
    return tier.slice(start, stop < 0 ? tier.length : stop);
  };
  const tags = findTags(tier, "condition").map((tag) => ({
    tag,
    name: tagName(tag.body).toLowerCase(),
    // "while {@condition poisoned}" names the condition the tier depends on, not one it gives.
    link: /\bwhile\s*$/i.test(tier.slice(Math.max(0, tag.index - 8), tag.index)),
    // An "unless" clause that names an immunity to the frightened condition is an exemption, not an effect.
    exempt: /\bimmune to (?:the )?$/i.test(tier.slice(Math.max(0, tag.index - 20), tag.index)),
  }));
  const endsOnDamage = /\b(?:regains consciousness|wakes up|ends early) if (?:it|the target) takes (?:any )?damage\b/i.test(rest);
  const riders: Rider[] = [];
  for (const { tag, name, link, exempt } of tags) {
    if (link || exempt || !impactfulConditions.has(name) || riders.some((rider) => rider.condition === name)) continue;
    const sentence = sentenceOf(tag.index);
    const untagged = sentence.match(/\bwhile ([a-z]+)(?: in)? this way\b/i)?.[1].toLowerCase();
    const linked = tags.find((other) => other.link && sentenceOf(other.tag.index) === sentence)?.name
      ?? (untagged && impactfulConditions.has(untagged) ? untagged : undefined);
    // A Poisoned condition for an hour with an Unconscious condition that lasts only while poisoned this way: the link is the
    // Unconscious's, not the Poisoned's own.
    const linkName = linked === name ? undefined : linked;
    const parentName = linkName ?? (/\bfor the same duration\b/i.test(sentence) ? baseRiders.find((rider) => rider.save)?.condition : undefined);
    const parent = parentName
      ? [...riders].reverse().find((rider) => rider.condition === parentName) ?? [...baseRiders].reverse().find((rider) => rider.condition === parentName)
      : undefined;
    const duration: Rider["duration"] = parent
      ? parent.duration
      : /\buntil the end of its next turn\b/i.test(sentence) ? "endOfTargetNextTurn"
        : /\brepeats? the saving throw at the end of each of its turns\b/i.test(tier) ? "saveEndsEachTurn"
          : "permanent";
    const riderSave = parent?.save ?? save;
    riders.push({
      condition: name,
      ...(riderSave ? { save: { ...riderSave } } : {}),
      duration,
      ...(parent ? { requiresTargetCondition: parent.condition } : {}),
      ...(name === "unconscious" && endsOnDamage ? { endsOnDamage: true } : {}),
      saveFailMargin: margin,
    });
  }
  const instead = tier.match(/\binstead takes (\d+) ([a-z]+) damage\b/i);
  const damageTags = findTags(text, "damage").map((tag) => tag.index);
  const resumeAt = resumes >= 0 ? from + resumes : -1;
  const damage: DamageClause[] | undefined = instead
    ? [{ dice: { n: 0, d: 1, mod: Number(instead[1]) }, type: normalizeDamageType(instead[2].toLowerCase()) }]
    : resumeAt >= 0 && damageTags.length && damageTags.every((index) => index > resumeAt) ? [] : undefined;
  if (!riders.length && !damage) return undefined;
  // The tier's riders are built here, outside the base riders' chain, so
  // "for 1 minute" printed in the tier never reached `withMinuteClock` (a bite: Poisoned for 1 minute, and
  // Unconscious while Poisoned). The clock reads the tier's own text and riders only: a rider that depends on a base
  // rider (an Unconscious tied to the base Poisoned) keeps what it had.
  withMinuteClock(tier, riders);
  return { margin, riders, replacesBase: tagged || resumeAt >= 0 || !!instead, damage };
}

/** An attack's or save action's riders and damage with its save-margin tier (`parseSaveMarginTier`). */
function withSaveMarginTier<A extends CombatAction>(text: string, action: A): A {
  if (action.kind !== "attack" && action.kind !== "save") return action;
  const save = action.kind === "save" ? { ability: action.ability, dc: action.dc } : action.riders.find((rider) => rider.save)?.save;
  if (!save) return action;
  const tier = parseSaveMarginTier(text, action.riders, save);
  if (!tier) return action;
  const base = tier.replacesBase
    ? action.riders.map((rider) => rider.appliesOnSuccess ? rider : { ...rider, saveFailMarginBelow: tier.margin })
    : action.riders;
  const out = { ...action, riders: [...base, ...tier.riders] };
  if (out.kind === "save" && tier.damage && out.damage.length) out.marginDamage = { margin: tier.margin, damage: tier.damage };
  return out;
}

/** Does this action compile a save-margin tier? */
export function hasSaveMarginTier(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.some(hasSaveMarginTier);
  if (action.kind === "save" && action.marginDamage) return true;
  return "riders" in action && !!action.riders?.some((rider) => rider.saveFailMargin !== undefined);
}

/** A die followed by a unit of time ("{@dice 1d4} hours") counts time, not damage. */
const TIME_UNIT_AFTER_RE = /^\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|rounds?)\b/i;

/** Directly after a `{@dice}` tag: the die picks what the roller does, or counts an item's charges (selection-dice-as-damage). */
const SELECTION_DIE_AFTER_RE = /^\s*(?:to determine\b|charges?\b)/i;

export const ROLL_PENALTY_RE =/\bsubtracts?\b[^.]*\bfrom (?:its|their|the target.s) (?:damage|attack) rolls\b/i;

/** A heal gated on the option's own damage (the print says the creature regains hit points provided some creature suffers that damage). */
const DAMAGE_GATED_HEAL_RE = /\bif (?:at least one creature|any creature|a creature|the target) takes? (?:this|that|the) damage\b[^.]{0,80}\bregains?\b/i;

export function parseDamageClauses(text: string): DamageClause[] {
  const out: DamageClause[] = [];
  // A few modern attacks mix fixed and rolled components, for example
  // "{@h}1 Piercing damage plus 3 ({@damage 1d6}) Necrotic damage."
  // The fixed component is real damage, not the displayed average of a following
  // dice tag (which is separated by parentheses), so retain it alongside the tags.
  const fixedHit = text.match(/\{@h\}\s*(\d+)\s+([A-Za-z]+)\s+damage\b/i);
  if (fixedHit) {
    out.push({
      dice: { n: 0, d: 1, mod: Number(fixedHit[1]) },
      type: normalizeDamageType(fixedHit[2]),
    });
  }
  // An alternative branch can restate several values at once (a second damage value joined by "plus"
  // and gated on a spell effect), so the branch is a span,
  // not just the one value after "or". It ends where its gating phrase ends, which keeps a
  // trailing universal addition (a final "plus" damage clause) out of the branch.
  const altMarker = text.match(/(?:,\s*|\s+)or\s+\d+\s*(?:\(|[A-Za-z]+\s+damage\b)/i);
  const altStart = altMarker?.index ?? -1;
  const altGate = altStart >= 0 ? alternativeDamageGate(text.slice(altStart)) : undefined;
  const altEnd = altGate ? altStart + altGate.end : -1;
  // An alternative whose gate no field expresses (an "or" damage value plus a second "plus" value, gated on
  // the creature's size) is dropped as a span too. Only the
  // value directly after "or" was dropped; the second value fell outside any span and landed on every hit beside
  // the base damage. The span runs from the "or" to the alternative's own "if / while / when" in the same sentence.
  const ungatedAltIf = altStart >= 0 && !altGate ? text.slice(altStart).split(".", 1)[0].search(/\b(?:if|while|when)\b/i) : -1;
  const ungatedAltEnd = ungatedAltIf >= 0 ? altStart + ungatedAltIf : -1;
  const deferredClauses = new Set<DamageClause>();
  let previousDamageEnd = 0;
  let delayedSentenceEnd = -1;
  const restGate = restGatedFrom(text);
  for (const tag of findTags(text, "damage")) {
    if (restGate >= 0 && tag.index >= restGate) continue;
    try {
      const after = text.slice(tag.end, tag.end + 240);
      const afterUntilNextDamage = after.split("{@damage", 1)[0];
      let sincePreviousDamage = text.slice(previousDamageEnd, tag.index);
      previousDamageEnd = tag.end;
      // A persistent-zone setup can mention when the zone expires before describing its
      // immediate appearance damage. Treat an intervening "when ... appears" sentence as
      // a new event boundary so the expiry sentence doesn't incorrectly suppress that hit.
      const immediateEvent = [...sincePreviousDamage.matchAll(/\bwhen\b[^.]{0,120}\b(?:appears?|begins?|forms?|is created)\b/gi)].at(-1);
      if (immediateEvent?.index !== undefined) sincePreviousDamage = sincePreviousDamage.slice(immediateEvent.index);
      // Periodic damage belongs to a lasting rider, not the initial hit.
      if (tag.index < delayedSentenceEnd) continue;
      if (/damage at the start of/i.test(afterUntilNextDamage)) continue;
      // Damage that follows a natural-20 gate lands only on that roll. Some fiends' and medusa-like creatures'
      // weapon attacks decapitate on a 20, and deal "an extra"
      // 6d8 / 8d6 only to a target immune to that; read as a plain clause, it landed on every hit.
      // The engine has no roll-gated damage, so leave it out rather than add it to every hit.
      if (/\b(?:rolled|rolls|roll of) (?:a |an )?(?:natural )?20\b/i.test(sincePreviousDamage)) continue;
      const before = text.slice(Math.max(0, tag.index - 280), tag.index);
      const sentenceBefore = text.slice(text.lastIndexOf(".", tag.index - 1) + 1, tag.index);
      // Recurring damage is described at sentence scope, and the trigger phrase can sit after
      // several damage values (two damage values followed by "at the start of each of its turns").
      // Checking only the text around one tag caught the last
      // value and let the earlier ones through as immediate damage, so a fire wall and
      // a constrict attack counted their ongoing damage twice. Judge the whole sentence.
      const recurringSentenceEnd = text.indexOf(".", tag.end) < 0 ? text.length : text.indexOf(".", tag.end);
      const sentenceStart = text.lastIndexOf(".", tag.index - 1) + 1;
      const wholeSentence = text.slice(sentenceStart, recurringSentenceEnd);
      const recurring = recurringScope(wholeSentence, tag.index - sentenceStart);
      // Start-of-turn damage is re-attached below as a rider's startTurnDamage, so it must
      // never also land as an immediate hit (a naga-like constrict, a smother).
      if (recurring === "startOfTurn") continue;
      // Other recurring phrasings are carried by no rider, so defer rather than drop: a zone
      // whose *only* damage is worded that way would otherwise vanish from the creature.
      const deferred = recurring === "other";
      // Damage assigned only to objects/structures is not damage to the combat target.
      if (/\b(?:objects?|structures?)\b[^.]{0,100}\b(?:take|takes)\s+\d+\s*\(\s*$/i.test(sentenceBefore)) continue;
      // Collision damage is contingent on a push actually hitting an obstacle; the abstract
      // 1v1 field does not guarantee one, so don't frontload it into the primary effect.
      if (/\bif\b[^.]{0,140}\bcollides?\b/i.test(sentenceBefore)
        || /for every \d+ feet (?:it|the target) was (?:thrown|pushed)/i.test(afterUntilNextDamage)) continue;
      // The price of a later escape attempt is not part of the hit that opened the grapple.
      // Both harpoons in the data write it the same way (slashing damage when the creature gets
      // free or when it tries and fails), and read as a second clause on
      // the attack it gave each of them a free 1d10 on every shot, landing whether or not the
      // victim ever tried to get out. `parseRiders` re-attaches it to the hold below.
      if (ESCAPE_ATTEMPT_DAMAGE_RE.test(afterUntilNextDamage)) continue;
      if (/\bat (?:the )?(?:start|end) of [^.]{0,100}turn/i.test(sincePreviousDamage)) {
        delayedSentenceEnd = text.indexOf(".", tag.end);
        if (delayedSentenceEnd < 0) delayedSentenceEnd = text.length;
        continue;
      }
      // Versatile/dual-mode weapon values are alternatives, not additive damage. Until
      // attack modes carry distinct damage profiles, retain the generally applicable first value.
      if (/\bor\s+\d+\s*\(\s*$/.test(before) && /(?:if|when) used with two hands/i.test(afterUntilNextDamage)) continue;
      const clause: DamageClause = { dice: parseDice(tagName(tag.body)), type: normalizeDamageType(damageTypeAfter(text, tag.end)) };
      // "<base>, or <this> <condition>" replaces the preceding value rather than adding to it.
      // Fall through afterwards so the alternative still picks up the shared clause
      // enrichment below (healsAttacker, reducesMaxHp, creature-type gates, ...).
      const startsAlternative = /\bor\s+(?:\d+\s*)?\(\s*$/.test(before);
      if (!startsAlternative && tag.index > altStart && tag.index < ungatedAltEnd) continue; // A further value of that span
      if (startsAlternative || (altStart >= 0 && tag.index > altStart && tag.index < altEnd)) {
        const gate = startsAlternative ? (alternativeDamageGate(afterUntilNextDamage) ?? altGate) : altGate;
        if (!gate) {
          // A base damage value, then "or" and a larger value of the same type if the creature
          // moved some distance straight toward the target just before the hit. The charge value replaces the base, and
          // no clause field says "only without the run-up", so the alternative compiles as the difference (2d4 in one case; for a
          // "1, or 2 (1d4)" pair, 1d4 - 1) on an extra clause gated by the run-up: base plus difference is the printed
          // charge value on every roll. A difference that is not a dice expression (2d6 + 2 against
          // 2d8 + 2) keeps the base value only.
          const runUp = startsAlternative
            ? afterUntilNextDamage.match(/^\)?\s*[A-Za-z]+\s+damage\s+if\s+(?!the\s+target\b)(?:the\s+[a-z' -]{1,30}?|it|he|she)\s+(?:moved|flew)\s+(?:(?:at )?least\s+)?(\d+)\+?\s+feet\b[^.]{0,40}\btoward\s+(?:the\s+target|it)\b/i)
            : null;
          const charged = out.at(-1);
          const gated = (c: DamageClause) => Object.keys(c).some((key) => key !== "dice" && key !== "type");
          if (runUp && charged && out.length === 1 && !gated(charged) && charged.type === clause.type
            && clause.dice.n > charged.dice.n && (charged.dice.n === 0 || charged.dice.d === clause.dice.d)) {
            out.push({
              dice: { n: clause.dice.n - charged.dice.n, d: clause.dice.d, mod: clause.dice.mod - charged.dice.mod },
              type: clause.type,
              requiresMovement: Number(runUp[1]),
              ...(IMMEDIATE_RUN_UP_RE.test(afterUntilNextDamage.split(".", 1)[0]) ? { requiresMovementImmediate: true as const } : {}),
            });
          } else if (runUp && charged && out.length === 1 && !gated(charged) && charged.type === clause.type) {
            // No dice difference (2d6 + 2 against 2d8 + 2, the Giant Seahorse's Ram): the base value applies only
            // without the run-up (`requiresNoRunUp`) and the charge value only with it.
            const immediate = IMMEDIATE_RUN_UP_RE.test(afterUntilNextDamage.split(".", 1)[0]) ? { requiresMovementImmediate: true as const } : {};
            Object.assign(charged, { requiresNoRunUp: Number(runUp[1]), ...immediate });
            out.push({ ...clause, requiresMovement: Number(runUp[1]), ...immediate });
          }
          continue; // otherwise an unmodelable condition: keep the base value only
        }
        const base = out.at(-1);
        // An alternative that restates only the amount (an "or" followed by a number and a gate on a prone target) is the base's damage type.
        if (base && gate.targetCondition && clause.type === "untyped" && startsAlternative) clause.type = base.type;
        const replaceable = base && base.type === clause.type
          && base.requiresAttackerBloodied === undefined && base.requiresAttackerCondition === undefined
          && base.requiresTargetCondition === undefined && base.requiresGrounded === undefined;
        if (gate.grounded) {
          clause.requiresGrounded = gate.grounded;
          if (replaceable) base.requiresAirborne = gate.grounded;
        } else if (gate.attackerBloodied) {
          clause.requiresAttackerBloodied = true;
          if (replaceable) base.requiresAttackerNotBloodied = true;
        } else if (gate.attackerCondition) {
          clause.requiresAttackerCondition = gate.attackerCondition;
          if (replaceable) base.requiresAttackerMissingCondition = gate.attackerCondition;
        } else if (gate.targetCondition) {
          clause.requiresTargetCondition = gate.targetCondition;
          if (replaceable) base.requiresTargetMissingCondition = gate.targetCondition;
        } else if (gate.attackAdvantage) {
          clause.requiresAttackAdvantage = true;
          if (replaceable) base.requiresAttackNoAdvantage = true;
        } else if (gate.targetBloodied) {
          clause.requiresTargetBloodied = true;
          if (replaceable) base.requiresTargetNotBloodied = true;
        }
      }
      const whileCondition = afterUntilNextDamage.match(/\bwhile\s+(?:the [a-z -]+\s+is\s+)?([a-z]+)\b/i)?.[1]?.toLowerCase();
      if (whileCondition === "raging") clause.requiresAttackerCondition = "raging";
      const conditionBefore = before.match(/if (?:the )?target[^.]{0,120}\{@condition\s+([^}|]+)/i);
      const conditionAfter = afterUntilNextDamage.match(/damage if (?:the )?target[^.]{0,100}\{@condition\s+([^}|]+)/i);
      const required = conditionAfter?.[1] || (/\bextra\b/i.test(before.slice(-100)) ? conditionBefore?.[1] : undefined);
      // A target that is already Frightened takes a different damage amount "instead".
      // The 2024 wording instead says the target takes an additional amount if it already has the Frightened condition: the
      // same gate, with no "extra" for the reader above.
      const alreadyBefore = sentenceBefore.match(/\bif (?:the )?(?:target|creature) (?:is already|already has the) \{@condition\s+([^}|]+)[^}]*\}[^.{]*$/i)?.[1];
      if (required) clause.requiresTargetCondition = tagName(required).toLowerCase();
      else if (alreadyBefore) clause.requiresTargetCondition = tagName(alreadyBefore).toLowerCase();
      if (/\bif the attack was made with \{@variantrule Advantage\b/i.test(afterUntilNextDamage)
        || /\bif the attack (?:roll )?had (?:advantage\b|\{@variantrule Advantage\b)/i.test(afterUntilNextDamage)) {
        clause.requiresAttackAdvantage = true;
      }
      // Two more prints of the same gate. One adds a "plus" damage value if the
      // creature had Advantage on the attack roll, and the other puts the gate ahead of the
      // damage (an "if the attack roll has advantage" opener). Ungated, both landed
      // the extra dice on every hit.
      if (/\bdamage,? if (?:the [a-z' -]{1,30}?|it|he|she) had (?:advantage\b|\{@variantrule Advantage\b[^}]*\}) on the attack roll\b/i.test(afterUntilNextDamage)
        || /\bIf the attack roll (?:has|had) (?:advantage\b|\{@variantrule Advantage\b[^}]*\}), the target (?:also )?takes[^.{]*\($/i.test(sentenceBefore)) {
        clause.requiresAttackAdvantage = true;
      }
      // A clause gated on the target missing any Hit Points.
      // One print says that a target missing any of its hit points "instead" takes a larger necrotic amount: the
      // value replaces the base damage, so the one ungated clause of the
      // same type read before it applies only to a target with all its Hit Points. Ungated, every hit dealt both.
      // Another print adds damage of its own with "plus", gated on the target not having all its hit points: added damage with the
      // same gate.
      if (TARGET_HURT_INSTEAD_RE.test(sentenceBefore)) {
        const replaced = out.at(-1);
        if (replaced && out.length === 1 && replaced.type === clause.type && Object.keys(replaced).every((key) => key === "dice" || key === "type")) {
          clause.requiresTargetHurt = true;
          replaced.requiresTargetUnhurt = true;
        }
      } else if (TARGET_HURT_AFTER_RE.test(afterUntilNextDamage)) {
        clause.requiresTargetHurt = true;
      }
      const hpThreshold = text.slice(Math.max(0, tag.index - 420), tag.index).match(
        /(?:target|creature)\s+has\s+(\d+)\s+(?:\{@variantrule\s+Hit Points?[^}]*\}|Hit Points?)\s+or fewer[\s\S]{0,360}\bOtherwise\b/i,
      );
      if (hpThreshold) clause.requiresTargetHpAbove = Number(hpThreshold[1]);
      // A creature-type condition belongs to this damage clause only when it is in the
      // same sentence (extra radiant damage gated on a fiendish or undead target). A later
      // sentence often gates a curse/rider while the base weapon damage remains universal.
      const sameDamageSentence = afterUntilNextDamage.split(".", 1)[0];
      const typeCondition = sameDamageSentence.match(
        /\bdamage\b[^.]{0,100}\bif (?:the )?(?:target|creature) is (?:an? )?([A-Za-z -]+)$/i,
      )?.[1] || "";
      const clauseTargetTypes = creatureTypes.filter((type) => new RegExp(`\\b${type}s?\\b`, "i").test(typeCondition));
      if (clauseTargetTypes.length) clause.targetTypes = clauseTargetTypes;
      else {
        const leading = leadingTypeGate(sentenceBefore);
        if (leading) clause.targetTypes = leading;
      }
      // 2024 blocks write the run-up as a distance with a plus sign; 2014 blocks write "at least" and then the distance. Only
      // the first was read, so every legacy charger added its charge die to *every* hit with no
      // run-up at all: a gore or stomp attack carried a free extra die.
      // A flying creature's bite adds extra damage if it flew some distance toward
      // the target immediately before the hit (one print drops the word "at"). The same run-up gate as "moved": the
      // engine counts feet closed, by any speed.
      const movement = before.match(/(?:moved|flew)\s+(?:(?:at )?least\s+)?(\d+)\+?\s+feet[^.]{0,140}$/i);
      if (movement && /\bextra\b/i.test(before.slice(-100))) {
        clause.requiresMovement = Number(movement[1]);
        if (IMMEDIATE_RUN_UP_RE.test(movement[0])) clause.requiresMovementImmediate = true;
        // A size cap that opens the sentence (a clause that says if the target is a given size or smaller and the creature moved
        // some feet straight toward it immediately before the hit, the target takes extra Piercing damage and has the Prone
        // condition), joined to the run-up by "and", governs the extra damage as well as the Prone. A cap printed after
        // the damage (extra Bludgeoning damage and then a size cap on the Prone condition) governs
        // the Prone or the save only, and is not read.
        const cap = sentenceBefore.match(RUN_UP_SIZE_CAP_RE);
        if (cap) clause.targetMaxSize = sizeRanks[cap[1].toLowerCase()];
      }
      if (new RegExp(ATTACKER_BLOODIED_IF, "i").test(afterUntilNextDamage)) {
        clause.requiresAttackerBloodied = true;
      }

      // The first side of a "base damage, or alternate damage if X" sentence applies only while X is false.
      const nextDamageAt = after.indexOf("{@damage");
      const followingDamageAt = nextDamageAt >= 0 ? after.indexOf("{@damage", nextDamageAt + 1) : -1;
      const alternateWindow = followingDamageAt >= 0 ? after.slice(0, followingDamageAt) : after;
      const alternate = alternateWindow.match(/(?:—|-|,)?\s*or\b[^.]{0,180}\{@damage[^}]+\}[^.]{0,120}if (?:the )?target[^.]{0,80}\{@condition\s+([^}|]+)/i);
      if (alternate) clause.requiresTargetMissingCondition = tagName(alternate[1]).toLowerCase();
      if (/(?:—|-|,)?\s*or\b[^.]{0,180}\{@damage[^}]+\}[^.]{0,120}\bwhile raging\b/i.test(alternateWindow)) {
        clause.requiresAttackerMissingCondition = "raging";
      }
      if (new RegExp(String.raw`(?:—|-|,)?\s*or\b[^.]{0,180}\{@damage[^}]+\}[^.]{0,140}` + ATTACKER_BLOODIED_IF, "i").test(alternateWindow)) {
        clause.requiresAttackerNotBloodied = true;
      }
      const alternateTypeCondition = alternateWindow.match(
        /(?:—|-|,)?\s*or\b[^.]{0,180}\{@damage[^}]+\}[^.]{0,120}\bdamage\b[^.]{0,80}\bif (?:the )?(?:target|creature) is (?:an? )?([A-Za-z -]+?)(?:\.|$)/i,
      )?.[1] || "";
      const alternateTypes = creatureTypes.filter((type) => new RegExp(`\\b${type}s?\\b`, "i").test(alternateTypeCondition));
      if (alternateTypes.length) clause.excludedTargetTypes = alternateTypes;
      if (deferred) deferredClauses.add(clause);
      out.push(clause);
    } catch {
      // ignored by caller coverage
    }
  }
  // Recurring damage only counts as an immediate hit when nothing else does.
  if (deferredClauses.size && out.some((clause) => !deferredClauses.has(clause))) {
    return out.filter((clause) => !deferredClauses.has(clause));
  }
  // Some data sources tag attack damage as {@dice ...} instead of {@damage ...}.
  // Recurring damage is excluded here for the same reason it is above: an infernal wound's
  // "loses 5 ({@dice 1d10}) Hit Points" at the top of each of its turns is a tick, and read as
  // an immediate value it gave a glaive attack one extra die on the hit that opened the
  // wound and nothing thereafter.
  if (!out.length) {
    for (const tag of findTags(text, "dice")) {
      if (restGate >= 0 && tag.index >= restGate) continue;
      if (recurringScopeAt(text, tag.index, tag.end)) continue;
      // A roll penalty is not damage: the gold dragons' Weakening Breath ("subtracts 3 ({@dice 1d6})
      // from its damage rolls") and one named character's toxic wave compiled the die as untyped damage.
      // The engine models no roll penalty; `compileMonster` records the skip line.
      if (ROLL_PENALTY_AFTER_RE.test(text.slice(tag.end, tag.end + 60))) continue;
      // A die that counts time is not damage. A die for hours of a stench, one for years of aging,
      // and one for hours before a trapped target dies each compiled that die as untyped damage.
      if (TIME_UNIT_AFTER_RE.test(text.slice(tag.end, tag.end + 20))) continue;
      // A die that selects behaviour or counts charges is not damage. A die rolled to determine
      // what the target does on its next turn, and one that sets how many charges a target loses, each compiled that
      // die as untyped damage.
      if (SELECTION_DIE_AFTER_RE.test(text.slice(tag.end, tag.end + 20))) continue;
      try {
        out.push({ dice: parseDice(tagName(tag.body)), type: normalizeDamageType(damageTypeAfter(text, tag.end)) });
      } catch {
        // ignored by caller coverage
      }
    }
  }
  // Some legacy stat blocks leave fixed damage untagged ("takes 45 radiant damage").
  if (!out.length) {
    const flat = text.match(/\b(?:takes?|deals?)\s+(\d+)\s+([A-Za-z]+)\s+damage\b/i);
    if (flat) out.push({ dice: { n: 0, d: 1, mod: Number(flat[1]) }, type: normalizeDamageType(flat[2]) });
  }
  const maxReduction = text.match(/(?:hit points?|(?:\{@variantrule\s+Hit Points?[^}]*\})) maximum (?:is reduced|decreases) by an amount equal to (?:the )?([A-Za-z]+)?\s*damage (?:taken|dealt)/i);
  if (maxReduction) {
    const type = maxReduction[1]?.toLowerCase();
    for (const clause of out) {
      if (!type || clause.type === type) {
        clause.reducesMaxHp = true;
        const following = text.slice(maxReduction.index! + maxReduction[0].length, maxReduction.index! + maxReduction[0].length + 220);
        if (/\b(?:attacker|it|he|she|[A-Z][A-Za-z' -]+) regains?[^.]{0,100}(?:equal to that amount|equal to the damage)/i.test(following)) {
          clause.healsAttacker = true;
        }
      }
    }
  }
  // Life-drain wording is independent of maximum-HP reduction. Equal-damage healing
  // applies to every damage clause; fixed healing is attached once to avoid duplication.
  if (/\b(?:it|the [a-z][a-z' -]+|[A-Z][A-Za-z' -]+) regains? hit points equal to (?:the amount of )?(?:damage|the damage) (?:dealt|taken)\b/i.test(text)) {
    for (const clause of out) clause.healsAttacker = true;
  } else {
    // The heal printed with its dice (a "regains N (dice) hit points" clause), and with a second
    // possible recipient (the creature's name, or a creature of its choosing 60 feet away or closer, then regains dice-valued hit
    // points; in a duel the only other creature is the foe, and the subject pattern, case-insensitive, already reads
    // the trailing "of her then"). The printed average is the amount, as for the flat form.
    const fixedHealing = text.match(/\b(?:it|the [a-z][a-z' -]+|[A-Z][A-Za-z' -]+) regains?\s+(\d+)(?:\s*\(\{@dice [^}]+\}\))?\s+(?:\{@variantrule\s+Hit Points?[^}]*\}|hit points?)\b/i);
    // A heal of another creature is not the attacker's: a "second creature" that regains hit points, or a group of
    // creatures that each regain hit points.
    const otherRecipient = fixedHealing && /\b(?:second creature|these creatures|allies|each ally)\b/i.test(fixedHealing[0]);
    if (fixedHealing && !otherRecipient && out.length) out[0].healsAttackerFlat = Number(fixedHealing[1]);
  }
  const choiceText = text.match(/damage of a type[^.:]*:\s*([^.]+)/i)?.[1]
    || text.match(/((?:Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Poison|Psychic|Radiant|Thunder)(?:\s*(?:,|or)\s*(?:Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Poison|Psychic|Radiant|Thunder))+)\s+damage\b/i)?.[1]
    // Choice wordings the two readings above missed, leaving the clause untyped (so no resistance or immunity applied):
    // a type chosen by the creature, followed by a type list (a "particular damage type" colon and four types), and a
    // list with ", or" or with piercing and slashing (a four-type list ending in "or Psychic damage",
    // "piercing or slashing damage"). After "damage type:" the list must start with a type: a rolled type (roll a die
    // to determine the damage type, each number mapped to a type) is not a choice.
    || text.match(/\bof a type of [^.:]{0,30}\bchoice:\s*([^.]+)/i)?.[1]
    || text.match(new RegExp(`\\bdamage type:\\s*((?:${damageTypes.join("|")})\\b[^.]*)`, "i"))?.[1]
    || text.match(new RegExp(`\\b((?:${damageTypes.join("|")})(?:,? (?:or )?(?:${damageTypes.join("|")}))+) damage\\b`, "i"))?.[1]
    // Conjure Elemental's element list, each element with its type in brackets: "Choose the spirit's element, which
    // determines its damage type: air (Lightning), earth (Thunder), fire (Fire), or water (Cold)".
    || text.match(new RegExp(`\\bdamage type:\\s*((?:[a-z]+ \\((?:${damageTypes.join("|")})\\)(?:,? (?:or )?)?)+)`, "i"))?.[1];
  const typeChoices = choiceText
    ? [...new Set(choiceText.toLowerCase().match(new RegExp(`\\b(?:${damageTypes.join("|")})\\b`, "g")) || [])]
    : [];
  if (typeChoices.length > 1) {
    for (const clause of out.filter((item) => item.type === "untyped")) clause.typeChoices = typeChoices;
  }
  // Same-dice clauses that name two damage types joined by "or" (Radiant or Necrotic) are one choice, not two hits.
  if (out.length === 2
    && out[0].dice.n === out[1].dice.n && out[0].dice.d === out[1].dice.d && out[0].dice.mod === out[1].dice.mod
    && out[0].type !== out[1].type
    && /\bdamage\b[^.]{0,100}\bor\s+\{@damage/i.test(text)) {
    return [{ ...out[0], typeChoices: [out[0].type, out[1].type] }];
  }
  // A fixed addition with no dice: "{@h}3 ({@damage 1d4 + 1}) Slashing damage plus 1 Necrotic damage." A number followed
  // by a parenthesis is the displayed average of a dice tag, which the loop above has read.
  for (const fixed of text.matchAll(/\bdamage plus (\d+) ([A-Za-z]+) damage\b/gi)) {
    out.push({ dice: { n: 0, d: 1, mod: Number(fixed[1]) }, type: normalizeDamageType(fixed[2]) });
  }
  return out;
}

/**
 * How a held creature gets loose, when the stat block spells it out as something other than the
 * "(escape {@dc N})" shorthand. Two shapes are covered:
 *
 * - an **ability check** as an action (a Strength check that bursts the webbing), which is the
 *   shorthand written the long way;
 * - a **destructible restraint** (held until the web is destroyed, with its own AC and HP) is not one of these: the
 *   print gives no check, and `parseBreakable` compiles the object for the held creature to attack;
 * - **an action spent removing it** (pulling the weapon out of the victim), which always succeeds
 *   and so costs only the action.
 *
 * A swallowed creature's escape from the corpse after the swallower dies is deliberately not one of
 * these: it is not an exit available while the fight is going on.
 */
/**
 * An attached creature taken off as an action, with no check printed: "The target or a creature within 5 feet of it can
 * detach the stirge as an action", or any creature, including the target, using its action to detach the attacker.
 */
const ACTION_DETACH_RE = /\bcan detach (?:it|the [\w'’ -]{1,40}?) as an action\b|\bcan use (?:its|an) action to detach\b/i;

/** The escape check printed with Disadvantage, in the hold's own parenthesis or in a sentence after it. */
const ESCAPE_DISADVANTAGE_RE = /\(escape\s+\{@dc\s+\d+\},?\s+with\s+disadvantage\)|\bability checks made to escape (?:this|the) grapple have (?:\{@variantrule\s+)?disadvantage\b/i;

/** "AC 10; HP 5; Vulnerability to Fire damage; Immunity to Bludgeoning, Poison, and Psychic damage", in any punctuation. */
export function parseObjectStats(text: string, name: string): BreakableObject | undefined {
  const stats = text.match(/\bAC\s+(\d+)[;,]?\s+(?:and\s+)?HP\s+(\d+)/i);
  if (!stats) return undefined;
  const types = (label: string): string[] => {
    const list = text.slice(stats.index!).match(new RegExp(`\\b${label}\\s+to\\s+([A-Za-z, ]+?)\\s+damage\\b`, "i"))?.[1] ?? "";
    return list.split(/,|\band\b/i).map((word) => word.trim()).filter(Boolean).map(normalizeDamageType);
  };
  return { name, ac: Number(stats[1]), hp: Number(stats[2]), immune: types("Immunity"), vulnerable: types("Vulnerability") };
}

/** A hold that lasts until an object with printed statistics is destroyed: the object, read from the same sentence. */
function parseBreakable(text: string): BreakableObject | undefined {
  const destroyed = text.match(/\buntil\s+the\s+([\w' -]{1,30}?)\s+(?:is|are)\s+destroyed\s+\(([^)]*)\)/i);
  return destroyed ? parseObjectStats(destroyed[2], destroyed[1].toLowerCase()) : undefined;
}

function parseEscapeRoute(text: string): { dc: number; abilities: Ability[] } | undefined {
  // A "no longer" exit phrase (no longer buried, grafted or Restrained) is the same exit named by the state it ends:
  // the check a buried, grafted or vortex-held creature takes as an action.
  const ESCAPES = /\b(?:escap|free(?:ing|s|d)?\b|burst|extricat|shunted|relocates?|prising|no\s+longer\s+(?:buried|grafted|(?:has\s+the\s+)?(?:\{@condition\s+prone[^}]*\}\s+or\s+)?\{@condition\s+restrained[^}]*\}))/i;
  const check = text.match(
    /\{@dc\s+(\d+)\}\s+(Strength|Dexterity)(?:\s*\([^)]*\))?(?:\s+or\s+(Strength|Dexterity)(?:\s*\([^)]*\))?)?\s+check/i,
  );
  if (check?.index !== undefined) {
    // The verb can sit on either side of the roll (the escape is an action spent on a
    // Strength or Dexterity check, or a Strength check that bursts the webbing).
    const window = text.slice(Math.max(0, check.index - 200), check.index + check[0].length + 220);
    if (ESCAPES.test(window)) {
      const named = [check[2], check[3]].filter(Boolean).map((word) => word!.slice(0, 3).toLowerCase() as Ability);
      return { dc: Number(check[1]), abilities: [...new Set(named)] };
    }
  }
  if (/\b(?:can\s+)?take\s+an\s+action\s+to\s+remove\s+it\b/i.test(text)) return { dc: 0, abilities: ["str", "dex"] };
  return undefined;
}

/**
 * The synthetic state that carries a per-turn tick nothing else holds.
 * A save at the end of the tick's turn that ends the effect on itself is save-ends at that DC.
 * Wordings where some creature must spend an action to remove the effect (scrape off the sap, kill or remove the
 * scarabs): the duel has no one to spend that action, so the effect lasts the fight, with the action's own save (if
 * any) as the initial one. On an attack the engine rolls a rider's save when it lands, a save some weapons
 * do not print; recorded as a residual, not modelled.
 */
function tickHolder(text: string, initialAbility: Ability | undefined, initialDc: number | undefined): Rider | undefined {
  const ending = text.match(/\{@dc\s+(\d+)\}\s+([A-Za-z]+)\s+saving throw,\s+ending the effect on itself\b/i);
  const endingAbility = ending ? longAbility[ending[2].toLowerCase()] : undefined;
  if (ending && endingAbility) {
    return { condition: "afflicted", save: { ability: endingAbility, dc: Number(ending[1]) }, duration: "saveEndsEachTurn" };
  }
  // An exit where another creature nearby spends an action to scrape away the burning fuel.
  if (/\buses? (?:its|an) action to (?:scrape|wash|kill or remove)\b/i.test(text) || /\bcan take an action to scrape\b/i.test(text)) {
    return {
      condition: "afflicted",
      save: initialAbility && initialDc !== undefined ? { ability: initialAbility, dc: initialDc } : undefined,
      duration: "permanent",
    };
  }
  return undefined;
}

/** A swallow that applies to a creature Grappled by the swallower: a grapple the swallow requires. */
const SWALLOW_NEEDS_GRAPPLE_RE = /\{@condition\s+grappled[^}]*\}\s+by\s+[^,.]{1,40},\s+that creature is swallowed\b/i;

/**
 * `wholeAction` says `text` is an action's entire text, so its opening names who it targets. A
 * clause handed over on its own — a Multiattack's "the target is Grappled" follow-up, a trait's
 * charge rider — has no descriptor to read, and its own effect would look like one.
 */
/**
 * A save printed behind a state of the attacker that no rider field expresses. A print that gates a Strength save
 * against being {@condition prone} on the creature having been {@condition invisible} before it attacked, and a Prone save
 * that applies only when the victim is a creature and the
 * attacker is enlarged, each compiled the Prone save on every hit. A rider's own gates are the target's condition, the
 * run-up and the target's Hit Points (`requiresTargetCondition`, `requiresMovement`, `requiresTargetHpAbove`), so the
 * sentence is left out of the rider parse.
 * The subject is the creature itself (not the target, a creature or the attack) and the state is one word or one
 * condition tag: an "If the attack hits a creature" opener and an "If the limb hits" opener are hit gates and are not this.
 */
const ATTACKER_STATE_GATED_SAVE_RE = /(^|[.!?]\s+)If (?:the target is a creature and )?the (?!target\b|creature\b|attack\b)[a-z' -]{2,40}? (?:is|was) (?:\{@condition [^}]+\}|[a-z]+)(?: before it attacked)?, the target must succeed on [^.]*\./gi;

export function parseRiders(text: string, wholeAction = false): Rider[] {
  text = text.replace(ATTACKER_STATE_GATED_SAVE_RE, "$1");
  return withSpeedCut(text, withTeleportBan(text, withStandBar(text, withHealBlock(text, withRollEffects(text, withMinuteClock(text, withHolderDamageShare(text, withSavesToEnd(text, withLeadingTypeGates(text, parseRidersUngated(text, wholeAction))))))))));
}

// A printed partial Speed cut on the target: Speed decreases or is reduced by some feet (also "has its speed
// reduced by" feet); Speed halved, "has its speed halved", or reduced by half. Group 1: the feet.
// Not "speed is reduced to 0" (`speedZero`), "its speed isn't reduced", "moves up to half its Speed".
const SPEED_CUT_RE = /\bspeed (?:(?:is )?(?:reduced|decreases|decreased) by (\d+) feet|(?:is )?halved|is reduced by half)/gi;
const SPEED_CUT_CLOCK_RE = /\buntil the (start|end) of (its|their|the target['’]s|[\w' -]+?['’]s) next turn\b/i;
const EFFECT_LIST_HEADER_RE = /\bWhile (\w+) in this way, the target suffers one of the following effects\b/i;
const SPEED_CUT_OWN_SAVE_RE =/\bmust (?:succeed on|make) a (?:DC )?(\d+) [A-Za-z]+ saving throw\b/i;

/**
 * A printed partial Speed cut: the target's Speed drops by some feet through its next turn, or is
 * halved through its next turn. It lasts as the print says:
 * - a turn clock in its sentence and no save of the sentence's own: a `speedCut` rider of that duration, landing with the
 *   hit or the failed save as every rider does;
 * - a turn clock and a save in the same sentence (a Constitution save, or the halved Speed paired with
 *   disadvantage, both timed to the next turn): the field on the rider that already carries that save and clock,
 *   else nothing;
 * - no clock, in a sentence that opens "While ..." or "Until ..." and names a condition the compile carries (a charmed
 *   target, a wounded target, a curse that ends): the field on that rider.
 * Nothing else is read: a cut on a successful save, one with no printed end (until a bolt is removed), one
 * "for 1 minute" behind a repeat save, one whose condition the compile does not carry.
 */
export function withSpeedCut(text: string, riders: Rider[]): Rider[] {
  const plain = stripTags(text);
  if (!/\bspeed\b/i.test(plain)) return riders;
  let out = riders;
  for (const match of plain.matchAll(SPEED_CUT_RE)) {
    const at = match.index ?? 0;
    const sentenceStart = plain.lastIndexOf(". ", at) + 1;
    const stop = plain.indexOf(".", at + match[0].length);
    const sentence = plain.slice(sentenceStart, stop < 0 ? plain.length : stop + 1);
    const before = plain.slice(sentenceStart, at);
    if (/\bOn a successful save\b|\{@actSaveSuccess\}/i.test(before)) continue;
    if (/\b(?:its own|moves?|fl(?:y|ies)) \b/i.test(before) && !/\btarget|creature\b/i.test(before)) continue;
    const field: Pick<Rider, "speedCut" | "speedHalved"> = match[1] ? { speedCut: Number(match[1]) } : { speedHalved: true };
    const clock = sentence.match(SPEED_CUT_CLOCK_RE);
    const duration: Rider["duration"] | undefined = !clock ? undefined
      : /^(?:its|their|the target['’]s)$/i.test(clock[2])
        ? clock[1].toLowerCase() === "end" ? "endOfTargetNextTurn" : "startOfTargetNextTurn"
        : clock[1].toLowerCase() === "end" ? "endOfSourceNextTurn" : "startOfSourceNextTurn";
    const ownSave = before.match(SPEED_CUT_OWN_SAVE_RE);
    if (duration && ownSave) {
      const carrier = out.find((rider) => rider.save?.dc === Number(ownSave[1]) && rider.duration === duration && !rider.requiresTargetCondition);
      if (carrier) out = out.map((rider) => rider === carrier ? { ...rider, ...field } : rider);
      continue;
    }
    if (duration) {
      // "Until the end of its next turn, the target can't take a Bonus Action or Reaction, its Speed decreases by 10
      // feet, and it can move or take one action on its turn, not both" (Ice Spear): the limits ride on the Speed cut.
      const limits: Pick<Rider, "noReactions" | "noBonusActions" | "moveOrAct"> = /\bcan't take a Bonus Action or Reaction\b[^.]*\bit can move or take one action on its turn, not both\b/i.test(stripTags(sentence))
        ? { noReactions: true, noBonusActions: true, moveOrAct: true } : {};
      if (!out.some((rider) => rider.condition === "speedCut")) out = [...out, { condition: "speedCut", duration, ...field, ...limits }];
      continue;
    }
    // A header that holds while the target is Poisoned in this way and offers a choice of listed effects, one of which
    // is acid damage at the start of each turn plus a Speed decrease by some feet. The listed effect holds while the header's
    // condition does, so the cut goes on the rider that carries that condition.
    const listHeader = plain.slice(0, at).match(EFFECT_LIST_HEADER_RE);
    const listed = listHeader ? out.find((rider) => rider.condition === listHeader[1].toLowerCase() && !rider.requiresTargetCondition) : undefined;
    if (listed) { out = out.map((rider) => rider === listed ? { ...rider, ...field } : rider); continue; }
    if (!/^\s*(?:While|Until)\b/.test(before)) continue;
    const named = out.find((rider) => !rider.requiresTargetCondition
      && new RegExp(`\\b${rider.condition.replace(/ed$/, "")}`, "i").test(before));
    if (named) out = out.map((rider) => rider === named ? { ...rider, ...field } : rider);
    // A failed save that deals necrotic damage and makes the target cursed for 24 hours, with its Speed halved while cursed. The print's own curse
    // compiled no rider ("become cursed" is not a wording the curse reader takes), so the cut had nothing to ride. The
    // curse becomes a `cursed` rider that carries the cut; 24 hours outlast a fight (`permanent`).
    else if (/^\s*While cursed\b/i.test(before) && /\bbecomes? cursed\b/i.test(plain) && !out.some((rider) => rider.condition === "cursed")) {
      out = [...out, { condition: "cursed", duration: "permanent", ...field }];
    }
  }
  return out;
}

const TELEPORT_BAN_RE = /\bUntil the (?:grapple|(?:\{@condition grappled[^}]*\}|grappled) condition) ends, the target [^.]*\bcan['’]t teleport\b/i;

/**
 * A ban on teleporting printed on a grapple: the grapple holds the target Restrained and it can't teleport until the
 * grapple ends (or until the grappled condition ends). The effect's
 * `grappled` rider carries it (`Rider.blocksTeleport`), so the ban ends when the grapple does. A swallow's
 * ban (a swallowed creature can't teleport) is in force through `swallowed` and is not read here.
 */
export function withTeleportBan(text: string, riders: Rider[]): Rider[] {
  if (!TELEPORT_BAN_RE.test(text)) return riders;
  return riders.map((rider) => rider.condition === "grappled" && rider.duration === "untilEscape" ? { ...rider, blocksTeleport: true as const } : rider);
}

const STAND_BAR_RE = /\bcan['’]t stand up and end the (?:\{@condition prone[^}]*\}|prone) condition on itself\b/i;

/**
 * A printed bar on standing: a cursed target cannot rise from Prone by its own effort.
 * The effect's `prone` rider carries it (`Rider.cannotStand`), so the bar lasts as long as that copy.
 */
export function withStandBar(text: string, riders: Rider[]): Rider[] {
  if (!STAND_BAR_RE.test(text)) return riders;
  return riders.map((rider) => rider.condition === "prone" ? { ...rider, cannotStand: true as const } : rider);
}

/**
 * A "can't regain hit points" clause whose subject is the one the effect lands on (the target, the creature or "it"), never the creature
 * itself, a zone (creatures within 60 feet of the source), or an
 * exception ("unless it is underwater").
 */
const HEAL_BLOCK_RE = /\b(?:(?:the|a|that) (?:[a-z]+ )?(?:target|creature)|it|and)\s+can(?:'|’)t regain hit points\b(?![^.]*\bunless\b)/gi;
// Three more printed shapes of a maximum-HP reduction:
// - behind a save of its own: a Constitution save, and on a failure the maximum drops
//   by the damage taken (or half of it) of a given type. Groups: DC, ability, "half ", damage type;
// - half the damage, with no save of its own: the maximum drops by half the necrotic damage dealt. Group: type;
// - dice of its own on a hit: the maximum also drops by a dice amount. Group: the dice;
// - dice of its own as the whole failure branch of a save action: the {@actSaveFail} entry says the Hit Point maximum decreases
//   by a dice amount. Group: the dice. The sentence ends at the dice: a reduction that waits on a rest or a day says
//   more (it does not return to normal until some later event) and is not read.
const OWN_SAVE_MAX_HP_REDUCTION_RE = /\bmust succeed on a \{@dc (\d+)\} ([A-Za-z]+) saving throw,? or its hit points? maximum is reduced by an amount equal to (half )?(?:the )?(?:([A-Za-z]+) )?damage taken/i;
const HALF_MAX_HP_REDUCTION_RE = /(?:hit points?|\{@variantrule\s+Hit Points?[^}]*\}) maximum (?:is reduced|decreases) by an amount equal to half (?:the )?([A-Za-z]+) damage (?:taken|dealt)/i;
const OWN_DICE_MAX_HP_REDUCTION_RE = /\bits hit points? maximum is also reduced by \d+ \(\{@dice ([^}]+)\}\)/i;
const FAILURE_DICE_MAX_HP_REDUCTION_RE = /\{@actSaveFail\}\s*The target's (?:hit points?|\{@variantrule\s+Hit Points?[^}]*\}) maximum decreases by \d+ \(\{@dice ([^}]+)\}\)\s*\./i;
const TYPED_MAX_HP_REDUCTION_RE = /(?:hit points?|\{@variantrule\s+Hit Points?[^}]*\}) maximum (?:is reduced|decreases) by an amount equal to (?:the )?([A-Za-z]+) damage (?:taken|dealt)/i;
const AREA_HEAL_BLOCK_RE =/\bCreatures in that area can['’]t regain (?:\{@variantrule Hit Points[^}]*\}|Hit Points) until the (start|end) of [\w' -]+?['’]s next turn\b/i;
const HEAL_BLOCK_END_RE =/^\s*(?:until the (start|end) of (its|[\w' -]+?'s) next turn\b|for 1 minute\b)/i;

/**
 * A printed heal block: the creature cannot recover hit points while poisoned this way, or the target cannot
 * recover them through its next turn. It lasts exactly as long as what the print ties it to:
 * - a printed end after it: a `healBlocked` rider of that duration ("for 1 minute" is ten rounds);
 * - else the condition its sentence names ("While Poisoned", "Until this poison ends", "The cursed target", "the burning
 *   creature"): `blocksHealing` on that rider, so the block ends with the copy;
 * - else a curse the compile does not carry ("it is cursed. While cursed, ..."; a disease curse followed by "The cursed
 *   target ..."): a `cursed` rider, with the save that gates it;
 * - else the one condition the effect gives (a choice made "while Poisoned in this way").
 */
export function withHealBlock(text: string, riders: Rider[]): Rider[] {
  const plain = stripTags(text);
  const out = [...riders];
  for (const match of plain.matchAll(HEAL_BLOCK_RE)) {
    const start = match.index ?? 0;
    const after = plain.slice(start + match[0].length);
    // The sentence up to and including the subject ("The cursed target", "While Poisoned, the target").
    const prefix = plain.slice(plain.lastIndexOf(". ", start) + 1, start + match[0].length);
    const end = after.match(HEAL_BLOCK_END_RE);
    if (end) {
      let duration: Rider["duration"] = "permanent";
      if (end[1]) {
        const own = end[2].toLowerCase() === "its";
        const atEnd = end[1].toLowerCase() === "end";
        duration = own ? atEnd ? "endOfTargetNextTurn" : "startOfTargetNextTurn" : atEnd ? "endOfSourceNextTurn" : "startOfSourceNextTurn";
      }
      if (!out.some((rider) => rider.condition === "healBlocked")) {
        out.push({ condition: "healBlocked", duration, ...(end[1] ? {} : { rounds: 10 }), blocksHealing: true });
      }
      continue;
    }
    const topLevel = out.filter((rider) => !rider.requiresTargetCondition);
    const named = topLevel.find((rider) => new RegExp(`\\b${rider.condition.replace(/ed$/, "")}`, "i").test(prefix));
    if (named) {
      named.blocksHealing = true;
      continue;
    }
    if (/\bcursed\b/i.test(prefix)) {
      const gate = plain.match(/\bmust succeed on a (?:DC )?(\d+) ([A-Za-z]+) saving throw or be cursed\b/i);
      const ability = gate ? longAbility[gate[2].toLowerCase()] : undefined;
      out.push({ condition: "cursed", ...(gate && ability ? { save: { ability, dc: Number(gate[1]) } } : {}), duration: "permanent", blocksHealing: true });
      continue;
    }
    if (topLevel.length === 1) topLevel[0].blocksHealing = true;
  }
  return out;
}

/** "{@dice 1d6}" → "1d6"; a tagged "Disadvantage" → "Disadvantage". The roll-effect wordings are read untagged. */
const stripTags = (text: string): string => text.replace(/\{@\w+ ([^|}]*)[^}]*\}/g, "$1");
/** "d4" → 1d4. */
const MELEE_OR_RANGE_RE = /\breach \d+ ?ft\.?,? or range \d+/i;
/** A one-off delayed packet printed beside a save's failure damage (an acidic sphere's spell-like delayed effect). */
const DELAYED_NEXT_TURN_DAMAGE_RE = /,? and \d+ \(\{@damage ([^}]+)\}\) ([A-Za-z]+) damage at the end of the target's next turn/i;
const dieOf = (die: string): ReturnType<typeof parseDice> => parseDice(/^d/i.test(die) ? `1${die}` : die);

/**
 * Bounded roll effects. Each printed wording
 * below becomes a rider carrying `rollEffects`, or adds them to the rider the print already hangs them on (a
 * Poisoned condition). Read exactly as printed, and nothing looser. Timed Disadvantage on attack rolls (a disadvantage that
 * runs through the creature's following turn) and the other near misses are not read here.
 */
function withRollEffects(text: string, riders: Rider[]): Rider[] {
  const plain = stripTags(text);
  const out = [...riders];
  const add = (rider: Rider): void => {
    if (!out.some((existing) => existing.condition === rider.condition)) out.push(rider);
  };
  // A breath weapon that applies a roll effect.
  if (/\bis weakened until the end of its next turn\b/i.test(plain)
    && /\bA weakened creature has disadvantage on Strength-based ability checks and Strength saving throws, and the creature's weapon attacks that rely on Strength deal half damage\b/i.test(plain)) {
    add({
      condition: "weakened",
      duration: "endOfTargetNextTurn",
      rollEffects: [
        { roll: "check", ability: "str", mode: "disadvantage" },
        { roll: "save", ability: "str", mode: "disadvantage" },
        { roll: "damage", ability: "str", mode: "half" },
      ],
    });
  }
  // A breath weapon whose own save repeats (the save action fills it in), and "After 1 minute,
  // it succeeds automatically" is the rider clock.
  const weakening = plain.match(/\bhas Disadvantage on Strength-based D20 Tests? and subtracts \d+ \((\d*d\d+)\) from its damage rolls\b/i);
  if (weakening) {
    add({
      condition: "weakeningBreath",
      duration: /\brepeats the save at the end of each of its turns\b/i.test(plain) ? "saveEndsEachTurn" : "permanent",
      ...(/\bAfter 1 minute, it succeeds automatically\b/i.test(plain) ? { rounds: 10 } : {}),
      rollEffects: [
        { roll: "attack", ability: "str", mode: "disadvantage" },
        { roll: "save", ability: "str", mode: "disadvantage" },
        { roll: "check", ability: "str", mode: "disadvantage" },
        { roll: "damage", mode: "penalty", dice: dieOf(weakening[1]) },
      ],
    });
  }
  // A poison effect that, while Poisoned, subtracts a die from the target's damage rolls.
  const toxin = plain.match(/\bWhile Poisoned, the target subtracts (\d*d\d+) from its damage rolls\b/i);
  const poisoned = toxin ? out.find((rider) => rider.condition === "poisoned" && !rider.requiresTargetCondition) : undefined;
  if (toxin && poisoned) {
    poisoned.rollEffects = [...(poisoned.rollEffects ?? []), { roll: "damage", mode: "penalty", dice: dieOf(toxin[1]) }];
  }
  // Breath and magic effects that apply a roll effect.
  const disoriented = plain.match(/\buntil the end of its next turn, when the creature makes an attack roll or an ability check, it must roll a (d\d+) and reduce the total by the number rolled\b/i);
  if (disoriented) {
    const dice = dieOf(disoriented[1]);
    add({ condition: "disoriented", duration: "endOfTargetNextTurn", rollEffects: [
      { roll: "attack", mode: "penalty", dice }, { roll: "check", mode: "penalty", dice }] });
  }
  const giggling = plain.match(/\bUntil the end of its next turn, the target rolls (\d*d\d+) whenever it makes an ability check or attack roll and subtracts the number rolled from the D20 Test\b/i);
  if (giggling) {
    const dice = dieOf(giggling[1]);
    add({ condition: "giggling", duration: "endOfTargetNextTurn", rollEffects: [
      { roll: "attack", mode: "penalty", dice }, { roll: "check", mode: "penalty", dice }] });
  }
  // A memory drain that lasts until the target has rested, short or long (the rest of the fight). The
  // growing die on a second drain is not read.
  // Another print gives the same rider as a d4 rolled each
  // time the target makes an ability check or attack roll, subtracted from it, and compiled no rider.
  const drained = plain.match(/\bWhile memory drained, the target must roll a (d\d+) and subtract the number rolled from (?:its|any) ability checks? (?:and|or) attack rolls?\b/i)
    ?? plain.match(/\bWhile memory drained, the target must roll a (d\d+) each time it makes an ability check or attack roll, subtracting the \1 roll from it\b/i);
  if (drained) {
    const dice = dieOf(drained[1]);
    add({ condition: "memoryDrained", duration: "permanent", rollEffects: [
      { roll: "attack", mode: "penalty", dice }, { roll: "check", mode: "penalty", dice }] });
  }
  // LFL: a gnome spellcaster's confusing ray.
  const befuddled = plain.match(/\bthe target subtracts (\d*d\d+) from the next saving throw it makes before the end of the [\w' -]+?'s next turn\b/i);
  if (befuddled) {
    add({ condition: "befuddled", duration: "endOfSourceNextTurn", rollEffects: [
      { roll: "save", mode: "penalty", dice: dieOf(befuddled[1]), nextRollOnly: true }] });
  }
  // One-roll Disadvantage: the target suffers it on the next attack roll it makes, if made before its next turn ends,
  // and its variants.
  const oneRoll = plain.match(/\b(?:has|have) Disadvantage on (?:the |its )?next attack roll (?:it makes )?(?:before|until) (?:the (start|end) of )?(its|[\w' -]+?'s) next turn\b/i);
  if (oneRoll) {
    const own = oneRoll[2].toLowerCase() === "its";
    const duration: Rider["duration"] = own
      ? oneRoll[1]?.toLowerCase() === "end" ? "endOfTargetNextTurn" : "startOfTargetNextTurn"
      : oneRoll[1]?.toLowerCase() === "end" ? "endOfSourceNextTurn" : "startOfSourceNextTurn";
    // An attack whose effect is behind its own save (a Charisma save, otherwise the target suffers disadvantage on
    // its next attack roll). A save action rolls its own save instead.
    const sentence = plain.slice(0, (oneRoll.index ?? 0) + oneRoll[0].length).split(/(?<=[.:])\s+/).pop() ?? "";
    const gate = /\{@(?:atkr?|hit)\b/i.test(text) ? sentence.match(/\bmust succeed on a (?:DC )?(\d+) ([A-Za-z]+) saving throw or\b/i) : null;
    const ability = gate ? longAbility[gate[2].toLowerCase()] : undefined;
    add({
      condition: "nextAttackDisadvantage",
      duration,
      ...(gate && ability ? { save: { ability, dc: Number(gate[1]) } } : {}),
      rollEffects: [{ roll: "attack", mode: "disadvantage", nextRollOnly: true }],
    });
  }
  const timed = timedDisadvantage(text, plain);
  if (timed) add(timed);
  // The Guiding Bolt spell's effect printed on an
  // action: the next attack roll made against the target before the start (or end) of the creature's next turn has
  // Advantage. The shape the spell compiles to (`spells.ts`), with the printed start or end of the
  // source's turn.
  const against = plain.match(/\bthe next attack roll made against (?:the|this) target before the (start|end) of [\w' -]+?'s next turn has advantage\b/i);
  if (against) {
    add({
      condition: "nextAttackAgainstAdvantage",
      duration: against[1].toLowerCase() === "end" ? "endOfSourceNextTurn" : "startOfSourceNextTurn",
      rollEffects: [{ roll: "attackAgainst", mode: "advantage", nextRollOnly: true }],
    });
  }
  // A roll effect printed as held with a
  // state the option already compiles as a rider. The sentence opens with the state (while poisoned in this way, while grafted
  // with a Restrained condition, while the creature is in a named state with the
  // poisoned condition, or "The cursed target has ...") and has no clock of its own; the effects join the rider whose
  // condition the sentence names, for as long as that rider lasts. With no such rider the sentence is not read.
  for (const sentence of plain.split(/(?<=[.:])\s+/)) {
    if (!HELD_LEAD_RE.test(sentence) || /\buntil the (?:start|end) of\b/i.test(sentence)) continue;
    const effects = heldSentenceRollEffects(sentence);
    if (!effects.length) continue;
    const words = sentence.toLowerCase().split(/[^a-z]+/);
    const holder = out.find((rider) => words.includes(rider.condition.toLowerCase()) && !rider.rollEffects);
    if (holder) out[out.indexOf(holder)] = { ...holder, rollEffects: effects };
  }
  return out;
}

const HELD_LEAD_RE = /^(?:While\b[^,]*,|The cursed target\b)/i;

/** The roll effects one held-state sentence prints: Disadvantage on the listed rolls, and advantage for attacks aimed at the holder. */
function heldSentenceRollEffects(sentence: string): RollEffect[] {
  const effects: RollEffect[] = [];
  const list = sentence.match(new RegExp(`\\bdisadvantage on (${TIMED_ROLLS}(?:,? (?:and )?${TIMED_ROLLS})*)(?! against\\b)`, "i"));
  for (const [, ability, rolls] of list?.[1].matchAll(/(?:(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) )?(attack rolls|saving throws|ability checks)/gi) ?? []) {
    effects.push({
      roll: /^attack/i.test(rolls) ? "attack" : /^saving/i.test(rolls) ? "save" : "check",
      ...(ability ? { ability: longAbility[ability.toLowerCase()] } : {}),
      mode: "disadvantage",
    });
  }
  if (/\battack rolls against it have advantage\b/i.test(sentence)) effects.push({ roll: "attackAgainst", mode: "advantage" });
  return effects;
}

/**
 * Timed Disadvantage: the target suffers
 * Disadvantage on attack rolls through the creature's following turn, or the same on Intelligence saving
 * throws, or on attack rolls and saving throws, until its next turn ends. A `rollDisadvantage` rider with the
 * printed duration: "its" is the target's turn, a name's is the source's, and "her" or "his" is the source's where the
 * rolls are those "against" the source. It takes the gates its sentence prints, each an existing field: a leading
 * creature type (an "if the target is undead" opener, `targetTypes`), and on an attack its own save (a Constitution save
 * followed by "or ... it has disadvantage ..."). Not read:
 * - the heated-metal effects (touching hot gear), the recorded D family
 *   for heated metal and equipment;
 * - a Disadvantage printed for a successful save (an "On a successful save" opener): the
 *   success branch stays D, and no rider field applies on a success only.
 */
const TIMED_ROLLS = "(?:(?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) )?(?:attack rolls|saving throws|ability checks)";
const TIMED_DISADVANTAGE_RE = new RegExp(
  `\\b(?:has|have) disadvantage on (${TIMED_ROLLS}(?:,? (?:and )?${TIMED_ROLLS})*)( against (?!the \\w+ condition)[\\w' -]+?)? until the (start|end) of (its|his|her|[\\w' -]+?'s) next turn\\b`, "i",
);

function timedDisadvantage(text: string, plain: string): Rider | undefined {
  const match = plain.match(TIMED_DISADVANTAGE_RE);
  if (!match || match.index === undefined) return undefined;
  if (/\bin physical contact with a heated object\b/i.test(plain)) return undefined;
  const sentence = plain.slice(0, match.index + match[0].length).split(/(?<=[.:])\s+/).pop() ?? "";
  if (/^On a successful save\b/i.test(sentence)) return undefined;
  const owner = match[4].toLowerCase();
  if ((owner === "his" || owner === "her") && !match[2]) return undefined;
  const end = match[3].toLowerCase() === "end";
  const duration: Rider["duration"] = owner === "its"
    ? end ? "endOfTargetNextTurn" : "startOfTargetNextTurn"
    : end ? "endOfSourceNextTurn" : "startOfSourceNextTurn";
  const rollEffects: RollEffect[] = [...match[1].matchAll(/(?:(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) )?(attack rolls|saving throws|ability checks)/gi)]
    .map(([, ability, rolls]) => ({
      roll: /^attack/i.test(rolls) ? "attack" as const : /^saving/i.test(rolls) ? "save" as const : "check" as const,
      ...(ability ? { ability: longAbility[ability.toLowerCase()] } : {}),
      mode: "disadvantage" as const,
    }));
  const gate = /\{@(?:atkr?|hit)\b/i.test(text) ? sentence.match(/\bmust succeed on a (?:DC )?(\d+) ([A-Za-z]+) saving throw,? or\b/i) : null;
  const ability = gate ? longAbility[gate[2].toLowerCase()] : undefined;
  const types = leadingTypeGate(sentence);
  return {
    condition: "rollDisadvantage",
    ...(gate && ability ? { save: { ability, dc: Number(gate[1]) } } : {}),
    ...(types ? { targetTypes: types } : {}),
    duration,
    rollEffects,
  };
}

/**
 * A charm printed as lasting 1 minute after a Charisma save by each creature in an area. With no repeat save and no other exit the Charm compiled `permanent`
 * and outlasted its minute to the 100-round cap: the target lost all 100 turns. The minute is read right after the
 * condition's own tag, in its own clause, so a minute that belongs to something else stays out: a spore cloud that
 * "lingers for 1 minute" but charms for a 24-hour infection, and a "Stunned for 1 minute" that follows a
 * possession with no time limit. A dependent "while charmed in this way" rider that took its parent's duration takes its
 * clock too.
 * An ending on damage is no longer "another way out" here. A print can give a one-minute charm
 * and also state that damage to the target breaks the effect; both exits are printed, and
 * the minute was dropped: the target stayed Incapacitated to the round cap.
 * `Rider.rounds` carries the clock beside `endsOnDamage`.
 * The rest of the one-minute class. The first slice took only the six incapacitating
 * conditions (charmed, incapacitated, paralyzed, petrified, stunned, unconscious) and refused a rider with a save on
 * damage. The engine reads `rounds` for any condition and beside any other exit, so both limits go: a Blinded
 * condition for 1 minute, and a charm for 1 minute with a repeat save that is allowed
 * when the source deals damage to the target, carry the minute. A repeat save each turn, a
 * transition and Concentration are still other mechanisms.
 */
function withMinuteClock(text: string, riders: Rider[]): Rider[] {
  if (/\bconcentration\b/i.test(text)) return riders;
  const noExit = (rider: Rider): boolean => rider.duration === "permanent"
    && !rider.transitionOnFailedSave && rider.rounds === undefined;
  for (const rider of riders) {
    if (!noExit(rider) || rider.requiresTargetCondition) continue;
    const own = new RegExp(`\\{@condition ${rider.condition}(?:\\|[^}]*)?\\}[^.,;{]{0,40}?\\bfor 1 minute\\b`, "i");
    if (own.test(text)) rider.rounds = 10;
  }
  for (const rider of riders) {
    const parent = rider.requiresTargetCondition ? riders.find((candidate) => candidate.condition === rider.requiresTargetCondition) : undefined;
    if (parent?.rounds !== undefined && noExit(rider)) rider.rounds = parent.rounds;
  }
  return riders;
}

/**
 * A creature that splits the damage it takes in half (rounding down) while attached, the target absorbing the same amount; another
 * wording says the same while grappling the target. The share rides on the hold the print names (the
 * attachment, else the grapple), and lasts exactly as long as that hold.
 * A second wording: during a grapple on the target, the creature suffers only half of any damage aimed at it
 * (rounded down) and the target absorbs the remainder.
 */
const HOLDER_SHARE_RE = /\bhalves the damage it takes(?: \(round down\))?, and the target takes the same amount of damage\b/i;
const HOLDER_SHARE_OTHER_HALF_RE = /\btakes only half (?:of )?any damage dealt to it(?: \(rounded down\))?, and the target takes the other half\b/i;
function withHolderDamageShare(text: string, riders: Rider[]): Rider[] {
  if (!HOLDER_SHARE_RE.test(text) && !HOLDER_SHARE_OTHER_HALF_RE.test(text)) return riders;
  const hold = riders.find((rider) => rider.condition === "attached" && !rider.requiresTargetCondition)
    ?? riders.find((rider) => rider.condition === "grappled" && rider.duration === "untilEscape" && !rider.requiresTargetCondition);
  if (hold) hold.sharesHolderDamage = true;
  return riders;
}

/**
 * A repeat-save condition that takes more than one success to end: the print says the target is freed after
 * three of these saves succeed, or that three winning saves against the poison
 * end it. Each ended after one success. The count goes on every repeat-save rider that
 * has none yet, in the existing `savesToEnd` the engine counts down; the infestation reader above sets its own.
 */
function withSavesToEnd(text: string, riders: Rider[]): Rider[] {
  const printed = text.match(/\bafter (?:it|they) succeeds? on ([a-z]+|\d+) of these saves\b/i)
    ?? text.match(/\b([a-z]+|\d+) successful saves against the [a-z]+ end it\b/i);
  const count = printed ? (numberWords[printed[1].toLowerCase()] ?? (Number(printed[1]) || undefined)) : undefined;
  if (!count || count < 2) return riders;
  for (const rider of riders) {
    if (rider.duration === "saveEndsEachTurn" && rider.savesToEnd === undefined) rider.savesToEnd = count;
  }
  return riders;
}

function parseRidersUngated(text: string, wholeAction: boolean): Rider[] {
  if (/condition determined by rolling/i.test(text)) return [];
  const riders: Rider[] = [];
  const seen = new Set<string>();
  // Graduated escalation tiers: "fail by 5" and "{@actSaveFail 2}" (second failure).
  // "{@actSaveFail 1}" is the base tier and must still produce riders.
  // The "fails by 5 or more" wordings with the creature or the saving throw as subject are the same margin tier
  // (`FAIL_MARGIN_RE`).
  const failByIdx = text.search(new RegExp(`\\{@actSaveFail(?:By|\\s+(?:[2-9]|\\d\\d))|saving throw fails by \\d+ or more|${FAIL_MARGIN_RE.source}`, "i"));
  // Some gazes print the escalation first (a failure by a margin gives petrified, then an "Otherwise, on a failed save"
  // clause gives restrained), so the base tier
  // resumes at that "Otherwise" and only the tags between the two belong to the escalation. A variant
  // opening "Otherwise" and then addressing whoever fails the save is the same resume (`BASE_TIER_RESUMES_RE`); the margin tier itself is
  // read by `parseSaveMarginTier`.
  const baseTierResumes = failByIdx >= 0
    ? text.slice(failByIdx).search(BASE_TIER_RESUMES_RE)
    : -1;
  const failByEnd = baseTierResumes >= 0 ? failByIdx + baseTierResumes : text.length;
  // A gaze that lets a creature use its reaction to shut its eyes and avoid the saving throw, becoming Blinded if it does:
  // the defender's own choice, which the engine does not
  // offer, not an effect of the gaze.
  const avertAt = text.search(/\bcan use its reaction\b[^.]{0,40}\bto (?:shut|avert) its eyes\b/i);
  // "must each succeed": a fear effect on the target and several other creatures needs "each", and without it that Frightened
  // read as a demand as well as an effect.
  const proseSaveAt = text.search(/(?:must\s+(?:each\s+)?(?:make|succeed on)|makes?)\s+(?:a\s+)?\{@dc\s+\d+\}\s+[A-Za-z]+\s+saving throw/i);
  // A bite attack against a grappled target whose hit also swallows it: a reference-style action has no {@h}, and its only
  // prose save may be the
  // swallower's own (a regurgitation save), which would put every effect in the descriptor.
  const attackHitsAt = text.search(/\bIf the attack hits\b/i);
  const firstOutcome = [text.indexOf("{@h}"), text.indexOf("{@actSaveFail"), proseSaveAt, attackHitsAt]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  const initialSave = text.match(/\{@actSave\s+([a-z]{3})\}\s+\{@dc\s+(\d+)\}/i);
  const initialProseSave = initialSave ? null : text.match(/\{@dc\s+(\d+)\}\s+([A-Za-z]+)\s+saving throw/i);
  const initialSaveAbility = initialSave
    ? longAbility[initialSave[1].toLowerCase()]
    : initialProseSave ? longAbility[initialProseSave[2].toLowerCase()] : undefined;
  const initialSaveDc = initialSave ? Number(initialSave[2]) : initialProseSave ? Number(initialProseSave[1]) : undefined;
  // Where the aftermath starts. Once an action's prose reaches an "if the target is reduced to 0
  // hit points" clause, everything after it describes what becomes of a body (a paralysed corpse, a
  // transformation hours later, the spell that would undo it) and none of it is a condition
  // this action puts on a creature that is still standing.
  //
  // A 280-character window used to carry this, but one breath-weapon block is longer than the
  // window: a spell cast on the unconscious creature sat 300 characters past the
  // 0-HP clause it belongs to, so the tag was read as an application and every creature caught
  // in the breath was permanently Unconscious with no save. Read to the end of the text instead.
  // Every action and trait with a condition tag after a 0-HP clause put
  // aftermath there and nothing else.
  // Only past the action's own first outcome, so that a death burst, whose *trigger* is a 0-HP
  // clause and whose whole effect follows it, keeps everything it does. A death burst's own trigger (the creature
  // drops to 0 hit points and its essence lashes out) is a trigger; an "if the target is reduced to 0 hit points" clause
  // three sentences into a breath weapon is an outcome.
  const zeroHpAt = text.search(/\b(?:reduces?|reduced|drops?)\b[^.]{0,60}\bto 0(?:\s|,|\.|$)/i);
  const aftermathAt = firstOutcome >= 0 && zeroHpAt > firstOutcome ? zeroHpAt : -1;
  const restGatedAt = restGatedFrom(text);
  const restGateAt = firstOutcome >= 0 && restGatedAt > firstOutcome ? restGatedAt : -1;
  // The hit tag and the first save header printed after it (see `saveNear`).
  const hitAt = text.indexOf("{@h}");
  const midHeaderAt = hitAt >= 0 ? text.indexOf("{@actSave ", hitAt) : -1;
  // A condition already read as a demand on the target is not also something the action does to it.
  // With no hit, failed save or prose save to mark where the effect starts, the check above cannot
  // tell the two apart: one brain-extracting attack "targets one Incapacitated creature", and a
  // specter-like creature's memory-stealing touch "touches one Incapacitated creature", each came out as a
  // permanent Incapacitated — latent while nothing counted a Stunned target as Incapacitated.
  const descriptorEnd = wholeAction ? (text.match(SAVE_HEADER_RE)?.[0].length ?? 0) + targetDescriptor(text, PROSE_SAVE_RE).length : 0;
  const demands = targetPrerequisites(text);
  const demanded = new Set([...demands.all, ...demands.any]);

  // Untagged relationship states are still prerequisites for follow-up actions.
  // "If the target is a Large or smaller creature, the cloaker attaches to it" is the same attachment,
  // gated on size in its own sentence.
  const attachesToIt = text.match(/[^.]*\battaches to it\b/i);
  if (/\battaches to the target\b/i.test(text) || attachesToIt) {
    const detach = text.match(/(?:successful|succeeding on an?) \{@dc\s+(\d+)\} Strength(?:\s*\([^)]*\))? check/i);
    const sourceDetach = text.match(/\bdetach itself by (?:using|spending) (\d+) feet? of (?:(?:its|the [a-z -]+'s) )?movement/i);
    // The exit that costs the action and needs no check: the shape `parseEscapeRoute` gives a print that says to take an action to remove
    // the attachment (`escapeDc: 0`). Only where no check is printed: some attachers
    // print a DC.
    const actionDetach = !detach && ACTION_DETACH_RE.test(text);
    riders.push({
      condition: "attached",
      escapeDc: detach ? Number(detach[1]) : actionDetach ? 0 : undefined,
      escapeAbilities: detach ? ["str"] : actionDetach ? ["str", "dex"] : undefined,
      sourceDetachMovement: sourceDetach ? Number(sourceDetach[1]) : undefined,
      targetMaxSize: attachesToIt ? targetMaxSize(attachesToIt[0]) : undefined,
      duration: "untilEscape",
    });
    seen.add("attached");
  }
  // A vampire-style hit that can also grapple the target, with an escape DC: some
  // Unarmed Strikes grapple in words, not with a condition tag, alongside its damage.
  const untaggedGrapple = text.match(/\bcan also grapple the target \(escape \{@dc\s+(\d+)\}\)/i);
  if (untaggedGrapple) {
    riders.push({
      condition: "grappled",
      escapeDc: Number(untaggedGrapple[1]),
      escapeAbilities: ["str", "dex"],
      duration: "untilEscape",
    });
    seen.add("grappled");
  }
  // "…or be swallowed" is how most blocks say it; a couple of amphibious creatures
  // instead say that the creature swallows a Medium or smaller target it is grappling, and the state
  // that follows is the same one. Kept to those exact shapes rather than to the word "swallows",
  // which also appears in a creature eating the dead and in several prerequisites.
  //
  // Several more swallows were written another way and compiled as a permanent Blinded and Restrained
  // with nothing to hold them: a "the target is swallowed" wording (several giant monsters) and
  // a "swallows the target" wording (a few others).
  // A "swallows it" that sends a creature at 0 hit points to a demiplane stays out.
  const swallowAt = text.search(
    /\bbe swallowed\b|\b(?:is|are) (?:also )?swallowed\b|\bswallows the target\b|\bswallows an? [A-Za-z]+ or smaller target it is grappling\b/i,
  );
  if (swallowAt >= 0) {
    const regurgitation = text.match(
      /\btakes\s+(\d+)\s+damage or more on a single turn from (?:a creature inside|the swallowed creature|a swallowed creature)/i,
    );
    const regurgitationClause = regurgitation?.index === undefined
      ? ""
      : text.slice(regurgitation.index, text.indexOf(".", regurgitation.index) + 1 || undefined);
    const regurgitationSave = regurgitationClause.match(
      /\bmust succeed on a (?:\{@dc\s+|DC\s+)(\d+)\}?\s+Constitution saving throw at the end of that turn or regurgitate/i,
    );
    // The swallow's own save is one stated before it. A hit that swallows outright has none, and
    // the first DC in its text — in several large swallowers' cases — is the
    // swallower's Constitution save to keep what it swallowed.
    const lead = text.slice(0, swallowAt);
    const leadTag = lead.match(/\{@actSave\s+([a-z]{3})\}\s+\{@dc\s+(\d+)\}/i);
    const leadProse = leadTag ? null : lead.match(/\{@dc\s+(\d+)\}\s+([A-Za-z]+)\s+saving throw/i);
    const saveAbility = leadTag ? longAbility[leadTag[1].toLowerCase()] : leadProse ? longAbility[leadProse[2].toLowerCase()] : undefined;
    const saveDc = leadTag ? Number(leadTag[2]) : leadProse ? Number(leadProse[1]) : undefined;
    riders.push({
      condition: "swallowed",
      save: saveAbility && saveDc !== undefined ? { ability: saveAbility, dc: saveDc } : undefined,
      targetMaxSize: targetMaxSize(text),
      duration: "permanent",
      speedZero: true,
      // A swallow gated on the target being a creature of some size or smaller that the swallower has Grappled: the grapple is what
      // the swallow needs, and the bite's damage lands either way.
      requiresTargetCondition: SWALLOW_NEEDS_GRAPPLE_RE.test(text) ? "grappled" : undefined,
      sourceDamageEscapeThreshold: regurgitation ? Number(regurgitation[1]) : undefined,
      sourceDamageEscapeSaveDc: regurgitationSave ? Number(regurgitationSave[1]) : undefined,
    });
    seen.add("swallowed");
  }
  // A clause setting the target's Speed to 0 through its next turn. There is no {@condition}
  // tag on this, so no rider was built and the effect vanished: a breath
  // rooted nobody. `speedZero` is already honoured on any rider that carries it; the
  // condition name is synthetic, the same way "antimagic" below is.
  //
  // Also the tagged {@variantrule Speed} form of the 2024 prints, "reduced to 0
  // feet", and "speed becomes 0". "On a success or failure" / {@actSaveSuccessOrFail} before
  // the clause means the save does not gate it (`appliesOnSuccess`). A creature whose Speed becomes 0 while it is
  // attached and moves with the target has its own speed zeroed, not a rooting, and is skipped.
  const rootedAt = text.search(ROOTED_RE);
  const rootedSentence = rootedAt < 0 ? "" : text.slice(Math.max(0, text.lastIndexOf(". ", rootedAt)), text.indexOf(".", rootedAt + 1) + 1 || undefined);
  if (!seen.has("rooted") && rootedAt >= 0 && !/\bmoves with the target\b/i.test(rootedSentence)) {
    riders.push({
      condition: "rooted",
      save: initialSaveAbility && initialSaveDc !== undefined ? { ability: initialSaveAbility, dc: initialSaveDc } : undefined,
      duration: conditionDuration(text.slice(rootedAt)),
      speedZero: true,
      appliesOnSuccess: /\bon a success or failure\b|\{@actSaveSuccessOrFail\}/i.test(text.slice(Math.max(0, text.lastIndexOf(". ", rootedAt)), rootedAt)) || undefined,
    });
    seen.add("rooted");
  }
  // An infernal wound is a lasting state written with no {@condition} tag to carry it: the
  // target receives an infernal wound and, while wounded, loses hit points at the start of each of its turns.
  // Nothing held the tick, so some devils' damage
  // compiled as nothing at all and another's as a single die on the
  // hit that opened the wound. The name is synthetic, the way "rooted" and "antimagic" are, and
  // the engine's own already-has-this-condition check gives it for free the
  // non-stacking the prose asks for (a receives-a-wound clause that applies only if the target has none).
  //
  if (/\breceives an? [a-z]{0,12} ?wound\b/i.test(text) && /\bloses \d+ \(\{@dice\b/i.test(text)) {
    riders.push({
      condition: "wound",
      rounds: /wound closes after 1 minute/i.test(text) ? 10 : undefined,
      endsOnHealingSpell: /after a spell restores/i.test(text) ? true : undefined,
      stanchDc: /stanch the wound/i.test(text) ? Number(text.match(/succeeding on a \{@dc (\d+)\} Wisdom \(Medicine\) check/i)?.[1]) || undefined : undefined,
      save: initialSaveAbility && initialSaveDc !== undefined ? { ability: initialSaveAbility, dc: initialSaveDc } : undefined,
      duration: "permanent",
    });
    seen.add("wound");
  }
  // Catching fire is the same shape: a lasting state with per-turn damage and no tag. Only the
  // blocks with a printed tick use that tick; bare "starts burning" uses the SRD glossary
  // hazard's 1d4 Fire damage at the start of the victim's turn.
  // "If the target is a flammable object that isn't being worn or carried, it starts burning" sets objects alight,
  // never the creature attacked; "a creature or a flammable object" still does.
  const objectOnlyBurning = /\bif the target is an? (?:flammable )?object\b[^.]*\bstarts? (?:\{@hazard burning[^}]*\}|burning\b)/i.test(text);
  const bareBurning = !objectOnlyBurning && /\bstarts? (?:\{@hazard burning[^}]*\}|burning\b)/i.test(text) && !START_OF_TURN_RE.test(text) && !END_OF_TURN_RE.test(text);
  const catchesFire = bareBurning || (!objectOnlyBurning && /\b(?:starts? \{@hazard burning|starts? burning\b|catches fire\b|it ignites\b)/i.test(text)
    && (START_OF_TURN_RE.test(text) || END_OF_TURN_RE.test(text)));
  if (catchesFire) {
    // One creature writes the fire as a save-ends state whose damage is the failed
    // save's own outcome: each turn's end afterward, the burning target
    // rolls the save again, is hurt by fire when it fails, and the effect
    // stops when it succeeds. The damage sits in a sentence of its own, past any
    // recurrence phrase, so it is attached here rather than by the re-attach pass below.
    const repeated = text.match(/\bat the end of each of its turns?[^.]{0,80}\brepeats? the sav(?:e|ing throw)\b[^.]*\.\s*[^.]{0,40}\{@damage\s+([^}|]+)[^}]*\}\)?\s*([A-Za-z]+)?/i);
    riders.push({
      condition: "burning",
      save: initialSaveAbility && initialSaveDc !== undefined ? { ability: initialSaveAbility, dc: initialSaveDc } : undefined,
      duration: repeated ? "saveEndsEachTurn" : "permanent",
      // A clause saying the creature catches fire on a success or on a failure: some rays set the
      // target alight whether or not the save landed.
      appliesOnSuccess: /\bon a success or failure\b[^.]{0,80}(?:catches fire|starts? burning|ignites)/i.test(text) || undefined,
      endTurnDamage: repeated ? [{ dice: parseDice(repeated[1]), type: normalizeDamageType(repeated[2]) }] : undefined,
      startTurnDamage: bareBurning ? [{ dice: parseDice("1d4"), type: "fire" }] : undefined,
    });
    seen.add("burning");
  }
  const appliedCurse = [...text.matchAll(/\btarget is cursed\b/gi)].find((match) => {
    const sentence = text.slice(text.lastIndexOf(".", (match.index || 0) - 1) + 1, match.index);
    // An "if the frightened target is cursed by ..." clause is a prerequisite, not a curse
    // bestowed by this action. A tagged failed-save clause still is an application.
    return !/\bif\b/i.test(sentence) || /\{@actSaveFail(?:\s+1)?\}/i.test(sentence);
  });
  if (appliedCurse) {
    riders.push({
      condition: "cursed",
      save: initialSaveAbility && initialSaveDc !== undefined ? { ability: initialSaveAbility, dc: initialSaveDc } : undefined,
      duration: "permanent",
    });
    seen.add("cursed");
  }
  // Where each tag-read rider was printed, for the choice groups below.
  const printedAt = new Map<Rider, number>();
  for (const tag of findTags(text, "condition")) {
    // Conditions in the target descriptor are prerequisites, not effects bestowed by the action.
    // ...unless it is written as one: a constrict attack whose damage is followed by the Restrained
    // condition lasting to the start of the dragon's following turn, plus a further save.
    if (firstOutcome >= 0 && tag.index < firstOutcome && !isOutcomeTag(text, tag)) continue;
    // Model only the base fail tier; the fail-by-5+ escalation is a rarer, separate outcome.
    if (failByIdx >= 0 && tag.index > failByIdx && tag.index < failByEnd) continue;
    if (avertAt >= 0 && tag.index > avertAt) continue;
    const prefix = text.slice(Math.max(0, tag.index - 280), tag.index).toLowerCase();
    const shortPrefix = text.slice(Math.max(0, tag.index - 60), tag.index).toLowerCase();
    const after = text.slice(tag.end, tag.end + 240).toLowerCase();
    const sentencePrefix = text.slice(text.lastIndexOf(".", tag.index - 1) + 1, tag.index).toLowerCase();
    // Everything this sentence goes on to inflict hangs off the condition its "if the target has
    // the X" clause named, and a later reference to X in the same sentence (a "while Charmed" phrase) is
    // that same prerequisite rather than a second thing being applied.
    const dependsOn = sentencePrefix.match(DEPENDS_ON_RE)?.[1]?.trim();
    // An "already Frightened" clause that gives a different condition (Stunned) instead, or an "already Grappled this
    // way" clause that gives Prone: the condition this
    // clause gives needs the named one to be there *before* the action. Read as a plain rider it applied on
    // the first failed save. See `ALREADY_IS_RE` and the placement below.
    const alreadyIs = dependsOn ? undefined : sentencePrefix.match(ALREADY_IS_RE)?.[1]?.trim();
    // A collision rider aimed at "that other creature" is not a rider on the primary
    // combat target and only exists if a suitable secondary creature is present.
    if (/\b(?:that )?other creature\b/.test(sentencePrefix) && /\bcollides?\b/.test(prefix)) continue;
    if (/^\s+when [^.]{0,120}\bends\b/.test(after)) continue;
    // An "if", "while" or "until" clause on X being Frightened or Incapacitated describes a prerequisite or
    // termination state, not a condition this action inflicts.
    if (/\b(?:if|when|while|unless|until)\s+(?:the |an? )?[^,.;]{1,100}\s+(?:is|are)\s*$/.test(sentencePrefix)) continue;
    // The same prerequisite in 2024 wording: a giant gains temporary hit points when the target is Frightened.
    // Read as an effect this made a giant's every ranged
    // hit inflict a permanent, save-less Frightened.
    if (PREREQUISITE_HAS_RE.test(sentencePrefix)) continue;
    // An immunity to being Charmed and Frightened describes what the *possessing* creature
    // keeps, not something it inflicts.
    // Also the "immunity to the Charmed and Frightened conditions" wording
    // (a possession trait).
    if (/\b(?:immunity|immune) to (?:being |the )?(?:\{@condition [^}]*\}(?:,| and| or)*\s*)*$/.test(sentencePrefix)) continue;
    // A condition that qualifies something else is not applied. An "or" damage amount gated on a
    // Prone target (the damage alternative's gate, `alternativeDamageGate`); a clause giving
    // disadvantage on saves versus being Frightened.
    if (/\bto an?\s*$/.test(sentencePrefix) && /^\s+(?:target|creature)\b/.test(after)) continue;
    if (/\bsaving throws? against (?:the |being )?$/.test(sentencePrefix)) continue;
    // An ooze's memory drain escalates a die one step per hit and only ends in Unconscious once
    // it reaches d20 — an outcome no duel-length fight reaches, and not an outcome of this hit.
    if (/\bthe die becomes\b[^.]{0,80}\bat which point\b/.test(sentencePrefix)) continue;
    // Regurgitation/death cleanup belongs to a later event, not the initial swallow hit.
    // `regurgitat` is a stem and needs to stay one: with a word boundary behind it the
    // alternative could never fire, because every spelling in the corpus continues into
    // "regurgitate". A giant's inhaling swallow is where that showed — its regurgitation
    // clause knocked the target Prone on the hit that swallowed it, three sentences early.
    if (/^\s*if\b[^.]{0,180}\b(?:takes? \d+ damage|dies)\b[^.]{0,160}\b(?:regurgitat\w*|falls?|escapes?|no longer)\b/.test(sentencePrefix)) continue;
    // Another creature writes the same event off its core: when the core is destroyed, the creature
    // disgorges everything it swallowed, and each of those creatures gains the Prone condition.
    if (/^\s*if\b[^.]{0,120}\bis destroyed\b[^.]{0,80}\bregurgitat\w*/.test(sentencePrefix)) continue;
    if (/\bunless there is nowhere\b[^.]{0,160}\bin which case\b/.test(sentencePrefix)) continue;
    // A Petrified condition applied when the creature's next turn begins, provided the target remains Grappled,
    // happens later and only if the hold survives. Applied on the hit that
    // opened the grapple it would turn a high-CR grapple into an instant win.
    if (/\bat the start of\b[^.]{0,80}\bnext turn,?\s+if\b/.test(sentencePrefix)) continue;
    // Riders that only trigger on dropping the target to 0 HP are irrelevant (it's already down),
    // and so is everything the prose says after that point — see `aftermathAt`.
    if (aftermathAt >= 0 && tag.index > aftermathAt) continue;
    // A condition that waits for a day or a rest (`REST_GATE_RE`).
    if (restGateAt >= 0 && tag.index >= restGateAt) continue;
    if (/\breduce[sd]?\b[^.]{0,40}\bto 0\b|drops? to 0\b|to 0 (?:\{@variantrule )?hit points|while it has the\s*$/.test(prefix)) continue;
    // A "creature Grappled by" the source in a target descriptor is a prerequisite,
    // but a "the target is Charmed by" the source after a save is the effect itself.
    // A creature Grappled by the source in a target descriptor is a prerequisite. Written with
    // a possessive it is the same clause: a toxic web that hits each creature Restrained by
    // the source's Web, which is who it reaches and not what it does.
    if ((firstOutcome < 0 && /^\s+by (?:the |an? )?[\w'’ -]+/.test(after)) || /^\s+condition ends/.test(after)) continue;
    // …and after the hit, when it is what a swallow needs: a size-limited creature Grappled by the swallower is
    // swallowed (see `SWALLOW_NEEDS_GRAPPLE_RE`).
    if (/^\s+by\s+[^,.]{1,40},\s+that creature is swallowed\b/.test(after)) continue;
    // A condition the prose takes *away* is not one it applies. "While swallowed, the target
    // isn't Grappled but has the Blinded and Restrained conditions" says three things, and read
    // without this the first of them came out as a grapple the swallow inflicted.
    if (/\b(?:isn't|is not|no longer has|no longer)\s*(?:the\s+)?$/.test(sentencePrefix)) continue;
    if (/can choose not to be\s*$/.test(shortPrefix)) continue;
    // A condition the print names only in a release or immunity clause is not one it
    // applies. A bonus-action release of the target, which is also let go if the creature dies or
    // becomes Incapacitated; an Incapacitated target that fails the save automatically (a gate on the save); and creatures
    // that can't be Charmed being immune to the effect. Each came out as that condition on the target.
    if (/\bfreed if\b[^.]{0,80}\b(?:becomes|is)\s*$/.test(sentencePrefix)) continue;
    if (/(?:^|\s)an?\s*$/.test(sentencePrefix) && /^\s+(?:target|creature)s?\s+(?:automatically\s+)?fails? the sav(?:e|ing throw)\s+automatically\b|^\s+(?:target|creature)s?\s+automatically fails?\b/.test(after)) continue;
    if (/\b(?:can't|cannot|can not) be\s*$/.test(sentencePrefix) && /^\s+are immune to\b/.test(after)) continue;
    const condition = tagName(tag.body).toLowerCase();
    if (tag.index < descriptorEnd && demanded.has(condition)) continue;
    if (dependsOn && condition === dependsOn) continue;
    if (!impactfulConditions.has(condition) && !(condition === "deafened" && /While \{@condition Deafened\}/i.test(text))) continue;
    if (seen.has(condition)) continue; // dedup repeated references to the same condition
    const near = text.slice(Math.max(0, tag.index - 360), tag.end + 220).toLowerCase();
    // The rider's own sentence ends here. A size phrase after it gates something else: a soul trap
    // (a clause on this damage dropping a Medium or smaller creature to 0 Hit Points), a carry, a
    // pull. Read from `near`, each became a size gate on the Paralyzed or Restrained rider itself.
    const sentenceStop = text.indexOf(".", tag.end);
    const ownSentenceEnd = sentenceStop < 0 ? text.length : sentenceStop + 1;
    // An escape DC binds to the condition it directly follows ("Grappled condition (escape
    // {@dc 12})"); a wider window would steal a later separate effect's save or repeat text.
    const escape = text.slice(tag.end, tag.end + 80).match(/escape\s+\{@dc\s+(\d+)\}/i);
    // A save printed earlier in the rider's own sentence (a Dexterity save to avoid being knocked Prone)
    // is the one that governs it. A "choose one of the following" block gives
    // each effect its own sentence and save (Strength to disarm, Dexterity against Prone, Constitution
    // against Stunned), and the first save in the window gave both riders the disarm's Strength. Without
    // one, the first save in the window stands: the 2024 head "{@actSave con} {@dc 15}." sits a sentence
    // before the riders it governs, and "Failing the Charisma save" refers back a sentence to
    // a save printed before a nearer Constitution one.
    const own = [...text.slice(text.lastIndexOf(".", tag.index - 1) + 1, tag.index).matchAll(/\{@dc\s+(\d+)\}\s+([a-z]+)\s+saving throw/gi)]
      .at(-1);
    // A save printed after a rest or an hour has passed (`REST_GATE_RE`) does not govern a condition printed before the
    // wait: the Otyugh's Bite gives Poisoned outright.
    // A condition printed on the hit, before a mid-text save header
    // ("{@h} ... and the target has the Poisoned condition until ... If the target is a Humanoid, it is subjected to the
    // following effect. {@actSave con} {@dc 16}."), takes no save from that header: the header opens a later effect. Its
    // window runs from the hit to the header, so a save printed in its own text still governs it.
    const saveNear = restGateAt >= 0 && tag.index < restGateAt
      ? text.slice(Math.max(0, tag.index - 360), Math.min(tag.end + 220, restGateAt)).toLowerCase()
      // Not when the header's own outcomes name the condition again ("{@actSaveSuccess} The Poisoned condition ends"):
      // there the save is the condition's (the immediate chained save of a delayed effect).
      : midHeaderAt >= 0 && tag.index > hitAt && tag.index < midHeaderAt && !text.slice(midHeaderAt).toLowerCase().includes(`{@condition ${condition}`)
        ? text.slice(hitAt, Math.min(tag.end + 220, midHeaderAt)).toLowerCase()
        : near;
    const save = own ? null : saveNear.match(/\{@actsave\s+([a-z]{3})\}\s+\{@dc\s+(\d+)\}/i);
    const saveProse = own ?? (save ? null : saveNear.match(/\{@dc\s+(\d+)\}\s+([a-z]+)\s+saving throw/i));
    const saveAbility = save ? longAbility[save[1]] : saveProse ? longAbility[saveProse[2].toLowerCase()] : undefined;
    const saveDc = save ? Number(save[2]) : saveProse ? Number(saveProse[1]) : undefined;
    const riderRunUp = near.match(/\bmoved\s+(?:at least\s+)?(\d+)\+?\s+feet\b[^.]*/i);
    const rider: Rider = {
      condition,
      escapeDc: escape ? Number(escape[1]) : undefined,
      escapeAbilities: escape ? ["str", "dex"] : undefined,
      targetMaxSize: targetMaxSize(text.slice(Math.max(0, tag.index - 360), Math.min(tag.end + 220, ownSentenceEnd))),
      // Same two wordings as the damage clause above: without the legacy form several big-cat and
      // ram creatures knocked their target down on any hit at all.
      requiresMovement: Number(near.match(/\bmoved\s+(?:at least\s+)?(\d+)\+?\s+feet\b/i)?.[1]) || undefined,
      // The same sentence's "immediately before the hit" (see `IMMEDIATE_RUN_UP_RE`).
      requiresMovementImmediate: Number(riderRunUp?.[1]) && IMMEDIATE_RUN_UP_RE.test(riderRunUp![0]) ? true : undefined,
      // The same gate in two more wordings: a non-Undead creature
      // and a creature other than an Undead.
      excludedTargetTypes: /isn't an? Undead|\bnon-Undead\b|\bother than an? Undead\b/i.test(near) ? ["undead"] : undefined,
      excludedTargetTags: /(?:or|and) elf/i.test(near) ? ["elf"] : undefined,
      targetHpMax: Number(near.match(
        /(?:target|creature)\s+has\s+(\d+)\s+(?:\{@variantrule\s+hit points?[^}]*\}|hit points?)\s+or fewer/i,
      )?.[1]) || undefined,
      // An outcome written before the action's save is not what the save decides: a
      // constrict attack restrains outright and then asks for a Constitution save against a disease.
      // A rider with an escape DC takes no save of its own (the save-kind grapples'
      // action save already governs them), except a save printed earlier in its own sentence after an attack's hit: a
      // Strength save, failed for extra piercing damage and a grapple with an escape DC.
      save: (escape && !(own && ownSaveFollowsHit(text, tag.index, own.index))) || (firstOutcome >= 0 && tag.index < firstOutcome)
        ? undefined
        : saveAbility && saveDc !== undefined ? { ability: saveAbility, dc: saveDc } : undefined,
      // A print that says the target has the restrained condition until the grappled condition ends ties the condition to the grapple as
      // "until this grapple ends" does.
      // Read as permanent, an escape from the grapple left the target Restrained for the rest of the fight.
      duration: escape || GRAPPLE_TIED_RE.test(near) ? "untilEscape" : referentDuration(text, tag.index) ?? conditionDuration(durationWindow(text, tag.end)),
      endsOnDamage: endsOnDamage(durationWindow(text, tag.end)) || undefined,
      // A Paralyzed condition lasting to the start of the creature's following turn, with an exemption for a target immune to Cold
      // damage: read from the rider's own sentence, after its tag.
      unlessImmuneTo: riderImmunityGate(text.slice(tag.end, ownSentenceEnd)),
    };
    // Prone lasts until the creature stands. A turn-bounded end printed in a later sentence belongs to something else:
    // difficult terrain, a cloud, a speed of 0.
    // Other conditions keep the later sentence (a vortex whose effect runs to the creature's next turn start bounds a
    // Restrained condition).
    if (condition === "prone" && /NextTurn$/.test(rider.duration)
      && !/NextTurn$/.test(conditionDuration(text.slice(tag.end, ownSentenceEnd)))) {
      rider.duration = conditionDuration(text.slice(tag.end, ownSentenceEnd));
    }
    // A creature that covers the victim's eyes does so only while it remains attached. The same
    // sentence puts a "while attached in this way" phrase after the suffocation clause.
    if (condition === "blinded" && riders.some((candidate) => candidate.condition === "attached")
      && /\bis suffocating while [^.]{0,70}\battached in this way\b/i.test(text.slice(tag.end, tag.end + 150))) {
      const attachment = riders.find((candidate) => candidate.condition === "attached")!;
      rider.duration = "untilEscape";
      rider.requiresTargetCondition = "attached";
      rider.escapeDc = attachment.escapeDc;
      rider.escapeAbilities = attachment.escapeAbilities;
      // "... and the darkmantle had Advantage on the attack roll, it covers the target, which has the Blinded condition".
      if (/\bhad (?:\{@variantrule )?Advantage(?:\|[^}]*)?\}? on the attack roll, it covers the target\b/i.test(text.slice(Math.max(0, tag.index - 160), tag.index))) rider.requiresAttackAdvantage = true;
    }
    // "While the cloaker is attached, the target has the Blinded condition": the same dependence, printed before the
    // condition.
    if (riders.some((candidate) => candidate.condition === "attached")
      && /\bwhile the [a-z -]+ is attached, the target has the\s*$/i.test(text.slice(Math.max(0, tag.index - 80), tag.index))) {
      const attachment = riders.find((candidate) => candidate.condition === "attached")!;
      rider.duration = "untilEscape";
      rider.requiresTargetCondition = "attached";
      rider.escapeDc = attachment.escapeDc;
      rider.escapeAbilities = attachment.escapeAbilities;
    }
    if (dependsOn) {
      // The action's own save has already been rolled by the time this applies, so the rider
      // carries no second one; it simply needs the named condition to be there.
      rider.requiresTargetCondition = dependsOn;
      rider.save = undefined;
      // A Stunned condition that holds only while Charmed lasts exactly as long as the Charmed does,
      // which for a per-hit condition is the source's next turn.
      if (new RegExp(`while\\s+\\{@condition\\s+${dependsOn}`, "i").test(text.slice(tag.end, tag.end + 200))) {
        rider.duration = "startOfSourceNextTurn";
      }
    }
    if (riders.some((candidate) => candidate.condition === "swallowed")
      && (condition === "blinded" || condition === "restrained")) {
      rider.requiresTargetCondition = "swallowed";
      rider.save = undefined;
    }
    if (riders.some((candidate) => candidate.condition === "cursed")
      && /\buntil the curse ends\b/.test(sentencePrefix)) {
      const curse = riders.find((candidate) => candidate.condition === "cursed")!;
      rider.requiresTargetCondition = "cursed";
      rider.save = undefined;
      rider.duration = curse.duration;
    }
    if (condition !== "cursed" && /\bif\b[^.]{0,180}\btarget is cursed by\b/.test(sentencePrefix)) {
      rider.requiresTargetCondition = "cursed";
      rider.save = undefined;
      const parent = riders.find((candidate) => candidate.condition !== "cursed");
      if (parent) rider.duration = parent.duration;
    }
    // "While [X], the target also has [Y]": Y is dependent — it lasts exactly as long as X,
    // so inherit X's persistence rather than making Y a permanent standalone rider.
    if (/\bwhile\b/.test(sentencePrefix) && riders.length) {
      // "While swallowed, a creature has the Blinded and Restrained conditions" hangs both conditions off the
      // swallow, not off the sibling parsed just before: read the clause the governing "while" opens and prefer
      // the rider it names. Read from the sibling instead, the Behir left a Blinded-immune creature unrestrained,
      // because a chain is only as strong as a condition its target may be immune to.
      const whileClause = sentencePrefix.slice(sentencePrefix.lastIndexOf("while")).split(/[,.;]/)[0];
      const root = riders.find((candidate) => new RegExp(`\\b${candidate.condition}\\b`).test(whileClause));
      const parent = root ?? riders[riders.length - 1];
      // A clause whose state is no condition at all (a "while trapped" opener that grants Blinded
      // and Paralyzed) lists siblings too, and the second is no more dependent than the first.
      const sibling = !root && !parent.requiresTargetCondition;
      rider.duration = parent.duration;
      // Not a swallow's save, though: the 2024 Behir's "While swallowed, a creature has the Blinded and
      // Restrained conditions" is what being swallowed means, and its save was the swallow's.
      rider.save = parent.condition === "swallowed" ? undefined : parent.save;
      rider.escapeDc = parent.escapeDc;
      rider.escapeAbilities = parent.escapeAbilities;
      rider.targetMaxSize = parent.targetMaxSize;
      rider.requiresMovement = parent.requiresMovement;
      rider.requiresMovementImmediate = parent.requiresMovementImmediate;
      rider.targetTypes = parent.targetTypes;
      rider.excludedTargetTypes = parent.excludedTargetTypes;
      rider.excludedTargetTags = parent.excludedTargetTags;
      rider.requiresTargetCondition = sibling ? undefined : parent.condition;
      if (/take[sn]? (?:any )?damage|shake it awake/.test(after)) rider.endsOnDamage = true;
      // A charmed creature that is incapacitated and has a speed of 0 while charmed in this way: the Speed of 0 holds exactly as
      // long as the dependent condition does, so it rides
      // on it. Without it the charmed creature "is incapacitated but moves" out of reach.
      if (!sibling && /^\}?\s*and has a speed of 0\./i.test(text.slice(tag.end, ownSentenceEnd))) rider.speedZero = true;
    }
    seen.add(condition);
    printedAt.set(rider, tag.index);
    if (alreadyIs) {
      // `applyRiders` walks the list in order, so a gate on a condition this same action gives would find it
      // already applied. Placed ahead of that rider, the gate sees only what the target had before the action.
      rider.requiresTargetCondition = alreadyIs;
      const parentAt = riders.findIndex((candidate) => candidate.condition === alreadyIs);
      if (parentAt >= 0) riders.splice(parentAt, 0, rider);
      else riders.push(rider);
      continue;
    }
    riders.push(rider);
  }
  // A Speed of 0 feet while the target is Frightened (or a creature's speed is 0 while charmed in this
  // way). The Speed of 0 holds exactly as long as
  // the printed condition, so it rides on that condition's own rider (as for a dependent
  // one). Only the target's Speed, and only when this action gives that condition.
  const whileSpeedZero = text.match(WHILE_CONDITION_SPEED_ZERO_RE);
  const whileRider = whileSpeedZero ? riders.find((rider) => rider.condition === whileSpeedZero[1].toLowerCase()) : undefined;
  if (whileRider) whileRider.speedZero = true;
  // While the target is {@condition Charmed} it is Incapacitated and spends all its movement dancing in place. The
  // target goes nowhere while the printed condition lasts: the same Speed of 0,
  // on the same rider. A movement spent "to move in a random direction" or in flight is not this.
  const dance = text.match(DANCE_IN_PLACE_RE);
  const danceRider = dance ? riders.find((rider) => rider.condition === dance[1].toLowerCase()) : undefined;
  if (danceRider) danceRider.speedZero = true;
  // A dependent rider that lapses on damage takes its parent with it, but only when the prose
  // says the *whole effect* ends, not when an escalation states its own exit. The distinction is
  // the one the English draws, and both readings appear in the data:
  //
  //   Charm effect:      Charmed, and while Charmed also Incapacitated, and then
  //                      a sentence stating that damage to the target finishes the effect: one exit
  //                      for one effect, so damage must clear the Charm too.
  //   Poison effect:     Poisoned for an hour, and on a bad enough failure also Unconscious,
  //                      with a clause saying the sleep ends early if the target takes damage: the sleep lapses,
  //                      the poison runs its hour.
  //
  // Scoping the clause to the nearest condition already handles the second; this handles the
  // first, without which the victim shrugged off the dancing and stayed Charmed all fight.
  if (/\bthe effect ends\b/i.test(text)) {
    for (const rider of riders) {
      if (!rider.endsOnDamage || !rider.requiresTargetCondition) continue;
      const parent = riders.find((candidate) => candidate.condition === rider.requiresTargetCondition);
      if (parent) parent.endsOnDamage = true;
    }
  }

  // A clause giving the target the Charmed **or** Poisoned condition, at the creature's choice, offers the
  // attacker a choice between two conditions, not both of them. Taken as a conjunction the
  // attacker landed a duel-ending Charm *and* a Poison on every hit, twice a turn. The join word
  // plus an explicit "(X's choice)" is what distinguishes this from a genuine pair, so both
  // are required: a wave that really does knock prone and bury is a genuine pair.
  for (const match of text.matchAll(
    /\{@condition\s+([^}|]+)[^}]*\}\s+or\s+(?:the\s+)?\{@condition\s+([^}|]+)[^}]*\}\s+condition[^.]{0,40}?\bchoice\b/gi,
  )) {
    const pair = [match[1], match[2]].map((name) => name.trim().toLowerCase());
    const group = riders.filter((rider) => pair.includes(rider.condition) && rider.choiceGroup === undefined);
    if (group.length < 2) continue;
    const id = 1 + Math.max(0, ...riders.map((rider) => rider.choiceGroup ?? 0));
    for (const rider of group) rider.choiceGroup = id;
  }
  // The same choice written out as branches: lettered alternatives after "choice of" (a psionic
  // humanoid's "the creature's choice of (A) the Charmed condition … or (B) the Prone condition"), or
  // "choose one of the following … effects:" with a sentence per effect (an Unarmed Strike whose
  // disarm branch compiles to nothing, leaving Prone | Stunned). A choiceGroup picks one rider, so it
  // only fits when every branch is a single condition; a branch with damage or more conditions of its
  // own is split into options instead (`parseActionVariants`).
  const branchSets: [number, number][][] = [];
  for (const match of text.matchAll(/\bchoice of\s+(?=\(A\))/gi)) {
    const start = match.index + match[0].length;
    const end = text.slice(start).search(/\.(?:\s|$)/);
    const clause = text.slice(start, end < 0 ? text.length : start + end);
    const letters = [...clause.matchAll(/\([A-Z]\)/g)].map((m) => start + m.index);
    branchSets.push(letters.map((at, i) => [at, letters[i + 1] ?? start + clause.length]));
  }
  for (const match of text.matchAll(/\b(?:chooses? one of the following|one of the following\b[^.:]*\bchoice)\b[^.:]*:/gi)) {
    const bounds = [match.index + match[0].length];
    for (const stop of text.slice(bounds[0]).matchAll(/\.(?:\s|$)/g)) bounds.push(bounds[0] + stop.index + 1);
    branchSets.push(bounds.slice(0, -1).map((at, i) => [at, bounds[i + 1]]));
  }
  for (const branches of branchSets) {
    const picks = branches
      .map(([from, to]) => riders.filter((rider) => (printedAt.get(rider) ?? -1) >= from && printedAt.get(rider)! < to))
      .filter((branch) => branch.length);
    if (picks.length < 2 || picks.some((branch) => branch.length > 1 || branch[0].choiceGroup !== undefined)) continue;
    const id = 1 + Math.max(0, ...riders.map((rider) => rider.choiceGroup ?? 0));
    for (const [rider] of picks) rider.choiceGroup = id;
  }

  // A hold with no way out at all is almost always a hold whose exit is written as something
  // other than "(escape {@dc N})" — an ability check, a destructible web, or an action spent
  // prising the thing off. Those all read as permanent, so a spider's web held its victim for
  // the rest of the fight. Only holds that currently have *no* exit are given one: a rider that
  // already repeats a save each turn keeps that, which is the better of the two routes anyway.
  const stuck = riders.filter((rider) =>
    ["restrained", "grappled"].includes(rider.condition)
    && rider.escapeDc === undefined
    && (rider.duration === "permanent" || rider.duration === "untilEscape"));
  if (/\bis possessed by\b/i.test(text)) for (const rider of riders) if (rider.condition === "incapacitated") rider.possession = true;
  // "While Charmed, the target acts as an ally to the aboleth and is under its control while within 60 feet of it."
  const controlRange = text.match(/\bis under (?:its|his|her|their) control while within (\d+) feet\b/i)?.[1];
  if (controlRange) for (const rider of riders) if (rider.condition === "charmed") rider.controlRange = Number(controlRange);
  // "If the target is more than 5 feet from the harpy, the target moves on its turn toward the harpy by the most direct route".
  if (/\bthe target moves on its turn toward the [a-z' -]+? by the most direct route\b/i.test(text)) for (const rider of riders) if (rider.condition === "charmed") rider.drawnToSource = true;
  if (stuck.length) {
    const escape = parseEscapeRoute(text);
    const breakable = escape ? undefined : parseBreakable(text);
    // "... or the erinyes uses Entangling Rope again": the old hold ends as the action is used again.
    const endsOnReuse = /\buntil\b[^.]*\buses\s+[A-Z][\w' -]*?\s+again\b/.test(text);
    // A hold on a destructible object. With statistics in the sentence the object is made by this use; with none
    // ("until the rope is destroyed") it is the creature's own item, and `compile` reads it from the trait.
    if (breakable || endsOnReuse || (!escape && /\buntil\s+the\s+[\w' -]{1,30}?\s+is\s+destroyed\b/i.test(text))) {
      for (const rider of stuck) {
        rider.duration = "untilEscape";
        if (breakable) rider.breakable = breakable;
        if (endsOnReuse) rider.endsOnReuse = true;
      }
    }
    if (escape) {
      for (const rider of stuck) {
        rider.duration = "untilEscape";
        rider.escapeDc = escape.dc;
        rider.escapeAbilities = escape.abilities;
        // Any save the rider carries stays: for a save action the engine already knows the
        // initial save was rolled, and for an attack (a rider that restrains the target for an hour with
        // webbing) it is the roll that decides whether the hold lands at all.
      }
    }
  }
  // "The tentacle can be damaged, freeing a creature it has Grappled when destroyed (AC 20, HP 10, ...)": a hold with an
  // escape check and a destructible object both. Everything the escape would shed hangs on the object too.
  const freeing = text.match(/\bThe\s+([\w' -]{1,30}?)\s+can\s+be\s+damaged,\s+freeing\s+a\s+creature\s+it\s+has\s+(?:\{@condition\s+)?Grappled[^}]*\}?\s+when\s+destroyed\s+\(([^)]*)\)/i);
  const freed = freeing ? parseObjectStats(freeing[2], freeing[1].toLowerCase()) : undefined;
  if (freed) for (const rider of riders) if (rider.duration === "untilEscape" && !rider.breakable) rider.breakable = freed;
  // A state that replaces another says so (a swallowed target isn't Grappled, a chewed creature is released from the
  // grapple, the target's Grappled condition is cleared), and until now the engine left the old one on. Several
  // actions write it. The negated condition is attached to the first rider the action applies, which is the state
  // doing the replacing.
  //
  // A state can only end a state the action needed to begin with. That keeps out a condition on the *swallower*
  // (it can regurgitate only while it isn't Incapacitated): that is a prerequisite for a later paragraph rather than
  // something the bite takes off its victim.
  const descriptor = firstOutcome >= 0 ? text.slice(0, firstOutcome) : text;
  const prerequisites = new Set([...descriptor.matchAll(/\{@condition\s+([^}|]+)[^}]*\}/gi)]
    .map((match) => match[1].trim().toLowerCase()));
  if (/\b(?:it|the [\w'’ -]{1,24}) is grappling\b/i.test(descriptor)) prerequisites.add("grappled");
  if (riders.some((rider) => rider.condition === "swallowed" && rider.requiresTargetCondition === "grappled")) prerequisites.add("grappled");
  const negated = [...text.matchAll(/\b(?:isn't|is not|no longer)\s+(?:has\s+)?(?:the\s+)?\{@condition\s+([^}|]+)[^}]*\}/gi)]
    .map((match) => match[1].trim().toLowerCase());
  // The swallow's other two ways of saying it: the target is swallowed and the hold is over, or swallowed and the
  // Grappled condition is gone. Kept to the "and" form: "until the grapple ends" is a duration, and many grapples say it.
  if (/\band the grapple ends\b|\band the \{@condition\s+grappled[^}]*\}\s+condition ends\b/i.test(text)) negated.push("grappled");
  if (negated.length && riders.length) {
    const ends = [...new Set(negated)]
      .filter((condition) => prerequisites.has(condition) && !riders.some((rider) => rider.condition === condition));
    if (ends.length) riders[0].endsConditions = ends;
  }
  // Dependent conditions (Grappled with an escape DC, and Restrained until the grapple
  // ends) end with the grapple: give them the grapple's escape DC so escaping clears both.
  const escapeDc = riders.find((r) => r.escapeDc)?.escapeDc;
  if (escapeDc) {
    for (const rider of riders) {
      if (rider.duration === "untilEscape" && !rider.escapeDc) rider.escapeDc = escapeDc;
      if (rider.duration === "untilEscape" && !rider.escapeAbilities) rider.escapeAbilities = ["str", "dex"];
    }
  }
  // A hold printed with Disadvantage on the check to escape it: an escape DC with "with disadvantage" after it (in or out of
  // parentheses), or a statement that ability checks made to escape this grapple have Disadvantage (a mimic-style
  // pseudopod). Every condition the escape sheds carries it, as it carries the DC.
  if (ESCAPE_DISADVANTAGE_RE.test(text)) {
    for (const rider of riders) {
      if (rider.duration === "untilEscape" && rider.escapeDc !== undefined) rider.escapeDisadvantage = true;
    }
  }
  // A harpoon is a rope, not a pin. Only a couple of blocks say so: a grappled target keeps its full speed but
  // may not get farther from the grappler, or may move only along paths that close the distance. Compiled as ordinary
  // Grappled they took away a Speed their own text leaves alone.
  //
  // The phrase has to be read on the sentence that names the grapple, not on the whole action:
  // several dragons end a breath weapon with a note that on a successful save its speed isn't reduced,
  // which is about the save, not about a hold, and a whole-text test would have gone looking for
  // holds to attach it to.
  for (const sentence of text.split(/(?<=\.)\s+/)) {
    if (!/\bspeed (?:isn't|is not) reduced\b/i.test(sentence)) continue;
    if (!/\{@condition\s+grappled|\bgrappled\b/i.test(sentence)) continue;
    const approachOnly = /\bmove only in directions that bring it closer\b|\bcan'?t move farther from\b/i.test(sentence);
    for (const rider of riders) {
      if (rider.condition !== "grappled" || rider.duration !== "untilEscape") continue;
      rider.speedNotReduced = true;
      if (approachOnly) rider.approachOnly = true;
    }
  }
  // A grip that stays behind on its victim. A limb that hits a Medium or smaller creature grapples it, and the limb has
  // the statistics of the parent creature: the limb is its own creature, so what holds the victim is not the parent at
  // the end of a line. Only the Troll Limb text says this.
  const thrown = text.match(/\bthe (\w+) has the statistics of\b/i);
  if (thrown && new RegExp(`\\bif the ${thrown[1]} hits\\b`, "i").test(text)) {
    for (const rider of riders) {
      if (rider.duration === "untilEscape") rider.detachedHold = true;
    }
  }
  // …and the toll for struggling out of one, which `parseDamageClauses` kept off the hit.
  for (const tag of findTags(text, "damage")) {
    if (!ESCAPE_ATTEMPT_DAMAGE_RE.test(text.slice(tag.end, tag.end + 240))) continue;
    const holder = riders.find((rider) => rider.condition === "grappled" && rider.duration === "untilEscape");
    if (!holder) continue;
    try {
      holder.escapeAttemptDamage = [...(holder.escapeAttemptDamage || []), {
        dice: parseDice(tagName(tag.body)),
        type: normalizeDamageType(damageTypeAfter(text, tag.end)),
      }];
    } catch {
      // malformed escape damage remains omitted, as the hit-damage guard above already did
    }
  }
  // When fire hurts the poisoned target, it gets another save, and a success ends the effect on itself. That is a
  // repeat save with a trigger, not one the victim gets every turn for free, and reading it as
  // `saveEndsEachTurn` gave a poison an exit its own text does not offer.
  const damageGatedRepeat = text.match(
    /\bwhenever\b[^.]{0,80}\btakes\s+([a-z]+)\s+damage\b[^.]{0,60}\b(?:can\s+)?repeats?\s+the\s+sav(?:e|ing throw)\b/i,
  );
  if (damageGatedRepeat) {
    for (const rider of riders) {
      if (rider.duration !== "saveEndsEachTurn") continue;
      rider.duration = "permanent";
      rider.saveOnDamage = true;
      rider.saveOnDamageTypes = [normalizeDamageType(damageGatedRepeat[1])];
    }
  }
  // The same with any damage as the trigger (the charmed target takes damage and can repeat the save, the target repeats
  // the save whenever it takes damage, it can repeat the save if the source deals any damage to it), and a repeat save
  // that needs the target out of the caster's line of sight, which a featureless line never gives. Each
  // compiled as `saveEndsEachTurn`, an end-of-turn exit the print does not offer. Only when no
  // turn-end repeat is printed as well.
  const turnRepeat = /\bat the (?:end|start) of each of (?:its|their|the target's) turns\b/i.test(text);
  // An "if the charmed creature takes damage" clause followed by a repeat save is the same trigger with "if" in front, and
  // "anything harmful" / "suffers any harm" is read as damage, the only harm a duel has. A repeat on damage from "a
  // source other than" the caster has no trigger in a duel and is left alone.
  const damageRepeatPrinted = !/\btakes\s+damage\s+from\s+a\s+source\s+other\s+than\b/i.test(text) && (
    /\b(?:if|whenever|each time)\b[^.]{0,80}\b(?:takes|deals?)\s+(?:any\s+)?damage\b[^.]{0,80}\brepeats?\s+the\s+sav(?:e|ing throw)\b/i.test(text)
    || /\brepeats?\s+the\s+sav(?:e|ing throw)\b[^.]{0,40}\b(?:if|whenever|each time)\b[^.]{0,60}\b(?:takes|deals?)\s+(?:any\s+)?damage\b/i.test(text)
    || /\b(?:if|whenever|each time)\b[^.]{0,80}\b(?:anything harmful|any harm)\b[^.]{0,120}\brepeats?\s+the\s+sav(?:e|ing throw)\b/i.test(text));
  const anyDamageRepeat = !damageGatedRepeat && !turnRepeat && damageRepeatPrinted;
  const sightRepeat = !damageGatedRepeat && !turnRepeat
    && /\bdoesn't have line of sight\b[^.]{0,80}\brepeats?\s+the\s+sav(?:e|ing throw)\b/i.test(text);
  // A repeat only after a long rest or each 24 hours (the target may roll again when a long
  // rest ends, or rolls the save once per 24 hours elapsed): no repeat inside a duel at all.
  const restRepeat = !damageGatedRepeat && !turnRepeat && (
    /\b(?:after|at the end of|every)\b[^.]{0,20}\b(?:24 hours|long rest)\b[^.]{0,80}\brepeats?\s+the\s+sav(?:e|ing throw)\b/i.test(text)
    || /\brepeats?\s+the\s+sav(?:e|ing throw)\b[^.]{0,20}\bevery 24 hours\b/i.test(text));
  if (anyDamageRepeat || sightRepeat || restRepeat) {
    for (const rider of riders) {
      if (rider.duration !== "saveEndsEachTurn") continue;
      rider.duration = "permanent";
      if (anyDamageRepeat) rider.saveOnDamage = true;
    }
  }
  // Both triggers printed (a repeat save on taking damage, and also when each of its turns ends): the
  // turn-end repeat stays, and the damage one, which the `!turnRepeat` guards above dropped, is added. A rider that
  // already ends on damage (compiled by another path) is left alone.
  if (!damageGatedRepeat && turnRepeat && damageRepeatPrinted) {
    for (const rider of riders) {
      if (rider.duration === "saveEndsEachTurn" && !rider.endsOnDamage) rider.saveOnDamage = true;
    }
  }
  // Periodic damage is carried by one lasting state so it triggers exactly once per turn.
  //
  // Which values recur is judged at sentence scope by `recurringScope` — the same reading that
  // keeps them out of the immediate hit, so the two can never disagree. A plain window of
  // characters either side of the tag, which is what this was, cannot make that judgement: one
  // fire-elemental's blast and the fire it sets are two values in one sentence, and a
  // window sees the "at the start of each of its turns" from both of them. Nor can a window tell
  // a sentence from its neighbour — the Horned Devil's tail attack states its 1d8+6 hit and,
  // 120 characters later, the wound's 3d6 tick.
  //
  // {@dice} tags are read as well as {@damage} ones. An infernal wound is written as "loses 5
  // ({@dice 1d10}) Hit Points", which is damage in everything but the tag it carries; the only
  // other {@dice} values inside a per-turn sentence in the corpus belong to a fey's rope and
  // a giant's behaviour table, and both are keyed to their owner's turns.
  for (const tag of [...findTags(text, "damage"), ...findTags(text, "dice")].sort((a, b) => a.index - b.index)) {
    const sentenceStart = text.lastIndexOf(".", tag.index - 1) + 1;
    const sentenceEnd = text.indexOf(".", tag.end) < 0 ? text.length : text.indexOf(".", tag.end);
    const sentence = text.slice(sentenceStart, sentenceEnd);
    const offset = tag.index - sentenceStart;
    const scope = recurringScope(sentence, offset);
    // A *leading* phrase governs the value that follows it, which `recurringScope` deliberately
    // does not report: there it means the damage is immediate on any of several triggers (a phrase naming each
    // creature that ends its turn in the area). A leading start-of-turn phrase has no such
    // reading, and a whirlwind that restrains its target is written that way: at the start of each of its
    // turns the Restrained target takes damage.
    const startPhrase = sentence.search(START_OF_TURN_RE);
    const endPhrase = sentence.search(END_OF_TURN_RE);
    const leading = startPhrase >= 0 && startPhrase < offset;
    // The same reading for the other end of the turn. A leading phrase naming when the poisoned
    // target's turns end, followed by damage, is a tick, and a leading phrase is
    // the only shape `recurringScope` deliberately does not report, so a swarm
    // dealt its bite and nothing thereafter.
    const leadingEnd = !leading && endPhrase >= 0 && endPhrase < offset;
    if (!scope && !leading && !leadingEnd) continue;
    // Most "at the end of each of its turns" in the corpus is a repeat save's timing rather than
    // a tick, and two blocks — the Pit Fiend's Bite and an engulfing ooze-like creature's attack — write
    // both wordings in one sentence: "takes 21 (6d6) Poison damage at the start of each of its
    // turns, and it repeats the save at the end of each of its turns". They tick once because
    // `recurringScope` reports the start-of-turn phrase first, and a value it has already claimed
    // never reaches the end-of-turn branch. No corpus sentence puts a damage value in front of a
    // bare end-of-turn repeat save.
    const endTick = leadingEnd || (scope === "other" && !leading && END_OF_TURN_RE.test(sentence));
    // Anything else `recurringScope` calls recurring is a trigger rather than a tick: a zone the
    // duel has no second creature to stand in, or an entry into an area.
    if (scope === "other" && !leading && !endTick) continue;
    if (leadingEnd && scope === undefined && !END_OF_TURN_RE.test(sentence)) continue;
    let holder = riders.find((rider) => HOLDER_CONDITIONS.includes(rider.condition)) || riders[0];
    if (!holder) {
      // A tick with nothing to hang on was dropped here: magical flames cling to the target and burn it each turn, a slime pot,
      // a sap squirt, burrowing scarabs, a magical entropy effect. None writes a {@condition}
      // tag or one of the synthetic states above, so it gets one of its own, the way the
      // wound and burning states carry theirs: save-ends at the printed DC when the print gives a
      // save that ends it, lasting the fight when the only exit is someone's action spent scraping
      // it off. Anything else stays dropped.
      const synthetic = tickHolder(text, initialSaveAbility, initialSaveDc);
      if (!synthetic) continue;
      riders.push(synthetic);
      seen.add(synthetic.condition);
      holder = synthetic;
    }
    // Whose turn the phrase names decides which end of the victim's turn it lands on, and a
    // source-keyed tick lands on the opposite one: see `ticksOnSourceTurn`. Read off the phrase
    // that was actually matched rather than the sentence, so a sentence that names a caster's turns for the tick and then lets the creature repeat the saving throw at the end of
    // each of its turns is judged by the first of its two phrases and not the second.
    const phrase = sentence.match(endTick ? END_OF_TURN_RE : START_OF_TURN_RE);
    const atVictimsEnd = endTick !== (!!phrase && ticksOnSourceTurn(phrase[0]));
    try {
      const clause: DamageClause = {
        dice: parseDice(tagName(tag.body)),
        type: normalizeDamageType(damageTypeAfter(text, tag.end)),
      };
      if (atVictimsEnd) holder.endTurnDamage = [...(holder.endTurnDamage || []), clause];
      else holder.startTurnDamage = [...(holder.startTurnDamage || []), clause];
    } catch {
      // malformed periodic damage remains omitted
    }
  }
  // A telekinetic grip whose damage sentence carries no turn phrase. When the source's turn ends it may shift every
  // creature or object in its grip, and in addition pick any set of the creatures Restrained that way and deal force
  // damage to each of them. The damage sentence carries no turn phrase of its own (the sentence before it does), so the
  // tick loop above never saw it and the grip dealt nothing. A tick on the rider the sentence names, at the end of the
  // source's turn, which is the victim's start-of-turn phase (`ticksOnSourceTurn`): it lands once on the turn the grip
  // takes hold and again each turn until the victim's end-of-turn save ends the grip.
  const grip = text.match(GRIP_DAMAGE_RE);
  const gripped = grip ? riders.find((rider) => rider.condition === tagName(grip[1]).toLowerCase()) : undefined;
  if (grip && gripped && !gripped.startTurnDamage?.length) {
    gripped.startTurnDamage = [{ dice: parseDice(grip[2]), type: normalizeDamageType(grip[3]) }];
  }
  // A follow-on with no save, when the source's next turn begins, on a condition that still holds: if the target is still
  // {@condition grappled}, it becomes {@condition petrified}. Only a named source's turn is read (such as "the scion's"); "its next
  // turn" could be either creature's.
  const delayed = text.match(
    /At the start of the (?!target's|creature's)[a-z][a-z' -]{0,40}?'s next turn, if the target is still \{@condition\s+([^}|]+)[^}]*\}, (?:the target|it) has the \{@condition\s+([^}|]+)[^}]*\} condition/i,
  );
  if (delayed) {
    const held = delayed[1].trim().toLowerCase();
    const follow = delayed[2].trim().toLowerCase();
    const parent = riders.find((rider) => rider.condition === held);
    if (parent && follow !== held && impactfulConditions.has(follow)) {
      parent.delayedCondition = { condition: follow, at: "startOfSourceNextTurn" };
      for (let i = riders.length - 1; i >= 0; i--) if (riders[i].condition === follow) riders.splice(i, 1);
    }
  }
  // Petrification is a two-stage effect: the victim is Restrained, repeats the save when
  // its next turn ends, and turns to stone only on a second failure. 2024 blocks put that second stage
  // behind {@actSaveFail 2}, which is dropped as an escalation tier, and legacy blocks write it
  // as a following sentence, where it read as a *simultaneous* second condition. Either way it
  // belongs to the first stage as a transition, the same shape 2024 Sleep already uses.
  const petrifiesOnSecondFailure = /\{@actSaveFail\s+2\}[^.]{0,200}\{@condition\s+petrified/i.test(text)
    || /repeats? the sav(?:e|ing throw)[\s\S]{0,400}?(?:on a failed save|otherwise)[^.]{0,140}\{@condition\s+petrified/i.test(text)
    // A target that rolls the save again when its next turn ends, turning to stone on a failure: a gaze
    // that compiled nothing until its margin tier was read; the aura parser reads
    // an identical gaze the same way.
    || /repeats? the saving throw[^.]{0,140}becoming \{@condition\s+petrified/i.test(text);
  if (petrifiesOnSecondFailure) {
    const firstStage = riders.find((rider) => rider.condition !== "petrified" && rider.duration === "saveEndsEachTurn");
    if (firstStage) {
      firstStage.transitionOnFailedSave = "petrified";
      return riders.filter((rider) => rider.condition !== "petrified");
    }
  }
  // Petrification is not the only two-stage effect written this way, and the tier was dropped
  // for every other one. A Brass Dragon's Sleep Breath Incapacitates on the first failure and
  // knocks Unconscious on the second; a Silver Dragon's Paralyzing Breath escalates the same way
  // to Paralyzed. Both families compiled the first stage only, so across CR 1 to CR 23 no brass
  // dragon ever put anything to sleep and no silver dragon ever paralysed anything.
  const escalation = text.match(/\{@actSaveFail\s+2\}([^.]{0,200}?)\{@condition\s+([^}|]+)/i);
  if (escalation) {
    const condition = escalation[2].trim().toLowerCase();
    const firstStage = riders.find((rider) => rider.condition !== condition && rider.duration === "saveEndsEachTurn");
    if (firstStage && impactfulConditions.has(condition) && !firstStage.transitionOnFailedSave) {
      firstStage.transitionOnFailedSave = condition;
      // The escalation states its own exit, which the second stage keeps: a sleeper woken by a
      // blow is awake, while a paralysis that says nothing about damage runs to its save.
      // Read from *after* the tier's own condition tag: `endsOnDamage` stops at the next tag, so
      // starting at the tier marker would cut the clause off before it was ever seen.
      if (endsOnDamage(text.slice(escalation.index! + escalation[0].length))) firstStage.transitionEndsOnDamage = true;
      // And a second stage that states its own repeat save keeps it: the Silver Dragons' Paralyzed "repeats the save
      // at the end of each of its turns". Read only up to the next tier or save tag, so a later ray or tier's
      // repeat save is not taken for this one.
      const tier = text.slice(escalation.index! + escalation[0].length).split(/\{@actSave/i)[0];
      if (/repeats? the sav(?:e|ing throw) at the end of each of its turns/i.test(tier)) firstStage.transitionSaveEndsEachTurn = true;
      // The second stage's own clock: the Brass Dragons' "Unconscious condition for 1 minute" and the Silver Dragons'
      // "After 1 minute, it succeeds automatically". The first stage ends with its one save and has none.
      if (/\bcondition for 1 minute\b|\bAfter 1 minute, it succeeds automatically\b/i.test(stripTags(`{@condition ${condition}}${tier}`))) firstStage.transitionRounds = 10;
      return riders.filter((rider) => rider.condition !== condition);
    }
  }
  // The same escalation in legacy prose, for a condition other than stone (handled above): a breath that Poisons, and
  // a second save when the target's next turn ends, with a failure giving it the Unconscious
  // condition. Read as a simultaneous second
  // rider, the sleep landed on the first failure and never ended. The sleep states its exit where
  // it last names the condition (it stays Unconscious for an hour, unless damaged).
  const proseEscalation = text.match(
    /repeats? the sav(?:e|ing throw)[^.]{0,60}\.\s*On a failed save, (?:it|the target|the creature) (?:has|is|gains|falls)[^.]{0,30}?\{@condition\s+([^}|]+)/i,
  );
  if (proseEscalation) {
    const condition = proseEscalation[1].trim().toLowerCase();
    const firstStage = riders.find((rider) => rider.condition !== condition && rider.duration === "saveEndsEachTurn");
    if (condition !== "petrified" && firstStage && riders.some((rider) => rider.condition === condition)
      && impactfulConditions.has(condition) && !firstStage.transitionOnFailedSave) {
      firstStage.transitionOnFailedSave = condition;
      const lastMention = text.toLowerCase().lastIndexOf(`{@condition ${condition}`);
      if (endsOnDamage(text.slice(lastMention))) firstStage.transitionEndsOnDamage = true;
      return riders.filter((rider) => rider.condition !== condition);
    }
  }
  if (/acts as an \{@spell antimagic field/i.test(text)) {
    riders.push({
      condition: "antimagic",
      duration: "endOfTargetNextTurn",
      appliesOnSuccess: true,
    });
  }
  // Short debuffs printed without a condition tag. Each is a holder of its own with the printed clock.
  // "The target can't take Reactions until the start of the balor's next turn." Slow's own list is read elsewhere.
  if (/\btarget can't take Reactions until the start of (?:the |its )?[^.]{0,40}\bnext turn\b/i.test(text) && !riders.some((r) => r.noReactions)) {
    riders.push({ condition: "noReactions", duration: "startOfSourceNextTurn", noReactions: true });
  }
  // "Until the grapple ends, the target can't cast spells with a Verbal component" (Vortex); "An engulfed target is
  // suffocating, can't cast spells with a Verbal component, has the Restrained condition" (Engulf): the lock rides on
  // the hold the same print applies.
  if (/\bcan't cast spells with a Verbal component\b/i.test(text)) {
    const hold = ["grappled", "engulfed", "swallowed", "restrained"].map((name) => riders.find((r) => r.condition === name)).find(Boolean);
    if (hold) hold.noVerbalSpells = true;
  }
  // "The target takes a -2 penalty to AC until the end of its next turn."
  const acPenalty = text.match(/\btarget takes a [-\u2212](\d+) penalty to AC until the end of its next turn\b/i);
  if (acPenalty && !riders.some((r) => r.acAdjustment)) riders.push({ condition: "acPenalty", duration: "endOfTargetNextTurn", acAdjustment: -Number(acPenalty[1]) });
  // "The target has Disadvantage on saving throws to maintain Concentration until the end of its next turn."
  if (/\btarget has (?:\{@variantrule )?Disadvantage(?:\|[^}]*)?\}? on saving throws to maintain Concentration until the end of its next turn\b/i.test(text)) {
    riders.push({ condition: "concentrationShaken", duration: "endOfTargetNextTurn", concentrationDisadvantage: true });
  }
  // "While Poisoned, the creature can take either an action or a Bonus Action on its turn, not both, and it can't take
  // Reactions": the limits ride on the condition the same print applies.
  const limited = text.match(/\bWhile \{@condition (\w+)[^}]*\}, the (?:creature|target) can take either an action or a (?:\{@variantrule )?Bonus Action(?:\|[^}]*)?\}? on its turn, not both, and it can't take Reactions\b/i);
  if (limited) for (const rider of riders) if (rider.condition === limited[1].toLowerCase()) { rider.actionOrBonus = true; rider.noReactions = true; }
  // "After 1 minute, it succeeds automatically" puts a ten-round clock on a save repeated each turn.
  if (/\bAfter 1 minute, it succeeds automatically\b/i.test(text)) for (const rider of riders) if (rider.duration === "saveEndsEachTurn" && rider.rounds === undefined) rider.rounds = 10;
  return riders;
}

/**
 * Text that determines a condition's duration: from the tag to the start of the next
 * separate effect ("{@actSave ...}", a new attack, or a "must succeed" clause), capped at
 * 480 chars so 2014-style prose with a one-minute duration and a repeat save is reached
 * without reading a neighboring effect's duration phrases (a multi-ray text).
 */
function durationWindow(text: string, from: number): string {
  const rest = text.slice(from, from + 480);
  const boundary = rest.slice(1).search(/\{@actsave\s|\{@atkr?\s|must succeed/i);
  return boundary >= 0 ? rest.slice(0, boundary + 1) : rest;
}

/**
 * Does the condition lapse the moment its victim is hurt? The data spells this four ways and
 * only the first was understood:
 *
 *   an "unconscious until it takes damage" wording                          (recognized)
 *   an effect that lapses for a creature once that creature is damaged
 *   a sleeping target that awakens on damage
 *   a condition that lapses once the target suffers any damage
 *
 * Missing the other three compiled a *permanent, unbreakable* Unconscious, which in a duel is
 * simply a win: a low-CR dragon put its opponent to sleep and then farmed
 * auto-crits with the very bite that should have woken it.
 */
function endsOnDamage(window: string): boolean {
  // The clause belongs to the nearest condition *preceding* it, so stop at the next one. A
  // multi-stage effect states the escalation's own exit after it — the Pseudodragon's sting
  // Poisons for an hour and, on a bad enough failure, adds an Unconscious "which ends early if
  // the target takes damage". Without this cut the Poison inherited the sleep's exit.
  const next = window.slice(1).search(/\{@condition\s/i);
  const scoped = next >= 0 ? window.slice(0, next + 1) : window;
  // "until it takes any damage" is the same exit.
  if (/until (?:it|the target|the creature) takes (?:any )?damage/i.test(scoped)) return true;
  // The repeat save "succeeds automatically ... if it takes damage": the target succeeds automatically after a set time
  // or if it takes damage.
  if (/\bsucceeds? automatically\b[^.]{0,60}?\bif (?:it|the target|the creature) takes (?:any )?damage/i.test(scoped)) return true;
  // An ending/waking verb, then the damage trigger, within one sentence of each other.
  return /\b(?:ends?|awakens?|wakes?)\b[^.]{0,90}?\b(?:if|when)\b[^.]{0,50}?\btakes?\s+(?:any\s+)?damage/i.test(scoped);
}

/**
 * A clause saying that a hit which would drop the target to 0 Hit Points leaves it at 1 Hit Point
 * and makes it Petrified, a frozen statue.
 *
 * In a duel a frozen statue is out exactly as stone is, and the clause matters beyond ordinary
 * death at 0 because it cannot be undone by regeneration, Undead Fortitude or a troll rule.
 */
function petrifiesOnLethalDamage(text: string): boolean {
  return /would reduce the target to 0[^.]{0,120}\{@condition\s+petrified/i.test(text);
}

/**
 * Death when this action's own damage takes the target to 0 hit points: a ray that kills a target dropped to 0 by
 * it, a creature that kills whatever this damage drops to 0, a creature that dies and turns to dust on
 * the drop to 0, "is disintegrated", "crumbles to dust",
 * a weapon that devours the soul, and a disintegration effect that applies when this damage drops the target to 0.
 * One sentence must name the drop to 0, this packet as its cause, and the death. Not read: a death at a hit point
 * maximum of 0 (the `reducesMaxHp` path), one carried by a condition (a poisoned-in-this-way clause, a creature whose
 * turn ends while it sits at 0), or a packet that only stabilises.
 * The gates are the sentence's own: "A Humanoid
 * reduced to 0", "a Medium or smaller creature".
 */
export function parseSlayOnZeroHp(text: string): SlayOnZeroHp | undefined {
  const plain = text.replace(/\{@\w+ ([^|}]+)[^}]*\}/g, "$1");
  for (const sentence of plain.split(/(?<=[.!?])\s+/)) {
    if (!/\b(?:reduces?|reduced)\b[^.]*\bto 0 hit points\b/i.test(sentence)) continue;
    if (!/\b(?:by|from) (?:this|the) (?:[a-z']+ ){0,2}(?:damage|attack|ray|beam|effect)\b|\b(?:this|the) (?:damage|attack|ray|beam) reduces\b/i.test(sentence)) continue;
    if (!/\b(?:dies|kills|disintegrat\w*|(?:turns|crumbles) (?:in)?to dust|devours its soul)\b/i.test(sentence)) continue;
    if (/hit point maximum|while poisoned|ends its turn/i.test(sentence)) continue;
    const maxSize = targetMaxSize(sentence);
    return {
      ...(/\bhumanoid\b/i.test(sentence) ? { targetTypes: ["humanoid"] } : {}),
      ...(maxSize !== undefined ? { targetMaxSize: maxSize } : {}),
    };
  }
  return undefined;
}

/**
 * Whose next turn ends the condition. The 2024 stat blocks name the source, as in a phrase ending at the end of the source's
 * next turn, and the stun then lasts through the source's
 * own next turn, where "its next turn" is the target's. A stat block calls its targets "it", "they",
 * "the target", "the creature" or "the enemy"; every "its" and "their" in the
 * data that times a condition has the target as its subject. A gendered pronoun is the named source: creatures
 * left blinded, or frightened of her, until her next turn ends.
 */
const TARGET_POSSESSIVE_RE = /^(?:its|their|(?:the|that|each|an?) (?:[a-z-]+ )?(?:target|creature|enemy|foe)(?:'s|s'))$/;

/**
 * Whose next turn the "until the start of" phrase names. Unlike "end of", an "its" here is as often the
 * source as the target: a dragon that can't take an action again until its next turn begins, and
 * self-buffs, far outnumber a target that is Stunned until its next turn begins. What
 * tells them apart is the sentence. `text` starts just after the rider's condition tag (`durationWindow`),
 * so an "its" or "their" with no sentence break before it is in the rider's own sentence and has the
 * rider's target as its subject;
 * one in a later sentence belongs to that sentence's subject, which in the data is always the source
 * (for example a sphere whose Blinded tag is a sentence earlier). A named
 * target ("the target's next turn") is the target wherever it is.
 * Named possessives ("the dragon's") and gendered pronouns ("her") are the source, as for "end of".
 */
function startOfTargetTurn(near: string, startOf: RegExpMatchArray): boolean {
  const who = startOf[1];
  if (who !== "its" && who !== "their") return TARGET_POSSESSIVE_RE.test(who);
  return !/[.!?]\s/.test(near.slice(0, startOf.index));
}

/**
 * A Speed-0 clause: "speed is reduced to 0", the tagged {@variantrule Speed} form with "to 0 feet", "speed becomes 0".
 * Also a clause saying the target's {@variantrule Speed} is 0 until the end of the target's next
 * turn (a freezing breath), which compiled the damage only. Only "the target's Speed
 * is 0 until": a Speed that is 0 *while* a printed condition lasts belongs on that condition's rider and is not read here.
 */
const ROOTED_RE = /\b(?:speed|movement) (?:is reduced to|becomes) 0\b|\bthe target's speed is 0 until\b/i;

/** The target's Speed is 0 while a printed condition lasts (see `parseRiders`). */
const DANCE_IN_PLACE_RE = /\bWhile \{@condition (\w+)(?:\|[^}]*)?\}, the target has the \{@condition Incapacitated(?:\|[^}]*)?\} condition and uses all its movement to dance in place\b/i;
const WHILE_CONDITION_SPEED_ZERO_RE =/\bWhile \{@condition (\w+)(?:\|[^}]*)?\}(?: in this way)?, (?:the target's|the creature's|a creature's|that creature's) speed is 0\b/i;

/**
 * A condition that lasts as long as something an earlier sentence bounds: a shell that sheds dazzling,
 * colored light through its next turn, and a target that must pass a saving throw or be stunned
 * until the light ends. Read from the condition's own window, "until the light ends" named no turn and compiled a
 * permanent Stun. The duration is the one printed for the thing that ends ("light"), read from the earlier sentence
 * that names it with a turn-bounded end. Only a turn-bounded referent counts; anything else falls through to
 * `conditionDuration`.
 */
/**
 * Whether the save found in a rider's own sentence (`ownIndex`, counted from that
 * sentence's start) is printed after an attack's `{@h}`. Only then does it govern a rider that also prints an escape DC.
 */
function ownSaveFollowsHit(text: string, tagIndex: number, ownIndex: number | undefined): boolean {
  const hitAt = text.indexOf("{@h}");
  return hitAt >= 0 && ownIndex !== undefined && hitAt < text.lastIndexOf(".", tagIndex - 1) + 1 + ownIndex;
}

function referentDuration(text: string, tagIndex: number): Rider["duration"] | undefined {
  const tagEnd = text.indexOf("}", tagIndex) + 1;
  const ends = text.slice(tagEnd, tagEnd + 60).match(/^[^.]{0,20}?\buntil the ([a-z]+) ends\b/i);
  if (!ends) return undefined;
  const noun = ends[1].toLowerCase();
  const before = text.slice(0, tagIndex);
  for (const sentence of before.split(/(?<=\.)\s+/)) {
    if (!new RegExp(`\\b${noun}\\b`, "i").test(sentence)) continue;
    if (!/until the (?:start|end) of [^.]{0,60}?next turn/i.test(sentence)) continue;
    const duration = conditionDuration(sentence);
    if (/NextTurn$/.test(duration)) return duration;
  }
  return undefined;
}

/** A condition tied to the grapple: "until this grapple ends", or a tagged {@condition grappled} condition that ends. */
const GRAPPLE_TIED_RE = /until (?:this|the) grapple ends|until the (?:\{@condition )?grappled\}? condition ends/;

function conditionDuration(text: string): Rider["duration"] {
  const near = text.toLowerCase().split("{@actsavesuccessorfail}")[0];
  // "until the end of its next turn, at which point it repeats the save" (Sleep Breath):
  // the repeat continues the effect, so it is save-ends, not a one-turn condition.
  if (/until the end of [^.]{0,60}next turn, (?:at which point|when) it (?:must )?repeats? the sav(?:e|ing throw)/.test(near)) return "saveEndsEachTurn";
  const startOf = near.match(/until the start of ([^.]{0,60}?)\s*next turn/);
  if (startOf) return startOfTargetTurn(near, startOf) ? "startOfTargetNextTurn" : "startOfSourceNextTurn";
  if (/repeats? the sav(?:e|ing throw)|ending the effect/.test(near)) return "saveEndsEachTurn";
  // A target that is frightened of a conjured apparition until it fades when the source's next turn ends: the
  // apparition's end is the condition's end, not a permanent Frightened.
  const endOf = near.match(/until (?:(?:it|the [a-z-]+) (?:vanishes|disappears) at )?the end of ([^.]{0,60}?)\s*next turn/);
  if (endOf) return TARGET_POSSESSIVE_RE.test(endOf[1]) ? "endOfTargetNextTurn" : "endOfSourceNextTurn";
  if (/until (?:this|the) grapple ends|escape/.test(near)) return "untilEscape";
  return "permanent";
}

/**
 * An inline random-effect table: the target suffers one random effect from a die roll, with a result range per tier.
 *
 * Unlike the eye-ray tables these sit inside a single action's prose rather than in a
 * list in the data, so `parseRandomAction` never saw them and every tier's rider was applied at once: a
 * construct paralysed on every bite *and* poisoned for 3d8 on top.
 */
function inlineRandomTiers(text: string, action: CombatAction): CombatAction | undefined {
  if (action.kind !== "attack" && action.kind !== "save") return undefined;
  const table = text.match(/\broll a \{@dice d(\d+)\}\)?:\s*/i);
  if (table?.index === undefined) return undefined;
  const body = text.slice(table.index + table[0].length);
  // Tiers are "1-2: Confusion …", with an en dash or a hyphen, and each runs to the next.
  const marks = [...body.matchAll(/\b(\d+)(?:[–-]\d+)?:\s+/g)];
  if (marks.length < 2) return undefined;
  const branches: CombatAction[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index! + marks[i][0].length;
    const tier = body.slice(start, i + 1 < marks.length ? marks[i + 1].index! : body.length);
    const damage = parseDamageClauses(tier);
    const riders = parseRiders(tier).filter((rider) => impactfulConditions.has(rider.condition));
    // A tier the duel cannot represent (the cobra's "attack a random creature") is still a
    // branch — it is a real chance of nothing happening, and dropping it would inflate the rest.
    if (action.kind === "attack") {
      // The tier's own damage rides on the action's secondary save, which is what gates it.
      const gate = action.extraSave;
      branches.push({
        ...action,
        // ...and so does the tier's own rider. The DC sits in the sentence *introducing* the
        // table (the target must pass a saving throw or get one randomly rolled
        // effect), never in the tier, so parsing the tier alone finds no save and the engine
        // applies a save-less rider unconditionally: the construct paralysed on every bite that
        // rolled a 3-4, with no save allowed.
        riders: gate
          ? riders.map((rider) => rider.save ? rider : { ...rider, save: { ability: gate.ability, dc: gate.dc } })
          : riders,
        extraSave: damage.length && gate
          ? { ...gate, damage, riders: [], onSuccess: "none" as const }
          : undefined,
      });
    } else {
      // A save action states its damage once, before the table; a tier that adds more appends
      // to it rather than replacing it. No corpus creature takes this path today.
      branches.push({ ...action, riders, damage: [...action.damage, ...damage] });
    }
  }
  return { kind: "random", branches };
}

/**
 * A save whose damage type is rolled (a damage amount followed by a die roll that picks among acid, fire, lightning
 * and thunder) compiled
 * its dice untyped, so no resistance, immunity or vulnerability ever applied. It becomes equal-odds `random` branches,
 * one per printed type, drawn each use. Save actions only: a `random` attack is not opportunity-attack eligible, so
 * rolled-type attacks need an engine field and stay as they are.
 */
const ROLLED_DAMAGE_TYPE_RE = /\broll (?:an? )?\{@dice 1?d(\d+)\} to determine (?:the )?damage type:([^.)]*)/i;
const ROLLED_TYPE_NAME_RE = /\b(acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder)\b/gi;
function rolledTypeBranches(text: string, action: CombatAction): CombatAction | undefined {
  if (action.kind !== "save") return undefined;
  const table = text.match(ROLLED_DAMAGE_TYPE_RE);
  if (!table || !action.damage.some((clause) => clause.type === "untyped")) return undefined;
  const types = [...table[2].matchAll(ROLLED_TYPE_NAME_RE)].map((m) => m[1].toLowerCase());
  if (types.length !== Number(table[1])) return undefined;
  return { kind: "random", branches: types.map((type) => ({ ...action, damage: action.damage.map((clause) => clause.type === "untyped" ? { ...clause, type: normalizeDamageType(type) } : clause) })) };
}

function randomConditionBranches(text: string, action: CombatAction): CombatAction | undefined {
  // A random condition lasting to the start of the source's following turn, rolled on a d6 table: (1-2) blinded, (3-4) frightened,
  // or (5-6) stunned. The same table in other words;
  // read as riders it applied all three, permanently.
  if (!/condition determined by rolling|\broll an? \{@dice d\d+\} for the condition\b/i.test(text)) return undefined;
  if (action.kind !== "attack" && action.kind !== "save") return undefined;
  const branches: CombatAction[] = [];
  const duration = conditionDuration(text);
  const conditionTags = findTags(text, "condition").map((tag) => tagName(tag.body).toLowerCase());
  for (const condition of conditionTags) {
    const riders = impactfulConditions.has(condition) ? [{ condition, duration }] : [];
    branches.push({ ...action, riders });
  }
  return branches.length ? { kind: "random", branches } : undefined;
}

/**
 * Teleports the engine can place on the map. Only a *self*-teleport of a stated distance
 * qualifies; everything else is left out on purpose, because a wrong destination is worse
 * than no jump at all:
 *
 * - **Forced teleports** (the creature moves the target by up to 10 feet) move the
 *   opponent, not the user. That is a different mechanic with the opposite sign, so it is
 *   skipped rather than mistaken for an escape.
 * - **Landmark-gated** jumps (the Dryad's Tree Stride) need scenery the duel has no notion of.
 * - **Plane shifts** (Etherealness) leave the battlefield entirely.
 * - **Position swaps** with an ally, and **death-triggered escapes**, have no 1v1 meaning.
 */
/**
 * Does this option get its damage from another action it names, rather than stating its own?
 * Mirrors the reference forms the legendary and multiattack resolvers understand.
 */
export function referencesAnotherAction(text: string): boolean {
  return /\bmakes?\s+(?:a|an|one|two|three|four|\d+)\s+(?:separate\s+)?[A-Z][A-Za-z', -]*\s*attacks?\b/.test(text)
    || /\buses?\s+(?:Spellcasting|[A-Z][A-Za-z' -]+)\b/.test(text);
}

/**
 * `referenced`: the text is a Legendary entry that jumps and then makes an attack it names (the reference resolver in
 * `compile.ts`). Two more wordings are read there, and only there: a jump to an unoccupied space the creature can see, 30
 * feet away at most, with no "of herself", and a jump to an unoccupied space 5 feet or less from a creature it can see, a jump fixed beside the
 * foe (`besideFoe`). Elsewhere the first wording also
 * names a jump but is out of this reader's scope, and the second names how close it lands to a target
 * rather than how far it goes.
 */
export function parseTeleport(text: string, referenced = false): TeleportSpec | undefined {
  // "can't teleport" clauses describe a restriction the option imposes on somebody else.
  const clean = text.replace(/can'?t (?:be )?teleport(?:ed)?/ig, "");
  if (!/\bteleports?\b/i.test(clean)) return undefined;
  if (/\bteleports?\s+(?:the target|it,|that creature|one creature|the creature)|\bis teleported\b/i.test(clean)) return undefined;
  // Landmark hops (Tree Stride and its reskins) need scenery, and they always describe the
  // destination relative to a *second* landmark rather than to the creature.
  if (/\btree\b|\binanimate plant\b|\bof a second\b/i.test(clean)) return undefined;
  if (/Ethereal Plane|plane of existence/i.test(clean)) return undefined;
  if (/exchanging positions/i.test(clean)) return undefined;
  if (/drops to 0\b/i.test(clean)) return undefined;
  if (/\bmount(?:ed|s)?\b/i.test(clean)) return undefined;
  const match = clean.match(/\bteleports?\b[^.]{0,120}?\bup to (\d+)\s*(?:feet|ft)/i)
    // "within N feet of itself" states the jump's range. A "within N feet of a creature" clause the creature can
    // see states how close it lands to its *target*, which is an unbounded closing teleport
    // and a different thing entirely, so matching it would read a
    // battlefield-crossing jump as a five-foot shuffle.
    || clean.match(/\bteleports?\b[^.]{0,120}?\bto an unoccupied space[^.]{0,80}?within (\d+)\s*(?:feet|ft) of (?:it|itself|him|himself|her|herself|them|themselves)\b/i)
    || (referenced ? clean.match(/\bteleports?\b[^.]{0,120}?\bto an unoccupied space[^.]{0,80}?within (\d+)\s*(?:feet|ft)\b(?!\s+of\b)/i) : null);
  const beside = referenced ? clean.match(/\bteleports?\b[^.]{0,120}?\bto an unoccupied space within (\d+)\s*(?:feet|ft) of a creature it can see\b/i) : null;
  if (!match && beside) {
    const radius = Number(beside[1]);
    return Number.isFinite(radius) && radius > 0 ? { distance: 0, besideFoe: radius } : undefined;
  }
  // A jump-first bonus save: the creature teleports to a visible space up to 30 feet away in a flash of light, and
  // then each creature in a small Emanation originating from it is affected when it
  // appears. The jump names no "of itself" and no "destination space";
  // "when it appears" says the effect is made where it lands. Only with those words: another jump prints the same jump
  // clause, resolves around "the space it left" and carries its grappled creatures, which no field holds, so it stays
  // unread.
  const appearing = !match && /\bwhen (?:it|he|she|they) appears?\b/i.test(clean)
    ? clean.match(/\bteleports to an? (?:unoccupied )?space (?:it|he|she|they) can see within (\d+)\s*(?:feet|ft)\b(?!\s+of\b)/i)
    : null;
  if (appearing) {
    const jump = Number(appearing[1]);
    return Number.isFinite(jump) && jump > 0 ? { distance: jump, anchor: "destination" } : undefined;
  }
  if (!match) return undefined;
  const distance = Number(match[1]);
  if (!Number.isFinite(distance) || distance <= 0) return undefined;
  // "each creature within 10 feet of the space it left" resolves where the creature was;
  // an Emanation originating from the creature at its destination space resolves where it
  // arrives. The two orders give opposite answers whenever the option also deals damage.
  const anchor = /destination space|its destination/i.test(clean) ? "destination" as const : undefined;
  return anchor ? { distance, anchor } : { distance };
}

/**
 * Temporary hit points a creature gives *itself*: a creature that then gains a number of temporary hit points, a dice-valued
 * gain of Temporary Hit Points, and a gain equal to the damage dealt. Grants whose subject is someone
 * else ("The target gains", "each Undead ally … gains", "If another demon drinks") are not this creature's, and a
 * grant paid only for reducing a creature to 0 hit points never pays in a duel that ends there.
 */
function parseSelfTempHp(tagged: string): SelfTempHp | undefined {
  // The phrase is tagged in 2024 blocks ("{@variantrule Temporary Hit Points}") and plain in older ones; dice
  // tags are left alone because the patterns below read them.
  const text = tagged.replace(/\{@(?:variantrule|status|condition)\s+([^}|]*)(\|[^}]*)?\}/gi, "$1");
  const sentence = text.split(/(?<=\.)\s+/).find((s) => /temporary hit points/i.test(s) && /\bgains?\b/i.test(s));
  if (!sentence) return undefined;
  // Who does the gaining: the phrase before the verb, with any leading condition stripped, so a condition about a
  // target that isn't a Construct followed by the creature gaining reads as the creature's while "The target gains …"
  // and a clause about the creature's allies of one type gaining do not. A condition that names someone else and a bare
  // pronoun after it ("If another demon drinks …, it gains") is that someone else's.
  const verb = sentence.search(/\bgains?\b/i);
  const clause = sentence.slice(0, verb);
  const subject = clause.slice(clause.lastIndexOf(",") + 1).trim();
  if (/^(?:the\s+)?(?:target|each|every|another|one\s+creature|its\s+ally)\b/i.test(subject)) return undefined;
  if (/^(?:it|they|he|she)\b/i.test(subject) && /^if\s+(?:another|an?\s+(?:ally|demon|creature|undead))/i.test(clause.trim())) return undefined;
  if (/\bcan't\s+(?:regain|gain)\b/i.test(sentence)) return undefined;
  // Possessing a corpse is not something a duel offers.
  if (/\bcorpse\b/i.test(text)) return undefined;
  if (/\breduces? (?:an? )?(?:enemy|creature)[^.]{0,40}\bto 0\b/i.test(sentence)) return undefined;
  const expires = /until the start of (?:its|his|her) next turn/i.test(sentence) ? "startOfNextTurn" as const : undefined;
  const ofDamage = sentence.match(/temporary hit points equal to (half )?(?:the|that) damage/i);
  if (ofDamage) {
    const grant: SelfTempHp = { ofDamage: ofDamage[1] ? "half" : "full" };
    if (expires) grant.expires = expires;
    if (/\bif the target (?:has|is)[^.]{0,40}frightened/i.test(text)) grant.requiresTargetCondition = "frightened";
    const excluded = creatureTypes.filter((type) => new RegExp(`isn't (?:an? )?(?:[A-Za-z]+ or (?:an? )?)?${type}\\b|or (?:an? )?${type}\\b`, "i").test(sentence));
    if (/\bisn't\b/i.test(sentence) && excluded.length) grant.excludedTargetTypes = excluded;
    return grant;
  }
  const dice = sentence.match(/gains?\s+(?:a number of\s+)?\d+\s*\(\{@dice\s+([^}]+)\}\)\s*temporary hit points/i);
  if (dice) return expires ? { dice: parseDice(dice[1]), expires } : { dice: parseDice(dice[1]) };
  const flat = sentence.match(/gains?\s+(\d+)\s+temporary hit points/i);
  if (flat) {
    const dicePool = { n: 0, d: 1, mod: Number(flat[1]) };
    return expires ? { dice: dicePool, expires } : { dice: dicePool };
  }
  return undefined;
}

/**
 * The target may spend its own action to try to break a link, which takes a Charisma saving throw;
 * a made save costs the target psychic damage.
 * That save, and the damage after it, belong to the *target's* action. Read as the source's,
 * a psychic link became a Charisma-save attack for 3d6 (for some creatures an unmissable one). The action's own
 * effect is what precedes that sentence.
 */
function withoutTargetEscapeAttempt(text: string): string {
  const at = text.search(/(?<=\.\s+)The target can use an action[^.]*\b(?:break|end)\b[^.]*\{@dc\s+\d+\}/);
  return at >= 0 ? text.slice(0, at).trimEnd() : text;
}

/**
 * "Critical {@h}…": an effect printed for a critical hit only, running to the next outcome tag ("{@hom}") or the
 * end. No compiled field gates an effect on a critical, so the clause is left out of the parse rather than applied
 * on every hit: a Poisoned condition on a critical, or an extra 1d8 against a shape-shifted target.
 * Compile records a skip line where the clause carried a rider or a die (`criticalClauseEffect`).
 */
const CRITICAL_CLAUSE_RE = /Critical \{@h\}[\s\S]*?(?=\{@(?:hom|h|m)\}|$)/;

function withoutCriticalClause(text: string): string {
  const match = text.match(CRITICAL_CLAUSE_RE);
  // Only a clause the parser would read an effect from. The others stay in the text, so a clause that carries no
  // rider or die (an astral cord, a Deafened clause) compiles as it did.
  if (!match || match.index === undefined || !criticalClauseEffect(text)) return text;
  const rest = text.slice(match.index + match[0].length);
  return text.slice(0, match.index).trimEnd() + (rest ? ` ${rest}` : "");
}

/**
 * A sentence whose damage goes to something other than the foe: a ship's hull (a creature attaches itself to a ship's
 * hull, dealing piercing damage to the ship) or the creature itself (it takes force damage if it ends its turn inside
 * an object). Read as an
 * autohit on the foe, it was free damage the print never deals to a creature. The recipient is read from the die's
 * own sentence. An ability aimed at a ship that also hurts whoever is attuned to its helm
 * (psychic damage to that creature, with the helm going inert for a time) gets the same skip.
 */
const NON_FOE_DAMAGE_RES = [
  /\bdamage to (?:a|the) (?:ship|hull|vehicle)\b/i,
  /\bdamage, and the helm is suppressed\b/i,
  /\b(?:it|he|she|they) takes? [^.]*\bif (?:it|he|she|they) ends? (?:its|his|her|their) turn inside an object\b/i,
];

function nonFoeDamageSentences(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const tag of text.matchAll(/\{@damage\s/g)) {
    const start = text.lastIndexOf(".", tag.index) + 1;
    const end = text.indexOf(".", tag.index) < 0 ? text.length : text.indexOf(".", tag.index) + 1;
    if (spans.some(([s]) => s === start)) continue;
    if (NON_FOE_DAMAGE_RES.some((re) => re.test(text.slice(start, end)))) spans.push([start, end]);
  }
  return spans;
}

/** Whether an entry prints damage that goes to a ship or to the creature itself (compile's skip line). */
export function hasNonFoeDamage(text: string): boolean {
  return nonFoeDamageSentences(text).length > 0;
}

function withoutNonFoeDamage(text: string): string {
  const spans = nonFoeDamageSentences(text);
  if (!spans.length) return text;
  let out = "", at = 0;
  for (const [start, end] of spans) { out += text.slice(at, start); at = end; }
  return (out + text.slice(at)).replace(/\s{2,}/g, " ").trim();
}

/**
 * A cost the option deals its own user. Two printed wordings, each a sentence of its own whose
 * subject is the creature itself:
 * - a force-damage sentence that says it is taken after resolving the attack. Paid after the attack, hit or miss.
 * - a sentence of slashing damage that adds that no defence reduces it. Paid before the spray
 *   the sentence precedes, and irreducible.
 * Environmental self-damage (damage taken if the creature ends its turn inside an object) and damage a target
 * takes are neither wording.
 */
const SELF_COST_RE = /(?<=^|[.}]\s*)The [A-Za-z][A-Za-z' -]{0,40}? takes \d+ \(\{@damage ([^}]+)\}\) ([A-Za-z]+) damage(?: (after resolving the attack)| \((this damage can't be reduced in any way)\))\./;

export function parseSelfCost(text: string): SelfCost | undefined {
  const match = text.match(SELF_COST_RE);
  if (!match) return undefined;
  const cost: SelfCost = { dice: parseDice(tagName(match[1])), type: normalizeDamageType(match[2]), when: match[3] ? "after" : "before" };
  if (match[4]) cost.irreducible = true;
  return cost;
}

/** The text without the cost sentence, so the user's own damage is not read as damage to the foe. */
function withoutSelfCost(text: string): string {
  return SELF_COST_RE.test(text) ? text.replace(SELF_COST_RE, "").replace(/\s{2,}/g, " ").trim() : text;
}

/** Whether an option's printed critical-hit clause carries an effect the parser would read (a rider or a die). */
export function criticalClauseEffect(text: string): boolean {
  const clause = text.match(CRITICAL_CLAUSE_RE)?.[0];
  return !!clause && (parseRiders(clause).length > 0 || parseDamageClauses(clause).length > 0);
}

/**
 * Text that makes an option magical: "magic" or "magical", a spell attack, or wording that calls the effect itself a
 * spell (a creature that is a living spell, a clause about the creature casting this spell, a target being affected by a
 * named spell). A passing mention of a spell does not: a cure that names a spell, a creature that can't cast spells, or
 * a comparison to a named spell's effect. Tags are not stripped, so a tagged "{@spell X} spell" is a mention.
 *
 * "Magically" says the same as "magical" when the sentence uses it for the effect (something magically emitted or
 * created, a target magically charmed), and nothing about it when it describes the creature's own business: a weapon that
 * magically returns to its wielder, a creature that magically teleports, regains or devours something, a victim
 * magically branded, a creature that magically has the Invisible condition, and a creature magically suppressing
 * a ship's helm. Those verbs are excluded.
 */
const MAGICAL_TEXT_RE = /\bmagic(?:al)?\b|\bmagically\b(?!\s+(?:returns|teleports|regains|devours|branded|suppressing|has the\b))|spell attack|\{@atkr? [a-z,]*s[a-z,]*\}|\bthe living spell\b|\bcasts this spell\b|\baffected by the [a-z ]{1,30} spell\b/i;

/**
 * A passing mention of magic says nothing about the effect itself: the effect can be
 * "removed by magic" (a disease), the victim may be spared when affected by magic that ends a curse, the
 * gear spared or left behind is "magic items" ("except for magic items"), or the target is not attuned to any
 * magic items. These are removed before `MAGICAL_TEXT_RE` is
 * tried. "Activate magic items" (an eye ray whose header calls it a "magical eye
 * ray") and "a magic wave" (an antimagic breath) are not passing mentions and still match.
 *
 * A cure is a passing mention too: the effect ends by a named curse-removal spell or
 * similar magic, lasts until some spell or other magic removes it, or until a restoration spell or similar magic frees
 * the creature. A print that calls its own effect magic
 * as well ("unleashes petrifying magic") still matches.
 */
const PASSING_MAGIC_RE = /\b(?:removed|ended) by magic\b|\btargeted by magic that\b|\b(?:except for|leaving behind|attuned to) (?:any )?magic items?\b|\b(?:or|and) (?:other|similar) magic\b/gi;

function magicalText(text: string): boolean {
  return MAGICAL_TEXT_RE.test(text.replace(PASSING_MAGIC_RE, " "));
}

/**
 * Ability-score drain that kills at 0: the target's Strength score decreases by {@dice 1d4}, and the target dies if
 * this reduces that score to 0. A reduction with no death clause changes nothing the engine models (modifiers stay static),
 * so it compiles no drain. The gate is read from the drain's own sentence: a creature type ("If the target is a
 * Humanoid") or a damage immunity (a clause exempting a target immune to necrotic damage); on a save action, the outcome it
 * rides (a failed-save clause that also reduces a Charisma score).
 */
/**
 * A condition rider's damage-immunity gate, from the rest of its own sentence: an exemption for a target that has
 * {@variantrule Immunity} to Cold damage, or one that is simply immune to cold
 * damage.
 */
function riderImmunityGate(rest: string): string | undefined {
  const gate = rest.match(/\bunless the target (?:has (?:\{@variantrule Immunity[^}]*\}|Immunity) to|is immune to) ([A-Za-z]+) damage\b/i);
  return gate ? normalizeDamageType(gate[1]) : undefined;
}

function parseAbilityDrain(text: string, kind: CombatAction["kind"]): AbilityDrain | undefined {
  if (kind !== "attack" && kind !== "save") return undefined;
  const drain = text.match(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) score (?:is reduced|decreases) by \{@dice\s+([^}]+)\}/i);
  if (!drain || drain.index === undefined) return undefined;
  if (!/\bdies if this reduces\b|\bif this reduces the target's [A-Za-z]+ to 0, the target dies\b/i.test(text)) return undefined;
  const sentence = text.slice(text.lastIndexOf(".", drain.index) + 1, drain.index);
  const typeGate = sentence.match(/\bIf the target is an? ([A-Za-z]+),/i);
  const immunityGate = sentence.match(/\bUnless the target is immune to ([A-Za-z]+) damage\b/i);
  const either = /\bOn a (?:successful or failed|failed or successful) save\b/i.test(sentence);
  return {
    ability: longAbility[drain[1].toLowerCase()],
    dice: parseDice(tagName(drain[2])),
    on: kind === "attack" ? "hit" : either ? "eitherSave" : "failedSave",
    ...(typeGate ? { targetTypes: [typeGate[1].toLowerCase()] } : {}),
    ...(immunityGate ? { unlessImmuneTo: normalizeDamageType(immunityGate[1]) } : {}),
  };
}

/**
 * A heal tied to the damage, in wordings the life-drain reader in `parseDamageClauses` does not take: hit points
 * gained to match the Necrotic damage taken, a gain matching the
 * necrotic damage dealt, a heal for the amount of force damage taken,
 * a gain matching "the damage.", and a regain of the same figure
 * after a necrotic damage clause (a vampire whose heal sentence the
 * attack reader cuts off at the charm save). Read on the whole text at the point every action kind passes through. The
 * subject is "it", "he", "she", a capitalised name, or any "the <words>" but the target, a creature or an ally. A named
 * type heals from that type's clauses only. A half heal ("equal to half ...") is a different amount and is not read.
 */
function fullAmountHealClauses(text: string, damage: DamageClause[]): DamageClause[] {
  const heal = text.match(/(?:^|[\s,.;])((?:it|he|she|the [a-z][a-z' -]*?|[A-Z][A-Za-z' -]*?)\s+(?:then\s+)?regains?\s+(?:a number of\s+)?(?:hit points?|\{@variantrule\s+Hit Points?[^}]*\})\s+equal to\s+(?:(that amount)|the amount of (?:(\w+)\s+)?damage (?:dealt|taken)|the (?:(\w+)\s+)?damage(?:\s+(?:dealt|taken))?)(?=[\s.,;]|$))/i);
  if (!heal || /^the (?:target|creature|ally)\b|\b(?:target|creature|ally)\s+(?:then\s+)?regains?\b/i.test(heal[1])) return [];
  const sentence = text.slice(text.lastIndexOf(".", heal.index ?? 0) + 1, (heal.index ?? 0) + heal[0].length);
  const named = heal[2]
    ? sentence.match(/\bequal to the (\w+) damage (?:dealt|taken)\b/i)?.[1]
    : heal[3] ?? heal[4];
  const type = named && damageTypes.includes(named.toLowerCase()) ? named.toLowerCase() : undefined;
  if (heal[2] && !type) return [];
  return damage.filter((clause) => !type || clause.type === type);
}

/** The sentence that prints damage for removing a lodged thing (a bolt pulled from a creature deals slashing damage to
 * that creature): matched from the sentence's start. */
const REMOVAL_DAMAGE_RE = /[^.]*\bis removed\b[^.]*\btakes\b[^.]*\{@damage/i;

/** Sentences of a save action that print damage under a trigger later than the save: an oiled creature that is burned
 * before the oil dries, lit oil left in the area, and a target that willingly
 * moves before a device vanishes. Their dice are not the save's damage (they
 * were dealt on the failed save, and halved on a made one). Each is matched as a whole sentence after a full stop. */
const LATER_TRIGGER_SAVE_DAMAGE_RES = [
  /(?<=\. )Any creature affected by [^.]*? that takes [a-z]+ damage before [^.]*\btakes an additional\b[^.]*\{@damage[^.]*\./i,
  /(?<=\. )If the oil that remains [^.]*\{@damage[^.]*\./i,
  /(?<=\. )If the target willingly moves [^.]*\btakes\b[^.]*\{@damage[^.]*\./i,
];
const withoutLaterTriggerDamage = (text: string): string => LATER_TRIGGER_SAVE_DAMAGE_RES.reduce((out, re) => out.replace(re, ""), text);

export function parseAction(raw: { name: string; entries?: unknown }, timing: Timing, sourceRef: string, ungatedPrefix = false): ParseOutcome {
  const random = parseRandomAction(raw, timing, sourceRef);
  if (random.option) return random;
  const sourceText = flattenEntries(raw.entries);
  const text = withoutSelfCost(withoutNonFoeDamage(withoutCriticalClause(withoutTargetEscapeAttempt(sourceText))));
  const name = cleanName(raw.name);
  let uses = parseUses(raw.name);
  const prerequisites = targetPrerequisites(text);
  const requiresTargetCondition = requiredTargetCondition(text, prerequisites);
  const allRequiredTargetConditions = prerequisites.all;
  const requiresAnyTargetConditions = prerequisites.any.length > 1 ? prerequisites.any : undefined;
  const seeingTargetMissingConditions = unseeingTargetExempt(text) && !prerequisites.missing.includes("blinded")
    ? [...prerequisites.missing, "blinded"]
    : prerequisites.missing;
  // "Each creature whose space the cube enters for the first time during this move ... When the cube moves, the
  // engulfed target moves with it": a creature already inside is carried along, so its space is not entered again
  // and the save is not repeated on it. The hold is the Restrained the engulfing gives.
  const carriesEngulfed = /whose space the [\w ]+? enters for the first time during this move/i.test(text)
    && /\bengulfed target moves with it\b/i.test(text);
  const allRequiredTargetMissingConditions = carriesEngulfed && !seeingTargetMissingConditions.includes("restrained")
    ? [...seeingTargetMissingConditions, "restrained"]
    : seeingTargetMissingConditions;
  // A finisher whose prerequisite is a hold (one creature Grappled by the source) states
  // no range of its own, and the 120-ft default let the movement AI value it from across the
  // field. Contact is implied by the prerequisite.
  const contactRange = [requiresTargetCondition, ...prerequisites.all, ...prerequisites.any]
    .some((condition) => condition && CONTACT_PREREQUISITES.has(condition))
    ? 5
    : undefined;
  const cannotAttackWhileAttached = (
    /\bcan't make [^.]* attacks while attached\b|\bwhile attached[^.]*can't make|\bwhile [^,.]{1,50} is attached,?[^.]*can't make [^.]* attacks/i.test(text)
    && !/\bcan't make [^.]* attacks against other targets\b/i.test(text)
  );
  const choiceRiders = parseChoiceRiders(text);
  let action: CombatAction | undefined;

  // 2024 stat blocks use {@atkr m}/{@atkr r}; legacy ones use {@atk mw|rw|ms|rs} (weapon/spell melee/ranged).
  const attackTag = findTags(text, "atkr")[0] || findTags(text, "atk")[0];
  // A bare bonus right after the tag is the same attack roll as {@hit N}: a spear that prints "{@atk m,r} +9, reach 10
  // ft." fell through to a never-missing autohit.
  const hit = text.match(/\{@hit\s+([+-]?\d+)\}/i)
    || (attackTag ? text.slice(attackTag.end).match(/^\s*([+-]\d+)(?=,|\s+to hit\b)/i) : null);
  if (attackTag && hit) {
    const taggedSecondarySave = text.match(/\{@actSave\s+([a-z]{3})\}\s+\{@dc\s+(\d+)\}/i);
    const proseSecondarySave = taggedSecondarySave ? null : text.match(/(?:must\s+(?:make|succeed on)|makes?)\s+(?:a\s+)?\{@dc\s+(\d+)\}\s+([A-Za-z]+)\s+saving throw/i);
    const chainedSave = taggedSecondarySave || proseSecondarySave;
    // A save printed after a rest or an hour has passed (`REST_GATE_RE`) is not the hit's: no duel reaches it. Read as the
    // attack's chained save, a bite rolled it on every hit, dealt the delayed effect's die as untyped damage and
    // put the Poisoned the print gives outright behind it.
    const delayedFrom = restGatedFrom(text);
    const chained = chainedSave && delayedFrom >= 0 && (chainedSave.index ?? -1) >= delayedFrom ? null : chainedSave;
    // A lightning bolt that arcs from the target to a second creature, which must succeed on
    // a Dexterity saving throw, belongs to somebody else. In a duel there is nobody
    // else, so folding it in gave the creature a free second helping of its own damage.
    // The plural too: as many as three further creatures chosen by the creature,
    // each visible within 30 feet of the target and each making a Dexterity saving throw, and
    // that put the other creatures' 5d8 on the one foe.
    const chainedAt = chained?.index ?? -1;
    const secondarySave = chained !== null && chainedAt >= 0
      && /\b(?:the\s+)?(?:second|other|another)\s+(?:creature|target)s?\b/i.test(text.slice(Math.max(0, chainedAt - 220), chainedAt))
      ? null
      : chained;
    const secondaryAt = secondarySave?.index ?? -1;
    // Truncate at the chained clause either way: whoever its damage belongs to, it is not part
    // of the on-hit damage of this attack.
    // A sentence that deals damage to a creature when a lodged bolt is removed from it is dealt when the lodged thing is
    // taken out, not on the hit: the on-hit damage stops at the
    // sentence that prints it.
    const hitText = chainedAt >= 0 ? text.slice(0, chainedAt) : text;
    const removalAt = hitText.search(REMOVAL_DAMAGE_RE);
    const damage = parseDamageClauses(removalAt >= 0 ? hitText.slice(0, removalAt) : hitText);
    const secondaryDamage = secondaryAt >= 0 ? parseDamageClauses(text.slice(secondaryAt)) : [];
    const riders = parseRiders(text, true);
    if (!damage.length && !riders.some((r) => r.condition !== "speedCut")) return { reason: "attack has no parseable damage" };
    const modes = attackTag.body.split(",").map((s) => s.trim().toLowerCase());
    const melee = modes.some((m) => m.startsWith("m"));
    const parsedRange = parseRange(text);
    // A ranged mode with no stated range (a spear that says only "reach 5 ft.")
    // would otherwise inherit the 120-foot default and turn a thrown spear into a longbow. The
    // mode is dropped instead, which can only understate the creature; `coverage.md` lists it.
    // A melee-only tag whose header prints "reach N ft. or range M ft." (every other print of the wording tags both
    // modes) also gets the ranged
    // mode. The text is taken over the tag. Only the header before {@h} is read.
    const printedRangedMode = melee && !modes.some((m) => m.startsWith("r"))
      && MELEE_OR_RANGE_RE.test(text.split("{@h}")[0]) && parsedRange.range !== undefined;
    const ranged = (modes.some((m) => m.startsWith("r")) && (parsedRange.range !== undefined || !melee)) || printedRangedMode;
    const secondaryAbility = taggedSecondarySave
      ? longAbility[taggedSecondarySave[1].toLowerCase()]
      : proseSecondarySave ? longAbility[proseSecondarySave[2].toLowerCase()] : undefined;
    const secondaryDc = taggedSecondarySave
      ? Number(taggedSecondarySave[2])
      : proseSecondarySave ? Number(proseSecondarySave[1]) : undefined;
    const secondaryRiders = secondarySave && secondaryDamage.length
      ? riders.filter((r) => r.save?.ability === secondaryAbility && r.save?.dc === secondaryDc)
      : [];
    action = {
      kind: "attack",
      toHit: Number(hit[1]),
      damage,
      riders: riders.filter(
        (r) => !choiceRiders.some((c) => c.condition === r.condition) && !secondaryRiders.includes(r),
      ),
      choiceRiders,
      // A name that marks a magic weapon ("+1 Shortsword", "Foremother (+1 Scimitar)", "Magic Staff") makes the
      // attack magical even when its text never says so.
      magical: magicalText(text) || modes.some((m) => m.endsWith("s"))
        || /(?:^|[\s(])\+\d\b|\bmagic(?:al)?\b/i.test(raw.name),
      melee,
      ranged,
      reach: melee ? parseReach(text) : undefined,
      range: ranged ? parsedRange.range : melee ? parseReach(text) : undefined,
      longRange: ranged ? parsedRange.longRange : undefined,
      advantageWhen: attackHeaderAdvantage(text),
      requiresTargetCondition,
      requiresTargetConditions: allRequiredTargetConditions.length > 1 ? allRequiredTargetConditions : undefined,
      requiresAnyTargetConditions,
      targetTypes: explicitTargetTypes(text),
      requiresTargetMissingConditions: ([
        ...allRequiredTargetMissingConditions,
        ...(cannotAttackWhileAttached ? ["attached"] : []),
        ...(/\bcan swallow one creature at a time\b/i.test(text) ? ["swallowed"] : []),
      ].filter((condition, index, all) => all.indexOf(condition) === index).length
        ? [
          ...allRequiredTargetMissingConditions,
          ...(cannotAttackWhileAttached ? ["attached"] : []),
          ...(/\bcan swallow one creature at a time\b/i.test(text) ? ["swallowed"] : []),
        ].filter((condition, index, all) => all.indexOf(condition) === index)
        : undefined),
      requiresSight: requiresSight(text),
      targetMaxSize: targetDescriptorMaxSize(text) ?? moveThroughMaxSize(text),
      extraSave: secondarySave && secondaryDamage.length ? {
        ability: secondaryAbility!,
        dc: secondaryDc!,
        damage: secondaryDamage,
        onSuccess: halfOnSuccess(text.slice(secondaryAt)) ? "half" : "none",
        riders: secondaryRiders,
        onMiss: false,
      } : undefined,
    };
    if (/(?:hit points?|(?:\{@variantrule\s+Hit Points?[^}]*\})) maximum (?:is reduced|decreases) by an amount equal to (?:the )?damage taken/i.test(text)) {
      for (const clause of action.damage) clause.reducesMaxHp = true;
    }
    // The typed form of a hit point maximum reduction: a sentence that lowers the target's maximum hit points by the
    // necrotic damage taken, printed after a chained save for something else (a
    // vampire's bite, whose save is the charm's). The on-hit damage is parsed from the text before that save, so the
    // sentence was never seen. Not read when the reduction is the failure branch of its own save (a Constitution save
    // whose failure lowers the maximum): the boolean
    // has no save, and those cases are left for later.
    const typedReduction = text.match(TYPED_MAX_HP_REDUCTION_RE);
    if (typedReduction && !/\bsaving throw\b/i.test(text.slice(text.lastIndexOf(". ", typedReduction.index!) + 1, typedReduction.index!))) {
      for (const clause of action.damage) if (clause.type === typedReduction[1].toLowerCase()) clause.reducesMaxHp = true;
    }
    // A hit point maximum reduction behind its own save, rolled after the hit's damage (several creatures, some of which
    // compiled nothing, and some whose untyped wording was read just above with the save
    // ignored). The clauses of the named type carry it, every on-hit clause when none is named.
    const ownSaveReduction = text.match(OWN_SAVE_MAX_HP_REDUCTION_RE);
    const ownSaveAbility = ownSaveReduction ? longAbility[ownSaveReduction[2].toLowerCase()] : undefined;
    if (ownSaveReduction && ownSaveAbility) {
      const type = ownSaveReduction[4]?.toLowerCase();
      for (const clause of action.damage) {
        if (type && clause.type !== type) continue;
        clause.reducesMaxHp = true;
        if (ownSaveReduction[3]) clause.reducesMaxHpHalf = true;
        clause.reducesMaxHpSave = { ability: ownSaveAbility, dc: Number(ownSaveReduction[1]) };
      }
    }
    // Half the damage of one type, no save of its own: on the hit (a sword) or in the chained
    // save's damage (a heal of half the poison damage taken, the poison being that save's failure).
    const halfReduction = ownSaveReduction ? null : text.match(HALF_MAX_HP_REDUCTION_RE);
    if (halfReduction) {
      for (const clause of [...action.damage, ...(action.extraSave?.damage ?? [])]) {
        if (clause.type !== halfReduction[1].toLowerCase()) continue;
        clause.reducesMaxHp = true;
        clause.reducesMaxHpHalf = true;
      }
    }
    // Dice of its own on a hit (a tentacle attack): not damage, and not sized by any clause.
    const ownDiceReduction = text.match(OWN_DICE_MAX_HP_REDUCTION_RE);
    if (ownDiceReduction) action.maxHpReduction = { dice: parseDice(ownDiceReduction[1]) };
    // "...and the pirate has Advantage on the next attack roll it makes before the end of this turn": the attacker's own.
    if (/\band the [\w' -]+? has (?:\{@variantrule )?Advantage(?:\|[^}]*)?\}? on the next attack roll it makes before the end of this turn\b/i.test(text)) {
      action.selfRidersOnHit = [{ condition: "pressing", duration: "endOfTargetTurn", endsThisTurn: true,
        rollEffects: [{ roll: "attack", mode: "advantage", nextRollOnly: true }] }];
    }
    // On a hit the creature pulls the target (up to) some feet straight toward itself. The size gate is the clause's own:
    // "If the target is a Huge or smaller creature, [it] pulls the target up to 25 feet straight toward itself".
    const hitPull = text.match(/\bpulls the target (up to )?(\d+) feet straight toward itself\b/i);
    if (hitPull) {
      const sentence = text.slice(text.lastIndexOf(". ", hitPull.index!) + 1, hitPull.index!);
      action.riders.push({ condition: "forcedPull", pull: Number(hitPull[2]), ...(hitPull[1] ? { pullUpTo: true as const } : {}), targetMaxSize: targetMaxSize(sentence), duration: "endOfTargetTurn" });
    }
    // And the push: "the target is pushed up to 15 feet straight away from the giant".
    const hitPush = text.match(/\btarget is pushed up to (\d+) feet straight away\b/i);
    if (hitPush && !action.riders.some((r) => r.push)) action.riders.push({ condition: "forcedPush", push: Number(hitPush[1]), duration: "endOfTargetTurn" });
    // The same in the active voice, with the clause's own size gate: "If the target is a Medium or smaller creature, the
    // satyr pushes the target up to 10 feet straight away from itself".
    const activePush = text.match(/\bpushes the target up to (\d+) feet straight away from itself\b/i);
    if (activePush && !action.riders.some((r) => r.push)) {
      const sentence = text.slice(text.lastIndexOf(". ", activePush.index!) + 1, activePush.index!);
      action.riders.push({ condition: "forcedPush", push: Number(activePush[1]), pushUpTo: true, targetMaxSize: targetMaxSize(sentence), duration: "endOfTargetTurn" });
    }
    // A save the hit forces whose later failures do something else: "First Failure: The target has the Poisoned condition.
    // ... Subsequent Failures: The Poisoned target's Hit Point maximum decreases by 5 (1d10)." The first failure is the
    // rider; a failure by a target that already has the condition lowers the maximum by the dice.
    const laterFailures = text.match(/\{@actSave (\w+)\} \{@dc (\d+)\}[^]*?Subsequent Failures: The \{@condition (\w+)[^}]*\} target's Hit Point maximum decreases by \d+ \(\{@dice ([^}]+)\}\)/i);
    if (laterFailures && !action.maxHpReduction) {
      action.maxHpReduction = { dice: parseDice(laterFailures[4]), save: { ability: longAbility[laterFailures[1].toLowerCase()] as Ability ?? laterFailures[1].toLowerCase() as Ability, dc: Number(laterFailures[2]) }, requiresTargetCondition: laterFailures[3].toLowerCase() };
    }
    action = withSaveMarginTier(text, action);
    action = randomConditionBranches(text, action) || inlineRandomTiers(text, action) || action;
  }

  // 2024 stat blocks use {@actSave dex} {@dc N}; legacy ones use prose "{@dc N} Dexterity saving throw".
  const saveTag = text.match(/\{@actSave\s+([a-z]{3})\}\s+\{@dc\s+(\d+)\}/i);
  const saveProse = saveTag ? null : text.match(/\{@dc\s+(\d+)\}\s+([A-Za-z]+)\s+saving throw/i);
  const saveAbility = saveTag ? longAbility[saveTag[1].toLowerCase()] : saveProse ? longAbility[saveProse[2].toLowerCase()] : undefined;
  const saveDc = saveTag ? Number(saveTag[2]) : saveProse ? Number(saveProse[1]) : undefined;
  if (!action && saveAbility && saveDc !== undefined) {
    // A consume-life action: one living creature the wisp can see within 5 feet that has 0 Hit Points, where on a failure
    // the target dies and the wisp regains Hit Points (the Will-o'-Wisp's Consume Life). Its only
    // target in a duel is a troll-rule regenerator held at 0 HP, and the existing instant-death threshold says exactly that:
    // `instantDeathHpThreshold: 0`, no damage (the 3d6 is the wisp's own regain, which was read as damage).
    const downedTarget = /\bthat has 0 (?:\{@variantrule Hit Points[^}]*\}|Hit Points?)\.\s*\{@actSaveFail\}\s*The target dies\b/i.test(text);
    const killRegain = text.match(/The target dies, and the [a-z' -]+ regains \d+ \(\{@dice ([^}]+)\}\) (?:\{@variantrule Hit Points[^}]*\}|Hit Points)/i);
    // A failure branch that is a reduction of the maximum by dice of its own (an energy drain). The dice are the
    // reduction; read as damage they dealt 4d6 untyped.
    const failureDiceReduction = text.match(FAILURE_DICE_MAX_HP_REDUCTION_RE);
    const maxHpReduction: MaxHpReduction | undefined = failureDiceReduction ? { dice: parseDice(failureDiceReduction[1]), save: "action" } : undefined;
    // Delayed damage on a failed save: the failure line gives one damage amount at once and a second amount of the same type
    // when the target's next turn ends, and the success line says only the initial damage is halved. The delayed dice are not
    // part of the save's damage (they were dealt at once, and halved on a success): they become one end-of-turn tick on
    // an `afflicted` holder, applied on a failure only. The holder lasts until the end of the source's next turn, not of
    // the target's: the engine ends an `endOfTargetNextTurn` condition before that turn's end-of-turn tick
    // (`resolveEndTurnConditions` runs before `resolveConditionDamage`), so it would never tick. In a duel exactly one
    // end of the target's turn falls before the end of the source's next turn: one tick, at the printed time.
    const delayedDamage = text.match(DELAYED_NEXT_TURN_DAMAGE_RE);
    // Damage printed under a later trigger is left out of the save's own damage.
    const damage = downedTarget ? [] : parseDamageClauses(withoutLaterTriggerDamage(failureDiceReduction ? text.replace(failureDiceReduction[0], "{@actSaveFail} ") : delayedDamage ? text.replace(delayedDamage[0], "") : text));
    let riders = parseRiders(text, true);
    if (/gains 1 \{@condition Exhaustion\} level/i.test(text)) riders.push({ condition: "exhaustion", duration: "permanent" });
    if (/can't take Reactions; its Speed is halved;.*either an action or a Bonus Action/i.test(text)) {
      riders.push({ condition: "slowed", duration: "endOfTargetNextTurn", speedHalved: true, noReactions: true, actionOrBonus: true });
    }
    if (delayedDamage) riders.push({ condition: "afflicted", duration: "endOfSourceNextTurn", endTurnDamage: [{ dice: parseDice(delayedDamage[1]), type: normalizeDamageType(delayedDamage[2].toLowerCase()) }] });
    // A timed Disadvantage joins an option that compiles without it; alone it
    // does not make one. A few skipped features print the wording and nothing else that compiles (an aura or similar
    // feature): they stay skipped.
    // A partial Speed cut alone does not make a save action an option either, so such an option stays skipped, as it was
    // with its roll penalty alone.
    if (!damage.length && !riders.some((r) => r.condition !== "rollDisadvantage" && r.condition !== "speedCut") && !downedTarget && !maxHpReduction) return { reason: "save action has no parseable damage" };
    riders = riders.map((r) => r.duration === "saveEndsEachTurn" && !r.save ? { ...r, save: { ability: saveAbility, dc: saveDc } } : r);
    // A parenthetical saying one kind of creature automatically succeeds on the save
    // names a kind that is a tag, not a creature type, so `explicitExcludedTargetTypes` never read
    // it. With no damage the riders are the whole effect, so the exemption goes on each rider (`excludedTargetTags`, read
    // by the engine beside the rider's other gates). A save that also deals damage carries it on the action
    // (`SaveAction.excludedTargetTags`) when a success does nothing: such a creature is then no target at all.
    const succeedingTags = autoSucceedTags(text);
    const exemptTags = damage.length ? undefined : succeedingTags;
    const actionExemptTags = damage.length && !halfOnSuccess(text) ? succeedingTags : undefined;
    if (exemptTags) riders = riders.map((r) => ({ ...r, excludedTargetTags: [...new Set([...(r.excludedTargetTags ?? []), ...exemptTags])] }));
    const parsedRange = parseRange(text);
    action = {
      kind: "save",
      ability: saveAbility,
      dc: saveDc,
      damage,
      onSuccess: halfOnSuccess(text)
        ? "half"
        : damagePrintedBeforeSave(text, saveTag?.index ?? saveProse?.index ?? 0)
          ? "full"
          : "none",
      riders: riders.filter((r) => !choiceRiders.some((c) => c.condition === r.condition)),
      choiceRiders,
      magical: magicalText(text),
      range: /one creature in the swarm's space/i.test(text) ? 0 : parsedRange.range ?? boundedTargetRange(text) ?? contactRange,
      targetTypes: explicitTargetTypes(text),
      excludedTargetTypes: explicitExcludedTargetTypes(text),
      ...(actionExemptTags ? { excludedTargetTags: actionExemptTags } : {}),
      requiresTargetCondition,
      requiresTargetConditions: allRequiredTargetConditions.length > 1 ? allRequiredTargetConditions : undefined,
      requiresAnyTargetConditions,
      requiresTargetMissingConditions: allRequiredTargetMissingConditions.length ? allRequiredTargetMissingConditions : undefined,
      ...(carriesEngulfed ? { entersTargetSpace: true as const } : {}),
      requiresSight: requiresSight(text),
      targetMaxSize: targetDescriptorMaxSize(text) ?? moveThroughMaxSize(text) ?? jumpDestinationMaxSize(text),
      ...(jumpToTarget(text) ? { jumpsToTarget: jumpToTarget(text) } : {}),
      instantDeathHpThreshold: downedTarget ? 0 : instantDeathThreshold(text),
      ...(downedTarget && killRegain ? { selfHealOnKill: parseDice(killRegain[1]) } : {}),
      maxHpReduction,
      ...printedConcentration(text, riders),
    };
    // A hit point maximum reduction that waits on the action's save while the damage does not: the target takes necrotic
    // damage, and must succeed on a Constitution saving throw or lose maximum hit points equal to
    // half the necrotic damage taken. The save is the action's own (`onSuccess: "full"`), so the clause names it rather
    // than repeating it.
    const savedReduction = action.onSuccess === "full" ? text.match(OWN_SAVE_MAX_HP_REDUCTION_RE) : null;
    if (savedReduction && Number(savedReduction[1]) === saveDc && longAbility[savedReduction[2].toLowerCase()] === saveAbility) {
      const type = savedReduction[4]?.toLowerCase();
      for (const clause of action.damage) {
        if (type && clause.type !== type) continue;
        clause.reducesMaxHp = true;
        if (savedReduction[3]) clause.reducesMaxHpHalf = true;
        clause.reducesMaxHpSave = "action";
      }
    }
    // Sent to a demiplane until the copy ends, "at which point it reappears in an unoccupied space of the dragon's choice
    // within 120 feet of the dragon": the reappearance rides on the copy that marks the absence. (The print's
    // "re\u00adappears" carries a soft hyphen.)
    const reappears = text.match(/transported to a harmless demiplane until the start of [^.]*?next turn, at which point it re\u00ad?appears in an unoccupied space of [^.]*?choice within (\d+) feet/i);
    const absent = reappears ? action.riders.find((r) => r.duration === "startOfSourceNextTurn") : undefined;
    if (absent) absent.reappearWithin = Number(reappears![1]);
    const push = text.match(/pushed up to (\d+) feet straight away/i);
    if (push) action.riders.push({ condition: "forcedPush", push: Number(push[1]), duration: "endOfTargetTurn" });
    // A push the print gives a successful save only: "Success: Half damage, and the target is pushed 5 feet straight away".
    const savedPush = text.match(/\{@actSaveSuccess\}[^.]*?\btarget is pushed (\d+) feet straight away\b/i);
    if (savedPush) action.riders.push({ condition: "forcedPush", push: Number(savedPush[1]), duration: "endOfTargetTurn", appliesOnSuccess: true, onlyOnSuccess: true });
    // A failed save that drags the target in: "If the target is Large or smaller, the devil moves the target up to 30 feet
    // straight toward itself."
    const savePull = text.match(/\bmoves the target up to (\d+) feet straight toward itself\b/i);
    if (savePull) {
      const sentence = text.slice(text.lastIndexOf(". ", savePull.index!) + 1, savePull.index!);
      action.riders.push({ condition: "forcedPull", pull: Number(savePull[1]), pullUpTo: true, targetMaxSize: targetMaxSize(sentence), duration: "endOfTargetTurn" });
    }
    action = withSaveMarginTier(text, action);
    action = randomConditionBranches(text, action) || inlineRandomTiers(text, action) || rolledTypeBranches(text, action) || action;
  }

  if (!action && /and its light have the \{@condition Invisible\} condition/i.test(text)
    && /Concentration ends on this effect/i.test(text)) {
    action = { kind: "selfbuff", condition: "invisible", concentration: true, breaksOnAttackOrSpell: true };
  }
  // "Magical Darkness fills a 15-foot Emanation originating from the darkmantle. This effect lasts while the darkmantle
  // maintains Concentration on it, up to 10 minutes. Darkvision can't penetrate this area, and no light can illuminate
  // it." The area moves with its maker, so the maker is unseen wherever it is, inside the radius or from outside it.
  if (!action && /\bMagical Darkness fills a \d+-foot (?:\{@variantrule )?Emanation[^.]*\boriginating from the\b/i.test(text)
    && /\bmaintains (?:\{@status )?Concentration\b/i.test(text)) {
    action = { kind: "selfbuff", condition: "invisible", darkness: true, concentration: true, breaksOnAttackOrSpell: false };
  }
  // Reel is an ordered, damage-less step in the Roper's Multiattack.
  const pull = text.match(/pulls each creature \{@condition Grappled\} by it up to (\d+) feet straight toward it/i);
  const webPull = text.match(/pulls one creature within (\d+) feet[^.]*\{@condition Restrained\} by its Web Strand up to (\d+) feet/i);
  if (!action && webPull) action = { kind: "autohit", damage: [], magical: false, pull: Number(webPull[2]), range: Number(webPull[1]), requiresTargetCondition: "restrained" };
  if (!action && pull) action = { kind: "autohit", damage: [], magical: false, pull: Number(pull[1]), requiresTargetCondition: "grappled" };
  // "If the roc has a creature Grappled, the roc flies up to half its Fly Speed without provoking Opportunity Attacks and
  // drops that creature." The fall is the effect (`AutoHitAction.liftAndDrop`).
  const liftAndDrop = text.match(/^If the [a-z' -]+ has a creature \{@condition Grappled[^}]*\}, the [a-z' -]+ flies up to (half )?its Fly Speed without provoking Opportunity Attacks and drops that creature\./i);
  if (!action && liftAndDrop) action = { kind: "autohit", damage: [], magical: false, requiresTargetCondition: "grappled", liftAndDrop: liftAndDrop[1] ? 0.5 : 1 };
  if (!action && /gains 1 \{@condition Exhaustion\} level/i.test(text) && saveAbility && saveDc) {
    action = { kind: "save", ability: saveAbility, dc: saveDc, damage: [], onSuccess: "none", magical: false,
      range: parseRange(text).range ?? boundedTargetRange(text), requiresSight: requiresSight(text),
      riders: [{ condition: "exhaustion", duration: "permanent" }] };
  }
  if (!action && /^Shimmering Shield$/i.test(raw.name)) action = {
    kind: "selfbuff", condition: "shimmeringShield", duration: "endOfSourceNextTurn", breaksOnAttackOrSpell: false,
    acAdjustment: 2, selfTempHp: { dice: parseDice("3d6") },
  };
  if (!action && timing === "bonus") {
    const chargeMove = text.match(/moves up to (half )?(?:its |the )?(?:Speed|Burrow Speed)[^.]*toward/i);
    const leapMove = text.match(/jumps up to (\d+) feet by spending (\d+) feet of movement/i);
    // "The weretiger moves up to its Speed without provoking Opportunity Attacks" (Prowl) is a Dash and a Disengage by
    // another wording. The Hide it allows afterwards is stealth, as Nimble Escape's is.
    const freeMove = /^The [a-z' -]+ moves up to its Speed without provoking (?:\{@action )?Opportunity Attacks?/i.test(text);
    const dash = freeMove || /takes the Dash and Disengage actions|takes the Dash(?: or|,) Disengage(?:, or Hide)? action/i.test(text);
    // "The goblin takes the Disengage or Hide action" (Nimble Escape): a Disengage with no Dash beside it.
    const disengageOnly = !dash && /takes the Disengage(?: or Hide)? action\b/i.test(text);
    if (disengageOnly) action = {
      kind: "selfbuff", condition: "disengaged", duration: "endOfTargetTurn", breaksOnAttackOrSpell: false,
      movement: { mode: "dash", distance: 0, noProvoke: true },
    };
    else if (chargeMove || leapMove || dash) action = {
      kind: "selfbuff", condition: /^Hasten\b/i.test(raw.name) ? "hastened" : "bonusMobility",
      duration: "endOfTargetTurn", breaksOnAttackOrSpell: false,
      movement: leapMove ? { mode: "leap", distance: Number(leapMove[1]), cost: Number(leapMove[2]) }
        : chargeMove ? { mode: "charge", fraction: chargeMove[1] ? 0.5 : 1, requiresSight: /enemy it can see/i.test(text), requiresSense: /enemy it can sense/i.test(text) }
        : { mode: "dash", noProvoke: freeMove || /Dash and Disengage/i.test(text) },
    };
  }
  // Giant Frog: no immediate damage, and a single source-next-turn packet followed by disgorging survivors.
  const frogTick = text.match(/At the end of the [^.]+'s next turn, the swallowed target takes \d+ \(\{@damage ([^}]+)\}\) Acid damage/i);
  if (!action && frogTick && /the frog disgorges it/i.test(text)) {
    const riders = parseRiders(text, true).filter(r => r.condition !== "prone");
    const swallowed = riders.find(r => r.condition === "swallowed")!;
    swallowed.delayedDamage = { damage: [{ dice: parseDice(frogTick[1]), type: "acid" }], clock: "source", disgorge: true };
    action = { kind: "autohit", damage: [], riders, magical: false, range: 5, targetMaxSize: 1, requiresTargetCondition: "grappled" };
  }
  if (!action && /\benters? a rage\b/i.test(text)) {
    action = {
      kind: "selfbuff",
      condition: "raging",
      breaksOnAttackOrSpell: false,
      resistDamage: /resistance to bludgeoning, piercing, and slashing damage/i.test(text)
        ? ["bludgeoning", "piercing", "slashing"]
        : undefined,
    };
  }
  if (!action && /\bhas \{@variantrule Advantage[^}]*\} on the next attack roll\b/i.test(text)) {
    action = {
      kind: "selfbuff",
      condition: "aiming",
      breaksOnAttackOrSpell: false,
    };
  }
  const unsupportedSelfHealing = /\b(?:target|another creature|each creature|ally)\b[^.]{0,80}\b(?:magically )?regains?\b/i.test(text)
    || /\bwith 0 (?:\{@variantrule )?hit points\b/i.test(text)
    || /\bif [^.]{0,100}\bdies\b[^.]{0,100}\bregains?\b/i.test(text)
    || /\bonly if (?:it|the [a-z' -]+) is retracted\b/i.test(text)
    || /\buses? [A-Z][A-Za-z' -]+ and regains?\b/.test(text)
    // A heal paid only when the option's own damage lands is that damage clause's `healsAttackerFlat`, not a self-heal:
    // a teleport that deals psychic damage to creatures near it and then, when the damage hits any creature,
    // heals the creature for 80 hit points. Read as a self-heal it healed 80 every turn and dealt nothing.
    || DAMAGE_GATED_HEAL_RE.test(text);
  if (!action && !unsupportedSelfHealing) {
    const healingDice = text.match(
      /\b(?:it|the [a-z][a-z' -]{0,60}|[A-Z][A-Za-z' -]{1,60})\s+(?:instantly )?regains?\s+\d+\s+\(\{@dice\s+([^}]+)\}\)\s+(?:\{@variantrule\s+Hit Points?[^}]*\}|hit points?)/i,
    );
    // A heal that names the creature or a second creature it touches: in a duel the
    // other creature is the foe, so the heal is the creature's own.
    const flatHealing = healingDice ? null : text.match(
      /\b(?:it|the [a-z][a-z' -]{0,60}|[A-Z][A-Za-z' -]{1,60})(?:, or one creature (?:it|he|she|they) touches,)?\s+(?:instantly )?regains?\s+(\d+)\s+(?:\{@variantrule\s+Hit Points?[^}]*\}|hit points?)/i,
    );
    if (healingDice || flatHealing) {
      action = {
        kind: "selfheal",
        healing: healingDice ? parseDice(healingDice[1]) : { n: 0, d: 1, mod: Number(flatHealing![1]) },
      };
    }
  }

  // Some target debuffs have neither an attack roll nor a save. Treat them as
  // automatic rider actions so the normal targeting, range, timing, and
  // condition-usefulness logic can schedule them (for example, an undead
  // bonus-action curse).
  if (!action && /\bcurses?\s+(?:one|a|the)\s+(?:creature|target)\b/i.test(text)) {
    const parsedRange = parseRange(text);
    action = {
      kind: "autohit",
      damage: [],
      riders: [{ condition: "cursed", duration: "permanent" }],
      magical: magicalText(text),
      range: parsedRange.range,
      requiresTargetMissingConditions: ["cursed"],
      requiresSight: requiresSight(text),
    };
  }

  // A conjured weapon states its attack bonus in prose rather than with an {@atk} tag: a creature
  // conjures a floating, spectral dagger that makes a melee spell attack ({@hit 10} to hit)
  // on a creature near the dagger (5 feet). Without a tag the whole option was
  // skipped, so a high-CR creature simply lost a bonus-action attack.
  if (!action && !attackTag && hit && /\b(?:melee|ranged) spell attack\b/i.test(text)) {
    const damage = parseDamageClauses(text);
    if (damage.length) {
      // The dagger is conjured anywhere within its stated distance and attacks from there, so
      // that distance is the option's reach, not the caster's.
      const conjured = Number(text.match(/within\s+(\d+)\s+feet of itself/i)?.[1]);
      action = {
        kind: "attack",
        toHit: Number(hit[1]),
        damage,
        riders: parseRiders(text, true),
        magical: true,
        melee: false,
        ranged: true,
        range: Number.isFinite(conjured) ? conjured : parseRange(text).range,
        requiresSight: requiresSight(text),
      };
      // The dagger lasts for 1 minute, and on later turns the creature can spend a bonus action to move it up to 20 feet and
      // repeat the attack. The once-per-rest cost buys the conjuring,
      // not each swing, and a once-per-fight reading throws away the rounds that follow.
      if (/as a bonus action on later turns/i.test(text)) uses = { t: "atWill" };
    }
  }

  // An area whose whole duel effect is a timed heal block, with no
  // attack roll, save or damage: a cone, with a sentence that bars healing in that area until the creature's
  // following turn starts (a bonus action). A damage-less autohit with the
  // `healBlocked` rider the heal-block reader makes for a timed block, for the printed duration. `withHealBlock`
  // does not read a zone's subject ("Creatures in that area"), so the sentence is read here. The corpse it raises is not
  // modelled.
  const areaHealBlock = action ? null : text.match(AREA_HEAL_BLOCK_RE);
  if (areaHealBlock) {
    action = {
      kind: "autohit",
      damage: [],
      riders: [{ condition: "healBlocked", duration: areaHealBlock[1].toLowerCase() === "end" ? "endOfSourceNextTurn" : "startOfSourceNextTurn", blocksHealing: true }],
      magical: magicalText(text),
      range: parseRange(text).range,
      requiresSight: false,
    };
  }

  // Autohit: Magic Missile-style ({@damage} with no attack roll) and legacy "automatic hit" attacks
  // (a slam that is an automatic hit dealing flat force damage, with no {@hit}).
  if (!action && (text.includes("{@damage") || /automatic hit/i.test(text))) {
    const damage = parseDamageClauses(text);
    // Damage with no attack roll and no save is an attack on the opponent only if someone other
    // than the creature is in the sentence. Two actions were compiled as never-missing hits on the
    // foe though neither touches it: one whose 4d6 is what it takes
    // *itself* for ending a move inside stone, and one whose 2d6 lands on her own *ally* in
    // exchange for a blessing — a bonus action, so a free
    // 7 damage a turn to a CR 20. A duel has no ally, and self-harm is nobody's attack.
    const namesAnyoneElse = /\b(?:targets?|creatures?|foes?|enem(?:y|ies)|opponents?|victims?|anyone|humanoids?)\b/i.test(text);
    const hurtsAnAlly = /\ball(?:y|ies)\b[^.]{0,120}?\btakes?\b[^.]{0,40}\{@damage/i.test(text);
    if (damage.length && !/\{@hit|\{@actSave/i.test(text) && namesAnyoneElse && !hurtsAnAlly) {
      const melee = !!attackTag && attackTag.body.split(",").some((m) => m.trim().toLowerCase().startsWith("m"));
      const parsedRange = parseRange(text);
      // The damage lands as the Charmed condition applied by this creature ends on the target, so
      // the target must hold the condition this creature applied, and the condition is ended, not applied.
      const ended = endedOwnCondition(text);
      // Every creature slowed by this creature's own attack
      // takes damage: the damage lands only on a target under this creature's Speed cut (the `speedCut` condition its own
      // attack applies).
      const underOwnCut = /\bwhose speed is currently reduced by\b/i.test(text) ? "speedCut" : undefined;
      const autoRiders = parseRiders(text, true).filter((rider) => rider.condition !== ended);
      // A tick and a hit can be the same value written twice — a hag's crushing grapple deals
      // 9d6+5 on the hit and 9d6+5 a turn thereafter — so a clause a rider also carries is not
      // dropped on sight. But `parseDamageClauses` keeps recurring damage as an immediate hit
      // only "when nothing else does", and once a rider can carry it something else does: the
      // Giant Toad's Swallow states one damage value, the acid at the end of the toad's turns,
      // and dealing it on the swallow as well counted it twice.
      const ticks = new Set(autoRiders
        .flatMap((rider) => [...(rider.startTurnDamage ?? []), ...(rider.endTurnDamage ?? [])])
        .map((clause) => JSON.stringify(clause)));
      const allTicked = damage.length > 0 && damage.every((clause) => ticks.has(JSON.stringify(clause)));
      const repeated = text.match(/\b(?:creates?|conjures?|launches?|fires?)\s+(two|three|four|five|six|\d+)\s+[^.]+[.][^.]{0,100}\bEach\b/i);
      const count = repeated ? (numberWords[repeated[1].toLowerCase()] ?? Number(repeated[1]) ?? 1) : 1;
      action = {
        kind: "autohit",
        damage: allTicked ? [] : Array.from({ length: count }, () => damage).flat(),
        // An action with neither an attack roll nor a save still applies what it says it
        // applies. This constructor never asked, so every rider on a prose-only action was
        // dropped: a spear never cursed anything, which in turn made
        // a later option that needs a creature cursed by that spear unusable
        // for the whole fight, and its own Unconscious went with it.
        riders: autoRiders.length ? autoRiders : undefined,
        magical: magicalText(text),
        range: parsedRange.range ?? (melee ? parseReach(text) : boundedTargetRange(text) ?? contactRange),
        // A printed melee attack ("{@atk mw} automatic hit") is still a melee attack: an opportunity attack takes it.
        ...(melee ? { melee: true as const } : {}),
        requiresTargetCondition: requiresTargetCondition ?? ended ?? underOwnCut,
        requiresTargetConditions: allRequiredTargetConditions.length > 1 ? allRequiredTargetConditions : undefined,
        requiresAnyTargetConditions,
        requiresTargetMissingConditions: allRequiredTargetMissingConditions.length ? allRequiredTargetMissingConditions : undefined,
        targetTypes: explicitTargetTypes(text),
        excludedTargetTypes: explicitExcludedTargetTypes(text),
        requiresSight: requiresSight(text),
        instantDeathHpThreshold: instantDeathThreshold(text),
      };
    }
  }

  const teleport = parseTeleport(text);
  if (teleport) {
    // A jump rides along with whatever else the option does; when it is the only thing the
    // option does, it becomes the action.
    //
    // Except when the option's damage lives in *another* action it names: the creature makes one
    // named attack, and afterwards jumps as far as 30 feet. Compiling that as a bare
    // teleport is worse than not compiling it at all: it satisfies the parser, so the
    // reference resolver in `compile.ts` never runs, and a legendary action that should
    // stab-and-vanish becomes a vanish. `referencesAnotherAction` hands those back
    // unparsed, and the resolver reattaches the jump to the attack it names.
    if (!action && !referencesAnotherAction(text)) action = { kind: "teleport", teleport, magical: true };
    else if (action && action.kind !== "random" && action.kind !== "selfheal") {
      action.teleport = teleport;
      // A jump-first option's "unoccupied space it can see" is sight of the destination, not of the
      // target: the Solar's Radiant Teleport and other jumps with an emanation from the destination, or creatures
      // within 15 feet of it, name no sight of the creatures they hit. With the
      // destination's sight clause taken out, the print's own `requiresSight` test decides.
      //
      // Not only a jump-first option. Whatever the anchor, "unoccupied space it can see" is sight of
      // the landing: a burst around the space it left, a frightening teleport, a jump on a hit or miss, and
      // rebukes that name no sight of the creature they hit.
      // What is left may be sight of a point; the mode carries through.
      if ("requiresSight" in action && action.requiresSight) {
        const rest = requiresSight(text.replace(JUMP_SPACE_SIGHT_RE, " "));
        if (rest !== true) action.requiresSight = rest;
      }
    }
    // A heal that jumps first in the same sentence carries the jump, landing first: a creature that teleports up to 60
    // feet ... and regains 11 (2d10) Hit Points. A jump named in another sentence
    // (a teleport whose heal depends on damage at the destination) stays unread.
    else if (action && action.kind === "selfheal" && /\bteleports?\b[^.]*\bregains?\b/i.test(text)) action.teleport = { ...teleport, anchor: "destination" };
  }

  const selfTempHp = parseSelfTempHp(text);
  // A grant with nothing else to it is the whole action; otherwise it rides on the action that deals the damage.
  if (!action && selfTempHp?.dice) {
    action = { kind: "selfheal", healing: { n: 0, d: 1, mod: 0 }, selfTempHp };
    // "... gains 16 (2d10 + 5) Temporary Hit Points and has Advantage on attack rolls until the start of the giant's next turn."
    if (/\bTemporary (?:\{@variantrule )?Hit Points(?:\|[^}]*)?\}? and has (?:\{@variantrule )?Advantage(?:\|[^}]*)?\}? on attack rolls until the start of (?:the [a-z' -]+?|its) next turn\b/i.test(text)) {
      action.selfRiders = [{ condition: "attackAdvantage", duration: "startOfSourceNextTurn", rollEffects: [{ roll: "attack", mode: "advantage" }] }];
    }
  }
  if (!action) return { reason: "not an attack/save/autohit damaging action" };
  if (selfTempHp && action.kind !== "random" && action.kind !== "selfbuff" && action.kind !== "teleport" && action.kind !== "selfheal") {
    action.selfTempHp = selfTempHp;
  }
  // Applies to every action kind, so it sits at the one point they all pass through: one
  // clause rides an attack, another a breath save.
  if (petrifiesOnLethalDamage(text) && "damage" in action) {
    for (const clause of action.damage) clause.petrifiesOnLethalDamage = true;
  }
  if ("damage" in action) {
    for (const clause of fullAmountHealClauses(text, action.damage)) clause.healsAttacker = true;
  }
  const abilityDrain = parseAbilityDrain(text, action.kind);
  if (abilityDrain && (action.kind === "attack" || action.kind === "save")) action.abilityDrain = abilityDrain;
  const slay = parseSlayOnZeroHp(text);
  if (slay && (action.kind === "attack" || action.kind === "save")) action.slaysOnZeroHp = slay;
  const selfCost = parseSelfCost(sourceText);
  if (selfCost && (action.kind === "attack" || action.kind === "save" || action.kind === "autohit")) action.selfCost = selfCost;
  const perTurn = ungatedPrefix ? undefined : oncePerTurnGate(sourceText, name, sourceRef);
  if (perTurn && action.kind === "attack") {
    // The text before the gated effect compiles the attack without it; what the whole text adds is the gated effect.
    const base = parseAction({ name: raw.name, entries: [sourceText.slice(0, perTurn.from)] }, timing, sourceRef, true).option?.action;
    keyOncePerTurn(action, base, perTurn.key);
  }
  return { option: { name, sourceText, sourceRef, action, uses, timing } };
}

/**
 * A printed once-per-turn effect on an attack a Multiattack repeats. Three wordings:
 * - per weapon: the creature can cause a weapon to emit a burst of energy, and the weapon can do so only once per turn.
 *   The gated effect starts at the sentence "… can cause the …"; the key is the option's name.
 * - one effect per turn among several: once per turn the creature can cause one of a list of additional effects. The
 *   gated effect is the list item; every item shares the key, the action's name.
 * - each effect once per turn: the list says each effect can be applied only once per turn, or carries an "up to once
 *   per turn" parenthetical. The key is the action's and the item's name.
 * Returns the key and where the gated effect starts in the text. A limit on how often a creature is affected by an area
 * ("a creature makes this save only once per turn", "for the first time on a turn") is not this.
 */
const ONCE_PER_TURN_EACH_RE = /\bone of the following\b[^.:]*?(?:\beach of which \w+ can apply only once per turn\b|\(up to once per turn each\))\s*:?/i;
const ONCE_PER_TURN_SHARED_RE = /\bonce per turn\b[^.:]*\bone of the following\b[^.:]*:?/i;
const ONCE_PER_TURN_WEAPON_RE = /\bcan\b[^.]*\b(?:in )?this way only once per turn\b/i;

export function oncePerTurnGate(text: string, name: string, sourceRef: string): { key: string; from: number } | undefined {
  const each = text.match(ONCE_PER_TURN_EACH_RE);
  if (each?.index !== undefined) return { key: `${name}: ${sourceRef.split(".").pop() || "choice"}`, from: each.index + each[0].length };
  const shared = text.match(ONCE_PER_TURN_SHARED_RE);
  if (shared?.index !== undefined) return { key: name, from: shared.index + shared[0].length };
  const weapon = text.match(ONCE_PER_TURN_WEAPON_RE);
  if (weapon?.index === undefined) return undefined;
  const cause = text.lastIndexOf(" can cause the ", weapon.index);
  if (cause < 0) return undefined;
  const sentence = text.lastIndexOf(". ", cause);
  return { key: name, from: sentence < 0 ? 0 : sentence + 2 };
}

/** Keys what the whole attack compiles beyond its ungated prefix: a burst, riders, damage clauses. */
function keyOncePerTurn(action: CombatAction, base: CombatAction | undefined, key: string): void {
  if (action.kind !== "attack" || base?.kind !== "attack") return;
  if (action.extraSave && !base.extraSave) action.extraSave.oncePerTurnKey = key;
  for (const rider of action.riders) {
    if (!base.riders.some((r) => r.condition === rider.condition)) rider.oncePerTurnKey = key;
  }
  action.damage.forEach((clause, i) => { if (i >= base.damage.length) clause.oncePerTurnKey = key; });
}

/**
 * Choice-list actions (a header with "one of the following") compile as distinct
 * options sharing one recharge pool. Flattening the list would combine incompatible saves,
 * damage, and riders into one impossible super-action.
 */
const SEQUENCE_STEPS = ["first", "second", "third", "fourth", "fifth"];

/**
 * A roar action whose effect differs each time it is used, with each effect described in its own labelled
 * paragraph: one action whose effect advances with every use.
 *
 * Flattened into a single option, the sphinx frightened, paralysed *and* knocked prone with every
 * roar, three times a day. Compiled as three steps over one shared pool of uses, each available
 * only at its own point in the sequence, it follows the printed rule.
 */
function parseSequenceVariants(
  raw: { name: string; entries?: unknown },
  header: string,
  timing: Timing,
  sourceRef: string,
): ParseOutcome[] | undefined {
  if (!/has a different effect|as detailed below|the sequence resets/i.test(header)) return undefined;
  const items = (raw.entries as any[]).flatMap((entry) =>
    entry && typeof entry === "object" && entry.type === "list" ? entry.items || [] : []);
  const steps = items.map((item: any) => SEQUENCE_STEPS.indexOf(String(item?.name || "").split(/\s+/)[0].toLowerCase()));
  if (items.length < 2 || steps.some((step: number) => step < 0)) return undefined;
  const shared = parseUses(raw.name);
  // The pool has to hold the whole sequence for the ordering test to mean anything.
  const total = shared.t === "perDay" ? shared.max : items.length;
  const pool = `${sourceRef}:sequence`;
  const outcomes: ParseOutcome[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const parsed = parseAction({ name: `${cleanName(raw.name)}: ${item.name}`, entries: item.entries }, timing, `${sourceRef}.${item.name}`);
    if (!parsed.option) continue;
    parsed.option.action = withHeaderFlags(parsed.option.action, header);
    parsed.option.aliases = [raw.name, cleanName(raw.name)];
    parsed.option.uses = { t: "perDay", max: total, pool };
    parsed.option.sequence = { pool, position: steps[i], total };
    outcomes.push(parsed);
  }
  return outcomes.length ? outcomes : undefined;
}

export function parseActionVariants(raw: { name: string; entries?: unknown }, timing: Timing, sourceRef: string): ParseOutcome[] {
  if (!Array.isArray(raw.entries)) return [parseAction(raw, timing, sourceRef)];
  const header = raw.entries.filter((entry) => typeof entry === "string").join(" ");
  // Older PDF extraction flattened the sphinx's named steps into one paragraph.
  // Recover only an explicitly announced sequence; ordinary prose stays intact.
  if (/has a different effect|as detailed below|the sequence resets/i.test(header)
    && raw.entries.every((entry) => typeof entry === "string")) {
    const headings = [...header.matchAll(/\b(First|Second|Third) Roar\.\s*/g)];
    if (headings.length === 3 && headings.map((match) => match[1]).join(",") === "First,Second,Third") {
      return parseActionVariants({ ...raw, entries: [header.slice(0, headings[0].index), {
        type: "list", style: "list-hang-notitle", items: headings.map((match, i) => ({
          type: "item", name: `${match[1]} Roar`,
          entries: [header.slice(match.index! + match[0].length, headings[i + 1]?.index)],
        })),
      }] }, timing, sourceRef);
    }
  }
  const sequence = parseSequenceVariants(raw, header, timing, sourceRef);
  if (sequence) return sequence;
  const items = raw.entries.flatMap((entry: any) => entry && typeof entry === "object" && entry.type === "list" ? entry.items || [] : []);
  // A list whose items the header names as alternatives is a choice too: a header offering a song of one of two kinds
  // is followed by a Charming item (Charmed and Incapacitated, ending on damage) and a Frightening one (psychic
  // damage and Frightened). Flattened, one song did all of it.
  const names = items.map((item: any) => String(item?.name ?? "").trim().toLowerCase().replace(/[^a-z' -]/g, ""));
  const either = names.length >= 2 && names.every(Boolean)
    && new RegExp(`\\b(?:${names.join("|")})\\s+or\\s+(?:${names.join("|")})\\b`, "i").test(header);
  if ((!either && !/one of the following/i.test(header)) || /at random|randomly (?:shoots?|uses?|chooses?)/i.test(header)) {
    return [parseAction(raw, timing, sourceRef)];
  }
  const outcomes: ParseOutcome[] = [];
  const sharedUses = parseUses(raw.name);
  const pool = `${sourceRef}:choice`;
  const hasBaseAttack = !!(findTags(header, "atkr")[0] || findTags(header, "atk")[0])
    && /\{@hit\s+[+-]?\d+\}/i.test(header);
  const hasBaseSave = /\{@actSave\s+[a-z]{3}\}\s+\{@dc\s+\d+\}|\{@dc\s+\d+\}\s+[A-Za-z]+\s+saving throw/i.test(header);
  for (const item of items) {
    // Some legacy attacks put the common attack roll and base damage in the header,
    // followed by a list of mutually exclusive additional effects (for example,
    // a demon lord's flail and a chain attack). Compile each branch with
    // that common prefix instead of discarding the weapon attack.
    const parsed = parseAction(
      {
        // Named, like the branches of a chain attack, after the action they are branches of.
        name: hasBaseAttack || either ? raw.name : item.name || raw.name,
        entries: hasBaseAttack || hasBaseSave
          ? [header, ...(Array.isArray(item.entries ?? item.entry) ? item.entries ?? item.entry : [item.entries ?? item.entry])]
          : item.entries ?? item.entry,
      },
      timing,
      `${sourceRef}.${item.name || "choice"}`,
    );
    if (!parsed.option) continue;
    parsed.option.action = withHeaderFlags(parsed.option.action, header);
    parsed.option.aliases = [raw.name];
    parsed.option.uses = sharedUses.t === "recharge" ? { ...sharedUses, pool } : sharedUses;
    outcomes.push(parsed);
  }
  return outcomes.length ? outcomes : [parseAction(raw, timing, sourceRef)];
}

/**
 * A list's header speaks for every item under it: a header saying the creature fires a random ray from the list below,
 * or one of its choice, at a target it can see, that it emits a magical roar, or that it fires something at
 * a point it can see. Each item parsed alone read only its own
 * text, and most rays print neither word, so a ray was nonmagical (no Magic Resistance Advantage against it) and fired
 * at a foe the source could not see. An attack, save or auto-hit item takes `magical` and `requiresSight` from the
 * header when the header prints them; an item that prints them keeps them, and a header that prints neither changes
 * nothing. The header's magic is the word "magic" or "magical" ("magical rays", "a magical roar", "magic surges"); a
 * header that says only "magically" is left to the items.
 */
const HEADER_MAGIC_RE = /\bmagic(?:al)?\b/i;

function withHeaderFlags(action: CombatAction, header: string): CombatAction {
  if (action.kind !== "attack" && action.kind !== "save" && action.kind !== "autohit") return action;
  // A header's "at a point it can see" (a grenade thrown at a point) gives the point mode; the stricter gate wins where
  // the header and the item both print one.
  const magical = HEADER_MAGIC_RE.test(header), sight = stricterSight(requiresSight(header), action.requiresSight);
  if ((!magical || action.magical) && sight === (action.requiresSight ?? false)) return action;
  return { ...action, ...(magical ? { magical: true } : {}), ...(sight ? { requiresSight: sight } : {}) };
}

/** A random branch's printed saving throw with no modelled outcome: a slot in the roll that does nothing here. */
function inertSaveBranch(text: string): CombatAction | undefined {
  const tagged = text.match(/\{@actSave\s+([a-z]{3})\}\s+\{@dc\s+(\d+)\}/i);
  const prose = tagged ? null : text.match(/\{@dc\s+(\d+)\}\s+([A-Za-z]+)\s+saving throw/i);
  const ability = tagged ? longAbility[tagged[1].toLowerCase()] : prose ? longAbility[prose[2].toLowerCase()] : undefined;
  const dc = tagged ? Number(tagged[2]) : prose ? Number(prose[1]) : undefined;
  if (!ability || dc === undefined) return undefined;
  return { kind: "save", ability, dc, damage: [], onSuccess: "none", riders: [], choiceRiders: [], magical: magicalText(text), requiresSight: false };
}

/**
 * A Speed cut printed on a ray that is otherwise inert: a failed Strength save means the target is pushed and its
 * speed is halved until the creature's next turn begins; or a failed save halves the target's speed for 1
 * minute, with a repeat save at the end of each of its turns. A save action whose only rider is a cut is not an option
 * (the partial-speed-cut rule), but inside a random action the branch already holds its slot, so the cut rides it: a
 * `speedCut` rider with the branch's own save and the printed clock. A one-minute cut with a repeat save takes the
 * clock its sibling rays take ("paralyzed for 1 minute" with a repeat: `saveEndsEachTurn`, no round count). Nothing
 * else on the ray is read (the push, a lost reaction).
 */
function withInertBranchSpeedCut(text: string, inert: CombatAction): CombatAction {
  if (inert.kind !== "save") return inert;
  const plain = stripTags(text);
  for (const match of plain.matchAll(SPEED_CUT_RE)) {
    const at = match.index ?? 0;
    const sentenceStart = plain.lastIndexOf(". ", at) + 1;
    const stop = plain.indexOf(".", at + match[0].length);
    const sentence = plain.slice(sentenceStart, stop < 0 ? plain.length : stop + 1);
    if (/\bOn a successful save\b/i.test(plain.slice(sentenceStart, at))) continue;
    const clock = sentence.match(SPEED_CUT_CLOCK_RE);
    const duration: Rider["duration"] | undefined = clock
      ? /^(?:its|their|the target['’]s)$/i.test(clock[2])
        ? clock[1].toLowerCase() === "end" ? "endOfTargetNextTurn" : "startOfTargetNextTurn"
        : clock[1].toLowerCase() === "end" ? "endOfSourceNextTurn" : "startOfSourceNextTurn"
      : /\bfor 1 minute\b/i.test(sentence) && /\brepeat the saving throw at the end of each of its turns\b/i.test(plain) ? "saveEndsEachTurn"
      : undefined;
    if (!duration) continue;
    const field: Pick<Rider, "speedCut" | "speedHalved"> = match[1] ? { speedCut: Number(match[1]) } : { speedHalved: true };
    return { ...inert, riders: [{ condition: "speedCut", save: { ability: inert.ability, dc: inert.dc }, duration, ...field }] };
  }
  return inert;
}

function parseRandomAction(raw: { name: string; entries?: unknown }, timing: Timing, sourceRef: string): ParseOutcome {
  if (!Array.isArray(raw.entries)) return {};
  const text = flattenEntries(raw.entries);
  // Ray-shooting creatures word the same mechanic three ways: "randomly shoots", a roll of a die to pick the ray, and a
  // header with "three of the following" plus "at random". Missing the last two
  // dropped some creatures through to a flat sum of every ray's damage at once.
  const header = raw.entries.filter((entry) => typeof entry === "string").join(" ");
  const randomWording = /randomly shoots|roll (?:a |[a-z]+ )?\{@dice 1?d\d+\}/i.test(text)
    || /\bof the following\b[^.]{0,160}\bat random\b/i.test(header);
  if (!randomWording) return {};
  // An attack roll means this is an attack with a random rider table,
  // not a random-branch action like a ray burst.
  if ((findTags(text, "atkr")[0] || findTags(text, "atk")[0]) && /\{@hit\s/i.test(text)) return {};
  const branches: CombatAction[] = [];
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== "object" || (entry as any).type !== "list") continue;
    for (const item of (entry as any).items || []) {
      const parsed = parseAction({ name: `${raw.name}: ${(item as any).name || "branch"}`, entries: (item as any).entries }, timing, sourceRef);
      if (parsed.option) branches.push(parsed.option.action);
      else {
        // A ray the engine cannot model (a push ray, a telekinetic ray, an aversion or slowing ray) still fills its slot in
        // the roll. Dropped, it left each modelled ray drawn more often than the print's pool gives. It compiles as its
        // printed save with nothing on a failure.
        const itemText = flattenEntries((item as any).entries ?? []);
        const inert = inertSaveBranch(itemText);
        if (inert) branches.push(withInertBranchSpeedCut(itemText, inert));
      }
    }
  }
  if (!branches.length) return {};
  // The header names the targeting range once for every ray (a target it can see within some number of feet of itself).
  // Each branch parsed alone read its range from incidental text, or found none: a sleep ray took 5 ft from "a
  // creature within 5 feet of it … wake it", a disintegration ray took 10 ft from a "10-foot Cube", and some rays had
  // no range at all. Every branch takes the header's range.
  const targeting = header.match(/\bwithin (\d+) (?:feet|ft\.) of (?:itself|it)\b/i);
  if (targeting) {
    for (let i = 0; i < branches.length; i++) {
      if (branches[i].kind !== "random") branches[i] = { ...branches[i], range: Number(targeting[1]) } as CombatAction;
    }
  }
  for (let i = 0; i < branches.length; i++) branches[i] = withHeaderFlags(branches[i], header);
  return {
    option: {
      name: cleanName(raw.name),
      sourceText: text,
      sourceRef,
      action: { kind: "random", branches },
      uses: parseUses(raw.name),
      timing,
    },
  };
}

export function actionAverageDamage(action: CombatAction): number {
  if (action.kind === "random") {
    return action.branches.reduce((sum, branch) => sum + actionAverageDamage(branch), 0) / Math.max(1, action.branches.length);
  }
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return 0;
  return action.damage.reduce((sum, d) => sum + avgDice(d.dice), 0);
}
