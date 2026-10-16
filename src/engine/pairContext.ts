import { avgDice } from "../dice.ts";
import type { Ability, CombatAction, CombatStatblock, DamageClause, Rider, Routine } from "../types.ts";

const INCAPACITATING_RIDERS = new Set([
  "charmed",
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
  "sleepDrowsy",
  "hypnotized",
  "hideousLaughter",
  "suggested",
  "commandedGrovel",
  "fearSpell",
]);

/**
 * Conditions the fight engine does something about, beyond writing the name down. Everything
 * here is read by `fight.ts` on the creature carrying it: the incapacitating set above, the
 * advantage-granting and Speed-zeroing sets (`ADV_AGAINST`, `SPEED_ZERO`), the conditions that
 * make its own attacks roll at disadvantage, the antimagic gate on casting, and Swallowed,
 * which is what stops a victim teleporting out of a gullet.
 *
 * The names that are *not* here matter more. "burning", "wound", "cursed" and "attached" are
 * labels the engine tracks so that a dependent rider or a tick can hang on them, and nothing
 * else; a creature with a "burning" label on it fights exactly as well
 * as one without. So the condition itself is worth nothing to the chooser, and the only thing
 * there is to price is the damage it ticks for. `speedZero` is asked separately because
 * "rooted" and "swallowed" do their work through that flag rather than through their name.
 */
const HAMPERING_RIDERS = new Set([
  ...INCAPACITATING_RIDERS,
  "prone",
  "restrained",
  "grappled",
  "poisoned",
  "frightened",
  "blinded",
  "antimagic",
  "swallowed",
]);

/**
 * The most turns of a condition one application is priced over. Shared with `escapeWorthwhile`,
 * so the attacker deciding to apply a hold and the victim deciding whether to break it are
 * valuing the same four turns — about the median fight's remaining length, and short enough
 * that no decision here rests on a twenty-round projection.
 */
export const CONDITION_HORIZON_TURNS = 4;

/** A rider counts as incapacitating if it is one, or if a failed repeat save turns it into one. */
function riderIncapacitates(rider: Rider): boolean {
  return INCAPACITATING_RIDERS.has(rider.condition)
    || (!!rider.transitionOnFailedSave && INCAPACITATING_RIDERS.has(rider.transitionOnFailedSave));
}

/**
 * Or if it becomes one at a later turn boundary while it still holds, against a defender not immune to what it becomes
 * (`delayedCondition`: a grapple that turns its victim to stone).
 */
export function delayedIncapacitates(rider: Rider, defender: CombatStatblock): boolean {
  return !!rider.delayedCondition && INCAPACITATING_RIDERS.has(rider.delayedCondition.condition)
    && !defender.conditionImmune.includes(rider.delayedCondition.condition);
}

/**
 * Only one rider from an attacker's-choice group ever lands, so only one may be priced. Mirrors
 * `resolveRiderChoices` in the engine: prefer an incapacitating option, else keep source order.
 * Valuing both would tell the chooser that a Pixie's dust is worth two conditions a hit.
 */
export function ridersAfterChoices(riders: Rider[]): Rider[] {
  if (!riders.some((rider) => rider.choiceGroup !== undefined)) return riders;
  const chosen = new Map<number, Rider>();
  for (const rider of riders) {
    if (rider.choiceGroup === undefined) continue;
    const best = chosen.get(rider.choiceGroup);
    if (!best || (riderIncapacitates(rider) && !riderIncapacitates(best))) chosen.set(rider.choiceGroup, rider);
  }
  return riders.filter((rider) => rider.choiceGroup === undefined || chosen.get(rider.choiceGroup) === rider);
}

/** A magical sleep against a creature that magic can't put to sleep: the rider does not land. */
export function sleepBlocked(rider: Rider, defender: CombatStatblock): boolean {
  return !!rider.magicalSleep && !!defender.sleepImmune;
}

/**
 * A rider gated on the target's damage immunity (it applies unless the target is Immune to Cold) against a target immune
 * to that type: the rider does not land. The same test as an ability drain's gate (`drainApplies`): the plain immunity
 * list.
 */
export function immunityGated(rider: Rider, defender: CombatStatblock): boolean {
  return !!rider.unlessImmuneTo && defender.immune.includes(rider.unlessImmuneTo);
}

/**
 * A save action that does nothing but put its target to sleep by magic (Dream Breath, a Sleep Ray branch): against a
 * creature magic can't put to sleep it has no effect at all, so it cannot target that creature (`actionTargetable`).
 */
export function magicalSleepOnly(action: CombatAction, defender: CombatStatblock): boolean {
  return action.kind === "save" && !!defender.sleepImmune
    && action.damage.length === 0 && !action.choiceRiders?.length && action.instantDeathHpThreshold === undefined
    && action.riders.length > 0 && action.riders.every((rider) => rider.magicalSleep);
}

export function damageMultiplier(type: string, defender: CombatStatblock, bypassResistance = false, magical = false): number {
  if (bypassResistance) return 1;
  // Absorption: the damage heals instead (the target takes no damage and gains Hit Points matching the damage
  // dealt). Negative, so every expected-damage sum prices the heal and a type choice steers away from it.
  if (defender.absorption?.types.includes(type)) return -defender.absorption.fraction;
  const standing = standingDefence(type, defender, magical);
  if (standing === "immune") return 0;
  return (standing === "resist" ? 0.5 : 1) * (defender.vulnerable.includes(type) ? 2 : 1);
}

/**
 * The defender's own immunity or resistance to a damage type, printed or qualified. Resistance
 * applies once however many sources grant it (SRD 5.2.1, "Damage Resistance and Vulnerability"),
 * so the fight engine asks this before it lets a temporary resistance halve the damage again.
 */
export function standingDefence(type: string, defender: CombatStatblock, magical = false): "immune" | "resist" | undefined {
  if (defender.immune.includes(type)) return "immune";
  let resistant = defender.resist.includes(type);
  for (const defense of defender.qualifiedDefenses || []) {
    if (!defense.types.includes(type)) continue;
    if (defense.nonmagicalOnly && magical) continue;
    if (defense.kind === "immune") return "immune";
    resistant = true;
  }
  return resistant ? "resist" : undefined;
}

export function damageClauseType(clause: DamageClause, defender: CombatStatblock, magical = false): string {
  const choices = clause.typeChoices?.length ? clause.typeChoices : [clause.type];
  return choices.reduce((best, type) =>
    damageMultiplier(type, defender, clause.bypassResistance, magical)
      > damageMultiplier(best, defender, clause.bypassResistance, magical) ? type : best
  );
}

export function damageClauseMultiplier(clause: DamageClause, defender: CombatStatblock, magical = false): number {
  return damageMultiplier(damageClauseType(clause, defender, magical), defender, clause.bypassResistance, magical);
}

/**
 * How often a saving throw is failed, with Advantage on it if the defender has some.
 *
 * Advantage is two dice and the better of them, so a save is failed only when *both* rolls fail:
 * the chance squares. Magic Resistance is the corpus's one static source of it — `rollSave`
 * grants Advantage whenever the defender carries the trait and the effect is magical, and both
 * halves of that are properties of the pair rather than of the round, so they belong inside the
 * memoized evaluator. The state-dependent sources (a Restrained creature's Dexterity saves, the
 * auto-failures a paralysed one takes) stay where they are, in the engine.
 */
export function saveFailChance(dc: number, saveBonus: number, advantage: boolean | -1 = false): number {
  const needed = dc - saveBonus;
  const once = Math.max(0, Math.min(1, (needed - 1) / 20));
  return advantage === -1 ? 1 - (1 - once) ** 2 : advantage ? once * once : once;
}

/**
 * The chance a save fails by at least `margin` (a save-margin tier, `Rider.saveFailMargin`): the d20 shows at most
 * DC - bonus - margin. `saveFailChance` is the same arithmetic at a margin of 1.
 */
export function saveFailByChance(dc: number, saveBonus: number, margin: number, advantage: boolean | -1 = false): number {
  const once = Math.max(0, Math.min(1, (dc - saveBonus - margin) / 20));
  return advantage === -1 ? 1 - (1 - once) ** 2 : advantage ? once * once : once;
}

/** Spell-specific save rules combined with Magic Resistance and condition-save traits. */
export function actionSaveMode(action: { magical: boolean; riders?: Rider[]; saveAdvantageInCombat?: true; saveDisadvantageTypes?: string[] }, defender: CombatStatblock): boolean | -1 {
  const adv = !!action.saveAdvantageInCombat || saveAdvantage(defender, action.magical, actionSaveConditions(action));
  const dis = !!action.saveDisadvantageTypes?.includes(defender.creatureType);
  return adv === dis ? false : dis ? -1 : true;
}

