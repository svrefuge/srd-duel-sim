export type DraconicOrigin = "acid" | "cold" | "fire" | "lightning" | "poison";
export type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";
export type Timing = "action" | "bonus" | "legendary";
export type Uses =
  | { t: "atWill" }
  | {
    t: "recharge"; min: number; /** Variants of one action share the same recharge roll. */ pool?: string;
    /**
     * Spells one use casts ("casts Fireball twice ... It can replace one Fireball with ..."): once the recharge is spent,
     * the pool's options stay usable for this many casts in all, until the end of that turn.
     */
    casts?: number;
  }
  | { t: "perDay"; max: number; /** Shared resource key, such as a prepared spell-slot level. */ pool?: string };

export interface DicePool {
  n: number;
  d: number;
  mod: number;
}

/**
 * The state in which a printed conditional Advantage on an attack roll holds:
 * - `targetGrappledByAttacker`: the target has the Grappled condition from the attacker;
 * - `targetMissingHp`: the target "doesn't have all its Hit Points" (below its current Hit Point maximum; temporary Hit
 *   Points are not Hit Points);
 * - `attackerMissingHp`: the same of the attacker;
 * - `attackerBloodied`: the attacker is at or below half its current Hit Point maximum;
 * - `attackerAttached`: the attacker is attached to the target (the target holds `attached` from the attacker);
 * - `targetFrightened`: the target has the Frightened condition, whatever its source;
 * - `firstRound`: neither creature has started a second turn;
 * - `targetNoTurnYet`: the target has not started its first turn.
 */
export type AttackAdvantageCondition =
  | "targetGrappledByAttacker" | "targetMissingHp" | "attackerMissingHp" | "attackerBloodied"
  | "attackerAttached" | "targetFrightened" | "firstRound" | "targetNoTurnYet" | "attackerNotIncapacitated";

/** A trait granting Advantage on the creature's attack rolls in a state of the fight (Blood Frenzy, Bloodied Fury). */
export interface AttackAdvantageTrait {
  name: string;
  when: AttackAdvantageCondition;
  /** The print says "melee attack rolls": only a melee attack made within its reach. */
  melee?: boolean;
}

export interface DamageClause {
  dice: DicePool;
  type: string;
  /** The attacker chooses the most effective listed damage type when the stat block permits it. */
  typeChoices?: string[];
  bypassResistance?: boolean;
  /** Clause applies only while the target has/doesn't have this condition. */
  requiresTargetCondition?: string;
  requiresTargetMissingCondition?: string;
  /** Clause applies only while the attacker is/isn't Bloodied. */
  requiresAttackerBloodied?: boolean;
  requiresAttackerNotBloodied?: boolean;
  requiresAttackerCondition?: string;
  requiresAttackerMissingCondition?: string;
  /** Clause applies only above/at-or-below the indicated current-HP threshold. */
  requiresTargetHpAbove?: number;
  targetHpMax?: number;
  /**
   * Clause applies only while the target is below its current Hit Point maximum, read before this packet's damage: a
   * print where a target missing any of its hit points takes a different damage amount instead, or takes an extra die
   * of piercing damage if it doesn't have all its hit points.
   */
  requiresTargetHurt?: boolean;
  /**
   * The complement of `requiresMovement`: the base side of "N damage, or M damage if the creature moved 20+ feet
   * straight toward the target", applied only when the run-up is shorter than this many feet (Giant Seahorse's Ram).
   * Read with `requiresMovementImmediate` as the run-up gate is.
   */
  requiresNoRunUp?: number;
  /** The complement: the clause an "instead" replaces applies only while the target has all its Hit Points. */
  requiresTargetUnhurt?: boolean;
  /**
   * Clause applies only while the target is Bloodied (at or below half its current maximum), read before this packet's
   * damage: a print where a hit deals one amount, or a larger amount if the target is Bloodied (the Blood Hawk's
   * Beak).
   */
  requiresTargetBloodied?: boolean;
  /** The complement: the base side of a target-Bloodied alternative. */
  requiresTargetNotBloodied?: boolean;
  /** The attack roll must actually have Advantage after Advantage/Disadvantage cancel. */
  requiresAttackAdvantage?: boolean;
  /** The base side of an Advantage alternative: applies only when the attack roll did not have Advantage. */
  requiresAttackNoAdvantage?: boolean;
  /** Creature-type gates on one damage alternative rather than the whole action. */
  targetTypes?: string[];
  excludedTargetTypes?: string[];
  /** Damage also shrinks the target's hit-point maximum, by as much as was dealt. */
  reducesMaxHp?: boolean;
  /**
   * With `reducesMaxHp`: the maximum falls by half the damage dealt, rounded down.
   */
  reducesMaxHpHalf?: boolean;
  /** With `reducesMaxHp`: the reduction lands only when this save fails (`MaxHpReductionSave`). */
  reducesMaxHpSave?: MaxHpReductionSave;
  /** With `reducesMaxHp`: the lowest maximum this reduction can leave (Harm: "can't reduce a target's Hit Point maximum below 1"). */
  reducesMaxHpFloor?: number;
  /**
   * A hit that would drop the target to 0 Hit Points instead leaves it at 1 with the Petrified condition. A frozen
   * statue is out of the duel exactly as stone is, and
   * unlike ordinary death at 0 it cannot be undone by regeneration, Undead Fortitude or a troll
   * rule — which is the whole point of the clause.
   */
  petrifiesOnLethalDamage?: boolean;
  /** Damage heals the attacker by the amount actually dealt. */
  healsAttacker?: boolean;
  /** Damage heals the attacker by this fixed amount once when this clause deals damage. */
  healsAttackerFlat?: number;
  /** Charge-style clause requiring this much straight-line movement immediately before the hit. */
  requiresMovement?: number;
  /**
   * The print's run-up is "immediately before the hit": only the first attack after the approach carries it, hit or
   * miss. Set beside `requiresMovement`; without it the gate reads the whole turn's
   * approach, as older prints say ("and then hits it ... on the same turn").
   */
  requiresMovementImmediate?: true;
  /**
   * Clause applies only to a target of this size rank or smaller: a print where a Large or smaller target that the
   * attacker approached in a straight line immediately before the hit takes extra damage and has the Prone condition
   * (the Rhinoceros's Charge; the cap opens the sentence and governs the damage as well as the Prone, whose
   * rider carries its own `targetMaxSize`).
   */
  targetMaxSize?: number;
  /** Clause applies only while the attacker's `fury` trait is switched on (an anger-driven trait). */
  requiresAttackerFury?: boolean;
  /**
   * Clause deals its damage at most once per turn. A bonus printed for the first time a creature hits with a given
   * attack is worth one bonus, not one per swing of a Multiattack that repeats that attack.
   */
  oncePerTurn?: boolean;
  /**
   * A printed once-per-turn effect (a weapon that can emit a burst only once per turn): the per-turn group key.
   * The clause is dealt on the first hit of a turn (any creature's turn) on which its key is unused, and spends the key.
   * See `Rider.oncePerTurnKey`. Not `oncePerTurn` above, which resets on the attacker's own turn only, is spent only by
   * damage above 0 and is priced on every swing.
   */
  oncePerTurnKey?: string;
  /**
   * Clause applies only while the named side is on the ground / off it (a creature that hits
   * far harder while it is on the ground). Carries the subject rather than being
   * split into four booleans because the source prose can name either combatant.
   */
  requiresGrounded?: "attacker" | "target";
  requiresAirborne?: "attacker" | "target";
}

/**
 * The save that gates a reduction of the Hit Point maximum:
 * - a save of its own, rolled after the damage has landed (a Constitution save or the target's Hit Point maximum falls
 * by that damage). Rolled once per damage packet;
 * - `"action"`: the save action's own save, for an action whose damage does not wait on that save (full damage on
 *   a success) or that has none. The reduction lands only on the packet a failed save deals.
 * Legendary Resistance is not spent on the reduction (a save's damage, incapacitation and outright
 * death are covered by the policy; a reduction of the maximum is none of them).
 */
export type MaxHpReductionSave = { ability: Ability; dc: number } | "action";

/**
 * A reduction of the target's Hit Point maximum by dice of its own, not by the damage a clause dealt: a hit that also
 * reduces the maximum by a rolled amount, or a failed save that decreases it by a rolled amount (`save: "action"`). It
 * lands with the action's own damage packet (a
 * hit; a failed save), whatever that packet dealt, and it is not damage: no resistance, critical or temporary hit points
 * touch it. Current hit points are capped at the new maximum.
 */
export interface MaxHpReduction {
  dice: DicePool;
  save?: MaxHpReductionSave;
  /** Lands only on a target that already has this condition from the attacker: "Subsequent Failures: The Poisoned target's ...". */
  requiresTargetCondition?: string;
}

/**
 * An object a hold hangs on (`Rider.breakable`). `item` marks the creature's own equipment, printed in a trait
 * ("The erinyes has a magic rope ... The rope has AC 20, HP 90"): one object for the whole fight, whose damage
 * carries over between uses and whose destruction takes the action that requires it away. Without it each use makes a
 * new object (a web strand).
 */