/** A rider on a save-margin tier, either side of the gate. */
export function marginGatedRider(rider: Rider): boolean {
  return rider.saveFailMargin !== undefined || rider.saveFailMarginBelow !== undefined;
}

/**
 * The printed condition an engine-only condition stands for, where the spell's 2024 text names one:
 * Suggestion and Hypnotic Pattern charm their target, Fear frightens it. The same pairs are the
 * spells' `blockedByConditions`, which is how a creature immune to Charmed already shrugs them off.
 */
const PRINTED_CONDITION: Record<string, string> = { suggested: "charmed", hypnotized: "charmed", fearSpell: "frightened" };

/**
 * Does a trait such as Fey Ancestry give this save Advantage? `against` lists the conditions the
 * save stands between the defender and: those its failure would apply, or its success end.
 *
 * The rule used: Advantage against a charm save applies to any save whose
 * failure would leave the creature Charmed, whatever else the effect does (damage, or a second
 * condition the trait does not name). One listed condition among several is enough, and a save
 * that only deals damage or applies unlisted conditions gets none.
 */
export function conditionSaveAdvantage(defender: CombatStatblock, against: Iterable<string | undefined>): boolean {
  const listed = defender.conditionSaveAdvantage;
  if (!listed?.length) return false;
  for (const condition of against) {
    if (!condition) continue;
    if (listed.includes(condition) || listed.includes(PRINTED_CONDITION[condition])) return true;
  }
  return false;
}

/**
 * Every static source of Advantage on a saving throw: Magic Resistance against a magical effect,
 * and a condition-save trait against the conditions in `against`. Both at once is still one
 * Advantage. `rollSave` asks exactly this, so the chooser prices the save the engine rolls.
 */
export function saveAdvantage(defender: CombatStatblock, magical: boolean, against: Iterable<string | undefined> = []): boolean {
  return (!!defender.magicResistance && magical) || conditionSaveAdvantage(defender, against);
}

/**
 * Riders that ride on `rider`'s own save rather than rolling one of their own: `applyRiders` gives a
 * dependent rider its parent's save when both end on a repeat save with the same ability and DC
 * (the Carrier Crawler's paralysis behind its poison), so that save stands against both.
 */
export function sharedSaveDependents(rider: Rider, riders: readonly Rider[]): Rider[] {
  if (rider.duration !== "saveEndsEachTurn") return [];
  return riders.filter((candidate) => candidate !== rider && candidate.requiresTargetCondition === rider.condition
    && candidate.duration === "saveEndsEachTurn" && candidate.save?.ability === rider.save?.ability
    && candidate.save?.dc === rider.save?.dc);
}

/** What a rider's own initial save stands against: its condition and those sharing the save. */
export function riderSaveConditions(rider: Rider, riders: readonly Rider[]): string[] {
  const shared = [rider.condition, ...sharedSaveDependents(rider, riders).map((dependent) => dependent.condition)];
  // A save-margin tier rides on the same roll (`applyRiders`), so that roll stands against its conditions too.
  if (!riders.some(marginGatedRider)) return shared;
  const tier = riders.filter((candidate) => candidate !== rider && marginGatedRider(candidate) && !!rider.save
    && candidate.save?.ability === rider.save.ability && candidate.save?.dc === rider.save.dc
    && !shared.includes(candidate.condition)).map((candidate) => candidate.condition);
  return [...shared, ...new Set(tier)];
}

/**
 * What a rider's repeat save stands against: success ends the condition (and whatever shares the
 * save), failure turns it into its `transitionOnFailedSave` (Sleep's Unconscious).
 */
export function riderRepeatConditions(rider: Rider, riders: readonly Rider[]): (string | undefined)[] {
  return [rider, ...sharedSaveDependents(rider, riders)].flatMap((r) => [r.condition, r.transitionOnFailedSave]);
}

/**
 * What an action's own save stands against: every rider it lands on a failure (a rider applied
 * "on a success or failure" is not avoided by it), and a victim's-choice rider it offers.
 */
export function actionSaveConditions(action: { riders?: Rider[]; choiceRiders?: { condition: string }[] }): string[] {
  return [
    ...(action.riders || []).filter((rider) => !rider.appliesOnSuccess).map((rider) => rider.condition),
    ...(action.choiceRiders || []).map((choice) => choice.condition),
  ];
}

export function hitChance(toHit: number, ac: number): number {
  return Math.max(0.05, Math.min(0.95, (21 + toHit - ac) / 20));
}

/**
 * What Advantage and Disadvantage are worth to the chooser. The engine reads both from here so
 * that a defence priced in this file and a condition priced in `fight.ts` cost the same thing.
 */
export const ADVANTAGE_EV = 1.25;
export const DISADVANTAGE_EV = 0.65;

/**
 * Which of the defender's suppressible defences are switched on right now. The memoized
 * evaluator is pure in (action, direction, distance) and cannot see a condition, so it prices
 * every defence as active; the engine re-prices post-cache on the rounds one is not.
 */
export interface DefenceState {
  /** Displacement and the rest of `attacksAgainstDisadvantage`. */
  displacement: boolean;
  /** Evasion / Avoidance. */
  evasion: boolean;
}

export const DEFENCES_ACTIVE: DefenceState = { displacement: true, evasion: true };

/**
 * The factor an attack roll's expected value is multiplied by for a defence that makes the roll
 * itself worse. Distance-dependent — a cloud defence only fools an attacker who has not come
 * inside 15 feet — which is why it lives beside `distanceEvFactor` and not inside `actionEv`.
 */
export function attackDisadvantageFactor(
  action: CombatAction,
  defender: CombatStatblock,
  distance: number,
  defences: DefenceState = DEFENCES_ACTIVE,
): number {
  const trait = defender.attacksAgainstDisadvantage;
  if (!trait || !defences.displacement) return 1;
  // A random action is priced as the mean of its branches, so the penalty has to be averaged
  // the same way `distanceEvFactor` averages its own.
  if (action.kind === "random") {
    const usable = action.branches.filter((b) => actionInRange(b, distance));
    if (!usable.length) return 1;
    return usable.reduce((sum, b) => sum + attackDisadvantageFactor(b, defender, distance, defences), 0) / usable.length;
  }
  if (action.kind !== "attack") return 1;
  if (trait.rangedOnly && !action.ranged) return 1;
  if (trait.minDistance !== undefined && distance <= trait.minDistance) return 1;
  return DISADVANTAGE_EV;
}

/**
 * How a save-for-half burst lands against this defender: the share of its damage taken on a
 * failed save, and the share taken on a successful one. Evasion turns "half or full" into
 * "none or half", and it reaches exactly the effects that offer half on a success, which in
 * this engine is a `SaveAction` or a `SaveEffect` with `onSuccess: "half"`, and nothing else.
 * An aura's save is all-or-nothing already, and an attack roll is not a saving throw.
 */
export function evasionShares(
  onSuccess: "half" | "none" | "full",
  ability: Ability,
  defender: CombatStatblock,
  defences: DefenceState = DEFENCES_ACTIVE,
): { onFail: number; onSave: number } {
  const plain = { onFail: 1, onSave: onSuccess === "half" ? 0.5 : onSuccess === "full" ? 1 : 0 };
  const trait = defender.evasion;
  if (!trait || !defences.evasion || onSuccess !== "half") return plain;
  if (trait.ability !== undefined && trait.ability !== ability) return plain;
  return { onFail: 0.5, onSave: 0 };
}

/**
 * How often an altitude-gated clause actually fires: 1 when the named side can never leave the
 * ground (so a "grounded" clause always applies), 0 when it can never be airborne (so an
 * "airborne" clause never does), and 0.5 for a flier that could be either.
 */
function altitudeCertainty(clause: DamageClause, attacker: CombatStatblock, defender: CombatStatblock): number {
  const subject = clause.requiresGrounded ?? clause.requiresAirborne;
  if (!subject) return 1;
  const canFly = (subject === "target" ? defender : attacker).flySpeed !== undefined;
  if (canFly) return 0.5;
  return clause.requiresGrounded ? 1 : 0;
}

/**
 * How many ticks one application of this rider is expected to land inside the horizon, counted in
 * the order the engine actually resolves a turn.
 *
 * The old reading was a capped geometric, `min(1/(1 - fail), 4)`, and it was wrong twice over.
 *
 * It is not the four-turn survival sum. A condition re-saved against every turn is on for turn
 * one, and on for turn two only if the first save failed, and so on: the ticks it buys are
 * `1 + p + p^2 + p^3`, not `1/(1 - p)` with a ceiling bolted on. At an even save that is 1.875
 * rather than 2, and at a hopeless one it approaches four from below instead of arriving there.
 *
 * And it did not know which end of the turn the tick lands on, which for a save-ends condition
 * decides whether the tick happens at all. `endTurn` rolls the repeat save
 * (`resolveEndTurnConditions`) *before* it deals end-of-turn damage (`resolveConditionDamage(...,
 * "end")`), so a successful save removes the condition and that turn's tick never fires: an
 * end-of-turn tick is worth exactly `p` times a start-of-turn one. At an even save that is half as
 * much again, and nothing priced it before.
 *
 * `savesToEnd` generalises the same sum. A condition needing three successes
 * is still on after `k` saves whenever fewer than three of them landed, and the
 * survival term is a binomial tail rather than `p^k`.
 */