export interface BreakableObject {
  /** The print's noun for it ("web", "rope"), for the log. */
  name: string;
  ac: number;
  hp: number;
  immune: string[];
  vulnerable: string[];
  item?: true;
}

export interface ChoiceRider {
  condition: string;
  duration: Rider["duration"];
  damage: DamageClause[];
}

export interface Rider {
  /** The level of the spell this rider comes from, which Dispel Magic reads (`ConditionState.spellLevel`). */
  spellLevel?: number;
  push?: number;
  /**
   * The push is the attacker's own, printed "pushes the target up to" its feet: the attacker chooses how far, nothing
   * included (`choosePush`). Absent: the print's feet, always.
   */
  pushUpTo?: true;
  /** Feet the attacker pulls the target straight toward itself on a hit (a forced move; the rider's own gates apply). */
  pull?: number;
  /** The pull is printed "up to" its feet: the attacker chooses how far, nothing included (`choosePull`). Absent: the print's feet, always. */
  pullUpTo?: true;
  /**
   * Feet the source lifts the target straight up, within the action's range and under the ceiling; the target hangs there
   * until the condition ends and then falls if it cannot fly (Telekinesis: "if you lift it into the air, it is suspended
   * there").
   */
  lift?: number;
  /**
   * The target leaves play until the copy ends, then reappears in a space of the source's choice within this many feet
   * of the source (a banishment to a harmless demiplane).
   */
  reappearWithin?: number;
  acAdjustment?: number;
  oneAttack?: true;
  slowCasting?: true;
  condition: string;
  save?: { ability: Ability; dc: number };
  /**
   * A printed once-per-turn effect (a weapon that can flare only once per turn; or several additional effects, each up
   * to once per turn): the per-turn group key. The effect is attempted at most once in a
   * turn, any creature's turn: the first hit that reaches its save (or its automatic application) spends the key,
   * whether or not the save succeeds, and later hits of that turn deal their ordinary damage only. Effects that share a
   * key share the turn's one use (a choice among several additional effects); effects printed
   * "once per turn each" carry a key each. Also on `SaveEffect` and `DamageClause`.
   */
  oncePerTurnKey?: string;
  escapeDc?: number;
  escapeAbilities?: Ability[];
  /**
   * The print gives Disadvantage on the check to escape this hold (an escape DC stated with disadvantage, or ability
   * checks made to escape the grapple having Disadvantage; Mimic's Pseudopod is one). The escape roll and its priced
   * odds read it beside Poisoned and Frightened.
   */
  escapeDisadvantage?: boolean;
  /**
   * The thing that holds the target is an object with its own statistics, and the hold ends when it is destroyed:
   * "until the web is destroyed (AC 10; HP 5; Vulnerability to Fire damage; Immunity to ...)". The print gives no
   * check to get out, so the rider carries no `escapeDc`; the held creature aims attack rolls at the object instead.
   */
  breakable?: BreakableObject;
  /**
   * The source possesses the target: "The target is possessed by the ghost; the ghost disappears, and the target has
   * the Incapacitated condition and loses control of its body." While this copy holds, the source can't be targeted,
   * goes where the body goes, and acts on the body only with its own attacks; the body does nothing of its own.
   */
  possession?: true;
  /**
   * The source controls the Charmed target while the two are within this many feet: "While Charmed, the target acts
   * as an ally to the aboleth and is under its control while within 60 feet of it." While this copy holds and the
   * pair stand that close, the target does nothing of its own: no movement, action, Bonus Action, Reaction or
   * Legendary Action.
   */
  controlRange?: number;
  /**
   * The Charmed target walks to the source: "If the target is more than 5 feet from the harpy, the target moves on its
   * turn toward the harpy by the most direct route, trying to get within 5 feet of the harpy." While this copy holds
   * the target's movement is not its own choice.
   */
  drawnToSource?: true;
  /** The hold ends when its source uses the same action again: "or the erinyes uses Entangling Rope again". */
  endsOnReuse?: true;
  /** Movement the source can spend on its turn to detach itself from this target. */
  sourceDetachMovement?: number;
  /**
   * While this hold is on its victim, the holder takes half of any damage dealt to it (rounding down) and the target
   * suffers the same amount (an attachment or smothering grapple).
   */
  sharesHolderDamage?: true;
  /** A dependent rider applies only if its parent condition actually applied. */
  requiresTargetCondition?: string;
  targetMaxSize?: number;
  requiresMovement?: number;
  /** As the damage clause's: the run-up belongs to the first attack after the approach. */
  requiresMovementImmediate?: true;
  targetTypes?: string[];
  excludedTargetTypes?: string[];
  excludedTargetTags?: string[];
  blockedByConditions?: string[];
  /**
   * No condition on a target immune to this damage type (a gaze that paralyzes a target not immune to Cold damage).
   * `AbilityDrain.unlessImmuneTo`'s name and meaning.
   */
  unlessImmuneTo?: string;
  /** Rider applies only at-or-below this current-HP threshold. */
  targetHpMax?: number;
  requiresTargetHpAbove?: number;
  /**
   * `endOfTargetNextTurn` is "until the end of its next turn"; `endOfSourceNextTurn` is until the end
   * of the source's next turn, which outlasts the target's own turn and runs through the source's.
   * `startOfTargetNextTurn` lasts only until the target's next turn begins: it
   * ends as the target's next turn begins, so one applied on the source's turn costs the target none of its
   * own, and one an aura lands at the start of the target's turn lasts through that turn only.
   */
  duration: "endOfTargetTurn" | "startOfSourceNextTurn" | "startOfTargetNextTurn" | "endOfTargetNextTurn" | "endOfSourceNextTurn" | "saveEndsEachTurn" | "untilEscape" | "permanent";
  /**
   * A `permanent` rider's printed time limit, in rounds (a condition lasting 1 minute is 10). It is counted in
   * the source's turns, as a Concentration spell's minute is: the condition ends as the source's tenth later turn begins.
   * Set only for an incapacitating condition with no other way out, and for a heal
   * block printed "for 1 minute".
   */
  rounds?: number;
  /**
   * While the target holds this copy it can't regain hit points (for instance a poisoned creature barred from healing,
   * or a target barred from healing through its next turn's end; a `healBlocked` rider).
   * Blocks regeneration (a death-rule regenerator at 0 HP then fails to regenerate), healing, a drain's heal, absorption's
   * heal and a reaction's heal; not temporary hit points, Undead Fortitude, a mythic reset or a successor form.
   */
  blocksHealing?: true;
  /**
   * On a `prone` rider: while the target holds this copy it cannot get up from prone. Its
   * only movement is to crawl, at half its Speed.
   */
  cannotStand?: true;
  /**
   * On a `grappled` rider: while the target holds this copy it can't teleport (a grapple that also Restrains the target
   * until it ends; the Tarrasque's Bite is one). The ban ends with
   * the grapple.
   */
  blocksTeleport?: true;
  /** Condition breaks when the target takes damage (Sleep, Hypnotic Pattern). */
  endsOnDamage?: boolean;
  endsOnSourceDamage?: true;
  sourceDamageException?: string;
  willingFor?: string;
  /** Damage triggers another save rather than ending the condition outright. */
  saveOnDamage?: boolean;
  /**
   * Which damage types trigger that save, when the prose names one. A swarm's
   * poison can be shaken off by burning it out and by nothing else: the poisoned target gets another save whenever it
   * takes fire damage.
   */
  saveOnDamageTypes?: string[];
  /**
   * That save is rolled with Advantage, when the text prints it (Hideous Laughter: "The target has Advantage on the save
   * if the save is triggered by damage"; Dominate Person's Advantage while the caster is fighting the target). Absent: a
   * plain roll (Dominate Mind).
   */
  saveOnDamageAdvantage?: true;
  /**
   * Conditions this rider *removes* as it lands. A swallow ends the grapple that set it up —
   * "While swallowed, the target isn't Grappled" — and six actions in the corpus say so.
   */
  endsConditions?: string[];
  /** Failed repeat save changes the condition (2024 Sleep, petrification's second failure). */
  transitionOnFailedSave?: string;
  /**
   * How many *successful* repeat saves it takes to be rid of this. One unless the prose says
   * otherwise, and only a few effects say otherwise (an effect that ends after three successful saves).
   */
  savesToEnd?: number;
  /**
   * Whether the condition it *becomes* ends on damage. Sleep's does — a slap wakes the sleeper.
   * Petrification's does not, which is the whole point of turning to stone.
   */
  transitionEndsOnDamage?: boolean;
  /**
   * The condition it *becomes* keeps the same save, repeated when each of the target's turns ends. A Silver
   * Dragon's Paralyzing Breath prints it for its second stage ("it repeats the save at the end of each of its turns,
   * ending the effect on itself on a success"). Absent, the escalated condition is permanent: petrification is the
   * end of the duel, and Sleep's unconsciousness ends on damage or with the spell.
   */
  transitionSaveEndsEachTurn?: true;
  /**
   * Rounds the condition it *becomes* lasts at most, counted in the holder's own turns from the failure that made it:
   * Sleep Breath's "Unconscious condition for 1 minute", and Paralyzing Breath's "After 1 minute, it succeeds
   * automatically" (ten rounds).
   */
  transitionRounds?: number;
  /**
   * A condition that follows at a later turn boundary if this one still holds, with no save of its own: at the start of
   * the source's next turn, a target that is still Grappled gains a further condition. It lands once, at the first start of the source's turn after this rider was applied, and
   * only on the same condition copy.
   */
  delayedCondition?: { condition: string; at: "startOfSourceNextTurn" };
  /**
   * A save-margin tier: the rider lands only when the saving throw that governs it fails by at least this much (a
   * creature that fails by 5 or more is also stunned, `{@actSaveFailBy 5}`). The governing save is the
   * action's own (a save action, a burst, an aura) or, on an attack, the first roll against this rider's `save` in the
   * same application. An automatic failure has no total and fails by no margin.
   */
  saveFailMargin?: number;
  /**
   * The base tier a margin tier replaces (a failed save otherwise; the 2024 `{@actSaveFail}` tier printed beside
   * `{@actSaveFailBy 5}`): the rider lands only when the governing save fails by less than this.
   */
  saveFailMarginBelow?: number;
  /** The condition fixes Speed at 0 even though the base condition doesn't. */
  speedZero?: boolean;
  /**
   * A printed partial Speed cut, in feet, for as long as this rider's copy holds: the target's Speed decreases by 10
   * feet until the end of its next turn (the Frost Giant's Great Bow). On a rider of its own (`speedCut`, with the
   * printed clock) or on the condition the print ties it to (a wounded target's Speed is reduced by 10 feet).
   * Applied (`currentSpeed`), not priced.
   */
  speedCut?: number;
  /** The same for a halved Speed. Flat cuts apply first, then one halving. */
  noReactions?: true;
  /**
   * The holder can't cast spells with a Verbal component while this copy lasts (held in the Invisible Stalker's Vortex,
   * engulfed by a Gelatinous Cube): spell options marked `verbal` are unusable, Counterspell included.
   */
  noVerbalSpells?: true;
  /** The holder can't take a Bonus Action while this copy lasts (the Ice Devil's Ice Spear). */
  noBonusActions?: true;
  /**
   * "It can move or take one action on its turn, not both" (Ice Spear). The holder takes its action when it has a
   * usable routine from where it stands, or has already spent the action, and does not move; otherwise it moves and
   * takes no action (so no Dash).
   */
  moveOrAct?: true;
  /** Disadvantage on the holder's saving throws to maintain Concentration while this copy lasts (Cloud of Insects). */
  concentrationDisadvantage?: true;
  actionOrBonus?: true;
  /** One packet at a specified next-turn boundary, independent of recurring condition ticks. */
  delayedDamage?: { damage: DamageClause[]; clock: "source" | "target"; disgorge?: true };
  speedHalved?: true;
  /** The condition lasts "before the end of this turn": it ends when the turn it landed in ends, whoever's turn it is. */
  endsThisTurn?: true;
  /**
   * The two harpoons say so in as many words: "its speed isn't reduced". Grappled normally
   * pins a creature where it stands, and these do not, so the name alone would take away a
   * Speed the source explicitly leaves alone.
   */
  speedNotReduced?: boolean;
  /**
   * The victim may move, but only closer to whoever holds it (a harpoon line that lets it only approach the holder,
   * never retreat). Rope,
   * not paralysis: it goes with `speedNotReduced` rather than replacing it.
   */
  approachOnly?: boolean;
  /**
   * The grip belongs to something the creature throws, which stays on the victim (a flung limb with its own
   * statistics). No line runs back to the thrower, so the hold has no reach,
   * ties neither fighter to the other, and follows its victim anywhere.
   */
  detachedHold?: boolean;
  /**
   * Damage the victim takes for *trying* to get out, whether or not it succeeds (a grapple that deals slashing damage if
   * the victim escapes or tries and fails). Not
   * damage the attack deals: reading it as a second clause on the hit gave both harpoons a
   * free extra die on every shot.
   */
  escapeAttemptDamage?: DamageClause[];
  /** Damage dealt at the start of the affected creature's turn. */
  /** A spell must actually restore HP to close this wound. */
  endsOnHealingSpell?: true;
  /** Wisdom (Medicine) action to close this wound, at the printed DC. */
  stanchDc?: number;
  startTurnDamage?: DamageClause[];
  /**
   * Damage dealt at the end of the affected creature's turn, after it has acted — a grapple
   * that crushes (damage when each of the target's turns ends while the grapple lasts) rather than one that ticks
   * before its victim moves. The half-round
   * difference is worth keeping: a start-of-turn tick lands before the victim's first action
   * and an end-of-turn one cannot.
   */
  endTurnDamage?: DamageClause[];
  /** Damage dealt by the affected creature in one turn ends this state (regurgitation). */
  sourceDamageEscapeThreshold?: number;
  /** Constitution save the source makes at turn end after that threshold; absent means automatic. */
  sourceDamageEscapeSaveDc?: number;
  /** Rider applies regardless of whether the action's saving throw succeeds. */
  appliesOnSuccess?: boolean;
  /** Rider applies only when the action's saving throw succeeds: "Success: Half damage, and the target is pushed 5 feet". */
  onlyOnSuccess?: boolean;
  /** Rider applies only on a hit whose attack roll had Advantage: "and the darkmantle had Advantage on the attack roll". */
  requiresAttackAdvantage?: boolean;
  /**
   * Riders sharing a group are alternatives the *attacker* picks between, not effects that all
   * land: e.g. the target becomes Charmed or Poisoned, whichever the attacker picks. Exactly one of
   * the group applies. Distinct from `choiceRiders`, which is the victim's choice to shrug a
   * condition off by taking extra damage.
   */
  choiceGroup?: number;
  /**
   * "The target is immune to this werewolf's curse for 24 hours": a made save against this rider makes the target
   * immune to it for the rest of the duel, while the attack that carries it still hits and hurts.
   */
  immuneOnSuccess?: SuccessImmunity;
  /**
   * A magical sleep: it does not land on a creature that magic can't put to sleep
   * (`sleepImmune`). A save action whose whole effect is such riders cannot target that creature at all.
   */
  magicalSleep?: true;
  /**
   * What holding this rider does to rolls: a weakened creature having Disadvantage on Strength checks and saves,
   * subtracting a die from its damage rolls, Disadvantage on the next attack roll it makes before its next turn ends,
   * or Advantage on the next attack roll made against the target (Guiding Bolt). The
   * rider's own `duration` (and `rounds`) says how long; `RollEffect.nextRollOnly` ends it sooner.
   */
  rollEffects?: RollEffect[];
}

/**
 * One way a held condition changes a roll (`Rider.rollEffects`).
 * - `roll`: the holder's `attack` rolls, saving throws (`save`), ability checks (`check`) or `damage` rolls, or attack rolls
 *   made against the holder (`attackAgainst`).
 * - `ability`: only saves or checks of that ability; on `attack` and `damage`, only a weapon attack that relies on it
 *   (Strength, the only one printed).
 * - `mode`: Advantage or Disadvantage on the d20; `penalty` subtracts `dice` from the d20 test's total or from the damage
 *   roll; `half` halves the damage.
 * - `nextRollOnly`: spent by the first roll it changes, and the condition ends with it.
 */
export interface RollEffect {
  roll: "attack" | "save" | "check" | "damage" | "attackAgainst";
  ability?: Ability;
  /** `penalty` subtracts `dice` from the roll and `bonus` adds it (Bless: "the target adds 1d4 to the attack roll or save"). */
  mode: "advantage" | "disadvantage" | "penalty" | "bonus" | "half";
  dice?: DicePool;
  nextRollOnly?: true;
  /** An `attackAgainst` effect only for an attacker that can see its holder (Faerie Fire: "if the attacker can see it"). */
  requiresSight?: true;
  /** An `attackAgainst` effect only for an attacker of one of these creature types (Dispel Evil and Good). */
  attackerTypes?: string[];
}

/**
 * A successful save can make the target immune to the effect for 24 hours. In a duel, 24 hours or 1 hour
 * is the rest of the fight. `key` names the effect (the option's name, or `curse`) and is unique within a block;
 * the target holds the immunity, and its only foe is the source. `trigger` is what the print says grants it:
 * - `save`: a success on the initial save;
 * - `anySave`: a success on the initial save or on a repeat save;
 * - `saveOrEnd`: a success on the initial save, or the effect ending on the target in any way;
 * - `end`: the effect ending (the target is immune after the effect ends); a made
 *   initial save grants nothing.
 */
export interface SuccessImmunity {
  key: string;
  trigger: "save" | "anySave" | "saveOrEnd" | "end";
}

/** A saving-throw damage burst that resolves independently of an attack (e.g. Ice Knife). */
export interface SaveEffect {
  ability: Ability;
  dc: number;
  damage: DamageClause[];
  onSuccess: "half" | "none";
  /** Conditions governed by this same saving throw; avoids rolling the save twice. */
  riders?: Rider[];
  /** Ice Knife is exceptional; most secondary saves happen only after the attack hits. */
  onMiss?: boolean;
  /** The burst fires at most once in a turn (a weapon whose burst can occur only once per turn). See `Rider.oncePerTurnKey`. */
  oncePerTurnKey?: string;
}