function expectedTicks(rider: Rider, defender: CombatStatblock, magical: boolean, phase: "start" | "end", riders: readonly Rider[] = [rider]): number {
  // An action's "until the start of its next turn" lapses as the target's turn begins, before its
  // start-of-turn tick and long before its end-of-turn one. (An aura's copy covers one of the target's
  // turns, but auras are priced per round by `auraCost`, not here.)
  if (rider.duration === "startOfTargetNextTurn") return 0;
  if (rider.duration === "endOfTargetNextTurn" || rider.duration === "endOfSourceNextTurn" || rider.duration === "startOfSourceNextTurn") return 1;
  if (rider.duration !== "saveEndsEachTurn" || !rider.save) return CONDITION_HORIZON_TURNS;
  const persists = defender.greaterMagicResistance && magical ? 0 : saveFailChance(
    rider.save.dc,
    defender.saves[rider.save.ability] ?? defender.abilityMods[rider.save.ability],
    saveAdvantage(defender, magical, riderRepeatConditions(rider, riders)),
  );
  const made = 1 - persists;
  const needed = rider.savesToEnd ?? 1;
  // Still on after `k` repeat saves: fewer than `needed` of them were made.
  const stillOn = (k: number): number => {
    if (needed === 1) return persists ** k;
    let sum = 0;
    let coefficient = 1;
    for (let successes = 0; successes < needed && successes <= k; successes++) {
      sum += coefficient * made ** successes * persists ** (k - successes);
      coefficient = coefficient * (k - successes) / (successes + 1);
    }
    return Math.min(1, sum);
  };
  // A start-of-turn tick on the nth turn needs the condition to have survived n-1 saves; an
  // end-of-turn one runs after that turn's own save, so it needs n.
  let ticks = 0;
  for (let turn = 0; turn < CONDITION_HORIZON_TURNS; turn++) {
    ticks += stillOn(phase === "start" ? turn : turn + 1);
  }
  return ticks;
}

/**
 * How often a rider's own prerequisites let it land, mirroring the `conditionalFactor` the
 * damage loop in `actionEv` applies to a gated clause — with the same distinction
 * `altitudeCertainty` draws. A gate `applyRiders` settles off the defender's block alone
 * (`src/engine/fight.ts:942`) is not guesswork: size, creature type, creature tag and the
 * condition-immunity blockers are 0 or 1 against a known opponent and never a coin flip. A gate
 * that depends on how the turn goes — a run-up, a hit-point threshold — is the coin flip, and is
 * priced the way the damage loop prices it.
 *
 * `requiresTargetCondition` is both, and which one it is depends on the company it keeps.
 * `applyRiders` walks a rider list in order and pushes each condition as it goes, so a *dependent*
 * rider — a paralysis behind its own poison, a crocodile's Restrained behind its
 * own grapple — finds its prerequisite already there and is certain, not a coin flip; 41 of the
 * corpus's 43 are of that kind. `earlier` is the part of the list `applyRiders` would have
 * resolved first, so the parent's own gates are inherited and a parent the defender is immune to
 * kills the dependent outright. Only a prerequisite nothing on this action supplies — an undead's
 * glare that wants a curse laid by another action — is the coin flip.
 */
function riderGateFactor(rider: Rider, defender: CombatStatblock, earlier: Rider[], runUp?: number): number {
  if (rider.targetMaxSize !== undefined && defender.size > rider.targetMaxSize) return 0;
  if (rider.targetTypes && !rider.targetTypes.includes(defender.creatureType)) return 0;
  if (rider.excludedTargetTypes?.includes(defender.creatureType)) return 0;
  if (rider.excludedTargetTags?.some((tag) => defender.creatureTags.includes(tag))) return 0;
  if (rider.blockedByConditions?.some((condition) => defender.conditionImmune.includes(condition))) return 0;
  if (sleepBlocked(rider, defender)) return 0;
  if (immunityGated(rider, defender)) return 0;
  // A run-up is the coin flip only while nobody has said where the creature is attacking from. The
  // movement search does say, square by square (`runUp`), and there it is 1 or 0 like any other gate
  // the pair settles.
  const hpGate = rider.targetHpMax !== undefined || rider.requiresTargetHpAbove !== undefined;
  let factor = runUp !== undefined && rider.requiresMovement !== undefined
    ? (runUp >= rider.requiresMovement ? 1 : 0) * (hpGate ? 0.5 : 1)
    : rider.requiresMovement !== undefined || hpGate ? 0.5 : 1;
  if (rider.requiresTargetCondition) {
    let parent = earlier.length - 1;
    while (parent >= 0 && earlier[parent].condition !== rider.requiresTargetCondition) parent--;
    if (parent < 0) factor *= 0.5;
    else if (defender.conditionImmune.includes(earlier[parent].condition)) return 0;
    else factor *= riderGateFactor(earlier[parent], defender, earlier.slice(0, parent), runUp);
  }
  return factor;
}

/** An option that restores its user's hit points: a healing option (not a pure temporary-HP grant) or a drain. */
function regainsBy(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.some(regainsBy);
  if (action.kind === "selfheal") return !action.selfTempHp?.dice && avgDice(action.healing) > 0;
  if (action.kind === "selfbuff" || action.kind === "teleport") return false;
  const clauses = [...action.damage, ...(action.kind === "attack" && action.extraSave ? action.extraSave.damage : [])];
  return clauses.some((clause) => clause.healsAttacker || !!clause.healsAttackerFlat);
}

/**
 * Whether this creature has any way to regain hit points in a duel, which is what a heal block takes away: regeneration,
 * damage absorption, a reaction that heals, a healing option, or a drain. `offTurnOnly`: only the ways that work off its
 * own turn (absorption, a healing reaction). `afterTurnStart`: all but regeneration, which a block landed at the start of
 * the creature's turn (an aura's) comes too late for.
 */
export function canRegainHp(block: CombatStatblock, offTurnOnly = false, afterTurnStart = false): boolean {
  if (block.absorption?.types.length || block.reaction?.healing) return true;
  return !offTurnOnly && ((!afterTurnStart && !!block.regeneration) || block.options.some((option) => regainsBy(option.action)));
}

/** What a pair's plain damage comes to, for pricing a rider by what it takes from the foe or adds to the attacker. */
interface PairPlain { swing: number; swings: number }
const pairPlains = new WeakMap<CombatStatblock, WeakMap<CombatStatblock, PairPlain>>();
/** Above 0 while a pair's plain damage is being measured: a rider's condition is then worth nothing, only its damage. */
let plainDepth = 0;

function pairPlain(attacker: CombatStatblock, defender: CombatStatblock): PairPlain {
  let byDefender = pairPlains.get(attacker);
  if (!byDefender) pairPlains.set(attacker, byDefender = new WeakMap());
  let plain = byDefender.get(defender);
  if (!plain) {
    plainDepth++;
    try {
      let swing = 0;
      for (const option of attacker.options) {
        if (option.action.kind === "attack" && option.uses.t === "atWill") swing = Math.max(swing, actionEv(option.action, attacker, defender));
      }
      const swings = attacker.routines.reduce((most, routine) => Math.max(most, routine.parts.reduce(
        (sum, part) => sum + (attacker.options[part.optionIdx]?.action.kind === "attack" ? part.count : 0), 0)), 0);
      plain = { swing, swings };
    } finally {
      plainDepth--;
    }
    byDefender.set(defender, plain);
  }
  return plain;
}

/** The share of a swing's value one roll's Advantage adds or one roll's Disadvantage takes: 1 - 0.65, a hit on a 8. */
export const ONE_ROLL_SHARE = 0.35;

/**
 * A rider whose whole effect is one roll or Prone, priced from the pair and not as a share of the foe's Hit Points;
 * undefined for any other rider. One roll: that share of the one swing it changes, the foe's (damage to the attacker
 * counts in proportion to the two creatures' Hit Points) or the attacker's own. Prone: Advantage on the attacker's
 * later swings of the turn, half of them on average. A push keeps its share: `walkedOffDisplacement` takes it away
 * where the foe walks back, and it is what breaks the foe's hold where it does not.
 */
function pairRiderWorth(rider: Rider, attacker: CombatStatblock, defender: CombatStatblock): number | undefined {
  const oneRoll = !!rider.rollEffects?.length && rider.rollEffects.every((effect) => effect.nextRollOnly && (effect.roll === "attack" || effect.roll === "attackAgainst"));
  const prone = rider.condition === "prone";
  if ((!oneRoll && !prone) || rider.push) return undefined;
  if (rider.speedZero || rider.noReactions || rider.actionOrBonus || rider.blocksHealing || (!!rider.rollEffects?.length && !oneRoll)
    || (!prone && HAMPERING_RIDERS.has(rider.condition))) return undefined;
  const exchange = Math.min(4, Math.max(0.25, defender.hpAvg / Math.max(1, attacker.hpAvg)));
  let worth = 0;
  if (oneRoll) {
    for (const effect of rider.rollEffects!) {
      worth += ONE_ROLL_SHARE * (effect.roll === "attack" ? pairPlain(defender, attacker).swing * exchange : pairPlain(attacker, defender).swing);
    }
  }
  if (prone) {
    const own = pairPlain(attacker, defender);
    worth += ONE_ROLL_SHARE * own.swing * Math.max(0, own.swings - 1) / 2;
    // A faster foe that shoots from beyond the attacker's reach stands on half its Speed and leaves through an
    // Opportunity Attack; where that attack knocks it Prone again it has no movement left to stand with. Against such a
    // foe Prone keeps the hampering share (R07).
    if (outrunsAndShoots(defender, attacker)) worth = Math.max(worth, defender.hpAvg * 0.08);
  }
  return Math.min(worth, defender.hpAvg * 0.25);
}

const kiterCache = new WeakMap<CombatStatblock, WeakMap<CombatStatblock, boolean>>();
/** Whether `runner` is faster than `chaser` and has a damaging option that reaches farther than any of the chaser's melee. */
function outrunsAndShoots(runner: CombatStatblock, chaser: CombatStatblock): boolean {
  let byChaser = kiterCache.get(runner);
  if (!byChaser) kiterCache.set(runner, byChaser = new WeakMap());
  let known = byChaser.get(chaser);
  if (known === undefined) {
    let reach = 0;
    for (const option of chaser.options) if (option.action.kind === "attack" && option.action.melee) reach = Math.max(reach, actionRange(option.action));
    // A flier that does not hover falls when knocked Prone, which has its own price.
    known = runner.speed > chaser.speed && (!runner.flySpeed || !!runner.canHover) && runner.options.some((option) => option.timing === "action" && actionRange(option.action) > reach
      && (option.action.kind === "attack" || option.action.kind === "save") && !!option.action.damage?.length);
    byChaser.set(chaser, known);
  }
  return known;
}

/**
 * A condition that takes the foe's turns (Paralyzed, Stunned, Unconscious, Incapacitated), priced from the pair: the
 * turns of its own attacks the foe loses (damage to the attacker counts in proportion to the two creatures' Hit
 * Points) and the Advantage the attacker's own attacks gain meanwhile, over the turns it is expected to last, three at
 * most. Kept between a tenth and four tenths of the foe's Hit Points, about the flat quarter it replaces: that share
 * had a Cultist Fanatic cast Hold Person on every Berserker and never on a Bandit Captain, and a Silver Dragon
 * Wyrmling breathe cold at a foe its Paralyzing Breath would have held (E13).
 */
function pairIncapacityWorth(rider: Rider, attacker: CombatStatblock, defender: CombatStatblock): number {
  const own = pairPlain(attacker, defender);
  const foe = pairPlain(defender, attacker);
  const exchange = Math.min(4, Math.max(0.25, defender.hpAvg / Math.max(1, attacker.hpAvg)));
  const fail = rider.duration === "saveEndsEachTurn" && rider.save
    ? saveFailChance(rider.save.dc, defender.saves[rider.save.ability] ?? defender.abilityMods[rider.save.ability]) : undefined;
  const turns = fail !== undefined ? Math.min(3, 1 / Math.max(0.05, 1 - fail))
    : rider.duration === "permanent" || rider.duration === "untilEscape" ? 3 : 1;
  // One that ends when its holder is hurt lasts until the attacker's next hit: one turn, and never above the flat quarter.
  const fragile = !!rider.endsOnDamage || !!rider.transitionEndsOnDamage;
  const worth = (fragile ? 1 : turns) * (foe.swing * Math.max(1, foe.swings) * exchange + own.swing * Math.max(1, own.swings) * ONE_ROLL_SHARE);
  return Math.min(defender.hpAvg * (fragile ? 0.25 : 0.4), Math.max(defender.hpAvg * 0.1, worth));
}

const TURN_TAKING = new Set(["paralyzed", "stunned", "unconscious", "incapacitated", "petrified"]);
/** Durations that can run past the holder's next turn. One that cannot keeps the flat quarter: priced from the pair, a
 * Ghast clawed where its Bite was worth more and lost 12 pairings of 49 that moved. */
const LASTING = new Set(["saveEndsEachTurn", "permanent", "untilEscape"]);
/** Whether the rider takes its holder's turns by the rules, itself or through what a failed save turns it into. */
function takesTurns(rider: Rider): boolean {
  return TURN_TAKING.has(rider.condition) || (!!rider.transitionOnFailedSave && TURN_TAKING.has(rider.transitionOnFailedSave));
}

/**
 * What one rider is worth against this defender, before whatever roll lands it.
 *
 * Two terms, and the old pricing had only the first. The condition is worth a share of the
 * defender's hit points — incapacitating riders (paralyzed etc.) are effectively win conditions
 * in 1v1 (lost turns + auto-crits), so they weigh far more than other riders, and a rider that
 * *becomes* one on a failed repeat save is worth the same: a basilisk's gaze reads as a mild
 * Restrained until you notice the second save turns the victim to stone. A condition the engine
 * does nothing with is worth none of it.
 *
 * The tick is worth what it actually deals to *this* defender, through the same
 * `damageClauseMultiplier` every damage clause goes through. A flat share of the victim's hit
 * points priced a burning-lava breath identically against a fire-immune
 * tarrasque and against a kobold, and priced the Tarrasque's own 16d6 gullet the same as a
 * Stirge's 2d4.
 */
function riderWorth(rider: Rider, defender: CombatStatblock, magical: boolean, riders: readonly Rider[] = [rider], attacker?: CombatStatblock): number {
  // A rider that changes the holder's rolls (`rollEffects`) is hampering, as `speedZero` is.
  // So is a heal block, against a defender that has a way to regain hit points while it holds.
  // One lasting until the start of its next turn, landed by an action, ends before the target's own turn does anything (its
  // regeneration included, `healBlocked`): only a regain off the target's turn is left for it to stop.
  // Confusion takes the holder's action on six turns in ten and leaves it one melee attack on two more.
  const conditionShare = riderIncapacitates(rider) || delayedIncapacitates(rider, defender) ? 0.25
    : rider.condition === "confused" ? 0.15
    : HAMPERING_RIDERS.has(rider.condition) || rider.speedZero || !!rider.rollEffects?.length || rider.noReactions || rider.actionOrBonus || rider.condition === "exhaustion" || rider.condition === "gibbering" || !!rider.push
      || (!!rider.blocksHealing && canRegainHp(defender, rider.duration === "startOfTargetNextTurn")) ? 0.08 : 0;
  // The two phases are counted separately because they do not last the same number of turns —
  // see `expectedTicks`. A rider carrying both gets each on its own terms.
  const ticking = expectedDamageClauses(rider.startTurnDamage, defender, magical) * expectedTicks(rider, defender, magical, "start", riders)
    + expectedDamageClauses(rider.endTurnDamage, defender, magical) * expectedTicks(rider, defender, magical, "end", riders)
    + expectedDamageClauses(rider.delayedDamage?.damage, defender, magical);
  if (plainDepth > 0) return ticking;
  const paired = !attacker ? undefined : conditionShare === 0.08 ? pairRiderWorth(rider, attacker, defender)
    : conditionShare === 0.25 && takesTurns(rider) && LASTING.has(rider.duration) ? pairIncapacityWorth(rider, attacker, defender) : undefined;
  return (paired ?? defender.hpAvg * conditionShare) + ticking;
}

/**
 * The save that stands between an action and one of its riders, if the rider has one of its own
 * and the action has not already rolled it.
 *
 * Which of those it is, is not a judgement call: `applyRiders` takes an `initialSaveMade` flag and
 * rolls `rider.save` only when it is false (`src/engine/fight.ts:983`). An attack passes false —
 * the attack roll is not a saving throw, so a Ghoul's Claw hits and *then* the victim rolls
 * against paralysis. A save action passes true, because its own save was that roll and the rider
 * must not be charged for it twice. An autohit passes true as well, and so does an `extraSave`
 * burst and an aura.
 *
 * Priced at 1 before this, which said that a Ghoul's Claw paralyses whatever it hits.
 */