/**
 * Damage an option deals its own user each time it is used: for example an attack that deals force damage to its
 * user after resolving the attack, hit or miss, or a spray that deals slashing damage to its user before the spray
 * (damage nothing can lessen). Applied
 * by the fight engine when the action resolves; the chooser does not price it (the policy has no clause for it).
 */
export interface SelfCost {
  dice: DicePool;
  type: string;
  /** Paid before the option's effect ("slices itself ... releasing a spray") or after it ("after resolving the attack"). */
  when: "before" | "after";
  /** A damage amount that nothing can lessen: the user's resistances and immunities do not touch it. */
  irreducible?: true;
}

/**
 * Temporary hit points the acting creature gives itself. A separate pool that damage spends first; a new grant
 * replaces a smaller one and never stacks, and it is not healing (it can never lift a creature off 0 hit points).
 */
export interface SelfTempHp {
  /** Fixed or rolled amount. */
  dice?: DicePool;
  /** Or an amount taken from the damage this action deals. */
  ofDamage?: "full" | "half";
  /** Only when the target already has this condition (the Death Giants' Frightened gate). */
  requiresTargetCondition?: string;
  /** Creature types the grant does not pay against (one reptilian leader's Constructs and Undead). */
  excludedTargetTypes?: string[];
  /** Grants that state an end; the rest last until spent. */
  expires?: "startOfNextTurn";
}

/**
 * Ability-score drain (the target's score is reduced by a die roll, and it dies if this reduces the score to 0). The
 * engine keeps the target's current score and slays it outright at 0; save and check modifiers stay static.
 */
export interface AbilityDrain {
  ability: Ability;
  dice: DicePool;
  /** When it lands: on a hit (attack), on a failed save, or on either save result. */
  on: "hit" | "failedSave" | "eitherSave";
  /** Only these creature types are drained ("If the target is a Humanoid"). */
  targetTypes?: string[];
  /** No drain on a target immune to this damage type. */
  unlessImmuneTo?: string;
}

/**
 * A target reduced to 0 hit points by this damage or ray dies (also Disintegrate's dust). When the action's packet
 * drops the target from above 0 to 0 hit points, it is slain: regeneration's troll rule, Undead Fortitude, a mythic
 * reset and a successor form all answer a drop to 0, and
 * this is death.
 */
export interface SlayOnZeroHp {
  /** Only these creature types die of it (for example, a Humanoid reduced to 0 Hit Points by this damage). */
  targetTypes?: string[];
  /** Only a target of this size or smaller dies of it (a Medium or smaller creature reduced to 0 Hit Points). */
  targetMaxSize?: number;
}

/**
 * An option's sight gate. `true`: the source must see the target (its Blindness, senses and the target's invisibility
 * count). `"point"`: the print names a point the source can see, so the source must see the place: its own Blindness,
 * blindsight and `blindBeyond` count, the target's invisibility does not.
 */
export type SightGate = boolean | "point";

export interface AttackAction {
  /**
   * The attack is repeated on the caster's later turns while the spell's Concentration lasts, at no further use
   * (Spiritual Weapon: "As a Bonus Action on your later turns, you can move the force up to 20 feet and repeat the
   * attack"). As `SaveAction.sustained`.
   */
  sustained?: true;
  /**
   * A free attack this attack's hit grants ("...and the allosaurus can make one Bite attack against it"), under the
   * same size and run-up gates as the sentence that prints it. `action` is the named option's own attack.
   */
  followUp?: { name: string; action: AttackAction; targetMaxSize?: number; requiresMovement?: number; requiresMovementImmediate?: true };
  missDamageFactor?: number;
  /**
   * Conditions a hit gives the attacker itself ("...and the pirate has Advantage on the next attack roll it makes before
   * the end of this turn").
   */
  selfRidersOnHit?: Rider[];
  kind: "attack";
  toHit: number;
  damage: DamageClause[];
  riders: Rider[];
  choiceRiders?: ChoiceRider[];
  /** Extra save-based damage that lands hit-or-miss (hybrid spells). */
  extraSave?: SaveEffect;
  magical: boolean;
  melee: boolean;
  ranged: boolean;
  /**
   * A melee spell attack made by a conjured force away from its caster (Spiritual Weapon: "one melee spell attack against
   * one creature within 5 feet of the force"). It is aimed over `range` as a ranged attack is, and is not a ranged attack
   * roll: a foe within 5 feet of the caster gives it no Disadvantage.
   */
  conjuredMelee?: true;
  /** Melee reach in feet. Defaults to 5 for melee attacks. */
  reach?: number;
  /**
   * A spell attack compiled from the creature's spellcasting. An opportunity attack is a weapon or
   * Unarmed Strike attack, so a melee spell attack (Shocking Grasp) never makes one and
   * never counts toward the creature's melee reach.
   */
  spell?: boolean;
  /** Effective attack range in feet. For ranged attacks this is the normal range. */
  range?: number;
  /** Maximum range; attacks beyond normal range have Disadvantage. */
  longRange?: number;
  /**
   * A printed Advantage on this attack's roll that holds only in a state of the fight (for example, with Advantage if
   * the target is Grappled by the attacker). One Advantage source among the others: it does not stack, and it cancels
   * against any Disadvantage.
   */
  advantageWhen?: AttackAdvantageCondition;
  requiresTargetCondition?: string;
  /** Every listed condition must already be present (a brain-extracting finisher and similar). */
  requiresTargetConditions?: string[];
  /**
   * At least one of these must already be present. A vampire's Bite wants a target that is
   * "Grappled, Incapacitated, or Restrained" — any one of the three will do, and reading that
   * list as a conjunction makes the action unusable.
   */
  requiresAnyTargetConditions?: string[];
  /** None of these conditions may already be present (one root/grapple per target). */
  requiresTargetMissingConditions?: string[];
  /**
   * The attack only works on these creature types. Save and autohit actions have always carried
   * this; attacks did not, so a brain-extracting attack — "one incapacitated Humanoid" — would
   * extract the brain of anything, including creatures that have none.
   */
  targetTypes?: string[];
  excludedTargetTypes?: string[];
  /** The sight gate: `true` sight of the target; `"point"` sight of a place. */
  requiresSight?: SightGate;
  /** Restriction in the attack's target descriptor, not merely on a rider. */
  targetMaxSize?: number;
  concentration?: boolean;
  /** Rounds a Concentration spell can last, when fewer than a duel's hundred; unset means it outlasts the fight. */
  concentrationRounds?: number;
  teleport?: TeleportSpec;
  /** Temporary hit points this action gives its own user. */
  selfTempHp?: SelfTempHp;
  /** Damage this option deals its own user each time it is used (`SelfCost`). */
  selfCost?: SelfCost;
  abilityDrain?: AbilityDrain;
  /** Dies if this action's damage reduces it to 0 hit points (`SlayOnZeroHp`). */
  slaysOnZeroHp?: SlayOnZeroHp;
  /** A hit also lowers the target's Hit Point maximum by dice of its own (`MaxHpReduction`). */
  maxHpReduction?: MaxHpReduction;
}