function riderSaveFactor(rider: Rider, defender: CombatStatblock, savesRolled: boolean, magical: boolean, riders: readonly Rider[] = [rider]): number {
  if (savesRolled || !rider.save) return 1;
  if (defender.greaterMagicResistance && magical) return 0;
  if (!marginGatedRider(rider)) {
    return saveFailChance(
      rider.save.dc,
      defender.saves[rider.save.ability] ?? defender.abilityMods[rider.save.ability],
      saveAdvantage(defender, magical, riderSaveConditions(rider, riders)),
    );
  }
  // A save-margin tier lands on the share of failures that reach its margin, and the base tier it replaces on the rest.
  const bonus = defender.saves[rider.save.ability] ?? defender.abilityMods[rider.save.ability];
  const advantage = saveAdvantage(defender, magical, riderSaveConditions(rider, riders));
  if (rider.saveFailMargin !== undefined) return saveFailByChance(rider.save.dc, bonus, rider.saveFailMargin, advantage);
  const fail = saveFailChance(rider.save.dc, bonus, advantage);
  return Math.max(0, fail - saveFailByChance(rider.save.dc, bonus, rider.saveFailMarginBelow!, advantage));
}

function expectedDamageClauses(clauses: DamageClause[] | undefined, defender: CombatStatblock, magical: boolean): number {
  if (!clauses?.length) return 0;
  return clauses.reduce((sum, clause) => sum + avgDice(clause.dice) * damageClauseMultiplier(clause, defender, magical), 0);
}

/**
 * What a set of riders is worth, after the attacker's choice groups and the defender's immunities.
 * The list stays in order and each rider is priced against the ones ahead of it, because that is
 * how `applyRiders` resolves them and it is what makes a dependent rider's prerequisite certain.
 */
function ridersEv(
  riders: Rider[] | undefined,
  defender: CombatStatblock,
  magical: boolean,
  include: (rider: Rider) => boolean,
  savesRolled: boolean,
  runUp?: number,
  tier: MarginTier = "below",
  attacker?: CombatStatblock,
): number {
  if (!riders?.length) return 0;
  const ordered = ridersAfterChoices(riders);
  // The chain of saving throws each condition arrived behind, so a dependent rider keeps the
  // joint probability rather than treating its prerequisite as certain. Only the *saves* are
  // carried here: `riderGateFactor` already walks the parent's size, type and immunity gates,
  // and multiplying by the parent's whole land chance would charge those twice.
  const saveChain = new Map<string, number>();
  let sum = 0;
  for (let i = 0; i < ordered.length; i++) {
    const rider = ordered[i];
    if (defender.conditionImmune.includes(rider.condition)) {
      saveChain.set(rider.condition, 0);
      continue;
    }
    const parent = rider.requiresTargetCondition ? saveChain.get(rider.requiresTargetCondition) : undefined;
    const parentRider = rider.requiresTargetCondition
      ? ordered.slice(0, i).reverse().find((earlier) => earlier.condition === rider.requiresTargetCondition) : undefined;
    const sharesParentSave = parentRider?.duration === "saveEndsEachTurn" && rider.duration === "saveEndsEachTurn"
      && parentRider.save?.ability === rider.save?.ability && parentRider.save?.dc === rider.save?.dc;
    const land = marginGatedRider(rider)
      ? marginLand(rider, parentRider, parent, defender, savesRolled, magical, ordered, tier)
      : (sharesParentSave ? 1 : riderSaveFactor(rider, defender, savesRolled, magical, ordered)) * (parent ?? 1);
    saveChain.set(rider.condition, land);
    if (!include(rider)) continue;
    const gate = riderGateFactor(rider, defender, ordered.slice(0, i), runUp);
    if (gate === 0) continue;
    sum += gate * land * riderWorth(rider, defender, magical, ordered, attacker);
  }
  return sum;
}

/**
 * Which side of a save-margin tier a save already rolled is priced on: `below` (a failure short of the margin, or no
 * margin read: what `applyRiders` does when it is given none) or `margin`. Only a rider behind a rolled save reads it.
 */
export type MarginTier = "below" | "margin";

/**
 * How often a save-margin rider lands. Behind a save the action has already rolled, the caller prices each tier on its
 * own (`saveMarginTierEvs`), so the rider is certain on its side of the gate and absent on the other. On an attack, the
 * rider's own save is rolled once for the base tier and the margin tier together (`applyRiders`): a margin rider lands
 * on P(fail by the margin), and the base rider it replaces on the rest of the failures. Its parent on the same save is
 * implied by that roll, not a second chance to multiply in.
 */
function marginLand(
  rider: Rider,
  parentRider: Rider | undefined,
  parent: number | undefined,
  defender: CombatStatblock,
  savesRolled: boolean,
  magical: boolean,
  ordered: readonly Rider[],
  tier: MarginTier,
): number {
  if (savesRolled) {
    const reached = tier === "margin";
    return (rider.saveFailMargin !== undefined ? reached : !reached) ? 1 : 0;
  }
  const sameSave = !!parentRider && parentRider.save?.ability === rider.save?.ability && parentRider.save?.dc === rider.save?.dc;
  return riderSaveFactor(rider, defender, false, magical, ordered) * (sameSave ? 1 : parent ?? 1);
}

/** A save action's outcomes one at a time (`saveMarginTierEvs`). */
export interface SaveMarginTierEvs {
  /** P(fail) and P(fail by the margin). */
  fail: number;
  failBy: number;
  /** Worth on a failure short of the margin, on one that reaches it, and on a success. */
  below: number;
  margin: number;
  onSave: number;
  /** The damage part of `below` and `margin`. */
  belowDamage: number;
  marginDamage: number;
}

/**
 * A save action with a save-margin tier, priced one outcome at a time. Undefined for an action with no tier. `actionEv`,
 * `actionRiderEv` and the Legendary Resistance component read it, so the chooser prices the tier the engine rolls: a
 * margin-gated effect at the chance of failing by the margin, the base tier it replaces at the rest of the failures.
 */
export function saveMarginTierEvs(
  action: CombatAction,
  attacker: CombatStatblock,
  defender: CombatStatblock,
  defences: DefenceState = DEFENCES_ACTIVE,
  include: (rider: Rider) => boolean = () => true,
  runUp?: number,
): SaveMarginTierEvs | undefined {
  if (action.kind !== "save") return undefined;
  const gatedRiders = action.riders.filter((rider) => rider.saveFailMargin !== undefined);
  if (!action.marginDamage && !gatedRiders.length) return undefined;
  const margin = action.marginDamage?.margin ?? gatedRiders[0].saveFailMargin!;
  const bonus = defender.saves[action.ability] ?? defender.abilityMods[action.ability];
  const advantage = actionSaveMode(action, defender);
  const fail = defender.greaterMagicResistance && action.magical ? 0 : saveFailChance(action.dc, bonus, advantage);
  const failBy = Math.min(fail, saveFailByChance(action.dc, bonus, margin, advantage));
  const deathBonus = action.instantDeathHpThreshold !== undefined && defender.hpAvg <= action.instantDeathHpThreshold ? defender.hpAvg : 0;
  const share = evasionShares(action.onSuccess, action.ability, defender, defences);
  const base = damageEv(action, attacker, defender, runUp);
  const tierBase = action.marginDamage ? damageEv({ ...action, damage: action.marginDamage.damage }, attacker, defender, runUp) : base;
  const belowDamage = Math.max(base * share.onFail, deathBonus);
  const marginDamage = Math.max(tierBase * share.onFail, deathBonus);
  const eitherWay = ridersEv(action.riders, defender, action.magical, (r) => include(r) && !!r.appliesOnSuccess, true, runUp, "below", attacker);
  return {
    fail,
    failBy,
    below: belowDamage + ridersEv(action.riders, defender, action.magical, include, true, runUp, "below", attacker),
    margin: marginDamage + ridersEv(action.riders, defender, action.magical, include, true, runUp, "margin", attacker),
    onSave: base * share.onSave + eitherWay,
    belowDamage,
    marginDamage,
  };
}

/**
 * The share of `actionEv` that comes from riders rather than damage, optionally restricted to
 * the riders a caller cares about. Split out because riders and damage do not scale alike: a
 * routine that swings the same option three times deals its damage three times and applies its
 * conditions once, and because a condition the foe already has is worth nothing at all — both
 * of which are corrections applied to a price this function is the rider half of.
 */
export function actionRiderEv(action: CombatAction, defender: CombatStatblock, include: (rider: Rider) => boolean = () => true, runUp?: number, attacker?: CombatStatblock): number {
  if (spellBlocked(action, defender)) return 0;
  if (action.kind === "random") {
    return action.branches.reduce((sum, branch) => sum + actionRiderEv(branch, defender, include, runUp, attacker), 0) / Math.max(1, action.branches.length);
  }
  if (!("riders" in action)) return 0;
  if (action.kind === "attack") {
    // An attack roll is not a saving throw, so a rider with a save of its own still has one to
    // get past: `savesRolled` is false here and true everywhere below.
    let ev = (defender.greaterMagicResistance && action.spell ? 0 : hitChance(action.toHit, defender.ac)) * ridersEv(action.riders, defender, action.magical, include, false, runUp, "below", attacker);
    if (action.extraSave) {
      const sb = action.extraSave;
      const fail = defender.greaterMagicResistance && action.magical ? 0 : saveFailChance(sb.dc, defender.saves[sb.ability] ?? defender.abilityMods[sb.ability], saveAdvantage(defender, action.magical, actionSaveConditions(sb)));
      ev += fail * ridersEv(sb.riders, defender, action.magical, include, true, runUp, "below", attacker);
    }
    return ev;
  }
  if (action.kind === "save" && (action.marginDamage || action.riders.some((rider) => rider.saveFailMargin !== undefined))) {
    // A save-margin tier: each side of the gate at its own chance. Riders only, so the damage terms are left out.
    const gated = action.riders.find((rider) => rider.saveFailMargin !== undefined);
    const bonus = defender.saves[action.ability] ?? defender.abilityMods[action.ability];
    const advantage = actionSaveMode(action, defender);
    const fail = defender.greaterMagicResistance && action.magical ? 0 : saveFailChance(action.dc, bonus, advantage);
    const failBy = Math.min(fail, saveFailByChance(action.dc, bonus, action.marginDamage?.margin ?? gated!.saveFailMargin!, advantage));
    return (fail - failBy) * ridersEv(action.riders, defender, action.magical, include, true, runUp, "below", attacker)
      + failBy * ridersEv(action.riders, defender, action.magical, include, true, runUp, "margin", attacker)
      + (1 - fail) * ridersEv(action.riders, defender, action.magical, (r) => include(r) && !!r.appliesOnSuccess, true, runUp, "below", attacker);
  }
  if (action.kind === "save") {
    const fail = defender.greaterMagicResistance && action.magical ? 0 : saveFailChance(action.dc, defender.saves[action.ability] ?? defender.abilityMods[action.ability], actionSaveMode(action, defender));
    // "On a success or failure, …": a rider the action applies either way is not worth the
    // failure chance, it is worth all of it.
    const onFail = ridersEv(action.riders, defender, action.magical, include, true, runUp, "below", attacker);
    const eitherWay = ridersEv(action.riders, defender, action.magical, (r) => include(r) && !!r.appliesOnSuccess, true, runUp, "below", attacker);
    return fail * onFail + (1 - fail) * eitherWay;
  }
  return ridersEv(action.riders, defender, action.magical, include, true, runUp, "below", attacker);
}

/**
 * The chance one use of this action gets past the roll — or the two rolls — that stand between
 * it and its riders.
 *
 * An attack roll is only the first of them. A Ghoul's Claw hits on a 55% chance and then asks
 * for a DC 10 Constitution save, and how often three Claws paralyse *at least once* is a
 * question about the product, not about the attack roll: the old reading said a three-claw
 * routine was near-certain to paralyse when it is closer to even.
 *
 * One approximation, kept from before and now visible rather than implicit: an action whose
 * riders carry different saves has one landing chance here, and it is the best of them — the
 * routine's conditions are worth what its most likely one is worth.
 */
export function riderLandChance(action: CombatAction, defender: CombatStatblock): number {
  if (spellBlocked(action, defender)) return 0;
  if (action.kind === "random") {
    return action.branches.reduce((sum, branch) => sum + riderLandChance(branch, defender), 0) / Math.max(1, action.branches.length);
  }
  const roll = action.kind === "attack"
    ? (defender.greaterMagicResistance && action.spell ? 0 : hitChance(action.toHit, defender.ac))
    : action.kind === "save"
      ? defender.greaterMagicResistance && action.magical ? 0 : saveFailChance(action.dc, defender.saves[action.ability] ?? defender.abilityMods[action.ability], actionSaveMode(action, defender))
      : 1;
  // Only an attack leaves a rider's own save unrolled; see `riderSaveFactor`.
  if (action.kind !== "attack" || !("riders" in action) || !action.riders?.length) return roll;
  const riders = action.riders;
  const best = Math.max(...riders.map((rider) => riderSaveFactor(rider, defender, false, action.magical, riders)));
  return roll * best;
}

/**
 * The multiplier a routine applies to one swing's expected value when it takes `count` swings
 * with the same option. `count` for the damage, and less than that for the riders: `applyRiders`
 * skips a condition the target already has (`src/engine/fight.ts:950`), so a three-spear routine
 * lands its wound if *any* of the three connects: 1 - (1 - hit)^3, not three separate wounds.
 * Without this, a barbed-spear routine was priced above a routine dealing twice the damage.
 *
 * Returned as a factor rather than a value so the fight's own routine scorer, which prices every
 * swing through `dynamicEv` and its state-dependent multipliers, can apply the same arithmetic
 * to a number this file never sees. Those multipliers scale damage and riders alike, so the
 * rider's share of the price is the same before and after them.
 *
 * One approximation: an attack whose `extraSave` carries riders of its own has two landing
 * chances, and this uses the attack roll's for both.
 *
 * A printed once-per-turn effect (`oncePerTurnKey` on a rider, an `extraSave` or a damage clause) is attempted by the
 * first swing that reaches it and by no later swing of the turn, so its share
 * of one swing's value is worth (1 - (1 - hit)^count) / hit swings, not `count` and not the riders' "any of them lands".
 */
export function repeatFactor(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, count: number, defences: DefenceState = DEFENCES_ACTIVE, runUp?: number): number {
  if (count <= 1) return count;
  return repeatFactorFrom(action, defender, count,
    (priced) => actionEv(priced, attacker, defender, defences, runUp),
    (priced) => actionRiderEv(priced, defender, undefined, runUp, attacker));
}

const plainActions = new WeakMap<CombatAction, CombatAction>();
const unburstActions = new WeakMap<CombatAction, CombatAction>();

/**
 * The action less its once-per-turn effects (`oncePerTurnKey`): what a swing is once the turn's use is spent. With
 * `burstOnly`, less its once-per-turn `extraSave` alone. The action itself when it carries none, and one stable object
 * per action otherwise, so the evaluator's caches can key on it.
 */
export function withoutOncePerTurn(action: CombatAction, burstOnly = false): CombatAction {
  if (action.kind !== "attack") return action;
  const burstKeyed = action.extraSave?.oncePerTurnKey !== undefined;
  const hitKeyed = action.riders.some((rider) => rider.oncePerTurnKey !== undefined)
    || action.damage.some((clause) => clause.oncePerTurnKey !== undefined);
  if (burstOnly ? !burstKeyed : !burstKeyed && !hitKeyed) return action;
  const cache = burstOnly ? unburstActions : plainActions;
  let plain = cache.get(action);
  if (!plain) {
    plain = {
      ...action,
      riders: burstOnly ? action.riders : action.riders.filter((rider) => rider.oncePerTurnKey === undefined),
      damage: burstOnly ? action.damage : action.damage.filter((clause) => clause.oncePerTurnKey === undefined),
      extraSave: burstKeyed ? undefined : action.extraSave,
    };
    cache.set(action, plain);
  }
  return plain;
}

/**
 * `repeatFactor`'s arithmetic, over whichever pricing functions the caller has (the fight's evaluator passes its cached
 * ones). An action with no once-per-turn effect takes the first branch, which is the formula as it always was.
 */
export function repeatFactorFrom(
  action: CombatAction,
  defender: CombatStatblock,
  count: number,
  ev: (priced: CombatAction) => number,
  riderEv: (priced: CombatAction) => number,
): number {
  if (count <= 1) return count;
  const plain = withoutOncePerTurn(action);
  if (plain === action) {
    const riders = riderEv(action);
    if (riders <= 0) return count;
    const single = ev(action);
    if (single <= 0) return count;
    const land = riderLandChance(action, defender);
    const applications = land > 0 ? (1 - (1 - land) ** count) / land : 0;
    return count + Math.min(1, riders / single) * (applications - count);
  }
  const single = ev(action);
  if (single <= 0) return count;
  let factor = count;
  // The riders with no per-turn limit, as above.
  const riders = riderEv(plain);
  if (riders > 0) {
    const land = riderLandChance(plain, defender);
    const applications = land > 0 ? (1 - (1 - land) ** count) / land : 0;
    factor += Math.min(1, riders / single) * (applications - count);
  }
  // The once-per-turn share on a hit (a rider, a damage clause): the first hit attempts it, whatever its save then does,
  // so the share one swing prices behind its attack roll is worth (1 - (1 - hit)^count) / hit swings.
  const unburst = withoutOncePerTurn(action, true);
  const onHit = (unburst === action ? single : ev(unburst)) - ev(plain);
  if (onHit > 0 && action.kind === "attack") {
    const hit = (defender.greaterMagicResistance && action.spell ? 0 : hitChance(action.toHit, defender.ac));
    const attempts = hit > 0 ? (1 - (1 - hit) ** count) / hit : 0;
    factor += Math.min(1, onHit / single) * (attempts - count);
  }
  // A once-per-turn `extraSave` burst: `actionEv` prices a burst with no attack roll in front of it (as certain to be
  // reached by a swing), so the turn's one burst is worth one swing's.
  const burst = unburst === action ? 0 : single - ev(unburst);
  if (burst > 0) factor += Math.min(1, burst / single) * (1 - count);
  return factor;
}