export interface SaveAction {
  /**
   * The spell is used again on the caster's later turns while its Concentration lasts, at no further use (Telekinesis:
   * "When you cast the spell and as a Magic action on your later turns before the spell ends").
   */
  sustained?: true;
  /** The effect lies on the ground and a creature in the air above it is not in it (the Web spell's webs, 5 feet deep). */
  targetGroundOnly?: true;
  /**
   * The user jumps into its target's space to deliver the effect, paying `cost` feet of its movement ("spends 5 feet of
   * movement to jump to a space within 15 feet that contains one or more Large or smaller creatures"); `range` is how
   * far the jump reaches.
   */
  jumpsToTarget?: { cost: number };
  /** Only a target that can see the effect is subjected to it ("each creature in the area who can see the pattern"). */
  targetMustSee?: true;
  saveAdvantageInCombat?: true;
  saveDisadvantageTypes?: string[];
  kind: "save";
  ability: Ability;
  dc: number;
  damage: DamageClause[];
  onSuccess: "half" | "none" | "full";
  riders: Rider[];
  choiceRiders?: ChoiceRider[];
  magical: boolean;
  /** Maximum distance in feet from which the effect can target the opponent. */
  range?: number;
  requiresTargetCondition?: string;
  requiresTargetConditions?: string[];
  requiresAnyTargetConditions?: string[];
  requiresTargetMissingConditions?: string[];
  /**
   * The action is the creature's own move into the target's space ("The cube moves up to its Speed ... each creature
   * whose space the cube enters ... the engulfed target moves with it"): `range` is that move, and the creature ends
   * it beside the target, where what it engulfed is carried.
   */
  entersTargetSpace?: true;
  /** Only affects these creature types (e.g. Hold Person -> humanoid). */
  targetTypes?: string[];
  excludedTargetTypes?: string[];
  /** Creatures with one of these tags succeed automatically on a save whose success does nothing: they are not targets ("demons succeed automatically"). */
  excludedTargetTags?: string[];
  targetMaxSize?: number;
  blockedByConditions?: string[];
  /** The sight gate: `true` sight of the target; `"point"` sight of a place. */
  requiresSight?: SightGate;
  concentration?: boolean;
  /** Rounds a Concentration spell can last, when fewer than a duel's hundred; unset means it outlasts the fight. */
  concentrationRounds?: number;
  /**
   * The save is an area that stays where it was put while the caster concentrates (Moonbeam's Cylinder): "A creature
   * also makes this save when the spell's area moves into its space and when it enters the spell's area or ends its
   * turn there." Resolving the action puts the area on the target; the target makes the save again at the end of its
   * turn if it is still there. The duel has no map: a target with any Speed has left by then, one with Speed 0 has not.
   * `key` names the area for the option that moves it (`ActionOption.requiresZone`).
   */
  zone?: { key: string };
  /**
   * The save belongs to an Emanation that stays around its caster while it concentrates (Spirit Guardians): "whenever the
   * Emanation enters a creature's space and whenever a creature enters the Emanation or ends its turn there, the
   * creature must make a Wisdom saving throw ... A creature makes this save only once per turn." Resolving the action
   * rolls nothing: the caster holds the Emanation, and the save is made at the end of the other creature's turn if it
   * is within `radius` then, and at the end of the caster's turn if the caster's movement brought it within `radius`.
   * `speedHalved`: "Any other creature's Speed is halved in the Emanation."
   */
  emanation?: { radius: number; speedHalved?: true };
  instantDeathHpThreshold?: number;
  /** Hit Points the user regains when this action's instant death kills ("The target dies, and the wisp regains 10 (3d6) Hit Points"). */
  selfHealOnKill?: DicePool;
  /**
   * A save-margin tier's damage: on a failure by at least `margin`, `damage` replaces the action's damage (a ray that
   * instead deals fixed necrotic damage on a bad failure). A gaze that deals its force damage only on an ordinary failed
   * save has a margin tier that deals none (`damage: []`).
   */
  marginDamage?: { margin: number; damage: DamageClause[] };
  teleport?: TeleportSpec;
  /** Temporary hit points this action gives its own user. */
  selfTempHp?: SelfTempHp;
  /** Damage this option deals its own user each time it is used (`SelfCost`). */
  selfCost?: SelfCost;
  /** A made save (per `trigger`) makes the target immune to this whole option for the rest of the duel. */
  immuneOnSuccess?: SuccessImmunity;
  abilityDrain?: AbilityDrain;
  /** Dies if this action's damage reduces it to 0 hit points (`SlayOnZeroHp`). */
  slaysOnZeroHp?: SlayOnZeroHp;
  /** A failed save lowers the target's Hit Point maximum by dice of its own (`MaxHpReduction`, `save: "action"`). */
  maxHpReduction?: MaxHpReduction;
}

export interface AutoHitAction {
  pull?: number;
  kind: "autohit";
  /**
   * The user flies straight up this fraction of its Fly Speed with the creature it has Grappled and lets it go: "If the
   * roc has a creature Grappled, the roc flies up to half its Fly Speed without provoking Opportunity Attacks and drops
   * that creature." The creature then falls, if it cannot fly.
   */
  liftAndDrop?: number;
  /** The target's Concentration ends, with no save: "Creatures in that area lose Concentration". */
  endsTargetConcentration?: true;
  damage: DamageClause[];
  /**
   * A printed melee attack that hits automatically (`{@atk mw} automatic hit`). Set only then, so an at-will one is an
   * opportunity attack like any melee attack. Its reach is `range`.
   */
  melee?: true;
  /** Automatic target effects with no attack roll or save (for example, a vow-based marking). */
  riders?: Rider[];
  magical: boolean;
  /** Maximum distance in feet from which the effect can target the opponent. */
  range?: number;
  requiresTargetCondition?: string;
  requiresTargetConditions?: string[];
  requiresAnyTargetConditions?: string[];
  requiresTargetMissingConditions?: string[];
  targetTypes?: string[];
  excludedTargetTypes?: string[];
  /** The sight gate: `true` sight of the target; `"point"` sight of a place. */
  requiresSight?: SightGate;
  targetMaxSize?: number;
  concentration?: boolean;
  /** Rounds a Concentration spell can last, when fewer than a duel's hundred; unset means it outlasts the fight. */
  concentrationRounds?: number;
  blockedByShield?: boolean;
  /** Power Word Kill style: target dies if at or below this HP, otherwise no effect. */
  instantDeathHpThreshold?: number;
  teleport?: TeleportSpec;
  /** Temporary hit points this action gives its own user. */
  selfTempHp?: SelfTempHp;
  /** Damage this option deals its own user each time it is used (`SelfCost`). */
  selfCost?: SelfCost;
}

export interface RandomAction {
  kind: "random";
  branches: CombatAction[];
}

/**
 * Self-teleportation, carried alongside whatever else the option does. Kept as a property
 * rather than a kind of its own so that an option which both damages and jumps (the Lich's
 * Deathly Teleport, the Solar's Radiant Teleport) keeps resolving its damage through the
 * normal path; `TeleportAction` covers the options whose *only* effect is the jump.
 */
export interface TeleportSpec {
  requiresSight?: true;
  /** Maximum distance in feet the creature may place itself from where it stands. */
  distance: number;
  /**
   * Where the option's own damage is anchored. Origin-anchored effects — the Lich hits "the
   * space it left" — resolve before the jump; destination-anchored ones — the Solar's
   * emanation originates "at its destination space" — resolve after it. Defaults to origin,
   * which is also correct for every option that deals no damage at all.
   */
  anchor?: "origin" | "destination";
  /**
   * The jump lands within this many feet of the opponent, wherever it starts: a teleport that ends on a free space
   * within 5 feet of a visible creature. `distance` is then no bound and is 0.
   */
  besideFoe?: number;
}

/** An option whose only effect is a self-teleport (Misty Step, the Nalfeshnee's Teleport). */
export interface TeleportAction {
  kind: "teleport";
  teleport: TeleportSpec;
  magical: boolean;
}

/** A self-targeted buff that applies a condition to the caster (e.g. Invisibility -> invisible). */
export interface SelfBuffAction {
  duration?: Rider["duration"];
  acAdjustment?: number;
  selfTempHp?: SelfTempHp;
  movement?: { mode: "charge" | "leap" | "dash"; fraction?: number; distance?: number; cost?: number; noProvoke?: boolean; requiresSight?: boolean; requiresSense?: boolean };
  kind: "selfbuff";
  condition: string;
  /** The level of the spell this buff is, which Dispel Magic reads (`ConditionState.spellLevel`). */
  spellLevel?: number;
  /** What holding the condition does to the caster's own rolls (Bless). */
  rollEffects?: RollEffect[];
  /** A duration that is not Concentration, in rounds (Mirror Image: 1 minute is 10). */
  rounds?: number;
  /**
   * Illusory duplicates (Mirror Image): each time an attack roll hits the holder, a d6 is rolled for each remaining
   * duplicate, and on any 3 or higher a duplicate is hit instead and destroyed. An attacker that is Blinded or has
   * Blindsight or Truesight is unaffected. The condition ends with the last duplicate.
   */
  images?: number;
  breaksOnAttackOrSpell?: boolean;
  /**
   * Sanctuary's ward: "any creature who targets the warded creature with an attack roll or a damaging spell must succeed
   * on a Wisdom saving throw or either choose a new target or lose the attack or spell", at this DC. Not against an area
   * (`area`). "The spell ends if the warded creature makes an attack roll, casts a spell, or deals damage."
   */
  wardDc?: number;
  /**
   * The condition is magical Darkness around the holder (the Darkmantle's Darkness Aura), not invisibility: an
   * outline (Faerie Fire) does not cancel it, and an observer whose Darkvision is "unimpeded by magical Darkness"
   * (`CombatStatblock.seesMagicalDarkness`) sees through it, as Blindsight and Truesight do in their range.
   */
  darkness?: true;
  /**
   * The Fly spell cast on the caster itself: "the target gains a Fly Speed of 60 feet and can hover. When the spell
   * ends, the target falls if it is still aloft unless it can stop the fall."
   */
  fly?: { speed: number; hover: boolean };
  /** True Seeing cast on the caster itself: "has Truesight with a range of 120 feet" while the condition lasts. */
  truesight?: number;
  concentration?: boolean;
  /** Rounds a Concentration spell can last, when fewer than a duel's hundred; unset means it outlasts the fight. */
  concentrationRounds?: number;
  /** Temporary damage resistances granted while this condition is active. */
  resistDamage?: string[];
  teleport?: TeleportSpec;
}

export interface SelfHealAction {
  kind: "selfheal";
  healing: DicePool;
  /** Distinguishes HP-restoring spells from ordinary healing for wound removal. */
  spell?: true;
  /** A pure grant of temporary hit points, which the healing field does not describe. */
  selfTempHp?: SelfTempHp;
  /** A jump the heal makes first (an undead caster's teleporting recuperation). */
  teleport?: TeleportSpec;
  /** Holders the user itself gains with the grant: Advantage on attack rolls until the start of its next turn. */
  selfRiders?: Rider[];
  /** Ends one of these conditions on the caster instead of healing (Lesser Restoration: "end one condition on it"). */
  curesConditions?: string[];
  /**
   * Dispel Magic: ends the ongoing spells of the other creature's casting on one creature within `range`. A spell of
   * level 3 or lower ends outright; a higher one on a check of d20 plus `mod` against 10 plus its level.
   */
  dispels?: { mod: number; range: number };
  /** Or ends every reduction to the caster's ability scores (Greater Restoration: "Any reduction to one of the target's ability scores"). */
  restoresAbilityScores?: boolean;
}