/**
 * The damage half of an action's price, before whatever roll delivers it. Split out of `actionEv`
 * so that `actionEvOnSave` can ask the same question of the same clauses.
 */
function damageEv(action: Exclude<CombatAction, { kind: "random" } | { kind: "selfbuff" } | { kind: "selfheal" } | { kind: "teleport" }>, attacker: CombatStatblock, defender: CombatStatblock, runUp?: number): number {
  return action.damage.reduce((sum, d) => {
    if (d.targetTypes && !d.targetTypes.includes(defender.creatureType)) return sum;
    if (d.excludedTargetTypes?.includes(defender.creatureType)) return sum;
    // A clause the defender's size shuts is worth 0, as `clauseApplies` deals none of it.
    if (d.targetMaxSize !== undefined && defender.size > d.targetMaxSize) return sum;
    // The static price is the one against a full-health foe, which is neither
    // hurt nor Bloodied: a clause gated on either is worth 0, and its complement is worth its whole average (no gate
    // factor). `dynamicEv` prices the clauses that apply at the foe's current Hit Points (`settleTargetHpGates`).
    if (d.requiresTargetHurt || d.requiresTargetBloodied) return sum;
    // Altitude gates are not guesswork: a creature with no fly speed is on the ground for the
    // whole fight, so its grounded clause is certain and its airborne clause is dead. Pricing
    // those two at the generic 0.5 would understate every swing of such a creature.
    const altitudeFactor = altitudeCertainty(d, attacker, defender);
    if (altitudeFactor === 0) return sum;
    const otherGate = d.requiresTargetCondition
      || d.requiresTargetMissingCondition
      || d.requiresAttackerBloodied
      || d.requiresAttackerNotBloodied
      || d.requiresAttackerCondition
      || d.requiresAttackerMissingCondition
      || d.requiresTargetHpAbove !== undefined
      || d.targetHpMax !== undefined
      || d.requiresAttackAdvantage
      || d.requiresAttackNoAdvantage
      || d.requiresAttackerFury;
    // The run-up is settled exactly where the caller knows the square (`runUp`); see `riderGateFactor`.
    const conditionalFactor = runUp !== undefined && d.requiresMovement
      ? (runUp >= d.requiresMovement ? 1 : 0) * (otherGate ? 0.5 : 1)
      : otherGate || d.requiresMovement ? 0.5 : 1;
    return sum + avgDice(d.dice) * damageClauseMultiplier(d, defender, action.magical) * conditionalFactor * altitudeFactor;
  }, 0);
}

/**
 * What a save action is worth when its saving throw is *made* — which is what a Legendary
 * Resistance turns every failure into. The damage the prose still allows on a success, plus the
 * riders whose own text says they apply either way, and nothing else.
 */
export function actionEvOnSave(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, defences: DefenceState = DEFENCES_ACTIVE): number {
  if (action.kind !== "save") return 0;
  const share = evasionShares(action.onSuccess, action.ability, defender, defences);
  return damageEv(action, attacker, defender) * share.onSave
    + ridersEv(action.riders, defender, action.magical, (r) => !!r.appliesOnSuccess, true, undefined, "below", attacker);
}

export function actionEv(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, defences: DefenceState = DEFENCES_ACTIVE, runUp?: number): number {
  if (spellBlocked(action, defender)) return 0;
  // An action printed for "a Large or smaller creature" cannot be aimed at a bigger one.
  if ("targetMaxSize" in action && action.targetMaxSize !== undefined && defender.size > action.targetMaxSize) return 0;
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return 0; // valued dynamically in the fight engine
  if (action.kind === "random") {
    return action.branches.reduce((sum, branch) => sum + actionEv(branch, attacker, defender, defences, runUp), 0) / Math.max(1, action.branches.length);
  }
  const choiceDamage = "choiceRiders" in action ? (action.choiceRiders || []).reduce((sum, r) => sum + r.damage.reduce((s, d) => s + avgDice(d.dice) * damageClauseMultiplier(d, defender, action.magical), 0), 0) : 0;
  const base = damageEv(action, attacker, defender, runUp) + choiceDamage;
  // What the conditions this action applies are worth: the condition itself, the damage it ticks
  // for, and — since this stage — the saving throw that stands between the action and the rider
  // wherever the engine rolls one. `savesRolled` is the same flag `applyRiders` takes, false for
  // an attack and true everywhere else, so a shared save is never charged twice.
  const all = () => true;
  if (action.kind === "attack") {
    const chance = (defender.greaterMagicResistance && action.spell ? 0 : hitChance(action.toHit, defender.ac));
    let ev = chance * (base + ridersEv(action.riders, defender, action.magical, all, false, runUp, "below", attacker));
    if (action.missDamageFactor !== undefined) ev += (1 - chance) * base * action.missDamageFactor;
    if (action.followUp && (action.followUp.targetMaxSize === undefined || defender.size <= action.followUp.targetMaxSize)) {
      // The free attack a hit grants, at the same run-up factor a gated rider is priced with.
      const gated = action.followUp.requiresMovement !== undefined;
      const factor = gated && runUp !== undefined ? (runUp >= action.followUp.requiresMovement! ? 1 : 0) : gated ? 0.5 : 1;
      ev += chance * factor * actionEv(action.followUp.action, attacker, defender, defences);
    }
    if (action.extraSave) {
      const sb = action.extraSave;
      const fail = defender.greaterMagicResistance && action.magical ? 0 : saveFailChance(sb.dc, defender.saves[sb.ability] ?? defender.abilityMods[sb.ability], saveAdvantage(defender, action.magical, actionSaveConditions(sb)));
      const burst = sb.damage.reduce((s, d) => s + avgDice(d.dice) * damageClauseMultiplier(d, defender, action.magical), 0);
      const burstRiderBonus = ridersEv(sb.riders, defender, action.magical, all, true, runUp, "below", attacker);
      const share = evasionShares(sb.onSuccess, sb.ability, defender, defences);
      ev += fail * (burst * share.onFail + burstRiderBonus) + (1 - fail) * burst * share.onSave;
    }
    return ev;
  }
  if (action.kind === "save") {
    // A save-margin tier ("instead takes 64", "also stunned"): each side of the gate at its own chance.
    const tiers = saveMarginTierEvs(action, attacker, defender, defences, all, runUp);
    if (tiers) return (tiers.fail - tiers.failBy) * tiers.below + tiers.failBy * tiers.margin + (1 - tiers.fail) * tiers.onSave;
    const bonus = defender.saves[action.ability] ?? defender.abilityMods[action.ability];
    const fail = defender.greaterMagicResistance && action.magical ? 0 : saveFailChance(action.dc, bonus, actionSaveMode(action, defender));
    const deathBonus = action.instantDeathHpThreshold !== undefined && defender.hpAvg <= action.instantDeathHpThreshold ? defender.hpAvg : 0;
    // Evasion only touches the damage: a failed save still applies every rider the action carries.
    const share = evasionShares(action.onSuccess, action.ability, defender, defences);
    const onFail = ridersEv(action.riders, defender, action.magical, all, true, runUp, "below", attacker);
    // A rider printed to apply on a success or a failure, unless the target is of certain creature types, is worth all
    // of it: a rider that lands either way is not scaled by the failure chance.
    const eitherWay = ridersEv(action.riders, defender, action.magical, (r) => !!r.appliesOnSuccess, true, runUp, "below", attacker);
    return fail * (Math.max(base * share.onFail, deathBonus) + onFail)
      + (1 - fail) * (base * share.onSave + eitherWay);
  }
  // Autohit. Nothing stands between the action and its riders — no attack roll, no save — so
  // they are worth exactly what they are worth. This line read `return base` for as long as the
  // kind has existed, which was harmless only because the constructor that builds these actions
  // never gave them any riders to price; now that it does, an unpriced Swallow is one the
  // chooser never chooses.
  return base + ("riders" in action ? ridersEv(action.riders, defender, action.magical, all, true, runUp, "below", attacker) : 0);
}