export type CombatAction = (AttackAction | SaveAction | AutoHitAction | RandomAction | SelfBuffAction | SelfHealAction | TeleportAction) & { actionName?: string; spell?: boolean; spellName?: string; verbal?: boolean; somatic?: boolean; components?: boolean; reflected?: true;
  /** A spell that fills an area (a Sphere, Cone, Cube, Cylinder, Line or Emanation) or reads "each creature": Sanctuary does not ward against it. */
  area?: true };

export interface ActionOption {
  requiresBloodiedDamage?: true;
  oncePerRound?: true;
  name: string;
  sourceText: string;
  sourceRef: string;
  action: CombatAction;
  uses: Uses;
  timing: Timing;
  /**
   * Usable only while the creature keeps the area of this key up (`SaveAction.zone`): "you can take a Magic action on
   * later turns to move the Cylinder up to 60 feet", which expends no spell slot.
   */
  requiresZone?: string;
  /** A persistent multi-turn feature must be activated before its child actions become at-will. */
  activation?: { group: string; min: number; noRepeat?: boolean };
  /** Action is available only after the creature's mythic/awakening HP reset triggers. */
  requiresMythic?: boolean;
  /**
   * Action is available only while the creature's start count (`CombatStatblock.startCount`) is at least this: spells
   * that each need a requisite number of brains consumed.
   */
  requiresStartCount?: number;
  /** Alternate names by which Multiattack/legendary prose can reference this option. */
  aliases?: string[];
  /** The option becomes unavailable after the indicated post-use roll succeeds. */
  depletion?: { die: number; maxRoll: number };
  /**
   * One step of a fixed sequence sharing a single pool of uses — a sphinx's Roar has a different
   * effect each time it is used. Available only while the pool still holds exactly the number of
   * uses this step expects, which orders the steps without any cross-option state.
   */
  sequence?: { pool: string; position: number; total: number };
}

export interface Routine {
  requiresCondition?: string;
  name: string;
  /**
   * `replacesAttack`: the part stands in for one of the Multiattack's attacks ("It can replace one attack with a use of
   * Slowing Breath") and is not itself an attack roll. It takes the place of an attack where attacks are limited (Slow).
   */
  parts: { optionIdx: number; count: number; perHead?: true; replacesAttack?: true }[];
  /** A mode-qualified Multiattack such as "two melee attacks" cannot be used beyond this range. */
  maxDistance?: number;
  /** Extra effect triggered when the required attacks in this routine all hit one target. */
  onAllHits?: { requiredHits: number; action: CombatAction };
}

export interface SkipLog {
  name: string;
  where: string;
  reason: string;
}

/**
 * A trait that swings the creature's own attack rolls on a trigger the duel can actually
 * observe, and may add damage to the first attack that lands while it holds.
 *
 * Written for an anger-driven trait worth roughly 60% of its creature's
 * offence: in a duel the opponent damages it nearly every round, so what reads on the page
 * as a situational bonus is close to permanent. The trigger is deliberately narrow — a trait
 * whose condition a 1v1 cannot observe (an ally count, the light level) stays unmodelled and
 * is logged as such rather than approximated.
 */
export interface Fury {
  name: string;
  /** Damage taken since the end of the creature's own last turn. */
  trigger: "tookDamage";
  /** The trait imposes Disadvantage while the trigger is *unmet*, rather than nothing. */
  disadvantageWhenInactive?: boolean;
}

export interface Regeneration {
  amount: number;
  suppressedBy: string[];
  suppressedByCritical?: boolean;
  /**
   * Troll rule: dies only if it starts its turn at 0 HP and doesn't regenerate. Also set with `deathThreshold`, whose
   * holder stays up at 0 HP the same way and has nothing in `suppressedBy`.
   */
  deathRule: boolean;
  /**
   * A regeneration of a set amount of hit points at the start of the creature's turn while its hit points are below
   * half but still positive. It only answers a creature already
   * losing, so it never props up a healthy one — and, saying nothing about dying, it leaves
   * `deathRule` false and cannot be mistaken for the troll rule.
   */
  requiresBelowHalf?: boolean;
  /**
   * A regeneration reduction: damage of a listed type since the holder's last turn start makes that one regain
   * `amount` in place of the trait's own.
   */
  reducedBy?: { types: string[]; amount: number };
  /**
   * A troll-style death rule: the creature dies only when enough acid or fire damage lands while it
   * has 0 hit points: the holder stays up at 0 HP (`deathRule` is set with it) and dies when one damage packet that finds it at 0
   * HP deals `amount` or more of the listed types in all, after its defences. `attackOnly`: only an attack roll's own hit
   * counts (the print words it as being hit by an attack); otherwise any packet does (the print words it as taking damage).
   */
  deathThreshold?: { amount: number; types: string[]; attackOnly: boolean };
}

export interface QualifiedDamageDefense {
  types: string[];
  kind: "resist" | "immune";
  nonmagicalOnly?: boolean;
}

export interface Reaction {
  acBonus: number;
  meleeOnly: boolean;
  kind?: "parry" | "shield" | "damageHalf" | "damageNegation" | "deflectMissile" | "turnStart";
  turnStart?: SaveAction;
  counterOptionIdx?: number;
  response?: AutoHitAction;
  reduction?: DicePool;
  redirect?: SaveAction;
  uses?: Uses;
  /** Healing performed after a damage-negating reaction. */
  healing?: DicePool;
  /**
   * The print makes the reaction depend on seeing the attacker: the reaction needs the creature to see the attacker (as
   * with Parry or Uncanny Dodge), or a trigger that only an attacker it can see sets off. Unset when the print says nothing.
   */
  requiresSight?: true;
}

/**
 * A reaction that answers its trigger by striking back rather than by blunting the blow the
 * way `Reaction` does. Two shapes are common: when the creature takes damage, it
 * makes one attack, or when it takes damage, the attacker must succeed on a save or take damage
 * — and both spend the one
 * reaction per round through the same slot, so a six-attack Multiattack provokes one rebuke
 * rather than six.
 *
 * Attacks are referenced rather than re-parsed, the way legendary actions reference them: the
 * option indices carry the attack's own reach, damage and riders, so a rebuke Claw cannot
 * reach an archer standing outside it, and where the prose offers a choice between attacks
 * every alternative joins and the engine picks by expected value.
 */
export interface Rebuke {
  name: string;
  /**
   * What the reaction answers. The distinctions are not cosmetic in a duel: "takes damage"
   * answers an arrow from across the field, a reaction to a hit by an attack roll within 5 feet does
   * not answer anything at range at all, and a reaction to a creature stepping within 15 feet fires once, on
   * the approach, rather than every round.
   */
  trigger: "tookDamage" | "hitByAttack" | "hitByMeleeAttack" | "enteredReach" | "foeBloodiedDamaged";
  /** Trigger fires only on damage of these types ("takes Piercing or Slashing damage"). */
  requiresDamageTypes?: string[];
  /** How far away the triggering creature may be, in feet. Undefined means any distance. */
  triggerRange?: number;
  /** The trigger names a creature the reactor can see, so an unseen attacker is safe from it. */
  requiresSight?: boolean;
  uses: Uses;
  /** Referenced attack options; whichever is worth most at the distance is the one made. */
  attacks?: { optionIdx: number; count: number }[];
  /** Used only when nothing in `attacks` can reach — a fiend's two ranged flings. */
  fallbackAttacks?: { optionIdx: number; count: number }[];
  /** The referenced attack is made with Advantage (for example, some orcish and draconic-servant creatures). */
  advantage?: boolean;
  /** A response that is not an attack: a saving-throw burst, or damage to a creature it holds. */
  action?: CombatAction;
}

/**
 * A trait that makes attack rolls against this creature roll at Disadvantage — a displacement
 * trait, a blurred-form trait, and a storm creature's winds. The mechanic is one mechanic; what the seven wordings disagree about is only
 * which attacks the penalty reaches and what switches it off, so those are the fields.
 */
export interface AttacksAgainstDisadvantage {
  name: string;
  /** One storm creature's winds bend arrows only. Every illusion trait in the corpus fools melee too. */
  rangedOnly?: boolean;
  /**
   * A cloud effect that penalizes attackers except those standing within 15 feet of the creature. An attacker
   * close enough to reach into the mist is not fooled by it, so the penalty applies strictly
   * beyond this distance instead of applying from contact outward.
   */
  minDistance?: number;
  /** Suppressed while the carrier has the Incapacitated condition. Six of the seven say so. */
  requiresConscious?: boolean;
  /** A blur that *is* the creature's movement: it ends when the creature's speed is 0. */
  requiresSpeed?: boolean;
}