/**
 * Memoized on action identity. `actionRange` is a pure function of the action's own
 * immutable fields, and successor transformation swaps in wholly new action objects rather
 * than mutating existing ones, so an entry can never go stale. It is called for every
 * option of both combatants on every turn, which made it a measurable hot spot.
 */
const rangeCache = new WeakMap<CombatAction, number>();

export function actionRange(action: CombatAction): number {
  const cached = rangeCache.get(action);
  if (cached !== undefined) return cached;
  const value = computeActionRange(action);
  rangeCache.set(action, value);
  return value;
}

function computeActionRange(action: CombatAction): number {
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return Infinity; // self-targeted; usable at any distance
  if (action.kind === "random") return Math.max(...action.branches.map(actionRange), 0);
  if (action.kind === "attack") {
    if (action.ranged) return action.longRange ?? action.range ?? 120;
    if (action.melee) return action.reach ?? action.range ?? 5;
    return action.range ?? 5;
  }
  return action.range ?? 120;
}

const landmarkCache = new WeakMap<CombatAction, number[]>();

/**
 * Distances at which this action's expected value changes, for the movement search to consider.
 *
 * `actionRange` answers "how far can this reach?", which for a ranged attack is its *long* range —
 * and that is the only distance the candidate scan used to know about. But EV is not flat across
 * that reach: beyond the normal range the attack rolls at disadvantage, which `distanceEvFactor`
 * prices at 0.6. Every position inside the long-range band therefore scored identically, and the
 * standoff tiebreaker then sent the creature to the far end of it — an archer parked at 120 feet
 * shooting at disadvantage all fight when 30 feet was free of threat and worth two-thirds more.
 *
 * Memoized on action identity for the same reason `actionRange` is: pure in the action's own
 * immutable fields, and successor forms swap in new action objects rather than mutating old ones.
 */
export function actionRangeLandmarks(action: CombatAction): number[] {
  const cached = landmarkCache.get(action);
  if (cached !== undefined) return cached;
  const value = computeActionRangeLandmarks(action);
  landmarkCache.set(action, value);
  return value;
}

function computeActionRangeLandmarks(action: CombatAction): number[] {
  if (action.kind === "random") return [...new Set(action.branches.flatMap(actionRangeLandmarks))];
  if (action.kind === "attack" && action.ranged
    && action.range !== undefined && action.longRange !== undefined && action.longRange !== action.range) {
    return [action.longRange, action.range];
  }
  return [actionRange(action)];
}

export function actionInRange(action: CombatAction, distance: number): boolean {
  if (action.kind === "random") return action.branches.some((b) => actionInRange(b, distance));
  return distance <= actionRange(action);
}

export function actionEvAtDistance(
  action: CombatAction,
  attacker: CombatStatblock,
  defender: CombatStatblock,
  distance: number,
  defences: DefenceState = DEFENCES_ACTIVE,
  runUp?: number,
): number {
  if (!actionInRange(action, distance)) return 0;
  return actionEv(action, attacker, defender, defences, runUp)
    * distanceEvFactor(action, distance, defender.ac)
    * attackDisadvantageFactor(action, defender, distance, defences);
}

export function distanceEvFactor(action: CombatAction, distance: number, ac?: number): number {
  const dis = (a: CombatAction) => ac !== undefined && a.kind === "attack" ? hitChance(a.toHit, ac) : 0.6;
  if (action.kind === "random") {
    const usable = action.branches.filter((b) => actionInRange(b, distance));
    if (!usable.length) return 0;
    return usable.reduce((sum, b) => sum + distanceEvFactor(b, distance, ac), 0) / usable.length;
  }
  if (action.kind === "attack" && action.ranged) {
    if (action.range !== undefined && distance > action.range) return dis(action);
    if (distance <= 5 && !action.melee) return dis(action);
  }
  return 1;
}

/**
 * `allowLimited: false` asks "what can this creature reliably bring to bear?" — it is the
 * threat term the movement AI prices a candidate position against, and the baseline a
 * self-buff is valued against. A recharge or per-day option is not *absent* from that
 * question, merely uncertain, so it is discounted rather than excluded. Excluding it made
 * a dragon with its breath ready read as threatening nothing at all from 30 feet, since every
 * option it owns beyond a melee attack is limited-use.
 */
const holdRangeCache = new WeakMap<CombatStatblock, number>();

/** The farthest any of the block's options can put Grappled on a target: beyond it the block holds nobody. */
function holdRange(block: CombatStatblock): number {
  let range = holdRangeCache.get(block);
  if (range === undefined) {
    range = 0;
    for (const option of block.options) {
      const action = option.action;
      if ("riders" in action && action.riders?.some((r) => r.condition === "grappled")) range = Math.max(range, actionRange(action));
    }
    holdRangeCache.set(block, range);
  }
  return range;
}

/**
 * What an attack gains from Advantage on a target its maker has Grappled, where a Bonus Action of the block takes that
 * hold from this distance: the hold is tried each turn, so it is counted as landed in one of two tries, and Advantage
 * turns a hit chance p into 1 - (1 - p)^2. Without it a Tough Boss walked into a Bugbear Stalker's Quick Grapple with
 * its Warhammer where its Heavy Crossbow from 60 ft won more (R06).
 */
function heldAdvantage(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, distance: number): number {
  if (action.kind !== "attack" || action.advantageWhen !== "targetGrappledByAttacker" || defender.conditionImmune.includes("grappled")) return 1;
  let land = 0;
  for (const option of attacker.options) {
    if (option.timing !== "bonus" || !actionInRange(option.action, distance) || !("riders" in option.action)) continue;
    if (!option.action.riders?.some((r) => r.condition === "grappled" && riderGateFactor(r, defender, []) > 0)) continue;
    land = Math.max(land, riderLandChance(option.action, defender));
  }
  if (land <= 0) return 1;
  const held = 1 - (1 - land) ** 2;
  return 1 + held * (1 - hitChance(action.toHit, defender.ac));
}

export function routineEvAtDistance(routine: Routine, attacker: CombatStatblock, defender: CombatStatblock, distance: number, allowLimited = true): number {
  if (routine.maxDistance !== undefined && distance > routine.maxDistance) return 0;
  let partDistance = distance;
  let mayGrapple = false;
  const base = routine.parts.reduce((sum, part) => {
    const option = attacker.options[part.optionIdx];
    if (!option) return sum;
    const action = option.action;
    if (action.kind === "autohit" && action.pull && mayGrapple) {
      partDistance = Math.max(5, partDistance - action.pull);
      return sum;
    }
    if (!defender.conditionImmune.includes("grappled") && actionInRange(action, partDistance) && "riders" in action
      && action.riders?.some(r => r.condition === "grappled" && riderGateFactor(r, defender, []) > 0)) mayGrapple = true;
    // An action on a target the block has Grappled (a Fling) reaches no farther than its hold does (SZ02).
    if ("requiresTargetCondition" in action && action.requiresTargetCondition === "grappled" && partDistance > holdRange(attacker)) return sum;
    const discount = allowLimited || option.uses.t === "atWill" ? 1 : option.uses.t === "recharge" ? 0.5 : 0.4;
    // `repeatFactor`, not `part.count`: the damage of a three-attack routine multiplies and its
    // riders do not.
    return sum + actionEvAtDistance(option.action, attacker, defender, partDistance)
      * repeatFactor(option.action, attacker, defender, part.count) * discount * heldAdvantage(action, attacker, defender, partDistance);
  }, 0);
  if (!routine.onAllHits) return base;
  let hitProbability = 1;
  let attacksNeeded = routine.onAllHits.requiredHits;
  for (const part of routine.parts) {
    const action = attacker.options[part.optionIdx]?.action;
    if (!action || action.kind !== "attack") continue;
    const used = Math.min(part.count, attacksNeeded);
    hitProbability *= (defender.greaterMagicResistance && action.spell ? 0 : hitChance(action.toHit, defender.ac)) ** used;
    attacksNeeded -= used;
    if (attacksNeeded <= 0) break;
  }
  return base + actionEvAtDistance(routine.onAllHits.action, attacker, defender, distance) * hitProbability;
}

export function bestRoutineEvAtDistance(attacker: CombatStatblock, defender: CombatStatblock, distance: number, allowLimited = true): number {
  return attacker.routines.reduce((best, routine) => Math.max(best, routineEvAtDistance(routine, attacker, defender, distance, allowLimited)), 0);
}


/** No attack roll or damage packet can penetrate these spell-specific defenses. */
export function spellBlocked(action: CombatAction, defender: CombatStatblock): boolean {
  return !!action.spell && ((!!defender.greaterMagicResistance && action.kind === "attack" && action.missDamageFactor === undefined && !action.extraSave?.onMiss)
    || (!!defender.reflectiveCarapace && ((action.kind === "attack" && action.ranged) || action.spellName === "Magic Missile")));
}