/**
 * Evasion and similar avoidance traits. A saving throw that would halve damage takes the
 * damage away entirely on a success and halves it on a failure.
 *
 * Every carrier in the corpus ends with the same exception — "it can't use this trait if it has
 * the Incapacitated condition" — so the engine applies that to all of them rather than the block
 * carrying a field that is never false.
 */
export interface Evasion {
  name: string;
  /**
   * The save the trait covers: Dexterity for Evasion. Undefined for Avoidance, which applies to any effect that allows a
   * saving throw and names no ability at all.
   */
  ability?: Ability;
}

/** A passive, immediate effect when this body dies or actually drops to zero HP. */
export interface DeathBurst {
  name: string;
  trigger: "dies" | "zeroHp";
  radius: number;
  action: SaveAction | AutoHitAction;
  /** One colossal construct scatters debris only onto creatures on the ground. */
  requiresGrounded?: boolean;
}

export interface DamageGate {
  ability: Ability;
  dc: number;
  condition: string;
  duration: Rider["duration"];
  magical: boolean;
}

/**
 * A creature that hits the pudding with a melee attack takes Acid damage.
 * Passive damage dealt back to whoever lands a melee attack, with no save and no roll.
 */
export interface Retaliation {
  name: string;
  damage: DamageClause[];
  /** One fiery creature retaliates only against piercing or slashing hits. */
  requiresDamageTypes?: string[];
  /**
   * Two mechanics share this shape and only one of them answers an attacker. Fire Form and its
   * kin punish *the creature that hits them*: a creature that hits the creature with a melee
   * attack takes fire damage. A blood-spray trait answers the damage itself and sprays a
   * radius: when piercing or slashing damage hits the hydra, acid splashes on every creature within 5 feet of it —
   * which a ranged shot from five feet sets off and a reach
   * weapon from ten feet does not. A radius is what tells the two apart.
   */
  radius?: number;
}

/**
 * A passive trait that makes a creature beginning its turn within N feet save or suffer an effect. Unlike a
 * rider it belongs to the creature rather than to an action, and it is resolved from the
 * engagement distance rather than by targeting.
 *
 * The same shape serves the other side of the round. Where `onSourceTurn` is set the effect
 * fires on the *owner's* turn instead of the affected creature's (at the end of each of the
 * owner's turns, each creature in a 5-foot Emanation around it takes Fire damage) and most of that family has no saving
 * throw at all, which is why `ability` and
 * `dc` are optional. One type rather than two: everything else about the mechanic (radius,
 * damage, riders, the immunity a success buys, the creature-type gates) is identical, and the
 * two differences are exactly the two fields.
 */
export interface Aura {
  magical?: boolean;
  name: string;
  /**
   * Undefined only where the effect has no distance gate of its own: the Barbed Devil's Barbed
   * Hide reaches whatever it is grappling or is grappled by, and the hold is the gate.
   */
  radius?: number;
  /** Undefined where the effect simply lands, with no saving throw offered. */
  ability?: Ability;
  dc?: number;
  damage: DamageClause[];
  riders: Rider[];
  /**
   * A successful save can make the creature immune for 24 hours — within one fight that
   * means the aura gets a single chance per opponent. Most auras say
   * this, and ignoring it would let them re-roll every round.
   */
  immuneOnSuccess: boolean;
  /**
   * The same immunity where the print grants it beyond the aura's own save: once the creature succeeds on the saving
   * throw (`anySave`: the repeat save counts), or on a made save or the effect's end (`saveOrEnd`). The key is the
   * aura's name. The aura's own
   * save still sets the flag above.
   */
  successImmunity?: SuccessImmunity;
  /** Suppressed while the source is Incapacitated. */
  requiresConscious: boolean;
  /** Gaze-style auras need line of sight both ways. */
  requiresSight: boolean;
  targetTypes?: string[];
  excludedTargetTypes?: string[];
  /**
   * Which end of the *owner's* turn the effect resolves at, for an emanation that fires on its
   * owner's turn rather than its victim's. Absent for the ordinary start-of-victim's-turn aura.
   * The half-round distinction is the same one riders draw between `startTurnDamage` and
   * `endTurnDamage`: an end-of-turn tick lands a full opponent turn earlier than a start-of-turn
   * one does, and over a fight that is a whole extra tick.
   */
  onSourceTurn?: "start" | "end";
  /**
   * Damage types that switch the effect off for a round — the effect is off unless the troll took acid or fire damage
   * after its last turn ended, the same suppression a troll's
   * Regeneration uses, measured over the same window.
   */
  suppressedBy?: string[];
  /**
   * The effect reaches only a creature in a grapple with the owner: `grappler` for one that
   * fires only at a creature grappling the owner (a thorny trait), `either` where the prose names
   * both directions (Barbed Hide: "any creature it is grappling or any creature grappling it").
   */
  requiresGrapple?: "either" | "grappler";
  /**
   * A heal block held by place: creatures within 60 feet of the owner can't regain Hit Points. While a creature is within `radius` of the owner it can't regain hit points, at every moment and with no save; the
   * block starts and stops with distance. Not a rider: nothing is landed and nothing has a duration. The engine's one
   * reader is `healBlocked`, which every regain asks. The aura's gates (`requiresConscious`, `requiresSight`, the type
   * gates) apply; a successful save's immunity does not (no save is offered).
   */
  blocksHealing?: true;
}

/**
 * Named for the one thing that differs: the most the two creatures can be apart, in feet. Every scenario starts
 * them 30 feet apart. Ordered from least to most maneuvering room.
 */
export const SCENARIOS = ["max30", "max120", "max600"] as const;
export type Scenario = typeof SCENARIOS[number];

/** The scenarios the standard sweep (`analyze`) runs and ranks. max600 stays a scenario for single fights and `run`. */
export const SWEEP_SCENARIOS: readonly Scenario[] = ["max30", "max120"];

export const SCENARIO_MAX_DISTANCE: Record<Scenario, number> = { max30: 30, max120: 120, max600: 600 };

/** The names the scenarios had before they were named for their caps. Still accepted wherever a scenario is. */
export const SCENARIO_ALIASES: Record<string, Scenario> = { arena: "max30", arena120: "max120", open: "max600" };

/** A scenario from its name or an old alias. Throws on anything else, so a stale name never falls to a default. */
export function resolveScenario(value: string): Scenario {
  if ((SCENARIOS as readonly string[]).includes(value)) return value as Scenario;
  const aliased = Object.hasOwn(SCENARIO_ALIASES, value) ? SCENARIO_ALIASES[value] : undefined;
  if (!aliased) throw new Error(`Unknown scenario ${value}: expected ${SCENARIOS.join(", ")} (or the old ${Object.keys(SCENARIO_ALIASES).join(", ")})`);
  return aliased;
}

/**
 * One usable legendary action. `selfHeal` is Hit Points the creature regains after the referenced option resolves
 * (an entry that uses another action "and regains 5 (1d10) Hit Points").
 */
/**
 * Movement a Legendary entry prints with the action it uses. `feet` is the printed grant at full Speed (half the
 * printed Speed, or half the Fly Speed); the engine scales it by the Speed the creature has left. `before`: it moves,
 * then makes the attack. `after`: it uses the action, then may move.
 */
export interface LegendaryEntryMove { when: "before" | "after"; feet: number; noProvoke: boolean }
export interface LegendaryEntry { optionIdx: number; count: number; requiresMythic?: boolean; refreshesUse?: boolean; selfHeal?: DicePool; move?: LegendaryEntryMove }

export interface CombatStatblock {
  greaterMagicResistance?: true;
  reflectiveCarapace?: true;
  aversionToFire?: true;
  /**
   * A Speed lost to damage of a type (Water Elemental's Freeze: "If the elemental takes Cold damage, its Speed decreases
   * by 20 feet until the end of its next turn").
   */
  speedLossOnDamage?: { types: string[]; feet: number };
  pursuit?: { distance: number; range: number; beside: number };
  counterspell?: { option: ActionOption; dc: number };
  draconicOrigin?: DraconicOrigin;
  id: string;
  source: string;
  name: string;
  cr: number;
  ac: number;
  hpAvg: number;
  abilityMods: Record<Ability, number>;
  /** The printed ability scores. Optional only for constructed test blocks; the compile always emits it. */
  abilityScores?: Record<Ability, number>;
  saves: Partial<Record<Ability, number>>;
  skills: { athletics?: number; acrobatics?: number; medicine?: number };
  initiativeBonus: number;
  immune: string[];
  resist: string[];
  vulnerable: string[];
  qualifiedDefenses: QualifiedDamageDefense[];
  conditionImmune: string[];
  /** Best terrestrial chase/escape speed in feet (walk, fly, or burrow; not swim). */
  speed: number;
  /**
   * Fly speed in feet, if the creature can fly at all. This is a capability flag, not a
   * movement budget: it gates whether the creature may leave the ground. The budget for
   * both axes still comes from `speed`, which already maxes fly in.
   */
  flySpeed?: number;
  /** Doesn't fall when its Speed drops to 0 or it is knocked Prone (the flying-movement rule). */
  canHover?: boolean;
  /** May occupy another creature's space and vice versa: a swarm, or a mist that says so. */
  sharesSpace?: boolean;
  /**
   * "It can enter a creature's space and stop there. The first time it enters a creature's space on a turn, that
   * creature takes 5 (1d10) Fire damage" (Fire Form): damage with no attack roll and no save, once on each of the
   * owner's turns, for the movement it takes to step into the foe's space.
   */
  spaceEntry?: { name: string; damage: DamageClause[] };
  /**
   * "The ground in a 10-foot Emanation originating from the mouther is Difficult Terrain" (Aberrant Ground): the radius
   * in feet. It moves with its owner, so it is the owner's property and not the arena's. Every foot its foe walks on
   * that ground costs 1 extra foot; a foe that can fly does not walk on it, and the owner's printed Speed stands.
   */
  difficultGround?: { name: string; radius: number };
  size: number;
  creatureType: string;
  creatureTags: string[];
  /** Legacy capability flag; compiled creatures also supply truesightRange. */
  truesight: boolean;
  /** Exceptional sight ranges in feet; absent means the sense is not available. */
  truesightRange?: number;
  blindsight?: number;
  /** Maximum physical sight range for creatures explicitly blind beyond their sense radius. */
  blindBeyond?: number;
  /** "Tremorsense 60 ft.": creatures in contact with the same surface, for an effect that needs a creature it "can sense". */
  tremorsense?: number;
  /** "Darkvision 120 ft. (unimpeded by magical Darkness)". */
  seesMagicalDarkness?: true;
  /** Doesn't provoke opportunity attacks when moving out of reach. */
  flyby: boolean;
  /**
   * Moving a creature it grapples costs no extra movement: "The bugbear needn't spend extra movement to move a
   * creature it is grappling." Without it the Grappled condition's rule applies (every foot costs 1 extra foot unless
   * the victim is Tiny or two or more sizes smaller).
   */
  freeCarry?: true;
  reaction?: Reaction;
  /** Damage- or approach-triggered reaction that strikes back (a rampage trait, a cold rebuke). */
  rebuke?: Rebuke;
  deathBurst?: DeathBurst;
  /** Save required before an opponent can attempt to damage this creature (Nilbogism). */
  damageGate?: DamageGate;
  /** Passive start-of-turn proximity effect (Stench, Fear Aura, an annihilating aura). */
  aura?: Aura;
  /**
   * Passive proximity effect that fires on the creature's *own* turn instead (Fire Aura, Heat
   * Aura, a degeneration aura, Barbed Hide). A separate slot rather than a second meaning for
   * `aura` because a creature may carry one of each — and because the two resolve at different
   * moments, against different creatures' turns.
   */
  sourceTurnAura?: Aura;
  /** Passive damage dealt back to a melee attacker (Corrosive Form, Fire Form). */
  retaliation?: Retaliation;
  undeadFortitude: boolean;
  magicResistance: boolean;
  /**
   * Printed conditions this creature saves against with Advantage, from a trait such as Fey Ancestry
   * (Advantage on saves against being charmed). A save gets it when its failure would apply,
   * or its success end, one of these (`saveAdvantage`, `src/engine/pairContext.ts`). Absent: none.
   */
  conditionSaveAdvantage?: string[];
  /** Advantage on every saving throw while the creature is Bloodied (Bloodied Frenzy). Absent: none printed. */
  bloodiedSaveAdvantage?: true;
  /**
   * Advantage on every saving throw while the creature is not Incapacitated: the saving-throw half of an aura the
   * creature itself stands in (the Hobgoblin Captain's Aura of Authority). Rolled, not priced by the foe's chooser.
   */
  saveAdvantageUnlessIncapacitated?: true;
  /** "The stalker has the Invisible condition": the creature starts each fight Invisible and attacking does not end it. */
  innateInvisible?: true;
  /** "The marilith can take one Reaction on every turn of combat": its Reaction returns at the start of every turn. */
  reactionEveryTurn?: true;
  /**
   * A Reaction that adds a fixed number to the creature's own ability check or saving throw after the roll: "Trigger: The
   * sphinx or another creature within 30 feet makes an ability check or a saving throw. Response: The sphinx adds 2 to
   * the roll." Taken when the number turns a failure into a success; `perDay` uses a fight.
   */
  rollBoost?: { name: string; bonus: number; perDay: number };
  /**
   * A sleep immunity: the Sleep spell's elf/Exhaustion auto-success gate applies to it, and no
   * `magicalSleep` rider lands on it.
   */
  sleepImmune?: boolean;
  legendaryResistances: number;
  /**
   * A count rolled once when the fight starts and fixed for it (a roll that determines the number of brains the creature
   * has already consumed). Read by `requiresStartCount`. Absent: none printed.
   */
  startCount?: { name: string; dice: DicePool };
  /** Usable legendary actions; optionIdx may reference an action-timing option ("makes one Rend attack"). */
  legendaryOptions: LegendaryEntry[];
  /**
   * A printed Legendary "Move" (a move of up to its speed that provokes no opportunity attacks). It competes with
   * `legendaryOptions` in `legendaryStep`, valued by the movement square score. Absent: none printed.
   */
  legendaryMove?: { name: string; halfSpeed: boolean; noProvoke: boolean };
  /**
   * Damage absorption (a golem subjected to Fire damage takes none and is healed by the amount of damage). A damage
   * type listed here heals `fraction` of the rolled
   * damage instead of hurting (`damageMultiplier` returns -fraction). Absent: none printed.
   */
  absorption?: { name: string; types: string[]; fraction: number };
  /** One-time 0-HP reset supplied by a mythic/awakening trait. */
  mythicResetHp?: number;
  /**
   * The reset is printed as a replacement: when the creature would drop to 0 hit points, its hit points are set to a
   * fixed number instead. The holder is never reduced to 0, so a slay-on-zero packet
   * (`slaysOnZeroHp`) does not slay a holder whose reset is unspent; the reset answers it as it answers any packet.
   * Wordings where the creature, on being reduced to 0 hit points, doesn't die or fall unconscious and instead regains
   * a set number, or simply regains a set number, carry it too: the print resolves before
   * the slay. Every holder of `mythicResetHp` carries it; its one reader is the slay site in `applyDamage`.
   */
  mythicResetReplaces?: true;
  /**
   * What the reset does NOT restore. Without the field the reset refills the
   * Legendary Resistance pool and readies every recharge, as the prints say (its Breath Weapon recharges and spent
   * Legendary Resistance uses return). `legendaryResistance`: the print does not restore the pool,
   * and the block has one. `recharge`: the names of the block's recharge
   * options the print does not recharge. Spent per-day uses are never restored, with or without the field. Absent: the
   * print restores both, or the block has neither.
   */
  mythicResetKeeps?: { legendaryResistance?: true; recharge?: string[] };
  /**
   * The reset is printed as a regain of Hit Points, so a heal block stops it: a holder reduced to 0 hit points while it
   * can't regain Hit Points spends the trait,
   * regains nothing and is down. Absent on a reset printed as the current hit point total
   * resetting to a number (not a regain).
   */
  mythicResetRegains?: true;
  /** SRD Multiple Heads and Reactive Heads; attack repetitions refer to the live count. */
  heads?: { initial: number; threshold: number; regrow: number; healing: number; reactive: boolean };
  regeneration?: Regeneration;
  /** Full replacement stat block that appears when this form reaches 0 HP. */
  successor?: CombatStatblock;
  /** Trait imposing Disadvantage on attack rolls made *against* this creature. */
  attacksAgainstDisadvantage?: AttacksAgainstDisadvantage;
  /** Evasion / Avoidance: a save-for-half becomes none-on-success, half-on-failure. */
  evasion?: Evasion;
  /**
   * Permanent Advantage on every attack roll this creature makes, granted by a trait rather
   * than by the target's condition (Lucifer's Apotheosis). Still cancels against Disadvantage
   * the normal way. No published creature in the corpus sets this.
   */
  attackAdvantage?: boolean;
  /**
   * The mirror image, and unlike its counterpart the corpus does contain one: a trait whose
   * *favourable* branch needs a crowd the duel never supplies, leaving only the penalty. A
   * creature with Advantage while at least two other creatures are within 30 feet, and Disadvantage
   * on attack rolls otherwise, has in a 1v1 never more than one
   * other creature, so the second clause governs every attack it makes.
   */
  attackDisadvantage?: boolean;
  /**
   * A trait's conditional Advantage on every attack roll this creature makes (for example, against a creature missing
   * Hit Points). The per-option form is `advantageWhen` on the attack.
   */
  attackAdvantageWhen?: AttackAdvantageTrait;
  fury?: Fury;
  options: ActionOption[];
  routines: Routine[];
  skipped: SkipLog[];
}

export interface PairResult {
  a: string;
  b: string;
  iters: number;
  winsA: number;
  winsB: number;
  draws: number;
  avgRounds: number;
  avgWinnerHpPct: number;
  /**
   * Mean remaining hit-point fraction for each side across *drawn* iterations. A 100-round
   * stalemate is rarely even: a regenerator typically ends near 0 while its opponent is
   * barely scratched, so scoring every draw as half a win flattered it enormously.
   */
  drawHpA: number;
  drawHpB: number;
}
