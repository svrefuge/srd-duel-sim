import { avgDice, rollDice } from "../dice.ts";
import { d20, hashSeed, mulberry32 } from "../rng.ts";
import { proficiencyFromCr } from "../tables.ts";
import { seesInvisible, seesTarget, sightRange } from "./senses.ts";
import type { LegendaryEntry, LegendaryEntryMove, Ability, ActionOption, AttackAction, BreakableObject, AttackAdvantageCondition, Aura, AutoHitAction, CombatAction, CombatStatblock, DamageClause, MaxHpReductionSave, PairResult, Rebuke, Regeneration, Rider, RollEffect, Routine, SaveAction, SaveEffect, SelfCost, SelfTempHp, Scenario, SuccessImmunity, TeleportSpec, Timing } from "../types.ts";
import { SCENARIO_MAX_DISTANCE, resolveScenario } from "../types.ts";
import {
  ADVANTAGE_EV,
  CONDITION_HORIZON_TURNS,
  DEFENCES_ACTIVE,
  DISADVANTAGE_EV,
  actionEv,
  spellBlocked,
  actionEvOnSave,
  actionRiderEv,
  attackDisadvantageFactor,
  distanceEvFactor,
  repeatFactor,
  repeatFactorFrom,
  riderLandChance,
  ONE_ROLL_SHARE,
  evasionShares,
  hitChance,
  saveFailChance,
  saveFailByChance,
  saveMarginTierEvs,
  saveAdvantage,
  actionSaveMode,
  actionSaveConditions,
  riderSaveConditions,
  actionEvAtDistance as rawActionEvAtDistance,
  actionInRange,
  actionRange,
  actionRangeLandmarks,
  bestRoutineEvAtDistance as rawBestRoutineEvAtDistance,
  routineEvAtDistance as rawRoutineEvAtDistance,
  damageClauseMultiplier,
  damageClauseType,
  standingDefence,
  sleepBlocked,
  immunityGated,
  magicalSleepOnly,
  canRegainHp,
} from "./pairContext.ts";
import type { DefenceState } from "./pairContext.ts";

/** An object a hold hangs on, as it stands in this fight: the printed object and the Hit Points it has left. */
interface LiveObject {
  spec: BreakableObject;
  hp: number;
}

interface ConditionState {
  /** Held for having 0 Hit Points and not being dead (`settleZeroHp`); ends when the holder regains any. */
  zeroHp?: true;
  /** The level of the spell this copy is (`Rider.spellLevel`, `SelfBuffAction.spellLevel`): what Dispel Magic ends. */
  spellLevel?: number;
  /** The object this hold hangs on (`Rider.breakable`); the hold ends when it has no Hit Points left. */
  breakable?: LiveObject;
  /** Mirror Image duplicates left on this copy (`SelfBuffAction.images`). */
  images?: number;
  /** The source possesses its holder (`Rider.possession`). */
  possession?: true;
  /** The hold ends when its source uses the action that applied it again (`Rider.endsOnReuse`). */
  endsOnReuse?: true;
  concentrationDisadvantage?: true;
  noProvoke?: boolean;
  push?: number;
  pushUpTo?: true;
  pull?: number;
  pullUpTo?: true;
  /** Feet still to be lifted (`Rider.lift`), cleared once the lift is made. */
  lift?: number;
  /** Held in the air by its source: it does not fall while this lasts (`settleFlight`). */
  suspended?: true;
  /** On the caster: the spell it may use again at no further use while it concentrates (`SaveAction.sustained`). */
  sustainsSpell?: string;
  reappearWithin?: number;
  acAdjustment?: number;
  oneAttack?: true;
  slowCasting?: true;
  name: string;
  /** The particular condition copy whose end also ends this one. */
  linkedParent?: ConditionState;
  duration: Rider["duration"];
  save?: Rider["save"];
  escapeDc?: number;
  escapeAbilities?: Ability[];
  /** The hold's print gives Disadvantage on the check to escape it (`Rider.escapeDisadvantage`). */
  escapeDisadvantage?: boolean;
  sourceDetachMovement?: number;
  /** The holder of this hold halves the damage it takes and its victim takes the same amount (`Rider.sharesHolderDamage`). */
  sharesHolderDamage?: true;
  endsOnDamage?: boolean;
  endsOnSourceDamage?: true;
  sourceDamageException?: string;
  willingFor?: string;
  saveOnDamage?: boolean;
  saveOnDamageTypes?: string[];
  saveOnDamageAdvantage?: true;
  /** Sanctuary's ward on the holder (`SelfBuffAction.wardDc`). */
  wardDc?: number;
  /** This Invisible copy is magical Darkness around the holder (`SelfBuffAction.darkness`). */
  darkness?: true;
  /** A Fly Speed the holder has while the condition lasts, and whether it can hover (`SelfBuffAction.fly`). */
  flySpeed?: number;
  hover?: boolean;
  /** A Truesight range the holder has while the condition lasts (`SelfBuffAction.truesight`). */
  truesightRange?: number;
  transitionOnFailedSave?: string;
  transitionEndsOnDamage?: boolean;
  /** The condition it becomes keeps this save, repeated at the end of each of the holder's turns. */
  transitionSaveEndsEachTurn?: true;
  /** `Rider.transitionRounds`, carried to the failure that escalates. */
  transitionRounds?: number;
  /** The holder's own `turnCount` at whose end this copy lapses (an escalated condition's "for 1 minute"). */
  endsOwnTurn?: number;
  /**
   * A follow-on still pending (`Rider.delayedCondition`): it lands at the start of the source's next turn if this copy is
   * still on the target, and is cleared there either way.
   */
  delayedCondition?: string;
  /** Successful repeat saves needed to shake this off; one when absent. */
  savesToEnd?: number;
  /** How many have been made so far. */
  savesMade?: number;
  speedZero?: boolean;
  speedNotReduced?: boolean;
  /** A partial Speed cut in feet while this copy holds (`Rider.speedCut`). */
  speedCut?: number;
  /** The holder's Speed is halved while this copy holds (`Rider.speedHalved`). */
  noReactions?: true;
  noBonusActions?: true;
  moveOrAct?: true;
  noVerbalSpells?: true;
  actionOrBonus?: true;
  delayedDamage?: Rider["delayedDamage"];
  delayedDueTurn?: number;
  speedHalved?: true;
  approachOnly?: boolean;
  escapeAttemptDamage?: DamageClause[];
  /**
   * How far the body or tether that made this hold extends, in feet — the reach of a melee
   * grapple, the normal range of a harpoon. Set only on holds anchored to a grappler: a web's
   * Restrained is a place, not a grip, and follows nobody around. Undefined means no geometry.
   */
  holdReach?: number;
  concentrationSource?: 0 | 1;
  breaksOnAttackOrSpell?: boolean;
  endsOnHealingSpell?: true;
  stanchDc?: number;
  startTurnDamage?: DamageClause[];
  endTurnDamage?: DamageClause[];
  sourceDamageEscapeThreshold?: number;
  sourceDamageEscapeSaveDc?: number;
  /** This creature crossed its swallow's damage threshold during its current turn. */
  sourceDamageEscapePending?: boolean;
  resistDamage?: string[];
  magical?: boolean;
  /**
   * Turn counter on which the condition was applied, for "next turn" timing. It is the target's
   * counter, except for `endOfSourceNextTurn`, where it is the source's: the condition ends at the end
   * of the source's first turn whose count is higher, which is the source's next turn whether the
   * condition landed on the source's own turn or off it (a reaction, a legendary or lair action).
   */
  appliedTurn: number;
  /**
   * A timed copy's end (`Rider.rounds`): the source's `turnCount` at whose start it is removed, the source's count when it
   * landed plus the rounds.
   */
  endsSourceTurn?: number;
  source: 0 | 1;
  /** The printed success immunity of the effect that applied this condition (`SuccessImmunity`). */
  immunity?: SuccessImmunity;
  /** What holding this copy does to rolls (`Rider.rollEffects`). */
  rollEffects?: RollEffect[];
  /** While this copy holds, its holder can't regain hit points (`Rider.blocksHealing`). */
  blocksHealing?: true;
  /** While this `prone` copy holds, its holder can't stand (`Rider.cannotStand`). */
  cannotStand?: true;
  /** While this `grappled` copy holds, its holder can't teleport (`Rider.blocksTeleport`). */
  blocksTeleport?: true;
  /**
   * What of its source keeps this copy on, for a condition that lasts until escape (`applyRiders`): a grapple of the
   * creature's own (the Grappled itself and whatever its rider set hangs on it, "until the grapple ends"), or an
   * attachment. Unlike `holdReach` it needs no reach: a grapple thrown by an action with no range is still a grapple.
   * Absent on a place-held hold (a web's Restrained), on a detached grip (`Rider.detachedHold`) and on a swallow.
   */
  heldBy?: "grapple" | "attachment";
  /** The source controls this Charmed creature while the pair are within this many feet (`Rider.controlRange`). */
  controlRange?: number;
  /** This Charmed creature spends its movement walking to the source (`Rider.drawnToSource`). */
  drawnToSource?: true;
  /** On the caster: it keeps the area of this key up (`SaveAction.zone`), which is what its Concentration maintains. */
  zoneKey?: string;
  /** On the target: the area stands on it, and this is the save it makes again if it ends its turn there. */
  zoneSave?: CombatAction;
  /**
   * On the caster: the Emanation it keeps around itself (`SaveAction.emanation`) and the save the other creature makes
   * in it. `inside` is whether the other creature stood in it when the caster's turn last began, or when it appeared.
   */
  emanation?: { radius: number; name: string; save: CombatAction; inside: boolean; speedHalved?: true };
  /** Ends with the turn it landed in (`Rider.endsThisTurn`). */
  endsThisTurn?: true;
}

/**
 * The creature is under its foe's control (`Rider.controlRange`): it holds a copy that says so and stands within the
 * printed distance. Read from where the fighters are now (`bindPlace`); a state outside a fight is not controlled.
 */
function controlled(state: FighterState): boolean {
  const distance = state.place?.engagement.distance;
  return distance !== undefined && state.conditions.some((c) => c.controlRange !== undefined && distance <= c.controlRange);
}

/**
 * The creature holds a heal block (`Rider.blocksHealing`): the print says the creature can't regain hit points while poisoned this way.
 * `atTurnStart` is asked by the creature's own start of turn, where a block "until the start of its next turn" ends at the
 * same moment the turn's regeneration happens: the creature orders its own simultaneous start-of-turn effects, so the
 * lapsing block no longer holds there. `takeTurn` removes it right after `startTurn`.
 */
function healBlocked(state: FighterState, atTurnStart = false, distance?: number): boolean {
  return state.conditions.some((c) => c.blocksHealing
    && !(atTurnStart && c.duration === "startOfTargetNextTurn" && state.turnCount > c.appliedTurn))
    || heldHealBlock(state, distance);
}

/**
 * Where a fighter stands: the fight's blocks, states and engagement, and which side it is. Bound once per fight
 * (`bindPlace`), so that a state can be asked about an effect held by place without every caller carrying the distance.
 * A state built outside a fight has none. A successor form keeps it: `transformIntoSuccessor` assigns a fresh state's
 * fields over the old one, and a fresh state (`initState`) has no `place` to assign.
 */
interface FightPlace {
  blocks: [CombatStatblock, CombatStatblock];
  states: [FighterState, FighterState];
  engagement: EngagementState;
  self: 0 | 1;
  /** The fight's log, for an effect resolved inside a roll (`rollBoosted`). */
  log?: FightLog;
}

function bindPlace(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], engagement: EngagementState): void {
  for (const self of [0, 1] as const) states[self].place = { blocks, states, engagement, self };
}

/**
 * A heal block held by place (`Aura.blocksHealing`, creatures within 60 feet of the source can't regain Hit Points):
 * the creature stands within the foe's heal-blocking aura. Read from where the fighters are now, or from `distance` when
 * the caller is pricing a square it has not moved to yet, so the block starts and stops with distance and holds at every
 * moment inside, the start of the creature's turn included. The aura's gates apply; no save is offered, so no success
 * immunity does.
 */
function heldHealBlock(state: FighterState, distance?: number): boolean {
  const place = state.place;
  if (!place) return false;
  const source: 0 | 1 = place.self === 0 ? 1 : 0;
  const aura = place.blocks[source].aura;
  if (!aura?.blocksHealing || aura.radius === undefined) return false;
  const at = distance ?? place.engagement.distance;
  return at <= aura.radius && auraGatesOpen(aura, place.blocks[source], place.states[source], place.blocks[place.self], state, at);
}

function pruneLinkedConditions(state: FighterState, log?: FightLog, name?: string): void {
  let prior: number;
  do {
    prior = state.conditions.length;
    const present = new Set(state.conditions);
    const ended = state.conditions.filter((condition) => condition.linkedParent && !present.has(condition.linkedParent));
    state.conditions = state.conditions.filter((condition) => !ended.includes(condition));
    if (ended.length && log?.on && name) log.push(`${name} is no longer ${[...new Set(ended.map((condition) => condition.name))].join(" or ")}`);
  } while (state.conditions.length !== prior);
}

/**
 * What a held condition's repeat save stands against: success ends it and every condition linked to
 * it, failure turns it into its `transitionOnFailedSave`. The engine-side twin of
 * `riderRepeatConditions`, read from the conditions actually held.
 */
function repeatSaveConditions(condition: ConditionState, state: FighterState): (string | undefined)[] {
  return [condition, ...state.conditions.filter((candidate) => candidate.linkedParent === condition)]
    .flatMap((held) => [held.name, held.transitionOnFailedSave]);
}

function linkedWorthResisting(condition: ConditionState, state: FighterState): boolean {
  return [condition, ...state.conditions.filter((candidate) => candidate.linkedParent === condition)].some((candidate) =>
    INCAPACITATING.has(candidate.name) || (!!candidate.transitionOnFailedSave && INCAPACITATING.has(candidate.transitionOnFailedSave))
    || !!candidate.startTurnDamage?.length || !!candidate.endTurnDamage?.length);
}

interface FighterState {
  /** This creature possesses its foe (`Rider.possession`): it is inside the body, and moves only as the body does. */
  possessing?: boolean;
  /** This creature's own breakable items (`BreakableObject.item`), by their compiled object: one record a fight. */
  items?: Map<BreakableObject, LiveObject>;
  movementBeforeFoeTeleport?: { ground: number; height: number };
  bloodiedDamage?: boolean;
  usedThisRound?: Set<number>;
  routineAttacks?: number;
  /** While a routine part resolves: the reach or range of the nearest-reaching attack the routine still has to make (`choosePush`). */
  routineStillReaches?: number;
  /** Where this fighter stands in its fight (`FightPlace`); absent outside a fight. */
  place?: FightPlace;
  hp: number;
  maxHp: number;
  /** Temporary hit points: a separate pool damage spends first. Never healing, and never lifts a creature off 0. */
  tempHp: number;
  /** Set for a grant that states an end ("until the start of its next turn"); cleared when that turn starts. */
  tempHpExpiresTurn?: number;
  /** `castsLeft` and `castTurn`: casts a spent use still allows this turn (`Uses.casts`). */
  recharge: Map<string | number, { ready: boolean; min: number; castsLeft?: number; castTurn?: number }>;
  perDay: Map<string | number, number>;
  reactionRemaining?: number;
  /** Uses left of the block's `rollBoost` Reaction. */
  rollBoostLeft?: number;
  legendaryResistances: number;
  conditions: ConditionState[];
  lastDamageTypes: Set<string>;
  tookCritical: boolean;
  reactionUsed: boolean;
  heads?: number;
  headsLost: number;
  headTurnDamage: number;
  headLostThisTurn: boolean;
  headFire: boolean;
  extraOpportunityUsed: number;
  pendingDeflect?: boolean;
  pendingReactionResponse?: boolean;
  actionSlotUsed?: boolean;
  /** Took the Dodge action on its last turn: until the start of its next turn (`dodges` reads it). */
  dodging?: boolean;
  bonusSlotUsed?: boolean;
  shieldActive: boolean;
  regenFailed: boolean;
  /** Killed outright by a "the target dies" effect, which never routes through 0 HP. */
  slain: boolean;
  /** Petrification ends the duel without killing the creature. */
  petrifiedDefeat?: boolean;
  deathBurstUsed?: boolean;
  zeroHpBurstPending?: boolean;
  concentrating: boolean;
  /** The caster's own turn count at which its running Concentration spell's duration is up. */
  concentrationEndsTurn?: number;
  /**
   * Altitude above the ground in feet. A per-creature property like hp or conditions, unlike
   * the relational ground separation on `EngagementState` — which is what lets damage clauses
   * gated on being airborne read it without threading the engagement everywhere. Only a
   * creature with a fly speed is ever above 0.
   */
  height: number;
  movementPenalty: number;
  /** In the air on a printed Leap, until the fall that ends it (`leapUpPlan`): `settleFlight` leaves it there meanwhile. */
  leaping?: boolean;
  /** This fighter's own movement on its last turn left it farther from its foe than the turn found it. */
  withdrew: boolean;
  /**
   * The creature began this turn's movement Prone and unable to stand, and crawls: `currentSpeed` is half its Speed
   * while that holds (`standIfProne`). Cleared by `startTurn`.
   */
  crawling?: boolean;
  /** This turn the creature takes its action and so cannot move (`moveOrAct`): it has no movement to spend until the turn ends (`movementSpeed`). */
  actsInsteadOfMoving?: boolean;
  /**
   * The source of the Unconscious copy the creature held at the last settle point (`settleWake`); undefined when it held
   * none. "When this condition ends, you remain Prone" (SRD 5.2.1, Unconscious).
   */
  unconsciousFrom?: 0 | 1;
  movedToward: number;
  /** Feet the creature's own move has covered this turn, and whether its turn is under way (the rise after Fly). */
  turnMoved: number;
  ownTurn: boolean;
  /**
   * The `movedToward` this fighter's last attack of the turn found. A run-up printed as needing to come immediately before the hit
   * (`requiresMovementImmediate`) counts only the feet moved since: the first attack after the approach carries it, hit
   * or miss, and no later one does. Zeroed with `movedToward`. A gate without the
   * flag does not read it.
   */
  runUpSpent: number;
  /** An attack of this fighter's is resolving, past its gates: `resolveAction` spends the run-up once it is done. */
  attackResolving: boolean;
  turnCount: number;
  mythicActive: boolean;
  /** The block's `startCount`, rolled when the fight starts (`rollStartCount`); undefined if it prints none. */
  startCount?: number;
  activations: Map<string, { active: boolean; ready: boolean; min: number; lastOption?: number; lastTurn?: number }>;
  depleted: Set<number>;
  justTransformed: boolean;
  /**
   * How many times this fighter has changed into a successor form. A turn compares it with the count it began on: the old
   * form's routine and move end at the change and the new form first acts on its next turn.
   */
  formChanges: number;
  lastActionHit: boolean;
  damageDealtThisTurn: number;
  /**
   * Whether anything has damaged this creature since the end of its own last turn — the
   * trigger for a `fury` trait. Cleared at the end of its turn rather than the start, because
   * "until the end of its next turn" also covers damage it takes *during* that turn, from a
   * retaliation or an opportunity attack.
   */
  tookDamageSinceTurnEnd: boolean;
  /**
   * Which damage types have reached this creature since the end of its own last turn — the same
   * window as `tookDamageSinceTurnEnd` and cleared with it. `lastDamageTypes` cannot answer this:
   * it is cleared at the *start* of the turn, for the regeneration check that reads it there, so
   * by the end of the turn it no longer remembers the opponent's round. A trait that switches off
   * unless the creature has taken certain damage types since its own previous turn
   * ended fires at the end of the creature's own turn, which is exactly the gap.
   */
  damageTypesSinceTurnEnd: Set<string>;
  /** A `oncePerTurn` damage clause has already been paid out this turn. */
  bonusDamageUsed: boolean;
  /**
   * The once-per-turn effects this creature has attempted in the current turn, by `oncePerTurnKey` (a rider, an
   * `extraSave` burst or a damage clause). Cleared for both creatures at the start of every turn, either creature's.
   */
  perTurnUsed: Set<string>;
  /**
   * Rebuke triggers that fired while the action now resolving was resolving. Recorded rather
   * than acted on immediately so the reaction lands *after* its trigger has finished — an
   * attack's damage, its riders and any retaliation it drew all resolve first — and cleared by
   * `settleRebukes`, which is the only reader.
   */
  rebukeTriggers?: { damaged: boolean; hitByAttack: boolean; hitByMelee: boolean; damageTypes: string[] };
  /** Qualifying damage packets this creature has taken that its acid-spray trait has yet to answer. */
  bloodSprayPending?: number;
  /** Set when the creature forces its way out of its swallower; `settleSwallowGeometry` puts it beside it. */
  swallowExitPending?: boolean;
  /** Saved once against the foe's aura, where a success grants lasting immunity. */
  auraImmune: boolean;
  /**
   * Keys of the foe's effects this creature is immune to for the rest of the duel, under a printed success immunity
   * (immune to the source's named effect for 24 hours; `SuccessImmunity`). The foe is the only source, so the key alone
   * identifies the effect, and in a mirror match each side holds its own set against the other's copy.
   */
  immuneTo: Set<string>;
  /**
   * Keys of the foe's `saveOrEnd` and `end` effects that have landed on this creature. Once none of the conditions
   * such an effect applied remains, the effect has ended for it, however it ended (`successImmune`).
   */
  effectsHeld: Set<string>;
  /**
   * This creature has expended a spell slot on the current turn ("One Spell with a Spell Slot per Turn": on a turn, a
   * creature can expend only one spell slot to cast a spell). Set by `spend`, read by `usable`, and cleared for both
   * creatures at the start of every turn, since the rule binds on any turn, not only the caster's own.
   */
  spellSlotSpent: boolean;
  /**
   * Current scores of the abilities an `abilityDrain` has lowered; an ability absent here is at its printed score. Only
   * the death at 0 reads it: save and check modifiers stay the block's static ones.
   */
  drainedScores: Partial<Record<Ability, number>>;
}

/** A compiled spell-slot pool (`spell-slots:<level>`, one per level, `src/parse/spells.ts`). */
const SPELL_SLOT_POOL = "spell-slots:";

/** Does using this option expend a spell slot? */
function expendsSpellSlot(option: ActionOption): boolean {
  return option.uses.t === "perDay" && option.uses.pool?.startsWith(SPELL_SLOT_POOL) === true;
}

/**
 * Is `state` immune to the foe's effect? Either a made save granted it (`immuneTo`), or an effect whose end grants
 * it has landed and nothing it applied is left. Read at the moment of use, so every way a condition can end (a
 * repeat save, expiry, damage, the source's concentration) counts without a hook at each.
 */
function successImmune(state: Pick<FighterState, "immuneTo" | "effectsHeld" | "conditions">, immunity: SuccessImmunity | undefined): boolean {
  if (!immunity) return false;
  if (state.immuneTo.has(immunity.key)) return true;
  return state.effectsHeld.has(immunity.key) && !state.conditions.some((condition) => condition.immunity?.key === immunity.key);
}

/**
 * A save against an effect with a printed success immunity succeeded: `initial` for the save the effect called for
 * (a Legendary Resistance's success included), or a repeat save that ended or counted against it.
 */
function grantSuccessImmunity(state: FighterState, immunity: SuccessImmunity | undefined, save: "initial" | "repeat", log: FightLog, block: CombatStatblock): void {
  if (!immunity || state.immuneTo.has(immunity.key)) return;
  if (save === "initial" ? immunity.trigger === "end" : immunity.trigger !== "anySave") return;
  state.immuneTo.add(immunity.key);
  if (log.on) log.push(`${block.name} is immune to ${immunity.key}`);
}

/**
 * Write down, at the end of a turn, an effect that has ended since (`successImmune` already reads it as immune, so
 * this changes no answer: it moves the key into `immuneTo` and says so in the trace).
 */
function noteEndedEffects(state: FighterState, log: FightLog, block: CombatStatblock): void {
  for (const key of state.effectsHeld) {
    if (state.immuneTo.has(key) || state.conditions.some((condition) => condition.immunity?.key === key)) continue;
    state.immuneTo.add(key);
    if (log.on) log.push(`${block.name} is immune to ${key} (the effect has ended)`);
  }
}

interface EngagementState {
  /**
   * Chebyshev separation between the fighters, derived from `ground` and `height`. Every
   * consumer in the engine reads position through this one scalar, which is why adding the
   * vertical axis leaves range checks, auras and opportunity attacks untouched.
   * Movement and falling keep it synchronized with those underlying coordinates.
   */
  distance: number;
  /** Horizontal edge-to-edge separation. Altitude lives on each fighter's `FighterState`. */
  ground: number;
  maxDistance: number;
  /**
   * Altitude cap: the scenario's `maxDistance` again, as much sky as there is ground. It caps how far apart the pair
   * may be, as on the ground, so it is measured above the other creature's body (`skyRoof`).
   */
  ceiling: number;
}

/**
 * Invariant census. Findings 12–17 were each a one-line rule a turn could break — no Dash at zero
 * Speed, no hold beyond its reach, no Dash past a usable attack, a swallowed creature at zero
 * separation — and each was found by reading the movers of the previous fix, so discovery tracked the
 * fix rate rather than what was left. With a recorder set, the engine checks those rules at the end
 * of every turn and around every chosen movement, and reports what it sees. The checks read state and
 * never write it, and they draw nothing from the RNG: `scripts/invariant-census.mjs` proves that on
 * every run by reproducing the sweep row for row. With no recorder set, nothing is checked.
 */
export type CensusRecorder = (invariant: string, creature: string, detail: string) => void;
let census: CensusRecorder | undefined;

export function setCensusRecorder(recorder: CensusRecorder | undefined): void {
  census = recorder;
}

/**
 * Two-stage adaptive sampling. Three quarters of the corpus's pairs are settled — one side takes
 * 99.5% or more — and a fixed fight count spends as much on those as on a coin flip. A pilot run
 * sizes the rest of the pair from the variance it actually shows: n = variance/se², which for a
 * settled pair is a few dozen fights and for a near-even one is the full budget.
 *
 * The variance is that of the per-fight score the ranking consumes (win 1, loss 0, a draw worth
 * 0.5 plus half its hit-point margin: `drawScore`). With no draws that is p(1-p). A pair that
 * always draws at the same margin has almost none, where p(1-p) with a draw counted as half a win
 * read it as a coin flip and spent the full budget on the longest fights in the corpus. The win
 * and draw rates of a pair that mixes draws and decisions are measured less tightly than its score.
 *
 * Sizing reads only the pilot, never the full sample, so the estimate stays essentially unbiased —
 * unlike stopping the moment a running confidence interval looks narrow, which biases toward
 * whichever side the early fights favoured. Measured bias over 60,000 real pairs: +0.00006.
 *
 * This only pays off because `writeRanking` weights every pair equally. Weighting by sample count
 * would read a cheaply-settled pair as weaker evidence than a hard-fought one and pull the fit
 * apart; with raw counts the same rule moved ranks by a median of 4 places and a maximum of 183.
 */
export interface AdaptiveSampling {
  /** Fights before the size is chosen. */
  pilot: number;
  /** Target standard error of the pair's score share. */
  targetSe: number;
}

export interface RunPairOptions {
  /** Disable only for differential verification and profiling. */
  memoize?: boolean;
  /** Disable only for differential verification and profiling. */
  shortCircuitStalemates?: boolean;
  /**
   * Price a candidate position by the foe's threat from the closest spot it could reach
   * *next* turn rather than from where it stands now. On by default since 2026-09-13; `false`
   * restores the one-turn view, kept for comparison. That view reads a square just outside the
   * foe's current reach as safe, so a creature stepped back to shoot, took the opportunity
   * attack, and the foe stepped straight back in — 3–5× as many opportunity attacks per fight,
   * and the largest family of harmful options the option ablation found. See
   * `out/lookahead-benchmark/notes.md`.
   */
  lookahead?: boolean;
  /** Verification/benchmark ablation: disable only the additional immutable-component caches. */
  cacheImmutableEv?: boolean;
  /** Verification/benchmark ablation: disable only per-movement-search action reuse. */
  reuseMovementActions?: boolean;
  /**
   * Verification/benchmark ablation: build every trace message in a non-verbose fight and throw
   * it away, as the engine did before 2026-09-17. `false` restores the old cost; the messages
   * are discarded either way, so no `PairResult` or `FightTrace` field changes.
   */
  elideLogMessages?: boolean;
  /** Verification/benchmark ablation: disable only per-movement-search threat reuse. */
  reuseMovementThreats?: boolean;
  /** Verification/benchmark ablation: disable only the pair-scoped movement landmark metadata. */
  cacheMovementMeta?: boolean;
  /** Verification/benchmark ablation: plan every fight's opening turn afresh (`firstPlans`). */
  reuseFirstPlan?: boolean;
  /** Optional test instrumentation. It observes cache use and never affects selection. */
  cacheStats?: EvCacheStats;
  /** Size each pair from a pilot instead of running the full count. */
  adaptive?: AdaptiveSampling;
}

export interface EvCacheStats {
  immutableHits: number;
  immutableMisses: number;
  movementActionHits: number;
  movementActionMisses: number;
  movementThreatHits: number;
  movementThreatMisses: number;
  movementMetaBuilds: number;
  /** Opening turns that took the pair's stored plan (`firstPlans`). */
  firstPlanHits?: number;
}

/**
 * The part of a creature's movement geometry that cannot change while a pair fights: which
 * distances its options make worth standing at, how tall it is, and how far its at-will melee
 * reaches. `actionRangeLandmarks` already memoizes one action; what repeated was the scan over
 * every option on both stat blocks, once per `moveCandidates` call, and `meleeReach`'s own scan
 * once per `moveHeights` call. Built lazily and only for a pair the evaluator has already
 * established is stable — a successor form rewrites its stat block in place, which is exactly the
 * mutation this would not survive.
 */
interface MovementMeta {
  /** Every landmark of the block's options, flattened in option order. */
  landmarks: number[];
  bodyHeight: number;
  meleeReach: number;
}

interface LegendaryResistanceComponent {
  alwaysHurt: boolean;
  instantDeathHpThreshold?: number;
  /** A slay-on-zero save's failed-save average; resisted in full when the foe's current HP is at or below it. */
  slayAverage?: number;
  /** The same for a save-margin save, per tier the 15% test does not already count: its average and resisted share. */
  slayTiers?: { average: number; resisted: number }[];
  resisted: number;
}

type ImmutableComponentKey = number | string;

interface PairEvaluator {
  /** Dice rolled in the fight under way, and the count when its first turn began (`firstPlans`). */
  dice?: { n: number; start: number };
  /**
   * The square search of a fight's opening turn. No die has been rolled since initiative, so everything it reads is
   * the two blocks, the scenario, the lookahead setting, who goes first and the two start counts: the same plan every fight of the pair.
   */
  firstPlans?: Map<string, { attacker: CombatStatblock; defender: CombatStatblock; plan: ReturnType<typeof chooseMovementAndRoutine> }>;
  actionEvAtDistance(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, distance: number, defences?: DefenceState, runUp?: number): number;
  actionEv(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, defences?: DefenceState, runUp?: number): number;
  actionRiderEv(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, runUp?: number): number;
  actionEvOnSave(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, defences?: DefenceState): number;
  repeatFactor(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, count: number, defences?: DefenceState, runUp?: number): number;
  legendaryResistanceComponent(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock): LegendaryResistanceComponent;
  bestRoutineEvAtDistance(attacker: CombatStatblock, defender: CombatStatblock, distance: number, allowLimited?: boolean): number;
  /** Memoized `actionMakesLethalProgress`; pure in (action, attacker, defender). */
  makesLethalProgress(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock): boolean;
  /** Memoized `actionExpectedDamage`; pure in (action, defender). */
  expectedActionDamage(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock): number;
  oa: Map<number, { optionIdx: number; ev: number } | null>;
  direction(attacker: CombatStatblock, defender: CombatStatblock): 0 | 1 | undefined;
  immutableComponents: boolean;
  reuseMovementActions: boolean;
  reuseMovementThreats: boolean;
  /** Immutable movement landmarks, or undefined when this pair is not eligible for them. */
  movementMeta(block: CombatStatblock): MovementMeta | undefined;
  cacheStats?: EvCacheStats;
}

/**
 * Cache keys are packed into integers rather than template strings. Distances are small
 * non-negative integers (movement candidates and weapon ranges), so `dir` and the
 * `allowLimited` flag ride in the high bits. Profiling attributed a large share of the
 * memo wrappers' cost to building `${dir}:${distance}` strings, not to the lookups.
 */
const DIRECTION_STRIDE = 4096;

/**
 * Only pack a distance into a numeric key when it genuinely fits. `actionRange` returns
 * Infinity for self-targeted actions, and Infinity would collapse both directions onto the
 * same key; anything that doesn't fit bypasses the cache and is computed directly.
 */
function packable(distance: number): boolean {
  return Number.isInteger(distance) && distance >= 0 && distance < DIRECTION_STRIDE;
}

function createPairEvaluator(
  a: CombatStatblock,
  b: CombatStatblock,
  memoize: boolean,
  cacheImmutableEv = memoize,
  reuseMovementActions = memoize,
  cacheStats?: EvCacheStats,
  reuseMovementThreats = memoize,
  cacheMovementMeta = memoize,
): PairEvaluator {
  // Successor forms replace the active statblock in-place. Bypass the cache for those
  // rare pairs until form identity/versioning is explicitly represented in the key.
  const enabled = memoize && !a.successor && !b.successor;
  const immutableComponents = enabled && cacheImmutableEv;
  const actionDistance = new WeakMap<CombatAction, Map<number, number>>();
  const actionDistanceVariants = new WeakMap<CombatAction, Map<ImmutableComponentKey, number>>();
  const actionValues = new WeakMap<CombatAction, Map<ImmutableComponentKey, number>>();
  const riderValues = new WeakMap<CombatAction, Map<ImmutableComponentKey, number>>();
  const onSaveValues = new WeakMap<CombatAction, Map<number, number>>();
  const repeatValues = new WeakMap<CombatAction, Map<ImmutableComponentKey, number>>();
  const legendaryResistanceValues = new WeakMap<CombatAction, [LegendaryResistanceComponent?, LegendaryResistanceComponent?]>();
  const routineThreat = new Map<number, number>();
  // Per-direction memos for predicates that depend only on (action, defender).
  const lethalProgress = new WeakMap<CombatAction, [boolean?, boolean?]>();
  const expectedDamageByAction = new WeakMap<CombatAction, [number?, number?]>();
  const identify = (attacker: CombatStatblock, defender: CombatStatblock): 0 | 1 | undefined =>
    attacker === a && defender === b ? 0 : attacker === b && defender === a ? 1 : undefined;
  // Every cache reads its direction through this, so `memoize: false` really does reach
  // all of them — otherwise the reference arm of `verify` would share a cache with the
  // optimized arm and could not prove anything about it.
  const direction = (attacker: CombatStatblock, defender: CombatStatblock): 0 | 1 | undefined =>
    enabled ? identify(attacker, defender) : undefined;
  const defenceBits = (defences: DefenceState): number => (defences.displacement ? 1 : 0) | (defences.evasion ? 2 : 0);
  const componentKey = (dir: 0 | 1, defences: DefenceState, runUp?: number): ImmutableComponentKey => {
    if (runUp === undefined) return dir * 4 + defenceBits(defences);
    if (Number.isSafeInteger(runUp) && runUp >= 0 && runUp < DIRECTION_STRIDE) {
      return (runUp + 1) * 8 + dir * 4 + defenceBits(defences);
    }
    return `${dir}:${defenceBits(defences)}:${runUp}`;
  };
  const cachedNumber = (
    cache: WeakMap<CombatAction, Map<ImmutableComponentKey, number>>,
    action: CombatAction,
    key: ImmutableComponentKey,
    compute: () => number,
  ): number => {
    let values = cache.get(action);
    if (!values) {
      values = new Map();
      cache.set(action, values);
    }
    const cached = values.get(key);
    if (cached !== undefined) {
      if (cacheStats) cacheStats.immutableHits++;
      return cached;
    }
    if (cacheStats) cacheStats.immutableMisses++;
    const value = compute();
    values.set(key, value);
    return value;
  };
  const cachedActionEv = (action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, defences: DefenceState = DEFENCES_ACTIVE, runUp?: number): number => {
    const dir = immutableComponents ? identify(attacker, defender) : undefined;
    if (dir === undefined) return actionEv(action, attacker, defender, defences, runUp);
    return cachedNumber(actionValues, action, componentKey(dir, defences, runUp),
      () => actionEv(action, attacker, defender, defences, runUp));
  };
  const cachedActionRiderEv = (action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, runUp?: number): number => {
    const dir = immutableComponents ? identify(attacker, defender) : undefined;
    if (dir === undefined) return actionRiderEv(action, defender, undefined, runUp, attacker);
    return cachedNumber(riderValues, action, componentKey(dir, DEFENCES_ACTIVE, runUp),
      () => actionRiderEv(action, defender, undefined, runUp, attacker));
  };
  const cachedActionEvOnSave = (action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, defences: DefenceState = DEFENCES_ACTIVE): number => {
    const dir = immutableComponents ? identify(attacker, defender) : undefined;
    if (dir === undefined) return actionEvOnSave(action, attacker, defender, defences);
    let values = onSaveValues.get(action);
    if (!values) {
      values = new Map();
      onSaveValues.set(action, values);
    }
    const key = dir * 4 + defenceBits(defences);
    const cached = values.get(key);
    if (cached !== undefined) {
      if (cacheStats) cacheStats.immutableHits++;
      return cached;
    }
    if (cacheStats) cacheStats.immutableMisses++;
    const value = actionEvOnSave(action, attacker, defender, defences);
    values.set(key, value);
    return value;
  };
  // `enabled` already excludes successor pairs, so within this evaluator's life `a` and `b`
  // are the very objects the fight uses and neither is rewritten underneath us.
  const movementMetaCache: [MovementMeta | undefined, MovementMeta | undefined] = [undefined, undefined];
  const movementMetaOn = enabled && cacheMovementMeta;
  const movementMeta = (block: CombatStatblock): MovementMeta | undefined => {
    if (!movementMetaOn) return undefined;
    const idx = block === a ? 0 : block === b ? 1 : undefined;
    if (idx === undefined) return undefined;
    let meta = movementMetaCache[idx];
    if (!meta) {
      if (cacheStats) cacheStats.movementMetaBuilds++;
      const landmarks: number[] = [];
      for (const option of block.options) for (const landmark of actionRangeLandmarks(option.action)) landmarks.push(landmark);
      meta = { landmarks, bodyHeight: bodyHeight(block), meleeReach: meleeReach(block) };
      movementMetaCache[idx] = meta;
    }
    return meta;
  };
  return {
    direction,
    immutableComponents,
    reuseMovementActions: enabled && reuseMovementActions,
    // Keyed on distance inside one movement search, where neither fighter's state moves; a
    // successor form cannot appear mid-search, so this one does not need `enabled`.
    reuseMovementThreats: memoize && reuseMovementThreats,
    movementMeta,
    cacheStats,
    oa: new Map(),
    actionEvAtDistance(action, attacker, defender, distance, defences = DEFENCES_ACTIVE, runUp) {
      const dir = direction(attacker, defender);
      if (dir === undefined || !packable(distance)) return rawActionEvAtDistance(action, attacker, defender, distance, defences, runUp);
      if (defences !== DEFENCES_ACTIVE || runUp !== undefined) {
        if (!immutableComponents) return rawActionEvAtDistance(action, attacker, defender, distance, defences, runUp);
        const baseKey = componentKey(dir, defences, runUp);
        const key = typeof baseKey === "number" ? baseKey * DIRECTION_STRIDE + distance : `${baseKey}:${distance}`;
        return cachedNumber(actionDistanceVariants, action, key,
          () => rawActionEvAtDistance(action, attacker, defender, distance, defences, runUp));
      }
      let byKey = actionDistance.get(action);
      if (!byKey) {
        byKey = new Map();
        actionDistance.set(action, byKey);
      }
      const key = dir * DIRECTION_STRIDE + distance;
      const cached = byKey.get(key);
      if (cached !== undefined) return cached;
      const value = rawActionEvAtDistance(action, attacker, defender, distance);
      byKey.set(key, value);
      return value;
    },
    actionEv: cachedActionEv,
    actionRiderEv: cachedActionRiderEv,
    actionEvOnSave: cachedActionEvOnSave,
    repeatFactor(action, attacker, defender, count, defences = DEFENCES_ACTIVE, runUp) {
      if (count <= 1) return count;
      const dir = immutableComponents ? identify(attacker, defender) : undefined;
      if (dir === undefined) return repeatFactor(action, attacker, defender, count, defences, runUp);
      const baseKey = componentKey(dir, defences, runUp);
      const key = typeof baseKey === "number" && Number.isSafeInteger(count) && count >= 0 && count < 256
        ? baseKey * 256 + count
        : `${baseKey}:${count}`;
      // The same arithmetic as the uncached `repeatFactor`, once-per-turn share included, over the cached prices.
      return cachedNumber(repeatValues, action, key, () => repeatFactorFrom(action, defender, count,
        (priced) => cachedActionEv(priced, attacker, defender, defences, runUp),
        (priced) => cachedActionRiderEv(priced, attacker, defender, runUp)));
    },
    legendaryResistanceComponent(action, attacker, defender) {
      const dir = immutableComponents ? identify(attacker, defender) : undefined;
      const compute = (): LegendaryResistanceComponent => {
        if (!("riders" in action)) return { alwaysHurt: false, resisted: 0 };
        if (action.kind === "save") {
          // A save-margin tier: the defender sees its roll, so a resistance is spent on the tier a failure falls in
          // (`resolveAction`), and only the failures it would be spent on are discounted.
          const tiers = saveMarginTierEvs(action, attacker, defender, DEFENCES_ACTIVE);
          if (tiers) {
            const hurts = (damage: DamageClause[], failedBy: number): boolean => damage.reduce(
              (sum, d) => sum + rollDice(d.dice, () => 0.5, false) * damageClauseMultiplier(d, defender, action.magical),
              0,
            ) >= defender.hpAvg * 0.15
              || action.riders.some((r) => marginAdmits(r, failedBy) && TURN_LOSING.has(r.condition) && !sleepBlocked(r, defender) && !immunityGated(r, defender));
            const belowHurt = hurts(action.damage, 0);
            const marginHurt = hurts(action.marginDamage?.damage ?? action.damage, Number.POSITIVE_INFINITY);
            const belowShare = (tiers.fail - tiers.failBy) * (tiers.below - tiers.onSave);
            const marginShare = tiers.failBy * (tiers.margin - tiers.onSave);
            const slayTiers = slayApplies(action, defender)
              ? [
                ...(belowHurt ? [] : [{ average: averageFailedDamage(action.damage, defender, action.magical), resisted: belowShare }]),
                ...(marginHurt ? [] : [{ average: averageFailedDamage(action.marginDamage?.damage ?? action.damage, defender, action.magical), resisted: marginShare }]),
              ]
              : [];
            return {
              alwaysHurt: belowHurt || marginHurt,
              instantDeathHpThreshold: action.instantDeathHpThreshold,
              ...(slayTiers.length ? { slayTiers } : {}),
              resisted: Math.max(0,
                (belowHurt ? belowShare : 0)
                + (marginHurt ? marginShare : 0)),
            };
          }
          const alwaysHurt = action.damage.reduce(
            (sum, d) => sum + rollDice(d.dice, () => 0.5, false) * damageClauseMultiplier(d, defender, action.magical),
            0,
          ) >= defender.hpAvg * 0.15 || action.riders.some((r) => TURN_LOSING.has(r.condition) && !sleepBlocked(r, defender) && !immunityGated(r, defender));
          return {
            alwaysHurt,
            instantDeathHpThreshold: action.instantDeathHpThreshold,
            ...(slayApplies(action, defender) ? { slayAverage: averageFailedDamage(action.damage, defender, action.magical) } : {}),
            resisted: Math.max(0,
              cachedActionEv(action, attacker, defender, DEFENCES_ACTIVE)
              - cachedActionEvOnSave(action, attacker, defender, DEFENCES_ACTIVE)),
          };
        }
        if (action.kind !== "attack") return { alwaysHurt: false, resisted: 0 };
        let resisted = actionRiderEv({ ...action, extraSave: undefined }, defender,
          (rider) => !!rider.save && INCAPACITATING.has(rider.condition), undefined, attacker);
        const burst = action.extraSave;
        if (burst?.riders?.some((rider) => INCAPACITATING.has(rider.condition) && !immunityGated(rider, defender))) {
          const asSave: CombatAction = {
            kind: "save", ability: burst.ability, dc: burst.dc, damage: burst.damage, onSuccess: burst.onSuccess,
            riders: burst.riders, magical: action.magical,
          };
          resisted += Math.max(0,
            cachedActionEv(asSave, attacker, defender, DEFENCES_ACTIVE)
            - cachedActionEvOnSave(asSave, attacker, defender, DEFENCES_ACTIVE));
        }
        return { alwaysHurt: true, resisted };
      };
      if (dir === undefined) return compute();
      let values = legendaryResistanceValues.get(action);
      if (!values) {
        values = [];
        legendaryResistanceValues.set(action, values);
      }
      const cached = values[dir];
      if (cached !== undefined) {
        if (cacheStats) cacheStats.immutableHits++;
        return cached;
      }
      if (cacheStats) cacheStats.immutableMisses++;
      const value = compute();
      values[dir] = value;
      return value;
    },
    bestRoutineEvAtDistance(attacker, defender, distance, allowLimited = true) {
      const dir = direction(attacker, defender);
      if (dir === undefined || !packable(distance)) return rawBestRoutineEvAtDistance(attacker, defender, distance, allowLimited);
      const key = (dir * 2 + (allowLimited ? 1 : 0)) * DIRECTION_STRIDE + distance;
      const cached = routineThreat.get(key);
      if (cached !== undefined) return cached;
      const value = rawBestRoutineEvAtDistance(attacker, defender, distance, allowLimited);
      routineThreat.set(key, value);
      return value;
    },
    makesLethalProgress(action, attacker, defender) {
      const dir = direction(attacker, defender);
      if (dir === undefined) return actionMakesLethalProgress(action, defender, attacker);
      let slots = lethalProgress.get(action);
      if (!slots) {
        slots = [];
        lethalProgress.set(action, slots);
      }
      let value = slots[dir];
      if (value === undefined) {
        value = actionMakesLethalProgress(action, defender, attacker);
        slots[dir] = value;
      }
      return value;
    },
    expectedActionDamage(action, attacker, defender) {
      const dir = direction(attacker, defender);
      if (dir === undefined) return actionExpectedDamage(action, defender);
      let slots = expectedDamageByAction.get(action);
      if (!slots) {
        slots = [];
        expectedDamageByAction.set(action, slots);
      }
      let value = slots[dir];
      if (value === undefined) {
        value = actionExpectedDamage(action, defender);
        slots[dir] = value;
      }
      return value;
    },
  };
}

/**
 * A fight's message sink. Every message in this file is built only for a human reading a trace,
 * so a non-verbose fight — which is every fight a sweep runs — must not build one at all. A
 * no-op `push` would not help: the template literal is evaluated before the call. Each site is
 * therefore guarded by `log.on`, a single monomorphic field read on one class, and the whole
 * message expression is skipped. Nothing behind a guard has a side effect; the audit is in
 * `out/fight-loop-speedups-notes.md`. Census recording is separate and is never guarded.
 */
export class FightLog {
  /** True only when a caller asked for a trace. Guards every message expression. */
  readonly on: boolean;
  readonly lines: string[] = [];
  constructor(on: boolean) {
    this.on = on;
  }
  push(line: string): void {
    this.lines.push(line);
  }
}

export interface FightTrace {
  winner: 0 | 1 | -1;
  rounds: number;
  winnerHpPct: number;
  /** Remaining hit-point fraction for each side, needed to score draws by margin. */
  hpPct: [number, number];
  log: string[];
}

const INCAPACITATING = new Set([
  // In a 1v1, a creature Charmed by its only opponent cannot attack that opponent.
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
]);
/**
 * What a failed save must threaten before a Legendary Resistance is spent on it for the condition alone:
 * `INCAPACITATING`, and the two effects that take the whole turn without it (Command's Grovel: "falls Prone and then
 * ends its turn"; Fear: "takes the Dash action and moves away").
 */
const TURN_LOSING = new Set([...INCAPACITATING, "commandedGrovel", "fearSpell"]);
/**
 * The conditions that carry the rules' Incapacitated condition. `INCAPACITATING` adds Charmed and Suggestion, which only
 * stop a creature attacking its one foe; neither ends a grapple the creature holds.
 */
const RULES_INCAPACITATED = new Set([...INCAPACITATING].filter((name) => name !== "charmed" && name !== "suggested"));
const AUTO_FAIL_STR_DEX = new Set(["paralyzed", "stunned", "unconscious"]);
/** Durations that end by the next turn: a lasting save-margin copy replaces one of these (`applyRiders`). */
const SHORT_DURATIONS = new Set<Rider["duration"]>(["startOfSourceNextTurn", "startOfTargetNextTurn", "endOfTargetNextTurn", "endOfSourceNextTurn"]);
const ADV_AGAINST = new Set(["paralyzed", "stunned", "unconscious", "restrained"]);
/**
 * The most turns of freedom a single escape roll is allowed to be priced against. The fight may
 * well run longer, but a decision made now on a twenty-round projection is a decision made on a
 * number nobody can stand behind; four is about the median fight's remaining length. It is the
 * same horizon `riderEv` prices a hold's tick over, so the creature applying the hold and the
 * creature deciding whether to break it are valuing the same four turns.
 */
const ESCAPE_HORIZON_TURNS = CONDITION_HORIZON_TURNS;
/** Paralyzed/Unconscious: an attack roll that *hits* is a critical hit from within 5 feet. */
const AUTO_CRIT_ADJACENT = new Set(["paralyzed", "unconscious"]);
const SPEED_ZERO = new Set(["paralyzed", "petrified", "unconscious", "grappled", "restrained", "hypnotized"]);
/** Resource key for a rebuke's own uses, distinct from every option pool the compiler emits. */
const REBUKE_POOL = "rebuke";

function initState(block: CombatStatblock, self: 0 | 1 = 0): FighterState {
  const recharge = new Map<string | number, { ready: boolean; min: number }>();
  const perDay = new Map<string | number, number>();
  const activations = new Map<string, { active: boolean; ready: boolean; min: number; lastOption?: number; lastTurn?: number }>();
  const counter = block.counterspell?.option;
  if (counter?.uses.t === "perDay") perDay.set(counter.uses.pool ?? "counterspell", counter.uses.max);
  if (counter?.uses.t === "recharge") recharge.set(counter.uses.pool ?? "counterspell", { ready: true, min: counter.uses.min });
  block.options.forEach((option, idx) => {
    if (option.uses.t === "recharge") recharge.set(option.uses.pool ?? idx, { ready: true, min: option.uses.min });
    if (option.uses.t === "perDay") perDay.set(option.uses.pool ?? idx, option.uses.max);
    if (option.activation && !activations.has(option.activation.group)) {
      activations.set(option.activation.group, { active: false, ready: true, min: option.activation.min });
    }
  });
  if (block.reaction?.uses?.t === "recharge") recharge.set("defensive-reaction", { ready: true, min: block.reaction.uses.min });
  if (block.reaction?.uses?.t === "perDay" && block.reaction.uses.pool && !perDay.has(block.reaction.uses.pool)) {
    perDay.set(block.reaction.uses.pool, block.reaction.uses.max);
  }
  // A rebuke's own limit is separate from the reaction slot it also spends: a fiendish warlock
  // has one reaction a round and three rebukes a day.
  if (block.rebuke?.uses.t === "perDay") perDay.set(REBUKE_POOL, block.rebuke.uses.max);
  if (block.rebuke?.uses.t === "recharge") recharge.set(REBUKE_POOL, { ready: true, min: block.rebuke.uses.min });
  return {
    hp: block.hpAvg,
    maxHp: block.hpAvg,
    tempHp: 0,
    recharge,
    perDay,
    reactionRemaining: block.reaction?.uses?.t === "perDay" ? block.reaction.uses.max : undefined,
    rollBoostLeft: block.rollBoost?.perDay,
    legendaryResistances: block.legendaryResistances,
    // "The stalker has the Invisible condition": held from the start, and not ended by attacking.
    conditions: block.innateInvisible
      ? [{ name: "invisible", duration: "permanent", source: self, appliedTurn: 0, breaksOnAttackOrSpell: false }] : [],
    usedThisRound: new Set(),
    lastDamageTypes: new Set(),
    tookCritical: false,
    reactionUsed: false,
    heads: block.heads?.initial,
    headsLost: 0,
    headTurnDamage: 0,
    headLostThisTurn: false,
    headFire: false,
    extraOpportunityUsed: 0,
    shieldActive: false,
    regenFailed: false,
    slain: false,
    petrifiedDefeat: false,
    deathBurstUsed: false,
    zeroHpBurstPending: false,
    concentrating: false,
    height: 0,
    movementPenalty: 0,
    withdrew: false,
    movedToward: 0,
    turnMoved: 0,
    ownTurn: false,
    runUpSpent: 0,
    attackResolving: false,
    turnCount: 0,
    mythicActive: false,
    activations,
    depleted: new Set(),
    justTransformed: false,
    formChanges: 0,
    lastActionHit: false,
    damageDealtThisTurn: 0,
    tookDamageSinceTurnEnd: false,
    damageTypesSinceTurnEnd: new Set(),
    bonusDamageUsed: false,
    perTurnUsed: new Set(),
    auraImmune: false,
    immuneTo: new Set(),
    effectsHeld: new Set(),
    spellSlotSpent: false,
    drainedScores: {},
  };
}

/**
 * Troll rule: a regenerator at 0 HP is only down once regeneration has failed at the start of
 * its turn. A "dies" effect (Power Word Kill, Disintegrate's dusting, Slaying Bow) is not a
 * reduction to 0 HP at all, so it bypasses that rule and kills outright, since
 * such effects bypass features that rely on a creature having 0 hit points.
 */
function isDown(block: CombatStatblock, state: FighterState): boolean {
  if (state.slain) return true;
  if (state.hp > 0) return false;
  if (block.regeneration?.deathRule && !state.regenFailed) return false;
  return true;
}

function instantDeathThreshold(action: CombatAction): number | undefined {
  if (action.kind === "save" || action.kind === "autohit") return action.instantDeathHpThreshold;
  return undefined;
}

/** Keep a charm that permits a damaging finisher instead of breaking it with another weapon. */
function preservesUsefulCharm(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock,
  state: FighterState, target: FighterState, source: 0 | 1, distance: number): boolean {
  const charm = target.conditions.find(c => c.source === source && c.endsOnSourceDamage && c.willingFor);
  if (!charm || !("damage" in action) || !action.damage.length || action.actionName?.split(" (")[0].toLowerCase() === charm.sourceDamageException?.toLowerCase()) return true;
  return !attacker.options.some((o, i) => o.action.actionName?.split(" (")[0].toLowerCase() === charm.willingFor!.toLowerCase()
    && usable(state, i, o) && actionInRange(o.action, distance)
    && actionRequirementMet(o.action, target, source) && actionTargetable(o.action, attacker, defender, distance, target, state));
}

/**
 * Whether to use again an action whose use ends the hold its last use left on the target (`Rider.endsOnReuse`: "or
 * the erinyes uses Entangling Rope again"). Using it frees the target and asks for a new save: a failure deals the
 * action's damage and holds it again, a success leaves it free. So the use is worth its damage at the odds of a
 * failure, and costs the hold at the odds of a success: what Restrained adds to the holder's attacks and takes from
 * the target's, over the turns a condition is priced for. With no such hold on the target it is used as any action is.
 */
function worthReusing(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, target: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator): boolean {
  if (action.kind !== "save" || !action.riders?.some((rider) => rider.endsOnReuse)) return true;
  if (!target.conditions.some((c) => c.endsOnReuse && c.source === source && action.riders.some((rider) => rider.endsOnReuse && rider.condition === c.name))) return true;
  const fails = saveFailChance(action.dc, defender.saves[action.ability] ?? defender.abilityMods[action.ability], actionSaveMode(action, defender));
  const perTurn = evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false) * (ADVANTAGE_EV - 1)
    + evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * (1 - DISADVANTAGE_EV) * threatFactor(defender, target);
  return fails * expectedDamage(action.damage, defender, action.magical) > (1 - fails) * perTurn * CONDITION_HORIZON_TURNS;
}

/**
 * A melee swing that is worth nothing against this foe (its damage is all immune, its riders all barred) and that the
 * foe's melee-hit response answers ("A creature that hits the pudding with a melee attack roll takes 4 (1d8) Acid
 * damage") is not made. A Chain Devil swung both Chains at a Black Pudding each round for 0 damage and about 8.6 of
 * its own Hit Points, where its Conjure Infernal Chain alone dealt the same.
 */
function recoilForNothing(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, target: FighterState, state: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator): boolean {
  const retaliation = defender.retaliation;
  if (!retaliation || retaliation.radius !== undefined || action.kind !== "attack" || !action.melee) return false;
  if (retaliation.requiresDamageTypes && !action.damage.some((clause) => retaliation.requiresDamageTypes!.includes(damageClauseType(clause, attacker, action.magical)))) return false;
  return expectedDamage(retaliation.damage, attacker, true) > 0
    && dynamicEv(action, attacker, defender, target, state, source, distance, evaluator, "action") <= 0;
}

function actionRequirementMet(action: CombatAction, target: FighterState, source: 0 | 1): boolean {
  if (action.kind === "random") return action.branches.some((branch) => actionRequirementMet(branch, target, source));
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return true;
  const required = action.requiresTargetConditions || (action.requiresTargetCondition ? [action.requiresTargetCondition] : []);
  const anyOf = action.requiresAnyTargetConditions || [];
  const missing = action.requiresTargetMissingConditions || [];
  return required.every((condition) => meetsCondition(target, condition, source))
    && (!anyOf.length || anyOf.some((condition) => meetsCondition(target, condition, source))
      || target.conditions.some(c => c.source === source && c.willingFor && c.willingFor.toLowerCase() === action.actionName?.split(" (")[0].toLowerCase()))
    && missing.every((condition) => !meetsCondition(target, condition, source));
}

/**
 * The states that carry Incapacitated with them — the four the rules list, and the three spell
 * states that impose it (Sleep's first round, Hypnotic Pattern, Hideous Laughter). Charmed
 * is in `INCAPACITATING` as a 1v1 shortcut, not because it is Incapacitated, so it is not here.
 */
const INCLUDES_INCAPACITATED = new Set([
  "incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "sleepDrowsy", "hypnotized", "hideousLaughter",
]);

/**
 * A prerequisite is met by the named state or by one that includes it. An exact-name test left
 * every "one Incapacitated creature" finisher waiting on a literal Incapacitated its owner never
 * applies: a brain-extracting creature stuns with one attack and then could not finish the stunned.
 */
function meetsCondition(target: Pick<FighterState, "conditions">, condition: string, source: 0 | 1): boolean {
  const names = condition === "incapacitated" ? INCLUDES_INCAPACITATED : new Set([condition]);
  return target.conditions.some((c) => names.has(c.name) && c.source === source);
}

/** The block's senses with a Truesight its holder has been granted (True Seeing) laid over its own. */
function eyes(block: CombatStatblock, state: FighterState | undefined): CombatStatblock {
  let granted = 0;
  if (state) for (const c of state.conditions) if (c.truesightRange !== undefined && c.truesightRange > granted) granted = c.truesightRange;
  return granted > (block.truesightRange ?? (block.truesight ? Infinity : 0)) ? { ...block, truesight: true, truesightRange: granted } : block;
}

/** All sight gates use the actual separation, including hypothetical movement positions. */
function canSee(observer: CombatStatblock, target: FighterState, observerState: FighterState | undefined, distance: number): boolean {
  return seesTarget(eyes(observer, observerState), !!observerState && hasCondition(observerState, "blinded"), unseenBy(target, observer), distance);
}

/** "An enemy it can sense": one it sees, or one within its Tremorsense while both are on the ground. */
function canSense(observer: CombatStatblock, target: FighterState, observerState: FighterState, distance: number): boolean {
  return canSee(observer, target, observerState, distance)
    || (observer.tremorsense !== undefined && distance <= observer.tremorsense && observerState.height === 0 && target.height === 0);
}

/**
 * Whether the target is unseen by ordinary sight: Invisible, unless outlined (Faerie Fire: "can't benefit from the
 * Invisible condition"), or inside its own magical Darkness, unless the observer's Darkvision is unimpeded by it.
 */
function unseenBy(target: FighterState, observer: CombatStatblock): boolean {
  const outlined = hasCondition(target, "outlined");
  return target.conditions.some((c) => c.name === "invisible" && (c.darkness ? !observer.seesMagicalDarkness : !outlined));
}

/**
 * Sight of a point at the target's distance ("a point it can see"): the observer's own Blindness, blindsight and
 * `blindBeyond`, not the target's invisibility.
 */
function canSeePoint(observer: CombatStatblock, observerState: FighterState | undefined, distance: number): boolean {
  return seesTarget(observer, !!observerState && hasCondition(observerState, "blinded"), false, distance);
}

function actionTargetable(
  action: CombatAction,
  attacker: CombatStatblock,
  defender: CombatStatblock,
  distance: number,
  target?: FighterState,
  attackerState?: FighterState,
): boolean {
  if (action.kind === "save" && action.targetGroundOnly && target && target.height > 0) return false;
  // The effect appears where the target stands, so its own sight decides: Blinded without Blindsight, it is unaffected.
  if (action.kind === "save" && action.targetMustSee && target && !canSeePoint(defender, target, 0)) return false;
  // A possessor has disappeared into the body: what it does to the body is attack it.
  if (attackerState?.possessing && action.kind !== "attack") return false;
  if (action.kind === "random") {
    return action.branches.some((branch) => actionTargetable(branch, attacker, defender, distance, target, attackerState));
  }
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return true;
  if (attackerState?.conditions.some(c => c.name === "charmed")) return false;
  if (target?.conditions.some(c => c.name === "swallowed")) return false;
  if (action.requiresSight && target
    && !(action.requiresSight === "point" ? canSeePoint(attacker, attackerState, distance) : canSee(attacker, target, attackerState, distance))) return false;
  if ("targetMaxSize" in action && action.targetMaxSize !== undefined && defender.size > action.targetMaxSize) return false;
  if ("targetTypes" in action && action.targetTypes && !action.targetTypes.includes(defender.creatureType)) return false;
  if ("excludedTargetTypes" in action && action.excludedTargetTypes?.includes(defender.creatureType)) return false;
  if (action.kind === "save" && action.excludedTargetTags?.some((tag) => defender.creatureTags.includes(tag))) return false;
  // A jump paid for with movement needs that movement: a creature whose Speed is 0 cannot make it.
  if (action.kind === "save" && action.jumpsToTarget && attackerState && movementSpeed(attacker, attackerState) < action.jumpsToTarget.cost) return false;
  // Nor a leap onto the source of its fear by a Frightened creature that does not already stand there.
  if (action.kind === "save" && action.jumpsToTarget && attackerState && isFrightened(attackerState)
    && (!target || distance > groundFloor(attacker, attackerState, attackerState.height, defender, target))) return false;
  if (action.kind === "save") {
    // The target is immune to this creature's named effect for 24 hours: the whole option, for the rest of the duel.
    if (target && successImmune(target, action.immuneOnSuccess)) return false;
    if (action.blockedByConditions?.some((c) => defender.conditionImmune.includes(c))) return false;
    // A spell whose whole effect the target is already under for the rest of the fight is not cast at it again
    // (Charm Monster "ends early if the dryad casts the spell again"): the new save can only lose what the first won.
    if (target && !action.damage?.length && action.riders?.length
      && action.riders.every((rider) => target.conditions.some((c) => c.name === rider.condition && c.duration === "permanent" && c.spellLevel === rider.spellLevel && rider.spellLevel !== undefined))) return false;
    // A creature that magic can't put to sleep: a sleep-inflicting breath or ray has nothing else to do to it.
    if (magicalSleepOnly(action, defender)) return false;
    // Sleep: creatures that don't sleep, such as elves, and creatures immune to the Exhaustion condition
    // automatically succeed, and so does one with a trait that stops magic from putting it to sleep (Fey Ancestry).
    if (action.blockedByConditions?.includes("exhaustion") && (defender.conditionImmune.includes("exhaustion") || defender.creatureTags.includes("elf") || defender.sleepImmune)) return false;
  }
  return true;
}

/**
 * The run-up a gate reads: the feet the attacker has moved toward its foe this turn, or, for a gate printed as needing
 * to come immediately before the hit (`requiresMovementImmediate`), the feet moved since its last attack.
 */
function runUpFor(state: FighterState, gate: { requiresMovementImmediate?: true }): number {
  return gate.requiresMovementImmediate ? state.movedToward - state.runUpSpent : state.movedToward;
}

const immediateRunUpActions = new WeakMap<CombatAction, boolean>();

/** Does a clause or rider on this action wait on a run-up printed "immediately before the hit"? */
function actionHasImmediateRunUpGate(action: CombatAction): boolean {
  let known = immediateRunUpActions.get(action);
  if (known === undefined) {
    known = action.kind === "random" ? action.branches.some(actionHasImmediateRunUpGate)
      : action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport" ? false
      : action.damage.some((clause) => !!clause.requiresMovement && !!clause.requiresMovementImmediate)
        || !!action.riders?.some((rider) => rider.requiresMovement !== undefined && !!rider.requiresMovementImmediate)
        || (action.kind === "attack" && action.followUp?.requiresMovement !== undefined && !!action.followUp.requiresMovementImmediate);
    immediateRunUpActions.set(action, known);
  }
  return known;
}

/** An attack roll, or a printed attack that hits automatically: what spends an "immediately before the hit" run-up. */
function makesAttack(action: CombatAction): boolean {
  return action.kind === "attack" || action.kind === "autohit" || (action.kind === "random" && action.branches.some(makesAttack));
}

/** Does any clause or rider on this action wait on a run-up? */
function actionHasRunUpGate(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.some(actionHasRunUpGate);
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return false;
  return action.damage.some((clause) => !!clause.requiresMovement)
    || !!action.riders?.some((rider) => rider.requiresMovement !== undefined)
    || (action.kind === "attack" && action.followUp?.requiresMovement !== undefined);
}

/**
 * Would this rider, landing now, push back the end of a copy the target already holds? A second rider that lasts
 * until the end of the source's next turn from the same source, on a later turn of that source, ends a
 * turn later than the first, so it is worth landing and `applyRiders` renews rather than skips it.
 */
function renews(held: ConditionState, rider: Rider, source: 0 | 1, sourceState: FighterState): boolean {
  return rider.duration === "endOfSourceNextTurn" && held.name === rider.condition && held.duration === "endOfSourceNextTurn"
    && held.source === source && held.appliedTurn < sourceState.turnCount;
}

/** Does the target hold this rider's condition in a copy the rider would not renew? */
function holdsUnrenewed(foeState: FighterState, rider: Rider, source: 0 | 1, sourceState: FighterState): boolean {
  const held = rider.condition === "exhaustion" || rider.push || rider.pull ? [] : foeState.conditions.filter((c) => c.name === rider.condition);
  return held.length > 0 && !held.every((c) => renews(c, rider, source, sourceState));
}

/** A pure-control action is wasted if every rider condition is already on the target (or immune). */
function riderStillUseful(action: CombatAction, defender: CombatStatblock, foeState: FighterState, source: 0 | 1, selfState: FighterState): boolean {
  if (action.kind === "random") return action.branches.some((branch) => riderStillUseful(branch, defender, foeState, source, selfState));
  if (!("riders" in action) || !action.riders?.length || action.damage.length) return true;
  return action.riders.some((r) => !defender.conditionImmune.includes(r.condition) && !holdsUnrenewed(foeState, r, source, selfState));
}

/** Every incapacitating condition on the target is one this action would renew. */
function renewsEveryLock(action: CombatAction, foeState: FighterState, source: 0 | 1, selfState: FighterState): boolean {
  if (!("riders" in action) || !action.riders?.length) return false;
  const riders = action.riders;
  return foeState.conditions.filter((c) => INCAPACITATING.has(c.name))
    .every((c) => riders.some((rider) => renews(c, rider, source, selfState)));
}

/** Does the action deal damage of any of the given types (e.g. a regenerator's suppression list)? */
function actionSuppresses(action: CombatAction, types: string[]): boolean {
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return false;
  if (action.kind === "random") return action.branches.some((b) => actionSuppresses(b, types));
  if (action.damage.some((d) => [d.type, ...(d.typeChoices || [])].some((type) => types.includes(type)))) return true;
  // Damage a rider deals each turn counts: a swallowed Troll takes the Acid before its next Regeneration.
  if (action.riders?.some((r) => [...(r.startTurnDamage ?? []), ...(r.endTurnDamage ?? [])].some((d) => types.includes(d.type)))) return true;
  return action.kind === "attack" && !!action.extraSave && action.extraSave.damage.some((d) => [d.type, ...(d.typeChoices || [])].some((type) => types.includes(type)));
}

function actionExpectedDamage(action: CombatAction, defender: CombatStatblock): number {
  if (spellBlocked(action, defender)) return 0;
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return 0;
  if (action.kind === "random") return action.branches.reduce((s, b) => s + actionExpectedDamage(b, defender), 0) / Math.max(1, action.branches.length);
  let dmg = expectedDamage(action.damage, defender, action.magical);
  if (action.kind === "attack" && action.extraSave) dmg += expectedDamage(action.extraSave.damage, defender, action.magical);
  if ("choiceRiders" in action) dmg += (action.choiceRiders || []).reduce((sum, choice) => sum + expectedDamage(choice.damage, defender, action.magical), 0);
  return dmg;
}

/** HP-maximum reduction can finish a death-rule regenerator without suppressing regeneration. */
function actionCanReduceMaxHp(action: CombatAction, defender: CombatStatblock): boolean {
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return false;
  if (action.kind === "random") return action.branches.some((branch) => actionCanReduceMaxHp(branch, defender));
  const clauses = [
    ...action.damage,
    ...(action.kind === "attack" ? action.extraSave?.damage || [] : []),
    ...("choiceRiders" in action ? (action.choiceRiders || []).flatMap((choice) => choice.damage) : []),
  ];
  // A reduction behind a save is progress only if that save can fail.
  if (clauses.some((clause) => clause.reducesMaxHp && expectedDamage([clause], defender, action.magical) > 0
    && maxHpReductionGateChance(action, clause.reducesMaxHpSave, defender) > 0)) return true;
  // So are dice of its own, which need no damage to land.
  const own = action.kind === "attack" || action.kind === "save" ? action.maxHpReduction : undefined;
  return !!own && maxHpReductionGateChance(action, own.save, defender) > 0;
}

/**
 * The chance the save gating a maximum-HP reduction fails, once the damage it follows has landed: 1 with no gate. A save
 * of its own is rolled as `settleMaxHpReductions` rolls it (the action's magic, no condition named); `"action"` is the
 * save action's own save.
 */
function maxHpReductionGateChance(action: CombatAction, save: MaxHpReductionSave | undefined, defender: CombatStatblock): number {
  if (!save) return 1;
  if (save === "action") {
    if (action.kind !== "save") return 0;
    return saveFailChance(action.dc, defender.saves[action.ability] ?? defender.abilityMods[action.ability], actionSaveMode(action, defender));
  }
  const magical = (action.kind === "attack" || action.kind === "save" || action.kind === "autohit") && action.magical;
  return saveFailChance(save.dc, defender.saves[save.ability] ?? defender.abilityMods[save.ability], saveAdvantage(defender, magical));
}

/**
 * What a reduction of the maximum by dice of its own (`MaxHpReduction`) is worth this turn: the hit points the cap takes
 * off. The maximum falls by the dice; current hit points fall only as far as they stand above the new maximum, after the
 * damage the same landing deals. So it is worth the dice against a foe at full hit points that the action's damage does
 * not reach (an energy drain that deals no damage), and nothing against a foe already missing more than the dice.
 * A reduction sized by a clause's damage needs no such term: it never exceeds the damage that landed with it. It reads
 * the foe's current and maximum hit points, so it lives outside the memoized evaluator.
 */
function maxHpReductionCapEv(action: CombatAction, defender: CombatStatblock, foeState: FighterState): number {
  if ((action.kind !== "attack" && action.kind !== "save") || !action.maxHpReduction) return 0;
  const own = action.maxHpReduction;
  if (own.requiresTargetCondition && !hasCondition(foeState, own.requiresTargetCondition)) return 0;
  const lands = (action.kind === "attack" ? hitChance(action.toHit, defender.ac) : 1) * maxHpReductionGateChance(action, own.save, defender);
  const missing = Math.max(0, foeState.maxHp - foeState.hp);
  return lands * Math.max(0, avgDice(own.dice) - missing - expectedDamage(action.damage, defender, action.magical));
}

const ABILITY_NAMES: Record<Ability, string> = {
  str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma",
};

/**
 * Whether this action's ability drain reaches this defender at all: its creature-type gate (the target must be
 * a certain type) and its immunity gate (unless the target is immune to a damage type). Pure in the defender's block.
 */
function drainApplies(action: CombatAction, defender: CombatStatblock): boolean {
  const drain = action.kind === "attack" || action.kind === "save" ? action.abilityDrain : undefined;
  if (!drain) return false;
  if (drain.targetTypes && !drain.targetTypes.includes(defender.creatureType)) return false;
  if (drain.unlessImmuneTo && defender.immune.includes(drain.unlessImmuneTo)) return false;
  return true;
}

/** A failed save's damage at the average the Legendary Resistance tests use: each clause at a constant 0.5 roll, after
 *  the defender's damage multipliers. */
function averageFailedDamage(damage: DamageClause[], defender: CombatStatblock, magical: boolean): number {
  return damage.reduce((sum, d) => sum + rollDice(d.dice, () => 0.5, false) * damageClauseMultiplier(d, defender, magical), 0);
}

/** Does this action's death-at-0-hit-points clause (a clause that kills a target the damage drops to 0) reach this defender (its type and size gates)? */
function slayApplies(action: CombatAction, defender: CombatStatblock): boolean {
  const slay = action.kind === "attack" || action.kind === "save" ? action.slaysOnZeroHp : undefined;
  if (!slay) return false;
  if (slay.targetTypes && !slay.targetTypes.includes(defender.creatureType)) return false;
  if (slay.targetMaxSize !== undefined && defender.size > slay.targetMaxSize) return false;
  return true;
}

/** The creature's current score in an ability: its printed score less any drain (10 + 2 × modifier for a block without scores). */
function currentScore(block: CombatStatblock, state: FighterState, ability: Ability): number {
  return state.drainedScores[ability] ?? block.abilityScores?.[ability] ?? 10 + 2 * block.abilityMods[ability];
}

/**
 * Lowers the target's score by the drain's roll; at 0 the target dies outright ("The target dies if this reduces that
 * score to 0"). That is the `slain` path, like instant death: regeneration's troll rule, Undead Fortitude, a mythic reset
 * and a successor form all answer a drop to 0 hit points, which this is not. Nothing happens to a target already down.
 */
function applyAbilityDrain(defender: CombatStatblock, dState: FighterState, action: CombatAction, rng: () => number, log: FightLog): void {
  if (!drainApplies(action, defender) || dState.justTransformed || isDown(defender, dState)) return;
  const drain = (action as AttackAction | SaveAction).abilityDrain!;
  const roll = rollDice(drain.dice, rng, false);
  const after = Math.max(0, currentScore(defender, dState, drain.ability) - roll);
  dState.drainedScores[drain.ability] = after;
  if (log.on) log.push(`${defender.name}'s ${ABILITY_NAMES[drain.ability]} drops by ${roll} to ${after}`);
  if (after <= 0) {
    dState.hp = 0;
    dState.slain = true;
    if (log.on) log.push(`${defender.name} dies (${ABILITY_NAMES[drain.ability]} 0)`);
  }
}

/** E[min(roll, score)] / score: the expected share of the remaining score one drain removes, exact over the dice. */
function expectedDrainFraction(drain: NonNullable<AttackAction["abilityDrain"]>, score: number): number {
  let totals = new Map<number, number>([[drain.dice.mod, 1]]);
  for (let i = 0; i < drain.dice.n; i++) {
    const next = new Map<number, number>();
    for (const [total, p] of totals) {
      for (let face = 1; face <= drain.dice.d; face++) next.set(total + face, (next.get(total + face) ?? 0) + p / drain.dice.d);
    }
    totals = next;
  }
  let expected = 0;
  for (const [total, p] of totals) expected += p * Math.min(Math.max(0, total), score);
  return expected / score;
}

/**
 * What a drain is worth to the chooser: progress toward the death at 0, in the hit points the chooser prices damage in.
 * The chance it lands (the static hit chance, or the failed-save chance) times the expected share of the foe's remaining
 * score it removes, times the foe's current hit points, the other road to the same death. A roll sure to reach 0 is worth
 * the foe's current hit points, which is what a sure lethal hit is worth: no bonus beyond expected value.
 */
function drainProgressEv(action: CombatAction, defender: CombatStatblock, foeState: FighterState): number {
  if (action.kind !== "attack" && action.kind !== "save") return 0;
  const drain = action.abilityDrain!;
  const score = currentScore(defender, foeState, drain.ability);
  if (score <= 0) return 0;
  const lands = action.kind === "attack"
    ? hitChance(action.toHit, defender.ac)
    : drain.on === "eitherSave"
      ? 1
      : saveFailChance(action.dc, defender.saves[action.ability] ?? defender.abilityMods[action.ability], actionSaveMode(action, defender));
  return lands * expectedDrainFraction(drain, score) * Math.max(0, foeState.hp);
}

/**
 * Can one damage packet of this action roll the defender's death threshold (`Regeneration.deathThreshold`)? The packets
 * are the ones the engine deals: the action's own damage (an attack's dice doubled, since a critical hit can), and, where
 * the print counts any damage ("takes"), an attack's burst behind a save and each choice rider's damage. With
 * `attackOnly` only an attack roll's own hit counts. Each clause is taken at its maximum in the type the engine would
 * deal (`damageClauseType`), after the defender's standing defences; a clause gated on a creature type the defender is
 * not is left out; gates on the fight's state are not read, the test being static.
 */
function actionReachesDeathThreshold(action: CombatAction, defender: CombatStatblock, threshold: NonNullable<Regeneration["deathThreshold"]>): boolean {
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return false;
  if (action.kind === "random") return action.branches.some((branch) => actionReachesDeathThreshold(branch, defender, threshold));
  const magical = action.magical;
  const reaches = (clauses: DamageClause[] | undefined, crit: boolean): boolean => {
    let sum = 0;
    for (const clause of clauses || []) {
      if (clause.targetTypes && !clause.targetTypes.includes(defender.creatureType)) continue;
      if (clause.excludedTargetTypes?.includes(defender.creatureType)) continue;
      if (!threshold.types.includes(damageClauseType(clause, defender, magical))) continue;
      const multiplier = damageClauseMultiplier(clause, defender, magical);
      if (multiplier <= 0) continue;
      sum += Math.floor(Math.max(0, clause.dice.n * clause.dice.d * (crit ? 2 : 1) + clause.dice.mod) * multiplier);
    }
    return sum >= threshold.amount;
  };
  if (reaches(action.damage, action.kind === "attack") && (!threshold.attackOnly || action.kind === "attack")) return true;
  if (threshold.attackOnly) return false;
  if (action.kind === "attack" && reaches(action.extraSave?.damage, false)) return true;
  return "choiceRiders" in action && !!action.choiceRiders?.some((choice) => reaches(choice.damage, false));
}

/**
 * Damage that can actually finish this defender. A troll-rule regenerator only dies to damage
 * of a suppressing type, so ordinary damage — however large — is not progress toward killing it.
 */
function actionMakesLethalProgress(action: CombatAction, defender: CombatStatblock, attacker?: CombatStatblock): boolean {
  if (spellBlocked(action, defender)) return false;
  if ("riders" in action && action.riders?.some(r => r.condition === "exhaustion") && !defender.conditionImmune.includes("exhaustion")) return true;
  // A "dies" effect kills outright, so it is progress against anything, regenerator included.
  // One that needs its target at 0 Hit Points first ("that has 0 Hit Points", a Will-o'-Wisp's Consume Life) is progress
  // against a regenerator only where the block's damage can get it there: more a round than it regains.
  const deathAt = instantDeathThreshold(action);
  if (deathAt !== undefined) {
    const mends = deathAt <= 0 && defender.regeneration?.deathRule ? defender.regeneration.amount : 0;
    if (!mends || !attacker || attacker.routines.some((routine) => routine.parts.reduce((sum, part) =>
      sum + part.count * actionExpectedDamage(attacker.options[part.optionIdx].action, defender), 0) > mends)) return true;
  }
  // So does an ability drain that kills at 0.
  if (drainApplies(action, defender)) return true;
  // So does turning the thing to stone, and by the same reasoning: it never routes through 0 HP,
  // so no amount of regeneration answers it.
  if (actionPetrifies(action) && !defender.conditionImmune.includes("petrified")) return true;
  // And so does a hold that turns to stone at the source's next turn.
  if (actionPetrifiesLater(action, defender)) return true;
  if (actionCanReduceMaxHp(action, defender)) return true;
  // So does damage that kills when it takes the target to 0 (a clause that kills a target the ray drops to 0): the troll
  // rule does not answer it.
  if (actionSlaysOnZero(action, defender)) return true;
  // So does a heal block the defender can suffer, against a
  // regenerator with a death rule: one that starts its turn at 0 HP unable to regain hit points dies (`startTurn`).
  const regen = defender.regeneration;
  if (regen?.deathRule && actionAppliesHealBlock(action, defender)) return true;
  if (actionExpectedDamage(action, defender) <= 0) return false;
  // A regenerator that dies only to a threshold packet at 0 HP is finished only by
  // damage that can roll that packet (or by the heal-block zone below, which stops its regain like any death-rule
  // regenerator's).
  if (regen?.deathThreshold) {
    return actionReachesDeathThreshold(action, defender, regen.deathThreshold) || (!!attacker && holdsHealBlockZone(attacker, defender));
  }
  const suppressBy = regen?.deathRule && regen.suppressedBy.length ? regen.suppressedBy : null;
  return !suppressBy
    || actionSuppresses(action, suppressBy)
    || (!!regen?.suppressedByCritical && action.kind === "attack")
    // So is any damage dealt by a block that holds a heal-block zone (`Aura.blocksHealing`) the
    // defender is admitted to. The test is static, so the zone's radius is not read here.
    || (!!attacker && holdsHealBlockZone(attacker, defender));
}

/**
 * Can a heal-block rider (`Rider.blocksHealing`) landed now still hold at the start of its target's next turn, where the
 * regeneration it must stop happens? "Until the start of its next turn" never does (`healBlocked`). A copy timed by its
 * source's turn does when it lands on the source's own turn, and not when it lands as a Legendary action: the source's
 * turn comes next and ends it first. A `rounds` clock runs out as the source's turn begins, so one round landed as a
 * Legendary action lapses the same way.
 */
function healBlockRiderCanHold(rider: Rider, timing: Timing = "action"): boolean {
  if (!rider.blocksHealing || rider.duration === "startOfTargetNextTurn") return false;
  if (timing !== "legendary") return true;
  return rider.duration !== "startOfSourceNextTurn" && rider.duration !== "endOfSourceNextTurn" && (rider.rounds === undefined || rider.rounds > 1);
}

/**
 * Does this action carry a heal block this defender can suffer, one that can hold at the defender's turn start? The
 * rider's own gates, the defender's condition immunities and the roll or save in front of it are the ones the chooser
 * prices riders with (`actionRiderEv`): a rider that cannot land is worth nothing there. `include` adds the state
 * tests `dynamicEv` knows (a copy already held, a success immunity). Asked only against a regenerator, which has a
 * regain for the block to stop, so a landable rider's worth is above 0.
 */
function actionAppliesHealBlock(action: CombatAction, defender: CombatStatblock, timing: Timing = "action", include: (rider: Rider) => boolean = () => true): boolean {
  if (!carriesHealBlockRider(action)) return false;
  return actionRiderEv(action, defender, (rider) => healBlockRiderCanHold(rider, timing) && include(rider)) > 0;
}

/** Does the action carry a `blocksHealing` rider at all (its own riders, a burst's, a random branch's)? Pure in the action. */
const healBlockCarriers = new WeakMap<CombatAction, boolean>();
function carriesHealBlockRider(action: CombatAction): boolean {
  let carries = healBlockCarriers.get(action);
  if (carries === undefined) {
    carries = action.kind === "random"
      ? action.branches.some(carriesHealBlockRider)
      : "riders" in action && (!!action.riders?.some((rider) => rider.blocksHealing)
        || (action.kind === "attack" && !!action.extraSave?.riders?.some((rider) => rider.blocksHealing)));
    healBlockCarriers.set(action, carries);
  }
  return carries;
}

/** The attacker holds a heal-block zone (`Aura.blocksHealing`) whose printed type gates admit this defender. */
function holdsHealBlockZone(attacker: CombatStatblock, defender: CombatStatblock): boolean {
  const aura = attacker.aura;
  if (!aura?.blocksHealing || aura.radius === undefined) return false;
  if (aura.targetTypes && !aura.targetTypes.includes(defender.creatureType)) return false;
  return !aura.excludedTargetTypes?.includes(defender.creatureType);
}

/**
 * Will the foe be barred from healing when its next turn begins, as things stand? A copy it holds
 * (`ConditionState.blocksHealing`), by each duration's own end: "until the start of its next turn" has lapsed by then; a
 * copy timed by this creature's turn holds through its own turn and not past its next one, so during a Legendary action
 * (its turn is next) it does not, and a copy lasting to the end of its next turn holds only if it landed this turn; a clocked copy
 * (`endsSourceTurn`) lapses as this creature's turn begins. Or the zone (`heldHealBlock`), with the foe inside it at the
 * square being priced.
 */
function healBlockHoldsAtNextTurnStart(foeState: FighterState, selfState: FighterState, source: 0 | 1, timing: Timing, distance: number): boolean {
  if (heldHealBlock(foeState, distance)) return true;
  return foeState.conditions.some((c) => {
    if (!c.blocksHealing || c.duration === "startOfTargetNextTurn") return false;
    // A copy the foe gave itself is timed by the foe's own turn: a copy lasting to the start of its next turn is gone as that turn begins.
    if (c.source !== source) return c.duration !== "startOfSourceNextTurn";
    if (c.endsSourceTurn !== undefined && timing === "legendary" && selfState.turnCount + 1 >= c.endsSourceTurn) return false;
    if (c.duration === "startOfSourceNextTurn") return timing !== "legendary";
    if (c.duration === "endOfSourceNextTurn") return timing !== "legendary" && c.appliedTurn >= selfState.turnCount;
    return true;
  });
}

/** A damaging action (or random branch) whose `slaysOnZeroHp` reaches this defender. */
function actionSlaysOnZero(action: CombatAction, defender: CombatStatblock): boolean {
  if (action.kind === "random") return action.branches.some((branch) => actionSlaysOnZero(branch, defender));
  return slayApplies(action, defender) && actionExpectedDamage(action, defender) > 0;
}

/**
 * Does this action land a condition that turns its target to stone at a later turn boundary, on this defender
 * (`Rider.delayedCondition`; the hold's own size and immunity gates)?
 */
function actionPetrifiesLater(action: CombatAction, defender: CombatStatblock): boolean {
  if (action.kind === "random") return action.branches.some((branch) => actionPetrifiesLater(branch, defender));
  if (!("riders" in action)) return false;
  if ("targetMaxSize" in action && action.targetMaxSize !== undefined && defender.size > action.targetMaxSize) return false;
  return (action.riders || []).some((rider) => rider.delayedCondition?.condition === "petrified"
    && !defender.conditionImmune.includes("petrified") && !defender.conditionImmune.includes(rider.condition)
    && (rider.targetMaxSize === undefined || defender.size <= rider.targetMaxSize));
}

/** Does this action turn its target to stone, now or on a failed repeat save? */
function actionPetrifies(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.some(actionPetrifies);
  if (!("riders" in action)) return false;
  const riders = [...(action.riders || []), ...(action.kind === "attack" ? action.extraSave?.riders || [] : [])];
  return riders.some((rider) => rider.condition === "petrified" || rider.transitionOnFailedSave === "petrified");
}

/** Ongoing rider damage is conservatively treated as a possible killing route. */
function actionHasOngoingDamage(action: CombatAction): boolean {
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return false;
  if (action.kind === "random") return action.branches.some(actionHasOngoingDamage);
  const riders = "riders" in action ? action.riders || [] : [];
  if (riders.some((rider) => !!rider.startTurnDamage?.length || !!rider.endTurnDamage?.length || !!rider.delayedDamage?.damage.length)) return true;
  return action.kind === "attack"
    && !!action.extraSave?.riders?.some((rider) => !!rider.startTurnDamage?.length || !!rider.endTurnDamage?.length || !!rider.delayedDamage?.damage.length);
}

/** Lethal progress that does not pass through 0 Hit Points: Exhaustion to its sixth level, an ability drain, petrification. */
function finishesWithoutDamage(action: CombatAction, defender: CombatStatblock): boolean {
  return ("riders" in action && !!action.riders?.some((rider) => rider.condition === "exhaustion") && !defender.conditionImmune.includes("exhaustion"))
    || drainApplies(action, defender)
    || (actionPetrifies(action) && !defender.conditionImmune.includes("petrified"))
    || actionPetrifiesLater(action, defender);
}

/** The conditions that satisfy a requirement for the one named: an Incapacitated target is also a Paralyzed one. */
const CONDITION_IMPLIED_BY: Record<string, string[]> = { incapacitated: ["incapacitated", "paralyzed", "stunned", "unconscious", "petrified"] };
const imposedConditions = new WeakMap<CombatStatblock, { names: Set<string>; willing: boolean }>();

/**
 * An option that waits on something this attacker can never bring about on this defender: a creature type the option
 * does not take ("isn't an Undead", "one Humanoid"), or a condition on the target that nothing the attacker has imposes
 * or that the defender is immune to. A Vampire Spawn's Bite needs its target "Grappled, Incapacitated, or Restrained";
 * an Ochre Jelly is immune to two and the spawn has nothing for the third, so the Bite is no line against it.
 */
function requirementOutOfReach(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock): boolean {
  if (action.kind === "random" || action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return false;
  if ("targetTypes" in action && action.targetTypes && !action.targetTypes.includes(defender.creatureType)) return true;
  if ("excludedTargetTypes" in action && action.excludedTargetTypes?.includes(defender.creatureType)) return true;
  const required = action.requiresTargetConditions || (action.requiresTargetCondition ? [action.requiresTargetCondition] : []);
  const anyOf = action.requiresAnyTargetConditions || [];
  if (!required.length && !anyOf.length) return false;
  let imposed = imposedConditions.get(attacker);
  if (!imposed) {
    const text = JSON.stringify([attacker.options, attacker.routines, attacker.aura, attacker.sourceTurnAura, attacker.reaction]);
    imposed = { names: new Set([...text.matchAll(/"condition":"([A-Za-z]+)"/g)].map((match) => match[1])), willing: text.includes('"willingFor"') };
    imposedConditions.set(attacker, imposed);
  }
  if (imposed.willing) return false;
  const reachable = (condition: string): boolean => (CONDITION_IMPLIED_BY[condition] ?? [condition])
    .some((name) => imposed!.names.has(name) && !defender.conditionImmune.includes(name));
  return required.some((condition) => !reachable(condition)) || (anyOf.length > 0 && !anyOf.some(reachable));
}

/**
 * Nothing this creature has, usable now or on a recharge, can put its foe down for good: every damaging option meets an
 * immunity, or the foe regenerates and dies only to a damage type the creature lacks. Such a creature cannot win, so
 * where it stands is decided by what the foe can do to it there and by nothing else (`chooseMovementAndRoutine`).
 */
function noLethalLineLeft(attacker: CombatStatblock, state: FighterState, defender: CombatStatblock, evaluator: PairEvaluator): boolean {
  // Ongoing damage counts only in a type the foe is not immune to (a Fire Elemental's burning on an Imp is nothing).
  const hurts = (damage: DamageClause[] | undefined): boolean => !!damage?.some((clause) => !defender.immune.includes(clause.type));
  const lingers = (action: CombatAction): boolean => {
    if (!actionHasOngoingDamage(action)) return false;
    if (action.kind === "random") return true;
    const riders = [...("riders" in action ? action.riders || [] : []), ...(action.kind === "attack" ? action.extraSave?.riders || [] : [])];
    return riders.some((rider) => hurts(rider.startTurnDamage) || hurts(rider.endTurnDamage) || hurts(rider.delayedDamage?.damage));
  };
  // A finisher that needs its target already at or under a Hit Point mark ("that has 0 Hit Points") is a line only for
  // a creature with some way to bring the foe there.
  const hurtsAtAll = attacker.options.some((option) => evaluator.expectedActionDamage(option.action, attacker, defender) > 0);
  const outOfReach = (action: CombatAction): boolean => {
    const mark = instantDeathThreshold(action);
    return mark !== undefined && mark < defender.hpAvg && !hurtsAtAll && !finishesWithoutDamage(action, defender);
  };
  const progress = (action: CombatAction): boolean => (evaluator.makesLethalProgress(action, attacker, defender) && !outOfReach(action) && !requirementOutOfReach(action, attacker, defender)) || lingers(action);
  // Spent for good is a daily option with no uses left. One merely not usable this turn (a recharge, a roar that waits
  // its place in a sequence, a Bonus Action barred this turn) is still a line.
  const spent = (option: ActionOption, idx: number): boolean => state.depleted.has(idx)
    || (option.uses.t === "perDay" && (state.perDay.get(option.sequence?.pool ?? option.uses.pool ?? idx) ?? 0) <= 0);
  // Charmed for the rest of the fight with no cure left, it "can't attack the charmer or target the charmer with
  // damaging abilities or magical effects" (SRD 5.2.1, Charmed): no option of its own is a line, whatever it would
  // deal. A Couatl under a Lamia's hour-long curse, its Greater Restoration cast, Dodged beside her until it died.
  const barred = state.conditions.some((c) => c.name === "charmed" && c.duration === "permanent" && !c.endsOnDamage && !c.endsOnSourceDamage
    && c.endsSourceTurn === undefined && !c.concentrationSource)
    && !attacker.options.some((option, idx) => !spent(option, idx) && option.action.kind === "selfheal"
      && option.action.curesConditions?.includes("charmed"));
  if (!barred && attacker.options.some((option, idx) => !spent(option, idx) && progress(option.action))) return false;
  if (!barred && attacker.routines.some((routine) => !!routine.onAllHits && progress(routine.onAllHits.action))) return false;
  // Nor is a body that hurts the foe by being near it.
  const passive = (aura: Aura | undefined): boolean => !!aura && (expectedDamage(aura.damage, defender, aura.magical ?? true) > 0
    || aura.riders.some((rider) => rider.startTurnDamage?.length || rider.endTurnDamage?.length
      ? hurts(rider.startTurnDamage) || hurts(rider.endTurnDamage)
      : !defender.conditionImmune.includes(rider.condition)));
  return !passive(attacker.aura) && !passive(attacker.sourceTurnAura)
    && !(attacker.spaceEntry && expectedDamage(attacker.spaceEntry.damage, defender, false) > 0)
    && retaliationThreat(attacker, defender, 5) <= 0;
}

function canMakeLethalProgress(attacker: CombatStatblock, defender: CombatStatblock): boolean {
  if (attacker.options.some((option) => actionMakesLethalProgress(option.action, defender, attacker) || actionHasOngoingDamage(option.action))) return true;
  return attacker.routines.some((routine) => !!routine.onAllHits
    && (actionMakesLethalProgress(routine.onAllHits.action, defender, attacker) || actionHasOngoingDamage(routine.onAllHits.action)));
}

/**
 * Deliberately incomplete proof: false negatives cost time, while false positives
 * would change results. Successor-form pairs remain on the reference path.
 */
export function isProvableStalemate(a: CombatStatblock, b: CombatStatblock): boolean {
  if (a.successor || b.successor) return false;
  if (canMakeLethalProgress(a, b) || canMakeLethalProgress(b, a)) return false;
  // Now that draws are scored by hit-point margin, the shortcut has to predict the final
  // hit points too, not just the winner. "No lethal progress" still permits chip damage —
  // an attacker can whittle a regenerator it can never actually put down — so the shortcut
  // is only sound when neither side can land any damage at all, leaving both at full.
  return !canDealAnyDamage(a, b) && !canDealAnyDamage(b, a);
}

/** Any damage at all, lethal or not, including ongoing rider damage and aura or retaliation ticks. */
function canDealAnyDamage(attacker: CombatStatblock, defender: CombatStatblock): boolean {
  if (attacker.aura && expectedDamage(attacker.aura.damage, defender, true) > 0) return true;
  if (attacker.sourceTurnAura && expectedDamage(attacker.sourceTurnAura.damage, defender, true) > 0) return true;
  if (attacker.spaceEntry && expectedDamage(attacker.spaceEntry.damage, defender, false) > 0) return true;
  if (attacker.retaliation && expectedDamage(attacker.retaliation.damage, defender, true) > 0) return true;
  const hurts = (action: CombatAction) => actionExpectedDamage(action, defender) > 0 || actionHasOngoingDamage(action);
  if (attacker.options.some((option) => hurts(option.action))) return true;
  return attacker.routines.some((routine) => !!routine.onAllHits && hurts(routine.onAllHits.action));
}

/**
 * Maximum usable range after a sight requirement is taken into account. `visibleRange` is how far the source sees the
 * foe; `pointRange` how far it sees a point (its own sight, the foe's invisibility aside).
 */
function actionTargetRange(action: CombatAction, visibleRange: number, pointRange = visibleRange): number {
  if (action.kind === "random") return Math.max(0, ...action.branches.map(branch => actionTargetRange(branch, visibleRange, pointRange)));
  if (!("requiresSight" in action) || !action.requiresSight) return actionRange(action);
  return Math.min(actionRange(action), action.requiresSight === "point" ? pointRange : visibleRange);
}

function actionCanMakeProgressCloser(action: CombatAction, defender: CombatStatblock, currentDistance: number, visibleRange = Infinity, attacker?: CombatStatblock, pointRange = visibleRange): boolean {
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return false;
  if (action.kind === "random") return action.branches.some((branch) => actionCanMakeProgressCloser(branch, defender, currentDistance, visibleRange, attacker, pointRange));
  return actionMakesLethalProgress(action, defender, attacker) && actionTargetRange(action, visibleRange, pointRange) < currentDistance;
}

/**
 * How much of the foe's printed offence to price into a candidate square. A Paralyzed or Stunned
 * foe will most likely lose its next turn, so standing inside its reach is not the gamble the
 * static threat term makes it look like — and a creature that would not close on a helpless
 * opponent is leaving the only free round it will get on the table. Halved rather than zeroed
 * because the conditions worth the most end on a save the foe may well make.
 *
 * Applies to the foe's routine only. An aura still radiates and a retaliation still bites while
 * its owner is unconscious, so those terms are left at full weight.
 */
function threatFactor(foe: CombatStatblock, foeState: FighterState): number {
  // A foe under Command's Grovel falls Prone and ends its next turn with no save left to make: it answers nothing then.
  if (hasCondition(foeState, "commandedGrovel")) return 0;
  return (foe.heads ? (foeState.heads ?? foe.heads.initial) / foe.heads.initial : 1) * (1 - 0.5 * incapacitationPersistence(foe, foeState));
}

/**
 * How likely the foe is still unable to act when its turn comes round. A condition that simply
 * lasts is worth its full weight; one it re-saves against at the end of every turn is worth only
 * its chance of sticking.
 *
 * This distinction is not academic. Weighing a save-ends condition as though it were permanent
 * talked a seven-hit-point Pseudodragon into landing next to an Allosaurus it had just stung
 * unconscious, to collect the critical hits an adjacent attacker gets — and the dinosaur made its
 * save. It went from winning 36% of those fights to 2%.
 */
function incapacitationPersistence(foe: CombatStatblock, foeState: FighterState): number {
  let best = 0;
  for (const condition of foeState.conditions) {
    if (!INCAPACITATING.has(condition.name)) continue;
    // A Sleep-style condition ends the moment the sleeper is hurt, so it cannot survive contact
    // with the very attack being priced. It buys exactly one hit, never a position worth taking:
    // a Pseudodragon that stung an opponent unconscious and then landed beside it to collect
    // criticals woke it with the first one, and stood there at ten hit points to find out.
    // "Until the start of its next turn" has lapsed by the time the foe's turn comes round.
    const persists = condition.endsOnDamage || condition.duration === "startOfTargetNextTurn"
      ? 0
      : condition.duration === "saveEndsEachTurn" && condition.save
        ? saveFailChance(condition.save.dc, foe.saves[condition.save.ability] ?? foe.abilityMods[condition.save.ability],
          saveAdvantage(foe, !!condition.magical, repeatSaveConditions(condition, foeState)))
        : 1;
    best = Math.max(best, persists);
  }
  return best;
}

/**
 * What a jump is worth: the routine it unlocks, plus the threat it walks out of, minus what
 * the creature already has where it stands. Self-limiting by construction — a creature
 * already standing in its best spot values a teleport at zero and attacks instead — which is
 * what keeps a repositioning option from crowding out the attack it exists to set up.
 *
 * Escaping a grapple is scored separately and dominates: being held is worth far more than
 * any distance, because it costs the creature its whole action every round until it breaks.
 *
 * The candidate scan is deliberately coarse (the extremes plus each side's option ranges);
 * the exact landing spot is chosen by `chooseTeleportGround` when the jump actually happens.
 */
function teleportEv(
  spec: TeleportSpec,
  attacker: CombatStatblock,
  defender: CombatStatblock,
  selfState: FighterState,
  foeState: FighterState,
  source: 0 | 1,
  distance: number,
  evaluator: PairEvaluator,
  allowRetreat = false,
): number {
  if (teleportBlocked(selfState)) return 0;
  const held = selfState.conditions.some(teleportFreesHold);
  // Positions are priced with the *static* routine evaluator, never the state-aware one.
  // `bestUsableRoutinesAtDistance` scores every option through `dynamicEv`, which would come
  // straight back here for the very teleport being valued — an unbounded recursion. The
  // static yardstick is the same one the threat term already uses, and it is memoized.
  const threatHere = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false);
  const hereEv = evaluator.bestRoutineEvAtDistance(attacker, defender, distance, true);
  // Net worth of a separation: what the creature can do from it, less what it must stand
  // still for. The same 0.7 the movement search uses when it asks whether closing is worth
  // it — and the reason that question has to be asked at all. Counting only the offence a
  // jump unlocks talked ranged casters into teleporting into melee to bring a short-range
  // option online, and two such casters each lost about two points
  // of win rate for the privilege.
  //
  // The foe's threat is priced from the closest spot *it* can reach next turn, not from the
  // landing distance. Ordinary movement can afford that myopia because a walk of thirty feet
  // cannot outrun the error; a jump of five hundred can. Landing forty feet from a Behir
  // reads as perfectly safe right up to the moment it steps five feet and swallows you.
  const netAt = (d: number): number =>
    evaluator.bestRoutineEvAtDistance(attacker, defender, d, true)
    - evaluator.bestRoutineEvAtDistance(defender, attacker, closestFoeReach(defender, foeState, d, 0), false) * 0.7 * threatFactor(defender, foeState);
  // The alternative to jumping is not standing still — it is the separation the fight arrives
  // at anyway, once this creature has moved and the foe has closed on its own turn. Measuring
  // against the current square instead priced in range the creature was going to lose for
  // free, and talked ranged casters into spending an action to reach, on round one, a range
  // the foe was about to hand them on round two. Those free shots while an opponent walks in
  // are most of what being a kiter is worth: one such caster gave up 2.4 points of
  // win rate buying the engagement early.
  const dash = Math.max(0, distance - movementSpeed(attacker, selfState) * 2);
  const inevitable = Math.max(0, dash - nextTurnSpeed(defender, foeState));
  // A Bonus Action jump leaves the action for the routine it lands on, which a Dash does not: its alternative is
  // where this turn's walk ends, not where two would. A Marilith 65 feet from an Archmage Dashed with its Teleport
  // ready, and the Archmage flew off before it swung.
  const walk = Math.max(0, distance - movementSpeed(attacker, selfState));
  const baseline = allowRetreat ? Math.max(netAt(distance), netAt(walk)) : Math.max(netAt(distance), netAt(dash), netAt(inevitable));
  let best = 0;
  let bestRetreat = 0;
  for (const candidate of teleportCandidates(attacker, defender, distance, spec.distance)) {
    // Only closing earns an *action*. Retreating is the movement AI's call, and valuing it here
    // let a creature buy distance with an action it should have spent fighting.
    if (candidate >= distance) {
      // A bonus action is not that trade. It costs nothing the creature was going to use, so the
      // step out of melee that Misty Step exists for is worth taking on its own merits.
      //
      // Priced on offence alone, deliberately: `netAt` subtracts the foe's threat, and counting
      // that here is the double-count the note below warns about — it reads "you are safer over
      // there" as a reason to go, which is how a high-level caster talked itself out of
      // a greatsword that hits twice for 2d6+7 plus 5d6 and into casting a force-hand spell from range.
      // What a retreat legitimately buys is what it *unlocks* — a ranged attacker shedding the
      // point-blank penalty — plus the free swing it denies by not walking out. Anything with a
      // better weapon where it stands sees no gain and stays.
      if (allowRetreat && candidate > distance) {
        const unlocked = evaluator.bestRoutineEvAtDistance(attacker, defender, candidate, true)
          - evaluator.bestRoutineEvAtDistance(attacker, defender, distance, true);
        if (unlocked > 0) {
          bestRetreat = Math.max(bestRetreat, unlocked + avoidedOpportunityAttack(attacker, defender, selfState, foeState, distance, candidate, evaluator));
        }
      }
      continue;
    }
    best = Math.max(best, netAt(candidate) - baseline);
  }
  // Breaking free is the dominant use. A held creature spends its entire action on an escape
  // roll it may well fail, so a certain release is worth a round of its own output.
  // Not when the jump costs the action and every square it would land on to fight from is one the holder walks to and
  // holds it at again: a Nalfeshnee (Rend, reach 10) jumped 5 feet out of a Remorhaz's Bite four turns running, was
  // bitten and Grappled again each time, and never swung. A jump to a square it can act from beyond the holder's
  // walk keeps its price (a Spirit Naga's 60 feet).
  if (held && !allowRetreat) {
    const holds = new Set(selfState.conditions.filter(teleportFreesHold).map((c) => c.name));
    const landings = teleportCandidates(attacker, defender, distance, spec.distance).filter((d) => evaluator.bestRoutineEvAtDistance(attacker, defender, d, true) > 0);
    if (landings.length && landings.every((d) => foeCanReapplyHold(defender, foeState, holds, closestFoeReach(defender, foeState, d, 0)))) return Math.max(0, best) * 0.5;
  }
  if (held) return Math.max(best, 0) + Math.max(threatHere, hereEv);
  // Only what the jump *unlocks* counts, never the threat it walks away from. A pure teleport
  // compiles as a routine of its own, so whatever is scored here competes head-to-head with
  // the creature's attack routine — and pricing in avoided damage made retreat beat attacking
  // for anything fragile enough to fear its opponent. One creature spent every round of every
  // fight teleporting away from a foe it was supposed to be fighting. Threat is the movement AI's concern and is already subtracted from
  // every candidate position there; counting it again here double-counts it.
  //
  // Halving what remains means a jump is taken only when the position it buys is worth more
  // than three times what the creature can already do from where it stands, which is the
  // margin that separates "this unlocks my real attack" from "this is a marginal shuffle".
  // The retreat term skips that discount: it exists to model competition for the action, and a
  // bonus action has no competition worth speaking of.
  return Math.max(Math.max(0, best) * 0.5, bestRetreat);
}

/**
 * What a creature saves by teleporting out instead of walking out. Leaving a foe's reach hands it
 * a free swing; a jump does not. This is the concrete, immediate edge a bonus-action teleport has
 * over ordinary movement, and without it the engine walked out and took the hit every time.
 */
function avoidedOpportunityAttack(
  attacker: CombatStatblock,
  defender: CombatStatblock,
  selfState: FighterState,
  foeState: FighterState,
  from: number,
  to: number,
  evaluator: PairEvaluator,
): number {
  if (!movementProvokeGuard(attacker, selfState, defender, foeState, from)) return 0;
  return cachedBestOaOption(evaluator, defender, attacker, from, to)?.ev ?? 0;
}

/** Separations reachable by a jump of `range` feet, restricted to the ones that can matter. */
function teleportCandidates(attacker: CombatStatblock, defender: CombatStatblock, current: number, range: number): number[] {
  const values = new Set<number>([Math.max(0, current - range), current + range]);
  for (const option of attacker.options) for (const landmark of actionRangeLandmarks(option.action)) values.add(landmark);
  for (const option of defender.options) for (const landmark of actionRangeLandmarks(option.action)) values.add(landmark + 5);
  return [...values]
    .filter((v) => Number.isFinite(v) && v >= 0 && Math.abs(v - current) <= range);
}

/** In-fight EV: range/prereq-gated, instant-death actions held until they can trigger, and
 *  damage-type-gated regeneration understood (only suppressing damage can actually kill it). */
/**
 * How much of an action's cached price a Legendary Resistance takes away this turn.
 *
 * The pool is state — it depletes — so this cannot live in the memoized evaluator, whose keys are
 * only (action, direction, distance). It is the same post-cache rescale the suppressible defences
 * and the already-held riders use, for the same reason.
 *
 * The engine spends greedily, and each of its three gates is mirrored here rather than restated:
 * a save action is resisted when it `wouldHurt` (`resolveAction`), a rider behind its own save is
 * resisted when the condition itself incapacitates (`applyRiders`), and an `extraSave` burst is
 * resisted when any of its riders do (`resolveSaveBurst`). Nothing else spends one, so nothing
 * else is discounted: a colossus's 4d8 burning against an ancient dragon with four of these is
 * a rider the dragon simply removes, and the chooser could not see that at all.
 *
 * What it does *not* price is the pool draining. Spending one is worth something to the attacker
 * and the turn after it is spent this term is smaller; the engine re-prices every turn, so the
 * depletion arrives on its own, but no action is credited for causing it and none is preferred
 * for being the cheap way to burn one.
 */
function legendaryResistedEv(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, evaluator: PairEvaluator): number {
  if (action.kind === "random") {
    return action.branches.reduce((sum, branch) => sum + legendaryResistedEv(branch, attacker, defender, foeState, evaluator), 0)
      / Math.max(1, action.branches.length);
  }
  const component = evaluator.legendaryResistanceComponent(action, attacker, defender);
  const slayReaches = (average: number) => foeState.hp > 0 && average > 0 && foeState.hp <= average;
  const wouldHurt = component.alwaysHurt
    || (component.instantDeathHpThreshold !== undefined && foeState.hp <= component.instantDeathHpThreshold)
    || (component.slayAverage !== undefined && slayReaches(component.slayAverage));
  // A save-margin save: a tier the 15% test does not count is resisted when its slay packet reaches current HP.
  const slayTiers = (component.slayTiers ?? []).reduce((sum, tier) => sum + (slayReaches(tier.average) ? Math.max(0, tier.resisted) : 0), 0);
  return (wouldHurt ? component.resisted : 0) + slayTiers;
}

const hasTargetHpGate = (clause: DamageClause): boolean =>
  !!(clause.requiresTargetHurt || clause.requiresTargetUnhurt || clause.requiresTargetBloodied || clause.requiresTargetNotBloodied);
/** Per action: `null` when no clause carries a target-Hit-Points gate, else the settled copies by state (hurt, Bloodied). */
const settledHpGateActions = new WeakMap<CombatAction, (CombatAction | undefined)[] | null>();

/**
 * The action as it would be dealt to the foe at its current Hit Points: the clauses
 * whose target-Hit-Points gate (`requiresTargetHurt`, `requiresTargetUnhurt`, `requiresTargetBloodied`,
 * `requiresTargetNotBloodied`) holds, with that gate taken off, and the others left out. `undefined` when the action
 * carries no such gate, or the foe is unhurt (the static price is already the full-health one). The copy is cached, so
 * the memoized evaluator sees one object per action and state.
 */
function settleTargetHpGates(action: CombatAction, foeState: FighterState): CombatAction | undefined {
  if (action.kind !== "attack" && action.kind !== "save" && action.kind !== "autohit") return undefined;
  let copies = settledHpGateActions.get(action);
  if (copies === undefined) {
    copies = action.damage.some(hasTargetHpGate) ? [] : null;
    settledHpGateActions.set(action, copies);
  }
  if (!copies) return undefined;
  const hurt = foeState.hp < foeState.maxHp;
  if (!hurt) return undefined;
  const bloodied = foeState.hp <= foeState.maxHp / 2;
  const key = bloodied ? 1 : 0;
  let copy = copies[key];
  if (!copy) {
    const damage = action.damage
      .filter((clause) => !clause.requiresTargetUnhurt && !(clause.requiresTargetBloodied && !bloodied) && !(clause.requiresTargetNotBloodied && bloodied))
      .map((clause) => {
        if (!hasTargetHpGate(clause)) return clause;
        const { requiresTargetHurt, requiresTargetUnhurt, requiresTargetBloodied, requiresTargetNotBloodied, ...open } = clause;
        return open;
      });
    copy = { ...action, damage };
    copies[key] = copy;
  }
  return copy;
}

/**
 * The ongoing spells Dispel Magic can end on a creature: the copies a spell put there that its caster (`caster`) did not
 * cast. The caster does not dispel its own, which are on the foe (its holds) or on itself (its buffs).
 */
function dispellable(state: FighterState, caster: 0 | 1): ConditionState[] {
  return state.conditions.filter((c) => c.spellLevel !== undefined && c.source !== caster);
}

/** The odds Dispel Magic ends a spell: always at level 3 or lower, else a check of d20 plus the modifier against 10 plus its level. */
function dispelChance(spellLevel: number, mod: number): number {
  return spellLevel <= 3 ? 1 : Math.max(0, Math.min(1, (21 - (10 + spellLevel - mod)) / 20));
}

/**
 * What ending one spell on a creature is worth to the caster of Dispel Magic. On the foe: the buff it holds, priced as
 * the cast of that buff is (an unseen state, Mirror Image, Sanctuary, Bless, Dispel Evil and Good), and nothing for a
 * spell not priced (Fly, True Seeing). On the caster itself: a condition that costs it its attack rolls, over the
 * turns a condition is priced for. A hold that takes its turn away is not on the list: it cannot cast.
 */
function dispelWorth(c: ConditionState, onFoe: boolean, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, selfState: FighterState,
  distance: number, evaluator: PairEvaluator): number {
  // What a spell hampers is the attack the caster makes once close: from the reach of its own attacks, as an Invisibility
  // cast is priced, and not from the distance it stands at now.
  const own = evaluator.bestRoutineEvAtDistance(attacker, defender, Math.min(distance, meleeReach(attacker)), false);
  const foe = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * threatFactor(defender, foeState);
  if (!onFoe) {
    if (c.name === "charmed") return own * CONDITION_HORIZON_TURNS;
    // Slow (one attack only, an action or a Bonus Action, -2 AC, half Speed) is priced as the other hampering conditions.
    // So are the Fear spell's Frightened and Phantasmal Killer's Disadvantage on attack rolls (`afflicted`).
    if (["blinded", "poisoned", "frightened", "restrained", "slowed", "fearSpell", "afflicted"].includes(c.name)) return own * (1 - DISADVANTAGE_EV) * CONDITION_HORIZON_TURNS;
    return c.name === "outlined" && outlineAdvantage(c) ? foe * (ADVANTAGE_EV - 1) * CONDITION_HORIZON_TURNS : 0;
  }
  if (c.name === "invisible") {
    if (canSee(attacker, foeState, selfState, distance)) return 0;
    return (c.breaksOnAttackOrSpell === false ? CONDITION_HORIZON_TURNS : 1) * (own * (1 - DISADVANTAGE_EV) + foe * (ADVANTAGE_EV - 1));
  }
  if (c.name === "mirrorImage") {
    return hasCondition(selfState, "blinded") || seesInvisible(eyes(attacker, selfState), false, distance) ? 0 : own * 2 * ((c.images ?? 0) / 3);
  }
  if (c.name === "sanctuary") {
    return wardedEv(attacker, defender, selfState, distance, evaluator)
      * saveFailChance(c.wardDc ?? 0, attacker.saves.wis ?? attacker.abilityMods.wis, saveAdvantage(attacker, true, []));
  }
  if (c.name === "blessed") return foe * 0.125 * CONDITION_HORIZON_TURNS;
  const against = c.rollEffects?.find((effect) => effect.roll === "attackAgainst" && effect.mode === "disadvantage");
  if (against && (!against.attackerTypes || against.attackerTypes.includes(attacker.creatureType))) return own * (1 - DISADVANTAGE_EV) * CONDITION_HORIZON_TURNS;
  return 0;
}

/** The conditions a spell can put on the caster of Dispel Magic that cost it something worth a turn to end. */
const DISPELLED_FROM_SELF = new Set(["charmed", "blinded", "poisoned", "frightened", "restrained", "outlined", "slowed", "fearSpell", "afflicted"]);

/** An outline that gives attackers nothing (Mind Spike's: it only denies the Invisible condition) hampers no one. */
function outlineAdvantage(c: ConditionState): boolean {
  return !!c.rollEffects?.some((effect) => effect.roll === "attackAgainst" && effect.mode === "advantage");
}

function hampers(c: ConditionState): boolean {
  return DISPELLED_FROM_SELF.has(c.name) && (c.name !== "outlined" || outlineAdvantage(c));
}

/** Dispel Magic is cast on itself when a spell of the foe's hampers it, else on the foe. */
function dispelsOnFoe(selfState: FighterState, source: 0 | 1): boolean {
  return !dispellable(selfState, source).some(hampers);
}

/** Dispel Magic's price: each spell on its target at the odds it ends, at what ending it is worth. */
function dispelEv(action: { mod: number; range: number }, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, selfState: FighterState,
  source: 0 | 1, distance: number, evaluator: PairEvaluator): number {
  if (distance > action.range) return 0;
  const onFoe = dispelsOnFoe(selfState, source);
  return dispellable(onFoe ? foeState : selfState, source)
    .reduce((sum, c) => sum + dispelChance(c.spellLevel!, action.mod) * dispelWorth(c, onFoe, attacker, defender, foeState, selfState, distance, evaluator), 0);
}

/**
 * The riders of this action that move the foe or put it on the ground to no effect: the foe's next turn covers the
 * push, and the stand ("costs an amount of movement equal to half your Speed"), and still brings it to where its best
 * routine is. A push is worth the turn it costs the foe and nothing else; so is a knock-down from beyond 5 feet, where
 * attack rolls against a Prone creature have Disadvantage. A Young Bronze Dragon gave up a Rend every round to push a
 * Vrock that flew straight back, and an Earth Elemental stepped out through an Opportunity Attack to knock one down
 * with a rock. The room's wall bounds the push. A push that breaks the foe's own hold on the pusher keeps its worth.
 */
function walkedOffDisplacement(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, selfState: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator): ((rider: Rider) => boolean) | undefined {
  return displacement(action, attacker, defender, foeState, selfState, source, distance, evaluator).walkedOff;
}

/**
 * `walkedOffDisplacement`, and what the displacement does where the foe does not walk it off: `lost`, the routine the
 * foe gives up for the one it can still reach, or `slows`, a knock-down from beyond 5 feet on a foe still on its way in.
 */
function displacement(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, selfState: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator): { walkedOff?: (rider: Rider) => boolean; slows?: boolean; lost?: number } {
  const walkedOff = ((): ((rider: Rider) => boolean) | "slows" | number | undefined => {
  if (!("riders" in action) || !action.riders?.length) return undefined;
  const push = Math.max(0, ...action.riders.map((rider) => rider.push ?? 0));
  const knocksDown = action.riders.some((rider) => rider.condition === "prone") && !defender.conditionImmune.includes("prone") && !isProne(foeState);
  if (!push && !(knocksDown && distance > 5)) return undefined;
  const foe = source === 0 ? 1 : 0;
  if (selfState.conditions.some((c) => c.source === foe && (c.name === "grappled" || c.name === "restrained" || c.name === "swallowed"))) return undefined;
  // A jump lands in the target's space, and the push starts from there, not from where the jump began.
  if (action.kind === "save" && action.jumpsToTarget) distance = Math.min(distance, groundFloor(attacker, selfState, selfState.height, defender, foeState));
  const after = Math.min(selfState.place?.engagement.maxDistance ?? Infinity, distance + push);
  const speed = currentSpeed(defender, foeState);
  const left = knocksDown ? Math.max(0, speed - standCost(defender, foeState)) : speed;
  // Height a walker cannot climb is not closed by its Speed, pushed or not.
  const gap = verticalGap(attacker, selfState.height, defender, foeState.height);
  const near = Math.max(Math.min(distance, 5), canFly(defender, foeState) ? 0 : gap);
  const undisturbed = evaluator.bestRoutineEvAtDistance(defender, attacker, Math.max(near, distance - speed), false);
  const returning = evaluator.bestRoutineEvAtDistance(defender, attacker, Math.max(near, after - left), false);
  // A foe with nothing to do from where its turn would have ended is slowed on its way in, which is not priced here.
  if (undisturbed <= 0) {
    const closeUp = evaluator.bestRoutineEvAtDistance(defender, attacker, near, false);
    // A foe with nothing to do to the pusher even from beside it loses nothing by being moved. A Bronze Dragon Wyrmling
    // pushed a Will-o'-Wisp (Shock is Lightning, the dragon is immune) across a 30-foot room for 100 rounds.
    if (closeUp <= 0 && push) return (rider) => !!rider.push;
    return knocksDown && distance > 5 && closeUp > 0 ? "slows" : undefined;
  }
  if (returning < undisturbed) {
    // Each turn it is short of that routine, for as long as the walk back takes.
    let lost = undisturbed - returning;
    for (let turn = 1; turn < CONDITION_HORIZON_TURNS; turn++) {
      const next = evaluator.bestRoutineEvAtDistance(defender, attacker, Math.max(near, after - left - turn * speed), false);
      if (next >= undisturbed) break;
      lost += undisturbed - next;
    }
    return lost;
  }
  // The stand takes half the movement a foe would have fled with, and a flier's climb with it: against a foe that can
  // fight from a full move away the knock-down keeps its worth. A Dragon Turtle's Tail kept an Efreeti within a Dash;
  // without it the Efreeti climbed out of reach for good.
  const melee = evaluator.bestRoutineEvAtDistance(defender, attacker, after + speed, false) <= 0;
  return (rider) => !!rider.push || (melee && rider.condition === "prone" && distance > 5);
  })();
  return walkedOff === "slows" ? { slows: true } : typeof walkedOff === "number" ? { lost: walkedOff } : { walkedOff };
}

/**
 * `repeatFactor` for a part of `count` swings where `dynamicEv` has changed what the riders are worth: a push or
 * knock-down the foe walks back from is taken out of one swing's price, and `displacedEv` is added to it. The repeat discount (riders apply once, damage multiplies) is taken on the riders as priced there,
 * not on the listed share. A Fire Giant's two Hammer Throws at a fire-immune dragon priced below sword and hammer: the
 * push was cancelled once and then discounted again.
 */
function repeatFactorWalkedOff(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, selfState: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator, count: number, runUp?: number): number {
  const factor = evaluator.repeatFactor(action, attacker, defender, count, DEFENCES_ACTIVE, runUp);
  if (count <= 1 || !("riders" in action) || !action.riders?.some((rider) => rider.push || rider.condition === "prone")) return factor;
  const displaced = displacement(action, attacker, defender, foeState, selfState, source, distance, evaluator);
  const change = displacedEv(action, attacker, defender, foeState, distance, displaced) - (displaced.walkedOff ? actionRiderEv(action, defender, displaced.walkedOff, undefined, attacker) : 0);
  if (change === 0) return factor;
  const single = evaluator.actionEv(action, attacker, defender);
  const riders = evaluator.actionRiderEv(action, attacker, defender);
  if (riders <= 0 || single + change <= 0) return count;
  // `factor` is `count + min(1, riders / single) * (applications - count)`: the same, over both as priced this turn.
  const share = Math.min(1, riders / single);
  return count + (factor - count) / share * Math.min(1, Math.max(0, riders + change) / (single + change));
}

/**
 * What a grant of temporary Hit Points adds to the pool already held. Against a foe whose every damaging option lowers
 * the Hit Point maximum by the damage it deals, no more than the Hit Points the holder is short of its maximum: the
 * maximum falls by the whole hit, absorbed or not, and the Hit Points are cut down to it. A Unicorn at its maximum
 * took Shimmering Shield four times against a Wraith's Life Drain and ended each drain where it would have without.
 */
function tempHpGain(avg: number, selfState: FighterState, self: CombatStatblock, foe: CombatStatblock): number {
  const gain = Math.max(0, avg - selfState.tempHp);
  const damaging = foe.options.filter((option) => "damage" in option.action && expectedDamage(option.action.damage, self, !!option.action.magical) > 0);
  const drainsAll = damaging.length > 0 && damaging.every((option) => "damage" in option.action
    && option.action.damage.every((clause) => clause.reducesMaxHp && !clause.reducesMaxHpHalf && !clause.reducesMaxHpSave));
  return drainsAll ? Math.min(gain, Math.max(0, selfState.maxHp - selfState.hp)) : gain;
}

/** What a knock-down is worth on a flier in the air, or from beyond 5 feet, over its price beside the target: the hampering share, less Advantage on the swings behind it. */
function aloftProneEv(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock): number {
  const knocksDown = (rider: Rider) => rider.condition === "prone";
  return Math.max(0, actionRiderEv(action, defender, knocksDown) - actionRiderEv(action, defender, knocksDown, undefined, attacker));
}

/**
 * What this turn's position adds to the listed price of an action's push and knock-down, where the foe does not walk
 * them off. Prone is listed as Advantage on the swings behind it, which is what it is worth beside the target. A flier
 * knocked Prone in the air falls ("you fall if you have the Incapacitated or Prone condition", p182), and from beyond 5
 * feet attack rolls against a Prone creature have Disadvantage and the knock-down is worth the movement it costs a foe
 * on its way in: there it keeps the hampering share. A Djinni kept a Young Silver Dragon standing up and Dashing for a
 * whole fight with Storm Bolts from 95 feet. Where the push or the stand leaves the foe a lesser routine, both are
 * worth no more than what it loses on its way back (in proportion to the two creatures' Hit Points): an Adult
 * Bronze Dragon gave up a Rend to push an Adult Black Dragon 60 feet, to where it cast Vitriolic Sphere instead.
 */
function displacedEv(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, distance: number, displaced: { slows?: boolean; lost?: number }): number {
  if (!("riders" in action) || !action.riders?.length) return 0;
  const far = action.riders.some((rider) => rider.condition === "prone") && !isProne(foeState) ? aloftProneEv(action, attacker, defender) : 0;
  if (displaced.lost !== undefined) {
    const farKnock = distance > 5 ? far : 0;
    const listed = actionRiderEv(action, defender, (rider) => !!rider.push || (rider.condition === "prone" && distance > 5), undefined, attacker);
    const exchange = Math.min(4, Math.max(0.25, defender.hpAvg / Math.max(1, attacker.hpAvg)));
    return listed > 0 ? Math.min(listed + farKnock, riderLandChance(action, defender) * displaced.lost * exchange) - listed : 0;
  }
  return displaced.slows || foeState.height > 0 && canFly(defender, foeState) && !canHover(defender, foeState) ? far : 0;
}

function dynamicEv(action: CombatAction, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, selfState: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator, timing: Timing = "action", runUp?: number): number {
  if (spellBlocked(action, defender)) return 0;
  if ("riders" in action && action.riders?.some(r => r.targetHpMax !== undefined || r.requiresTargetHpAbove !== undefined)) {
    // A daily option whose greater effect waits for the target to fall to a Hit Point mark is kept for it: "If the
    // target has 150 Hit Points or fewer, it has the Stunned condition. Otherwise, its Speed is 0 until the start of
    // your next turn" (Power Word Stun, SRD 5.2.1, p154). A foe that is to die passes the mark first, so the lesser
    // effect is worth nothing while it is above it. A Glabrezu spent its one Stun for a round of Speed 0 on a Storm
    // Giant at 205 Hit Points.
    if (action.riders.some(r => r.targetHpMax !== undefined && foeState.hp > r.targetHpMax)
      && !action.riders.some(r => r.targetHpMax === undefined && r.requiresTargetHpAbove === undefined)
      && !("damage" in action && action.damage?.length)
      && attacker.options.find(o => o.action === action)?.uses.t === "perDay") return 0;
    const riders = action.riders.filter(r => (r.targetHpMax === undefined || foeState.hp <= r.targetHpMax)
      && (r.requiresTargetHpAbove === undefined || foeState.hp > r.requiresTargetHpAbove))
      .map(r => ({ ...r, targetHpMax: undefined, requiresTargetHpAbove: undefined }));
    return dynamicEv({ ...action, riders }, attacker, defender, foeState, selfState, source, distance, evaluator, timing, runUp);
  }
  // Casting something else with Concentration drops what is already running. When what is
  // already running is the reason the opponent cannot act, there is no second spell worth that.
  if ("concentration" in action && action.concentration && selfState.concentrating
    && foeState.conditions.some((c) => c.concentrationSource === source && INCAPACITATING.has(c.name))) {
    return 0;
  }
  // Nor is a Restrained foe (Speed 0, its attacks at Disadvantage, attacks against it at Advantage) let go for a spell
  // that does not take it out of the fight. A Drider with an Ettin in its Web at 10 feet cast Faerie Fire for an
  // Advantage it already had; the Ettin walked up and knocked it Prone.
  if ("concentration" in action && action.concentration && selfState.concentrating
    && foeState.conditions.some((c) => c.concentrationSource === source && c.name === "restrained")
    && !("riders" in action && action.riders?.some((rider) => INCAPACITATING.has(rider.condition)))) {
    return 0;
  }
  // Nor is an Emanation it is keeping up given away for another Concentration spell.
  if ("concentration" in action && action.concentration && selfState.concentrating && selfState.conditions.some((c) => c.emanation)) return 0;
  // Nor is a buff of its own given away free: the second spell is worth what it adds over the first, which is priced
  // as a defensive buff is (`0.35` of the foe's routine), and nothing if the first is what holds the caster in the air.
  // A Unicorn dropped Dispel Evil and Good, cast the turn before against a Fiend, for an Entangle.
  if ("concentration" in action && action.concentration && selfState.concentrating
    && selfState.conditions.some((c) => c.concentrationSource === source && c.name !== "sustaining" && c.name !== "zoneHeld")) {
    if (selfState.height > 0 && !attacker.flySpeed) return 0;
    // Nor on the ground, while the spell is the caster's only way up to a foe that flies and shoots at will from beyond
    // its reach. A Glabrezu that had landed beside an Oni cast Confusion over its Fly; the Oni rose 30 feet and shot it
    // for 35 rounds.
    // A flier that must come down to fight (a dragon between breaths) is not one the spell is needed for.
    if (!attacker.flySpeed && canFly(defender, foeState) && selfState.conditions.some((c) => c.concentrationSource === source && c.name === "flying")
      && defender.options.some((option) => option.timing === "action" && option.uses.t === "atWill" && actionRange(option.action) > meleeReach(attacker)
        && evaluator.expectedActionDamage(option.action, defender, attacker) > 0)) return 0;
    const held = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * 0.35 * threatFactor(defender, foeState);
    return Math.max(0, dynamicEv({ ...action, concentration: undefined }, attacker, defender, foeState, selfState, source, distance, evaluator, timing, runUp) - held);
  }
  // An Emanation (Spirit Guardians) is worth its save once for each turn a condition is priced over; nothing while one is up.
  if (action.kind === "save" && action.emanation) {
    return selfState.conditions.some((c) => c.emanation) ? 0
      : dynamicEv({ ...action, emanation: undefined }, attacker, defender, foeState, selfState, source, distance, evaluator, timing, runUp) * CONDITION_HORIZON_TURNS;
  }
  // A swallowed creature "has Total Cover against attacks and other effects outside" its swallower: the swallow trades
  // every later routine against that creature for the digestion each turn, and for the Disadvantage of Blinded and
  // Restrained where the hold did not already give it. Where the routine is worth more, the creature keeps biting what
  // it holds. A Behir swallowed an Efreeti it was hitting at Advantage for 58 a turn, dealt 6d6 a turn after, and died.
  if ((action.kind === "save" || action.kind === "autohit") && action.riders?.some((rider) => rider.condition === "swallowed")) {
    const rider = action.riders.find((r) => r.condition === "swallowed")!;
    const digestion = [...(rider.startTurnDamage ?? []), ...(rider.endTurnDamage ?? []), ...(rider.delayedDamage?.damage ?? [])]
      .reduce((sum, clause) => sum + (clause.dice.n * (clause.dice.d + 1) / 2 + clause.dice.mod) * damageClauseMultiplier(clause, defender, false), 0);
    const hampered = foeState.conditions.some((c) => c.source === source && (c.name === "restrained" || c.name === "blinded"));
    const shelter = hampered ? 0 : evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * (1 - DISADVANTAGE_EV);
    const swallows = (other: CombatAction): boolean => "riders" in other && !!other.riders?.some((r) => r.condition === "swallowed");
    const routine = Math.max(0, ...attacker.routines.filter((r) => !r.parts.some((part) => swallows(attacker.options[part.optionIdx].action)))
      .map((r) => rawRoutineEvAtDistance(r, attacker, defender, distance, false))) * (hampered ? ADVANTAGE_EV : 1);
    // Not against a regenerator the digestion's damage type is what finishes (a Troll in a Behir: Acid).
    const finisher = !!defender.regeneration?.deathRule && [...(rider.startTurnDamage ?? []), ...(rider.endTurnDamage ?? []), ...(rider.delayedDamage?.damage ?? [])]
      .some((clause) => defender.regeneration!.suppressedBy.includes(clause.type));
    if (!finisher && digestion + shelter < routine && digestion < foeState.hp) return 0;
    // A swallow with no save whose least digestion covers what the foe has left kills it for certain, where a Bite only
    // might: a Giant Frog (2d4 Acid) bit a Grappled Kobold Warrior on 2 Hit Points at +3 for three rounds and died.
    const least = [...(rider.startTurnDamage ?? []), ...(rider.endTurnDamage ?? []), ...(rider.delayedDamage?.damage ?? [])]
      .reduce((sum, clause) => sum + Math.floor((clause.dice.n + clause.dice.mod) * damageClauseMultiplier(clause, defender, false)), 0);
    if (action.kind === "autohit" && foeState.hp > 0 && least >= foeState.hp && !defender.regeneration) return defender.hpAvg * 50;
  }
  // Lifting and dropping a held creature is worth the fall's damage, to a creature that will fall: 1d6 for each 10 feet
  // from where it is let go.
  if (action.kind === "autohit" && action.liftAndDrop) {
    const engagement = selfState.place?.engagement;
    if (!engagement || canFly(defender, foeState) || canHover(defender, foeState)) return 0;
    const rise = liftRise(attacker, selfState, defender, foeState, source, engagement, action.liftAndDrop);
    const fall: DamageClause = { dice: { n: Math.min(20, Math.floor((foeState.height + rise) / 10)), d: 6, mod: 0 }, type: "bludgeoning" };
    if (rise <= 0) return 0;
    // The drop lets go of the hold. Where that hold Restrains, it gives up the Disadvantage on the foe's attacks and
    // the Advantage on the creature's own next turn, for whatever the foe can still do to a creature `rise` feet up
    // ("the roc flies up to half its Fly Speed ... and drops that creature"). A Roc dropped a Frost Giant its Talons
    // had just Restrained for 3d6, and the giant stood up and shot it twice on plain rolls.
    const restrains = foeState.conditions.some((c) => c.name === "restrained" && c.source === source && c.duration === "untilEscape");
    const held = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * DISADVANTAGE_EV;
    const loosed = evaluator.bestRoutineEvAtDistance(defender, attacker, Math.max(distance, rise), false);
    const own = evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false) * (1 - 1 / ADVANTAGE_EV);
    return Math.max(0, fall.dice.n * 3.5 * damageClauseMultiplier(fall, defender, false) - (restrains ? loosed - held + own : 0));
  }
  // Ending a foe's Concentration is given a token worth on top of what the action's riders are worth: enough to choose it
  // over nothing, not over an attack.
  if (action.kind === "autohit" && action.endsTargetConcentration) {
    return dynamicEv({ ...action, endsTargetConcentration: undefined }, attacker, defender, foeState, selfState, source, distance, evaluator, timing, runUp)
      + (foeState.concentrating ? 1 : 0);
  }
  if (action.kind === "autohit" && action.pull) {
    if (!actionRequirementMet(action, foeState, source) || distance <= 5) return 0;
    const to = Math.max(5, distance - action.pull);
    return Math.max(1, evaluator.bestRoutineEvAtDistance(attacker, defender, to, false)
      - evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false));
  }
  if (action.kind === "selfbuff") {
    if (action.movement) {
      if (action.movement.requiresSight && !canSee(attacker, foeState, selfState, distance)) return 0;
      if (action.movement.requiresSense && !canSense(attacker, foeState, selfState, distance)) return 0;
      if (action.movement.distance === 0 && action.movement.noProvoke) {
        const ranged = attacker.options.some(o => o.action.kind === "attack" && o.action.ranged && !o.action.melee);
        return ranged && distance <= meleeReach(defender) ? avoidedOpportunityAttack(attacker, defender, selfState, foeState, distance, distance + currentSpeed(attacker, selfState), evaluator) + 1 : 0;
      }
      if (hasCondition(selfState, action.condition)) return 0;
      const haste = action.condition === "hastened" ? evaluator.bestRoutineEvAtDistance(attacker, defender, Math.min(distance, meleeReach(attacker)), false) / 3 : 0;
      const m = action.movement;
      if (m.mode === "leap" && movementSpeed(attacker, selfState) < (m.cost ?? 0)) return 0;
      const gain = m.mode === "leap" ? (m.distance ?? 0) - (m.cost ?? 0) : currentSpeed(attacker, selfState) * (m.fraction ?? 1);
      // Movement along the ground closes none of the height to a foe aloft (a leap upward is `leapUpPlan`'s).
      const aloft = canFly(attacker, selfState) ? 0 : verticalGap(attacker, selfState.height, defender, foeState.height);
      const to = Math.max(5, aloft, distance - Math.max(0, gain) - movementSpeed(attacker, selfState));
      return haste + Math.max(0, evaluator.bestRoutineEvAtDistance(attacker, defender, to, false)
        - evaluator.bestRoutineEvAtDistance(attacker, defender, Math.max(5, aloft, distance - movementSpeed(attacker, selfState)), false));
    }
    if (action.selfTempHp?.dice) return tempHpGain(avgDice(action.selfTempHp.dice), selfState, attacker, defender)
      + (hasCondition(selfState, action.condition) ? 0 : evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * 0.1);
    // Bless: a d4 on a d20 turns about one miss in eight into a hit, for as many turns as a condition is priced over.
    if (action.rollEffects?.some((effect) => effect.mode === "bonus")) {
      return hasCondition(selfState, action.condition) ? 0
        : evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false) * 0.125 * CONDITION_HORIZON_TURNS;
    }
    // Dispel Evil and Good: Disadvantage on the attack rolls of the listed creature types, and nothing against another.
    const against = action.rollEffects?.find((effect) => effect.roll === "attackAgainst" && effect.mode === "disadvantage");
    if (against) {
      if (hasCondition(selfState, action.condition) || (against.attackerTypes && !against.attackerTypes.includes(defender.creatureType))) return 0;
      // What the ward takes off a turn of the foe's: its best routine now, less the best it has left once every attack
      // roll in it is made with Disadvantage. A save or an automatic hit is untouched (Magic Missile, Fireball), and a
      // foe with one as good as its attacks loses nothing. Under Concentration each later turn counts at the odds the
      // spell is still up, as the defensive buff below is priced. A Unicorn opened with its one casting against a Night
      // Hag and lost it to the Magic Missile that followed.
      const reach = closestFoeReach(defender, foeState, distance, 0);
      let open = 0, warded = 0;
      for (const routine of defender.routines) {
        let full = 0, hampered = 0;
        for (const part of routine.parts) {
          const option = defender.options[part.optionIdx];
          if (!option || !usable(foeState, part.optionIdx, option)) continue;
          const ev = part.count * evaluator.actionEvAtDistance(option.action, defender, attacker, reach);
          full += ev;
          hampered += option.action.kind === "attack" ? ev * DISADVANTAGE_EV : ev;
        }
        open = Math.max(open, full);
        warded = Math.max(warded, hampered);
      }
      const broken = action.concentration ? 0.5 * saveFailChance(10, attacker.saves.con ?? attacker.abilityMods.con) : 0;
      let covered = 0;
      for (let turn = 0; turn < CONDITION_HORIZON_TURNS; turn++) covered += (1 - broken) ** turn;
      return Math.max(0, open - warded) * covered * threatFactor(defender, foeState);
    }
    // Sanctuary: the foe's next turn of attack rolls and aimed spells, at the odds it fails the Wisdom save. One turn,
    // since the caster's own next attack ends the ward. Nothing while warded, or against a foe whose best is an area.
    if (action.wardDc !== undefined) {
      return hasCondition(selfState, action.condition) ? 0
        : wardedEv(defender, attacker, foeState, distance, evaluator) * saveFailChance(action.wardDc, defender.saves.wis ?? defender.abilityMods.wis, saveAdvantage(defender, true, [])) * threatFactor(defender, foeState);
    }
    // True Seeing: nothing unless the foe is unseen now and the granted Truesight would reach it. Then the caster's
    // attack rolls lose their Disadvantage, the foe's lose their Advantage, and effects that need sight come back: one
    // turn of that against an unseen state the foe's own attack ends, otherwise as many as a condition is priced over.
    if (action.truesight) {
      const unseen = foeState.conditions.find((c) => c.name === "invisible");
      if (hasCondition(selfState, action.condition) || hasCondition(selfState, "blinded") || distance > action.truesight
        || canSee(attacker, foeState, selfState, distance)) return 0;
      const foeEv = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * threatFactor(defender, foeState);
      const ownEv = evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false);
      return (unseen?.breaksOnAttackOrSpell ? 1 : CONDITION_HORIZON_TURNS) * (foeEv * (1 - 1 / ADVANTAGE_EV) + ownEv * (1 / DISADVANTAGE_EV - 1));
    }
    // Mirror Image: three duplicates take most of the next three hits, priced as two turns of the foe's offence. Nothing
    // against a foe the spell does not affect (Blinded, or with Blindsight or Truesight in range).
    if (action.images) {
      return hasCondition(selfState, action.condition) || hasCondition(foeState, "blinded") || seesInvisible(eyes(defender, foeState), false, distance) ? 0
        : evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * 2 * threatFactor(defender, foeState);
    }
    // Invisibility: worthless against an exceptional sense in range, or if already active. Value it by the
    // incoming damage it blunts for a round (foe attacks at disadvantage) plus next-turn advantage. A foe with
    // no attack roll or sight-bound effect to use from where it stands loses nothing to the spell there and comes
    // closer to use one, so for that foe the range is read where it can stand on its own next turn: a dragon 40 feet
    // off with Blindsight 30 and only its breath in range closes and sees. A foe with such an option in range may stay
    // there, and the spell keeps its price.
    if (action.condition === "invisible") {
      const blinded = hasCondition(foeState, "blinded");
      // What being unseen hampers: attack rolls, and effects that need sight of their target. A breath does not care.
      const hampered = (candidate: CombatAction): boolean => candidate.kind === "random" ? candidate.branches.some(hampered)
        : candidate.kind === "attack" || ("requiresSight" in candidate && !!candidate.requiresSight);
      const mustClose = !defender.options.some((option, idx) => option.timing === "action" && usable(foeState, idx, option)
        && hampered(option.action) && actionInRange(option.action, distance));
      // Nor is it worth anything to a caster that must itself come inside that sense to do anything to the foe: its
      // longest attack or save reaches no farther than the foe's Blindsight or Truesight does (a rakshasa, reach 5 and
      // range 30, against a dragon with Blindsight 60).
      const ownRange = Math.max(0, ...attacker.options.filter((option) => option.timing === "action"
        && (option.action.kind === "attack" || option.action.kind === "save" || option.action.kind === "autohit" || option.action.kind === "random"))
        .map((option) => actionRange(option.action)));
      const foeEyes = eyes(defender, foeState);
      // Nor to a creature inside its foe: the swallower's attacks are not what hurts it there.
      if (hasCondition(selfState, "invisible") || hasCondition(selfState, "swallowed") || (action.darkness && defender.seesMagicalDarkness) || seesInvisible(foeEyes, blinded, distance)
        || seesInvisible(foeEyes, blinded, ownRange)
        || (mustClose && seesInvisible(foeEyes, blinded, closestFoeReach(defender, foeState, distance, 0)))) return 0;
    }
    // An unseen state its holder's own attacks do not end lasts: the foe's attack rolls at Disadvantage and the
    // holder's at Advantage, for as many whole turns as a condition is priced over, or as the fight has left once the
    // turn spent on it is gone.
    if (action.condition === "invisible" && action.breaksOnAttackOrSpell === false) {
      const foeEv = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * threatFactor(defender, foeState);
      const ownEv = evaluator.bestRoutineEvAtDistance(attacker, defender, Math.min(distance, meleeReach(attacker)), false);
      const turns = Math.min(CONDITION_HORIZON_TURNS, foeState.hp / Math.max(1, ownEv * ADVANTAGE_EV) - 1, selfState.hp / Math.max(1, foeEv * DISADVANTAGE_EV));
      // Under Concentration each later turn counts at the odds the DC 10 Constitution save has been made so far, at
      // about one hit taken a turn.
      const kept = action.concentration ? 1 - saveFailChance(10, attacker.saves.con ?? attacker.abilityMods.con) : 1;
      let worth = 0;
      for (let turn = 0; turn < Math.floor(Math.max(0, turns)); turn++) worth += kept ** turn;
      return worth * (foeEv * (1 - DISADVANTAGE_EV) + ownEv * (ADVANTAGE_EV - 1));
    }
    // Fly. To a creature whose foe is aloft where it cannot follow, it is worth the offence it gets back by closing.
    // Otherwise it is worth the offence the foe loses when its target rises as far as the spell and the ceiling allow
    // this turn, less the caster's own offence lost from up there, and nothing against a foe that flies (it follows).
    // Either way for no more turns than a condition is priced over or the foe lasts. If the foe can still deal damage
    // at that height, each later turn counts at the odds Concentration has held so far (DC 10 or half the damage of
    // one of the foe's turns), and the fall that follows a failed save is charged against it.
    if (action.fly) {
      const engagement = selfState.place?.engagement;
      if (!engagement || hasCondition(selfState, action.condition) || canFly(attacker, selfState)) return 0;
      // A Fly Speed is a Speed: one held at 0 (Grappled, Restrained) lifts nobody, and the spell is under Concentration
      // with the holder's attacks still coming.
      if (currentSpeed(attacker, selfState) <= 0) return 0;
      const ownNow = evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false);
      if (foeState.height > 0 && canFly(defender, foeState)) {
        // Less the farther off the foe is, down to nothing where two turns of flying would not reach it: the cast is
        // made from as close as the caster can get, not on the way out.
        const reach = meleeReach(attacker), within = 2 * action.fly.speed + reach;
        const ownClose = evaluator.bestRoutineEvAtDistance(attacker, defender, Math.min(distance, reach), false);
        return Math.max(0, ownClose - ownNow) * Math.min(CONDITION_HORIZON_TURNS, foeState.hp / Math.max(1, ownClose)) * Math.max(0, 1 - Math.max(0, distance - reach) / within);
      }
      if (canFly(defender, foeState)) return 0;
      const top = Math.min(selfState.height + action.fly.speed, skyRoof(engagement, defender));
      const gap = verticalGap(attacker, top, defender, foeState.height);
      const near = closestFoeReach(defender, foeState, distance, 0);
      const foeNear = evaluator.bestRoutineEvAtDistance(defender, attacker, near, false);
      const foeFar = evaluator.bestRoutineEvAtDistance(defender, attacker, Math.max(near, gap), false);
      const ownFar = evaluator.bestRoutineEvAtDistance(attacker, defender, Math.max(distance, gap), false);
      // What it gives up is its best from the ground, where it stands or closed to melee; and height it cannot attack
      // from is a stall, worth nothing.
      const ownGround = Math.max(ownNow, evaluator.bestRoutineEvAtDistance(attacker, defender, Math.min(distance, meleeReach(attacker)), false));
      const perTurn = (foeNear - foeFar) * threatFactor(defender, foeState) - Math.max(0, ownGround - ownFar);
      if (perTurn <= 0 || ownFar <= 0) return 0;
      const turns = Math.min(CONDITION_HORIZON_TURNS, foeState.hp / Math.max(1, ownFar));
      const kept = action.concentration && foeFar > 0
        ? 1 - saveFailChance(Math.max(10, Math.floor(foeFar / 2)), attacker.saves.con ?? attacker.abilityMods.con) : 1;
      let worth = 0;
      for (let turn = 0; turn < turns; turn++) worth += kept ** (turn + 1) * Math.min(1, turns - turn);
      const fall = (1 - kept) * Math.min(20, Math.floor(top / 10)) * 3.5;
      return Math.max(0, Math.min(selfState.hp, worth * perTurn) - fall);
    }
    if (action.condition === "aiming") {
      if (hasCondition(selfState, "aiming")) return 0;
      return evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false) * 0.3;
    }
    // A defensive buff is worth what it blunts, and a foe that cannot act is not swinging.
    // Under Concentration it blunts the foe's attacks only until one of them ends it: each attack before it is taken
    // to hit half the time and the DC 10 Constitution save to fail at its odds, so a foe with four attacks a turn has
    // on average the first three hampered, not all four. A Mage opened with Invisibility against an Archmage's four
    // Arcane Bursts, lost it to the first and never attacked.
    const swings = action.concentration ? Math.max(1, ...defender.routines.map((routine) => routine.parts.reduce(
      (n, part) => n + (defender.options[part.optionIdx]?.action.kind === "attack" ? part.count : 0), 0))) : 1;
    const broken = action.concentration ? 0.5 * saveFailChance(10, attacker.saves.con ?? attacker.abilityMods.con) : 0;
    let covered = 0;
    for (let swing = 0; swing < swings; swing++) covered += (1 - broken) ** swing;
    // Being unseen blunts nothing of an attack roll already at Disadvantage: the share of the foe's best routine from
    // here that such rolls make (a thrown weapon past its normal range) is left out. An Efreeti flew to 120 feet from a
    // Fire Giant, where the Hammer Throw (60/240) has Disadvantage already, cast Invisibility for nothing more, and
    // Dashed back the turn after.
    let unhampered = 1;
    if (action.condition === "invisible") {
      let best = 0;
      for (const routine of defender.routines) {
        let full = 0, already = 0;
        for (const part of routine.parts) {
          const option = defender.options[part.optionIdx];
          if (!option || !usable(foeState, part.optionIdx, option)) continue;
          const ev = part.count * evaluator.actionEvAtDistance(option.action, defender, attacker, distance);
          full += ev;
          if (option.action.kind === "attack" && distanceEvFactor(option.action, distance) < 1) already += ev;
        }
        if (full > best) {
          best = full;
          unhampered = 1 - already / full;
        }
      }
    }
    return evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * 0.35 * threatFactor(defender, foeState) * covered / swings * unhampered;
  }
  if (action.kind === "selfheal" && action.dispels) {
    return dispelEv(action.dispels, attacker, defender, foeState, selfState, source, distance, evaluator);
  }
  if (action.kind === "selfheal") {
    // Temporary hit points are not healing: they are worth their own size even at full health, and they do not
    // stack, so a grant no larger than the pool already held is worth nothing. A grant that expires at the start of
    // the creature's own next turn is worth only what the foe can spend against it in that window — priced like the
    // defensive self-buff above, and never more than the grant itself.
    // A cure is worth the Disadvantage it lifts from the caster's attacks, over the turns a condition is priced for.
    // Greater Restoration removes one effect, the one `restored` names: Charmed is worth the attacks it bars, an
    // Exhaustion level the 2 it takes off every attack roll (a tenth of the routine), and drained ability scores the
    // share of the way to 0 they have gone, in the caster's remaining hit points.
    if (action.curesConditions) {
      const removed = restored(attacker, selfState, action);
      if (!removed) return 0;
      if (removed === "abilityScores") return selfState.hp * drainedShare(attacker, selfState);
      const routine = evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false) * CONDITION_HORIZON_TURNS;
      const lifted = liftedBy(selfState, removed);
      return lifted.includes("charmed") ? routine
        : lifted.includes("blinded") || lifted.includes("poisoned") ? routine * (1 - DISADVANTAGE_EV)
        : lifted.includes("exhaustion") ? routine * 0.1 : 0;
    }
    if (action.selfTempHp?.dice) {
      // Advantage on its attack rolls until its next turn, priced as a fifth of what its best routine deals from here.
      const advantage = action.selfRiders?.some((r) => !hasCondition(selfState, r.condition) && r.rollEffects?.some((e) => e.roll === "attack" && e.mode === "advantage"))
        ? evaluator.bestRoutineEvAtDistance(attacker, defender, distance, false) * 0.2 : 0;
      const gained = tempHpGain(avgDice(action.selfTempHp.dice), selfState, attacker, defender) + advantage;
      if (action.selfTempHp.expires !== "startOfNextTurn") return gained;
      // The window such a grant covers is whatever the foe does before this creature's next turn begins. A legendary
      // action is taken at the end of the foe's turn, and in a duel this creature's own turn is next, so the grant
      // expires having absorbed nothing. Taken on its own turn, it covers the foe's next turn.
      if (timing === "legendary") return 0;
      const incoming = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * threatFactor(defender, foeState);
      return Math.min(gained, incoming);
    }
    // A creature that can't regain hit points (a heal block) heals nothing.
    // A block held by place (`Aura.blocksHealing`) is read at the square being priced: the heal is taken after the move.
    const missing = Math.max(0, selfState.maxHp - selfState.hp);
    // A heal with limited uses is kept until the wound is as large as the heal, or the creature is Bloodied: a Solar
    // spent a Divine Aid use to regain 5 hit points at 292 of 297.
    const limited = attacker.options.find((option) => option.action === action)?.uses.t;
    if (limited && limited !== "atWill" && missing < avgDice(action.healing) && selfState.hp * 2 > selfState.maxHp
      && !selfState.conditions.some((c) => c.endsOnHealingSpell)) return 0;
    const healed = healBlocked(selfState, false, distance) ? 0 : Math.min(avgDice(action.healing), missing);
    // Hit points restored are not worth the same as hit points taken off the opponent: healing
    // wins nothing by itself, and a creature at full health that heals for the sake of it never
    // closes the fight out. Full weight once bloodied, tapering to nothing at full health.
    const woundBenefit = action.spell && healed > 0
      ? selfState.conditions.filter(c => c.endsOnHealingSpell).reduce((sum, c) => {
        const remaining = c.endsSourceTurn === undefined ? 3 : c.endsSourceTurn - (c.source === source ? selfState : foeState).turnCount;
        return sum + (c.startTurnDamage ?? []).reduce((n, d) => n + avgDice(d.dice), 0) * Math.min(3, Math.max(0, remaining));
      }, 0) : 0;
    return woundBenefit + healed * Math.min(1, 2 * (1 - selfState.hp / Math.max(1, selfState.maxHp)));
  }
  if (action.kind === "teleport") {
    return teleportEv(action.teleport, attacker, defender, selfState, foeState, source, distance, evaluator, timing === "bonus");
  }
  if (action.kind === "random") {
    return action.branches.reduce(
      (sum, branch) => sum + dynamicEv(branch, attacker, defender, foeState, selfState, source, distance, evaluator, timing, runUp),
      0,
    ) / Math.max(1, action.branches.length);
  }
  // A clause gated on the foe's Hit Points (a clause that applies only to a foe that has lost some of its
  // hit points and then deals a different amount) is priced as it would be dealt now. The memoized evaluator prices such a clause
  // against a full-health foe; against a hurt one the action is priced with those gates settled.
  const settled = settleTargetHpGates(action, foeState);
  if (settled) return dynamicEv(settled, attacker, defender, foeState, selfState, source, distance, evaluator, timing, runUp);
  if (hasCondition(selfState, "antimagic") && action.magical) return 0;
  if (!actionInRange(action, distance)) return 0;
  if (!actionRequirementMet(action, foeState, source)) return 0;
  if (!actionTargetable(action, attacker, defender, distance, foeState, selfState)) return 0;
  if (!riderStillUseful(action, defender, foeState, source, selfState)) return 0;
  const expectedDmg = evaluator.expectedActionDamage(action, attacker, defender);
  const drains = drainApplies(action, defender);
  const capEv = maxHpReductionCapEv(action, defender, foeState);
  // Not an effect that kills a foe at its Hit Points outright: one the troll rule holds Unconscious at 0 is its target.
  // A troll-rule regenerator can only be put down by damage of a suppressing type.
  const regen = defender.regeneration;
  const suppressBy = regen?.deathRule && regen.suppressedBy.length ? regen.suppressedBy : null;
  const suppresses = suppressBy ? actionSuppresses(action, suppressBy) : false;
  const killsAtHp = instantDeathThreshold(action) !== undefined && foeState.hp <= instantDeathThreshold(action)!;
  if (hasAny(foeState, INCAPACITATING) && expectedDmg <= 0 && !renewsEveryLock(action, foeState, source, selfState) && !drains && capEv <= 0 && !killsAtHp && !suppresses
    && !finishesWithoutDamage(action, defender)) return 0;
  // A slay-on-zero option (a clause that kills a target this damage takes to 0 hit points)
  // against a foe above 0 HP whose regeneration has a death rule gets the suppression finisher below, on the same test,
  // and once when it also suppresses. A random action reaches here per branch, so a slay branch is priced inside the
  // mean. A foe held at 0 HP by its death rule is not slain by a further packet, so the term does not apply there.
  const slays = foeState.hp > 0 && !!regen?.deathRule && actionSlaysOnZero(action, defender);
  // A heal block against a death-rule regenerator, which dies if
  // it starts its turn at 0 HP unable to regain hit points. `blockHeld`: a block will still hold at the start of the
  // foe's next turn (a copy it holds, or the zone with the foe inside it at this square). Then any packet that reaches
  // the HP of a foe above 0 HP finishes it (the slay's test; at 0 HP it dies with no further packet). `blocks`: this
  // action would land such a block now. That is suppression's case, and it gets suppression's test: forced to top when
  // the foe's HP is at or below the packet (a foe held at 0 HP included), else + 0.5 × average HP.
  const blockHeld = !!regen?.deathRule && healBlockHoldsAtNextTurnStart(foeState, selfState, source, timing, distance);
  const blocks = !!regen?.deathRule && !blockHeld && actionAppliesHealBlock(action, defender, timing,
    (rider) => !successImmune(foeState, rider.immuneOnSuccess) && !holdsUnrenewed(foeState, rider, source, selfState));
  const threshold = instantDeathThreshold(action);
  // A "dies" effect kills outright rather than reducing to 0 HP, so it finishes even a
  // troll-rule regenerator — no suppressing damage type required.
  // Unless a Legendary Resistance answers the save: one is always spent on it (`resolveAction`), so the death is not on
  // offer and the action is priced as any other resisted save. A Solar shot its Slaying Bow at a Balor on 22 hit
  // points with three resistances left, where a second Flying Sword killed.
  const resistedDeath = action.kind === "save" && foeState.legendaryResistances > 0;
  if (threshold !== undefined && foeState.hp <= threshold && !resistedDeath) return defender.hpAvg * 100;
  let ev = evaluator.actionEvAtDistance(action, attacker, defender, distance);
  if ("riders" in action && action.riders?.some(r => r.condition === "exhaustion") && !defender.conditionImmune.includes("exhaustion")) {
    ev *= 1 + foeState.conditions.filter(c => c.name === "exhaustion").length;
  }
  // Against a regenerator this creature cannot finish through its Hit Points, Exhaustion is how it dies ("you die if
  // your Exhaustion level is 6"), whatever else the foe is suffering: the save is worth half the foe at its odds.
  const undying = defender.regeneration?.deathRule && defender.regeneration.suppressedBy.length ? defender.regeneration.suppressedBy : undefined;
  if (undying && action.kind === "save" && action.riders?.some((rider) => rider.condition === "exhaustion") && !defender.conditionImmune.includes("exhaustion")
    && actionInRange(action, distance) && !attacker.options.some((option) => actionSuppresses(option.action, undying))) {
    ev = Math.max(ev, defender.hpAvg * 0.5
      * saveFailChance(action.dc, defender.saves[action.ability] ?? defender.abilityMods[action.ability], actionSaveMode(action, defender)));
  }
  // A charge's extra die and knockdown wait on a run-up, which the memoized evaluator prices at a coin
  // flip because it cannot know where the attacker is coming from. The movement search does: it is
  // pricing the square the attack would be made from. So where `runUp` is given, the cached price is
  // rescaled to the one with the gate settled. Without it a Hippocamp standing beside its foe Rammed
  // for 1d6 + 2 instead of kicking with Hooves for 2d6 + 2, on a charge its 20-foot Speed almost never
  // lets it make.
  if (runUp !== undefined && actionHasRunUpGate(action)) {
    const priced = evaluator.immutableComponents
      ? evaluator.actionEvAtDistance(action, attacker, defender, distance)
      : rawActionEvAtDistance(action, attacker, defender, distance);
    if (priced > 0) ev *= (evaluator.immutableComponents
      ? evaluator.actionEvAtDistance(action, attacker, defender, distance, DEFENCES_ACTIVE, runUp)
      : rawActionEvAtDistance(action, attacker, defender, distance, DEFENCES_ACTIVE, runUp)) / priced;
  }
  // An ability drain is priced as progress toward its death at 0 (`drainProgressEv`). It reads the foe's current score
  // and hit points, so it cannot live in the memoized evaluator; it is added before the state multipliers below, which
  // scale it as they scale the damage it rides with. An option without a drain is not touched.
  if (drains) ev += drainProgressEv(action, defender, foeState);
  // A maximum-HP reduction by dice of its own, priced at the hit points the cap takes off (`maxHpReductionCapEv`).
  ev += capEv;
  // Everything from here down is state-dependent and so must stay *outside* the memoized
  // evaluator, whose keys are only (action, direction, distance). `resolveAction` already rolls
  // all of these correctly; without them the chooser is simply blind to advantage, and picks
  // its attack and its square as if every roll were flat.
  // Paralyzed and Unconscious turn any hit from within five feet into a critical, which is worth
  // crossing a room for. The uplift for that is weighted by how likely the condition is to still
  // be there, because collecting it means *standing* there: unlike the advantage below, which is
  // banked this turn, closing is a commitment that outlives the condition that justified it.
  const autoCrit = action.kind === "attack" && distance <= 5 && hasAny(foeState, AUTO_CRIT_ADJACENT);
  if (hasAny(foeState, INCAPACITATING) && expectedDmg > 0) {
    ev *= 1.6 + (autoCrit ? 0.6 * incapacitationPersistence(defender, foeState) : 0);
  }
  // Prone cuts both ways: advantage in reach, disadvantage at range. Skipped where the auto-crit
  // term already paid for the same advantage — Unconscious is Prone too, and counting it twice
  // squared a bonus that only exists once.
  // Disadvantage is had or not had: a roll with two sources of it is rolled as a roll with one is. The cached price
  // already carries the range's (a ranged attack within 5 feet or past its normal range) and a displacing trait's, so
  // the state's sources below count only where neither applies, and once between them. A Priest beside an Invisible
  // Will-o'-Wisp swung its Mace (8 a hit, the roll at Disadvantage) because its Radiant Flame (11 a hit, the same roll)
  // was priced at Disadvantage twice.
  let atDisadvantage = action.kind === "attack"
    && (distanceEvFactor(action, distance) < 1 || attackDisadvantageFactor(action, defender, distance, activeDefences(defender, foeState)) < 1);
  const disadvantage = (): void => {
    // Priced as the range's is: a second die that must also hit, so the factor is the roll's own chance to hit.
    if (!atDisadvantage) ev *= action.kind === "attack" ? hitChance(action.toHit, defender.ac) : DISADVANTAGE_EV;
    atDisadvantage = true;
  };
  if (action.kind === "attack" && isProne(foeState) && !autoCrit) {
    if (distance <= 5) ev *= ADVANTAGE_EV;
    // "Otherwise, that attack roll has Disadvantage": a reach attack from beyond 5 feet as much as a ranged one. An Oni
    // swung from 10 feet at the dragon its Sleep had dropped, where one step in had Advantage and the Critical Hit.
    else disadvantage();
  }
  // "Attack rolls against you have Advantage" (Paralyzed, Stunned, Unconscious, Restrained: the set `resolveAction`
  // reads), priced as Prone's Advantage within 5 feet is, and once: not where Prone above or a held roll effect below
  // pays for the same roll. The incapacitation uplift above scales every damaging option alike, a breath weapon's
  // Constitution save included, which these conditions do nothing for; without this term a Young Silver Dragon left a
  // Paralyzed foe's side to breathe on it.
  if (action.kind === "attack" && hasAny(foeState, ADV_AGAINST) && !(isProne(foeState) && !autoCrit && distance <= 5)
    && !heldRollEffects(foeState, "attackAgainst").some(({ effect }) => effect.mode === "advantage")) {
    ev *= ADVANTAGE_EV;
  }
  // "You automatically fail Strength and Dexterity saving throws" (Paralyzed, Stunned, Unconscious: the set
  // `rollSaveMargin` reads). The cached price weighs the save as rolled; it is rescaled to a certain failure. Not while
  // the foe has a Legendary Resistance left, which turns that failure into a success as it would any other.
  if (action.kind === "save" && (action.ability === "str" || action.ability === "dex") && action.onSuccess !== "full"
    && hasAny(foeState, AUTO_FAIL_STR_DEX) && foeState.legendaryResistances <= 0) {
    const fails = saveFailChance(action.dc, defender.saves[action.ability] ?? defender.abilityMods[action.ability], actionSaveMode(action, defender));
    const priced = action.onSuccess === "half" ? fails + (1 - fails) / 2 : fails;
    if (priced > 0) ev /= priced;
  }
  // "You have Disadvantage on Dexterity saving throws" (Restrained) and the Dodge action's Advantage on them, as
  // `rollSaveMargin` rolls both. The cached price is rescaled from the mode it was weighed at to that mode with the
  // state's sources added: an Advantage and a Disadvantage cancel to a straight roll. Not where the save fails outright
  // above.
  else if (action.kind === "save" && action.ability === "dex" && action.onSuccess !== "full"
    && (hasCondition(foeState, "restrained") || dodges(defender, foeState)) && !(defender.greaterMagicResistance && action.magical)) {
    const bonus = defender.saves.dex ?? defender.abilityMods.dex, mode = actionSaveMode(action, defender);
    const adv = mode === true || dodges(defender, foeState), dis = mode === -1 || hasCondition(foeState, "restrained");
    const worth = (fails: number) => action.onSuccess === "half" ? fails + (1 - fails) / 2 : fails;
    const was = worth(saveFailChance(action.dc, bonus, mode));
    if (was > 0) ev *= worth(saveFailChance(action.dc, bonus, adv === dis ? false : dis ? -1 : true)) / was;
  }
  // The Dodge action's Disadvantage on attack rolls against a foe that sees its attacker, priced as long range is.
  if (action.kind === "attack" && dodges(defender, foeState) && !unseenBy(selfState, defender)) disadvantage();
  // A printed conditional Advantage (an attack header's "with Advantage if the target
  // is Grappled by" the attacker, or a trait such as Blood Frenzy), priced as Prone's Advantage within 5 feet is, and only where it
  // is the roll's one Advantage: beside another source it changes nothing the roll does, so it changes no price.
  if (action.kind === "attack" && grantedAttackAdvantage(attacker, selfState, foeState, action, source, distance)
    && !otherAttackAdvantage(attacker, defender, selfState, foeState, action, distance)) {
    ev *= ADVANTAGE_EV;
  }
  // The attacker's own disadvantage, from the same set `resolveAction` reads. Blindness is
  // already handled upstream by the targeting checks. A trait-borne penalty belongs here too:
  // a creature that swings at Disadvantage all fight should prefer options that never roll to
  // hit, exactly as one Frightened of its foe does.
  // A held roll effect's Disadvantage is the same term (Phantasmal Killer, a one-roll
  // Disadvantage, or a breath weapon's weakening effect on a Strength weapon attack).
  const strengthAttack = reliesOnStrength(attacker, action);
  if (action.kind === "attack"
    && (isProne(selfState) || isFrightened(selfState) || hasCondition(selfState, "poisoned") || hasCondition(selfState, "restrained")
      // A target the attacker cannot see ("attack rolls against you have Disadvantage", Invisible): an area spell
      // that needs no attack roll is then the better use of the turn.
      || !canSee(attacker, foeState, selfState, distance)
      || attacker.attackDisadvantage || (attacker.fury?.disadvantageWhenInactive && !selfState.tookDamageSinceTurnEnd)
      || heldRollEffects(selfState, "attack", undefined, strengthAttack).some(({ effect }) => effect.mode === "disadvantage"))) {
    disadvantage();
  }
  // And the foe's: Guiding Bolt's Advantage rider on the next attack roll against the target, priced as Prone's
  // Advantage within 5 feet is. A weakened creature's Strength weapon attack deals half damage.
  if (action.kind === "attack" && heldRollEffects(foeState, "attackAgainst").some(({ effect }) => effect.mode === "advantage")) ev *= ADVANTAGE_EV;
  if (action.kind === "attack" && heldRollEffects(selfState, "damage", undefined, strengthAttack).some(({ effect }) => effect.mode === "half")) ev *= 0.5;
  // The defender's own Displacement and Evasion are priced inside the memoized evaluator, which
  // is pure in (action, direction, distance) and so prices them as though they were never
  // switched off. They are switched off while their owner is Incapacitated — and a fast creature's
  // blur while its Speed is 0 — so on those rounds the cached answer is rescaled by the ratio
  // between what the action is worth with the defence gone and what it was priced at.
  const defences = activeDefences(defender, foeState);
  if (!defences.displacement || !defences.evasion) {
    const priced = evaluator.immutableComponents
      ? evaluator.actionEvAtDistance(action, attacker, defender, distance)
      : rawActionEvAtDistance(action, attacker, defender, distance);
    if (priced > 0) ev *= (evaluator.immutableComponents
      ? evaluator.actionEvAtDistance(action, attacker, defender, distance, defences)
      : rawActionEvAtDistance(action, attacker, defender, distance, defences)) / priced;
  }
  // A condition the foe already has is not applied a second time — `applyRiders` skips it — so
  // the share of the cached price that comes from that rider is worth nothing this turn. The
  // memoized evaluator is pure in (action, direction, distance) and cannot see a condition, so
  // it prices every rider as landing fresh; the rescale is the same one the suppressible
  // defences use just above, for the same reason. Without it a barbed-spear attack keeps
  // outpricing a routine dealing twice the damage on every turn after the first, for a
  // wound the dragon has been carrying since turn one.
  //
  // A condition that ends on damage is the exception, and it is not a small one. `applyDamage`
  // clears it before `applyRiders` runs, so an action that both hurts and re-applies it puts it
  // straight back on — which is the whole of a Pseudodragon's game, stinging a sleeping opponent
  // once a round to keep it asleep. Reading it as "already held" told the pseudodragon to bite
  // instead, and the bite is what wakes the sleeper.
  // A Legendary Resistance turns this action's failed save into a made one, and while the pool
  // holds it always will. But the pool is finite and every attempt spends one, so the honest
  // price is not zero: an action resisted with N left lands on the (N + 1)th use, and is worth
  // that share of what it would be worth against a defender with none.
  //
  // Zero was the first thing tried and it is wrong in a way worth recording. A creature whose
  // only play is control — a gaze with no damage on it — stopped using it altogether against
  // anything with a pool, and stood there Dashing for the whole fight rather than spending three
  // turns burning through. One in (N + 1) keeps it trying, which is what actually beats the pool.
  if (foeState.legendaryResistances > 0) {
    const resisted = legendaryResistedEv(action, attacker, defender, foeState, evaluator);
    if (resisted > 0) {
      const priced = evaluator.immutableComponents
        ? evaluator.actionEv(action, attacker, defender)
        : actionEv(action, attacker, defender);
      const landsEvery = foeState.legendaryResistances + 1;
      if (priced > 0) ev *= Math.max(0, 1 - (resisted / priced) * (1 - 1 / landsEvery));
    }
  }
  // A condition that lasts "until the start of the dragon's next turn" (Banish, p292), landed by a Legendary Action:
  // the action is taken at the end of the foe's turn, and in a duel this creature's own turn is next, so the condition
  // ends having cost the foe nothing. An Ancient Gold Dragon spent ten Legendary Actions Banishing an Ancient Red.
  if (timing === "legendary" && "riders" in action && action.riders?.some((rider) => rider.duration === "startOfSourceNextTurn")) {
    const lapsed = actionRiderEv(action, defender, (rider) => rider.duration === "startOfSourceNextTurn", undefined, attacker);
    const priced = lapsed > 0 ? (evaluator.immutableComponents ? evaluator.actionEv(action, attacker, defender) : actionEv(action, attacker, defender)) : 0;
    if (priced > 0) ev *= Math.max(0, 1 - lapsed / priced);
  }
  // A copy this rider would renew is not "held": landing it again keeps the target locked a turn longer.
  // A rider the foe is immune to (a lycanthrope's curse it has saved against) is worth nothing the same way.
  const held = actionRiderEv(action, defender, (rider) => rider.condition !== "exhaustion" && !rider.push && !rider.pull && !(rider.delayedDamage && !rider.delayedDamage.disgorge) && (successImmune(foeState, rider.immuneOnSuccess) || foeState.conditions.some((condition) =>
    condition.name === rider.condition && !(condition.endsOnDamage && expectedDmg > 0) && !renews(condition, rider, source, selfState))), undefined, attacker);
  if (held > 0) {
    const priced = evaluator.immutableComponents
      ? evaluator.actionEv(action, attacker, defender)
      : actionEv(action, attacker, defender);
    if (priced > 0) ev *= Math.max(0, 1 - held / priced);
  }
  // A push the foe walks back from, or a knock-down from beyond 5 feet it stands up from, with its attack still to make.
  const displaced = displacement(action, attacker, defender, foeState, selfState, source, distance, evaluator);
  const walkedOff = displaced.walkedOff;
  if (walkedOff) {
    const wasted = actionRiderEv(action, defender, walkedOff, undefined, attacker);
    const priced = wasted > 0 ? (evaluator.immutableComponents ? evaluator.actionEv(action, attacker, defender) : actionEv(action, attacker, defender)) : 0;
    if (priced > 0) ev *= Math.max(0, 1 - wasted / priced);
  }
  ev = Math.max(0, ev + displacedEv(action, attacker, defender, foeState, distance, displaced));
  if (suppresses || slays || blocks) {
    if (foeState.hp <= expectedDmg) return defender.hpAvg * 100; // finish with it
    // A suppressor with daily uses is the finisher and nothing else is: while the uses left cannot take the foe down
    // between them, and nothing at will or on a recharge suppresses, it is kept back (half its price, no priority) and
    // the foe is worn down with the rest. A Mage threw both Fireballs at a Troll on 94 hit points and had none for 0.
    const optionIdx = attacker.options.findIndex((option) => option.action === action);
    const uses = optionIdx >= 0 ? attacker.options[optionIdx].uses : undefined;
    const usesLeft = uses?.t === "perDay" ? selfState.perDay.get(uses.pool ?? optionIdx) ?? 0 : Infinity;
    const kept = suppresses && !slays && !blocks && suppressBy && usesLeft !== Infinity && foeState.hp > expectedDmg * usesLeft
      && !attacker.options.some((option) => option.uses.t !== "perDay" && actionSuppresses(option.action, suppressBy));
    if (kept) ev *= 0.5;
    else ev += defender.hpAvg * 0.5; // otherwise keep the only winning line prioritized
  } else if (blockHeld && foeState.hp > 0 && foeState.hp <= expectedDmg) {
    return defender.hpAvg * 100; // the block is already there: this packet finishes
  } else if (suppressBy && !finishesWithoutDamage(action, defender) && !attacker.options.some((option, idx) => (option.uses.t === "recharge" || usable(selfState, idx, option))
    && actionMakesLethalProgress(option.action, defender, attacker) && !finishesWithoutDamage(option.action, defender))) {
    // (Or nothing that needs the regenerator at 0 Hit Points: Exhaustion, a drain or petrification kills it at any, so
    // damage is no step toward them and is a hundredth of its price. A Sphinx of Valor spent every Legendary Action clawing a Troll Limb, never used
    // Weight of Years, and lost all 400 fights to it.)
    // Nothing this creature has left can put the regenerator down for good, so its damage only postpones: a tenth
    // of its price, and whatever keeps the creature out of harm (Fly above a foe with no ranged attack) is worth more. An
    // Archmage stood beside a Troll for fourteen rounds of Arcane Burst and lost all 2,000 fights; aloft it draws.
    ev *= attacker.options.some((option, idx) => usable(selfState, idx, option) && finishesWithoutDamage(option.action, defender)) ? 0.01 : 0.1;
  }
  // A hold that the block's own regeneration-stopping option needs is the way to the finisher, and is prioritized like
  // it: a Behir's Swallow (Acid each turn) wants its target Grappled, which only Constrict does. It breathed Lightning at
  // a Troll on 0 Hit Points three rounds running.
  if (suppressBy && !suppresses && !slays && !blocks && ev > 0 && "riders" in action && action.riders?.some((rider) => rider.condition
    && !hasCondition(foeState, rider.condition) && attacker.options.some((option, idx) => "requiresTargetCondition" in option.action
      && option.action.requiresTargetCondition === rider.condition && actionSuppresses(option.action, suppressBy) && usable(selfState, idx, option)))) {
    ev += defender.hpAvg * 0.5;
  }
  // A possession that lands decides the fight: the body does nothing more and its possessor can't be targeted. It is
  // worth the body's remaining Hit Points at the odds it lands, to a possessor whose attacks can hurt the body.
  if (ev > 0 && "riders" in action && action.riders?.some((rider) => rider.possession) && !foeState.conditions.some((c) => c.possession)
    && attacker.options.some((option) => option.action.kind === "attack" && expectedDamage(option.action.damage, defender, option.action.magical) > 0)) {
    ev = Math.max(ev, riderLandChance(action, defender) * foeState.hp);
  }
  if (action.kind === "save") {
    const lift = action.riders.find((rider) => rider.lift)?.lift;
    if (lift) ev += liftEv(action, lift, attacker, defender, foeState, selfState, evaluator);
  }
  return ev;
}

/** Whether the creature is concentrating on a sustained spell of this name, cast earlier (`SaveAction.sustained`, `AttackAction.sustained`). */
function sustainsSpell(state: FighterState, spellName: string | undefined): boolean {
  return spellName !== undefined && state.concentrating && state.conditions.some(c => c.sustainsSpell === spellName);
}

function sustainedReuse(state: FighterState, option: ActionOption): boolean {
  return (option.action.kind === "save" || option.action.kind === "attack") && !!option.action.sustained && sustainsSpell(state, option.action.spellName);
}

function usable(state: FighterState, optionIdx: number, option: ActionOption): boolean {
  if (option.timing === "bonus" && state.conditions.some(c => c.noBonusActions)) return false;
  if (option.action.verbal && state.conditions.some(c => c.noVerbalSpells)) return false;
  if (state.conditions.some(c => c.actionOrBonus)
    && ((option.timing === "bonus" && state.actionSlotUsed) || (option.timing === "action" && state.bonusSlotUsed))) return false;
  if (option.requiresBloodiedDamage && !state.bloodiedDamage) return false;
  if (option.oncePerRound && state.usedThisRound?.has(optionIdx)) return false;
  if (state.depleted.has(optionIdx)) return false;
  if (option.requiresMythic && !state.mythicActive) return false;
  if (option.requiresStartCount !== undefined && (state.startCount ?? 0) < option.requiresStartCount) return false;
  if (option.requiresZone !== undefined && !state.conditions.some((c) => c.zoneKey === option.requiresZone)) return false;
  if (option.activation) {
    const activation = state.activations.get(option.activation.group);
    if (!activation) return false;
    if (!activation.active) return activation.ready;
    if (option.activation.noRepeat && activation.lastOption === optionIdx && activation.lastTurn === state.turnCount - 1) return false;
  }
  if (option.sequence) {
    const remaining = state.perDay.get(option.sequence.pool) ?? 0;
    if (remaining !== option.sequence.total - option.sequence.position) return false;
  }
  // One spell slot per turn: once a slot is expended this turn, no other slot spell is usable until the next turn.
  if (state.spellSlotSpent && expendsSpellSlot(option)) return false;
  const uses = option.uses;
  if (uses.t === "atWill" || sustainedReuse(state, option)) return true;
  if (uses.t === "recharge") {
    const resource = state.recharge.get(uses.pool ?? optionIdx);
    return resource?.ready === true || (!!resource?.castsLeft && resource.castTurn === state.turnCount);
  }
  return (state.perDay.get(uses.pool ?? optionIdx) || 0) > 0;
}

function spend(state: FighterState, optionIdx: number, option: ActionOption): void {
  if (option.oncePerRound) (state.usedThisRound ??= new Set()).add(optionIdx);
  if (option.timing === "action") state.actionSlotUsed = true;
  if (option.timing === "bonus") state.bonusSlotUsed = true;
  if (census) censusObservers.spend(census, state, optionIdx, option);
  if (option.activation) {
    const activation = state.activations.get(option.activation.group);
    if (activation) {
      activation.active = true;
      activation.ready = false;
      activation.lastOption = optionIdx;
      activation.lastTurn = state.turnCount;
    }
  }
  const uses = option.uses;
  if (uses.t === "recharge") {
    const key = uses.pool ?? optionIdx;
    const resource = state.recharge.get(key);
    // One use may cast more than one spell (`Uses.casts`): the first cast spends the recharge, the rest ride on it.
    if (resource?.ready) {
      resource.ready = false;
      resource.castsLeft = (uses.casts ?? 1) - 1;
      resource.castTurn = state.turnCount;
    } else if (resource?.castsLeft) resource.castsLeft--;
  }
  if (uses.t === "perDay" && !sustainedReuse(state, option)) {
    const key = uses.pool ?? optionIdx;
    state.perDay.set(key, (state.perDay.get(key) || 0) - 1);
  }
  if (expendsSpellSlot(option)) state.spellSlotSpent = true;
}

function rollDepletion(state: FighterState, optionIdx: number, option: ActionOption, rng: () => number, log: FightLog): void {
  if (!option.depletion || state.depleted.has(optionIdx)) return;
  if (1 + Math.floor(rng() * option.depletion.die) <= option.depletion.maxRoll) {
    state.depleted.add(optionIdx);
    if (log.on) log.push(`${option.name} is depleted`);
  }
}

/** The Shield spell has a Verbal component: a creature that can't cast Verbal spells (`noVerbalSpells`) can't raise it. */
function verbalShieldBarred(block: CombatStatblock, state: FighterState): boolean {
  return block.reaction?.kind === "shield" && state.conditions.some(c => c.noVerbalSpells);
}

function reactionAvailable(block: CombatStatblock, state: FighterState): boolean {
  if (state.reactionUsed || state.conditions.some(c => c.noReactions) || hasAny(state, RULES_INCAPACITATED) || controlled(state)) return false;
  if (block.reaction?.uses?.t === "recharge") return state.recharge.get("defensive-reaction")?.ready === true;
  if (block.reaction?.uses?.t !== "perDay") return true;
  if (block.reaction.uses.pool) return (state.perDay.get(block.reaction.uses.pool) || 0) > 0;
  return (state.reactionRemaining || 0) > 0;
}

/**
 * A defensive reaction whose print says the creature must see the attacker is not taken while its holder
 * cannot see the attacker, by the same sight test the opportunity attack and the rebukes use (the holder observes the
 * attacker at the actual separation). Judged after `breakInvisibility`, so an Invisibility that ends on attacking no
 * longer hides the attacker; a Greater Invisibility does. Not taken means not spent.
 */
function reactionSeesAttacker(
  defender: CombatStatblock,
  defenderState: FighterState,
  attackerState: FighterState | undefined,
  distance: number | undefined,
): boolean {
  if (!defender.reaction?.requiresSight) return true;
  if (!attackerState || distance === undefined) return true;
  return canSee(defender, attackerState, defenderState, distance);
}

/** The reaction slot and the rebuke's own limited uses, both of which a rebuke spends. */
function rebukeAvailable(state: FighterState, rebuke: Rebuke): boolean {
  if (state.reactionUsed || state.conditions.some(c => c.noReactions) || hasAny(state, RULES_INCAPACITATED) || controlled(state)) return false;
  if (rebuke.uses.t === "recharge") return state.recharge.get(REBUKE_POOL)?.ready === true;
  if (rebuke.uses.t === "perDay") return (state.perDay.get(REBUKE_POOL) || 0) > 0;
  return true;
}

function spendRebuke(state: FighterState, rebuke: Rebuke): void {
  if (census) censusObservers.spendRebuke(census, state, rebuke);
  state.reactionUsed = true;
  if (rebuke.uses.t === "recharge") {
    const resource = state.recharge.get(REBUKE_POOL);
    if (resource) resource.ready = false;
  }
  if (rebuke.uses.t === "perDay") {
    state.perDay.set(REBUKE_POOL, Math.max(0, (state.perDay.get(REBUKE_POOL) || 0) - 1));
  }
}

function spendReaction(block: CombatStatblock, state: FighterState): void {
  if (census) censusObservers.spendReaction(census, block, state);
  state.reactionUsed = true;
  if (block.reaction?.uses?.t === "recharge") state.recharge.get("defensive-reaction")!.ready = false;
  if (block.reaction?.uses?.t === "perDay") {
    if (block.reaction.uses.pool) {
      state.perDay.set(block.reaction.uses.pool, Math.max(0, (state.perDay.get(block.reaction.uses.pool) || 0) - 1));
    } else {
      state.reactionRemaining = Math.max(0, (state.reactionRemaining || 0) - 1);
    }
  }
}

function hasCondition(state: FighterState, name: string): boolean {
  return state.conditions.some((c) => c.name === name);
}

function isProne(state: FighterState): boolean {
  return hasCondition(state, "prone") || hasCondition(state, "hideousLaughter") || hasCondition(state, "unconscious");
}

/**
 * The creature is barred from ending its Prone: Hideous Laughter ("it can't end the Prone condition on itself"), or a
 * `prone` copy that carries the bar (`Rider.cannotStand`).
 */
function cannotStand(state: FighterState): boolean {
  return hasCondition(state, "hideousLaughter") || state.conditions.some((c) => c.name === "prone" && c.cannotStand);
}

/**
 * "When this condition ends, you remain Prone" (SRD 5.2.1, Unconscious). The engine holds no `prone` copy under
 * Unconscious (`isProne` reads the condition itself), so the copy is given here, when a creature that was Unconscious at
 * the last settle point no longer is: by the source of the Unconscious it held. Not to a creature that is down, is immune
 * to Prone or already holds a `prone` copy. Called wherever conditions are settled (`settleFlight`) and at the wake on
 * damage (`applyDamage`).
 */
/**
 * "When a creature drops to 0 Hit Points, it either dies outright or falls unconscious" (SRD 5.2.1). A creature its own
 * trait keeps from dying at 0 (the troll rule, `regeneration.deathRule`: it "dies only if it starts its turn with 0 Hit
 * Points and doesn't regenerate") is Unconscious while it has 0, and no longer once it has regained any; it remains
 * Prone then (`settleWake`). Called where damage lands, where conditions are settled and where it regenerates.
 */
function settleZeroHp(block: CombatStatblock, state: FighterState, log: FightLog): void {
  if (!block.regeneration?.deathRule) return;
  const held = state.conditions.find((c) => c.zeroHp);
  const out = state.hp <= 0 && !state.slain && !state.regenFailed;
  if (out && !held && !block.conditionImmune.includes("unconscious")) {
    state.conditions.push({ name: "unconscious", duration: "permanent", source: state.place ? (1 - state.place.self) as 0 | 1 : 0, appliedTurn: state.turnCount, zeroHp: true });
    if (log.on) log.push(`${block.name} falls unconscious at 0 hit points`);
  } else if (!out && held) {
    state.conditions = state.conditions.filter((c) => c !== held);
  }
}

function settleWake(block: CombatStatblock, state: FighterState, log: FightLog): void {
  const held = state.conditions.find((c) => c.name === "unconscious");
  if (state.unconsciousFrom !== undefined && !held) {
    // A creature the waking damage downed is given nothing; the note is kept in case something holds it up after all
    // (Undead Fortitude is rolled after the wake).
    if (isDown(block, state)) return;
    if (!block.conditionImmune.includes("prone") && !hasCondition(state, "prone")) {
      state.conditions.push({ name: "prone", duration: "permanent", source: state.unconsciousFrom, appliedTurn: state.turnCount });
      if (log.on) log.push(`${block.name} is no longer unconscious and remains prone`);
    }
  }
  state.unconsciousFrom = held?.source;
}

/**
 * A flier that cannot hover and may not leave the ground: "While flying, you fall if you have the Incapacitated or Prone
 * condition" (SRD 5.2.1). An Incapacitated one, and a Prone one: a climb would only
 * drop it again. On its own turn a Prone creature that can stand has stood before it
 * moves, so this reaches the crawler that cannot stand, and a Legendary Move made while Prone (off its turn the creature
 * does not stand).
 */
function groundBound(block: CombatStatblock, state: FighterState): boolean {
  return !canHover(block, state) && (hasAny(state, RULES_INCAPACITATED) || isProne(state));
}

/**
 * The Frightened condition, or the Fear spell's hold, which is one: "have the Frightened condition for the duration"
 * (SRD 5.2.1, Fear). `fearSpell` is kept as its own name for the Dash away that the spell adds.
 */
function isFrightened(state: FighterState): boolean {
  return hasCondition(state, "frightened") || hasCondition(state, "fearSpell");
}

function hasConditionFrom(state: FighterState, name: string, source: 0 | 1): boolean {
  return state.conditions.some((c) => c.name === name && c.source === source);
}

function hasAny(state: FighterState, names: Set<string>): boolean {
  return state.conditions.some((c) => names.has(c.name));
}

/**
 * Does the state a printed conditional Advantage names hold for an attack by `source`? Hit Points are read against the
 * current maximum, which max-HP drain can have reduced,
 * and exclude temporary Hit Points; Bloodied is the test the Bloodied damage gates use. The round is read from the two
 * turn counts: `startTurn` raises a creature's count when its turn begins.
 */
function advantageConditionHolds(when: AttackAdvantageCondition, aState: FighterState, dState: FighterState, source: 0 | 1): boolean {
  switch (when) {
    case "targetGrappledByAttacker": return hasConditionFrom(dState, "grappled", source);
    case "targetMissingHp": return dState.hp < dState.maxHp;
    case "attackerMissingHp": return aState.hp < aState.maxHp;
    case "attackerBloodied": return aState.hp <= aState.maxHp / 2;
    case "attackerAttached": return hasConditionFrom(dState, "attached", source);
    case "targetFrightened": return isFrightened(dState);
    case "firstRound": return aState.turnCount <= 1 && dState.turnCount <= 1;
    case "targetNoTurnYet": return dState.turnCount === 0;
    case "attackerNotIncapacitated": return !hasAny(aState, RULES_INCAPACITATED);
  }
}

/**
 * The Advantage an attack's own header ("with Advantage if the target is Grappled by the mimic") or the attacker's trait
 * (Blood Frenzy, Bloodied Fury) grants this roll. A trait reaches every attack roll the creature makes, or only its melee
 * attacks where the print says "melee attack rolls". One source among the roll's others: `resolveAction` ORs it into
 * `adv`, so it neither stacks nor survives a Disadvantage.
 */
function grantedAttackAdvantage(
  attacker: CombatStatblock, aState: FighterState, dState: FighterState,
  action: AttackAction, source: 0 | 1, distance: number,
): boolean {
  if (action.advantageWhen && advantageConditionHolds(action.advantageWhen, aState, dState, source)) return true;
  const trait = attacker.attackAdvantageWhen;
  if (!trait) return false;
  if (trait.melee && !(action.melee && distance <= (action.reach ?? 5))) return false;
  return advantageConditionHolds(trait.when, aState, dState, source);
}

/**
 * Whether the roll already has Advantage from a source other than a granted conditional one: the state sources
 * `resolveAction` reads (a rebuke's forced Advantage is a property of the reaction and is not priced). The chooser asks
 * this so that a granted Advantage is priced only where it changes the roll.
 */
function otherAttackAdvantage(
  attacker: CombatStatblock, defender: CombatStatblock, aState: FighterState, dState: FighterState,
  action: AttackAction, distance: number,
): boolean {
  return !!attacker.attackAdvantage || (!!attacker.fury && aState.tookDamageSinceTurnEnd)
    || !canSee(defender, aState, dState, distance) || hasCondition(aState, "aiming") || hasAny(dState, ADV_AGAINST)
    || (distance <= 5 && isProne(dState))
    || heldRollEffects(aState, "attack", undefined, reliesOnStrength(attacker, action)).some(({ effect }) => effect.mode === "advantage")
    || heldRollEffects(dState, "attackAgainst").some(({ effect }) => effect.mode === "advantage");
}

/** The proficiency bonus of a creature of this Challenge Rating. */
/**
 * Which of the creature's weapon attacks run on Strength: a weapon (non-spell) attack whose bonus is the proficiency bonus
 * plus the Strength modifier (and up to +3 for a magic weapon) and not the same for Dexterity. When both fit or neither
 * does, a melee attack reads Strength if it is at least Dexterity, and a ranged one only if it is greater.
 */
function reliesOnStrength(block: CombatStatblock, action: CombatAction): boolean {
  if (action.kind !== "attack" || action.spell) return false;
  const pb = proficiencyFromCr(block.cr);
  const fits = (mod: number): boolean => action.toHit - pb - mod >= 0 && action.toHit - pb - mod <= 3;
  const str = fits(block.abilityMods.str);
  const dex = fits(block.abilityMods.dex);
  if (str !== dex) return str;
  return action.melee ? block.abilityMods.str >= block.abilityMods.dex : block.abilityMods.str > block.abilityMods.dex;
}

/** A held roll effect and the condition copy it rides on. */
interface HeldRollEffect {
  condition: ConditionState;
  effect: RollEffect;
}

/**
 * The roll effects this creature holds that reach a roll: its `attack`, `save`, `check` or `damage` roll, or an attack
 * roll made against it (`attackAgainst`). An ability-gated effect reaches a save or check of that ability, or (on an
 * attack or damage roll) a weapon attack that relies on Strength.
 */
function heldRollEffects(state: FighterState, roll: RollEffect["roll"], ability?: Ability, strengthAttack = false): HeldRollEffect[] {
  const held: HeldRollEffect[] = [];
  if (["attack", "save", "check"].includes(roll)) for (const condition of state.conditions.filter(c => c.name === "exhaustion")) {
    held.push({ condition, effect: { roll, mode: "penalty", dice: { n: 0, d: 1, mod: 2 } } });
  }
  for (const condition of state.conditions) {
    for (const effect of condition.rollEffects ?? []) {
      if (effect.roll !== roll) continue;
      if (effect.ability !== undefined) {
        const reaches = roll === "save" || roll === "check" ? effect.ability === ability : effect.ability === "str" && strengthAttack;
        if (!reaches) continue;
      }
      held.push({ condition, effect });
    }
  }
  return held;
}

/** The dice the held penalties subtract from this roll, rolled now. */
function rollEffectPenalty(held: HeldRollEffect[], rng: () => number): number {
  let total = 0;
  for (const { effect } of held) {
    if (effect.mode === "penalty" && effect.dice) total += rollDice(effect.dice, rng, false);
    // A die added to the roll (Bless) is a penalty below zero.
    if (effect.mode === "bonus" && effect.dice) total -= rollDice(effect.dice, rng, false);
  }
  return total;
}

/** A roll was made: the next-roll copies that reached it are spent, and end. */
function spendNextRollEffects(state: FighterState, held: HeldRollEffect[], log?: FightLog, block?: CombatStatblock): void {
  const spent = new Set(held.filter((entry) => entry.effect.nextRollOnly).map((entry) => entry.condition));
  if (!spent.size) return;
  state.conditions = state.conditions.filter((condition) => !spent.has(condition));
  pruneLinkedConditions(state);
  if (log?.on && block) log.push(`${block.name}'s ${[...new Set([...spent].map((condition) => condition.name))].join(" and ")} is spent`);
}

/**
 * Why an ability check this creature makes has Disadvantage, apart from its held roll effects: it is Poisoned
 * (Disadvantage on attack rolls and ability checks) or Frightened (Disadvantage on ability checks and attack rolls
 * while the source of fear is within line of sight: the duel has no cover, so the source always is, as for the attack
 * roll in `resolveAction`), or the check itself is printed with it (`printed`: a hold's `escapeDisadvantage`). The one
 * source list the roll and its price both read.
 */
function checkDisadvantageSources(state: FighterState, printed = false): string[] {
  const sources: string[] = [];
  if (hasCondition(state, "fireAversion")) sources.push("fire aversion");
  if (hasCondition(state, "poisoned")) sources.push("poisoned");
  if (isFrightened(state)) sources.push("frightened");
  if (printed) sources.push("the hold");
  return sources;
}

/**
 * The odds of an ability check of `ability` with this bonus meeting `dc`, under the holder's check effects: Advantage and
 * Disadvantage square the chance, and a penalty is taken at its average. With none held it is the flat chance the escape
 * decision has always used. Disadvantage also comes from Poisoned, Frightened and a
 * hold printed with it (`printedDisadvantage`), and cancels against a held Advantage.
 */
function checkOdds(state: FighterState, ability: Ability, bonus: number, dc: number, printedDisadvantage = false): number {
  const held = heldRollEffects(state, "check", ability);
  const penalty = held.reduce((sum, { effect }) => sum + (effect.mode === "penalty" && effect.dice ? avgDice(effect.dice) : 0), 0);
  const p = Math.max(0, Math.min(1, (21 + bonus - penalty - dc) / 20));
  const adv = held.some(({ effect }) => effect.mode === "advantage");
  const dis = held.some(({ effect }) => effect.mode === "disadvantage")
    || checkDisadvantageSources(state, printedDisadvantage).length > 0;
  return adv && !dis ? 1 - (1 - p) ** 2 : dis && !adv ? p * p : p;
}

/**
 * Saving throw. Note there is no natural-20/natural-1 rule here: SRD 5.2.1 "Rolling 20 or 1"
 * scopes automatic success/failure to *attack rolls* only (the sole nat-20 saving throw rule
 * is the Death Saving Throw). A save is a plain d20 + bonus vs. DC, so a good enough bonus
 * cannot fail and a poor enough one cannot succeed.
 * Magic Resistance grants advantage vs magical effects; paralyzed/stunned/unconscious
 * auto-fail str/dex saves.
 */
function rollSave(
  block: CombatStatblock,
  state: FighterState,
  ability: Ability,
  dc: number,
  magical: boolean,
  rng: () => number,
  extraAdvantage = false,
  against: readonly (string | undefined)[] = [],
): boolean {
  return rollSaveMargin(block, state, ability, dc, magical, rng, extraAdvantage, against).saved;
}

/** A saving throw's outcome and, on a failure, by how much it failed (the DC minus the total). */
interface SaveOutcome {
  saved: boolean;
  failedBy: number;
}

/**
 * The same saving throw, with its failure margin: `failedBy` is the DC minus the total on a failure and 0 on a success.
 * An automatic failure (Paralyzed, Stunned or Unconscious against Strength or Dexterity) rolls no die and has no total,
 * so it fails by no margin: `failedBy` 0. A save-margin tier (`Rider.saveFailMargin`, `SaveAction.marginDamage`) reads
 * it.
 */
function dodges(block: CombatStatblock, state: FighterState): boolean {
  return !!state.dodging && !hasAny(state, RULES_INCAPACITATED) && currentSpeed(block, state) > 0;
}

function rollSaveMargin(
  block: CombatStatblock,
  state: FighterState,
  ability: Ability,
  dc: number,
  magical: boolean,
  rng: () => number,
  extraAdvantage = false,
  against: readonly (string | undefined)[] = [],
  extraDisadvantage = false,
): SaveOutcome {
  if (block.greaterMagicResistance && magical) return { saved: true, failedBy: 0 };
  if ((ability === "str" || ability === "dex") && hasAny(state, AUTO_FAIL_STR_DEX)) return { saved: false, failedBy: 0 };
  // Magic Resistance, a condition-save trait (Fey Ancestry) against `against`, or the caller's own
  // reason: any of them is one Advantage, and Disadvantage cancels it.
  // A held roll effect: the weakened creature's Strength saves, a penalty on the next save.
  const held = heldRollEffects(state, "save", ability);
  const adv = saveAdvantage(block, magical, against) || extraAdvantage || held.some(({ effect }) => effect.mode === "advantage")
    || (!!block.bloodiedSaveAdvantage && state.hp <= state.maxHp / 2)
    || (!!block.saveAdvantageUnlessIncapacitated && !hasAny(state, RULES_INCAPACITATED))
    || (ability === "dex" && dodges(block, state));
  const dis = extraDisadvantage || (ability === "dex" && hasCondition(state, "restrained")) || held.some(({ effect }) => effect.mode === "disadvantage");
  const r1 = d20(rng);
  const r2 = adv !== dis ? d20(rng) : r1;
  const roll = adv && !dis ? Math.max(r1, r2) : dis && !adv ? Math.min(r1, r2) : r1;
  const total = roll + (block.saves[ability] ?? block.abilityMods[ability]) - rollEffectPenalty(held, rng);
  spendNextRollEffects(state, held);
  return total >= dc || rollBoosted(block, state, dc - total) ? { saved: true, failedBy: 0 } : { saved: false, failedBy: dc - total };
}

/**
 * The creature's own roll fell `short` of its DC and its `rollBoost` Reaction covers the gap: it takes the Reaction, which
 * costs a use, and the roll succeeds. Not taken on a roll the number cannot save.
 */
function rollBoosted(block: CombatStatblock, state: FighterState, short: number): boolean {
  const boost = block.rollBoost;
  if (!boost || short <= 0 || short > boost.bonus || !state.rollBoostLeft || !reactionAvailable(block, state)) return false;
  state.rollBoostLeft--;
  spendReaction(block, state);
  if (state.place?.log?.on) state.place.log.push(`${block.name} uses ${boost.name}: +${boost.bonus} to the roll`);
  return true;
}

/** Does a save that failed by `failedBy` (0 on a success or an automatic failure) let this rider land? */
function marginAdmits(rider: Rider, failedBy: number): boolean {
  if (rider.saveFailMargin !== undefined && failedBy < rider.saveFailMargin) return false;
  if (rider.saveFailMarginBelow !== undefined && failedBy >= rider.saveFailMarginBelow) return false;
  return true;
}

/** A rider on a save-margin tier, either side of the gate. */
function marginGated(rider: Rider): boolean {
  return rider.saveFailMargin !== undefined || rider.saveFailMarginBelow !== undefined;
}

/** A trace line for a failed save that governs a save-margin tier: the margin is what decides the tier. */
function logSaveMargin(log: FightLog, name: string, failedBy: number): void {
  if (log.on) log.push(failedBy > 0 ? `${name} fails the save by ${failedBy}` : `${name} fails the save automatically`);
}

/**
 * Collapse each attacker's-choice group to the one rider it actually applies. A rider printed as
 * a choice between Charmed and Poisoned, left to the attacker, is a decision, and an attacker makes it well: skip anything the
 * defender is immune to, then prefer a condition that stops it acting — which in a 1v1 includes
 * Charmed, since a creature charmed by its only opponent cannot attack that opponent. Ties keep
 * source order, so the data's own first-listed option wins.
 *
 * Riders with no group are passed through untouched, which is nearly all of them.
 */
function resolveRiderChoices(riders: Rider[], defender: CombatStatblock): Rider[] {
  if (!riders.some((rider) => rider.choiceGroup !== undefined)) return riders;
  const chosen = new Map<number, Rider>();
  for (const rider of riders) {
    if (rider.choiceGroup === undefined) continue;
    if (defender.conditionImmune.includes(rider.condition)) continue;
    const best = chosen.get(rider.choiceGroup);
    if (!best || (INCAPACITATING.has(rider.condition) && !INCAPACITATING.has(best.condition))) {
      chosen.set(rider.choiceGroup, rider);
    }
  }
  // Every option immune-blocked leaves the group empty, which is the right answer: the attacker
  // had a choice between two things that cannot land.
  return riders.filter((rider) => rider.choiceGroup === undefined || chosen.get(rider.choiceGroup) === rider);
}

/**
 * Apply on-hit / on-fail condition riders. `initialSaveMade` is true when a save-based
 * action already rolled the initial save (Hold Monster etc.) — the rider's save is then
 * only for the per-turn repeat, so we must not roll it again here (that would double the save).
 */
function applyRiders(
  target: FighterState,
  defender: CombatStatblock,
  attackerState: FighterState,
  riders: Rider[],
  source: 0 | 1,
  magical: boolean,
  rng: () => number,
  log: FightLog,
  initialSaveMade = false,
  concentration = false,
  holdReach?: number,
  immunity?: SuccessImmunity,
  initialFailedBy = 0,
): void {
  // The saves rolled in this application, by ability and DC: a save-margin tier reads the roll its base tier made
  // (a failure by 5 or more also knocks the target unconscious) rather than rolling a second save.
  // `initialFailedBy` is the margin of the save the caller already rolled (`initialSaveMade`).
  const rolled = new Map<string, SaveOutcome>();
  // A hold is anchored to its grappler only when the prose actually grapples: the Kraken's
  // tentacle applies Grappled and Restrained together and both end with the grip, while a
  // spider's web applies Restrained on its own and stays where it was spun. Anchoring the
  // whole rider set on the presence of a `grappled` rider is what keeps the second out of it.
  const gripped = riders.some((rider) => rider.duration === "untilEscape" && rider.condition === "grappled" && !rider.detachedHold);
  const anchored = holdReach !== undefined && gripped;
  // What keeps a hold of this set on (`ConditionState.heldBy`): the creature's own grapple, or its attachment.
  const heldBy = gripped ? "grapple" as const : riders.some((rider) => rider.condition === "attached") ? "attachment" as const : undefined;
  const selectedRiders = resolveRiderChoices(riders, defender);
  const newlyApplied = new Map<string, ConditionState>();
  for (const rider of selectedRiders) {
    if (rider.requiresTargetCondition && !hasCondition(target, rider.requiresTargetCondition)) continue;
    // "The target is immune to this werewolf's curse for 24 hours": no save, and the bite's damage has already landed.
    if (successImmune(target, rider.immuneOnSuccess)) {
      if (log.on) log.push(`${defender.name} is immune to ${rider.immuneOnSuccess!.key}`);
      continue;
    }
    if (defender.conditionImmune.includes(rider.condition)) continue;
    if (rider.blockedByConditions?.some((c) => defender.conditionImmune.includes(c))) continue;
    if (sleepBlocked(rider, defender)) continue;
    if (immunityGated(rider, defender)) continue;
    if (rider.targetMaxSize !== undefined && defender.size > rider.targetMaxSize) continue;
    if (rider.requiresMovement !== undefined && runUpFor(attackerState, rider) < rider.requiresMovement) continue;
    if (rider.targetTypes && !rider.targetTypes.includes(defender.creatureType)) continue;
    if (rider.excludedTargetTypes?.includes(defender.creatureType)) continue;
    if (rider.excludedTargetTags?.some((tag) => defender.creatureTags.includes(tag))) continue;
    if (rider.targetHpMax !== undefined && target.hp > rider.targetHpMax) continue;
    if (rider.requiresTargetHpAbove !== undefined && target.hp <= rider.requiresTargetHpAbove) continue;
    // A copy that ends when the target escapes does not stand in for one that does not. A giant construct's bite
    // swallows a creature its fist already holds Restrained "until this grapple ends"; skipping the swallow's own
    // Restrained as a duplicate left an escape from the grapple taking it away inside the stomach.
    // A save-margin tier that outlasts the copy its base tier gave takes that copy's place: the Homunculus's Bite poisons
    // through the close of its following turn, or for 1 minute on a save failed by 5 or more, and a bite on a target still
    // poisoned by the last one must be able to give the longer copy.
    const gated = marginGated(rider);
    const replaced = rider.saveFailMargin !== undefined && (rider.duration === "permanent" || rider.duration === "saveEndsEachTurn")
      ? target.conditions.filter((c) => c.name === rider.condition)
      : [];
    const replaces = replaced.length > 0 && replaced.every((c) => c.source === source && SHORT_DURATIONS.has(c.duration));
    const held = rider.condition === "exhaustion" || rider.push || rider.pull || replaces || rider.delayedDamage && !rider.delayedDamage.disgorge ? [] : target.conditions.filter((c) => c.name === rider.condition);
    // A second rider that lasts until the end of the source's next turn is an effect of its own, and the later end
    // stands: a stunning attack that lands on a creature still stunned by the last one stuns it through the
    // source's next turn. Under the target-timed rule the first had always ended by then. One that
    // would end no later (a second hit in the same turn) is skipped as before, with no save to roll.
    // A copy held until an escape stands beside it and is not what the rider renews: a conjured chain landing again on
    // a creature the devil's own chain holds pushes back the end of the copy it gave the turn before.
    const renewable = held.filter((c) => renews(c, rider, source, attackerState));
    const renewing = renewable.length > 0 && held.every((c) => renewable.includes(c) || c.duration === "untilEscape");
    // Nor does a copy about to lapse stand in for one that lasts as long as a hold: a chain's Restrained "until the
    // grapple ends" lands on a target a conjured chain Restrains only until the end of the devil's next turn.
    const outlasts = rider.duration === "untilEscape" && held.every((c) => SHORT_DURATIONS.has(c.duration));
    if (!renewing && held.length && !outlasts && (rider.duration === "untilEscape" || held.some((c) => c.duration !== "untilEscape"))) {
      // A target already Prone that fails the effect's save is barred from standing all the same: the Prone it holds
      // carries the bar. Only where the save is already made (a save action's rider).
      if (rider.cannotStand && (!rider.save || initialSaveMade)) for (const c of held) c.cannotStand = true;
      continue;
    }
    // A printed once-per-turn effect (it can trigger only once per turn, or carries an "up to once per turn" note):
    // the first hit of the turn that reaches the attempt spends the turn's use, whether or not the save succeeds; later
    // hits of that turn deal their damage only. A rider skipped above (immunity, a gate, a copy it would not renew) was
    // not attempted and spends nothing.
    if (rider.oncePerTurnKey !== undefined) {
      if (attackerState.perTurnUsed.has(rider.oncePerTurnKey)) {
        if (log.on) log.push(`${rider.oncePerTurnKey} effect is spent this turn (${rider.condition})`);
        continue;
      }
      attackerState.perTurnUsed.add(rider.oncePerTurnKey);
    }
    // A margin tier's "while poisoned" links to the Poisoned the target already carries when this hit's own copy was
    // skipped as held (a second poisoning sting): the shared repeat save still ends both.
    const parent = rider.requiresTargetCondition
      ? newlyApplied.get(rider.requiresTargetCondition)
        ?? (gated ? target.conditions.filter((c) => c.name === rider.requiresTargetCondition).pop() : undefined)
      : undefined;
    const linkedSave = parent?.duration === "saveEndsEachTurn" && rider.duration === "saveEndsEachTurn"
      && parent.save?.ability === rider.save?.ability && parent.save?.dc === rider.save?.dc;
    const linkedHold = parent?.duration === "untilEscape" && rider.duration === "untilEscape"
      && parent.escapeDc !== undefined && parent.escapeDc === rider.escapeDc;
    // "The target is cursed ... Until the curse ends, the target has the Charmed and Poisoned conditions": what a curse
    // gives ends with the curse, and a cure that ends "a curse" ends them through it (`restored`).
    const linkedCurse = parent?.name === "cursed";
    const linkedParent = linkedSave || linkedHold || linkedCurse ? parent : undefined;
    const sharesInitialSave = linkedSave;
    // Would this failure land an incapacitating rider governed by the same roll? The rider itself, a follow-on rider
    // sharing its repeat save (Legendary Resistance), and a margin tier the failure reaches.
    const couldLand = (candidate: Rider): boolean => INCAPACITATING.has(candidate.condition)
      && !defender.conditionImmune.includes(candidate.condition)
      && !candidate.blockedByConditions?.some((c) => defender.conditionImmune.includes(c))
      && !immunityGated(candidate, defender)
      && (candidate.targetMaxSize === undefined || defender.size <= candidate.targetMaxSize)
      && (candidate.requiresMovement === undefined || runUpFor(attackerState, candidate) >= candidate.requiresMovement)
      && (!candidate.targetTypes || candidate.targetTypes.includes(defender.creatureType))
      && !candidate.excludedTargetTypes?.includes(defender.creatureType)
      && !candidate.excludedTargetTags?.some((tag) => defender.creatureTags.includes(tag))
      && (candidate.targetHpMax === undefined || target.hp <= candidate.targetHpMax)
      && (candidate.requiresTargetHpAbove === undefined || target.hp > candidate.requiresTargetHpAbove)
      && !target.conditions.some((condition) => condition.name === candidate.condition);
    const sameSave = (candidate: Rider): boolean => candidate.save?.ability === rider.save?.ability && candidate.save?.dc === rider.save?.dc;
    const marginWorth = (failedBy: number): boolean => selectedRiders.some((candidate) => candidate.saveFailMargin !== undefined
      && sameSave(candidate) && marginAdmits(candidate, failedBy) && couldLand(candidate));
    if (gated) {
      // A margin tier reads the save that governs it: the caller's (a save action, a burst, an aura), or the first roll
      // against the same save in this application (the base tier's), and rolls that save itself only when nothing has.
      let outcome: SaveOutcome;
      const key = rider.save ? `${rider.save.ability}:${rider.save.dc}` : "";
      const prior = initialSaveMade || !rider.save ? { saved: false, failedBy: initialFailedBy } : rolled.get(key);
      if (prior) {
        outcome = prior;
      } else {
        outcome = rollSaveMargin(defender, target, rider.save!.ability, rider.save!.dc, magical, rng, false, riderSaveConditions(rider, selectedRiders));
        if (!outcome.saved && target.legendaryResistances > 0
          && ((INCAPACITATING.has(rider.condition) && marginAdmits(rider, outcome.failedBy)) || marginWorth(outcome.failedBy))) {
          target.legendaryResistances--;
          outcome = { saved: true, failedBy: 0 };
          if (log.on) log.push(`${defender.name} uses Legendary Resistance`);
        }
        rolled.set(key, outcome);
        if (!outcome.saved) logSaveMargin(log, defender.name, outcome.failedBy);
        if (outcome.saved) {
          if (log.on) log.push(`${defender.name} resists ${rider.condition}`);
          grantSuccessImmunity(target, rider.immuneOnSuccess, "initial", log, defender);
          continue;
        }
      }
      if (outcome.saved || !marginAdmits(rider, outcome.failedBy)) continue;
      if (replaces) {
        target.conditions = target.conditions.filter((c) => !replaced.includes(c));
        pruneLinkedConditions(target);
      }
    } else if (rider.save && !initialSaveMade && !sharesInitialSave) {
      const outcome = rollSaveMargin(defender, target, rider.save.ability, rider.save.dc, magical, rng, false, riderSaveConditions(rider, selectedRiders));
      let saved = outcome.saved;
      const dependentWorth = selectedRiders.some((candidate) => candidate.requiresTargetCondition === rider.condition
        && candidate.duration === "saveEndsEachTurn" && sameSave(candidate)
        && marginAdmits(candidate, outcome.failedBy) && couldLand(candidate));
      if (!saved && target.legendaryResistances > 0 && (INCAPACITATING.has(rider.condition) || dependentWorth || marginWorth(outcome.failedBy))) {
        target.legendaryResistances--;
        saved = true;
        if (log.on) log.push(`${defender.name} uses Legendary Resistance`);
      }
      rolled.set(`${rider.save.ability}:${rider.save.dc}`, saved ? { saved: true, failedBy: 0 } : outcome);
      if (!saved && selectedRiders.some((candidate) => marginGated(candidate) && sameSave(candidate))) logSaveMargin(log, defender.name, outcome.failedBy);
      if (saved) {
        if (log.on) log.push(`${defender.name} resists ${rider.condition}`);
        grantSuccessImmunity(target, rider.immuneOnSuccess, "initial", log, defender);
        continue;
      }
    }
    if (renewing) {
      for (const c of renewable) c.appliedTurn = attackerState.turnCount;
      // A renewed copy carries this effect's heal block as well.
      if (rider.blocksHealing) for (const c of renewable) c.blocksHealing = true;
      // And its bar on standing.
      if (rider.cannotStand) for (const c of renewable) c.cannotStand = true;
      // And its lift, made again from where the target hangs.
      if (rider.lift) for (const c of renewable) c.lift = rider.lift;
      if (log.on) log.push(`${defender.name}'s ${rider.condition} is renewed`);
      continue;
    }
    const applied: ConditionState = {
      name: rider.condition,
      spellLevel: rider.spellLevel,
      push: rider.push,
      pushUpTo: rider.pushUpTo,
      pull: rider.pull,
      pullUpTo: rider.pullUpTo,
      lift: rider.lift,
      reappearWithin: rider.reappearWithin,
      acAdjustment: rider.acAdjustment,
      oneAttack: rider.oneAttack,
      slowCasting: rider.slowCasting,
      linkedParent,
      duration: rider.duration,
      save: rider.save,
      escapeDc: rider.escapeDc,
      escapeAbilities: rider.escapeAbilities,
      escapeDisadvantage: rider.escapeDisadvantage,
      sourceDetachMovement: rider.sourceDetachMovement,
      sharesHolderDamage: rider.sharesHolderDamage,
      endsOnDamage: rider.endsOnDamage,
      endsOnSourceDamage: rider.endsOnSourceDamage,
      sourceDamageException: rider.sourceDamageException,
      willingFor: rider.willingFor,
      saveOnDamage: rider.saveOnDamage,
      saveOnDamageTypes: rider.saveOnDamageTypes,
      saveOnDamageAdvantage: rider.saveOnDamageAdvantage,
      transitionOnFailedSave: rider.transitionOnFailedSave,
      transitionEndsOnDamage: rider.transitionEndsOnDamage,
      transitionSaveEndsEachTurn: rider.transitionSaveEndsEachTurn,
      transitionRounds: rider.transitionRounds,
      delayedCondition: rider.delayedCondition?.condition,
      savesToEnd: rider.savesToEnd,
      speedZero: rider.speedZero,
      speedNotReduced: rider.speedNotReduced,
      speedCut: rider.speedCut,
      speedHalved: rider.speedHalved,
      endsThisTurn: rider.endsThisTurn,
      noReactions: rider.noReactions,
      noBonusActions: rider.noBonusActions,
      noVerbalSpells: rider.noVerbalSpells,
      moveOrAct: rider.moveOrAct,
      concentrationDisadvantage: rider.concentrationDisadvantage,
      actionOrBonus: rider.actionOrBonus,
      delayedDamage: rider.delayedDamage,
      delayedDueTurn: rider.delayedDamage ? (rider.delayedDamage.clock === "source" ? attackerState.turnCount : target.turnCount) + 1 : undefined,
      approachOnly: rider.approachOnly,
      escapeAttemptDamage: rider.escapeAttemptDamage,
      holdReach: anchored && rider.duration === "untilEscape" ? holdReach : undefined,
      endsOnHealingSpell: rider.endsOnHealingSpell,
      stanchDc: rider.stanchDc,
      startTurnDamage: rider.startTurnDamage,
      endTurnDamage: rider.endTurnDamage,
      sourceDamageEscapeThreshold: rider.sourceDamageEscapeThreshold,
      sourceDamageEscapeSaveDc: rider.sourceDamageEscapeSaveDc,
      magical,
      concentrationSource: concentration ? source : undefined,
      appliedTurn: rider.duration === "endOfSourceNextTurn" ? attackerState.turnCount : target.turnCount,
      endsSourceTurn: rider.rounds === undefined ? undefined : attackerState.turnCount + rider.rounds,
      source,
      immunity: rider.immuneOnSuccess ?? immunity,
      rollEffects: rider.rollEffects,
      blocksHealing: rider.blocksHealing,
      cannotStand: rider.cannotStand,
      blocksTeleport: rider.blocksTeleport,
      heldBy: rider.duration === "untilEscape" ? heldBy : undefined,
      breakable: rider.breakable ? liveObject(attackerState, rider.breakable, target, source) : undefined,
      endsOnReuse: rider.endsOnReuse,
      possession: rider.possession,
      controlRange: rider.controlRange,
      drawnToSource: rider.drawnToSource,
    };
    if (rider.possession) attackerState.possessing = true;
    target.conditions.push(applied);
    if (rider.condition === "exhaustion" && target.conditions.filter(c => c.name === "exhaustion").length >= 6) { target.slain = true; target.hp = 0; }
    if (applied.immunity && (applied.immunity.trigger === "saveOrEnd" || applied.immunity.trigger === "end")) {
      target.effectsHeld.add(applied.immunity.key);
    }
    newlyApplied.set(rider.condition, applied);
    // A push or pull is reported by its own line where it moves the target; one of 0 feet ("up to") reports nothing.
    if (log.on && !rider.push && !rider.pull) log.push(`${defender.name} gains ${rider.condition}`);
    if (log.on && rider.condition === "exhaustion" && target.slain) log.push(`${defender.name} dies of Exhaustion (level 6)`);
    // "The condition also ends if the grappler has the Incapacitated condition" (SRD 5.2.1, Grappling): the creature
    // that has just been incapacitated lets go of what it grapples, at this moment. `attackerState` is the other
    // fighter at every call site.
    if (RULES_INCAPACITATED.has(applied.name)) releaseHeld(attackerState, source === 0 ? 1 : 0, defender.name, "incapacitated", log);
    // A state that replaces another takes the other away with it: a swallow ends the grapple
    // that set it up, and the prose says so in as many words.
    if (rider.endsConditions?.length) {
      const named = target.conditions.filter((c) => rider.endsConditions!.includes(c.name) && c.name !== rider.condition);
      // And what rode on the hold ends with it. The Behir's Constrict Restrains "until the grapple ends", and
      // left behind it kept the swallow's own Restrained off as a duplicate: an escape from a grapple that no
      // longer existed then took the Restrained a swallowed creature has for as long as it is swallowed.
      // Never the condition this rider has just applied: one chewing attack Restrains until escape under the same DC
      // as the claw grapple it ends.
      const applied = target.conditions[target.conditions.length - 1];
      const holds = named.filter((c) => c.duration === "untilEscape" && c.escapeDc !== undefined);
      const riding = target.conditions.filter((c) => c !== applied && !named.includes(c) && c.duration === "untilEscape"
        && holds.some((hold) => hold.source === c.source && hold.escapeDc === c.escapeDc));
      const ended = [...named, ...riding];
      if (ended.length) {
        target.conditions = target.conditions.filter((c) => !ended.includes(c));
        pruneLinkedConditions(target);
        if (log.on) log.push(`${defender.name} is no longer ${[...new Set(ended.map((c) => c.name))].join(" or ")}`);
      }
    }
    // Stone is the end of the fight. Nothing in a duel undoes it — no greater restoration, no
    // ally to cast one — so it resolves the way an outright-death effect does rather than
    // sitting on the victim as a condition it might one day shake off.
    if (rider.condition === "petrified") {
      target.petrifiedDefeat = !isDown(defender, target);
      target.slain = true;
      if (log.on) log.push(`${defender.name} is turned to stone`);
    }
  }
}

/**
 * A hold ends when its holder cannot hold.
 *
 * - `"incapacitated"`: "The condition also ends if the grappler has the Incapacitated condition" (SRD 5.2.1, Grappling).
 *   The victim loses every condition the holder's own grapple keeps on (`heldBy: "grapple"`): the Grappled, what the
 *   print hangs on it (a Restrained "until the grapple ends"), their ticks, a pending `delayedCondition` and any linked
 *   child. An attachment, a swallow, a place-held Restrained and a detached grip print no such end and stay.
 * - `"down"` (`isDown`): a dead creature holds nothing. The grapple's conditions go as above, and so do an attachment's;
 *   and a creature swallowed by the holder is no longer Restrained when the swallower dies. It
 *   stays `swallowed`, inside the corpse, which it leaves by spending movement on a turn a duel never reaches.
 * Returns what ended.
 */
/** The object a use of this hold hangs on: the owner's one item, or a new object for this use. */
function liveObject(owner: FighterState, spec: BreakableObject, target: FighterState, source: 0 | 1): LiveObject {
  // The riders of one hold (a tentacle's Grappled and its Poisoned) hang on the one object.
  if (!spec.item) return target.conditions.find((c) => c.source === source && c.breakable?.spec === spec && c.breakable.hp > 0)?.breakable ?? { spec, hp: spec.hp };
  const items = owner.items ??= new Map<BreakableObject, LiveObject>();
  let live = items.get(spec);
  if (!live) items.set(spec, live = { spec, hp: spec.hp });
  return live;
}

/**
 * The conditions a cure can end on its caster, the costliest first. Not a copy that hangs on something still there (a
 * hold's rider, Blinded while a creature is attached, or what a swallow gives the creature inside): the spell ends the
 * condition, and what it hangs on applies it again.
 */
function curable(state: FighterState, names: string[]): ConditionState[] {
  const swallowedBy = new Set(state.conditions.filter((c) => c.name === "swallowed").map((c) => c.source));
  return names.flatMap((name) => state.conditions.filter((c) => c.name === name && c.duration !== "untilEscape" && !c.linkedParent && !swallowedBy.has(c.source)));
}

/** The largest share of a printed ability score that drains have taken off: 0 with none, 1 at a score of 0. */
function drainedShare(block: CombatStatblock, state: FighterState): number {
  return Math.max(0, ...Object.entries(state.drainedScores).map(([ability, score]) => 1 - score / Math.max(1, block.abilityScores?.[ability as Ability] ?? 10 + 2 * block.abilityMods[ability as Ability])));
}

/**
 * The one effect a restoration removes from its caster. A cure that reads "one condition" or "one of the following
 * effects" ends one: a condition that costs the caster something first (the first of them as printed), then drained
 * ability scores where the spell names them, then whatever else it can end. Lesser Restoration ends its first curable
 * condition as before when none of them is priced.
 */
function restored(block: CombatStatblock, state: FighterState, action: Extract<CombatAction, { kind: "selfheal" }>): ConditionState | "abilityScores" | undefined {
  const held = curable(state, action.curesConditions ?? []);
  const lifts = (names: string[]) => held.find((c) => liftedBy(state, c).some((name) => names.includes(name)));
  return lifts(["charmed"]) ?? lifts(["blinded", "poisoned", "exhaustion"])
    ?? (action.restoresAbilityScores && drainedShare(block, state) > 0 ? "abilityScores" as const : undefined)
    ?? held[0];
}

/** The conditions that end when a cure ends this one: itself and what hangs on it (a curse's Charmed and Poisoned). */
function liftedBy(state: FighterState, removed: ConditionState): string[] {
  return [removed, ...state.conditions.filter((c) => c.linkedParent === removed)].map((c) => c.name);
}

function releaseHeld(victim: FighterState, holder: 0 | 1, holderName: string, cause: "incapacitated" | "down", log: FightLog): ConditionState[] {
  const down = cause === "down";
  const swallowed = down && victim.conditions.some((c) => c.name === "swallowed" && c.source === holder);
  if (swallowed) for (const c of victim.conditions) {
    if (c.source === holder && c.name === "swallowed" && c.delayedDamage?.disgorge) c.delayedDamage = undefined;
  }
  const ended = victim.conditions.filter((c) => c.source === holder
    && (c.heldBy === "grapple" || (down && (c.heldBy === "attachment" || (swallowed && c.name === "restrained")))));
  if (!ended.length) return ended;
  victim.conditions = victim.conditions.filter((c) => !ended.includes(c));
  pruneLinkedConditions(victim);
  if (log.on) log.push(`${holderName} is ${cause} and its hold ends (${[...new Set(ended.map((c) => c.name))].join(", ")})`);
  return ended;
}

/** Each fighter that is incapacitated (the rules' condition, `RULES_INCAPACITATED`) lets go of what it grapples. */
function endGrapplesOfIncapacitated(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], log: FightLog): void {
  for (const holder of [0, 1] as const) {
    if (!isDown(blocks[holder], states[holder]) && hasAny(states[holder], RULES_INCAPACITATED)) {
      releaseHeld(states[holder === 0 ? 1 : 0], holder, blocks[holder].name, "incapacitated", log);
    }
  }
}

/** Each fighter that is down lets go of everything it holds. */
function endHoldsOfDowned(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], log: FightLog): void {
  for (const holder of [0, 1] as const) {
    if (isDown(blocks[holder], states[holder])) releaseHeld(states[holder === 0 ? 1 : 0], holder, blocks[holder].name, "down", log);
  }
}

/**
 * A follow-on that petrifies a still-Grappled target at the start of the source's next turn (`Rider.delayedCondition`).
 * Run as the source's turn starts: a pending follow-on
 * from this source lands only on a condition copy still on the target (an escape, a hold broken by distance or any other
 * end has removed it), and not while the source is incapacitated (a grappler's incapacitation ends its grapple). Cleared
 * at this first boundary whether or not it lands. Stone resolves as every other petrification does: the fight is over.
 */
function resolveDelayedConditions(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, log: FightLog): void {
  const targetIdx = actor === 0 ? 1 : 0;
  const target = states[targetIdx];
  const block = blocks[targetIdx];
  const pending = target.conditions.filter((c) => c.delayedCondition && c.source === actor);
  if (!pending.length) return;
  const sourceIncapacitated = hasAny(states[actor], RULES_INCAPACITATED);
  for (const condition of pending) {
    const follow = condition.delayedCondition!;
    condition.delayedCondition = undefined;
    if (sourceIncapacitated || block.conditionImmune.includes(follow) || isDown(block, target)) continue;
    if (follow === "petrified") {
      target.petrifiedDefeat = true;
      target.slain = true;
      if (log.on) log.push(`${block.name} is still ${condition.name} and is turned to stone`);
      return;
    }
    target.conditions.push({ name: follow, duration: "permanent", appliedTurn: target.turnCount, source: actor, magical: condition.magical });
    if (log.on) log.push(`${block.name} is still ${condition.name} and gains ${follow}`);
    // A follow-on that incapacitates its target ends that target's own grapples.
    if (RULES_INCAPACITATED.has(follow)) releaseHeld(states[actor], targetIdx, block.name, "incapacitated", log);
  }
}

function resolveEndTurnConditions(block: CombatStatblock, state: FighterState, rng: () => number, log: FightLog): void {
  const kept: ConditionState[] = [];
  for (const condition of state.conditions) {
    if (condition.duration === "endOfTargetTurn") continue;
    if (condition.duration === "endOfTargetNextTurn" && state.turnCount > condition.appliedTurn) continue;
    if (condition.endsOwnTurn !== undefined && state.turnCount >= condition.endsOwnTurn) {
      if (log.on) log.push(`${block.name} ends ${condition.name} (1 minute)`);
      continue;
    }
    if (condition.linkedParent) {
      kept.push(condition);
      continue;
    }
    if (condition.duration === "saveEndsEachTurn" && condition.save) {
      let saved = rollSave(block, state, condition.save.ability, condition.save.dc, !!condition.magical, rng, false, repeatSaveConditions(condition, state));
      // Only spend a Legendary Resistance on a repeat save that is actually worth it, mirroring
      // the `wouldHurt` gate on initial saves. Otherwise the pool drains on trivial conditions.
      // A basilisk's hold reads as a mild Restrained, but failing this save is what turns the
      // victim to stone, so the escalation is what the Legendary Resistance is really for.
      const worthResisting = linkedWorthResisting(condition, state);
      if (!saved && worthResisting && state.legendaryResistances > 0) {
        state.legendaryResistances--;
        saved = true;
        if (log.on) log.push(`${block.name} uses Legendary Resistance`);
      }
      if (saved) {
        grantSuccessImmunity(state, condition.immunity, "repeat", log, block);
        // Most effects end on the first success. Some effects take more than one,
        // and the count is kept on the condition rather than assumed, so a creature that saves
        // twice and then fails does not lose the ground it made.
        const made = (condition.savesMade ?? 0) + 1;
        if (condition.savesToEnd !== undefined && made < condition.savesToEnd) {
          if (log.on) log.push(`${block.name} resists ${condition.name} (${made} of ${condition.savesToEnd})`);
          condition.savesMade = made;
          kept.push(condition);
          continue;
        }
        if (log.on) log.push(`${block.name} ends ${condition.name}`);
        continue;
      }
      if (condition.transitionOnFailedSave) {
        // Immunity to what the condition would become stops the escalation without ending the
        // condition itself: a construct held by a petrifying gaze stays held, and stays stone-proof.
        if (block.conditionImmune.includes(condition.transitionOnFailedSave)) {
          kept.push(condition);
          continue;
        }
        if (condition.transitionOnFailedSave === "petrified") {
          state.petrifiedDefeat = !isDown(block, state);
          state.slain = true;
          if (log.on) log.push(`${block.name} is turned to stone`);
          continue;
        }
        // A second stage that prints its own repeat save keeps the first stage's (a Silver Dragon's Paralyzed
        // "repeats the save at the end of each of its turns"); any other escalated condition is permanent.
        const keepsSave = !!condition.transitionSaveEndsEachTurn && !!condition.save;
        kept.push({
          ...condition,
          name: condition.transitionOnFailedSave,
          duration: keepsSave ? "saveEndsEachTurn" : "permanent",
          save: keepsSave ? condition.save : undefined,
          transitionOnFailedSave: undefined,
          transitionSaveEndsEachTurn: undefined,
          transitionRounds: undefined,
          endsOwnTurn: condition.transitionRounds === undefined ? undefined : state.turnCount + condition.transitionRounds,
          // Sleep's unconsciousness ends on a slap; petrification's does not, and neither does
          // anything else that might be written this way later.
          endsOnDamage: !!condition.transitionEndsOnDamage,
          appliedTurn: state.turnCount,
        });
        if (log.on) log.push(`${block.name} falls ${condition.transitionOnFailedSave}`);
        continue;
      }
      if (log.on) log.push(`${block.name} fails to end ${condition.name}`);
    }
    kept.push(condition);
  }
  state.conditions = kept;
  pruneLinkedConditions(state, log, block.name);
}

/** The hold a creature is currently in, if any, with the roll it would have to make to break it. */
function escapeProspect(block: CombatStatblock, state: FighterState): { dc: number; bonus: number; checks: { ability: Ability; bonus: number }[]; checkDisadvantage: boolean; restrained: boolean; disadvantaging: boolean; tick: number; attemptDamage: DamageClause[]; magical: boolean; held: Set<string> } | undefined {
  const escapeConditions = state.conditions.filter((c) =>
    c.duration === "untilEscape" && c.escapeDc !== undefined && ["grappled", "restrained", "attached"].includes(c.name));
  if (!escapeConditions.length) return undefined;
  const dc = Math.max(...escapeConditions.map((c) => c.escapeDc || 0));
  const matching = state.conditions.filter((c) => c.duration === "untilEscape" && c.escapeDc === dc);
  const allowed = new Set<Ability>(matching.flatMap((c) => c.escapeAbilities || ["str", "dex"]));
  const bonuses: number[] = [];
  const checks: { ability: Ability; bonus: number }[] = [];
  if (allowed.has("str")) bonuses.push(block.skills.athletics ?? block.abilityMods.str);
  if (allowed.has("dex")) bonuses.push(block.skills.acrobatics ?? block.abilityMods.dex);
  if (allowed.has("str")) checks.push({ ability: "str", bonus: block.skills.athletics ?? block.abilityMods.str });
  if (allowed.has("dex")) checks.push({ ability: "dex", bonus: block.skills.acrobatics ?? block.abilityMods.dex });
  // Everything the escape would shed, not just the hold itself: a grapple that also poisons
  // (a tentacle attack that grapples and poisons) costs the victim far more than the Speed it takes away, and
  // one roll clears the lot.
  const shed = state.conditions
    .filter((c) => c.duration === "untilEscape" && c.escapeDc !== undefined && c.escapeDc <= dc);
  const removed = new Set(shed.map((c) => c.name));
  // And the damage the hold deals every turn it lasts. A gelatinous cube's engulf costs its
  // victim 3d6 acid a turn on top of the offence Restrained takes away, and nothing in this
  // heuristic used to read a tick at all: victims made the same decision they would have made
  // against an empty grapple and died of the acid.
  const tick = shed.reduce((sum, c) =>
    sum + expectedDamage(c.startTurnDamage || [], block, !!c.magical) + expectedDamage(c.endTurnDamage || [], block, !!c.magical), 0);
  // What the attempt itself costs. A harpoon charges its victim 1d10 for pulling on the rope
  // whether the pull works or not, which is the one hold in the corpus where trying is not free.
  const attemptDamage = shed.flatMap((c) => c.escapeAttemptDamage || []);
  return {
    dc,
    bonus: Math.max(...bonuses),
    checks,
    // "Ability checks made to escape this grapple have Disadvantage": printed on a hold whose DC is rolled against.
    checkDisadvantage: matching.some((c) => c.escapeDisadvantage),
    restrained: removed.has("restrained"),
    disadvantaging: ["poisoned", "blinded", "frightened", "fearSpell"].some((name) => removed.has(name)),
    tick,
    attemptDamage,
    magical: shed.some((c) => c.magical),
    held: removed,
  };
}

/**
 * How far the limb or line that applies this action's hold reaches before it is thrown.
 *
 * Melee reach for a tentacle, normal range for a thrown line, the stated range for a save-based
 * grab. `holdReachAt` lengthens it to the throw that actually landed.
 */
function holdReachOf(action: CombatAction): number | undefined {
  if (action.kind === "random") {
    const reaches = action.branches.map(holdReachOf).filter((r): r is number => r !== undefined);
    return reaches.length ? Math.max(...reaches) : undefined;
  }
  if (action.kind === "attack") {
    if (action.melee) return action.reach ?? 5;
    return action.range ?? action.longRange;
  }
  if (action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return undefined;
  return action.range;
}

/**
 * The reach of a hold made at `distance`. Neither harpoon states a rope length, and both say a hit grapples,
 * so a throw that lands at 150 feet holds on 150 feet of line, and the target "can't move farther" than it
 * already is. Held to the normal range instead, it put the pair 150 feet apart on a 50-foot rope. A melee
 * grab never lands beyond its reach, so only a throw past its normal range is lengthened.
 */
function holdReachAt(action: CombatAction, distance: number): number | undefined {
  const reach = holdReachOf(action);
  return reach === undefined ? undefined : Math.max(reach, distance);
}

/** Conditions an action applies as a hold that has to be escaped. */
function holdConditions(action: CombatAction): string[] {
  if (action.kind === "random") return action.branches.flatMap(holdConditions);
  if (!("riders" in action)) return [];
  const riders = [...(action.riders || []), ...(action.kind === "attack" ? action.extraSave?.riders || [] : [])];
  return riders.filter((rider) => rider.duration === "untilEscape").map((rider) => rider.condition);
}

/** The conditions `block`'s swallows grant beside being swallowed: Blinded and Restrained for the victim. */
function swallowGrants(block: CombatStatblock): Set<string> {
  const ridersOf = (action: CombatAction): Rider[] => {
    if (action.kind === "random") return action.branches.flatMap(ridersOf);
    if (!("riders" in action)) return [];
    return [...(action.riders || []), ...(action.kind === "attack" ? action.extraSave?.riders || [] : [])];
  };
  const grants = new Set<string>();
  // Legendary options are references into `options`, so the options are every swallow there is.
  for (const option of block.options) {
    const riders = ridersOf(option.action);
    if (!riders.some((rider) => rider.condition === "swallowed")) continue;
    for (const rider of riders) if (rider.condition !== "swallowed") grants.add(rider.condition);
  }
  return grants;
}

/**
 * The share of turns on which a foe that can put its hold back at will fails to: every attack that carries the hold
 * misses, or the save is made. The option is counted as often as the foe's routines use it (a Chain Devil's two Chains
 * against a Young Red Dragon: 0.45 squared; a Couatl's one Constrict against a Gold Dragon Wyrmling's Strength: 0.5).
 */
function reapplyMissChance(foe: CombatStatblock, foeState: FighterState, block: CombatStatblock, held: Set<string>, distance: number): number {
  let misses = 1;
  foe.options.forEach((option, optionIdx) => {
    const action = option.action;
    if (option.uses.t !== "atWill" || option.timing === "legendary" || !usable(foeState, optionIdx, option) || !actionInRange(action, distance)
      || !holdConditions(action).some((condition) => held.has(condition))) return;
    const once = action.kind === "attack" ? 1 - hitChance(action.toHit, block.ac)
      : action.kind === "save" ? 1 - saveFailChance(action.dc, block.saves[action.ability] ?? block.abilityMods[action.ability], actionSaveMode(action, block))
        : 0;
    const count = Math.max(1, ...foe.routines.map((routine) => routine.parts.reduce((sum, part) => sum + (part.optionIdx === optionIdx ? part.count : 0), 0)));
    misses = Math.min(misses, once ** count);
  });
  return misses;
}

/**
 * Can the foe simply put this hold straight back on next turn, for free?
 *
 * This is what decides whether an escape buys anything at all. A gelatinous cube re-engulfs at
 * will, so a creature that spends its action breaking out is caught again before it ever swings,
 * and has paid a turn for nothing. Only at-will options count: a hold on a recharge may not come
 * back, and treating a 1-in-3 recharge as certain would talk creatures out of escapes worth making.
 */
function foeCanReapplyHold(
  foe: CombatStatblock,
  foeState: FighterState,
  held: Set<string>,
  distance: number,
): boolean {
  return foe.options.some((option, optionIdx) =>
    option.uses.t === "atWill"
    && option.timing !== "legendary"
    && usable(foeState, optionIdx, option)
    && actionInRange(option.action, distance)
    && holdConditions(option.action).some((condition) => held.has(condition)));
}

/**
 * The best routine's static EV at `distance`, counting only the parts `usable` allows now: the same parts rule as the
 * action chooser (`bestUsableRoutinesAtDistance`), priced with the static evaluator. A routine with no usable part is
 * worth nothing, and its all-hits effect counts only while its usable attacks can still land every required hit. With
 * every option usable this is exactly `bestRoutineEvAtDistance(..., true)`.
 */
function usableRoutineEvAtDistance(block: CombatStatblock, foe: CombatStatblock, state: FighterState, distance: number, evaluator: PairEvaluator): number {
  if (!block.heads && block.options.every((option, idx) => usable(state, idx, option))) return evaluator.bestRoutineEvAtDistance(block, foe, distance, true);
  let best = 0;
  for (const routine of block.routines) {
    const parts = routine.parts.map(part => part.perHead ? { ...part, count: state.heads ?? part.count } : part).filter((part) => {
      const option = block.options[part.optionIdx];
      return option !== undefined && usable(state, part.optionIdx, option);
    });
    if (!parts.length) continue;
    const attacks = parts.reduce((sum, part) => sum + (block.options[part.optionIdx].action.kind === "attack" ? part.count : 0), 0);
    const onAllHits = routine.onAllHits && attacks >= routine.onAllHits.requiredHits ? routine.onAllHits : undefined;
    const trimmed: Routine = parts.every((part, i) => part === routine.parts[i]) && parts.length === routine.parts.length && onAllHits === routine.onAllHits ? routine : { ...routine, parts, onAllHits };
    best = Math.max(best, rawRoutineEvAtDistance(trimmed, block, foe, distance, true));
  }
  return best;
}

/**
 * The foe's answer at `distance` (`bestRoutineEvAtDistance` with no limited use) without the parts `target` is immune to
 * for the fight by a made save (`immuneOnSuccess`). The static price cannot see that immunity: a Mummy's Dreadful Glare
 * still counted as an answer to a Hobgoblin Warrior that had saved against it, so the Warrior never Dashed clear (O03).
 */
function answerEvAtDistance(block: CombatStatblock, foe: CombatStatblock, target: FighterState, distance: number, evaluator: PairEvaluator): number {
  const spent = (idx: number): boolean => {
    const action = block.options[idx]?.action;
    return action?.kind === "save" && successImmune(target, action.immuneOnSuccess);
  };
  if (!block.options.some((_, idx) => spent(idx))) return evaluator.bestRoutineEvAtDistance(block, foe, distance, false);
  let best = 0;
  for (const routine of block.routines) {
    const parts = routine.parts.filter((part) => !spent(part.optionIdx));
    if (!parts.length) continue;
    best = Math.max(best, rawRoutineEvAtDistance(parts.length === routine.parts.length ? routine : { ...routine, parts }, block, foe, distance, false));
  }
  return best;
}

/** The best usable routine counting only its parts that make no attack roll (a save, an automatic hit). */
function rollFreeRoutineEvAtDistance(block: CombatStatblock, foe: CombatStatblock, state: FighterState, distance: number, evaluator: PairEvaluator): number {
  let best = 0;
  for (const routine of block.routines) {
    let ev = 0;
    for (const part of routine.parts) {
      const option = block.options[part.optionIdx];
      if (!option || option.action.kind === "attack" || !usable(state, part.optionIdx, option)) continue;
      ev += part.count * evaluator.actionEvAtDistance(option.action, block, foe, distance);
    }
    best = Math.max(best, ev);
  }
  return best;
}

/**
 * Whether every hold the creature is in is an attachment that does not pin it. Its holds are its `untilEscape`
 * Grappled, Restrained and `attached` conditions. An attachment that comes with one of the others (an attacher that also
 * Restrains), or that carries a stop or a tether of its own, pins; a condition that only rides it (a Blinded
 * from a clinging creature) does not.
 */
function heldOnlyByAttachment(state: FighterState): boolean {
  const holds = state.conditions.filter((c) =>
    c.duration === "untilEscape" && ["grappled", "restrained", "attached"].includes(c.name));
  return holds.length > 0 && holds.every((c) => c.name === "attached" && !c.speedZero && c.holdReach === undefined);
}

/**
 * Is breaking this hold worth the action it costs?
 *
 * Being Restrained is expensive — it hands the attacker advantage and takes the victim's own
 * away — but "expensive" is not the same as "always worth an action to escape", which is what
 * this used to assume. Two things make that assumption fail badly.
 *
 * A roll that will not land buys nothing: a creature pinned by a high-DC hold at DC 26
 * has about a one-in-twenty chance, and spending every turn on it is worse than swinging at
 * disadvantage. And a hold the foe re-applies for free is worth escaping at most once: an
 * allosaurus that breaks out of a gelatinous cube is engulfed again before its next turn, so it
 * spends the whole fight escaping instead of biting. That second case was not hypothetical —
 * giving engulfs their real escape DC made the *cube* stronger, which is what prompted this.
 *
 * So the escape is priced like any other action. What it wins is the position it opens up plus
 * what the hold costs per turn, offence and defence both, over however many turns the freedom
 * is likely to last; all of that times the odds of making the roll. What it costs is the turn of
 * attacking it replaces.
 */
function escapeWorthwhile(
  block: CombatStatblock,
  foe: CombatStatblock,
  state: FighterState,
  foeState: FighterState,
  engagement: EngagementState,
  evaluator: PairEvaluator,
  certain = false,
): boolean {
  const prospect = escapeProspect(block, state);
  // `certain`: the way out needs no roll (a teleport that takes the action, `teleportEscapeStep`).
  if (!prospect) return certain;
  // The better of the checks it may make, under any check effect it holds: with none,
  // the flat chance of the larger bonus.
  const odds = certain ? 1 : Math.max(...prospect.checks.map((check) => checkOdds(state, check.ability, check.bonus, prospect.dc, prospect.checkDisadvantage)));
  if (odds <= 0) return false;
  const stakes = holdStakes(block, foe, state, foeState, engagement, evaluator, prospect);
  // Nothing to do from where it stands: any chance of getting out beats none.
  if (stakes.hereEv <= 0) return true;
  const reapplies = foeCanReapplyHold(foe, foeState, prospect.held, engagement.distance);
  const horizon = reapplies ? 1 : stakes.fightHorizon;
  // Pulling on a harpoon's rope costs 1d10 win or lose, so the turn it replaces is not the
  // whole price of trying.
  const attemptCost = expectedDamage(prospect.attemptDamage, block, prospect.magical);
  // An attack the hold itself bars ("Proboscis" needs a target the stirge is not attached to) comes back with the
  // escape: the turn of drain it saves is paid for with the hit that puts the hold back. A Camel detached a Stirge
  // every round, was stung again, and never bit the 5 Hit Points hanging from it.
  const reopened = !reapplies ? 0 : Math.max(0, ...foe.options.map((option, idx) =>
    option.uses.t === "atWill" && option.timing !== "legendary" && usable(foeState, idx, option)
    && actionInRange(option.action, engagement.distance)
    && holdConditions(option.action).some((condition) => prospect.held.has(condition))
    && "requiresTargetMissingConditions" in option.action
    && option.action.requiresTargetMissingConditions?.some((condition) => prospect.held.has(condition))
      ? evaluator.actionEvAtDistance(option.action, foe, block, engagement.distance) : 0));
  // A hold the foe puts back on its turn frees none of the creature's own attacks and buys it no square unless the
  // foe then misses: what the escape surely wins is the foe's turn without the hold's Advantage and one turn of the
  // hold's damage, and the rest counts for the turns the hold stays off (`reapplyMissChance`). A Young Red Dragon held by a Chain
  // Devil (reach 10, two Chains a turn) escaped eight times in nine rounds and never used a Rend.
  if (reapplies) {
    // Free turns to come: one if the foe's first try fails, another if its second does too, and so on, within the fight.
    const misses = reapplyMissChance(foe, foeState, block, prospect.held, engagement.distance);
    const freeTurns = misses >= 1 ? stakes.fightHorizon : Math.min(stakes.fightHorizon, misses / (1 - misses));
    return odds * (stakes.foeShare + freeTurns * (stakes.positionalGain + stakes.perTurn - stakes.foeShare) - reopened) > stakes.hereEv + attemptCost;
  }
  return odds * (stakes.positionalGain + horizon * stakes.perTurn - reopened) > stakes.hereEv + attemptCost;
}

/**
 * What a hold costs its victim and what leaving it would win, for `escapeWorthwhile` and `breakPlan`: what the creature
 * can do from where it stands (`hereEv`), the position freedom opens up, the hold's cost every turn it lasts, and how
 * many turns the fight has left to enjoy the freedom (capped).
 */
function holdStakes(
  block: CombatStatblock,
  foe: CombatStatblock,
  state: FighterState,
  foeState: FighterState,
  engagement: EngagementState,
  evaluator: PairEvaluator,
  prospect: { restrained: boolean; disadvantaging: boolean; tick: number },
): { hereEv: number; positionalGain: number; perTurn: number; foeShare: number; fightHorizon: number; turnsLeft: number } {
  // The static evaluator does not know the creature's own condition, so discount what staying is
  // worth by the same factor `dynamicEv` uses. Restrained belongs here alongside Poisoned: it is
  // disadvantage on every attack roll the creature makes.
  const hampered = prospect.restrained || prospect.disadvantaging;
  const freeEv = evaluator.bestRoutineEvAtDistance(block, foe, engagement.distance, true);
  const factor = hampered ? DISADVANTAGE_EV : 1;
  // What staying is worth is what the creature can use this turn: a spent Web or a cast Insect Plague is not
  // something to do from where it stands. A creature held out of its
  // bite's reach with every limited option spent priced staying at its full static routine and sat out five rounds.
  // The hold's per-turn cost below still reads the static value: it prices the turns the freedom lasts, over which
  // a recharge may come back.
  // The hold's Disadvantage is on attack rolls: a save or an automatic hit made from inside it is worth what it always
  // is. A Young Bronze Dragon in a Drider's Web rolled to escape for two rounds with Lightning Breath ready at 30 feet.
  const hereEv = Math.max(usableRoutineEvAtDistance(block, foe, state, engagement.distance, evaluator) * factor,
    hampered ? rollFreeRoutineEvAtDistance(block, foe, state, engagement.distance, evaluator) : 0);
  if (hereEv <= 0) return { hereEv, positionalGain: 0, perTurn: 0, foeShare: 0, fightHorizon: 1, turnsLeft: 1 };
  // The same yardstick `teleportEv` uses to price a square: what it is worth standing there,
  // less what standing there costs.
  // What standing there costs is what the foe does on its turn, and its turn starts with its own move: a square its
  // Speed covers is no farther from its bite than this one. Priced from the square alone, an Earth Elemental held by
  // a Giant Crocodile saw 10 feet (its Slam's reach, outside the Bite's) as a free turn and spent its fights escaping.
  const foeStride = nextTurnSpeed(foe, foeState);
  const netAt = (d: number): number =>
    evaluator.bestRoutineEvAtDistance(block, foe, d, true)
    - Math.max(evaluator.bestRoutineEvAtDistance(foe, block, d, false), evaluator.bestRoutineEvAtDistance(foe, block, Math.max(engagement.distance, d - foeStride), false))
      * 0.7 * threatFactor(foe, foeState);
  let bestElsewhere = netAt(engagement.distance);
  // The Speed it would have once free: the block's, less the partial cuts it holds.
  for (const ground of moveCandidates(block, foe, engagement.ground, cutSpeed(block, state), engagement.maxDistance, sightBoundaries(block, state, foe, foeState))) {
    bestElsewhere = Math.max(bestElsewhere, netAt(Math.max(ground, verticalGap(block, state.height, foe, foeState.height))));
  }
  // A hold that does not pin its victim buys no position by being left: an attached creature rides its victim, which
  // can walk to any of those squares with it still on.
  const positionalGain = heldOnlyByAttachment(state) ? 0 : bestElsewhere - netAt(engagement.distance);
  // What the hold costs every turn it lasts, once position is set aside: the share of its own
  // offence it takes away, plus — for Restrained — the advantage it hands the foe, plus the
  // damage it deals for as long as it is on.
  const foeEv = evaluator.bestRoutineEvAtDistance(foe, block, engagement.distance, false) * threatFactor(foe, foeState);
  // The part of that the foe's turn takes: the Advantage the hold hands it and the hold's own damage.
  const foeShare = (prospect.restrained ? foeEv * (ADVANTAGE_EV - 1) : 0) + prospect.tick;
  const perTurn = (freeEv - freeEv * factor) + foeShare;
  // How many turns the freedom is worth having: however long the fight has left,
  // capped because a single escape roll should not be priced off a twenty-round projection. (A hold the foe can
  // re-apply at will from where it stands is worth one turn at best; the caller decides that.)
  const turnsLeft = Math.min(
    foeState.hp / Math.max(1, freeEv),
    state.hp / Math.max(1, foeEv),
  );
  return { hereEv, positionalGain, perTurn, foeShare, fightHorizon: Math.max(1, Math.min(ESCAPE_HORIZON_TURNS, turnsLeft)), turnsLeft };
}

/** The intact object a creature is held by (`Rider.breakable`), if any. */
function heldObject(state: FighterState): LiveObject | undefined {
  return state.conditions.find((c) => c.breakable && c.breakable.hp > 0 && c.duration === "untilEscape")?.breakable;
}

/**
 * What one hit of this option deals to an object, on average: its unconditional damage, none of a type the object is
 * immune to and double of a type it is vulnerable to. Only an at-will attack roll is aimed at an object; a save
 * effect names creatures, and a limited use is not spent on a web.
 */
function objectDamage(option: ActionOption | undefined, object: BreakableObject, roll?: { rng: () => number; crit: boolean }): number {
  if (!option || option.action.kind !== "attack" || option.uses.t !== "atWill" || option.timing !== "action") return 0;
  let total = 0;
  for (const clause of option.action.damage) {
    if (Object.keys(clause).some((key) => !["dice", "type", "typeChoices", "bypassResistance"].includes(key))) continue;
    const type = [clause.type, ...(clause.typeChoices ?? [])].find((t) => !object.immune.includes(t));
    if (type === undefined) continue;
    total += Math.max(0, roll ? rollDice(clause.dice, roll.rng, roll.crit) : avgDice(clause.dice)) * (object.vulnerable.includes(type) ? 2 : 1);
  }
  return total;
}

/** Whether the held creature's attack roll at the object it is held by has Advantage or Disadvantage. */
function objectAttackMode(block: CombatStatblock, state: FighterState, action: AttackAction): { adv: boolean; dis: boolean; effects: ReturnType<typeof heldRollEffects> } {
  const effects = heldRollEffects(state, "attack", undefined, reliesOnStrength(block, action));
  return {
    adv: !!block.attackAdvantage || hasCondition(state, "aiming") || effects.some(({ effect }) => effect.mode === "advantage"),
    dis: effects.some(({ effect }) => effect.mode === "disadvantage") || !!block.attackDisadvantage
      || ["frightened", "fearSpell", "poisoned", "restrained", "blinded"].some((name) => hasCondition(state, name)) || isProne(state),
    effects,
  };
}

/**
 * Whether the held creature turns its attacks on the object that holds it this turn, and with which routine.
 *
 * The print gives no check against such a hold: the object has an AC and Hit Points and the hold ends when it is
 * destroyed. The object is in the held creature's space, so every attack it has reaches it. The routine that deals the
 * object the most expected damage is priced like an escape: `turns` is how long destroying it should take, the hold
 * costs `perTurn` for as long as it lasts, and the attacks spent on the object are not made at the foe. A new web the
 * foe can spin at will is worth one turn of freedom; an item (a rope) cannot be used again once destroyed, so its
 * destruction is worth the rest of the fight (uncapped). A creature with nothing else to do attacks the object whenever it can
 * hurt it; one that cannot hurt it stays held.
 */
function breakPlan(
  block: CombatStatblock,
  foe: CombatStatblock,
  state: FighterState,
  foeState: FighterState,
  engagement: EngagementState,
  evaluator: PairEvaluator,
): Routine | undefined {
  const object = heldObject(state);
  if (!object) return undefined;
  const { best, bestDamage } = objectRoutine(block, state, object);
  if (!best) return undefined;
  const held = state.conditions.filter((c) => c.breakable === object);
  const names = new Set(held.map((c) => c.name));
  const stakes = holdStakes(block, foe, state, foeState, engagement, evaluator, {
    restrained: names.has("restrained"),
    disadvantaging: ["poisoned", "blinded", "frightened", "fearSpell"].some((name) => names.has(name)),
    tick: held.reduce((sum, c) => sum + expectedDamage(c.startTurnDamage || [], block, !!c.magical) + expectedDamage(c.endTurnDamage || [], block, !!c.magical), 0),
  });
  if (stakes.hereEv <= 0) return best;
  const turns = object.hp / bestDamage;
  // Damage to an item stays on it, so its destruction is weighed over the whole fight left, not the capped horizon.
  const horizon = object.spec.item ? Math.max(1, stakes.turnsLeft) : foeCanReapplyHold(foe, foeState, names, engagement.distance) ? 1 : stakes.fightHorizon;
  return turns < horizon && (horizon - turns) * stakes.perTurn + stakes.positionalGain > Math.min(1, turns) * stakes.hereEv ? best : undefined;
}

/** The routine that deals the object the most expected damage in one turn, and that damage. */
function objectRoutine(block: CombatStatblock, state: FighterState, object: LiveObject): { best?: Routine; bestDamage: number } {
  let best: Routine | undefined, bestDamage = 0;
  for (const routine of block.routines) {
    let damage = 0;
    for (const part of routine.parts) {
      const option = block.options[part.optionIdx];
      // No hit takes more off the object than it has left: 25 a swing is 10 against a tentacle with 10 Hit Points.
      const perHit = Math.min(objectDamage(option, object.spec), object.hp);
      if (perHit <= 0 || !usable(state, part.optionIdx, option)) continue;
      const action = option.action as AttackAction;
      const mode = objectAttackMode(block, state, action);
      const hit = hitChance(action.toHit, object.spec.ac);
      damage += (part.perHead ? state.heads ?? part.count : part.count) * perHit * (mode.adv === mode.dis ? hit : mode.adv ? 1 - (1 - hit) ** 2 : hit ** 2);
    }
    if (damage > bestDamage) { best = routine; bestDamage = damage; }
  }
  return { best, bestDamage };
}

/**
 * A hold with an escape check and a destructible object both (a roper's tentacle): whether the held creature attacks
 * the object instead of making the check. It does when `breakPlan` would attack it and the share of the object's Hit
 * Points its routine is expected to deal this turn is at least the odds of the check. Ties go to the attacks: the ones
 * left once the object is destroyed are still made.
 */
function breaksRatherThanEscapes(
  block: CombatStatblock, foe: CombatStatblock, state: FighterState, foeState: FighterState,
  engagement: EngagementState, evaluator: PairEvaluator,
): boolean {
  const object = heldObject(state);
  const prospect = escapeProspect(block, state);
  if (!object || !prospect || !breakPlan(block, foe, state, foeState, engagement, evaluator)) return false;
  const odds = Math.max(...prospect.checks.map((check) => checkOdds(state, check.ability, check.bonus, prospect.dc, prospect.checkDisadvantage)));
  return Math.min(1, objectRoutine(block, state, object).bestDamage / object.hp) >= odds;
}

/**
 * One attack roll at the object the creature is held by. A hit takes the damage off the object; at 0 Hit Points every
 * hold that hangs on it ends, and an item's owner loses the options that need it for the rest of the fight.
 */
function strikeObject(
  block: CombatStatblock,
  foe: CombatStatblock,
  state: FighterState,
  foeState: FighterState,
  option: ActionOption,
  object: LiveObject,
  rng: () => number,
  log: FightLog,
): void {
  const action = option.action as AttackAction;
  const mode = objectAttackMode(block, state, action);
  const r1 = d20(rng);
  const r2 = mode.adv !== mode.dis ? d20(rng) : r1;
  const roll = mode.adv && !mode.dis ? Math.max(r1, r2) : mode.dis && !mode.adv ? Math.min(r1, r2) : r1;
  const total = roll + action.toHit - rollEffectPenalty(mode.effects, rng);
  state.conditions = state.conditions.filter((c) => c.name !== "aiming");
  pruneLinkedConditions(state);
  spendNextRollEffects(state, mode.effects, log, block);
  breakInvisibility(state, block, log);
  if (roll === 1 || (roll !== 20 && total < object.spec.ac)) {
    if (log.on) log.push(`${block.name} misses the ${object.spec.name}`);
    return;
  }
  const dealt = objectDamage(option, object.spec, { rng, crit: roll === 20 });
  object.hp = Math.max(0, object.hp - dealt);
  if (log.on) log.push(`${block.name} hits the ${object.spec.name} for ${dealt} (${object.hp} hp)`);
  if (object.hp > 0) return;
  const ended = state.conditions.filter((c) => c.breakable === object);
  state.conditions = state.conditions.filter((c) => !ended.includes(c));
  pruneLinkedConditions(state);
  if (log.on) log.push(`The ${object.spec.name} is destroyed and ${block.name} is no longer ${[...new Set(ended.map((c) => c.name))].join(" or ")}`);
  if (!object.spec.item) return;
  foe.options.forEach((other, idx) => {
    if ("riders" in other.action && other.action.riders?.some((rider) => rider.breakable === object.spec)) foeState.depleted.add(idx);
  });
}

/** Spend an action when up to three future ticks saved, weighted by check odds, exceed the best action. */
function stanchIfWorthwhile(block: CombatStatblock, foe: CombatStatblock, state: FighterState, foeState: FighterState,
  source: 0 | 1, distance: number, evaluator: PairEvaluator, rng: () => number, log: FightLog, bonusAvailable = true): boolean {
  const wound = state.conditions.find(c => c.stanchDc !== undefined);
  if (!wound || hasAny(state, RULES_INCAPACITATED)) return false;
  const bonus = block.skills.medicine ?? block.abilityMods.wis;
  // A usable bonus-action healing spell closes the wound without surrendering the attack.
  if (bonusAvailable && state.hp < state.maxHp && !healBlocked(state) && block.options.some((o, i) => o.timing === "bonus"
    && usable(state, i, o) && o.action.kind === "selfheal" && o.action.spell && avgDice(o.action.healing) > 0)) return false;
  const turnsLeft = wound.endsSourceTurn === undefined ? 3 : wound.endsSourceTurn - (wound.source === source ? state : foeState).turnCount;
  const tick = (wound.startTurnDamage ?? []).reduce((sum, d) => sum + avgDice(d.dice), 0);
  // The attack given up is the one this turn's walk reaches, not only the one from where the creature stands: a Wyvern
  // (reach 5) held at 10 feet by a Horned Devil's tail stanched at one chance in four instead of stepping in to Bite and
  // Sting.
  const walked = Math.max(Math.min(distance, MIN_SEPARATION), distance - movementSpeed(block, state));
  const attack = Math.max(bestUsableRoutinesAtDistance(block, foe, state, foeState, source, distance, evaluator).any.ev,
    walked < distance ? bestUsableRoutinesAtDistance(block, foe, state, foeState, source, walked, evaluator).any.ev : 0);
  if (checkOdds(state, "wis", bonus, wound.stanchDc!) * tick * Math.min(3, Math.max(0, turnsLeft)) <= attack) return false;
  const held = heldRollEffects(state, "check", "wis");
  const adv = held.some(({ effect }) => effect.mode === "advantage");
  const dis = held.some(({ effect }) => effect.mode === "disadvantage") || checkDisadvantageSources(state).length > 0;
  const first = d20(rng), second = adv !== dis ? d20(rng) : first;
  const rolled = adv && !dis ? Math.max(first, second) : dis && !adv ? Math.min(first, second) : first;
  const success = rolled + bonus - rollEffectPenalty(held, rng) >= wound.stanchDc!;
  spendNextRollEffects(state, held, log, block);
  if (success) state.conditions = state.conditions.filter(c => c !== wound);
  if (log.on) log.push(`${block.name} attempts to stanch its wound (DC ${wound.stanchDc}): ${success ? "success" : "failure"}`);
  return true;
}

/** Attempting to escape movement-denying conditions consumes the action, win or lose. */
function attemptEscapeIfNeeded(block: CombatStatblock, state: FighterState, rng: () => number, log: FightLog): boolean {
  const prospect = escapeProspect(block, state);
  if (!prospect) return false;
  const { dc } = prospect;
  // The check with the better odds (with no check effect held, the larger bonus, as before); its roll effects apply
  // (Phantasmal Killer's Disadvantage, a disoriented creature's die, a weakened one's Strength).
  const check = prospect.checks.reduce((best, candidate) =>
    checkOdds(state, candidate.ability, candidate.bonus, dc, prospect.checkDisadvantage) > checkOdds(state, best.ability, best.bonus, dc, prospect.checkDisadvantage) ? candidate : best);
  const held = heldRollEffects(state, "check", check.ability);
  const adv = held.some(({ effect }) => effect.mode === "advantage");
  // The escape is an ability check: a Poisoned or Frightened creature makes it with Disadvantage, and so does one in a
  // hold whose stat block gives the escape DC with disadvantage. The same sources as `checkOdds`.
  const disadvantaged = checkDisadvantageSources(state, prospect.checkDisadvantage);
  const dis = held.some(({ effect }) => effect.mode === "disadvantage") || disadvantaged.length > 0;
  if (disadvantaged.length && log.on) {
    log.push(adv
      ? `${block.name}'s escape check has Advantage and Disadvantage (${disadvantaged.join(", ")}): one d20`
      : `${block.name} makes its escape check with Disadvantage (${disadvantaged.join(", ")})`);
  }
  const r1 = d20(rng);
  const r2 = adv !== dis ? d20(rng) : r1;
  const roll = adv && !dis ? Math.max(r1, r2) : dis && !adv ? Math.min(r1, r2) : r1;
  const checkTotal = roll + check.bonus - rollEffectPenalty(held, rng);
  const escaped = checkTotal >= dc || rollBoosted(block, state, dc - checkTotal);
  spendNextRollEffects(state, held, log, block);
  if (escaped) {
    state.conditions = state.conditions.filter((c) => !(c.duration === "untilEscape" && c.escapeDc !== undefined && c.escapeDc <= dc));
    pruneLinkedConditions(state);
    if (log.on) log.push(`${block.name} escapes (DC ${dc})`);
  } else {
    if (log.on) log.push(`${block.name} fails to escape (DC ${dc})`);
  }
  // The toll applies to the attempt to escape, whether it succeeds or fails,
  // so it is charged after the roll either way, and after a successful escape has already
  // shed the hold that charges it.
  if (prospect.attemptDamage.length) {
    const barb: CombatAction = { kind: "autohit", damage: prospect.attemptDamage, magical: prospect.magical };
    applyDamage(state, block, barb, rng, false, log);
  }
  return true;
}

/**
 * Current Speed, before subtracting movement already spent (such as standing up).
 *
 * A hold that says its own Speed is untouched is skipped by name as well as by flag: both
 * harpoons in the corpus apply Grappled and then spend a sentence saying the victim's Speed
 * isn't reduced, and taking the name at face value pinned a creature the source lets walk.
 */
function currentSpeed(block: CombatStatblock, state: FighterState): number {
  if (state.possessing) return 0;
  // Crawling: each foot of movement costs 1 extra foot (SRD 5.2.1), so a Speed's worth of movement is half a Speed of
  // ground, for the move and for a Dash's second Speed alike. From the turn the creature starts Prone and unable to stand
  // (`standIfProne`), for as long as that holds.
  const speed = speedBeforeCrawl(block, state);
  if (state.crawling && isProne(state) && cannotStand(state)) return Math.floor(speed / 2);
  return speed;
}

/** Current Speed before the crawl's halving: 0 under a stop (a pinning condition, `speedZero`), else the cut Speed. */
function speedBeforeCrawl(block: CombatStatblock, state: FighterState): number {
  const stops = state.conditions.some((c) => !c.speedNotReduced && (SPEED_ZERO.has(c.name) || c.speedZero));
  return stops ? 0 : cutSpeed(block, state);
}

/** Draws the defender up to `feet` straight toward the attacker, along the line between them, never into its space. */
function reelToward(attacker: CombatStatblock, aState: FighterState, defender: CombatStatblock, dState: FighterState, engagement: EngagementState, feet: number): void {
  const path = Math.max(engagement.ground, Math.abs(dState.height - aState.height));
  const scale = path > 0 ? Math.max(0, path - feet) / path : 0;
  dState.height = aState.height + (dState.height - aState.height) * scale;
  engagement.ground = Math.max(groundFloor(attacker, aState, aState.height, defender, dState), engagement.ground * scale);
  engagement.distance = separation(attacker, aState.height, defender, dState.height, engagement.ground);
}

/**
 * How far the attacker draws a target it may pull "up to" `feet` straight toward itself: its choice, in 5-foot steps,
 * nothing included. Each length is scored by what the two can do from where it leaves them: the attacker's best usable
 * routine less the target's, each over the separations its own Speed reaches from there (staying, closing or opening by
 * a Speed), plus the fall of a target with no Fly Speed that the pull lifts (3.5 a 10 feet, `settleFlight`). Ties go to
 * the longer pull, so a pull that changes nothing either way is made in full.
 */
function choosePull(attacker: CombatStatblock, aState: FighterState, defender: CombatStatblock, dState: FighterState, engagement: EngagementState, feet: number, evaluator: PairEvaluator): number {
  const reach = (block: CombatStatblock, foe: CombatStatblock, state: FighterState, distance: number): number => {
    const speed = currentSpeed(block, state);
    return Math.max(...[distance, Math.max(5, distance - speed), distance + speed].map((at) => usableRoutineEvAtDistance(block, foe, state, at, evaluator)));
  };
  let best = feet, bestScore = -Infinity;
  for (let pull = feet; pull >= 0; pull -= 5) {
    const after = { ...engagement }, target = { ...dState };
    reelToward(attacker, aState, defender, target, after, pull);
    const falls = target.height > 0 && target.height !== dState.height && !canFly(defender, dState) ? target.height : 0;
    const distance = falls ? separation(attacker, aState.height, defender, 0, after.ground) : after.distance;
    const score = reach(attacker, defender, aState, distance) - reach(defender, attacker, dState, distance) + Math.min(20, Math.floor(falls / 10)) * 3.5;
    if (score > bestScore) { best = pull; bestScore = score; }
  }
  return best;
}

/**
 * How far the attacker pushes a target it may push "up to" `feet` straight away: its choice, in 5-foot steps, nothing
 * included. Never out of the reach of an attack its routine still has to make this turn (`routineStillReaches`); among
 * the lengths left, scored as a pull is (`choosePull`), ties to the longer push.
 */
function choosePush(attacker: CombatStatblock, aState: FighterState, defender: CombatStatblock, dState: FighterState, engagement: EngagementState, feet: number, evaluator: PairEvaluator): number {
  const reach = (block: CombatStatblock, foe: CombatStatblock, state: FighterState, distance: number): number => {
    const speed = currentSpeed(block, state);
    return Math.max(...[distance, Math.max(5, distance - speed), distance + speed].map((at) => usableRoutineEvAtDistance(block, foe, state, at, evaluator)));
  };
  let best = 0, bestScore = -Infinity;
  for (let push = feet; push >= 0; push -= 5) {
    const distance = separation(attacker, aState.height, defender, dState.height, Math.min(engagement.maxDistance, engagement.ground + push));
    if (push > 0 && aState.routineStillReaches !== undefined && distance > aState.routineStillReaches) continue;
    const score = reach(attacker, defender, aState, distance) - reach(defender, attacker, dState, distance);
    if (score > bestScore) { best = push; bestScore = score; }
  }
  return best;
}

/**
 * What a printed Legendary Move may spend, and whether the mover stands first.
 *
 * The grant is the print's own: up to its speed, or up to half its speed, of the Speed the creature has now (a
 * stop and partial cuts applied). It is not what the creature's own turn left: `movementPenalty` (a stand's or a
 * detach's cost, cleared only when its next turn starts) is that turn's bookkeeping and is not subtracted.
 *
 * Made while Prone, the Move follows the rule of the creature's own turn: "Your only movement options are to crawl or to
 * spend an amount of movement equal to half your Speed (round down) to right yourself" (SRD 5.2.1). It stands if the
 * grant covers the stand, a grant equal to the cost included (the stand then leaves 0 ft, and a Move that only stands
 * is never made: it gains no square), and moves with what is left. A mover that cannot stand (`cannotStand`) crawls: 1
 * extra foot per foot, so half the grant, halved once (the grant is read before the crawl halving a turn already
 * crawling puts on `currentSpeed`).
 */
function legendaryMoveBudget(block: CombatStatblock, state: FighterState, move: { halfSpeed: boolean } | { feet: number }, crawls = false): { budget: number; stands: boolean } {
  // An entry's own grant (`LegendaryEntryMove.feet`) is printed against a Speed the block may not hold as its one Speed
  // (half a walking Speed on a flier): it shrinks in the proportion the creature's Speed has.
  const now = speedBeforeCrawl(block, state);
  const grant = "feet" in move ? (block.speed > 0 ? Math.floor(move.feet * now / block.speed) : 0) : now * (move.halfSpeed ? 0.5 : 1);
  if (grant <= 0 || !isProne(state)) return { budget: grant, stands: false };
  const cost = standCost(block, state);
  if (!crawls && hasCondition(state, "prone") && !cannotStand(state) && grant >= cost) return { budget: grant - cost, stands: true };
  return { budget: Math.floor(grant / 2), stands: false };
}

/**
 * The block's Speed less the partial cuts the creature holds (`ConditionState.speedCut`, `speedHalved`), such as a
 * 10-foot decrease lasting to the close of its next turn, or a halving. Flat cuts from different copies add
 * (one effect holds one copy, so two hits by the same option do not stack), then one halving, never below 0. Every
 * movement mode the engine tracks shares the one Speed. A stop (`speedZero`, a pinning condition) is `currentSpeed`'s to
 * apply; this is also the Speed the creature would have once free of one (`escapeWorthwhile`).
 */
function cutSpeed(block: CombatStatblock, state: FighterState): number {
  let flat = 0;
  let halved = false;
  for (const c of state.conditions) {
    if (c.name === "exhaustion") flat += 5;
    if (c.speedCut !== undefined) flat += c.speedCut;
    if (c.speedHalved) halved = true;
  }
  const speed = baseSpeed(block, state);
  if (!flat && !halved) return speed;
  const left = Math.max(0, speed - flat);
  return halved ? Math.floor(left / 2) : left;
}

/**
 * What standing from Prone costs: an amount of movement equal to half your Speed, rounded down (SRD 5.2.1), the Speed
 * the creature has now, partial cuts applied (the block's own Speed would ignore the cuts). "Speed" is the creature's
 * one Speed, its fastest mode (a dragon with Speed 40 ft., Fly 80 ft. pays 40 ft).
 */
function standCost(block: CombatStatblock, state: FighterState): number {
  return Math.floor(cutSpeed(block, state) / 2);
}

function movementSpeed(block: CombatStatblock, state: FighterState): number {
  // Taking the action under `moveOrAct` leaves no movement to spend; the Speed itself is not 0, so a flier stays aloft.
  if (state.actsInsteadOfMoving) return 0;
  return Math.max(0, currentSpeed(block, state) - state.movementPenalty);
}

/**
 * How much nearer the foe can be when it next attacks than its Speed alone brings it, for a creature deciding whether a
 * step away buys safety. Three ways in that are not its walk: the foe's own teleport that costs it no action (an attack
 * that teleports first, a Bonus Action or Legendary teleport), movement its Bonus Action grants (a Charge, a Dash, a
 * Leap), and the mover's own pull on a foe it holds (Reel in a Roper's Multiattack brings the grappled creature back
 * beside it on the same turn).
 */
function closingBeyondSpeed(mover: CombatStatblock, moverState: FighterState, foe: CombatStatblock, foeState: FighterState, source: 0 | 1): number {
  let closing = 0;
  foe.options.forEach((option, idx) => {
    const action = option.action;
    // Movement the foe's Bonus Action adds to its Speed ("Charge. The xorn moves up to its Speed without provoking
    // Opportunity Attacks straight toward an enemy it can sense"): a Bugbear Stalker walked 25 feet from a Xorn every
    // round, through an Opportunity Attack, to throw the Javelins it could have thrust, and the Xorn charged back.
    if (action.kind === "selfbuff" && action.movement && option.timing === "bonus" && action.movement.distance !== 0 && usable(foeState, idx, option)) {
      const m = action.movement;
      closing = Math.max(closing, m.mode === "leap" ? (m.distance ?? 0) - (m.cost ?? 0) : currentSpeed(foe, foeState) * (m.fraction ?? 1));
    }
    const spec = "teleport" in action ? action.teleport : undefined;
    if (!spec || !usable(foeState, idx, option)) return;
    if (action.kind === "attack" || (action.kind === "teleport" && option.timing !== "action")) closing = Math.max(closing, spec.distance);
  });
  mover.options.forEach((option, idx) => {
    const action = option.action;
    if (action.kind !== "autohit" || !action.pull || !usable(moverState, idx, option)) return;
    if (action.requiresTargetCondition && !hasConditionFrom(foeState, action.requiresTargetCondition, source)) return;
    if (mover.routines.some((routine) => routine.parts.length > 1 && routine.parts.some((part) => part.optionIdx === idx))) closing = Math.max(closing, action.pull);
  });
  return closing;
}

/**
 * The movement a creature will have on its own next turn, asked on the other creature's turn. `movementSpeed` cannot
 * answer that: `movementPenalty` still holds what this creature's last turn spent (a stand, a leap) until its next turn
 * starts, and a foe that had stood up from Prone read as too slow to follow a step back. A creature Prone now pays for
 * the stand then, or crawls if it cannot stand.
 */
function nextTurnSpeed(block: CombatStatblock, state: FighterState): number {
  const speed = currentSpeed(block, state);
  if (!isProne(state)) return speed;
  return cannotStand(state) ? Math.floor(speed / 2) : Math.max(0, speed - standCost(block, state));
}

/**
 * The largest separation a creature's own movement may end at.
 *
 * Two ropes pull the same way. A creature that is grappling drags its victim along instead of
 * walking off and leaving it held at a distance, so the pair can be pulled no further apart
 * than the grip that joins them: otherwise an Aboleth could walk to 30 feet with a
 * 15-foot tentacle still attached. And a harpooned creature may only step toward the
 * harpooner, which is the same ceiling written from the other end: wherever it stands
 * now. Both are limits on *voluntary* movement; an effect that drags a victim past the reach
 * breaks the hold instead, which is `settleHoldGeometry`'s job.
 *
 * Infinity whenever no hold is in force, which is almost every turn of almost every fight.
 */
function movementCeiling(state: FighterState, foeState: FighterState, source: 0 | 1, distance: number): number {
  let ceiling = Infinity;
  for (const condition of foeState.conditions) {
    if (condition.source === source && condition.holdReach !== undefined) {
      ceiling = Math.min(ceiling, condition.holdReach);
    }
  }
  if (state.conditions.some((condition) => condition.approachOnly)) ceiling = Math.min(ceiling, distance);
  // A creature attached to the mover rides it ("the cloaker attaches to it"; it lets go only by spending its own
  // movement, or when the host tears it off): the host's walking carries the rider along and opens no distance.
  if (state.conditions.some((condition) => condition.name === "attached" && condition.duration === "untilEscape" && condition.source !== source)) {
    ceiling = Math.min(ceiling, distance);
  }
  // A third rope, and the shortest: a swallower carries what it swallowed, so neither creature walks away from the
  // other while one is inside (`settleSwallowGeometry`).
  if (hasCondition(state, "swallowed") || hasCondition(foeState, "swallowed")) ceiling = 0;
  return ceiling;
}

/**
 * A hold ends the moment an effect puts its victim out of the grappler's reach (SRD 5.2.1).
 * Ordinary movement never gets there — `movementCeiling` keeps both ends inside the grip — so
 * what reaches this are the things that move a creature without asking it: a teleport, a fall,
 * the rout a Fear effect forces. A hold with no reach recorded is a place rather than a grip —
 * a web, an entangling patch of ground — and follows its victim nowhere.
 */
function settleHoldGeometry(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  engagement: EngagementState,
  log: FightLog,
): void {
  for (const idx of [0, 1] as const) {
    const state = states[idx];
    const broken = state.conditions.filter((c) => c.holdReach !== undefined && engagement.distance > c.holdReach);
    if (!broken.length) continue;
    state.conditions = state.conditions.filter((c) => !broken.includes(c));
    pruneLinkedConditions(state);
    if (log.on) log.push(`${blocks[idx].name} is out of ${blocks[idx === 0 ? 1 : 0].name}'s reach and the hold ends`);
  }
}

/**
 * Which of a creature's suppressible defences are switched on in this state. Every carrier of
 * Evasion or Avoidance cannot use the trait while Incapacitated, and most Displacement wordings
 * say the same of themselves; some creatures add a Speed of 0 as a second gate, which is the one gate read off
 * movement rather than off a condition.
 */
function activeDefences(block: CombatStatblock, state: FighterState): DefenceState {
  const incapacitated = hasAny(state, RULES_INCAPACITATED);
  const trait = block.attacksAgainstDisadvantage;
  return {
    displacement: !trait
      || !((trait.requiresConscious && incapacitated) || (trait.requiresSpeed && movementSpeed(block, state) === 0)),
    evasion: !incapacitated,
  };
}

/**
 * Displacement and similar traits, resolved against the roll actually
 * being made. `attackDisadvantageFactor` is the same predicate priced for the chooser; this is
 * the one the d20 goes through.
 */
function attacksAtDisadvantageAgainst(
  defender: CombatStatblock,
  defenderState: FighterState,
  action: CombatAction,
  distance: number,
): boolean {
  const trait = defender.attacksAgainstDisadvantage;
  if (!trait || action.kind !== "attack") return false;
  if (!activeDefences(defender, defenderState).displacement) return false;
  if (trait.rangedOnly && !action.ranged) return false;
  // The illusion works only while the attacker is outside the cloud's radius: step inside the mist and
  // the illusion stops working.
  if (trait.minDistance !== undefined && distance <= trait.minDistance) return false;
  return true;
}

/**
 * Vertical extent of a creature's space, indexed by size rank (T/S/M/L/H/G). 5e spaces are
 * cubes, so a Huge creature fills fifteen feet of altitude just as it fills fifteen feet of
 * ground. Kept to multiples of five so altitudes — and therefore distances — stay integral.
 */
const BODY_HEIGHT = [5, 5, 5, 10, 15, 20];

function bodyHeight(block: CombatStatblock): number {
  return BODY_HEIGHT[block.size] ?? 5;
}

/**
 * The highest a creature's feet may be: the scenario's cap above the top of the other creature's body, so that the gap
 * over a foe on the ground is at most the cap, as the ground between them is. Counting the flier's own body under a
 * 30-foot roof instead left a Huge flier 15 feet of climb and a Gargantuan one 10: neither cleared a Large foe's 5-foot
 * reach (10 + 5 + 5 = 20), and a dragon with nothing to kill a Troll stood beside it for forty rounds and died.
 */
function skyRoof(engagement: EngagementState, other: CombatStatblock): number {
  return engagement.ceiling + bodyHeight(other);
}

/**
 * "If you're Invisible when you roll Initiative, you have Advantage on the roll" (Invisible, SRD 5.2.1): a creature that
 * starts the fight with the condition (the Invisible Stalker, whose printed Initiative score of 22 is 10 + 7 + 5).
 */
function rollInitiative(block: CombatStatblock, state: FighterState, rng: () => number): number {
  const first = d20(rng);
  const invisible = state.conditions.some((c) => c.name === "invisible" && !c.darkness);
  return (invisible ? Math.max(first, d20(rng)) : first) + block.initiativeBonus;
}

/** A Fly Speed of the block's own, or one a condition on it grants (the Fly spell) for as long as that lasts. */
function canFly(block: CombatStatblock, state: FighterState | undefined): boolean {
  return block.flySpeed !== undefined || (!!state && state.conditions.some((c) => c.flySpeed !== undefined));
}

/** "Can hover": the block's own, or the granted Fly Speed's. */
function canHover(block: CombatStatblock, state: FighterState): boolean {
  return !!block.canHover || state.conditions.some((c) => c.hover);
}

/** The block's Speed (its fastest mode), or a granted Fly Speed if that is faster. */
function baseSpeed(block: CombatStatblock, state: FighterState): number {
  let speed = block.speed;
  for (const c of state.conditions) if (c.flySpeed !== undefined && c.flySpeed > speed) speed = c.flySpeed;
  return speed;
}

/**
 * Gap between the two creatures' occupied volumes on the vertical axis. Each fills
 * `[height, height + bodyHeight]`, so a Medium creature standing on the ground can still
 * reach a flier hovering ten feet up with a five-foot reach, and a Huge one with reach 15
 * threatens thirty feet of altitude. Takes the pair unpacked so the movement loop can call
 * it without building a tuple per candidate.
 */
function verticalGap(a: CombatStatblock, aHeight: number, b: CombatStatblock, bHeight: number): number {
  return aHeight >= bHeight
    ? Math.max(0, aHeight - (bHeight + bodyHeight(b)))
    : Math.max(0, bHeight - (aHeight + bodyHeight(a)));
}

/**
 * Separation between the fighters. 5e's basic rules price a diagonal at five feet, so this
 * is a Chebyshev metric and not a Euclidean one: the axes never add, the larger simply wins.
 * That keeps every distance integral, which the packed memo keys depend on, and it makes the
 * movement budget a plain rectangle — climbing and closing don't trade off against each other.
 */
function separation(a: CombatStatblock, aHeight: number, b: CombatStatblock, bHeight: number, ground: number): number {
  return Math.max(ground, verticalGap(a, aHeight, b, bHeight));
}

/** The reach of one melee attack an opportunity attack may be made with, or undefined: see `oaReach`. */
function oaAttackReach(action: CombatAction): number | undefined {
  if (action.kind === "attack") return action.melee && !action.spell ? action.reach ?? 5 : undefined;
  if (action.kind === "autohit") return action.melee ? action.range ?? 5 : undefined;
  return undefined;
}

/**
 * The reach of an option that can make an opportunity attack, or undefined if it cannot: an at-will melee attack that is
 * not a spell, or an at-will printed melee attack that hits automatically (an automatic-hit melee tag, compiled
 * `autohit` with `melee`; its reach is its range). The policy is any melee attack the stat block prints.
 *
 * A printed melee attack whose effect is rolled (an attack whose outcome is drawn from a table)
 * compiles as a `random` option with one melee attack per outcome. It is the same printed attack, so it is eligible
 * when every branch is: its reach is the shortest branch reach (the creature does not choose the branch), and the
 * opportunity attack draws its branch when it is made, as the action does (`resolveAction`). A random option with any
 * other branch (a save, a ranged-only attack, a spell attack, a nested random) is not a melee attack.
 */
function oaReach(option: ActionOption): number | undefined {
  if (option.uses.t !== "atWill") return undefined;
  const action = option.action;
  if (action.kind !== "random") return oaAttackReach(action);
  let shortest: number | undefined;
  for (const branch of action.branches) {
    const reach = oaAttackReach(branch);
    if (reach === undefined) return undefined;
    shortest = shortest === undefined ? reach : Math.min(shortest, reach);
  }
  return shortest;
}

/**
 * Longest reach among the creature's at-will melee attacks (0 if it has none). A long-reach melee spell attack
 * (30 ft) is left out: this is the reach of the creature's opportunity attacks.
 */
function meleeReach(block: CombatStatblock): number {
  let reach = 0;
  for (const option of block.options) {
    const optionReach = oaReach(option);
    if (optionReach === undefined) continue;
    reach = Math.max(reach, optionReach);
  }
  return reach;
}

/**
 * Best at-will melee attack for an opportunity attack, or undefined. An opportunity attack is a weapon or
 * Unarmed Strike attack, so a melee spell attack (Shocking Grasp, Chill Touch) never makes one.
 */
function bestOaOption(attacker: CombatStatblock, defender: CombatStatblock, from = 0, to = Infinity): { optionIdx: number; ev: number } | undefined {
  let best: { optionIdx: number; ev: number } | undefined;
  attacker.options.forEach((option, idx) => {
    const reach = oaReach(option);
    if (reach === undefined) return;
    if (from > reach || to <= reach) return;
    const ev = actionEv(option.action, attacker, defender);
    if (!best || ev > best.ev) best = { optionIdx: idx, ev };
  });
  return best;
}

function cachedBestOaOption(evaluator: PairEvaluator, attacker: CombatStatblock, defender: CombatStatblock, from: number, to: number): { optionIdx: number; ev: number } | undefined {
  const direction = evaluator.direction(attacker, defender);
  if (direction === undefined || !packable(from) || !packable(to)) return bestOaOption(attacker, defender, from, to);
  const key = (direction * DIRECTION_STRIDE + from) * DIRECTION_STRIDE + to;
  if (evaluator.oa.has(key)) return evaluator.oa.get(key) || undefined;
  const value = bestOaOption(attacker, defender, from, to);
  evaluator.oa.set(key, value || null);
  return value;
}

/**
 * Where a walk from ground separation `from` toward `to` stops on `budget` feet of movement when the foe carries
 * Difficult Terrain around itself (`CombatStatblock.difficultGround`): "Every foot of movement in Difficult Terrain
 * costs 1 extra foot" (SRD 5.2.1), for the feet walked within the radius. In whole 5-foot steps. `to` itself for a
 * mover that is not walking on that ground (a flier, a creature in the air) or a foe that carries none.
 */
function difficultGroundStop(mover: CombatStatblock, moverState: FighterState, foe: CombatStatblock, from: number, to: number, budget: number, toHeight = moverState.height): number {
  const radius = foe.difficultGround?.radius;
  if (radius === undefined || moverState.height > 0 || toHeight > 0 || canFly(mover, moverState)) return to;
  const direction = Math.sign(to - from);
  let at = from, left = budget;
  while (at !== to) {
    const step = Math.min(5, Math.abs(to - at));
    const next = at + direction * step;
    const cost = step + Math.max(0, Math.min(Math.max(at, next), radius) - Math.min(at, next));
    if (cost > left) break;
    left -= cost;
    at = next;
  }
  return at;
}

/**
 * Cheap half of the opportunity-attack test: is the foe in a position to make one at all?
 * Split out from the option lookup so callers that already resolved the OA option (via
 * `cachedBestOaOption`) don't pay for an identical uncached scan.
 */
function movementProvokeGuard(mover: CombatStatblock, moverState: FighterState, foe: CombatStatblock, foeState: FighterState, distance: number): boolean {
  return !(mover.flyby || moverState.conditions.some(c => c.noProvoke) || (foeState.reactionUsed && !(foe.heads?.reactive && foeState.extraOpportunityUsed < Math.max(0, (foeState.heads ?? 1) - 1))) || foeState.conditions.some(c => c.noReactions) || hasAny(foeState, INCAPACITATING) || !canSee(foe, moverState, foeState, distance));
}

/**
 * Resolve movement to a ground/altitude target, including any opportunity attack it provokes.
 * Returns true if the mover survives. Everything below the `to` computation works on the
 * derived scalar, so the vertical axis comes out right for free: climbing out of a foe's
 * reach provokes exactly one opportunity attack, and a dive-bomb counts toward charge riders.
 */
function applyMovement(mover: CombatStatblock, moverState: FighterState, foe: CombatStatblock, foeState: FighterState, moverIdx: 0 | 1, engagement: EngagementState, toGround: number, toHeight: number, rng: () => number, log: FightLog, evaluator: PairEvaluator, label = "moves", noProvoke = false, budget?: number, legendary = false, speeds?: number): boolean {
  moverState.movementBeforeFoeTeleport = undefined;
  const from = engagement.distance;
  // A Legendary Move spends its own grant, not the mover's turn: what that turn spent (`movementPenalty`) neither stops
  // it nor grows by a stand made during it.
  const speedNow = (): number => legendary ? currentSpeed(mover, moverState) : movementSpeed(mover, moverState);
  const carrying = carriesTarget(foeState, moverIdx);
  const roof = Math.max(0, Math.min(skyRoof(engagement, foe),
    carrying ? skyRoof(engagement, mover) - (foeState.height - moverState.height) : Infinity));
  toHeight = Math.min(toHeight, roof);
  const fromHeight = moverState.height;
  // A mover that changes into its successor form partway through (an opportunity attack or an approach rebuke drops the
  // old form) stops where it is: the rest of the move was the old form's.
  const form = moverState.formChanges;
  const formChanged = (): boolean => {
    if (moverState.formChanges === form) return false;
    if (log.on) log.push(`${mover.name} appears where its old form stood, and that form's movement ends`);
    return true;
  };
  // While flying, you fall if you have the Incapacitated condition (SRD 5.2.1): a non-hovering flier that is
  // Incapacitated is on the ground (`settleFlight`) and may not climb.
  // A square chosen above the foe (ground 0) is not one a grounded mover may end on: keep the pair apart.
  const keepApart = (): void => {
    toGround = Math.max(toGround, groundFloor(mover, moverState, toHeight, foe, foeState));
  };
  // `midMove`: after an opportunity attack. A mover whose flight that attack ended (Concentration on Fly, lost to the
  // damage) has no Fly Speed for the rest of the move either, and walks it.
  const refuseClimb = (midMove = false): void => {
    if (midMove && toHeight > moverState.height && !groundBound(mover, moverState) && !canFly(mover, moverState)) {
      if (log.on) log.push(`${mover.name} can no longer fly and stays at ${moverState.height} ft`);
      if (label === "flies") label = "moves";
      toHeight = moverState.height;
      keepApart();
      return;
    }
    if (toHeight > moverState.height && groundBound(mover, moverState)) {
      if (log.on) log.push(`${mover.name} cannot climb while ${hasAny(moverState, RULES_INCAPACITATED) ? "incapacitated" : "prone"}`);
      toHeight = moverState.height;
      keepApart();
    }
  };
  refuseClimb();
  // "You can't willingly move closer to the source of fear" (SRD 5.2.1, Frightened), whatever the move is made with: a
  // Bonus Action's movement, a leap, a Legendary move. One that would end nearer the foe than it starts is not made.
  if (isFrightened(moverState) && separation(mover, toHeight, foe, foeState.height, toGround) < from) {
    if (log.on) log.push(`${mover.name} is frightened and will not move closer`);
    return true;
  }
  if (toGround === engagement.ground && toHeight === fromHeight) return true;
  // What the move may spend: the caller's budget (a Dash's two Speeds, a Legendary Move's), else the Speed it has now.
  let moveBudget = (budget ?? movementSpeed(mover, moverState)) / (carrying ? carryCost(mover, foe) : 1);
  toHeight = moverState.height + Math.sign(toHeight - moverState.height) * Math.min(Math.abs(toHeight - moverState.height), moveBudget);
  toGround = engagement.ground + Math.sign(toGround - engagement.ground) * Math.min(Math.abs(toGround - engagement.ground), moveBudget);
  toGround = difficultGroundStop(mover, moverState, foe, engagement.ground, toGround, moveBudget, toHeight);
  const startedProne = hasCondition(moverState, "prone");
  // A partial Speed cut that lands during this move (an opportunity attack's rider, an approach rebuke's) shortens it:
  // the budget shrinks in the proportion the Speed did (a Dash's two Speeds, a Legendary Move's half), and what is left
  // of the move is cut back to what the new budget still buys.
  // A budget built from the turn's own Speed (`speeds` of them, less what the turn had already moved or paid to stand)
  // loses the feet the Speed lost, once per Speed: "subtract the distance already moved from the new speed" (SRD 5.2.1,
  // Speed). A caster whose Fly an opportunity attack ends after it walked 25 ft has its walking Speed less 25 ft left.
  const speedAtStart = currentSpeed(mover, moverState);
  const paysFromTurn = speeds ?? (budget === undefined && !legendary ? 1 : undefined);
  const cutMidMove = (spent: number): void => {
    const now = currentSpeed(mover, moverState);
    if (now >= speedAtStart || speedAtStart <= 0) return;
    moveBudget = paysFromTurn === undefined
      ? Math.floor(moveBudget * now / speedAtStart)
      : Math.max(0, Math.floor(moveBudget - paysFromTurn * (speedAtStart - now) / (carrying ? carryCost(mover, foe) : 1)));
    const rest = Math.max(0, moveBudget - spent);
    const advance = (start: number, end: number) => start + Math.sign(end - start) * Math.min(rest, Math.abs(end - start));
    const ground = advance(engagement.ground, toGround);
    const height = advance(moverState.height, toHeight);
    if (ground === toGround && height === toHeight) return;
    if (log.on) log.push(`${mover.name}'s Speed is cut mid-move (${rest} ft of movement left)`);
    toGround = ground;
    toHeight = height;
    keepApart();
  };
  // Prone: "Your only movement options are to crawl or to spend an amount of movement equal to half your Speed (round
  // down) to right yourself" (SRD 5.2.1). A mover a condition knocks Prone partway through its move stands, as it would
  // at the start of its turn (`standIfProne`), paying half its Speed from what the move has left, and goes on with the
  // rest; if it cannot pay it stays Prone where it is (no crawl). Returns true when the move stops here.
  const proneMidMove = (spent: number): boolean => {
    if (startedProne || !hasCondition(moverState, "prone")) return false;
    const half = standCost(mover, moverState);
    const left = Math.max(0, moveBudget - spent);
    if (cannotStand(moverState) || speedNow() <= 0 || left < half) {
      if (log.on) log.push(`${mover.name} is prone and its movement is stopped`);
      return true;
    }
    moverState.conditions = moverState.conditions.filter((c) => c.name !== "prone");
    pruneLinkedConditions(moverState);
    if (!legendary) moverState.movementPenalty += half;
    const rest = left - half;
    if (log.on) log.push(`${mover.name} spends half its Speed to stand (${rest} ft of movement left)`);
    const advance = (start: number, end: number) => start + Math.sign(end - start) * Math.min(rest, Math.abs(end - start));
    toGround = advance(engagement.ground, toGround);
    toHeight = advance(moverState.height, toHeight);
    keepApart();
    return false;
  };
  // A mover the opportunity attack relocated (its own Reaction teleport, a push) goes on from where it now stands, and
  // no farther than the movement it has left reaches from there.
  const withinBudget = (spent: number): void => {
    const left = Math.max(0, moveBudget - spent);
    if (Math.abs(toGround - engagement.ground) > left) toGround = engagement.ground + Math.sign(toGround - engagement.ground) * left;
    if (Math.abs(toHeight - moverState.height) > left) toHeight = moverState.height + Math.sign(toHeight - moverState.height) * left;
  };
  const to = separation(mover, toHeight, foe, foeState.height, toGround);
  // One Reaction a round: an Opportunity Attack spends the one Pursuit needs ("another creature the nalfeshnee can see
  // ends its move within 120 feet"). Where the mover ends farther than the foe's own walk and reach would bring it to
  // attack next turn, following is a whole turn's attacks for one swing, so the Reaction is kept. A Nalfeshnee swung at
  // an Adult Brass Dragon leaving its side every round and then Dashed after it, round after round, without attacking.
  const keptForPursuit = !!foe.pursuit && to <= foe.pursuit.range && to > foe.pursuit.beside && reactionAvailable(foe, foeState)
    && !foeState.conditions.some((c) => c.blocksTeleport) && canSee(foe, moverState, foeState, to)
    && closestFoeReach(foe, foeState, toGround, Math.abs(toHeight - foeState.height), nextTurnSpeed(foe, foeState)) > meleeReach(foe);
  const oa = !noProvoke && !keptForPursuit && movementProvokeGuard(mover, moverState, foe, foeState, from)
    ? cachedBestOaOption(evaluator, foe, mover, from, to)
    : undefined;
  const riddenNow = (): boolean => moverState.conditions.some((c) => c.name === "attached" && c.duration === "untilEscape" && c.source !== moverIdx);
  const ridden = riddenNow();
  if (oa) {
    if (foe.heads?.reactive && foeState.extraOpportunityUsed < Math.max(0, (foeState.heads ?? 1) - 1)) foeState.extraOpportunityUsed++;
    else foeState.reactionUsed = true;
    if (log.on) log.push(`${foe.name} makes an opportunity attack`);
    resolveAction(foe, mover, foeState, moverState, foe.options[oa.optionIdx].action, rng, moverIdx === 0 ? 1 : 0, from, log);
    settleAfterAction(foe, mover, foeState, moverState, moverIdx === 0 ? 1 : 0, engagement, rng, log);
    if (isDown(mover, moverState)) {
      // The move line is printed on arrival: without one the swing read as coming from nowhere.
      if (log.on) log.push(`${mover.name} falls as it moves away`);
      return false;
    }
    if (formChanged()) return true;
    if (speedNow() === 0) {
      if (log.on) log.push(`${mover.name}'s movement is stopped`);
      return true;
    }
    // An Opportunity Attack that attaches its maker to the mover ("the darkmantle attaches to the target") puts the
    // maker on it: the rest of the move carries the rider along and opens no distance (`movementCeiling`).
    if (!ridden && riddenNow()) {
      if (log.on) log.push(`${mover.name} moves with ${foe.name} attached and opens no distance`);
      return true;
    }
    // The opportunity attack is made as the mover leaves the start square, so none of the move is spent yet. A flier it
    // knocked out of the air is Prone where it fell, and stands or stops as a mover on the ground does
    // (before, its movement stopped where it fell).
    cutMidMove(0);
    if (proneMidMove(0)) return true;
    refuseClimb(true);
    withinBudget(0);
  }
  const moveTo = (ground: number, height: number): void => {
    if (carriesTarget(foeState, moverIdx)) foeState.height = Math.max(0, foeState.height + height - moverState.height);
    const distance = separation(mover, height, foe, foeState.height, ground);
    if (ground === engagement.ground && height === moverState.height) return;
    const altitude = height !== moverState.height || height > 0
      ? ` [altitude ${Math.round(moverState.height)} ft to ${Math.round(height)} ft]`
      : "";
    if (log.on) log.push(`${mover.name} ${label} (${Math.round(engagement.distance)} ft -> ${Math.round(distance)} ft)${altitude}`);
    moverState.movedToward += Math.max(0, engagement.distance - distance);
    const previous = engagement.distance;
    engagement.ground = ground;
    moverState.height = height;
    engagement.distance = distance;
    // Forced movement arrives here too — the rout a Fear effect drives, a rebuke's shove —
    // and that is movement by an effect, which breaks a hold it drags the victim out of.
    settleHoldGeometry(
      (moverIdx === 0 ? [mover, foe] : [foe, mover]) as [CombatStatblock, CombatStatblock],
      (moverIdx === 0 ? [moverState, foeState] : [foeState, moverState]) as [FighterState, FighterState],
      engagement,
      log,
    );
    // An attacher that moves off its victim has let go ("the cloaker can detach itself by spending 5 feet of
    // movement"): it is on the creature or it is somewhere else. A Cloaker flew 10 feet up from a Flesh Golem and
    // Tail-whipped it for two rounds while the golem, still Blinded, rolled to escape a creature no longer on it.
    const attachment = distance > previous ? foeState.conditions.find((c) => c.name === "attached" && c.source === moverIdx && c.sourceDetachMovement !== undefined) : undefined;
    if (attachment) {
      foeState.conditions = foeState.conditions.filter((c) => c !== attachment);
      pruneLinkedConditions(foeState);
      if (log.on) log.push(`${mover.name} detaches from ${foe.name}`);
    }
  };
  // Resolve entry at the first space inside the trigger radius, before spending the rest of
  // the movement. Both axes advance together under the engine's diagonal movement metric;
  // occupied body heights determine the vertical boundary, not the creatures' foot positions.
  const foeIdx: 0 | 1 = moverIdx === 0 ? 1 : 0;
  const approach = foe.rebuke?.trigger === "enteredReach" ? foe.rebuke.triggerRange ?? 5 : undefined;
  if (approach !== undefined && from > approach && to <= approach) {
    const blocks = (moverIdx === 0 ? [mover, foe] : [foe, mover]) as [CombatStatblock, CombatStatblock];
    const states = (moverIdx === 0 ? [moverState, foeState] : [foeState, moverState]) as [FighterState, FighterState];
    if (rebukeCanAnswer(blocks, states, foeIdx, approach)) {
      const step = Math.max(0, engagement.ground - approach,
        fromHeight - (foeState.height + bodyHeight(foe) + approach),
        foeState.height - bodyHeight(mover) - approach - fromHeight);
      const advance = (start: number, end: number) => start + Math.sign(end - start) * Math.min(step, Math.abs(end - start));
      const groundBefore = engagement.ground;
      moveTo(advance(engagement.ground, toGround), advance(fromHeight, toHeight));
      const entryHeight = moverState.height;
      const spent = Math.max(Math.abs(engagement.ground - groundBefore), Math.abs(entryHeight - fromHeight));
      fireRebuke(blocks, states, foeIdx, engagement, rng, log);
      settleDeathBursts(blocks, states, engagement, rng, log);
      settleSprayAndRebukes(blocks, states, engagement, rng, log); // the approach rebuke
      settleDeathBursts(blocks, states, engagement, rng, log);
      settleFlight(blocks, states, engagement, rng, log);
      settleDeathBursts(blocks, states, engagement, rng, log);
      if (isDown(mover, moverState)) return false;
      if (formChanged()) return true;
      if (speedNow() === 0) {
        if (log.on) log.push(`${mover.name}'s movement is stopped`);
        return true;
      }
      cutMidMove(spent);
      if (proneMidMove(spent)) return true;
      refuseClimb(true);
      withinBudget(spent);
    }
  }
  moveTo(toGround, toHeight);
  if (foe.pursuit && engagement.distance !== from && engagement.distance <= foe.pursuit.range
    && !isDown(foe, foeState) && reactionAvailable(foe, foeState) && !foeState.conditions.some(c => c.blocksTeleport)
    && canSee(foe, moverState, foeState, engagement.distance) && engagement.distance > foe.pursuit.beside) {
    moverState.movementBeforeFoeTeleport = { ground: engagement.ground, height: moverState.height };
    foeState.reactionUsed = true;
    const before = engagement.distance;
    engagement.ground = Math.max(0, engagement.ground - foe.pursuit.distance);
    foeState.height = moverState.height;
    engagement.ground = Math.max(groundFloor(foe, foeState, foeState.height, mover, moverState), Math.min(foe.pursuit.beside, engagement.ground));
    engagement.distance = separation(foe, foeState.height, mover, moverState.height, engagement.ground);
    if (log.on) log.push(`${foe.name} uses Pursuit (${before} ft -> ${engagement.distance} ft)`);
  }
  return true;
}

/** The teleport an option carries, if any. Pure teleports keep theirs on the action itself. */
function actionTeleport(action: CombatAction): TeleportSpec | undefined {
  if (action.kind === "random") return undefined;
  return action.teleport;
}

/**
 * The option a destination-anchored jump carries, when what it does lands on the foe (an attack, a save or an automatic
 * hit): a teleport of up to 30 feet followed by a Claw attack, or an emanation centred on the creature's destination
 * space. The landing is chosen for this option, and a Legendary entry is priced there. A heal that jumps first
 * does the same wherever it lands, so its landing is chosen as any other jump's.
 */
function jumpFirstAction(action: CombatAction): CombatAction | undefined {
  if (action.kind !== "attack" && action.kind !== "save" && action.kind !== "autohit") return undefined;
  return action.teleport?.anchor === "destination" ? action : undefined;
}

/**
 * A jump fixed beside the foe (within 5 feet of a foe it sees, `besideFoe`): the nearest ground the pair
 * allows, altitude kept as for every jump. No jump when that is not within the printed radius (a grounded jumper under a
 * high flier), when the jumper cannot see the foe, when it is frightened (closing is barred), or when it is already there.
 */
function besideFoeGround(
  attacker: CombatStatblock,
  defender: CombatStatblock,
  state: FighterState,
  foeState: FighterState,
  engagement: EngagementState,
  radius: number,
): number {
  if (engagement.distance <= radius || isFrightened(state)) return engagement.ground;
  if (!canSee(attacker, foeState, state, engagement.distance)) return engagement.ground;
  const ground = groundFloor(attacker, state, state.height, defender, foeState);
  return separation(attacker, state.height, defender, foeState.height, ground) <= radius ? ground : engagement.ground;
}

/** The separation a destination-anchored option would act from: where its own jump lands it (`chooseTeleportGround`). */
function jumpFirstDistance(
  attacker: CombatStatblock,
  defender: CombatStatblock,
  state: FighterState,
  foeState: FighterState,
  source: 0 | 1,
  engagement: EngagementState,
  carried: CombatAction,
  evaluator: PairEvaluator,
): number {
  const spec = actionTeleport(carried);
  if (!spec || teleportBlocked(state)) return engagement.distance;
  const ground = chooseTeleportGround(attacker, defender, state, foeState, source, engagement, spec, evaluator, carried);
  return ground === engagement.ground ? engagement.distance : separation(attacker, state.height, defender, foeState.height, ground);
}

/**
 * Whether a teleport ends this hold. A grapple, the Restrained that rides one, an attachment and a hold with an escape
 * check do: each ends when its victim is out of the holder's reach. A Restrained that lasts until an object is destroyed
 * and has no other printed end does not ("the target has the Restrained condition until the rope is destroyed, the
 * erinyes uses a Bonus Action to release the target, or the erinyes uses Entangling Rope again"): the rope or web goes
 * where the creature goes.
 */
function teleportFreesHold(c: ConditionState): boolean {
  if (c.duration !== "untilEscape" || !["grappled", "restrained", "attached"].includes(c.name)) return false;
  return !(c.name === "restrained" && c.breakable !== undefined && c.escapeDc === undefined && c.heldBy === undefined);
}

/**
 * Conditions a teleport removes. Grappling and the restraint that rides along with it both
 * end the moment the target leaves the grappler's reach (SRD 5.2.1), and a teleport is the
 * cleanest way there is to leave it — no contest, no escape roll. Only grapple-style
 * instances qualify: a `saveEndsEachTurn` Restrained from a web or a spell follows the
 * creature and is untouched.
 */
function breakGrappleByTeleport(state: FighterState, block: CombatStatblock, log: FightLog): boolean {
  const held = state.conditions.filter(teleportFreesHold);
  if (!held.length) return false;
  const grappled = held.some((c) => c.name !== "attached");
  state.conditions = state.conditions.filter((c) => !held.includes(c));
  pruneLinkedConditions(state, log, block.name);
  if (log.on) log.push(`${block.name} teleports free of the ${grappled ? "grapple" : "attachment"}`);
  return true;
}

/**
 * A swallowed creature is inside its captor, and every stat block that can swallow says the
 * same thing: it can't teleport out. A hold can print the same ban (the target has the Restrained
 * condition and can't teleport until the grapple ends, as on the Tarrasque's Bite and some other holds): its `grappled`
 * copy carries it (`ConditionState.blocksTeleport`) and it ends with that copy. Nothing else blocks a jump.
 */
function teleportBlocked(state: FighterState): boolean {
  return hasCondition(state, "swallowed") || state.conditions.some((c) => c.blocksTeleport);
}

/**
 * Whether a candidate square beats the best one so far, where each is scored the way the movement
 * and landing searches score them: a square the creature can act from is worth that action less
 * the threat waiting there, and a square it can do nothing from is worth `-distance`, so that
 * among the useless ones the nearest wins.
 *
 * Those are two different units — hit points and feet — and they must never be compared with each
 * other. A square worth something always outranks a square worth nothing, however dangerous it is.
 * Compared on score alone, a melee creature standing in a heavy hitter's reach scores its own
 * square below zero and the empty square ten feet back at -10, and the empty one won: it took no
 * action, fell through to the Dash, and Dashed back into the same reach every round without ever
 * attacking (finding 16). Retreating from danger is still available — among squares worth
 * something, the threat term decides — but not to a square from which the fight cannot be fought.
 */
function squareOutranks(worth: number, score: number, bestWorth: number, bestScore: number): boolean {
  if ((worth > 0) !== (bestWorth > 0)) return worth > 0;
  return score > bestScore;
}

/**
 * Where to land. Teleporting is not movement, so it provokes no opportunity attack and is
 * not spent from the creature's Speed — the only question is which separation is worth most.
 * Scored exactly as `chooseMovementAndRoutine` scores a candidate square (own routine EV
 * against the foe's threat), minus the opportunity-attack term that cannot apply.
 *
 * Altitude is preserved. A teleport may only end in a space the creature can occupy, and
 * hanging in mid-air is a choice the flight model already makes through ordinary movement;
 * carrying the current height over keeps a jump from quietly granting flight to a creature
 * that has none, or dropping a flier out of the sky.
 */
function chooseTeleportGround(
  attacker: CombatStatblock,
  defender: CombatStatblock,
  state: FighterState,
  foeState: FighterState,
  source: 0 | 1,
  engagement: EngagementState,
  spec: TeleportSpec,
  evaluator: PairEvaluator,
  carried?: CombatAction,
): number {
  if (spec.besideFoe !== undefined) return besideFoeGround(attacker, defender, state, foeState, engagement, spec.besideFoe);
  const gap = verticalGap(attacker, state.height, defender, foeState.height);
  // Frightened bars closing on the source of the fear, willingly and by any means.
  const floor = isFrightened(state) ? engagement.distance : 0;
  const candidates = moveCandidates(attacker, defender, engagement.ground, spec.distance, engagement.maxDistance, sightBoundaries(attacker, state, defender, foeState));
  let bestGround = engagement.ground;
  let bestMine = 0;
  let bestScore = -Infinity;
  for (const ground of candidates) {
    const distance = Math.max(ground, gap);
    if (distance < floor) continue;
    if (distance < engagement.distance && !mayShareSpace(attacker, state, defender, foeState) && distance < MIN_SEPARATION) continue;
    // Static evaluator, never the state-aware one: `bestUsableRoutinesAtDistance` prices a
    // pure teleport as a routine, so a landing spot would be scored partly by how good a
    // place it is to teleport *from*. That is self-referential, and it produced a creature
    // that hopped to five feet outside its opponent's range and stayed there for a hundred
    // rounds. A landing spot is worth what the creature can actually do from it.
    //
    // A jump that lands first carries an effect made from the landing (`jumpFirstAction`), and that effect is what the
    // landing is for: the Solar's emanation reaches 10 feet from where it arrives, and priced by its best routine instead
    // it jumped 60 feet clear of its own area. So such a landing is worth the carried option there.
    const mine = carried
      ? dynamicEv(carried, attacker, defender, foeState, state, source, distance, evaluator)
      : evaluator.bestRoutineEvAtDistance(attacker, defender, distance, true);
    // Priced from where the foe can be next turn, for the same reason as `teleportEv`: a
    // landing spot is only as safe as the foe's move makes it, and a jump can pick any spot
    // on the field rather than one within a walk of the last one.
    const threat = evaluator.bestRoutineEvAtDistance(defender, attacker, closestFoeReach(defender, foeState, distance, gap), false) * threatFactor(defender, foeState)
      + auraThreat(defender, attacker, distance, state)
      + sourceTurnAuraThreat(defender, foeState, attacker, state, source === 0 ? 1 : 0, distance)
      + spaceEntryThreat(defender, foeState, attacker, state, distance)
      + retaliationThreat(defender, attacker, distance)
      + rebukeThreat(defender, foeState, attacker, state, source === 0 ? 1 : 0, distance);
    // Same shape as the movement search, including its `-distance` fallback, and for the same
    // reason. Scoring purely on `mine - threat` sends a creature with nothing in range to the
    // farthest square available, because that is where it is safest — and a jump, unlike a
    // walk, can put 120 feet between the fighters every single round. One teleporter jumped
    // away from 207 opponents it had been beating outright and drew all of them at the
    // hundred-round cap. When no distance offers anything, closing is the only sane move.
    const score = mine > 0 ? mine - threat * 0.7 + distance * 0.002 : -distance;
    if (squareOutranks(mine, score, bestMine, bestScore)) {
      bestMine = mine;
      bestScore = score;
      bestGround = ground;
    }
  }
  return bestGround;
}

/**
 * Perform the jump: break any grapple, then reposition. Returns true if the creature moved
 * or freed itself, which is what makes spending an action on a pure teleport worthwhile.
 */
function applyTeleport(
  mover: CombatStatblock,
  moverState: FighterState,
  foe: CombatStatblock,
  foeState: FighterState,
  source: 0 | 1,
  engagement: EngagementState,
  spec: TeleportSpec,
  evaluator: PairEvaluator,
  log: FightLog,
  carried?: CombatAction,
): boolean {
  if (teleportBlocked(moverState)) {
    if (log.on) log.push(hasCondition(moverState, "swallowed") ? `${mover.name} cannot teleport from inside ${foe.name}` : `${mover.name} cannot teleport while ${foe.name} holds it`);
    return false;
  }
  const pointRange = spec.requiresSight ? sightRange(mover, hasCondition(moverState, "blinded"), false) : Infinity;
  if (pointRange <= 0) return false;
  if (spec.requiresSight) spec = { ...spec, distance: Math.min(spec.distance, pointRange) };
  const freed = breakGrappleByTeleport(moverState, mover, log);
  const from = engagement.distance;
  const toGround = chooseTeleportGround(mover, foe, moverState, foeState, source, engagement, spec, evaluator, carried);
  if (toGround === engagement.ground) return freed;
  const to = separation(mover, moverState.height, foe, foeState.height, toGround);
  engagement.ground = toGround;
  engagement.distance = to;
  moverState.movedToward += Math.max(0, from - to);
  if (log.on) log.push(`${mover.name} teleports (${Math.round(from)} ft -> ${Math.round(to)} ft)`);
  // `breakGrappleByTeleport` freed the jumper from anything holding *it*. A grappler that
  // jumps away has done the same thing from the other end: its victim is no longer in reach.
  settleHoldGeometry(
    (source === 0 ? [mover, foe] : [foe, mover]) as [CombatStatblock, CombatStatblock],
    (source === 0 ? [moverState, foeState] : [foeState, moverState]) as [FighterState, FighterState],
    engagement,
    log,
  );
  return true;
}

/**
 * Resolve one option that may carry a teleport, in the right order relative to its own
 * damage. Every site that fires an option routes through this so the ordering rule lives in
 * one place.
 */
function resolveOptionWithTeleport(
  attacker: CombatStatblock,
  defender: CombatStatblock,
  aState: FighterState,
  dState: FighterState,
  action: CombatAction,
  rng: () => number,
  source: 0 | 1,
  engagement: EngagementState,
  log: FightLog,
  evaluator: PairEvaluator,
): void {
  if (action.kind === "autohit" && action.pull && actionInRange(action, engagement.distance) && actionRequirementMet(action, dState, source)) {
    const from = engagement.distance;
    reelToward(attacker, aState, defender, dState, engagement, action.pull);
    if (log.on) log.push(`${attacker.name} reels ${defender.name} from ${from} to ${engagement.distance} ft`);
  }
  if (action.kind === "autohit" && action.liftAndDrop) {
    // Straight up with the creature it holds, then the hold is let go; the fall is `settleFlight`'s, after this action.
    const rise = liftRise(attacker, aState, defender, dState, source, engagement, action.liftAndDrop);
    if (rise <= 0) return;
    applyMovement(attacker, aState, defender, dState, source, engagement, engagement.ground, aState.height + rise, rng, log, evaluator, "swoops up", true, rise * carryCost(attacker, defender));
    if (isDown(attacker, aState) || !carriesTarget(dState, source)) return;
    dState.conditions = dState.conditions.filter((c) => !(c.source === source && c.heldBy === "grapple"));
    pruneLinkedConditions(dState);
    if (log.on) log.push(`${attacker.name} drops ${defender.name} from ${Math.round(dState.height)} ft`);
    return;
  }
  if (action.kind === "selfbuff" && action.movement) {
    if (hasAny(aState, RULES_INCAPACITATED)) return;
    const move = action.movement, speed = currentSpeed(attacker, aState);
    if (move.requiresSight && !canSee(attacker, dState, aState, engagement.distance)) return;
    if (move.requiresSense && !canSense(attacker, dState, aState, engagement.distance)) return;
    const grant = move.distance === 0 ? 0 : move.mode === "leap" ? (movementSpeed(attacker, aState) >= (move.cost ?? 0) ? move.distance ?? 0 : 0) : speed * (move.fraction ?? 1);
    if (grant > 0) {
      if (move.mode === "leap") aState.movementPenalty += move.cost ?? 0;
      const floor = groundFloor(attacker, aState, aState.height, defender, dState);
      const probe: LegendaryMoveProbe = { speed: grant, noProvoke: !!move.noProvoke };
      if (move.mode !== "charge") chooseMovementAndRoutine(attacker, defender, aState, dState, source, engagement, evaluator, true, probe);
      applyMovement(attacker, aState, defender, dState, source, engagement,
        move.mode === "charge" ? Math.max(floor, engagement.ground - grant) : probe.result?.ground ?? Math.max(floor, engagement.ground - grant),
        move.mode === "charge" ? aState.height : probe.result?.height ?? aState.height,
        rng, log, evaluator, "uses bonus movement", !!move.noProvoke, grant, true);
    }
  }
  if (action.kind === "save" && action.jumpsToTarget) {
    // The jump is made with the creature's own movement: it lands in the target's space, which the engine keeps as the
    // floor between the pair, and what the save does (a push straight away from it) starts from there.
    aState.movementPenalty += action.jumpsToTarget.cost;
    const floor = groundFloor(attacker, aState, aState.height, defender, dState);
    if (engagement.ground > floor) {
      applyMovement(attacker, aState, defender, dState, source, engagement, floor, aState.height, rng, log, evaluator, "jumps", false, engagement.ground - floor, true);
      if (isDown(attacker, aState) || engagement.ground > floor) return;
    }
  }
  const beforeConditions = new Set(dState.conditions);
  const spec = actionTeleport(action);
  const jump = () => applyTeleport(attacker, aState, defender, dState, source, engagement, spec!, evaluator, log, jumpFirstAction(action));
  if (spec && spec.anchor === "destination") jump();
  resolveAction(attacker, defender, aState, dState, action, rng, source, engagement.distance, log);
  const pushed = dState.conditions.filter(c => !beforeConditions.has(c) && c.push);
  // A creature the hit killed is not moved before what its death sets off ("The mephit explodes when it dies", an
  // Emanation "originating from the mephit"): the damage comes first in the Hit entry, so it dies, and bursts, where
  // it was hit.
  const diedInPlace = defender.deathBurst !== undefined && isDown(defender, dState);
  if (diedInPlace) dState.conditions = dState.conditions.filter(c => !pushed.includes(c) && !(c.pull && !beforeConditions.has(c)));
  if (pushed.length && !diedInPlace) {
    const from = engagement.distance;
    const most = Math.max(...pushed.map(c => c.push!));
    engagement.ground = Math.min(engagement.maxDistance, engagement.ground + (pushed.every(c => c.pushUpTo) ? choosePush(attacker, aState, defender, dState, engagement, most, evaluator) : most));
    engagement.distance = separation(attacker, aState.height, defender, dState.height, engagement.ground);
    dState.conditions = dState.conditions.filter(c => !pushed.includes(c));
    if (log.on && engagement.distance !== from) log.push(`${defender.name} is pushed (${from} ft -> ${engagement.distance} ft)`);
  }
  // A hit that pulls its target straight toward the attacker (a rider with `pull`): the same forced move as a reel.
  const pulled = dState.conditions.filter(c => !beforeConditions.has(c) && c.pull);
  if (pulled.length && !diedInPlace) {
    const from = engagement.distance;
    const most = Math.max(...pulled.map(c => c.pull!));
    reelToward(attacker, aState, defender, dState, engagement, pulled.every(c => c.pullUpTo) ? choosePull(attacker, aState, defender, dState, engagement, most, evaluator) : most);
    dState.conditions = dState.conditions.filter(c => !pulled.includes(c));
    if (log.on && engagement.distance !== from) log.push(`${defender.name} is pulled (${from} ft -> ${engagement.distance} ft)`);
  }
  // A failed save against a lift (`Rider.lift`): the target rises and hangs there for as long as the condition lasts.
  const lifted = dState.conditions.filter(c => c.lift);
  if (lifted.length) {
    const rise = liftHeight(attacker, aState, defender, dState, engagement, Math.max(...lifted.map(c => c.lift!)), "range" in action ? action.range : undefined);
    for (const c of lifted) { c.lift = undefined; c.suspended = true; }
    if (rise > 0) {
      dState.height += rise;
      engagement.distance = separation(attacker, aState.height, defender, dState.height, engagement.ground);
      if (log.on) log.push(`${defender.name} is lifted ${rise} ft (altitude ${Math.round(dState.height)} ft)`);
    }
  }
  const blocks = (source === 0 ? [attacker, defender] : [defender, attacker]) as [CombatStatblock, CombatStatblock];
  const states = (source === 0 ? [aState, dState] : [dState, aState]) as [FighterState, FighterState];
  if (pushed.length || pulled.length || lifted.length) settleHoldGeometry(blocks, states, engagement, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
  if (spec && spec.anchor !== "destination" && !isDown(attacker, aState)) jump();
  // A Fly Speed gained from the action is used with the movement the turn has left ("you can break up your movement,
  // using some of it before and after any action"): what the new Speed allows less what the turn has already moved,
  // spent where the movement search puts it.
  if (action.kind === "selfbuff" && action.fly && aState.ownTurn && hasCondition(aState, action.condition) && !hasAny(aState, RULES_INCAPACITATED)) {
    const budget = movementSpeed(attacker, aState) - aState.turnMoved;
    if (budget > 0) {
      const probe: LegendaryMoveProbe = { speed: budget, noProvoke: false };
      // Cast to reach a foe in the air, it goes toward that foe; otherwise where the movement search puts it. So does a
      // Frightened caster, which that search keeps from moving closer.
      if (!isFrightened(aState) && dState.height > aState.height && canFly(defender, dState)) {
        const height = aState.height + Math.min(budget, dState.height - aState.height);
        probe.result = { ground: Math.max(groundFloor(attacker, aState, height, defender, dState), engagement.ground - budget), height, gain: 0 };
      } else chooseMovementAndRoutine(attacker, defender, aState, dState, source, engagement, evaluator, true, probe);
      if (probe.result && (probe.result.ground !== engagement.ground || probe.result.height !== aState.height)) {
        const g0 = engagement.ground, h0 = aState.height;
        applyMovement(attacker, aState, defender, dState, source, engagement, probe.result.ground, probe.result.height, rng, log, evaluator, "flies", false, budget, true, 1);
        aState.turnMoved += Math.max(Math.abs(engagement.ground - g0), Math.abs(aState.height - h0));
      }
    }
  }
}

/**
 * A swallowed creature is inside its swallower (blinded and restrained, with total cover against attacks and
 * other effects outside) however far off the swallow happened: a pull can draw its victim many feet toward the
 * swallower, and some swallowing attacks reach 15. So the pair stands at no
 * ground distance, the victim at its swallower's altitude, and it rides wherever the swallower goes. Left where
 * the swallow found it, a victim sat 20 feet from the swallower's follow-up attack, which reaches 5, and a demon Inhaled out of the
 * air fell thirty feet inside a stomach.
 *
 * A creature that forces its way out drops prone, in the nearest space within 10 feet. If the
 * swallower was flying, `settleFlight` drops it from there.
 */
function settleSwallowGeometry(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  engagement: EngagementState,
): void {
  let moved = false;
  for (const idx of [0, 1] as const) {
    const state = states[idx];
    const other: 0 | 1 = idx === 0 ? 1 : 0;
    if (state.swallowExitPending) {
      state.swallowExitPending = false;
      const ground = Math.max(engagement.ground, Math.min(engagement.maxDistance, groundFloor(blocks[idx], state, state.height, blocks[other], states[other])));
      moved ||= ground !== engagement.ground;
      engagement.ground = ground;
    }
    if (hasCondition(state, "swallowed") && (state.height !== states[other].height || engagement.ground !== 0)) {
      state.height = states[other].height;
      engagement.ground = 0;
      moved = true;
    }
  }
  if (moved) engagement.distance = separation(blocks[0], states[0].height, blocks[1], states[1].height, engagement.ground);
}

/**
 * A flier that loses its Speed or is knocked Prone falls, unless it hovers (the flying movement rule). This is the
 * grounded creature's only real counterplay to an airborne foe, so a
 * stun or a knockdown is worth as much as a hit.
 *
 * Checked after every resolved action and again at the top of each turn, so a fall changes
 * range before another attack, bonus action, legendary action, or movement can resolve.
 */
function carriesTarget(target: FighterState, source: 0 | 1): boolean {
  return target.conditions.some(c => c.name === "grappled" && c.source === source);
}
function carryCost(block: CombatStatblock, target: CombatStatblock): number {
  return block.freeCarry || target.size === 0 || block.size - target.size >= 2 ? 1 : 2;
}

/**
 * How far straight up a `liftAndDrop` carries the creature its user holds: the fraction of its Fly Speed, less what
 * carrying costs (`carryCost`), under the ceiling. 0 when it holds nothing or cannot fly.
 */
function liftRise(attacker: CombatStatblock, aState: FighterState, defender: CombatStatblock, dState: FighterState, source: 0 | 1, engagement: EngagementState, fraction: number): number {
  if (!carriesTarget(dState, source) || !attacker.flySpeed || currentSpeed(attacker, aState) <= 0) return 0;
  const roof = Math.min(skyRoof(engagement, defender), skyRoof(engagement, attacker) - (dState.height - aState.height));
  return Math.max(0, Math.min(attacker.flySpeed * fraction / carryCost(attacker, defender), roof - aState.height));
}

/**
 * How far straight up a `Rider.lift` of `feet` raises the target: the most, in 5-foot steps, that keeps it under the
 * ceiling and within the action's range of its source, and does not bring the source into the target's melee reach. 0 for a target inside a swallower.
 */
function liftHeight(attacker: CombatStatblock, aState: FighterState, defender: CombatStatblock, dState: FighterState, engagement: EngagementState, feet: number, range: number | undefined): number {
  if (hasCondition(dState, "swallowed")) return 0;
  for (let rise = feet; rise > 0; rise -= 5) {
    if (dState.height + rise > skyRoof(engagement, attacker)) continue;
    // Nor up to a source overhead, into its space or to where the target's own melee reaches it: a Cloud Giant 30 feet
    // over a Troll Limb raised it 30 feet, to 0 feet apart. Nearer but still out of reach is a fall the target owes.
    const near = separation(attacker, aState.height, defender, dState.height + rise, engagement.ground);
    if (near < engagement.distance && (near < MIN_SEPARATION || near <= meleeReach(defender))) continue;
    if (range !== undefined && separation(attacker, aState.height, defender, dState.height + rise, engagement.ground) > range) continue;
    return rise;
  }
  return 0;
}

/**
 * What a lift adds to its action's worth, at the odds the save fails: the fall the target owes when the hold ends (a
 * target that will fall, and only the height this use adds to one already hanging), and the offence it loses hanging
 * where it cannot reach, against what its turn is worth on the ground or beside its foe.
 */
function liftEv(action: SaveAction, feet: number, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, selfState: FighterState, evaluator: PairEvaluator): number {
  const engagement = selfState.place?.engagement;
  if (!engagement) return 0;
  const rise = liftHeight(attacker, selfState, defender, foeState, engagement, feet, action.range);
  const hanging = foeState.conditions.some(c => c.suspended);
  if (rise <= 0 && !hanging) return 0;
  const fallDice = canFly(defender, foeState) || canHover(defender, foeState) ? 0
    : Math.min(20, Math.floor((foeState.height + rise) / 10)) - (hanging ? Math.min(20, Math.floor(foeState.height / 10)) : 0);
  const fall: DamageClause = { dice: { n: fallDice, d: 6, mod: 0 }, type: "bludgeoning" };
  const grounded = separation(attacker, selfState.height, defender, hanging ? 0 : foeState.height, engagement.ground);
  const aloft = separation(attacker, selfState.height, defender, foeState.height + rise, engagement.ground);
  const free = Math.max(usableRoutineEvAtDistance(defender, attacker, foeState, grounded, evaluator), usableRoutineEvAtDistance(defender, attacker, foeState, 5, evaluator));
  const denied = Math.max(0, free - usableRoutineEvAtDistance(defender, attacker, foeState, aloft, evaluator));
  return riderLandChance(action, defender) * (fallDice * 3.5 * damageClauseMultiplier(fall, defender, false) + denied);
}

function carriedAloft(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], idx: 0 | 1): boolean {
  const holder: 0 | 1 = idx === 0 ? 1 : 0;
  return states[idx].conditions.some(c => c.name === "grappled" && c.source === holder
    && (c.holdReach === undefined || separation(blocks[0], states[0].height, blocks[1], states[1].height, 0) <= c.holdReach))
    && !isDown(blocks[holder], states[holder]) && !hasAny(states[holder], RULES_INCAPACITATED)
    && states[holder].height > 0;
}

function settleFlight(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  engagement: EngagementState,
  rng: () => number,
  log: FightLog,
): void {
  settleSwallowGeometry(blocks, states, engagement);
  settleHoldGeometry(blocks, states, engagement, log);
  settleZeroHp(blocks[0], states[0], log);
  settleZeroHp(blocks[1], states[1], log);
  // A creature whose Unconscious has ended since the last settle point remains Prone.
  settleWake(blocks[0], states[0], log);
  settleWake(blocks[1], states[1], log);
  const order: (0 | 1)[] = states[0].conditions.some(c => c.name === "grappled" && c.source === 1) ? [1, 0] : [0, 1];
  for (const idx of order) {
    const state = states[idx];
    const height = state.height;
    if (height <= 0) continue;
    // Restrained takes a swallowed creature's Speed, but it is inside something, not hanging in the air.
    if (hasCondition(state, "swallowed")) continue;
    const block = blocks[idx];
    if (carriedAloft(blocks, states, idx)) continue;
    // "If you lift it into the air, it is suspended there" (Telekinesis): it falls when the hold on it ends.
    if (state.conditions.some(c => c.suspended)) continue;
    if (state.leaping) continue;
    if (canHover(block, state)) continue;
    // "While flying, you fall if you have the Incapacitated or Prone condition or your Fly Speed is reduced to 0" (SRD
    // 5.2.1): Stunned, Incapacitated and sleepDrowsy as well as Speed 0. Charmed and Suggested are not Incapacitated
    // (`RULES_INCAPACITATED`).
    // A creature with no Fly Speed that something has lifted (a pull straight toward an airborne attacker) is not flying
    // at all: it falls whatever its conditions.
    // The Fly Speed, not what the turn has left to move with: a flier that took the action under `moveOrAct`, or spent
    // its movement standing, still has a Fly Speed.
    if (canFly(block, state) && currentSpeed(block, state) > 0 && !hasCondition(state, "prone") && !hasAny(state, RULES_INCAPACITATED)) continue;
    const action: CombatAction = {
      kind: "autohit",
      damage: [{ dice: { n: Math.min(20, Math.floor(height / 10)), d: 6, mod: 0 }, type: "bludgeoning" }],
      magical: false,
    };
    state.height = 0;
    // A creature that falls into another's space lands in the nearest unoccupied one: a flier knocked out of
    // the air directly over its foe comes down beside it, not inside it.
    const other: 0 | 1 = idx === 0 ? 1 : 0;
    engagement.ground = Math.max(engagement.ground, Math.min(engagement.maxDistance, groundFloor(block, state, 0, blocks[other], states[other])));
    engagement.distance = separation(blocks[0], states[0].height, blocks[1], states[1].height, engagement.ground);
    if (log.on) log.push(`${block.name} falls ${Math.round(height)} ft`);
    // A fall away from an airborne grappler is gravity moving the victim, not the victim
    // choosing to leave, so it breaks a hold it drops out of.
    settleHoldGeometry(blocks, states, engagement, log);
    const fallDamage = applyDamage(state, block, action, rng, false, log);
    concentrationAfterDamage(block, state, states[other], idx, fallDamage, rng, log);
    if (fallDamage > 0 && !hasCondition(state, "prone")) {
      state.conditions.push({ name: "prone", duration: "permanent", source: idx, appliedTurn: state.turnCount });
    }
    if (isDown(block, state)) return;
  }
  // A swallower that fell carries what is inside it down with it.
  settleSwallowGeometry(blocks, states, engagement);
}

/**
 * Whether a rebuke whose trigger has fired may actually answer this opponent: the reaction slot
 * and its own uses, the distance its trigger states, the sight it needs, and both fighters still
 * standing. A rebuke that answers a creature it can see uses the same ranged senses as attacks.
 */
function rebukeCanAnswer(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  actor: 0 | 1,
  distance: number,
): boolean {
  const rebuke = blocks[actor].rebuke;
  if (!rebuke) return false;
  const foe = actor === 0 ? 1 : 0;
  if (isDown(blocks[actor], states[actor]) || isDown(blocks[foe], states[foe])) return false;
  if (!rebukeAvailable(states[actor], rebuke)) return false;
  if (rebuke.triggerRange !== undefined && distance > rebuke.triggerRange) return false;
  if (rebuke.requiresSight && !canSee(blocks[actor], states[foe], states[actor], distance)) return false;
  return true;
}

/** Whichever referenced attack is worth most at this distance, or nothing if none can reach. */
function bestRebukeAttack(
  parts: { optionIdx: number; count: number }[] | undefined,
  reactor: CombatStatblock,
  foe: CombatStatblock,
  distance: number,
): { optionIdx: number; count: number } | undefined {
  let best: { optionIdx: number; count: number } | undefined;
  let bestEv = 0;
  for (const part of parts || []) {
    const action = reactor.options[part.optionIdx]?.action;
    if (!action || !actionInRange(action, distance)) continue;
    const ev = rawActionEvAtDistance(action, reactor, foe, distance) * part.count;
    if (ev > bestEv) {
      bestEv = ev;
      best = part;
    }
  }
  return best;
}

/**
 * Spend the reaction and resolve the response. Returns false without spending anything when the
 * response cannot land — a 10-foot claw answers nothing beyond that reach,
 * and a crushing response hits only a victim it is actually holding — so a
 * rebuke that cannot reach keeps its slot for a later blow in the same round.
 */
function fireRebuke(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  actor: 0 | 1,
  engagement: EngagementState,
  rng: () => number,
  log: FightLog,
): boolean {
  const foe = actor === 0 ? 1 : 0;
  const reactor = blocks[actor];
  const target = blocks[foe];
  const rebuke = reactor.rebuke!;
  const distance = engagement.distance;
  if (rebuke.action) {
    if (!actionInRange(rebuke.action, distance)) return false;
    if (!actionRequirementMet(rebuke.action, states[foe], actor)) return false;
    if (!actionTargetable(rebuke.action, reactor, target, distance, states[foe], states[actor])) return false;
    spendRebuke(states[actor], rebuke);
    if (log.on) log.push(`${reactor.name} answers with ${rebuke.name} (reaction)`);
    resolveAction(reactor, target, states[actor], states[foe], rebuke.action, rng, actor, distance, log);
    settleDeathBursts(blocks, states, engagement, rng, log);
    return true;
  }
  const part = bestRebukeAttack(rebuke.attacks, reactor, target, distance)
    ?? bestRebukeAttack(rebuke.fallbackAttacks, reactor, target, distance);
  if (!part) return false;
  const option = reactor.options[part.optionIdx];
  spendRebuke(states[actor], rebuke);
  if (log.on) log.push(`${reactor.name} answers with ${rebuke.name} (reaction)`);
  for (let i = 0; i < part.count && !isDown(target, states[foe]); i++) {
    resolveAction(reactor, target, states[actor], states[foe], option.action, rng, actor, distance, log, rebuke.advantage);
    settleDeathBursts(blocks, states, engagement, rng, log);
    // A reactor downed between two counted attacks makes no more of them, whatever downed it (the same rule as the
    // routine's down guard).
    if (isDown(reactor, states[actor])) break;
  }
  return true;
}

/** Does the trigger this rebuke names match what actually happened? */
function rebukeTriggered(rebuke: Rebuke, triggers: NonNullable<FighterState["rebukeTriggers"]>): boolean {
  if (rebuke.trigger === "hitByAttack") return triggers.hitByAttack;
  if (rebuke.trigger === "hitByMeleeAttack") return triggers.hitByMelee;
  if (!triggers.damaged) return false;
  return !rebuke.requiresDamageTypes
    || triggers.damageTypes.some((type) => rebuke.requiresDamageTypes!.includes(type));
}

/**
 * Resolve any rebuke whose trigger fired while the action just resolved was resolving.
 *
 * Deferring to here rather than firing inside `dealDamage` is what puts the reaction after its
 * trigger — an attack's damage, its riders and any retaliation it drew all land first — and it
 * also settles which reaction wins the one slot when a creature owns both kinds. A defensive
 * reaction (Parry, Shield, a damage halving) is spent while the incoming attack is still being
 * resolved, because that is the only moment it can change; a rebuke fires afterwards, and only
 * if the slot survived. No creature in the corpus carries both, so the rule costs nothing today.
 *
 * Two passes, because a rebuke that answers "takes damage" answers a rebuke's damage too. It
 * cannot run further than that: firing spends the reactor's slot, so at most one rebuke per
 * fighter resolves per action and the second cannot draw a third.
 */
/** The clauses a packet would deal, for an action kind that has any. */
function damagePacketClauses(action: CombatAction): DamageClause[] {
  if (action.kind === "random" || action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return [];
  return action.damage;
}

/**
 * The acid-spray trait, fired against the distance the fighters are actually at.
 *
 * The trait sprays "each creature within 5 feet", and in a duel that is the opponent or nobody.
 * Which means it is not the melee-hit response it used to be compiled as: a ranged shot from five
 * feet sets it off, and a reach weapon from ten feet does not. Both of those were wrong before,
 * and both were written down as known approximations rather than fixed.
 *
 * One spray per qualifying packet, so a three-attack routine that lands twice sprays twice. The
 * counter is cleared before any of it is dealt, so a pair of sprayers cannot feed each other
 * inside one settle — and the acid they deal matches no piercing-or-slashing gate anyway.
 *
 * A blow that kills the hydra is still a blow the hydra took: the spray answers it. Only the
 * recipient being down stops it, because there is nobody left to spray.
 */
function settleBloodSpray(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  engagement: EngagementState,
  rng: () => number,
  log: FightLog,
): void {
  for (const idx of [0, 1] as const) {
    const pending = states[idx].bloodSprayPending ?? 0;
    if (!pending) continue;
    states[idx].bloodSprayPending = 0;
    const retaliation = blocks[idx].retaliation;
    if (retaliation?.radius === undefined || engagement.distance > retaliation.radius) continue;
    const foe = idx === 0 ? 1 : 0;
    const back: CombatAction = { kind: "autohit", damage: retaliation.damage, magical: true };
    for (let i = 0; i < pending; i++) {
      if (isDown(blocks[foe], states[foe])) break;
      if (log.on) log.push(`${blocks[foe].name} is sprayed by ${blocks[idx].name}'s ${retaliation.name}`);
      dealDamage(blocks[idx], blocks[foe], states[idx], states[foe], back, rng, idx, false, log);
    }
  }
}

function settleRebukes(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  engagement: EngagementState,
  rng: () => number,
  log: FightLog,
): void {
  if (!blocks[0].rebuke && !blocks[1].rebuke) return;
  for (let pass = 0; pass < 2; pass++) {
    const pending = [states[0].rebukeTriggers, states[1].rebukeTriggers] as const;
    states[0].rebukeTriggers = undefined;
    states[1].rebukeTriggers = undefined;
    if (!pending[0] && !pending[1]) return;
    for (const actor of [0, 1] as const) {
      const foe = actor === 0 ? 1 : 0;
      const rebuke = blocks[actor].rebuke;
      // The approach trigger is answered where the approach happens, in `applyMovement`.
      if (!rebuke || rebuke.trigger === "enteredReach") continue;
      // A vampiric creature answers damage taken by a Bloodied foe, so it reads the *other* record.
      const bloodiedFoe = rebuke.trigger === "foeBloodiedDamaged";
      const triggers = pending[bloodiedFoe ? foe : actor];
      if (!triggers || !rebukeTriggered(rebuke, triggers)) continue;
      if (bloodiedFoe && states[foe].hp > states[foe].maxHp / 2) continue;
      if (!rebukeCanAnswer(blocks, states, actor, engagement.distance)) continue;
      fireRebuke(blocks, states, actor, engagement, rng, log);
    }
  }
  states[0].rebukeTriggers = undefined;
  states[1].rebukeTriggers = undefined;
}

/** How many further rounds `settleSprayAndRebukes` runs before it gives up; never reached (each round needs a rebuke to fire). */
const SPRAY_SETTLE_ROUNDS = 4;

/**
 * A radius retaliation and the rebukes, settled together: the spray the action drew, the rebukes, then any spray the
 * rebukes drew, until nothing is pending. A troll's trait deals poison damage to everything within 5 feet whenever it
 * is hurt by any type except psychic: a rebuke's damage is damage the troll took, and its spray lands here,
 * at the distance the rebuke was made at, not after the next action. A late spray can draw a further rebuke only from a
 * reaction still unspent, so the sequence ends. The same order at each of the four settle sites.
 */
function settleSprayAndRebukes(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  engagement: EngagementState,
  rng: () => number,
  log: FightLog,
): void {
  settleBloodSpray(blocks, states, engagement, rng, log);
  settleRebukes(blocks, states, engagement, rng, log);
  for (let round = 0; round < SPRAY_SETTLE_ROUNDS && (states[0].bloodSprayPending || states[1].bloodSprayPending); round++) {
    settleDeathBursts(blocks, states, engagement, rng, log);
    settleBloodSpray(blocks, states, engagement, rng, log);
    settleRebukes(blocks, states, engagement, rng, log);
  }
}

/** Resolve passive death effects once per body, at its death location, before play resumes.
 * Revival/replacement has already resolved in applyDamage. Petrification is not death.
 * A second pass catches the other body's death, including a fall caused by the first burst.
 */
function settleDeathBursts(
  blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState],
  engagement: EngagementState, rng: () => number, log: FightLog,
): void {
  if (!blocks[0].deathBurst && !blocks[1].deathBurst) return;
  for (let pass = 0; pass < 2; pass++) {
    for (const actor of [0, 1] as const) {
      const state = states[actor];
      const burst = blocks[actor].deathBurst;
      if (!burst || state.deathBurstUsed || state.petrifiedDefeat) continue;
      const ready = burst.trigger === "zeroHp" ? state.zeroHpBurstPending : isDown(blocks[actor], state);
      if (!ready) continue;
      state.deathBurstUsed = true;
      state.zeroHpBurstPending = false;
      if (log.on) log.push(`${blocks[actor].name} releases ${burst.name}`);
      const foe = actor === 0 ? 1 : 0;
      if (isDown(blocks[foe], states[foe]) || engagement.distance > burst.radius
        || (burst.requiresGrounded && states[foe].height > 0)) continue;
      resolveAction(blocks[actor], blocks[foe], state, states[foe], burst.action,
        rng, actor, engagement.distance, log);
      settleFlight(blocks, states, engagement, rng, log);
    }
  }
}

/** Resolve any rebuke and then any fall caused by an action, before anything else happens. */
function settleAfterAction(
  attacker: CombatStatblock,
  defender: CombatStatblock,
  attackerState: FighterState,
  defenderState: FighterState,
  source: 0 | 1,
  engagement: EngagementState,
  rng: () => number,
  log: FightLog,
): void {
  const blocks = (source === 0 ? [attacker, defender] : [defender, attacker]) as [CombatStatblock, CombatStatblock];
  const states = (source === 0 ? [attackerState, defenderState] : [defenderState, attackerState]) as [FighterState, FighterState];
  syncConcentration(blocks, states, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
  for (const idx of [0, 1] as const) {
    const response = blocks[idx].reaction?.response;
    if (!states[idx].pendingReactionResponse) continue;
    states[idx].pendingReactionResponse = false;
    if (!response || isDown(blocks[idx], states[idx])) continue;
    const other = idx === 0 ? 1 : 0;
    if (log.on) log.push(`${blocks[idx].name} uses Whirlwind of Sand`);
    resolveOptionWithTeleport(blocks[idx], blocks[other], states[idx], states[other], response,
      rng, idx, engagement, log, createPairEvaluator(blocks[0], blocks[1], false));
  }
  settleSprayAndRebukes(blocks, states, engagement, rng, log); // after an action
  settleDeathBursts(blocks, states, engagement, rng, log);
  settleFlight(blocks, states, engagement, rng, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
}

function expectedDamage(clauses: DamageClause[], defender: CombatStatblock, magical = false): number {
  return clauses.reduce((sum, clause) => sum + avgDice(clause.dice) * damageClauseMultiplier(clause, defender, magical), 0);
}

function clauseApplies(
  clause: DamageClause,
  target: FighterState,
  defender: CombatStatblock,
  attacker?: CombatStatblock,
  attackerState?: FighterState,
  attackHadAdvantage = false,
): boolean {
  if (clause.requiresTargetCondition && !hasCondition(target, clause.requiresTargetCondition)) return false;
  if (clause.requiresTargetMissingCondition && hasCondition(target, clause.requiresTargetMissingCondition)) return false;
  if (clause.requiresMovement && (!attackerState || runUpFor(attackerState, clause) < clause.requiresMovement)) return false;
  if (clause.requiresNoRunUp && attackerState && runUpFor(attackerState, clause) >= clause.requiresNoRunUp) return false;
  if (clause.requiresAttackerFury && !(attacker?.fury && attackerState?.tookDamageSinceTurnEnd)) return false;
  if (clause.oncePerTurn && attackerState?.bonusDamageUsed) return false;
  // Bloodied is half of the current maximum, which max-HP drain can have reduced.
  if (clause.requiresAttackerBloodied && (!attacker || !attackerState || attackerState.hp > attackerState.maxHp / 2)) return false;
  if (clause.requiresAttackerNotBloodied && attacker && attackerState && attackerState.hp <= attackerState.maxHp / 2) return false;
  if (clause.requiresAttackerCondition && (!attackerState || !hasCondition(attackerState, clause.requiresAttackerCondition))) return false;
  if (clause.requiresAttackerMissingCondition && attackerState && hasCondition(attackerState, clause.requiresAttackerMissingCondition)) return false;
  if (clause.requiresTargetHpAbove !== undefined && target.hp <= clause.requiresTargetHpAbove) return false;
  if (clause.targetHpMax !== undefined && target.hp > clause.targetHpMax) return false;
  // A clause gated on the target's Hit Points as they stand before this packet
  // (the packet is summed before any are taken off). Hurt is below the current maximum; Bloodied is half of it or less.
  if (clause.requiresTargetHurt && target.hp >= target.maxHp) return false;
  if (clause.requiresTargetUnhurt && target.hp < target.maxHp) return false;
  if (clause.requiresTargetBloodied && target.hp > target.maxHp / 2) return false;
  if (clause.requiresTargetNotBloodied && target.hp <= target.maxHp / 2) return false;
  // Altitude gates. An unknown attacker state means the damage has no attacker to stand on
  // (fall damage, start-of-turn ticks), so an attacker-side gate simply can't be met.
  const heightOf = (subject: "attacker" | "target") => subject === "target" ? target.height : attackerState?.height;
  if (clause.requiresGrounded && heightOf(clause.requiresGrounded) !== 0) return false;
  if (clause.requiresAirborne && !(heightOf(clause.requiresAirborne)! > 0)) return false;
  if (clause.requiresAttackAdvantage && !attackHadAdvantage) return false;
  if (clause.requiresAttackNoAdvantage && attackHadAdvantage) return false;
  if (clause.targetTypes && !clause.targetTypes.includes(defender.creatureType)) return false;
  if (clause.excludedTargetTypes?.includes(defender.creatureType)) return false;
  // A clause whose print caps the target's size is not dealt to a bigger target.
  if (clause.targetMaxSize !== undefined && defender.size > clause.targetMaxSize) return false;
  return true;
}

function transformIntoSuccessor(defender: CombatStatblock, target: FighterState, log: FightLog): void {
  if (!defender.successor) return;
  const oldName = defender.name;
  const wasSwallowed = hasCondition(target, "swallowed");
  const successor = structuredClone(defender.successor);
  const turnCount = target.turnCount;
  const height = target.height;
  const next = initState(successor);
  next.turnCount = turnCount;
  // A form change replaces combat statistics, not physical position. This also keeps the
  // engagement's cached separation valid for the flying cradle/scion successor pairs.
  next.height = height;
  next.justTransformed = true;
  next.formChanges = target.formChanges + 1;
  // This is a full stat-block replacement. Remove fields that exist only on the
  // container (especially `successor`) so the new form cannot transform repeatedly.
  for (const key of Object.keys(defender)) delete (defender as unknown as Record<string, unknown>)[key];
  Object.assign(defender, successor);
  Object.assign(target, next);
  if (log.on) log.push(`${oldName} transforms into ${defender.name} (${target.hp} hp)`);
  // The new form starts with no conditions, so it is no longer swallowed; it is placed outside the swallower the way
  // an escape is, rather than left sharing its space (a statue creature swallowed by a Kraken).
  if (wasSwallowed) target.swallowExitPending = true;
}

/**
 * The reductions of the Hit Point maximum one damage packet carries beyond the plain reduction by the damage dealt (which the
 * clause loop of `applyDamage` applies as it goes): half the damage, those behind a save, and dice of the action's own.
 *
 * - A save of its own is rolled here, after the clauses have rolled their damage and once per packet, however many
 *   clauses wait on it. Nothing is rolled when no gated clause dealt damage: there is nothing for the save to stop.
 *   Legendary Resistance is not spent on it (a reduction of the maximum is not damage,
 *   incapacitation or death outright).
 * - `"action"` is the save action's own save: the reduction lands only on the packet a failed save deals
 *   (`packet.own.saveFailed`).
 * - Dice of the action's own (`MaxHpReduction`) land with the action's own packet (`packet.own`): a hit, or a failed
 *   save. They are not damage: nothing multiplies or absorbs them.
 * The caller caps current hit points at the new maximum and slays a target whose maximum reaches 0, as it does for the
 * plain shape.
 */
function settleMaxHpReductions(
  target: FighterState,
  defender: CombatStatblock,
  action: CombatAction,
  sized: { save?: MaxHpReductionSave; amount: number; floor?: number }[],
  rng: () => number,
  log: FightLog,
  packet: DamagePacketOptions | undefined,
): void {
  const own = packet?.own && (action.kind === "attack" || action.kind === "save") ? action.maxHpReduction : undefined;
  if (!sized.length && !own) return;
  const magical = (action.kind === "attack" || action.kind === "save" || action.kind === "autohit") && action.magical;
  // One roll per printed save in a packet: two clauses behind the same save share it.
  const rolled = new Map<string, boolean>();
  const lands = (save: MaxHpReductionSave | undefined): boolean => {
    if (!save) return true;
    if (save === "action") return !!packet?.own?.saveFailed;
    const key = `${save.ability}:${save.dc}`;
    let failed = rolled.get(key);
    if (failed === undefined) {
      failed = !rollSave(defender, target, save.ability, save.dc, magical, rng);
      rolled.set(key, failed);
      if (!failed && log.on) log.push(`${defender.name} saves: its hit point maximum is not reduced`);
    }
    return failed;
  };
  let reduction = 0;
  // A printed floor ("can't reduce a target's Hit Point maximum below 1") holds the maximum there.
  let floor = 0;
  for (const entry of sized) if (lands(entry.save)) {
    reduction += entry.amount;
    floor = Math.max(floor, entry.floor ?? 0);
  }
  if (own && (!own.requiresTargetCondition || hasCondition(target, own.requiresTargetCondition)) && lands(own.save)) reduction += Math.max(0, rollDice(own.dice, rng, false));
  if (reduction <= 0) return;
  target.maxHp = Math.max(Math.min(floor, target.maxHp), target.maxHp - reduction);
  if (log.on) log.push(`${defender.name}'s hit point maximum is reduced by ${reduction} (to ${target.maxHp})`);
}

function applyDamage(
  target: FighterState,
  defender: CombatStatblock,
  action: CombatAction,
  rng: () => number,
  crit: boolean,
  log: FightLog,
  factor = 1,
  clauses: DamageClause[] = action.kind === "random" || action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport" ? [] : action.damage,
  attacker?: CombatStatblock,
  attackerState?: FighterState,
  attackHadAdvantage = false,
  reactionDistance?: number,
  packet?: DamagePacketOptions,
): number {
  const wasAboveZero = target.hp > 0;
  let total = 0;
  let drainHealing = 0;
  let fixedHealing = 0;
  let absorbedHealing = 0;
  // Reductions of the maximum that are halved or wait on a save: settled after the
  // reaction, by `settleMaxHpReductions`.
  const sizedReductions: { save?: MaxHpReductionSave; amount: number; floor?: number }[] = [];
  // Each clause that reduces the maximum by the damage taken, with the damage it dealt before any reaction.
  const dealtReductions: { clause: DamageClause; amount: number }[] = [];
  // What this packet actually dealt, for a repeat save the prose gates on a damage type.
  // `lastDamageTypes` spans the whole fight and cannot answer that question.
  const dealtTypes = new Set<string>();
  // What this packet deals in the types of the defender's death threshold, summed.
  const deathThreshold = defender.regeneration?.deathThreshold;
  let thresholdDamage = 0;
  // The dealer's held damage effects: a die subtracted from this damage roll (a breath
  // or wave that weakens), rolled once for the packet and taken off the dice before any multiplier; a weakened creature's
  // Strength weapon attack deals half.
  const damageEffects = attacker && attackerState && clauses.length
    ? heldRollEffects(attackerState, "damage", undefined, reliesOnStrength(attacker, action))
    : [];
  let penaltyLeft = rollEffectPenalty(damageEffects, rng);
  const halved = damageEffects.some(({ effect }) => effect.mode === "half") ? 0.5 : 1;
  const rolled = (clause: DamageClause): number => {
    const amount = rollDice(clause.dice, rng, crit);
    const taken = Math.min(penaltyLeft, Math.max(0, amount));
    penaltyLeft -= taken;
    return amount - taken;
  };
  for (const clause of clauses) {
    if (!clauseApplies(clause, target, defender, attacker, attackerState, attackHadAdvantage)) continue;
    // A printed once-per-turn burst (an extra burst that can be emitted only once per turn): dealt by the first hit of
    // the turn it applies to, which spends the turn's use.
    if (clause.oncePerTurnKey && attackerState) {
      if (attackerState.perTurnUsed.has(clause.oncePerTurnKey)) continue;
      attackerState.perTurnUsed.add(clause.oncePerTurnKey);
    }
    const magical = action.kind !== "random" && action.kind !== "selfbuff" && action.kind !== "selfheal" && action.magical;
    const chosenType = damageClauseType(clause, defender, magical);
    // A temporary resistance adds nothing to a standing one: resistance halves once, and an
    // immunity has already zeroed the clause.
    const temporaryResistance = !packet?.irreducible && !(!clause.bypassResistance && standingDefence(chosenType, defender, magical))
      && target.conditions.some((condition) => condition.resistDamage?.includes(chosenType));
    const multiplier = packet?.irreducible ? 1 : damageClauseMultiplier(clause, defender, magical);
    if (multiplier < 0) {
      // Absorbed: no damage, and the defender regains the absorbed share of what was rolled.
      absorbedHealing += Math.floor(rolled(clause) * halved * -multiplier * factor);
      continue;
    }
    // "Modifiers to damage are applied in the following order: adjustments such as bonuses, penalties, or multipliers
    // are applied first; Resistance is applied second; and Vulnerability is applied third" (SRD 5.2.1, p17), rounding
    // down at each step: 23 Fire halved to 11, then doubled to 22. A save for half is the first step.
    const vulnerable = multiplier > 0 && !clause.bypassResistance && defender.vulnerable.includes(chosenType);
    const adjusted = Math.floor(rolled(clause) * halved * factor);
    const resisted = Math.floor(adjusted * (vulnerable ? multiplier / 2 : multiplier) * (temporaryResistance ? 0.5 : 1));
    const amount = vulnerable ? resisted * 2 : resisted;
    total += amount;
    // Spent only when it actually lands, so a clause that rolls into a full immunity does not
    // burn the turn's one use.
    if (amount > 0 && clause.oncePerTurn && attackerState) attackerState.bonusDamageUsed = true;
    if (amount > 0) {
      target.lastDamageTypes.add(chosenType);
      dealtTypes.add(chosenType);
      target.damageTypesSinceTurnEnd.add(chosenType);
      if (deathThreshold?.types.includes(chosenType)) thresholdDamage += amount;
    }
    // Sized by the damage taken, so settled below, after the defender's reaction and a holder's share have changed
    // what it takes.
    if (amount > 0 && clause.reducesMaxHp) dealtReductions.push({ clause, amount });
    if (amount > 0 && clause.healsAttacker) drainHealing += amount;
    if (amount > 0 && clause.healsAttackerFlat) fixedHealing += clause.healsAttackerFlat;
  }
  const beforeReaction = total;
  if (total > 0 && !packet?.noReaction && defender.reaction && reactionAvailable(defender, target)
    && reactionSeesAttacker(defender, target, attackerState, reactionDistance)) {
    if (defender.reaction.kind === "deflectMissile" && action.kind === "attack" && action.ranged
      && (!action.melee || (reactionDistance !== undefined && reactionDistance > (action.reach ?? 5)))
      && [...dealtTypes].some(type => ["bludgeoning", "piercing", "slashing"].includes(type))) {
      spendReaction(defender, target);
      total = Math.max(0, total - rollDice(defender.reaction.reduction!, rng, false));
      target.pendingDeflect = total === 0;
      if (log.on) log.push(`${defender.name} deflects the missile (${total} damage remains)`);
    } else if (defender.reaction.kind === "damageHalf" && action.kind === "attack") {
      spendReaction(defender, target);
      total = Math.floor(total / 2);
      if (log.on) log.push(`${defender.name} halves the damage (reaction)`);
    } else if (defender.reaction.kind === "damageNegation" && total >= defender.hpAvg * 0.15) {
      // Negation cancels the whole packet, so spending it on a chip tick wastes the round's
      // only reaction on damage that was never going to matter. Held for something material,
      // at the same 15%-of-hit-points bar `wouldHurt` uses to price a Legendary Resistance.
      spendReaction(defender, target);
      total = 0;
      const healing = defender.reaction.healing ? rollDice(defender.reaction.healing, rng, false) : 0;
      if (healing > 0 && healBlocked(target)) {
        if (log.on) log.push(`${defender.name} negates the damage and can't regain hit points (reaction)`);
      } else {
        target.hp = Math.min(target.maxHp, target.hp + healing);
        if (log.on) log.push(`${defender.name} negates the damage and regains ${healing} hp (reaction)`);
      }
    }
  }
  // A cloaker halves the damage it takes (round down), and the target takes the same amount of damage: taken from
  // what reaches the holder after its own defences and reaction, before its temporary hit points. The caller deals the
  // victim its share (`dealDamage`).
  if (total > 0 && packet?.holderShare) {
    total = Math.floor(total / 2);
    packet.holderShare.amount = total;
    if (log.on) log.push(`${defender.name} halves the damage (${packet.holderShare.hold}): ${packet.holderShare.victim} takes the same amount`);
  }
  // A reduction equal to the damage taken: each clause's share of what the
  // defender takes once its reaction and a holder's share have acted (a holder halves the damage it takes), in
  // integers so a packet nothing changed gives the clause's own damage. Temporary hit points absorb below, and what they
  // absorb still counts as taken. A share of 0 reduces nothing and rolls no save.
  let plainReduction = 0;
  for (const { clause, amount } of dealtReductions) {
    const taken = total === beforeReaction ? amount : Math.floor((amount * total) / beforeReaction);
    if (taken <= 0) continue;
    // The plain shape has no save of its own.
    if (!clause.reducesMaxHpHalf && !clause.reducesMaxHpSave) plainReduction += taken;
    // Half the necrotic damage taken: no rounding is printed, so the general rule applies (round down).
    else sizedReductions.push({ save: clause.reducesMaxHpSave, amount: clause.reducesMaxHpHalf ? Math.floor(taken / 2) : taken, floor: clause.reducesMaxHpFloor });
  }
  if (plainReduction > 0) {
    target.maxHp = Math.max(0, target.maxHp - plainReduction);
    if (log.on) log.push(`${defender.name}'s hit point maximum is reduced by ${plainReduction} (to ${target.maxHp})`);
  }
  settleMaxHpReductions(target, defender, action, sizedReductions, rng, log, packet);
  if (total > 0 && attacker && attackerState) {
    const reactionScale = beforeReaction > 0 ? total / beforeReaction : 0;
    const healing = Math.floor(drainHealing * reactionScale) + fixedHealing;
    // The drainer's own heal: blocked only if the drainer holds a heal block.
    if (healing > 0 && healBlocked(attackerState)) {
      if (log.on && attacker) log.push(`${attacker.name} can't regain hit points (drain)`);
    } else if (healing > 0) {
      const before = attackerState.hp;
      attackerState.hp = Math.min(attackerState.maxHp, attackerState.hp + healing);
      if (log.on && attackerState.hp > before) log.push(`${attacker.name} regains ${attackerState.hp - before} hit points (drain; ${attackerState.hp} hp)`);
    }
  }
  // A clause that drops the target to 1 Hit Point instead of 0 and leaves it Petrified. Checked before the subtraction
  // lands, because what the clause
  // keys on is the damage being lethal, and a frozen statue is out of the duel the way stone is,
  // beyond the reach of the regeneration or Undead Fortitude that would otherwise answer a
  // drop to 0.
  const freezes = total > 0 && target.hp - total <= 0
    && clauses.some((clause) => clause.petrifiesOnLethalDamage)
    && !defender.conditionImmune.includes("petrified");
  if (freezes) {
    target.hp = 1;
    target.petrifiedDefeat = true;
    target.slain = true;
    if (log.on) log.push(`${defender.name} is frozen solid`);
    return total;
  }
  // Temporary hit points are spent before hit points, and they are not hit points: every threshold below
  // (0 HP, Bloodied, the maximum) still reads `hp`.
  const absorbed = Math.min(target.tempHp, Math.max(0, total));
  if (absorbed > 0) {
    target.tempHp -= absorbed;
    if (log.on) log.push(`${defender.name} loses ${absorbed} temporary hit points${target.tempHp > 0 ? ` (${target.tempHp} left)` : ""}`);
  }
  target.hp -= total - absorbed;
  if (defender.heads && target.heads !== undefined && total > 0) {
    target.headTurnDamage += total;
    if (dealtTypes.has("fire")) target.headFire = true;
    if (!target.headLostThisTurn && target.headTurnDamage >= defender.heads.threshold) {
      target.headLostThisTurn = true;
      target.heads = Math.max(0, target.heads - 1);
      target.headsLost++;
      if (log.on) log.push(`${defender.name} loses a head (${target.heads} remain)`);
      if (!target.heads) { target.hp = 0; target.slain = true; }
    }
  }
  // Absorption lands with the rest of the packet: the net of the damage and the heal, capped at the maximum, which is
  // what `damageMultiplier`'s negative price assumes.
  if (absorbedHealing > 0 && healBlocked(target)) {
    if (log.on) log.push(`${defender.name} absorbs the damage and can't regain hit points (${target.hp} hp)`);
  } else if (absorbedHealing > 0) {
    target.hp = Math.min(target.maxHp, target.hp + absorbedHealing);
    if (log.on) log.push(`${defender.name} absorbs the damage and regains ${absorbedHealing} hp (${Math.max(0, target.hp)} hp after the hit)`);
  }
  target.hp = Math.min(target.hp, target.maxHp);
  if (crit && total > 0) target.tookCritical = true;
  if (total > 0) target.tookDamageSinceTurnEnd = true;
  if (target.maxHp <= 0) {
    target.hp = 0;
    target.slain = true;
  }
  settleZeroHp(defender, target, log);
  // A troll's death rule: it is slain only by an attack that deals at least 10 acid or fire damage while the troll is at 0 hit
  // points: the packet must find the holder at 0 HP (the one that takes it there does
  // not count), and its acid and fire together, after the holder's defences and scaled by what a reaction or a holder's
  // share left of the packet, must reach the amount. `attackOnly`: the packet is an attack roll's own hit (`own` is set
  // by `resolveAction` for the hit alone); a wording that says the creature takes the damage counts any packet. Death,
  // not a failed regeneration: `slain`.
  if (deathThreshold && !wasAboveZero && !target.slain && thresholdDamage > 0
    && (!deathThreshold.attackOnly || (action.kind === "attack" && !!packet?.own))) {
    const taken = total === beforeReaction ? thresholdDamage : Math.floor((thresholdDamage * total) / beforeReaction);
    if (taken >= deathThreshold.amount) {
      target.slain = true;
      if (log.on) log.push(`${defender.name} dies (${taken} ${deathThreshold.types.join(" or ")} damage at 0 hit points)`);
    }
  }
  // A target slain when a ray takes it to 0 hit points: death, not a drop to 0, so the troll rule, Undead Fortitude
  // and a reset written as a replacement do not answer it. The print keys it on
  // this packet *reducing* the target to 0, so a target already at 0 (a regenerator held up by its death rule) is not
  // slain by it.
  // A reset printed as a replacement (if it would drop to 0 hit points, it resets to N; `mythicResetReplaces`) means
  // its holder is never reduced to 0 while the reset is unspent, so the
  // slay has no trigger and the reset below answers the packet as it answers any other. And a holder with a successor
  // form does die, but its second form is a separate creature the slay does not prevent: `slainByPacket` lets the
  // successor below through.
  // Resets that say the creature doesn't die and instead regains hit points compile the same flag, so they answer a slay
  // too. The parser sets the field.
  const resetReplaces = !!defender.mythicResetReplaces && !!defender.mythicResetHp && !target.mythicActive;
  // Undead Fortitude answers first. If damage reduces the zombie to 0 Hit Points, it makes a Constitution saving throw,
  // and on a success it drops to 1 Hit Point
  // instead: a made save means the packet did not reduce its holder to 0, so the slay has no trigger. Where the save will
  // be rolled (`fortitudeRolls`: not against Radiant damage or a critical hit, as printed) the slay waits for it, below;
  // the save keeps its place after the damage-triggered repeat saves, so no other die moves.
  const fortitudeRolls = defender.undeadFortitude && total > 0 && !crit && !clauses.some((d) =>
    damageClauseType(d, defender, action.kind !== "random" && action.kind !== "selfbuff" && action.kind !== "selfheal" && action.magical) === "radiant");
  let slainByPacket = false;
  let slayPending = false;
  if (wasAboveZero && total > 0 && target.hp <= 0 && !target.slain && !resetReplaces && slayApplies(action, defender)) {
    if (fortitudeRolls) slayPending = true;
    else {
      target.slain = true;
      slainByPacket = true;
      if (log.on) log.push(`${defender.name} dies (reduced to 0 hit points by this damage)`);
    }
  }
  // A reset printed as a regain of a fixed number of hit points (`mythicResetRegains`) is stopped by a heal block that
  // holds on its holder at the moment it is reduced to 0. Read here,
  // before the packet's own damage ends or re-saves any condition below.
  const resetRegainBlocked = !!defender.mythicResetRegains && target.hp <= 0 && !!defender.mythicResetHp && !target.mythicActive
    && !target.slain && healBlocked(target);
  if (total > 0 && target.conditions.some((c) => c.saveOnDamage && c.save)) {
    target.conditions = target.conditions.filter((condition) => {
      if (condition.linkedParent) return true;
      if (!condition.saveOnDamage || !condition.save) return true;
      // A poisoned target may redo the save each time fire damage lands on it. A repeat save the prose gates on a
      // damage type is not offered by any other.
      if (condition.saveOnDamageTypes?.length && !condition.saveOnDamageTypes.some((t) => dealtTypes.has(t))) return true;
      let saved = rollSave(defender, target, condition.save.ability, condition.save.dc, !!condition.magical, rng, !!condition.saveOnDamageAdvantage, repeatSaveConditions(condition, target));
      // Same gate as the initial save (`wouldHurt`) and the end-of-turn repeat: a damage-triggered
      // re-save is still a save, and burning the pool to shrug off something harmless is how a
      // dragon arrives at the fight that matters with nothing left.
      // A basilisk's hold reads as a mild Restrained, but failing this save is what turns the
      // victim to stone, so the escalation is what the Legendary Resistance is really for.
      const worthResisting = linkedWorthResisting(condition, target);
      if (!saved && worthResisting && target.legendaryResistances > 0) {
        target.legendaryResistances--;
        saved = true;
        if (log.on) log.push(`${defender.name} uses Legendary Resistance`);
      }
      if (saved && log.on) log.push(`${defender.name} ends ${condition.name} after taking damage`);
      if (saved) grantSuccessImmunity(target, condition.immunity, "repeat", log, defender);
      return !saved;
    });
    pruneLinkedConditions(target, log, defender.name);
  }
  if (total > 0 && target.conditions.some((c) => c.endsOnDamage)) {
    // A sleeper the damage wakes remains Prone (`settleWake`): note what it holds, then settle once the copies are gone.
    settleWake(defender, target, log);
    target.conditions = target.conditions.filter((c) => !c.endsOnDamage);
    pruneLinkedConditions(target, log, defender.name);
    if (log.on) log.push(`${defender.name} shakes off its conditions`);
    settleWake(defender, target, log);
  }
  // Undead Fortitude: con save DC 5 + damage to drop to 1 HP instead (not vs crits or radiant).
  // A creature whose maximum was just drained to 0 is already slain; Undead Fortitude cannot hold it at 1.
  if (target.hp <= 0 && !target.slain && fortitudeRolls) {
    // A Constitution save rolled outside `rollSaveMargin`; a held save effect reaches it too.
    const held = heldRollEffects(target, "save", "con");
    const adv = held.some(({ effect }) => effect.mode === "advantage");
    const dis = held.some(({ effect }) => effect.mode === "disadvantage");
    const r1 = d20(rng);
    const r2 = adv !== dis ? d20(rng) : r1;
    const roll = adv && !dis ? Math.max(r1, r2) : dis && !adv ? Math.min(r1, r2) : r1;
    const fortitudeTotal = roll + (defender.saves.con ?? defender.abilityMods.con) - rollEffectPenalty(held, rng);
    spendNextRollEffects(target, held);
    if (fortitudeTotal >= 5 + total) {
      target.hp = 1;
      if (log.on) log.push(`${defender.name} holds on (Undead Fortitude)`);
    } else if (log.on) log.push(`${defender.name} fails to hold on (Undead Fortitude, DC ${5 + total})`);
  }
  // The slay that waited for the save: its holder is still at 0 hit points (the save failed), so the packet did reduce it
  // to 0 and it dies.
  if (slayPending && target.hp <= 0 && !target.slain) {
    target.slain = true;
    slainByPacket = true;
    if (log.on) log.push(`${defender.name} dies (reduced to 0 hit points by this damage)`);
  }
  if (resetRegainBlocked) {
    // The trait is spent, nothing is regained, and the holder is down (at 0 hit points, not slain).
    target.mythicActive = true;
    if (log.on) log.push(`${defender.name} can't regain hit points: its mythic trait is spent`);
  } else if (target.hp <= 0 && defender.mythicResetHp && !target.mythicActive && !target.slain) {
    target.hp = defender.mythicResetHp;
    target.maxHp = Math.max(target.maxHp, defender.mythicResetHp);
    target.mythicActive = true;
    // The reset restores what its print names. `mythicResetKeeps` marks what it does
    // not (a Legendary Resistance pool or a particular trait that some prints leave alone). Without the
    // field the pool is refilled and every recharge readied, as the prints say.
    const keeps = defender.mythicResetKeeps;
    if (!keeps?.legendaryResistance) target.legendaryResistances = defender.legendaryResistances;
    if (!keeps?.recharge?.length) {
      for (const resource of target.recharge.values()) resource.ready = true;
    } else {
      const kept = new Set<string | number>();
      defender.options.forEach((option, idx) => {
        if (option.uses.t === "recharge" && keeps.recharge!.includes(option.name)) kept.add(option.uses.pool ?? idx);
      });
      for (const [key, resource] of target.recharge) if (!kept.has(key)) resource.ready = true;
    }
    if (log.on) log.push(`${defender.name} enters its mythic phase (${target.hp} hp)`);
  }
  if (target.hp <= 0 && defender.successor && (!target.slain || slainByPacket)) transformIntoSuccessor(defender, target, log);
  if (wasAboveZero && target.hp <= 0 && defender.deathBurst?.trigger === "zeroHp") {
    target.zeroHpBurstPending = true;
  }
  // An effect that deals no damage (a save for a condition alone) has none to report.
  if (log.on && (total > 0 || clauses.length > 0)) log.push(`${defender.name} takes ${total} damage (${Math.max(0, target.hp)} hp left)`);
  return total;
}

function endConcentration(
  source: 0 | 1,
  sourceState: FighterState,
  otherState: FighterState,
  sourceBlock: CombatStatblock,
  log: FightLog,
): void {
  if (!sourceState.concentrating) return;
  sourceState.concentrating = false;
  sourceState.concentrationEndsTurn = undefined;
  sourceState.conditions = sourceState.conditions.filter((c) => c.concentrationSource !== source);
  otherState.conditions = otherState.conditions.filter((c) => c.concentrationSource !== source);
  pruneLinkedConditions(sourceState);
  pruneLinkedConditions(otherState);
  if (log.on) log.push(`${sourceBlock.name} loses Concentration`);
}

/** Drop a stale Concentration flag after the final effect maintained by that caster ends. */
function syncConcentration(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  log: FightLog,
): void {
  for (const source of [0, 1] as const) {
    if (!states[source].concentrating) continue;
    if (states[source].hp <= 0 || isDown(blocks[source], states[source]) || hasAny(states[source], RULES_INCAPACITATED)) {
      endConcentration(source, states[source], states[source === 0 ? 1 : 0], blocks[source], log); continue;
    }
    const hasEffect = states.some((state) => state.conditions.some((condition) => condition.concentrationSource === source));
    if (!hasEffect) {
      states[source].concentrating = false;
      states[source].concentrationEndsTurn = undefined;
      if (log.on) log.push(`${blocks[source].name} ends Concentration`);
    }
  }
}

function beginConcentration(
  action: CombatAction,
  source: 0 | 1,
  sourceState: FighterState,
  otherState: FighterState,
  sourceBlock: CombatStatblock,
  log: FightLog,
): void {
  if (!("concentration" in action) || !action.concentration) return;
  // A sustained spell used again is the same casting: its Concentration and what it holds carry on.
  const sustains = (action.kind === "save" || action.kind === "attack") && action.sustained ? action.spellName : undefined;
  if (sustains && sustainsSpell(sourceState, sustains)) return;
  endConcentration(source, sourceState, otherState, sourceBlock, log);
  if (sustains) sourceState.conditions.push({ name: "sustaining", sustainsSpell: sustains, duration: "permanent", source, concentrationSource: source, appliedTurn: sourceState.turnCount });
  sourceState.concentrating = true;
  const rounds = "concentrationRounds" in action ? action.concentrationRounds : undefined;
  sourceState.concentrationEndsTurn = rounds === undefined ? undefined : sourceState.turnCount + rounds;
}

function concentrationAfterDamage(
  damagedBlock: CombatStatblock,
  damagedState: FighterState,
  otherState: FighterState,
  damagedIndex: 0 | 1,
  damage: number,
  rng: () => number,
  log: FightLog,
): void {
  if (damage <= 0 || !damagedState.concentrating) return;
  if (damagedState.hp <= 0 || isDown(damagedBlock, damagedState) || hasAny(damagedState, RULES_INCAPACITATED)) {
    endConcentration(damagedIndex, damagedState, otherState, damagedBlock, log); return;
  }
  const dc = Math.min(30, Math.max(10, Math.floor(damage / 2)));
  if (!rollSaveMargin(damagedBlock, damagedState, "con", dc, false, rng, false, [], damagedState.conditions.some((c) => c.concentrationDisadvantage)).saved) {
    endConcentration(damagedIndex, damagedState, otherState, damagedBlock, log);
  }
}

/** The trigger record for this creature, created on first use so the common case allocates none. */
function markRebukeTrigger(state: FighterState): NonNullable<FighterState["rebukeTriggers"]> {
  if (!state.rebukeTriggers) state.rebukeTriggers = { damaged: false, hitByAttack: false, hitByMelee: false, damageTypes: [] };
  return state.rebukeTriggers;
}

/**
 * Damage types this packet actually dealt, for the triggers that gate on them — one undead
 * sprays only on Piercing or Slashing. Read the same way the retaliation gate reads them, off
 * the clauses rather than the accumulated `lastDamageTypes`, which spans the whole fight.
 */
function damagePacketTypes(action: CombatAction, clauses: DamageClause[] | undefined, defender: CombatStatblock): string[] {
  if (action.kind === "random" || action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return [];
  return (clauses ?? action.damage).map((clause) => damageClauseType(clause, defender, action.magical));
}

/** Remove only the swallow state made by `source`; unrelated conditions survive the exit. */
function releaseSwallowedCreature(state: FighterState, name: string, source: 0 | 1, log: FightLog, disgorged = false): void {
  state.conditions = state.conditions.filter((condition) =>
    condition.source !== source || !["swallowed", "blinded", "restrained"].includes(condition.name)
  );
  pruneLinkedConditions(state);
  state.conditions.push({
    name: "prone",
    duration: "permanent",
    source,
    appliedTurn: state.turnCount,
  });
  state.swallowExitPending = true;
  if (log.on) log.push(disgorged ? `${name} is disgorged and falls prone` : `${name} forces its way out and falls prone`);
}

/**
 * A grant of temporary hit points to the creature that acted. The pool does not stack: a larger grant replaces a
 * smaller one and a smaller grant is wasted, which is how the rule reads for a recipient that always keeps the best.
 */
function grantTempHp(block: CombatStatblock, state: FighterState, grant: SelfTempHp, amount: number, log: FightLog): void {
  if (amount <= 0) return;
  const kept = Math.max(state.tempHp, amount);
  if (kept > state.tempHp) {
    state.tempHp = kept;
    state.tempHpExpiresTurn = grant.expires === "startOfNextTurn" ? state.turnCount + 1 : undefined;
    if (log.on) log.push(`${block.name} gains ${amount} temporary hit points`);
  } else if (log.on) log.push(`${block.name} keeps its ${state.tempHp} temporary hit points`);
}

/** Whether a grant that rides on a damaging action pays against this target. */
function tempHpGrantApplies(grant: SelfTempHp, defender: CombatStatblock, target: FighterState, source: 0 | 1): boolean {
  if (grant.requiresTargetCondition && !hasConditionFrom(target, grant.requiresTargetCondition, source)) return false;
  if (grant.excludedTargetTypes?.includes(defender.creatureType)) return false;
  return true;
}

/** Options on one damage packet, for the paths that are not an ordinary hit. */
interface DamagePacketOptions {
  /** A share the defender's damage owes its victim; `applyDamage` fills `amount` with the halved damage. */
  holderShare?: { hold: string; victim: string; amount: number };
  /** The packet triggers none of the defender's reactions (a holder's share is not an attack). */
  noReaction?: boolean;
  /**
   * The packet is the action's own landing (an attack's hit, a save action's damage), not a burst, a choice, a tick or
   * an aura: dice of the action's own lower the maximum here (`MaxHpReduction`). `saveFailed` is a save action's own
   * save, for a reduction that waits on it (`MaxHpReductionSave`, `"action"`).
   */
  own?: { saveFailed?: boolean };
  /** No defence touches this damage (`SelfCost.irreducible`): no immunity, resistance or temporary resistance applies. */
  irreducible?: boolean;
}

/**
 * The hold through which the damaged creature shares its damage with its victim, if any: a condition on the victim
 * (`victimState`) from the damaged creature (`holder`) that carries `sharesHolderDamage`. Read at each packet, so the
 * share ends the moment the hold does.
 */
function sharingHold(victimState: FighterState, holder: 0 | 1): ConditionState | undefined {
  return victimState.conditions.find((condition) => condition.sharesHolderDamage && condition.source === holder);
}

/**
 * The victim's share: "the target takes the same amount of damage". A number, not typed damage, so the victim's
 * resistances and immunities do not touch it and none of its reactions answer it; it spends temporary hit points and
 * meets every rule `applyDamage` applies at 0 hit points, and a concentrating victim checks Concentration.
 */
function dealHolderShare(
  victim: CombatStatblock, victimState: FighterState, holderState: FighterState, victimIndex: 0 | 1,
  amount: number, rng: () => number, log: FightLog,
): void {
  if (amount <= 0) return;
  const share: CombatAction = {
    kind: "autohit",
    damage: [{ dice: { n: 0, d: 1, mod: amount }, type: "untyped", bypassResistance: true }],
    magical: false,
  };
  const total = applyDamage(victimState, victim, share, rng, false, log, 1, share.damage, undefined, undefined, false, undefined, { noReaction: true });
  concentrationAfterDamage(victim, victimState, holderState, victimIndex, total, rng, log);
}

function dealDamage(
  attacker: CombatStatblock,
  defender: CombatStatblock,
  aState: FighterState,
  dState: FighterState,
  action: CombatAction,
  rng: () => number,
  source: 0 | 1,
  crit: boolean,
  log: FightLog,
  factor = 1,
  clauses?: DamageClause[],
  attackHadAdvantage = false,
  reactionDistance?: number,
  own?: DamagePacketOptions["own"],
): number {
  const holder: 0 | 1 = source === 0 ? 1 : 0;
  const hold = sharingHold(aState, holder);
  const holderShare = hold ? { hold: hold.name, victim: attacker.name, amount: 0 } : undefined;
  const wasBloodied = dState.hp <= dState.maxHp / 2;
  const total = applyDamage(dState, defender, action, rng, crit, log, factor, clauses, attacker, aState, attackHadAdvantage, reactionDistance, holderShare || own ? { holderShare, own } : undefined);
  // Temporary Hit Points matching the damage dealt, and the fixed grants that ride on a damaging action
  // (a dragon that then gains 15 temporary hit points). Read off the damage this packet actually dealt.
  const grant = "selfTempHp" in action ? action.selfTempHp : undefined;
  if (grant && tempHpGrantApplies(grant, defender, dState, source)) {
    const amount = grant.ofDamage ? (grant.ofDamage === "half" ? Math.floor(total / 2) : total) : rollDice(grant.dice!, rng, false);
    grantTempHp(attacker, aState, grant, amount, log);
  }
  // Every damage packet in the engine passes through here with both sides in hand, which makes
  // this the one place a "when it takes damage" trigger can be recorded without threading the
  // engagement into the damage path. `attacker.rebuke` is asked as well because some creatures
  // answer damage dealt to their *foe* rather than to themselves.
  // A trait keyed to the hydra being hurt by piercing or slashing damage answers the damage rather
  // than the attacker, so it is recorded here and fired against the engagement distance by
  // `settleBloodSpray`, exactly as a rebuke trigger is. The qualifying clause must actually be
  // able to land: a piercing hit on a creature immune to piercing is not damage it took, and a
  // mixed packet is judged clause by clause rather than on the total.
  const spray = defender.retaliation;
  if (spray?.radius !== undefined) {
    const magical = action.kind !== "random" && action.kind !== "selfbuff" && action.kind !== "selfheal"
      && action.kind !== "teleport" && action.magical;
    const qualifying = (clauses ?? damagePacketClauses(action)).some((clause) => {
      const type = damageClauseType(clause, defender, magical);
      if (spray.requiresDamageTypes && !spray.requiresDamageTypes.includes(type)) return false;
      return damageClauseMultiplier(clause, defender, magical) > 0;
    });
    if (qualifying) dState.bloodSprayPending = (dState.bloodSprayPending ?? 0) + 1;
  }
  if (total > 0 && (defender.rebuke || attacker.rebuke)) {
    markRebukeTrigger(dState).damaged = true;
    for (const type of damagePacketTypes(action, clauses, defender)) dState.rebukeTriggers!.damageTypes.push(type);
  }
  if (total > 0) {
    if (wasBloodied) aState.bloodiedDamage = true;
    if (defender.aversionToFire && damagePacketTypes(action, clauses, defender).includes("fire") && damageClauseMultiplier({ dice: { n: 0, d: 1, mod: 1 }, type: "fire" }, defender, !!action.spell) > 0) {
      dState.conditions = dState.conditions.filter(c => c.name !== "fireAversion");
      dState.conditions.push({ name: "fireAversion", duration: "endOfTargetNextTurn", source, appliedTurn: dState.turnCount,
        rollEffects: [{ roll: "attack", mode: "disadvantage" }, { roll: "check", mode: "disadvantage" }] });
    }
    const speedLoss = defender.speedLossOnDamage;
    if (speedLoss && speedLoss.types.some((type) => damagePacketTypes(action, clauses, defender).includes(type)
      && damageClauseMultiplier({ dice: { n: 0, d: 1, mod: 1 }, type }, defender, !!action.spell) > 0)) {
      dState.conditions = dState.conditions.filter(c => c.name !== "speedLoss");
      dState.conditions.push({ name: "speedLoss", duration: "endOfTargetNextTurn", source, appliedTurn: dState.turnCount, speedCut: speedLoss.feet });
      if (log.on) log.push(`${defender.name}'s Speed decreases by ${speedLoss.feet} ft`);
    }
    aState.damageDealtThisTurn += total;
    const escaped = aState.conditions.find((condition) =>
      condition.sourceDamageEscapeThreshold !== undefined
      && aState.damageDealtThisTurn >= condition.sourceDamageEscapeThreshold
      && !condition.sourceDamageEscapePending
    );
    if (escaped) {
      if (escaped.sourceDamageEscapeSaveDc === undefined) {
        releaseSwallowedCreature(aState, attacker.name, escaped.source, log);
      } else {
        escaped.sourceDamageEscapePending = true;
      }
    }
  }
  if (total > 0) {
    const actionName = "actionName" in action ? String(action.actionName).split(" (")[0].toLowerCase() : undefined;
    dState.conditions = dState.conditions.filter(c => !(c.endsOnSourceDamage && c.source === source
      && (!c.sourceDamageException || c.sourceDamageException.toLowerCase() !== actionName)));
    pruneLinkedConditions(dState);
  }
  concentrationAfterDamage(defender, dState, aState, source === 0 ? 1 : 0, total, rng, log);
  if (holderShare) dealHolderShare(attacker, aState, dState, source, holderShare.amount, rng, log);
  if (dState.pendingDeflect) {
    dState.pendingDeflect = false;
    const redirect = defender.reaction?.redirect;
    if (redirect && reactionDistance !== undefined && reactionDistance <= redirect.range!
      && !isDown(defender, dState) && !isDown(attacker, aState)
      && canSee(defender, aState, dState, reactionDistance)) {
      if (log.on) log.push(`${defender.name} redirects the missile's force`);
      resolveAction(defender, attacker, dState, aState, redirect, rng, source === 0 ? 1 : 0, reactionDistance, log);
    }
  }
  return total;
}

function applyChoiceRiders(attacker: CombatStatblock, target: FighterState, defender: CombatStatblock, attackerState: FighterState, action: CombatAction, rng: () => number, source: 0 | 1, log: FightLog, distance?: number): void {
  if (!("choiceRiders" in action) || !action.choiceRiders?.length || target.hp <= 0) return;
  for (const choice of action.choiceRiders) {
    if (defender.conditionImmune.includes(choice.condition) || hasCondition(target, choice.condition)) continue;
    const extra = expectedDamage(choice.damage, defender, action.magical);
    if (extra > 0 && extra < target.hp) {
      if (log.on) log.push(`${defender.name} chooses extra damage instead of ${choice.condition}`);
      dealDamage(attacker, defender, attackerState, target, action, rng, source, false, log, 1, choice.damage, false, distance);
    } else {
      applyRiders(target, defender, attackerState, [{ condition: choice.condition, duration: choice.duration }], source, action.magical, rng, log);
    }
  }
}

/**
 * "The spell ends early immediately after the target makes an attack roll, deals damage, or casts a spell" (Invisibility,
 * SRD 5.2.1, p143). An action that is none of the three leaves the spell standing: a Quasit's Scare is a Wisdom save for
 * the Frightened condition, not a spell, and deals nothing, yet it revealed the Quasit every time.
 */
function revealsCaster(action: CombatAction): boolean {
  if (action.kind !== "save" && action.kind !== "autohit") return true;
  return !!action.spell || action.damage.length > 0 || (action.kind === "save" && !!action.marginDamage);
}

/** Invisibility ends the moment the creature attacks, deals damage, or casts a spell. */
function breakInvisibility(state: FighterState, block: CombatStatblock, log: FightLog, spellStands = false): void {
  // `spellStands`: the action is none of the spell's three, so the Invisibility spell stays; an Invisible condition with
  // its own printed end (a Will-o'-Wisp's Vanish "ends early immediately after the wisp makes an attack roll or uses
  // Consume Life") ends as before.
  const ends = (c: ConditionState): boolean => c.name === "invisible" && c.breaksOnAttackOrSpell !== false && !(spellStands && c.spellLevel !== undefined);
  if (state.conditions.some(ends)) {
    const dropsConcentration = state.conditions.some(c => ends(c) && c.concentrationSource !== undefined);
    state.conditions = state.conditions.filter((c) => !ends(c));
    if (dropsConcentration) { state.concentrating = false; state.concentrationEndsTurn = undefined; }
    pruneLinkedConditions(state);
    if (log.on) log.push(`${block.name} is revealed`);
  }
}

function resolveSaveBurst(attacker: CombatStatblock, defender: CombatStatblock, aState: FighterState, dState: FighterState, action: CombatAction, eff: SaveEffect, rng: () => number, source: 0 | 1, log: FightLog, distance: number): void {
  const magical = action.kind === "attack" ? action.magical : true;
  const outcome = rollSaveMargin(defender, dState, eff.ability, eff.dc, magical, rng, false, actionSaveConditions(eff));
  let saved = outcome.saved;
  const wouldIncapacitate = eff.riders?.some((rider) => INCAPACITATING.has(rider.condition) && marginAdmits(rider, outcome.failedBy)
    && !immunityGated(rider, defender));
  if (!saved && wouldIncapacitate && dState.legendaryResistances > 0) {
    dState.legendaryResistances--;
    saved = true;
    if (log.on) log.push(`${defender.name} uses Legendary Resistance`);
  }
  if (!saved && eff.riders?.some(marginGated)) logSaveMargin(log, defender.name, outcome.failedBy);
  // Evasion / Avoidance: a save for half becomes none on a success and half on a failure.
  const share = evasionShares(eff.onSuccess, eff.ability, defender, activeDefences(defender, dState));
  const factor = saved ? share.onSave : share.onFail;
  if (factor > 0) {
    if (log.on) log.push(`${defender.name} is caught in the burst`);
    dealDamage(attacker, defender, aState, dState, action, rng, source, false, log, factor, eff.damage, false, distance);
  } else {
    if (log.on) log.push(`${defender.name} avoids the burst`);
  }
  if (!saved && eff.riders?.length) {
    applyRiders(dState, defender, aState, eff.riders, source, magical, rng, log, true, !!("concentration" in action && action.concentration), holdReachAt(action, distance), undefined, outcome.failedBy);
  }
}

/** The cost an option deals its own user (`SelfCost`), for the action kinds that can carry one. */
function selfCostOf(action: CombatAction): SelfCost | undefined {
  return action.kind === "attack" || action.kind === "save" || action.kind === "autohit" ? action.selfCost : undefined;
}

/**
 * Pay an option's cost to its own user: for example, force damage of 5 (1d10) paid once
 * the attack resolves, or 7 (2d6) slashing damage that nothing can reduce. Damage
 * taken like any other: the user's own defences apply unless the print rules them out, temporary hit points absorb it,
 * and every rule `applyDamage` applies at 0 hit points is met (the troll rule included). It is nobody's attack, so no
 * reaction answers it and the foe's rebukes are not triggered; a concentrating user checks Concentration, and a user
 * whose own trait answers damage it takes within a radius records that trigger the way
 * `dealDamage` does, for `settleBloodSpray`. The chooser does not price the cost.
 */
function paySelfCost(user: CombatStatblock, userState: FighterState, otherState: FighterState, userIndex: 0 | 1, action: CombatAction, cost: SelfCost, rng: () => number, log: FightLog): void {
  if (isDown(user, userState)) return;
  const clause: DamageClause = { dice: cost.dice, type: cost.type };
  const magical = action.kind !== "random" && action.kind !== "selfbuff" && action.kind !== "selfheal" && action.kind !== "teleport" && action.magical;
  const packet: CombatAction = { kind: "autohit", damage: [clause], magical };
  if (log.on) log.push(`${user.name} pays its own cost (${cost.type})`);
  const total = applyDamage(userState, user, packet, rng, false, log, 1, packet.damage, undefined, undefined, false, undefined, { noReaction: true, irreducible: cost.irreducible });
  const spray = user.retaliation;
  if (spray?.radius !== undefined && (!spray.requiresDamageTypes || spray.requiresDamageTypes.includes(cost.type))
    && (cost.irreducible || damageClauseMultiplier(clause, user, magical) > 0)) {
    userState.bloodSprayPending = (userState.bloodSprayPending ?? 0) + 1;
  }
  concentrationAfterDamage(user, userState, otherState, userIndex, total, rng, log);
}

/**
 * Resolve one action. An option with a cost to its own user pays it here, the one path every slot shares (a routine
 * part, a bonus action, a Legendary entry, an opportunity attack, a rebuke): an `after` cost once the action has
 * resolved, hit or miss; a `before` cost inside, once the action has passed its gates. An action a gate stops (out of
 * range, an unmet prerequisite, suppressed magic) resolves nothing and costs nothing.
 */
/** Whether Sanctuary wards against this action: an attack roll or a damaging spell, and not an area. */
function wardedAgainst(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.every(wardedAgainst);
  return action.kind === "attack" || (!!action.spell && !action.area && "damage" in action && action.damage.length > 0);
}

/**
 * The foe's offence a ward can stop, from where it can stand on its next turn: the attack rolls and aimed damaging
 * spells in the routine it would use there. A breath, an area spell or a save effect in that routine is not counted,
 * and a limited option only while the foe has it.
 */
function wardedEv(foe: CombatStatblock, warded: CombatStatblock, foeState: FighterState, distance: number, evaluator: PairEvaluator): number {
  const reach = closestFoeReach(foe, foeState, distance, 0);
  let best: Routine | undefined, bestEv = 0;
  for (const routine of foe.routines) {
    const ev = rawRoutineEvAtDistance(routine, foe, warded, reach, true);
    if (ev > bestEv) { best = routine; bestEv = ev; }
  }
  if (!best) return 0;
  return best.parts.reduce((sum, part) => {
    const option = foe.options[part.optionIdx];
    if (!option || !usable(foeState, part.optionIdx, option) || !wardedAgainst(option.action)) return sum;
    return sum + part.count * evaluator.actionEvAtDistance(option.action, foe, warded, reach);
  }, 0);
}

function resolveAction(attacker: CombatStatblock, defender: CombatStatblock, aState: FighterState, dState: FighterState, action: CombatAction, rng: () => number, source: 0 | 1, distance: number, log: FightLog, forceAdvantage = false): void {
  aState.bloodiedDamage = false;
  aState.lastActionHit = false;
  // Sanctuary "ends if the warded creature makes an attack roll, casts a spell, or deals damage".
  const ownWard = aState.conditions.find((c) => c.wardDc !== undefined);
  if (ownWard && !(action.kind === "selfbuff" && action.wardDc !== undefined) && (action.kind === "attack" || action.spell || action.kind === "random" || ("damage" in action && action.damage.length > 0))) {
    aState.conditions = aState.conditions.filter((c) => c !== ownWard);
    if (log.on) log.push(`${attacker.name}'s ${ownWard.name} ends`);
  }
  // And whoever targets the warded creature with an attack roll or a damaging spell "must succeed on a Wisdom saving
  // throw or either choose a new target or lose the attack or spell": in a duel there is no other target.
  const ward = dState.conditions.find((c) => c.wardDc !== undefined);
  if (ward && wardedAgainst(action) && actionInRange(action, distance) && !rollSave(attacker, aState, "wis", ward.wardDc!, true, rng)) {
    if (log.on) log.push(`${attacker.name} loses the ${action.spell ? "spell" : "attack"} to ${defender.name}'s ${ward.name}`);
    return;
  }
  if (action.spell && actionInRange(action, distance)) {
    if (action.components && tryCounterspell(attacker, defender, aState, dState, action, rng, source, distance, log)) return;
    if (action.somatic && aState.conditions.some(c => c.slowCasting) && rng() < 0.25) {
      if (log.on) log.push(`${attacker.name}'s spell fails (Slow)`);
      return;
    }
    if (defender.reflectiveCarapace && !action.reflected && ((action.kind === "attack" && action.ranged) || action.spellName === "Magic Missile")) {
      aState.lastActionHit = false;
      breakInvisibility(aState, attacker, log);
      if (d20ForDie(6, rng) === 6) {
        if (log.on) log.push(`${defender.name} reflects ${action.spellName ?? "the spell"}`);
        resolveAction(defender, attacker, dState, aState, { ...action, reflected: true, components: false }, rng, source === 0 ? 1 : 0, distance, log);
      } else if (log.on) log.push(`${defender.name}'s Reflective Carapace blocks the spell`);
      return;
    }
  }
  const cost = selfCostOf(action);
  if (!cost) {
    resolveActionBody(attacker, defender, aState, dState, action, rng, source, distance, log, forceAdvantage);
  } else {
    const gates = { passed: false };
    resolveActionBody(attacker, defender, aState, dState, action, rng, source, distance, log, forceAdvantage, gates);
    if (gates.passed && cost.when === "after") paySelfCost(attacker, aState, dState, source, action, cost, rng, log);
  }
  // A run-up that applies immediately before the hit covers only the first attack after the approach: an attack that
  // was made, hit or miss, spends the run-up for every later attack of the turn, whichever option made it. The attack
  // itself read its gates before this.
  if (aState.attackResolving) {
    aState.attackResolving = false;
    aState.runUpSpent = aState.movedToward;
  }
}

function resolveActionBody(attacker: CombatStatblock, defender: CombatStatblock, aState: FighterState, dState: FighterState, action: CombatAction, rng: () => number, source: 0 | 1, distance: number, log: FightLog, forceAdvantage = false, gates?: { passed: boolean }): void {
  dState.justTransformed = false;
  aState.lastActionHit = false;
  if (action.kind === "selfbuff") {
    beginConcentration(action, source, aState, dState, attacker, log);
    if (action.selfTempHp?.dice) grantTempHp(attacker, aState, action.selfTempHp, rollDice(action.selfTempHp.dice, rng, false), log);
    if (action.acAdjustment) aState.conditions = aState.conditions.filter(c => c.name !== action.condition);
    if (!hasCondition(aState, action.condition)) {
      aState.conditions.push({
        name: action.condition,
        spellLevel: action.spellLevel,
        duration: action.duration ?? "permanent",
        acAdjustment: action.acAdjustment,
        noProvoke: action.movement?.noProvoke,
        source,
        appliedTurn: aState.turnCount,
        concentrationSource: action.concentration ? source : undefined,
        breaksOnAttackOrSpell: action.breaksOnAttackOrSpell ?? true,
        magical: true,
        resistDamage: action.resistDamage,
        rollEffects: action.rollEffects,
        images: action.images,
        wardDc: action.wardDc,
        darkness: action.darkness,
        flySpeed: action.fly?.speed,
        hover: action.fly?.hover,
        truesightRange: action.truesight,
        endsSourceTurn: action.rounds === undefined ? undefined : aState.turnCount + action.rounds,
      });
      if (log.on) log.push(`${attacker.name} becomes ${action.condition}`);
    }
    return;
  }
  if (action.kind === "selfheal" && action.dispels) {
    if (distance > action.dispels.range) return;
    const onFoe = dispelsOnFoe(aState, source);
    const target = onFoe ? dState : aState, name = onFoe ? defender.name : attacker.name;
    const ended = dispellable(target, source).filter((c) => {
      if (c.spellLevel! <= 3) return true;
      const roll = d20ForDie(20, rng) + action.dispels!.mod;
      if (log.on) log.push(`${attacker.name} checks ${roll} against ${10 + c.spellLevel!} to end ${c.name}`);
      return roll >= 10 + c.spellLevel!;
    });
    target.conditions = target.conditions.filter((c) => !ended.includes(c));
    pruneLinkedConditions(target);
    if (log.on) log.push(`${attacker.name} casts Dispel Magic on ${name}: ${ended.length ? [...new Set(ended.map((c) => c.name))].join(", ") + " ends" : "nothing ends"}`);
    return;
  }
  if (action.kind === "selfheal") {
    if (action.selfTempHp?.dice) {
      grantTempHp(attacker, aState, action.selfTempHp, rollDice(action.selfTempHp.dice, rng, false), log);
      if (action.selfRiders?.length) applyRiders(aState, attacker, aState, action.selfRiders, source, false, rng, log, true);
      return;
    }
    if (action.curesConditions) {
      const cured = restored(attacker, aState, action);
      if (cured === "abilityScores") {
        aState.drainedScores = {};
        if (log.on) log.push(`${attacker.name}'s ability scores are restored`);
      } else if (cured) {
        aState.conditions = aState.conditions.filter((c) => c !== cured);
        if (log.on) log.push(`${attacker.name} is no longer ${cured.name}`);
        pruneLinkedConditions(aState, log, attacker.name);
      }
      return;
    }
    const amount = rollDice(action.healing, rng, false);
    if (healBlocked(aState)) {
      if (log.on) log.push(`${attacker.name} can't regain hit points (${aState.hp} hp)`);
      return;
    }
    const before = aState.hp;
    aState.hp = Math.min(aState.maxHp, aState.hp + amount);
    if (action.spell && aState.hp > before) {
      const closed = aState.conditions.some(c => c.endsOnHealingSpell);
      aState.conditions = aState.conditions.filter(c => !c.endsOnHealingSpell);
      if (closed && log.on) log.push(`${attacker.name}'s wound closes (healing spell)`);
    }
    if (log.on) log.push(`${attacker.name} regains ${aState.hp - before} hp (${aState.hp} hp)`);
    return;
  }
  if (action.kind === "random") {
    const branches = action.branches.filter((branch) => actionInRange(branch, distance) && actionRequirementMet(branch, dState, source));
    if (!branches.length) {
      if (log.on) log.push(`${attacker.name} has no target in range`);
      return;
    }
    const branch = branches[Math.floor(rng() * branches.length)];
    resolveAction(attacker, defender, aState, dState, branch, rng, source, distance, log, forceAdvantage);
    return;
  }
  // A pure teleport has no target and nothing to resolve here. The jump itself needs the
  // engagement, which only the option-execution sites hold, so `applyOptionTeleport` performs
  // it around this call.
  if (action.kind === "teleport") return;
  if (hasCondition(aState, "antimagic") && action.magical) {
    if (log.on) log.push(`${attacker.name}'s magic is suppressed`);
    return;
  }
  if (!actionInRange(action, distance)) {
    if (log.on) log.push(`${attacker.name}'s target is out of range`);
    return;
  }
  if (!actionRequirementMet(action, dState, source)) {
    const prerequisite = action.requiresTargetConditions?.join(" and ")
      ?? action.requiresAnyTargetConditions?.join(" or ")
      ?? action.requiresTargetCondition;
    if (log.on) log.push(`${attacker.name}'s target does not meet ${prerequisite} prerequisite`);
    return;
  }
  if (!actionTargetable(action, attacker, defender, distance, dState, aState)) {
    if (log.on) log.push(`${defender.name} is not a valid target`);
    return;
  }
  if (census) censusObservers.application(census, attacker, defender, dState, action, source, distance);
  if (defender.damageGate && actionExpectedDamage(action, defender) > 0) {
    const gate = defender.damageGate;
    const defenderIndex: 0 | 1 = source === 0 ? 1 : 0;
    if (!hasConditionFrom(aState, gate.condition, defenderIndex)
      && !rollSave(attacker, aState, gate.ability, gate.dc, gate.magical, rng)) {
      applyRiders(aState, attacker, dState, [{
        condition: gate.condition,
        duration: gate.duration,
      }], defenderIndex, gate.magical, rng, log);
      if (log.on) log.push(`${attacker.name} fails to overcome ${defender.name}'s damage ward`);
      return;
    }
  }
  // The action is past its gates: it resolves, and a cost to its own user is owed (`resolveAction`). A cost the print
  // puts before the effect is paid here; a user it downs resolves nothing further.
  if (gates) {
    gates.passed = true;
    const cost = selfCostOf(action);
    if (cost?.when === "before") {
      paySelfCost(attacker, aState, dState, source, action, cost, rng, log);
      if (isDown(attacker, aState)) return;
    }
  }
  beginConcentration(action, source, aState, dState, attacker, log);
  // "... or the erinyes uses Entangling Rope again": using the action ends the hold its last use left on the target,
  // before this use's save.
  const reused = "riders" in action ? (action.riders ?? []).filter((rider) => rider.endsOnReuse) : [];
  if (reused.length) {
    const released = dState.conditions.filter((c) => c.endsOnReuse && c.source === source && reused.some((rider) => rider.condition === c.name));
    if (released.length) {
      dState.conditions = dState.conditions.filter((c) => !released.includes(c));
      pruneLinkedConditions(dState);
      if (log.on) log.push(`${attacker.name} uses ${action.actionName ?? "the action"} again and ${defender.name} is no longer ${[...new Set(released.map((c) => c.name))].join(" or ")}`);
    }
  }
  if (action.kind === "attack" || action.kind === "autohit") aState.attackResolving = true;
  if (action.kind === "attack") {
    const isMelee = action.melee && distance <= (action.reach ?? 5);
    // Sight is directional: blindness and invisibility are both resolved by the observer's senses.
    const attackerUnseen = !canSee(defender, aState, dState, distance);
    const targetUnseen = !canSee(attacker, dState, aState, distance);
    const targetProne = isProne(dState);
    // A fury trait swings the roll both ways: Advantage once something has drawn its blood,
    // and for an anger trait Disadvantage on a turn nothing has.
    const furyActive = !!attacker.fury && aState.tookDamageSinceTurnEnd;
    // `forceAdvantage` marks a rebuke written to be
    // made with Advantage, which is a property of the reaction rather than of either creature's
    // state, so it cannot be read off the conditions the way every other source here is.
    // Held roll effects: the attacker's own (Phantasmal Killer, a one-roll Disadvantage,
    // a die penalty; Strength-gated ones only on a Strength weapon attack) and the target's (Guiding Bolt's Advantage).
    const ownRollEffects = heldRollEffects(aState, "attack", undefined, reliesOnStrength(attacker, action));
    const againstRollEffects = heldRollEffects(dState, "attackAgainst").filter(({ effect }) => (!effect.requiresSight || !targetUnseen)
      && (!effect.attackerTypes || effect.attackerTypes.includes(attacker.creatureType)));
    const rollEffects = [...ownRollEffects, ...againstRollEffects];
    // A printed conditional Advantage: the option's header or the attacker's
    // trait, while its state holds. One more source: two Advantages are one, and any Disadvantage cancels it.
    const granted = grantedAttackAdvantage(attacker, aState, dState, action, source, distance);
    const adv = attacker.attackAdvantage || forceAdvantage || furyActive || attackerUnseen || hasCondition(aState, "aiming") || hasAny(dState, ADV_AGAINST) || (distance <= 5 && targetProne)
      || rollEffects.some(({ effect }) => effect.mode === "advantage")
      || granted;
    const dis = rollEffects.some(({ effect }) => effect.mode === "disadvantage")
      || attacker.attackDisadvantage || (!!attacker.fury?.disadvantageWhenInactive && !furyActive)
      || targetUnseen || isFrightened(aState) || hasCondition(aState, "poisoned")
      || (!attackerUnseen && dodges(defender, dState))
      || hasCondition(aState, "restrained") || isProne(aState)
      || (distance > 5 && targetProne)
      || attacksAtDisadvantageAgainst(defender, dState, action, distance)
      || (action.ranged && action.range !== undefined && distance > action.range)
      || (distance <= 5 && action.ranged && !isMelee && !action.conjuredMelee && canSee(defender, aState, dState, distance) && !hasAny(dState, RULES_INCAPACITATED));

    if (granted && adv && log.on) {
      const label = action.advantageWhen && advantageConditionHolds(action.advantageWhen, aState, dState, source)
        ? "the attack's condition" : attacker.attackAdvantageWhen!.name;
      log.push(dis ? `${attacker.name}'s Advantage (${label}) is cancelled by Disadvantage` : `${attacker.name} attacks with Advantage (${label})`);
    }
    const automaticMiss = !!defender.greaterMagicResistance && !!action.spell;
    const r1 = automaticMiss ? 1 : d20(rng);
    const r2 = !automaticMiss && adv !== dis ? d20(rng) : r1;
    const roll = adv && !dis ? Math.max(r1, r2) : dis && !adv ? Math.min(r1, r2) : r1;
    if (automaticMiss && log.on) log.push(`${defender.name}'s Greater Magic Resistance makes the spell miss`);
    // A die subtracted from the total, rolled after the d20: a natural 20 still hits and a natural 1 still misses.
    const total = roll + action.toHit - rollEffectPenalty(rollEffects, rng);
    const naturalCrit = roll === 20;
    // Paralyzed/Unconscious upgrade a hit to a critical from within 5 feet — they do not
    // make the attack land. The roll must still beat AC (SRD 5.2.1 conditions).
    const autoCritEligible = distance <= 5 && hasAny(dState, AUTO_CRIT_ADJACENT);
    aState.conditions = aState.conditions.filter((condition) => condition.name !== "aiming");
    pruneLinkedConditions(aState);
    spendNextRollEffects(aState, ownRollEffects, log, attacker);
    spendNextRollEffects(dState, againstRollEffects, log, defender);
    breakInvisibility(aState, attacker, log); // making the attack roll reveals the attacker
    const effectiveAc = defender.ac + dState.conditions.reduce((sum, c) => sum + (c.acAdjustment ?? 0), 0) + (dState.shieldActive && defender.reaction?.kind === "shield" ? defender.reaction.acBonus : 0);
    const missed = roll === 1 || (!naturalCrit && total < effectiveAc);
    // Parry/Shield: once per round, turn a would-be hit into a miss if the AC bonus covers it.
    // An auto-crit against a paralyzed target is an ordinary hit that crits, so it is still
    // deflectable; only a natural 20 is not.
    const takesAcReaction = !missed && defender.reaction && reactionAvailable(defender, dState)
      && (!defender.reaction.meleeOnly || isMelee)
      && !verbalShieldBarred(defender, dState)
      && reactionSeesAttacker(defender, dState, aState, distance)
      && (!!defender.reaction.response || (!naturalCrit && total < effectiveAc + defender.reaction.acBonus));
    const deflected = takesAcReaction && !naturalCrit && total < effectiveAc + defender.reaction!.acBonus;
    if (takesAcReaction) {
      spendReaction(defender, dState);
      if (defender.reaction?.kind === "shield") dState.shieldActive = true;
      if (defender.reaction?.response) dState.pendingReactionResponse = true;
    }
    const crit = !missed && !deflected && (naturalCrit || autoCritEligible);
    let hit = false;
    if (missed) {
      if (log.on) log.push(`${attacker.name} misses ${defender.name}`);
    } else if (deflected) {
      if (log.on) log.push(`${defender.name} deflects the attack (reaction)`);
      const idx = defender.reaction?.counterOptionIdx;
      const counter = idx === undefined ? undefined : defender.options[idx]?.action;
      if (counter && actionInRange(counter, distance)) {
        if (log.on) log.push(`${defender.name} uses Riposte`);
        resolveAction(defender, attacker, dState, aState, counter, rng, source === 0 ? 1 : 0, distance, log);
      }
    } else if (duplicateHit(attacker, defender, aState, dState, distance, rng, log)) {
      // The attack hit a duplicate (Mirror Image): the creature itself is not hit.
    } else {
      hit = true;
      aState.lastActionHit = true;
      if (crit && log.on) log.push(`${attacker.name} scores a Critical Hit`);
      if (action.selfRidersOnHit?.length) applyRiders(aState, attacker, aState, action.selfRidersOnHit, source, false, rng, log, true);
      // A reaction to a creature within 5 feet that hits with an attack
      // roll, or to a melee hit taken, answers the *hit*, whether or not
      // it went on to deal damage, so they are recorded here rather than in `dealDamage`.
      if (defender.rebuke) {
        const triggers = markRebukeTrigger(dState);
        triggers.hitByAttack = true;
        triggers.hitByMelee ||= isMelee;
      }
      // Read before anything spends the run-up: the free attack this hit grants is gated on the approach to this hit.
      const follow = action.followUp && (action.followUp.targetMaxSize === undefined || defender.size <= action.followUp.targetMaxSize)
        && (action.followUp.requiresMovement === undefined || runUpFor(aState, action.followUp) >= action.followUp.requiresMovement)
        ? action.followUp : undefined;
      const logged = log.lines.length;
      dealDamage(attacker, defender, aState, dState, action, rng, source, crit, log, 1, undefined, adv && !dis, distance, {});
      // What the hit also does it does to a creature still standing: one it killed is not knocked Prone or pushed.
      if (!dState.justTransformed && !isDown(defender, dState)) {
        const hitRiders = adv && !dis ? action.riders : action.riders.filter((rider) => !rider.requiresAttackAdvantage);
        applyRiders(dState, defender, aState, hitRiders, source, action.magical, rng, log, false, !!action.concentration, holdReachAt(action, distance));
        applyChoiceRiders(attacker, dState, defender, aState, action, rng, source, log, distance);
        if (action.abilityDrain) applyAbilityDrain(defender, dState, action, rng, log);
      }
      // A hit that changed nothing (no damage, and every condition it carries barred) still says it landed.
      if (log.on && log.lines.length === logged) log.push(`${attacker.name} hits ${defender.name} to no effect`);
      if (hasAny(dState, RULES_INCAPACITATED)) endConcentration(source === 0 ? 1 : 0, dState, aState, defender, log);
      if (follow && !isDown(defender, dState) && !isDown(attacker, aState)) {
        if (log.on) log.push(`${attacker.name} makes a free ${follow.name} attack`);
        resolveAction(attacker, defender, aState, dState, follow.action, rng, source, distance, log);
      }
      // Corrosive Form and friends: landing a melee blow costs the attacker. Resolved as an
      // autohit so it cannot itself provoke retaliation.
      // Fire Form and its kin answer the creature that hit them. An acid-spray trait answers the damage
      // and sprays a radius, and is settled from `dealDamage` instead — see `settleBloodSpray`.
      if (isMelee && defender.retaliation && defender.retaliation.radius === undefined && !isDown(attacker, aState)) {
        const retaliation = defender.retaliation;
        const dealtTypes = action.damage.map((clause) => damageClauseType(clause, attacker, action.magical));
        const gated = retaliation.requiresDamageTypes;
        if (!gated || dealtTypes.some((type) => gated.includes(type))) {
          if (log.on) log.push(`${attacker.name} is hurt by ${defender.name}'s ${retaliation.name}`);
          const back: CombatAction = { kind: "autohit", damage: retaliation.damage, magical: true };
          dealDamage(defender, attacker, dState, aState, back, rng, source === 0 ? 1 : 0, false, log);
        }
      }
    }
    if (!hit && action.missDamageFactor !== undefined) {
      dealDamage(attacker, defender, aState, dState,
        { kind: "autohit", damage: action.damage, magical: action.magical }, rng, source, false, log, action.missDamageFactor);
    }
    // Hybrid spells (Ice Knife) explode hit or miss: resolve the save burst regardless.
    // A printed once-per-turn burst (a weapon that can erupt only once per turn) fires on the first
    // swing of the turn that reaches it, and that spends the turn's use whatever the save does.
    const burstKey = action.extraSave?.oncePerTurnKey;
    if (action.extraSave && (hit || action.extraSave.onMiss) && burstKey !== undefined && aState.perTurnUsed.has(burstKey)) {
      if (log.on) log.push(`${attacker.name}'s ${burstKey} effect is spent this turn`);
    } else if (action.extraSave && (hit || action.extraSave.onMiss)) {
      if (burstKey !== undefined) aState.perTurnUsed.add(burstKey);
      resolveSaveBurst(attacker, defender, aState, dState, action, action.extraSave, rng, source, log, distance);
    }
    return;
  }
  if (action.kind === "save" && action.emanation) {
    breakInvisibility(aState, attacker, log, !revealsCaster(action));
    raiseEmanation(attacker, aState, dState, action, source, distance, log);
    return;
  }
  if (action.kind === "save") {
    breakInvisibility(aState, attacker, log, !revealsCaster(action));
    const outcome = rollSaveMargin(defender, dState, action.ability, action.dc, action.magical, rng, !!action.saveAdvantageInCombat, actionSaveConditions(action), !!action.saveDisadvantageTypes?.includes(defender.creatureType));
    let saved = outcome.saved;
    // A save-margin tier: the failure's own damage and riders (a larger damage figure, or an added condition such as stunned).
    // The defender sees its roll, so the Legendary Resistance test below weighs the tier this failure falls in.
    const marginReached = !!action.marginDamage && outcome.failedBy >= action.marginDamage.margin;
    const tierDamage = marginReached ? action.marginDamage!.damage : action.damage;
    const tierRiders = action.riders.some(marginGated) ? action.riders.filter((r) => marginAdmits(r, outcome.failedBy)) : action.riders;
    const tierAverage = tierDamage.reduce(
      (sum, d) => sum + rollDice(d.dice, () => 0.5, false) * damageClauseMultiplier(d, defender, action.magical),
      0,
    );
    const wouldHurt = tierRiders.some(r => r.condition === "exhaustion") && dState.conditions.filter(c => c.name === "exhaustion").length >= 5
      || tierAverage >= defender.hpAvg * 0.15
      || tierRiders.some((r) => TURN_LOSING.has(r.condition) && !sleepBlocked(r, defender) && !immunityGated(r, defender))
      // A failed save that kills outright is always worth a Legendary Resistance.
      || (action.instantDeathHpThreshold !== undefined && dState.hp <= action.instantDeathHpThreshold)
      // So is a slay-on-zero packet whose average damage reaches the current hit points of a defender above 0.
      || (dState.hp > 0 && slayApplies(action, defender) && tierAverage > 0 && tierAverage >= dState.hp);
    if (!saved && dState.legendaryResistances > 0 && wouldHurt) {
      dState.legendaryResistances--;
      saved = true;
      if (log.on) log.push(`${defender.name} uses Legendary Resistance`);
    }
    if (!saved && (action.marginDamage || action.riders.some(marginGated))) logSaveMargin(log, defender.name, outcome.failedBy);
    // Evasion / Avoidance halves what a failed save takes and removes what a successful one
    // would still have taken. It reaches the damage only: the riders are unaffected.
    const share = evasionShares(action.onSuccess, action.ability, defender, activeDefences(defender, dState));
    if (!saved) {
      if (action.instantDeathHpThreshold !== undefined && dState.hp <= action.instantDeathHpThreshold) {
        dState.hp = 0;
        dState.slain = true;
        if (log.on) log.push(`${defender.name} dies to instant death (${action.instantDeathHpThreshold} hp threshold)`);
        if (action.selfHealOnKill && !healBlocked(aState)) {
          const before = aState.hp;
          aState.hp = Math.min(aState.maxHp, before + rollDice(action.selfHealOnKill, rng, false));
          if (log.on && aState.hp > before) log.push(`${attacker.name} regains ${aState.hp - before} hp`);
        }
      } else if (!marginReached) {
        dealDamage(attacker, defender, aState, dState, action, rng, source, false, log, share.onFail, undefined, false, undefined, { saveFailed: true });
      } else if (tierDamage.length) {
        dealDamage(attacker, defender, aState, dState, action, rng, source, false, log, share.onFail, tierDamage, false, undefined, { saveFailed: true });
      }
      // The action's save was the initial save — riders only re-save on their per-turn repeat. A target this damage
      // has just dropped takes none of them, as with a hit (an Otyugh's Tentacle Slam "stunned" a Knight at 0).
      if (!dState.justTransformed && !isDown(defender, dState)) {
        applyRiders(dState, defender, aState, action.riders.filter((rider) => !rider.onlyOnSuccess), source, action.magical, rng, log, true, !!action.concentration, holdReachAt(action, distance), action.immuneOnSuccess, outcome.failedBy);
        applyChoiceRiders(attacker, dState, defender, aState, action, rng, source, log, distance);
        if (action.abilityDrain) applyAbilityDrain(defender, dState, action, rng, log);
      }
      if (hasAny(dState, RULES_INCAPACITATED)) endConcentration(source === 0 ? 1 : 0, dState, aState, defender, log);
    } else if (share.onSave > 0) {
      dealDamage(attacker, defender, aState, dState, action, rng, source, false, log, share.onSave, undefined, false, undefined, { saveFailed: false });
      // Nor does a made save's rider reach a target its half damage dropped (a Bulette's Deadly Leap "pushed" a dead veteran).
      if (!isDown(defender, dState)) applyRiders(dState, defender, aState, action.riders.filter((rider) => rider.appliesOnSuccess), source, action.magical, rng, log, true, false, holdReachAt(action, distance));
      if (action.abilityDrain?.on === "eitherSave") applyAbilityDrain(defender, dState, action, rng, log);
    } else {
      if (log.on) log.push(`${defender.name} saves`);
      applyRiders(dState, defender, aState, action.riders.filter((rider) => rider.appliesOnSuccess), source, action.magical, rng, log, true, false, holdReachAt(action, distance));
      if (action.abilityDrain?.on === "eitherSave") applyAbilityDrain(defender, dState, action, rng, log);
    }
    // After this use has resolved: a made save still takes its half damage this time.
    if (saved) grantSuccessImmunity(dState, action.immuneOnSuccess, "initial", log, defender);
    if (action.zone && !isDown(attacker, aState)) placeZone(aState, dState, action, source);
    if (action.concentration && !aState.conditions.some((c) => c.concentrationSource === source) && !dState.conditions.some((c) => c.concentrationSource === source)) {
      aState.concentrating = false;
    }
    return;
  }
  breakInvisibility(aState, attacker, log, !revealsCaster(action));
  if (action.blockedByShield && defender.reaction?.kind === "shield") {
    if (!dState.shieldActive && reactionAvailable(defender, dState) && !verbalShieldBarred(defender, dState)) {
      spendReaction(defender, dState);
      dState.shieldActive = true;
      if (log.on) log.push(`${defender.name} casts Shield`);
    }
    if (dState.shieldActive) {
      if (log.on) log.push(`${defender.name} takes no damage from Magic Missile`);
      return;
    }
  }
  // Power Word Kill style: kills at or below the threshold, otherwise nothing.
  if (action.instantDeathHpThreshold !== undefined) {
    if (dState.hp <= action.instantDeathHpThreshold) {
      dState.hp = 0;
      dState.slain = true;
      if (log.on) log.push(`${defender.name} dies (${action.instantDeathHpThreshold} hp threshold)`);
    } else {
      if (log.on) log.push(`${defender.name} is unaffected`);
    }
    if (!action.damage.length) return;
  }
  dealDamage(attacker, defender, aState, dState, action, rng, source, false, log);
  if (!dState.justTransformed && action.riders?.length) {
    applyRiders(dState, defender, aState, action.riders, source, action.magical, rng, log, true, !!action.concentration, holdReachAt(action, distance));
  }
  if (hasAny(dState, RULES_INCAPACITATED) || action.endsTargetConcentration) endConcentration(source === 0 ? 1 : 0, dState, aState, defender, log);
  aState.lastActionHit = true;
}

function startTurn(block: CombatStatblock, state: FighterState, rng: () => number, log: FightLog): void {
  state.turnCount++;
  state.usedThisRound?.clear();
  state.bloodiedDamage = false;
  state.routineAttacks = 0;
  state.actionSlotUsed = false;
  state.dodging = false;
  state.bonusSlotUsed = false;
  if (state.tempHpExpiresTurn !== undefined && state.turnCount >= state.tempHpExpiresTurn) {
    if (state.tempHp > 0 && log.on) log.push(`${block.name}'s temporary hit points fade`);
    state.tempHp = 0;
    state.tempHpExpiresTurn = undefined;
  }
  state.reactionUsed = false;
  state.extraOpportunityUsed = 0;
  state.shieldActive = false;
  state.movementPenalty = 0;
  state.withdrew = false;
  state.crawling = false;
  state.actsInsteadOfMoving = false;
  state.movedToward = 0;
  state.runUpSpent = 0;
  state.turnMoved = 0;
  state.damageDealtThisTurn = 0;
  for (const condition of state.conditions) condition.sourceDamageEscapePending = false;
  state.bonusDamageUsed = false;
  for (const [key, resource] of state.recharge) {
    if (!resource.ready) {
      if (1 + Math.floor(rng() * 6) >= resource.min) {
        resource.ready = true;
        if (log.on) log.push(`${block.name} recharges ${block.options.filter((option, idx) => option.uses.t === "recharge" && (option.uses.pool ?? idx) === key).map((option) => option.name).join(", ") || key}`);
      }
    }
  }
  if (block.regeneration) {
    const suppressed = block.regeneration.suppressedBy.some((t) => state.lastDamageTypes.has(t))
      || (!!block.regeneration.suppressedByCritical && state.tookCritical);
    // A heal block stops regeneration as suppression does: a creature that can't regain hit points doesn't regenerate.
    const blocked = healBlocked(state, true);
    // A troll that takes acid or fire damage heals just 5 hit points when its
    // next turn begins. `lastDamageTypes` is what dealt damage since this creature's last turn start.
    const reducedBy = block.regeneration.reducedBy;
    const regain = reducedBy?.types.some((t) => state.lastDamageTypes.has(t)) ? reducedBy.amount : block.regeneration.amount;
    if (state.hp <= 0 && block.regeneration.deathRule) {
      // Troll rule: dies only if it starts its turn at 0 HP and doesn't regenerate.
      if (suppressed) {
        state.regenFailed = true;
        if (log.on) log.push(`${block.name} fails to regenerate and dies`);
      } else if (blocked) {
        state.regenFailed = true;
        if (log.on) log.push(`${block.name} can't regain hit points: fails to regenerate and dies`);
      } else {
        // Bound by the *current* maximum: life drain that reduced the maximum caps the
        // recovery too, otherwise a drained regenerator comes back above its own maximum.
        state.hp = Math.min(state.maxHp, regain);
        if (log.on) log.push(`${block.name} regenerates back up (${state.hp} hp)`);
        settleWake(block, state, log);
        settleZeroHp(block, state, log);
        settleWake(block, state, log);
      }
    } else if (state.hp > 0 && !suppressed) {
      // A last-stand trait only answers a creature already losing: it applies while the creature is under half its hit
      // points yet still above 0.
      const belowHalf = !block.regeneration.requiresBelowHalf || state.hp * 2 < state.maxHp;
      if (belowHalf && blocked) {
        if (state.hp < state.maxHp && log.on) log.push(`${block.name} can't regain hit points (Regeneration)`);
      } else if (belowHalf) state.hp = Math.min(state.maxHp, state.hp + regain);
    }
  }
  state.lastDamageTypes.clear();
  state.tookCritical = false;
}

/**
 * Damage a lasting state deals once a turn. `phase` says which end of the affected creature's
 * turn it lands on, which is the difference the prose draws between damage taken
 * at the start of each of its turns and damage taken at the close of every turn while the grapple lasts:
 * a start-of-turn tick lands before the victim's
 * first action and an end-of-turn one cannot.
 */
function resolveConditionDamage(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  actor: 0 | 1,
  phase: "start" | "end",
  rng: () => number,
  log: FightLog,
  only?: (condition: FighterState["conditions"][number]) => boolean,
): void {
  const targetState = states[actor];
  const targetBlock = blocks[actor];
  for (const condition of [...targetState.conditions]) {
    const damage = phase === "start" ? condition.startTurnDamage : condition.endTurnDamage;
    if (!damage?.length) continue;
    if (only && !only(condition)) continue;
    const source = condition.source;
    const sourceBlock = blocks[source];
    const sourceState = states[source];
    // A hold's tick is its holder's doing (necrotic damage at the start of each of the stirge's turns;
    // damage until the grapple ends): a holder that is down deals none. A hold is a condition that lasts
    // until escape, or a swallow. A save-ends condition with a tick of its own (burning, poison) is not one and keeps
    // ticking. Only the end phase can meet a down source: `takeTurn` returns before the start phase when either fighter
    // is down.
    if ((condition.duration === "untilEscape" || condition.name === "swallowed") && isDown(sourceBlock, sourceState)) continue;
    const action: CombatAction = {
      kind: "autohit",
      damage,
      magical: !!condition.magical,
    };
    if (log.on) log.push(`${targetBlock.name} suffers ${condition.name} damage at the ${phase} of its turn`);
    if (condition.name === "wound") {
      // "Loses Hit Points" bypasses temporary HP and is not damage (no concentration save or damage reaction).
      const loss = damage.reduce((sum, d) => sum + rollDice(d.dice, rng, false), 0);
      targetState.hp -= loss;
      if (log.on) log.push(`${targetBlock.name} loses ${loss} hp (${targetState.hp} hp)`);
    } else dealDamage(sourceBlock, targetBlock, sourceState, targetState, action, rng, source, false, log);
    if (isDown(targetBlock, targetState)) break;
  }
}

/**
 * An area that stays where it was put (`SaveAction.zone`) now stands on the target. The caster's copy is what its
 * Concentration keeps up and what the option that moves the area asks for; the target's copy carries the save it makes
 * again if it ends its turn there. Both end with the caster's Concentration. The action that moves the area carries no
 * Concentration of its own and puts down nothing while the caster holds none.
 */
function placeZone(aState: FighterState, dState: FighterState, action: SaveAction, source: 0 | 1): void {
  const key = action.zone!.key;
  if (!aState.conditions.some((c) => c.zoneKey === key)) {
    if (!action.concentration || !aState.concentrating) return;
    aState.conditions.push({ name: "zoneHeld", duration: "permanent", source, appliedTurn: aState.turnCount, concentrationSource: source, zoneKey: key, magical: true });
  }
  dState.conditions = dState.conditions.filter((c) => !(c.zoneSave && c.source === source));
  dState.conditions.push({
    name: "inZone", duration: "permanent", source, appliedTurn: dState.turnCount, concentrationSource: source, magical: true,
    zoneSave: { ...action, concentration: undefined, concentrationRounds: undefined, spell: undefined, components: undefined, verbal: undefined, somatic: undefined },
  });
}

/**
 * An Emanation its caster keeps around itself (`SaveAction.emanation`). Casting rolls no save: the print's triggers are
 * the Emanation entering a creature's space, and a creature entering it or ending its turn there.
 */
function raiseEmanation(attacker: CombatStatblock, aState: FighterState, dState: FighterState, action: CombatAction & { kind: "save" }, source: 0 | 1, distance: number, log: FightLog): void {
  // `resolveActionBody` has already begun the Concentration.
  aState.conditions = aState.conditions.filter((c) => !c.emanation);
  aState.conditions.push({
    name: "emanation", duration: "permanent", source, appliedTurn: aState.turnCount, magical: true,
    concentrationSource: action.concentration ? source : undefined,
    emanation: {
      radius: action.emanation!.radius, name: action.actionName ?? "Emanation", inside: distance <= action.emanation!.radius, speedHalved: action.emanation!.speedHalved,
      save: { ...action, emanation: undefined, concentration: undefined, concentrationRounds: undefined, spell: undefined, components: undefined, verbal: undefined, somatic: undefined },
    },
  });
  if (log.on) log.push(`${attacker.name} is surrounded by ${action.actionName ?? "an Emanation"}`);
}

/**
 * The saves an Emanation asks for, at the end of a turn. The other creature's turn: it "ends its turn there" (which also
 * covers having entered and stayed). The caster's turn: "the Emanation enters a creature's space" when the creature stood
 * outside as the turn began and stands inside now. One save a turn either way.
 */
function resolveEmanationEndTurn(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, engagement: EngagementState, rng: () => number, log: FightLog): void {
  for (const source of [0, 1] as const) {
    const held = states[source].conditions.find((c) => c.emanation);
    if (!held) continue;
    const target: 0 | 1 = source === 0 ? 1 : 0;
    const emanation = held.emanation!;
    const inside = engagement.distance <= emanation.radius && !hasCondition(states[target], "swallowed") && !hasCondition(states[source], "swallowed");
    const saves = inside && (actor === target || !emanation.inside);
    if (actor === source) emanation.inside = inside;
    if (!saves || isDown(blocks[source], states[source]) || isDown(blocks[target], states[target])) continue;
    if (log.on) log.push(actor === target ? `${blocks[target].name} ends its turn in ${blocks[source].name}'s ${emanation.name}`
      : `${blocks[source].name}'s ${emanation.name} enters ${blocks[target].name}'s space`);
    resolveActionBody(blocks[source], blocks[target], states[source], states[target], emanation.save, rng, source, engagement.distance, log);
  }
}

/**
 * "Any other creature's Speed is halved in the Emanation." The duel has no map, so the halving is read at the start of
 * the creature's turn: inside then, its Speed is halved for that turn; outside, it is not.
 */
function settleEmanationSpeed(states: [FighterState, FighterState], actor: 0 | 1, distance: number): void {
  const source: 0 | 1 = actor === 0 ? 1 : 0;
  const emanation = states[source].conditions.find((c) => c.emanation)?.emanation;
  states[actor].conditions = states[actor].conditions.filter((c) => c.name !== "inEmanation");
  if (!emanation) return;
  if (actor !== source) emanation.inside = emanation.inside && distance <= emanation.radius;
  if (emanation.speedHalved && distance <= emanation.radius) {
    states[actor].conditions.push({ name: "inEmanation", duration: "endOfTargetTurn", source, appliedTurn: states[actor].turnCount, magical: true, speedHalved: true });
  }
}

/**
 * "A creature also makes this save when ... it enters the spell's area or ends its turn there." The duel has no map, so
 * whether the creature is still in a 5-foot-radius area at the end of its turn is read off its Speed: with any Speed
 * left to it, it has stepped out; with none (held, Paralyzed, asleep), it is still there and saves again.
 */
function resolveZoneEndTurn(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, engagement: EngagementState, rng: () => number, log: FightLog): void {
  const state = states[actor];
  for (const held of state.conditions.filter((c) => c.zoneSave)) {
    const key = held.zoneSave!.kind === "save" ? held.zoneSave!.zone?.key : undefined;
    if (currentSpeed(blocks[actor], state) > 0) {
      state.conditions = state.conditions.filter((c) => c !== held);
      if (log.on) log.push(`${blocks[actor].name} leaves the ${key ?? "area"}`);
      continue;
    }
    if (isDown(blocks[actor], state) || isDown(blocks[held.source], states[held.source])) continue;
    if (log.on) log.push(`${blocks[actor].name} ends its turn in the ${key ?? "area"}`);
    resolveActionBody(blocks[held.source], blocks[actor], states[held.source], state, held.zoneSave!, rng, held.source, engagement.distance, log);
  }
}

/**
 * The end of a turn: repeat saves and expiries first, then whatever the states that survived
 * them deal. Ordering the damage last is what lets one mechanism serve both wordings.
 * A grapple tick fires only while the hold is still on, so a victim that broke free
 * earlier in the turn takes nothing; and a burning effect that repeats the saving throw at the end of each of its
 * turns and deals fire damage on a failed save, ending on a successful one, deals its damage exactly
 * when that save has just failed, off the one roll the prose gives it.
 */
function endTurn(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  actor: 0 | 1,
  engagement: EngagementState,
  rng: () => number,
  log: FightLog,
): void {
  // Before the move-or-act flag clears: a creature that gave up its movement this turn entered no space.
  resolveSpaceEntry(blocks, states, actor, engagement.distance, rng, log);
  states[actor].leaping = false;
  states[actor].actsInsteadOfMoving = false;
  // One-shot clocks run before condition expiry. Acid Arrow survives its caster's death;
  // a swallowed victim stops holding its packet when it leaves the stomach.
  for (const target of [0, 1] as const) {
    const victim = states[target];
    for (const held of [...victim.conditions]) {
      const delayed = held.delayedDamage;
      if (delayed?.disgorge && isDown(blocks[held.source], states[held.source])) { held.delayedDamage = undefined; continue; }
      if (!delayed || (delayed.clock === "source" ? held.source : target) !== actor
        || states[actor].turnCount < held.delayedDueTurn!) continue;
      held.delayedDamage = undefined;
      if (log.on) log.push(`${blocks[target].name} suffers delayed ${held.name} damage`);
      dealDamage(blocks[held.source], blocks[target], states[held.source], victim,
        { kind: "autohit", damage: delayed.damage, magical: !!held.magical }, rng, held.source, false, log);
      if (delayed.disgorge && !isDown(blocks[target], victim)) {
        releaseSwallowedCreature(victim, blocks[target].name, held.source, log, true);
      } else if (!delayed.disgorge) victim.conditions = victim.conditions.filter(c => c !== held);
    }
  }
  syncConcentration(blocks, states, log);
  // An effect lasting until the end of the source's next turn ends here, on the source's turn, not the target's.
  for (const state of states) {
    const ended = state.conditions.filter((c) => c.duration === "endOfSourceNextTurn" && c.source === actor
      && states[actor].turnCount > c.appliedTurn);
    if (!ended.length) continue;
    state.conditions = state.conditions.filter((c) => !ended.includes(c));
    pruneLinkedConditions(state);
    // Not of a condition another copy still gives: Restrained "until the grapple ends" outlasts a timed one.
    const gone = [...new Set(ended.map((c) => c.name))].filter((name) => !hasCondition(state, name));
    if (log.on && gone.length) log.push(`${blocks[states.indexOf(state)].name} is no longer ${gone.join(" or ")}`);
  }
  resolveEndTurnConditions(blocks[actor], states[actor], rng, log);
  syncConcentration(blocks, states, log);
  // A failed repeat save can turn a condition into Unconscious or Paralyzed: the creature lets go of what it grapples
  // at that moment. And a holder downed during this turn holds nothing by the time the turn's ticks are dealt.
  endGrapplesOfIncapacitated(blocks, states, log);
  endHoldsOfDowned(blocks, states, log);
  resolveZoneEndTurn(blocks, states, actor, engagement, rng, log);
  resolveEmanationEndTurn(blocks, states, actor, engagement, rng, log);
  // "Before the end of this turn" (`Rider.endsThisTurn`): whoever's turn it landed in.
  for (const state of states) if (state.conditions.some((c) => c.endsThisTurn)) state.conditions = state.conditions.filter((c) => !c.endsThisTurn);
  // A swallow's tick is printed on the swallower's clock ("at the start of each of the remorhaz's turns") and is dealt
  // here, at the end of the turn before it. The regurgitation save is printed "at the end of that turn", which is
  // earlier, so a swallow with that save pending waits for it below: a creature spat out takes no acid on the way.
  resolveConditionDamage(blocks, states, actor, "end", rng, log, (c) => !c.sourceDamageEscapePending);
  settleDeathBursts(blocks, states, engagement, rng, log);
  // "At the end of each of the balor's turns …" — the larger half of the owner-turn family, and
  // the reason the timing is kept: this lands a full opponent turn earlier than the start-of-turn
  // wording would.
  resolveSourceTurnAura(blocks, states, actor, "end", engagement.distance, rng, log);
  // A grapple that crushes at the end of its victim's turn is damage like any other, and a
  // creature that answers damage answers this too.
  settleDeathBursts(blocks, states, engagement, rng, log);
  settleSprayAndRebukes(blocks, states, engagement, rng, log); // the end of a turn
  settleDeathBursts(blocks, states, engagement, rng, log);
  const pendingRegurgitation = states[actor].conditions.find((condition) => condition.sourceDamageEscapePending);
  if (pendingRegurgitation) {
    const deferred = states[actor].conditions.filter((c) => c.sourceDamageEscapePending);
    pendingRegurgitation.sourceDamageEscapePending = false;
    const swallower = pendingRegurgitation.source;
    const dc = pendingRegurgitation.sourceDamageEscapeSaveDc!;
    // A swallower that is down makes no save: the fight is over, and the creature inside it leaves the corpse on a
    // turn a duel never reaches (`releaseHeld`).
    if (isDown(blocks[swallower], states[swallower])) {
      // nothing
    } else if (rollSave(blocks[swallower], states[swallower], "con", dc, false, rng)) {
      if (log.on) log.push(`${blocks[swallower].name} succeeds on its regurgitation save`);
    } else {
      if (log.on) log.push(`${blocks[swallower].name} fails its regurgitation save`);
      releaseSwallowedCreature(states[actor], blocks[actor].name, swallower, log);
    }
    resolveConditionDamage(blocks, states, actor, "end", rng, log, (c) => deferred.includes(c));
    settleDeathBursts(blocks, states, engagement, rng, log);
  }
  // A repeat save that deepens Sleep into Unconscious grounds a flier as surely as a stun does, and the fall
  // belongs to this turn: left for the next turn's start, the flier hung in the air through the opponent's
  // legendary actions.
  settleFlight(blocks, states, engagement, rng, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
  // Every completed turn starts a fresh suppression window, including turns lost to control.
  // Clear after ticks and their reactions so all damage through this turn's end still counts.
  const headState = states[actor], headRule = blocks[actor].heads;
  if (headRule && headState.heads !== undefined) {
    if (headState.headsLost > 0 && !headState.headFire && !isDown(blocks[actor], headState)) {
      headState.heads += headRule.regrow * headState.headsLost;
      if (!healBlocked(headState)) headState.hp = Math.min(headState.maxHp, headState.hp + headRule.healing);
      if (log.on) log.push(`${blocks[actor].name} grows new heads (${headState.heads} heads, ${headState.hp} hp)`);
    }
    headState.headsLost = 0;
    headState.headFire = false;
  }
  states[actor].damageTypesSinceTurnEnd.clear();
  noteEndedEffects(states[0], log, blocks[0]);
  noteEndedEffects(states[1], log, blocks[1]);
}

/**
 * Is this creature immune to the foe's aura? The aura's own save made it so (`auraImmune`), or the print grants the
 * immunity on the repeat save's success or on the effect's end (`Aura.successImmunity`) and that has happened: the
 * conditions the aura applied carry the immunity, the repeat saves grant it (`grantSuccessImmunity`), and an ended
 * `saveOrEnd` effect reads as immune (`successImmune`).
 */
function auraImmuneTo(state: FighterState, aura: Aura): boolean {
  return state.auraImmune || successImmune(state, aura.successImmunity);
}

/** Is this creature subject to the foe's aura, including any mutual sight requirement? */
function auraApplies(aura: Aura, source: CombatStatblock, sourceState: FighterState, target: CombatStatblock, targetState: FighterState, distance: number): boolean {
  if (auraImmuneTo(targetState, aura)) return false;
  return auraGatesOpen(aura, source, sourceState, target, targetState, distance);
}

/** The aura's printed gates other than a save's immunity: the source conscious, mutual sight, the creature types. */
function auraGatesOpen(aura: Aura, source: CombatStatblock, sourceState: FighterState, target: CombatStatblock, targetState: FighterState, distance: number): boolean {
  if (aura.requiresConscious && hasAny(sourceState, RULES_INCAPACITATED)) return false;
  if (aura.requiresSight && (!canSee(source, targetState, sourceState, distance) || !canSee(target, sourceState, targetState, distance))) return false;
  if (aura.targetTypes && !aura.targetTypes.includes(target.creatureType)) return false;
  if (aura.excludedTargetTypes?.includes(target.creatureType)) return false;
  return true;
}

/**
 * Whether a grapple of the shape the trait names is actually in force. `grappler` is a thorny
 * plant creature's "any creature grappling it"; `either` adds the Barbed Devil's other direction, "any
 * creature it is grappling". Read off the hold the engine actually applies — a `grappled` or
 * `restrained` condition that lasts `untilEscape` — rather than off any separate bookkeeping.
 */
function grappleBetween(states: [FighterState, FighterState], source: 0 | 1, direction: "either" | "grappler"): boolean {
  const target: 0 | 1 = source === 0 ? 1 : 0;
  const heldBy = (state: FighterState, holder: 0 | 1) => state.conditions.some((c) =>
    c.duration === "untilEscape" && ["grappled", "restrained"].includes(c.name) && c.source === holder);
  return heldBy(states[source], target) || (direction === "either" && heldBy(states[target], source));
}

/** Does an owner-turn emanation reach the other creature from here? */
function sourceTurnAuraReaches(aura: Aura, states: [FighterState, FighterState], source: 0 | 1, distance: number): boolean {
  // Barbed Hide and similar thorny traits have no radius of their own: the hold is the proximity test.
  if (aura.requiresGrapple) return grappleBetween(states, source, aura.requiresGrapple);
  return aura.radius !== undefined && distance <= aura.radius;
}

/**
 * One proximity effect against one creature: the saving throw where the prose offers one, then
 * damage and riders. Shared by both timings, because the only thing that differs between them is
 * whose turn brings the effect round — which is the callers' business, not this one's.
 */
function applyAura(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  aura: Aura,
  source: 0 | 1,
  target: 0 | 1,
  rng: () => number,
  log: FightLog,
): void {
  const [targetBlock, targetState] = [blocks[target], states[target]];
  const [sourceBlock, sourceState] = [blocks[source], states[source]];
  if (targetState.conditions.some(c => c.name === "swallowed")) return;
  // Most of the owner-turn family offers no save at all — "each creature in a 5-foot Emanation
  // originating from the balor takes 13 (3d8) Fire damage" — and an effect with no saving throw
  // has nothing for Legendary Resistance to answer either.
  const magical = aura.magical ?? true;
  const rolls = aura.ability !== undefined && aura.dc !== undefined;
  const outcome = rolls ? rollSaveMargin(targetBlock, targetState, aura.ability!, aura.dc!, magical, rng, false, actionSaveConditions(aura)) : undefined;
  let saved = !!outcome?.saved;
  const failedBy = outcome?.failedBy ?? 0;
  const wouldIncapacitate = aura.riders.some((rider) => marginAdmits(rider, failedBy) && !immunityGated(rider, targetBlock) && (
    INCAPACITATING.has(rider.condition)
    || (!!rider.transitionOnFailedSave && INCAPACITATING.has(rider.transitionOnFailedSave))));
  if (rolls && !saved && wouldIncapacitate && targetState.legendaryResistances > 0) {
    targetState.legendaryResistances--;
    saved = true;
    if (log.on) log.push(`${targetBlock.name} uses Legendary Resistance`);
  }
  if (rolls && !saved && aura.riders.some(marginGated)) logSaveMargin(log, targetBlock.name, failedBy);
  if (saved) {
    // A successful save grants immunity for 24 hours: one chance per fight.
    if (aura.immuneOnSuccess) targetState.auraImmune = true;
    if (log.on) log.push(`${targetBlock.name} resists ${sourceBlock.name}'s ${aura.name}`);
    return;
  }
  // An aura that only imposes conditions does nothing to a target immune to all of them, failed save or not.
  const unaffected = !aura.damage.length && aura.riders.length > 0 && aura.riders.every((rider) => targetBlock.conditionImmune.includes(rider.condition));
  if (log.on) log.push(unaffected
    ? `${targetBlock.name} is immune to ${sourceBlock.name}'s ${aura.name}`
    : `${targetBlock.name} is caught in ${sourceBlock.name}'s ${aura.name}`);
  if (aura.damage.length) {
    const action: CombatAction = { kind: "autohit", damage: aura.damage, magical };
    dealDamage(sourceBlock, targetBlock, sourceState, targetState, action, rng, source, false, log);
  }
  if (aura.riders.length && !isDown(targetBlock, targetState)) {
    applyRiders(targetState, targetBlock, sourceState, aura.riders, source, magical, rng, log, true, false, undefined, aura.successImmunity, failedBy);
    syncConcentration(blocks, states, log);
  }
}

/**
 * A passive proximity aura fires at the start of the *affected* creature's turn, so it is
 * resolved here rather than through the acting creature's action economy.
 */
function resolveAura(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  actor: 0 | 1,
  distance: number,
  rng: () => number,
  log: FightLog,
): void {
  const source: 0 | 1 = actor === 0 ? 1 : 0;
  const aura = blocks[source].aura;
  if (!aura || aura.radius === undefined || distance > aura.radius) return;
  // An aura that is only a heal block held by place (`Aura.blocksHealing`) lands nothing at the turn
  // start: `healBlocked` reads it wherever a regain is checked.
  if (aura.blocksHealing && !aura.damage.length && !aura.riders.length) return;
  if (!auraApplies(aura, blocks[source], states[source], blocks[actor], states[actor], distance)) return;
  applyAura(blocks, states, aura, source, actor, rng, log);
}

/** Movement a step into the foe's space costs from beside it: 5 feet in, and 5 feet out first if it stopped there. */
const SPACE_ENTRY_MOVEMENT = 10;

/**
 * Whether the owner of a `spaceEntry` can step into its foe's space from `distance` with `movement` feet to spend. The
 * engine keeps the pair five feet apart (`MIN_SEPARATION`), so "in the foe's space" is that floor plus the step.
 */
function spaceEntryReaches(states: [FighterState, FighterState], distance: number, movement: number): boolean {
  if (states.some((state) => hasCondition(state, "swallowed"))) return false;
  return distance <= MIN_SEPARATION && movement >= SPACE_ENTRY_MOVEMENT;
}

/**
 * What standing at `distance` from a foe with a `spaceEntry` costs on that foe's next turn: the damage, wherever the
 * foe's movement can bring it alongside with the step to spare. A foe that cannot fly reaches nothing above it.
 */
function spaceEntryThreat(foe: CombatStatblock, foeState: FighterState, attacker: CombatStatblock, attackerState: FighterState, distance: number): number {
  const entry = foe.spaceEntry;
  if (!entry || hasCondition(attackerState, "swallowed") || hasCondition(foeState, "swallowed")) return 0;
  if (attackerState.height > foeState.height && !canFly(foe, foeState)) return 0;
  if (distance - MIN_SEPARATION + SPACE_ENTRY_MOVEMENT > nextTurnSpeed(foe, foeState)) return 0;
  return expectedDamage(entry.damage, attacker, false);
}

/**
 * "The first time it enters a creature's space on a turn, that creature takes ..." (`spaceEntry`). Dealt as the
 * owner's turn ends, out of the movement the turn has left: the step in costs no action and leaves no reach, so
 * a creature with the movement to spare always takes it.
 */
function resolveSpaceEntry(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  actor: 0 | 1,
  distance: number,
  rng: () => number,
  log: FightLog,
): void {
  const entry = blocks[actor].spaceEntry;
  if (!entry) return;
  const target: 0 | 1 = actor === 0 ? 1 : 0;
  if (isDown(blocks[actor], states[actor]) || isDown(blocks[target], states[target])) return;
  // Charmed: "You can't attack the charmer or target the charmer with damaging abilities". Stepping into the charmer's
  // space to burn it is that; the step is the owner's choice, so a Charmed owner does not take it.
  if (hasCondition(states[actor], "charmed")) return;
  if (!spaceEntryReaches(states, distance, movementSpeed(blocks[actor], states[actor]) - states[actor].turnMoved)) return;
  if (log.on) log.push(`${blocks[actor].name} enters ${blocks[target].name}'s space (${entry.name})`);
  dealDamage(blocks[actor], blocks[target], states[actor], states[target], { kind: "autohit", damage: entry.damage, magical: false }, rng, actor, false, log);
}

/**
 * The other timing: an emanation that belongs to the creature radiating on its *own* turn, at
 * whichever end of it the prose names. The actor is the source and the foe is the victim, which
 * is the mirror image of `resolveAura`.
 */
function resolveSourceTurnAura(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  actor: 0 | 1,
  phase: "start" | "end",
  distance: number,
  rng: () => number,
  log: FightLog,
): void {
  const target: 0 | 1 = actor === 0 ? 1 : 0;
  const aura = blocks[actor].sourceTurnAura;
  if (!aura || aura.onSourceTurn !== phase) return;
  if (isDown(blocks[actor], states[actor]) || isDown(blocks[target], states[target])) return;
  if (!sourceTurnAuraReaches(aura, states, actor, distance)) return;
  // A condition that holds unless acid or fire damage reached the troll since its previous turn ended: the same
  // window and the same damage types its Regeneration uses, off its own bookkeeping.
  if (aura.suppressedBy?.some((type) => states[actor].damageTypesSinceTurnEnd.has(type))) {
    if (log.on) log.push(`${blocks[actor].name}'s ${aura.name} is suppressed`);
    return;
  }
  if (!auraApplies(aura, blocks[actor], states[actor], blocks[target], states[target], distance)) return;
  applyAura(blocks, states, aura, actor, target, rng, log);
}

/**
 * Expected per-turn cost of attacking a retaliating foe in melee, for movement scoring.
 * Priced off the attacker's most swing-heavy routine, since that is what it would use on
 * arrival — a six-attack marilith pays far more to punch a phoenix than a single-attack brute.
 */
function retaliationThreat(foe: CombatStatblock, attacker: CombatStatblock, distance: number): number {
  const retaliation = foe.retaliation;
  if (!retaliation) return 0;
  const perHit = expectedDamage(retaliation.damage, attacker, true);
  if (perHit <= 0) return 0;
  let worstCase = 0;
  for (const routine of attacker.routines) {
    let expectedHits = 0;
    for (const part of routine.parts) {
      const action = attacker.options[part.optionIdx]?.action;
      if (action?.kind !== "attack") continue;
      // A melee-hit response reaches whoever is swinging a melee weapon at it. A radius sprays
      // whatever is standing inside the radius, however it is attacking from there — which is
      // the whole difference between Fire Form and an acid-spray trait.
      const reaches = retaliation.radius !== undefined
        ? distance <= retaliation.radius && actionInRange(action, distance)
        : action.melee && distance <= (action.reach ?? 5);
      if (!reaches) continue;
      if (retaliation.requiresDamageTypes
        && !action.damage.some((clause) => retaliation.requiresDamageTypes!.includes(damageClauseType(clause, attacker, action.magical)))) {
        continue;
      }
      expectedHits += part.count * hitChance(action.toHit, foe.ac);
    }
    worstCase = Math.max(worstCase, expectedHits);
  }
  return worstCase * perHit;
}

/**
 * What the foe's rebuke is worth against this creature at this distance — the referenced attack
 * it would make, or the burst it would loose. Range and reach are asked of the compiled action
 * itself, so a rebuke Claw that reaches 10 feet is worth nothing to an archer 60 feet out.
 */
function rebukeResponseValue(
  rebuke: Rebuke,
  foe: CombatStatblock,
  attacker: CombatStatblock,
  attackerState: FighterState,
  foeSource: 0 | 1,
  distance: number,
): number {
  if (rebuke.action) {
    // A crush response costs nothing to a creature it is not already holding.
    if (!actionRequirementMet(rebuke.action, attackerState, foeSource)) return 0;
    if (!actionTargetable(rebuke.action, foe, attacker, distance, attackerState)) return 0;
    return rawActionEvAtDistance(rebuke.action, foe, attacker, distance);
  }
  const part = bestRebukeAttack(rebuke.attacks, foe, attacker, distance)
    ?? bestRebukeAttack(rebuke.fallbackAttacks, foe, attacker, distance);
  if (!part) return 0;
  const action = foe.options[part.optionIdx].action;
  return rawActionEvAtDistance(action, foe, attacker, distance) * part.count * (rebuke.advantage ? ADVANTAGE_EV : 1);
}

/**
 * How likely this creature is to set the rebuke off in a round of fighting from here. An
 * attack-roll trigger needs a hit, so it is one minus the chance every swing of the best routine
 * misses; a "takes damage" trigger is met outright by anything that does not roll to hit at all.
 */
function rebukeTriggerChance(rebuke: Rebuke, attacker: CombatStatblock, foe: CombatStatblock, distance: number): number {
  const needsHit = rebuke.trigger === "hitByAttack" || rebuke.trigger === "hitByMeleeAttack";
  let best = 0;
  for (const routine of attacker.routines) {
    let allMiss = 1;
    let certain = false;
    for (const part of routine.parts) {
      const action = attacker.options[part.optionIdx]?.action;
      if (!action || !actionInRange(action, distance)) continue;
      if (action.kind === "attack") {
        if (rebuke.trigger === "hitByMeleeAttack" && !(action.melee && distance <= (action.reach ?? 5))) continue;
        if (rebuke.requiresDamageTypes
          && !action.damage.some((clause) => rebuke.requiresDamageTypes!.includes(damageClauseType(clause, foe, action.magical)))) {
          continue;
        }
        allMiss *= (1 - hitChance(action.toHit, foe.ac)) ** part.count;
      } else if (!needsHit && !rebuke.requiresDamageTypes && actionExpectedDamage(action, foe) > 0) {
        // A saving-throw action deals at least something to almost anything; a trigger that
        // wants an attack roll is not met by one at all.
        certain = true;
      }
    }
    best = Math.max(best, certain ? 1 : 1 - allMiss);
  }
  return best;
}

/**
 * Expected per-round cost of fighting a creature that answers being hurt by hurting back.
 * Subtracted from every candidate position the movement search scores, exactly as
 * `retaliationThreat` is — but once per round rather than once per swing, because the rebuke
 * spends the one reaction: a six-attack marilith provokes one and not six.
 */
function rebukeThreat(
  foe: CombatStatblock,
  foeState: FighterState,
  attacker: CombatStatblock,
  attackerState: FighterState,
  foeSource: 0 | 1,
  distance: number,
): number {
  const rebuke = foe.rebuke;
  // The approach trigger is paid once, on the step that crosses into it, and is priced there.
  if (!rebuke || rebuke.trigger === "enteredReach") return 0;
  // Only a spent daily pool makes the threat go away; the reaction slot and a recharge both come
  // back, and pricing a per-round cost off this round's slot would make it flicker.
  if (rebuke.uses.t === "perDay" && (foeState.perDay.get(REBUKE_POOL) || 0) <= 0) return 0;
  if (rebuke.triggerRange !== undefined && distance > rebuke.triggerRange) return 0;
  if (rebuke.requiresSight && !canSee(foe, attackerState, foeState, distance)) return 0;
  const value = rebukeResponseValue(rebuke, foe, attacker, attackerState, foeSource, distance);
  if (value <= 0) return 0;
  // A vampiric creature's trigger is its own doing rather than its opponent's: once the opponent is
  // Bloodied, anything that damages it — the creature's own Claw included — buys a free one.
  if (rebuke.trigger === "foeBloodiedDamaged") {
    return attackerState.hp <= attackerState.maxHp / 2 ? value : 0;
  }
  return value * rebukeTriggerChance(rebuke, attacker, foe, distance);
}

/**
 * One-off cost of stepping into the radius of an approach-triggered rebuke, priced beside the
 * opportunity attack it mirrors and paid on the same terms: only on the step that crosses in,
 * and only while the foe still has a reaction to answer with.
 */
function approachRebukeCost(
  foe: CombatStatblock,
  foeState: FighterState,
  mover: CombatStatblock,
  moverState: FighterState,
  foeSource: 0 | 1,
  from: number,
  to: number,
): number {
  const rebuke = foe.rebuke;
  if (!rebuke || rebuke.trigger !== "enteredReach") return 0;
  const radius = rebuke.triggerRange ?? 5;
  if (!(from > radius && to <= radius)) return 0;
  if (!rebukeAvailable(foeState, rebuke)) return 0;
  if (rebuke.requiresSight && !canSee(foe, moverState, foeState, radius)) return 0;
  return rebukeResponseValue(rebuke, foe, mover, moverState, foeSource, radius);
}

/**
 * Expected per-turn cost of standing inside the foe's aura, for movement scoring. The eligibility
 * tests mirror `auraApplies`, which is what actually fires the aura: a threat the aura cannot
 * carry out is a tax on positioning and nothing else. `attackerState` is optional only because
 * the static-threat callers have no state to give; every movement caller passes it, which is
 * where the immunity matters — a creature that already made its one save is done paying.
 */
function auraThreat(foe: CombatStatblock, attacker: CombatStatblock, distance: number, attackerState?: FighterState): number {
  if (attackerState?.conditions.some(c => c.name === "swallowed")) return 0;
  const aura = foe.aura;
  if (!aura || aura.radius === undefined || distance > aura.radius) return 0;
  if (attackerState && auraImmuneTo(attackerState, aura)) return 0;
  if (aura.targetTypes && !aura.targetTypes.includes(attacker.creatureType)) return 0;
  if (aura.excludedTargetTypes?.includes(attacker.creatureType)) return 0;
  return auraCost(aura, attacker);
}

/**
 * What one round of an emanation costs the creature standing in it. An effect with no saving
 * throw is paid in full every round, which is the whole reason the owner-turn family is worth
 * pricing: a Remorhaz's 3d10 is not a gamble a ranged attacker can win by making a save.
 */
function auraCost(aura: Aura, attacker: CombatStatblock): number {
  // An aura's riders are applied as magical (`resolveAura` passes `true`), so a Magic-Resistant
  // creature standing in one saves with Advantage and the emanation is worth less against it.
  const magical = aura.magical ?? true;
  const fail = aura.ability !== undefined && aura.dc !== undefined
    ? attacker.greaterMagicResistance && magical ? 0 : saveFailChance(aura.dc, attacker.saves[aura.ability] ?? attacker.abilityMods[aura.ability], saveAdvantage(attacker, magical, actionSaveConditions(aura)))
    : 1;
  const damage = expectedDamage(aura.damage, attacker, magical);
  // A save-margin tier (a gaze that petrifies on a save failed by 5 or more, and only holds otherwise): each rider
  // at the share of failures on its side of the gate.
  const gate = aura.riders.find((rider) => rider.saveFailMargin !== undefined)?.saveFailMargin;
  const reach = gate !== undefined && aura.ability !== undefined && aura.dc !== undefined && fail > 0
    ? Math.min(1, saveFailByChance(aura.dc, attacker.saves[aura.ability] ?? attacker.abilityMods[aura.ability], gate, saveAdvantage(attacker, magical, actionSaveConditions(aura))) / fail)
    : 0;
  // A rider that is only a heal block (`healBlocked`, an aura that suppresses healing) costs a creature that can regain
  // hit points after the aura lands (not by regeneration, which comes first on its turn), and nothing otherwise.
  const control = aura.riders.reduce((sum, rider) =>
    sum + (attacker.conditionImmune.includes(rider.condition)
      || (rider.condition === "healBlocked" && !canRegainHp(attacker, false, true))
      ? 0
      : attacker.hpAvg * (INCAPACITATING.has(rider.condition) ? 0.25 : 0.08)
        * (rider.saveFailMargin !== undefined ? reach : rider.saveFailMarginBelow !== undefined ? 1 - reach : 1)), 0);
  return fail * (damage + control);
}

/**
 * The same per-turn cost for an emanation that fires on its owner's turn. It belongs in the
 * movement search for exactly the reason the victim-turn one does — otherwise a ranged opponent
 * happily stands in a Remorhaz's 3d10 a round because nothing in the score says it hurts — and
 * the eligibility tests mirror `auraThreat`'s, plus the reach test the mechanic actually uses.
 *
 * Two things it deliberately does not price. A grapple-gated emanation is a threat only while the
 * hold is on, so a creature not in one pays nothing for standing next to the Barbed Devil; that
 * is read from live state, not assumed. And a `suppressedBy` gate is left out: whether a
 * troll's aura is switched off this round depends on damage the mover has not dealt yet, and
 * guessing at it would price the square by a decision not yet made.
 */
function sourceTurnAuraThreat(
  foe: CombatStatblock,
  foeState: FighterState,
  attacker: CombatStatblock,
  attackerState: FighterState,
  foeSource: 0 | 1,
  distance: number,
): number {
  if (attackerState.conditions.some(c => c.name === "swallowed")) return 0;
  const aura = foe.sourceTurnAura;
  if (!aura) return 0;
  if (auraImmuneTo(attackerState, aura)) return 0;
  if (aura.targetTypes && !aura.targetTypes.includes(attacker.creatureType)) return 0;
  if (aura.excludedTargetTypes?.includes(attacker.creatureType)) return 0;
  const states: [FighterState, FighterState] = foeSource === 0 ? [foeState, attackerState] : [attackerState, foeState];
  if (!sourceTurnAuraReaches(aura, states, foeSource, distance)) return 0;
  return auraCost(aura, attacker);
}

/**
 * The closest two fighters can stand: five feet, spaces touching and never overlapping. `ground` is the
 * horizontal separation, and a flier directly overhead may stand at 0 of it, so the floor is on the
 * separation itself — the ground may reach 0 only where the vertical gap already keeps the pair apart.
 *
 * Nothing enforced it. The fallback Dash aimed at `max(0, ground − (speed + current speed))` and the
 * movement candidates ran down to `max(0, ground − speed)`, so a creature whose Dash covered more than the
 * gap, or whose reach was still in range at 0, ended inside its foe. The invariant census found it in
 * 83,127 max30 rows, 176,402 in max120 and 382,958 in max600, and a run-up creature was
 * collecting a 30-foot charge from a 30-foot start by walking the last five feet into the target.
 */
const MIN_SEPARATION = 5;

/** How many times longer the foe must need to kill a waiting flier than the flier needs to kill it, before it comes down. */
const WAIT_MARGIN = 2;

/**
 * Whether this pair may stand closer than five feet. A swarm "can occupy another creature's space and vice
 * versa" (`sharesSpace`), and a swallowed creature is inside its swallower (`settleSwallowGeometry`).
 */
function mayShareSpace(a: CombatStatblock, aState: FighterState, b: CombatStatblock, bState: FighterState): boolean {
  return !!a.sharesSpace || !!b.sharesSpace || hasCondition(aState, "swallowed") || hasCondition(bState, "swallowed");
}

/** The nearest ground a mover at `height` may take toward its foe. */
function groundFloor(mover: CombatStatblock, moverState: FighterState, height: number, foe: CombatStatblock, foeState: FighterState): number {
  if (mayShareSpace(mover, moverState, foe, foeState)) return 0;
  return verticalGap(mover, height, foe, foeState.height) >= MIN_SEPARATION ? 0 : MIN_SEPARATION;
}

/**
 * The sense ranges that are live sight boundaries for this pair right now. Blindsight is one only while its owner is
 * Blinded, blind beyond it, or facing an Invisible foe; Truesight only while its owner can see and the foe is
 * Invisible. Anywhere else ordinary sight reaches past the range, so it marks nothing worth standing on, and adding it
 * as a candidate only perturbs the movement search.
 */
function sightBoundaries(a: CombatStatblock, aState: FighterState, b: CombatStatblock, bState: FighterState): number[] {
  const ranges: number[] = [];
  for (const [printed, own, foe] of [[a, aState, bState], [b, bState, aState]] as const) {
    const block = eyes(printed, own);
    const blinded = hasCondition(own, "blinded"), foeInvisible = unseenBy(foe, block);
    if (block.blindBeyond !== undefined) ranges.push(block.blindBeyond);
    if (block.blindsight !== undefined && (blinded || foeInvisible || block.blindBeyond !== undefined)) ranges.push(block.blindsight);
    if (block.truesightRange !== undefined && foeInvisible && !blinded) ranges.push(block.truesightRange);
  }
  return ranges;
}

/** The flat landmark list `moveCandidates` scans, for callers with no `MovementMeta` to hand. */
function collectLandmarks(block: CombatStatblock): number[] {
  const landmarks: number[] = [];
  for (const option of block.options) for (const landmark of actionRangeLandmarks(option.action)) landmarks.push(landmark);
  return landmarks;
}

function moveCandidates(attacker: CombatStatblock, defender: CombatStatblock, current: number, speed: number, maxDistance: number, senseRanges: number[], attackerMeta?: MovementMeta, defenderMeta?: MovementMeta): number[] {
  const lower = Math.max(0, current - speed);
  const upper = Math.min(maxDistance, current + speed);
  const values = new Set<number>([lower, Math.min(Math.max(current, lower), upper), upper]);
  const clamp = (value: number) => Math.min(Math.max(value, lower), upper);
  // Adjacent is always a candidate. The searches drop squares under it (`MIN_SEPARATION`), and without it a
  // creature whose options have no 5-foot landmark would lose its closest legal square.
  values.add(clamp(MIN_SEPARATION));
  // Landmarks, not just maximum reach: a ranged attack is worth appreciably more inside its
  // normal range than out in the long-range band, and a distance that is never a candidate can
  // never be chosen however good it is.
  for (const landmark of attackerMeta ? attackerMeta.landmarks : collectLandmarks(attacker)) values.add(clamp(landmark));
  for (const range of senseRanges) { values.add(clamp(range)); values.add(clamp(range + 5)); }
  for (const landmark of defenderMeta ? defenderMeta.landmarks : collectLandmarks(defender)) values.add(clamp(landmark + 5));
  return [...values].sort((a, b) => a - b);
}

/**
 * Altitudes worth evaluating. Only fliers get more than one value, so for every grounded
 * creature the candidate grid stays exactly as wide as it was before elevation existed.
 * Climbing higher than the foe's melee threat envelope only inflates `distance` for no gain,
 * so these few landmarks cover every altitude that can change the outcome.
 */
function moveHeights(attacker: CombatStatblock, current: number, foe: CombatStatblock, foeHeight: number, speed: number, roof: number, foeMeta?: MovementMeta, state?: FighterState): number[] {
  if (!canFly(attacker, state)) return [current];
  // Kept as two separate terms so the sum below adds in exactly the order it always did.
  const foeBody = foeMeta ? foeMeta.bodyHeight : bodyHeight(foe);
  const foeReach = foeMeta ? foeMeta.meleeReach : meleeReach(foe);
  const lower = Math.max(0, current - speed);
  const upper = Math.min(Math.max(0, roof), current + speed);
  const clamp = (value: number) => Math.min(Math.max(Math.round(value), lower), upper);
  return [...new Set<number>([
    clamp(0),
    clamp(current),
    clamp(upper),
    // Dive to the foe's own altitude band, for a flier that wants to be in melee.
    clamp(foeHeight),
    // The lowest altitude outside the foe's melee reach — the whole point of flying.
    clamp(foeHeight + foeBody + foeReach + 5),
    // And the lowest clear of a foe's printed Leap as well.
    ...(leapRise(foe) > 0 ? [clamp(foeHeight + foeBody + foeReach + leapRise(foe) + 5)] : []),
    // And the lowest altitude clear of each emanation the foe carries: just outside its reach can still be inside
    // its aura (a 10-foot Fire Aura around a 5-foot reach).
    ...[foe.aura?.radius, foe.sourceTurnAura?.radius].filter((radius) => radius !== undefined).map((radius) => clamp(foeHeight + foeBody + radius + 5)),
  ])];
}

/**
 * Closest the foe could get to a candidate position on its own next turn. A grounded foe
 * cannot shrink the vertical term at all, which is what makes altitude durable in a way that
 * ground separation isn't. Consulted unless `RunPairOptions.lookahead` is false.
 */
function closestFoeReach(defender: CombatStatblock, foeState: FighterState, ground: number, gap: number, foeSpeed = nextTurnSpeed(defender, foeState)): number {
  return Math.max(Math.max(0, ground - foeSpeed), canFly(defender, foeState) ? Math.max(0, gap - foeSpeed) : Math.max(0, gap - leapRise(defender)));
}

const LEAP_RISE = new WeakMap<CombatStatblock, number>();
/** How high a printed Leap carries a creature with no Fly Speed (`leapUpPlan`): the height a foe aloft cannot count on. */
function leapRise(block: CombatStatblock): number {
  let rise = LEAP_RISE.get(block);
  if (rise === undefined) {
    rise = 0;
    if (block.flySpeed === undefined) for (const option of block.options) {
      const move = option.action.kind === "selfbuff" && option.timing === "bonus" ? option.action.movement : undefined;
      if (move?.mode === "leap") rise = Math.max(rise, move.distance ?? 0);
    }
    LEAP_RISE.set(block, rise);
  }
  return rise;
}

/** The durations that are still running when the controller's next turn comes round. */
const LASTING_DURATIONS = new Set<string>(["saveEndsEachTurn", "permanent", "untilEscape"]);

/**
 * Conditions that take their victim out of action by sending it away. They last, but the foe spends them
 * running, so there is no held foe to hit when the controller's turn comes round: a devil Suggests a warrior
 * in a 120-foot room and Dashes after it for a hundred rounds without once getting within 20 feet.
 */
const ROUTING_CONDITIONS = new Set<string>(["suggested", "fearSpell"]);

/**
 * Would this routine put the foe out of action past the foe's own next turn, and leave it where it can be
 * hit, against the foe as it stands? A condition it already has, is immune to, one that sends it running,
 * or a rider waiting on a condition nothing supplies (the Revenant's paralysis wants a curse the Glare does
 * not bring) locks nothing.
 */
function routineLocksFoe(routine: Routine | undefined, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState): boolean {
  return !!routine?.parts.some((part) => {
    const action = attacker.options[part.optionIdx]?.action;
    return !!action && actionLocksFoe(action, defender, foeState);
  });
}

function actionLocksFoe(action: CombatAction, defender: CombatStatblock, foeState: FighterState): boolean {
  if (action.kind === "random") return action.branches.some((branch) => actionLocksFoe(branch, defender, foeState));
  if (!("riders" in action)) return false;
  const riders = [...(action.riders || []), ...(action.kind === "attack" ? action.extraSave?.riders || [] : [])];
  return riders.some((rider) => LASTING_DURATIONS.has(rider.duration) && !ROUTING_CONDITIONS.has(rider.condition)
    && (INCAPACITATING.has(rider.condition) || (!!rider.transitionOnFailedSave && INCAPACITATING.has(rider.transitionOnFailedSave)))
    && !defender.conditionImmune.includes(rider.condition)
    && !sleepBlocked(rider, defender)
    && !immunityGated(rider, defender)
    && !hasCondition(foeState, rider.condition)
    && (!rider.requiresTargetCondition
      || hasCondition(foeState, rider.requiresTargetCondition)
      || riders.some((other) => other !== rider && other.condition === rider.requiresTargetCondition)));
}

interface RoutineChoice {
  routine?: Routine;
  ev: number;
}

/** The foe's per-square costs that depend on the candidate only through its separation. */
interface DistanceThreat {
  aura: number;
  sourceTurnAura: number;
  retaliation: number;
  rebuke: number;
  approachRebuke: number;
}

/**
 * A step of a fixed sequence that does nothing to this foe (a roar whose only condition the foe is immune to) still
 * brings the later steps into reach. It is worth the best later step, halved for each use that stands before it.
 */
function sequenceAdvanceEv(option: ActionOption, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, state: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator): number {
  const sequence = option.sequence;
  if (!sequence) return 0;
  let best = 0;
  for (const later of attacker.options) {
    const step = later.sequence;
    if (!step || step.pool !== sequence.pool || step.position <= sequence.position) continue;
    const ev = dynamicEv(later.action, attacker, defender, foeState, state, source, distance, evaluator, "action");
    best = Math.max(best, ev * 0.5 ** (step.position - sequence.position));
  }
  return best;
}

/**
 * Best usable routine at a distance, in two flavours: `any` (control included) and
 * `damaging` (restricted to routines that make lethal progress). Both are produced by a
 * single pass because the per-routine EV is identical either way — only the acceptance
 * test differs — so evaluating them separately was doing the whole search twice.
 */
interface RoutineChoices {
  any: RoutineChoice;
  damaging: RoutineChoice;
}

/** The share of a part's price that is `dynamicEv`'s priority lift for a regeneration suppressor. The lift marks a
 *  winning line and belongs to a routine once: counted per swing, three acid Rends (25.6 damage) outbid the Acid Breath
 *  (39.2) against a Troll until the third round. */
function suppressorLift(action: CombatAction, defender: CombatStatblock, ev: number): number {
  const regen = defender.regeneration, lift = defender.hpAvg * 0.5;
  return regen?.deathRule && regen.suppressedBy.length && actionSuppresses(action, regen.suppressedBy) && ev > lift && ev < defender.hpAvg * 100 ? lift : 0;
}

function bestUsableRoutinesAtDistance(attacker: CombatStatblock, defender: CombatStatblock, state: FighterState, foeState: FighterState, source: 0 | 1, distance: number, evaluator: PairEvaluator, runUp?: number, scoreAction?: (action: CombatAction) => number): RoutineChoices {
  let bestAny: Routine | undefined;
  let bestAnyEv = 0;
  let bestDamaging: Routine | undefined;
  let bestDamagingEv = 0;
  // The conditions that put Disadvantage on this creature's next attack roll only, if it holds any.
  const oneRollHeld = state.conditions.filter((c) => c.rollEffects?.length && c.rollEffects.every((e) => e.roll === "attack" && e.mode === "disadvantage" && e.nextRollOnly));
  const oneRoll = oneRollHeld.length ? oneRollHeld : undefined;
  for (const routine of attacker.routines) {
    if (routine.requiresCondition && !hasCondition(state, routine.requiresCondition)) continue;
    if (routine.maxDistance !== undefined && distance > routine.maxDistance) continue;
    let ev = 0;
    let hasUsable = false;
    let dealsDamage = false;
    let attackMade = false;
    let lifted = false;
    let slowAttackCount = 0;
    let partDistance = distance;
    let mayGrapple = foeState.conditions.some(c => c.name === "grappled" && c.source === source);
    let oneRollFree: FighterState | undefined;
    for (const part of routine.parts) {
      const option = attacker.options[part.optionIdx];
      let count = part.perHead ? state.heads ?? part.count : part.count;
      // A part that replaces an attack takes the one attack's place ("It can replace one attack with a use of Slowing
      // Breath"): a Slowed Young Copper Dragon made its Rend and breathed as well.
      if (option && state.conditions.some(c => c.oneAttack) && (option.action.kind === "attack" || option.action.kind === "autohit" && option.action.melee || part.replacesAttack)) {
        if (slowAttackCount++) continue;
        count = 1;
      }
      if (!option || !usable(state, part.optionIdx, option)
      || !preservesUsefulCharm(option.action, attacker, defender, state, foeState, source, partDistance)
      || !worthReusing(option.action, attacker, defender, foeState, source, partDistance, evaluator)
      || recoilForNothing(option.action, attacker, defender, foeState, state, source, partDistance, evaluator)) continue;
      if (option.action.kind === "autohit" && option.action.pull && mayGrapple
        && actionInRange(option.action, partDistance) && actionTargetable(option.action, attacker, defender, partDistance, foeState, state)) {
        partDistance = Math.max(5, partDistance - option.action.pull); hasUsable = true; continue;
      }
      if (!actionInRange(option.action, partDistance) || !actionRequirementMet(option.action, foeState, source)
        || !actionTargetable(option.action, attacker, defender, partDistance, foeState, state)) continue;
      if ("riders" in option.action && option.action.riders?.some(r => r.condition === "grappled") && !defender.conditionImmune.includes("grappled")) mayGrapple = true;
      hasUsable = true;
      // A run-up that applies immediately before the hit belongs to the first attack after the approach, so the price
      // follows: the part's first swing carries the square's run-up only if no earlier part of the
      // routine makes an attack, and every other swing is priced with none.
      const immediate = runUp !== undefined && actionHasImmediateRunUpGate(option.action);
      const first = !(immediate && attackMade);
      // "Disadvantage on the next attack roll" is spent by the routine's first attack roll: every later one is priced
      // without it. A Bulette under an Ettin's Morningstar took its Deadly Leap (17.1) over two Bites priced as both at
      // Disadvantage (21.8, and 24.5 as rolled) once the Leap's knock-down was added.
      const spentBefore = attackMade;
      const later = option.action.kind === "attack" && oneRoll ? (oneRollFree ??= { ...state, conditions: state.conditions.filter((c) => !oneRoll.includes(c)) }) : undefined;
      attackMade ||= makesAttack(option.action);
      if (immediate && (!first || count > 1)) {
        const plainEv = dynamicEv(option.action, attacker, defender, foeState, state, source, partDistance, evaluator, "action", 0);
        const plainFactor = evaluator.repeatFactor(option.action, attacker, defender, count, DEFENCES_ACTIVE, 0);
        const firstEv = !first ? plainEv
          : scoreAction && partDistance === distance ? scoreAction(option.action)
          : dynamicEv(option.action, attacker, defender, foeState, state, source, partDistance, evaluator, "action", runUp);
        ev += firstEv + plainEv * (plainFactor - 1);
        dealsDamage ||= (firstEv > 0 || plainEv > 0) && evaluator.makesLethalProgress(option.action, attacker, defender);
        continue;
      }
      let partEv = later && spentBefore
        ? dynamicEv(option.action, attacker, defender, foeState, later, source, partDistance, evaluator, "action", runUp)
        : scoreAction && partDistance === distance
        ? scoreAction(option.action)
        : dynamicEv(option.action, attacker, defender, foeState, state, source, partDistance, evaluator, "action", runUp);
      if (later && !spentBefore && count > 1) {
        const plain = dynamicEv(option.action, attacker, defender, foeState, later, source, partDistance, evaluator, "action", runUp);
        const factor = repeatFactorWalkedOff(option.action, attacker, defender, foeState, later, source, partDistance, evaluator, count, runUp);
        ev += partEv + plain * (factor - 1);
        dealsDamage ||= (partEv > 0 || plain > 0) && evaluator.makesLethalProgress(option.action, attacker, defender);
        continue;
      }
      if (partEv <= 0) partEv = sequenceAdvanceEv(option, attacker, defender, foeState, state, source, partDistance, evaluator);
      // Damage multiplies with the number of swings and riders do not; `repeatFactor` is what
      // keeps a three-attack routine from buying the same condition three times.
      const lift = suppressorLift(option.action, defender, partEv);
      ev += (partEv - lift) * repeatFactorWalkedOff(option.action, attacker, defender, foeState, state, source, partDistance, evaluator, count, runUp) + (lifted ? 0 : lift);
      lifted ||= lift > 0;
      dealsDamage ||= partEv > 0 && evaluator.makesLethalProgress(option.action, attacker, defender);
    }
    // A knock-down `attackOrder` moves to the front has every other attack of the routine behind it, not the half of
    // them its listed price counts (`pairRiderWorth`). A Gladiator priced two Spears and a Shield Bash under three
    // Spears against a Half-Dragon: 0.5 x 0.35 x 2 x 5.85 = 2.0 for the knock-down, where it was listed at 1.0.
    const ordered = hasUsable && routine.parts.length > 1 ? attackOrder(routine, attacker, defender, foeState, distance) : routine.parts;
    const lead = ordered !== routine.parts && ordered[0].count === 1 ? attacker.options[ordered[0].optionIdx] : undefined;
    if (lead && (lead.action.kind === "attack" || lead.action.kind === "save") && !isProne(foeState) && usable(state, ordered[0].optionIdx, lead)
      && lead.action.riders.some((rider) => rider.condition === "prone")) {
      const knocksDown = (rider: Rider) => rider.condition === "prone";
      const behind = ordered.slice(1).reduce((sum, part) => {
        const option = attacker.options[part.optionIdx];
        return sum + (option?.action.kind === "attack" && usable(state, part.optionIdx, option) ? evaluator.actionEv(option.action, attacker, defender) * part.count : 0);
      }, 0);
      ev += Math.max(0, riderLandChance(lead.action, defender) * ONE_ROLL_SHARE * behind - actionRiderEv(lead.action, defender, knocksDown, undefined, attacker));
    }
    if (routine.onAllHits) {
      ev += (scoreAction && partDistance === distance
        ? scoreAction(routine.onAllHits.action)
        : dynamicEv(routine.onAllHits.action, attacker, defender, foeState, state, source, partDistance, evaluator, "action", runUp)) * 0.5;
      dealsDamage ||= evaluator.makesLethalProgress(routine.onAllHits.action, attacker, defender);
    }
    if (!hasUsable) continue;
    if (bestAny === undefined || ev > bestAnyEv) {
      bestAny = routine;
      bestAnyEv = ev;
    }
    if (dealsDamage && (bestDamaging === undefined || ev > bestDamagingEv)) {
      bestDamaging = routine;
      bestDamagingEv = ev;
    }
  }
  return {
    any: { routine: bestAny, ev: bestAnyEv },
    damaging: { routine: bestDamaging, ev: bestDamagingEv },
  };
}

/** Spend the printed movement to release a victim when that opens a better action this turn. */
function detachFromFoeIfUseful(
  block: CombatStatblock, foe: CombatStatblock, state: FighterState, foeState: FighterState,
  source: 0 | 1, distance: number, evaluator: PairEvaluator, log: FightLog,
): void {
  const attachment = foeState.conditions.find((condition) => condition.name === "attached"
    && condition.source === source && condition.sourceDetachMovement !== undefined);
  const cost = attachment?.sourceDetachMovement;
  if (!attachment || cost === undefined || movementSpeed(block, state) < cost) return;
  // Detachment is useful here only if it unlocks an attack that the current attachment bars.
  // An action that is already usable (the Darkmantle's Crush) must not release its target just
  // to earn the first-application rider value a second time.
  if (!block.options.some((option) => option.action.kind !== "random"
    && "requiresTargetMissingConditions" in option.action
    && option.action.requiresTargetMissingConditions?.includes("attached"))) return;
  // A persistent blood drain already deals damage without spending the source's action. The
  // routine chooser does not price that running tick, so it cannot justify ending one early.
  if (attachment.startTurnDamage?.length || attachment.endTurnDamage?.length) return;
  const before = bestUsableRoutinesAtDistance(block, foe, state, foeState, source, distance, evaluator).any.ev;
  const original = foeState.conditions;
  foeState.conditions = original.filter((condition) => condition !== attachment);
  pruneLinkedConditions(foeState);
  const after = bestUsableRoutinesAtDistance(block, foe, state, foeState, source, distance, evaluator).any.ev;
  if (after <= before) {
    foeState.conditions = original;
    return;
  }
  state.movementPenalty += cost;
  if (log.on) log.push(`${block.name} detaches from ${foe.name} (${cost} ft of movement)`);
}

/**
 * A Legendary Move priced by the turn's own square search. The caller sets the movement budget
 * and whether the step provokes; the search fills `result` with the winning branch's best square and how much
 * its score beats the square the creature stands on. The branch is the damaging search if any square makes
 * lethal progress, else the fallback search: the same two scores the turn compares.
 */
interface LegendaryMoveProbe {
  speed: number;
  noProvoke: boolean;
  /** Search the squares at the creature's present altitude only (the ground between the pair is all that is being set). */
  groundOnly?: true;
  result?: { ground: number; height: number; gain: number };
}

function chooseMovementAndRoutine(attacker: CombatStatblock, defender: CombatStatblock, state: FighterState, foeState: FighterState, source: 0 | 1, engagement: EngagementState, evaluator: PairEvaluator, lookahead = true, probe?: LegendaryMoveProbe): { ground: number; height: number; routine?: Routine; dash?: boolean; via?: number; catches?: boolean } {
  const carrying = carriesTarget(foeState, source);
  const speed = (probe ? probe.speed : movementSpeed(attacker, state)) / (carrying ? carryCost(attacker, defender) : 1);
  const roof = Math.max(0, Math.min(skyRoof(engagement, defender),
    carrying ? skyRoof(engagement, attacker) - (foeState.height - state.height) : Infinity));
  const currentHeight = state.height;
  const foeHeight = foeState.height;
  // Frightened forbids *willingly* moving closer to the source of the fear. In a duel the
  // source is the only opponent, so the condition collapses to a floor on separation: hold or
  // retreat, never close. Forced movement (the Fear spell's rout) is handled by its own branch
  // in `takeTurn` and never reaches here.
  const frightened = isFrightened(state);
  const minDistance = frightened ? engagement.distance : 0;
  // A grappler drags rather than abandons, and a harpooned creature may only close: either way
  // there is a separation this creature's own feet may not take it past. See `movementCeiling`.
  const maxDistance = movementCeiling(state, foeState, source, engagement.distance);
  const foeSource: 0 | 1 = source === 0 ? 1 : 0;
  const separationFloor = mayShareSpace(attacker, state, defender, foeState) ? 0 : MIN_SEPARATION;
  const attackerMeta = evaluator.movementMeta(attacker);
  const defenderMeta = evaluator.movementMeta(defender);
  const everyCandidate = moveCandidates(attacker, defender, engagement.ground, speed, engagement.maxDistance, sightBoundaries(attacker, state, defender, foeState), attackerMeta, defenderMeta);
  // Ground the foe makes Difficult Terrain (`difficultGround`) costs double: each candidate is where the walk toward it stops.
  const allCandidates = defender.difficultGround
    ? [...new Set(everyCandidate.map((ground) => difficultGroundStop(attacker, state, defender, engagement.ground, ground, speed)))].sort((a, b) => a - b)
    : everyCandidate;
  // An Incapacitated flier that cannot hover is on the ground and moves on the ground only (`settleFlight`).
  // So does one that is Prone and cannot stand (`groundBound`).
  const heights = probe?.groundOnly ? [currentHeight] : groundBound(attacker, state)
    ? moveHeights(attacker, currentHeight, defender, foeHeight, speed, roof, defenderMeta, state).filter((h) => h <= currentHeight)
    : moveHeights(attacker, currentHeight, defender, foeHeight, speed, roof, defenderMeta, state);
  // Invariants of this one search. Neither fighter's state moves while it runs — the same
  // assumption the per-distance routine memo below already rests on — so the foe's Speed, how
  // much of its routine survives what it is suffering, and whether it is in any condition to
  // answer a step at all are each read once rather than once per candidate square.
  // What this creature laid on the foe "until the end of its next turn" on an earlier turn or off its turn (a Legendary
  // Action) ends as this turn does, so the foe moves on its own turn as if free of it. A Mummy Lord left a Roc its
  // Dreadful Glare had Paralyzed to shoot it from 30 feet, reading the Roc's Speed as 0, and gave up the Critical Hit.
  const lapsing = probe ? [] : foeState.conditions.filter((c) => c.duration === "endOfSourceNextTurn" && c.source === source && state.turnCount > c.appliedTurn);
  const foeNext = lapsing.length ? { ...foeState, conditions: foeState.conditions.filter((c) => !lapsing.includes(c)) } : foeState;
  const foeSpeed = nextTurnSpeed(defender, foeNext) + closingBeyondSpeed(attacker, state, defender, foeState, source);
  const foeThreatFactor = threatFactor(defender, foeState);
  const foeCanAnswerStep = !probe?.noProvoke && movementProvokeGuard(attacker, state, defender, foeState, engagement.distance);
  const gapAt = (height: number): number => verticalGap(attacker, height, defender, carrying ? Math.max(0, foeHeight + height - currentHeight) : foeHeight);
  // Retreat is still free; only approach is barred. A candidate is kept when *some* reachable
  // altitude leaves it at or beyond the current separation, so a flier can still trade ground
  // for height without the filter deciding altitude on its behalf.
  const held = maxDistance === Infinity
    ? allCandidates
    : allCandidates.filter((ground) => heights.some((height) => Math.max(ground, gapAt(height)) <= maxDistance));
  const candidates = frightened
    ? held.filter((ground) => heights.some((height) => Math.max(ground, gapAt(height)) >= minDistance))
    : held;
  const lowestReachable = Math.max(0, currentHeight - speed);
  const highestReachable = Math.min(roof, currentHeight + speed);
  const holdHeight = Math.min(Math.max(currentHeight, lowestReachable), highestReachable);
  // Closing on a foe means matching its altitude band as well as its ground position.
  const closingHeight = canFly(attacker, state)
    ? Math.min(Math.max(foeHeight, lowestReachable), highestReachable)
    : currentHeight;
  // Nothing below mutates fighter state, so a distance evaluated once can be reused.
  const evaluated = new Map<number, RoutineChoices>();
  const choicesAt = (distance: number): RoutineChoices => {
    let choices = evaluated.get(distance);
    if (!choices) {
      // The run-up this square gives a charge: what the creature has already moved toward the foe this
      // turn, plus whatever getting here closes — counted the way `applyMovement` counts it.
      const runUp = state.movedToward + Math.max(0, engagement.distance - distance);
      // Routine alternatives commonly share option actions. One map per candidate makes the rest of
      // the key structural: attacker/defender/state belong to this movement invocation, and
      // distance/run-up/timing/source are fixed by this closure. It cannot survive movement or action.
      const actionScores = evaluator.reuseMovementActions ? new WeakMap<CombatAction, number>() : undefined;
      const scoreAction = (action: CombatAction): number => {
        if (!actionScores) return dynamicEv(action, attacker, defender, foeState, state, source, distance, evaluator, "action", runUp);
        const cached = actionScores.get(action);
        if (cached !== undefined) {
          if (evaluator.cacheStats) evaluator.cacheStats.movementActionHits++;
          return cached;
        }
        if (evaluator.cacheStats) evaluator.cacheStats.movementActionMisses++;
        const value = dynamicEv(action, attacker, defender, foeState, state, source, distance, evaluator, "action", runUp);
        actionScores.set(action, value);
        return value;
      };
      choices = bestUsableRoutinesAtDistance(attacker, defender, state, foeState, source, distance, evaluator, runUp,
        scoreAction);
      evaluated.set(distance, choices);
    }
    return choices;
  };
  // Everything the foe costs a square that depends on the square only through the separation it
  // ends at. `closestFoeReach` deliberately stays outside: it is derived from the candidate's
  // ground position and vertical gap, which two different squares can share a separation without
  // sharing. The terms are kept apart rather than summed so each caller below adds them in the
  // order it always did.
  const threats = new Map<number, DistanceThreat>();
  const threatAt = (distance: number): DistanceThreat => {
    if (!evaluator.reuseMovementThreats) return computeDistanceThreat(distance);
    let threat = threats.get(distance);
    if (threat) {
      if (evaluator.cacheStats) evaluator.cacheStats.movementThreatHits++;
      return threat;
    }
    if (evaluator.cacheStats) evaluator.cacheStats.movementThreatMisses++;
    threat = computeDistanceThreat(distance);
    threats.set(distance, threat);
    return threat;
  };
  function computeDistanceThreat(distance: number): DistanceThreat {
    return {
      aura: auraThreat(defender, attacker, distance, state),
      sourceTurnAura: sourceTurnAuraThreat(defender, foeState, attacker, state, foeSource, distance)
        + spaceEntryThreat(defender, foeState, attacker, state, distance),
      retaliation: retaliationThreat(defender, attacker, distance),
      rebuke: rebukeThreat(defender, foeState, attacker, state, foeSource, distance),
      approachRebuke: approachRebukeCost(defender, foeState, attacker, state, foeSource, engagement.distance, distance),
    };
  }
  // The opportunity attack a step into `distance` provokes. `cachedBestOaOption` already memoizes
  // per pair, but the lookup itself — direction, key arithmetic, two map probes — ran once per
  // candidate square; `engagement.distance` is fixed, so within one search it is a function of
  // the arrival distance alone.
  const oaOptions = new Map<number, { optionIdx: number; ev: number } | undefined>();
  const oaAt = (distance: number): { optionIdx: number; ev: number } | undefined => {
    if (!evaluator.reuseMovementThreats) return cachedBestOaOption(evaluator, defender, attacker, engagement.distance, distance);
    if (oaOptions.has(distance)) return oaOptions.get(distance);
    const value = cachedBestOaOption(evaluator, defender, attacker, engagement.distance, distance);
    oaOptions.set(distance, value);
    return value;
  };
  // Frightened creatures fall back on standing still, not on the closest reachable spot.
  const holdGround = frightened ? engagement.ground : candidates[0] ?? engagement.ground;
  let bestDamagingGround = holdGround;
  let bestDamagingHeight = holdHeight;
  let bestDamagingDistance = frightened ? engagement.distance : candidates[0] ?? engagement.distance;
  let bestDamagingEv = 0;
  let bestDamagingThreat = 0;
  let snipeEv = 0;
  let snipeGround = 0;
  let snipeHeight = 0;
  let snipeDistance = 0;
  let bestDamagingScore = -Infinity;
  let bestFallbackGround = holdGround;
  let bestFallbackHeight = holdHeight;
  let bestFallbackRoutine: Routine | undefined;
  let bestFallbackEv = 0;
  let bestFallbackScore = -Infinity;
  // The square the creature stands on, scored in both searches; only a probe reads them.
  let currentDamagingScore: number | undefined;
  let currentFallbackScore: number | undefined;
  // A creature that cannot win keeps out of harm: the square is chosen by the foe's threat there (and the step's
  // opportunity attack), and what the creature could do from it only breaks ties. An Adult Blue Dragon landed beside a
  // Troll Limb to make its Rends Critical Hits on a body that regenerates every turn, and lost all 400 fights to it; a
  // Young Blue Dragon Dashed up to an Ochre Jelly it cannot hurt and Dodged beside it. Aloft, or away, both draw.
  const hopeless = !probe && noLethalLineLeft(attacker, state, defender, evaluator);
  // A spent recharge that the creature could use from beyond the reach of a foe with nothing to answer it there is
  // worth waiting for where the exchange in between is a losing one; see the return below.
  const outOfReach = (option: ActionOption): boolean => "range" in option.action && (option.action.range ?? 0) > meleeReach(defender)
    && evaluator.bestRoutineEvAtDistance(defender, attacker, option.action.range ?? 0, false) <= 0;
  // What a creature that fights in melee gives up by laying a condition that opens the foe to its attacks (Paralyzed,
  // Restrained, Stunned) from farther off than it can walk back next turn: the routine it would have made on the foe
  // while the condition holds. A Cultist Fanatic stepped from 30 feet to 60 to cast Hold Person and spent the Berserker's
  // Paralyzed turn Dashing back (E14).
  const followUpLost = (routine: Routine | undefined, distance: number): number => {
    const reach = meleeReach(attacker);
    // Not against a flier: where it goes next is not a walk away. A Giant Spider drawn in to follow up its Web on a
    // Sprite 40 feet up went from 146 wins of 152 to 267 of 633.
    if (!routine || foeFlies || foeMayFly || distance <= reach + movementSpeed(attacker, state)) return 0;
    // By damage alone: the condition's own price is the same from either square.
    const damageAt = (from: number): number => Math.max(0, ...attacker.routines.map((other) => other.parts.every((part) => actionInRange(attacker.options[part.optionIdx].action, from))
      ? other.parts.reduce((sum, part) => sum + evaluator.expectedActionDamage(attacker.options[part.optionIdx].action, attacker, defender) * part.count, 0) : 0));
    const beside = damageAt(reach);
    const here = damageAt(distance);
    if (beside * ADVANTAGE_EV <= here) return 0;
    let held = 0;
    for (const part of routine.parts) {
      const action = attacker.options[part.optionIdx]?.action;
      if (!action || !("riders" in action)) continue;
      for (const rider of action.riders ?? []) {
        if (!rider.condition || !(OPENING_CONDITIONS.has(rider.condition) || rider.drawnToSource) || defender.conditionImmune.includes(rider.condition) || hasCondition(foeState, rider.condition)) continue;
        // Gone before the creature's next turn, or kept through the foe's own turn only on a failed save.
        if (rider.duration === "endOfTargetTurn" || rider.duration === "startOfTargetNextTurn" || rider.duration === "endOfTargetNextTurn" || rider.duration === "startOfSourceNextTurn") continue;
        const kept = rider.duration === "saveEndsEachTurn" && rider.save
          ? saveFailChance(rider.save.dc, defender.saves[rider.save.ability] ?? defender.abilityMods[rider.save.ability]) : 1;
        held = Math.max(held, riderLandChance(action, defender) * kept);
      }
    }
    return held * (beside * ADVANTAGE_EV - here);
  };
  const awaitedBlast = !probe && !hopeless && lookahead && !frightened && attacker.options.some((option, idx) => option.timing === "action" && option.uses.t === "recharge"
    && !usable(state, idx, option) && !state.depleted.has(idx) && evaluator.expectedActionDamage(option.action, attacker, defender) > 0 && outOfReach(option));
  // A recharge whose damage all comes turn by turn from what it leaves on the foe (a Vrock's Spores: Poisoned "takes 5
  // (1d10) Poison damage at the start of each of its turns") is worth that from the same height, spent or ready: it
  // keeps the creature out of an exchange it loses, and brings it into none it wins. A Vrock landed beside a Hydra with
  // no way up to it and lost 400 fights of 400.
  const awaitedSeed = !awaitedBlast && !probe && !hopeless && lookahead && !frightened && attacker.options.some((option, idx) => option.timing === "action"
    && option.uses.t === "recharge" && !state.depleted.has(idx) && evaluator.expectedActionDamage(option.action, attacker, defender) <= 0
    && actionRiderEv(option.action, defender, (rider) => !!rider.startTurnDamage?.length, undefined, attacker) > 0 && outOfReach(option));
  // The same recharge ready, where every square it can be used from is one the foe reaches (a Hezrou's Leap goes up 30
  // feet and a wyrmling's breath reaches 20): the creature breathes once and is killed for it. Where the foe wins that
  // exchange twice over and there is a square the foe cannot come to, it keeps to that square (L04).
  const awaitedReady = !awaitedBlast && !awaitedSeed && !probe && !hopeless && lookahead && !frightened && attacker.options.some((option, idx) => option.timing === "action"
    && option.uses.t === "recharge" && usable(state, idx, option) && evaluator.expectedActionDamage(option.action, attacker, defender) > 0 && outOfReach(option));
  const awaited = awaitedBlast || awaitedSeed || awaitedReady;
  // The best square to trade blows from, by the same score as the damaging square, among those with damage to deal: the
  // damaging square itself may be one with nothing to do (scored by distance alone) when every exchange scores worse.
  let exchangeScore = -Infinity;
  let exchangeEv = 0;
  let exchangeThreat = 0;
  let exchangeIdleThreat = 0;
  let bestSafeScore = -Infinity;
  let bestSafeGround = holdGround;
  let bestSafeHeight = holdHeight;
  let bestSafeToll = 0;
  let bestSafeDistance = engagement.distance;
  let bestSafeIdle = false;
  let bestSafeEv = 0;
  let bestSafeStandoff = -Infinity;
  let bestSafeUnclosable = -1;
  // The longest reach of a melee attack of this creature's that knocks its target Prone. Holding at that reach is a
  // loss, not a standoff: "attack rolls against you have Advantage if the attacker is within 5 feet of you. Otherwise,
  // that attack roll has Disadvantage", and what follows a knock-down (a Trample) wants the creature beside its foe.
  const knockdownReach = isProne(foeState) || defender.conditionImmune.includes("prone") ? 0 : attacker.options.reduce((reach, option, idx) =>
    option.timing === "action" && option.action.kind === "attack" && option.action.melee && usable(state, idx, option)
      && option.action.riders.some((rider) => rider.condition === "prone") ? Math.max(reach, option.action.reach ?? 5) : reach, 0);
  // What a routine loses from beyond 5 feet once one of its swings has knocked the foe Prone: every attack roll after
  // it has Disadvantage there (p x p) and Advantage beside the foe (1 - (1 - p)^2). A Hill Giant stopped at its Tree
  // Club's 10 feet and made the second swing at Disadvantage (D15).
  const knockdownLost = (routine: Routine | undefined, distance: number): number => {
    if (!routine || distance <= 5 || distance > knockdownReach) return 0;
    let prone = 0;
    let lost = 0;
    for (const part of routine.parts) {
      const action = attacker.options[part.optionIdx]?.action;
      if (!action || action.kind !== "attack") continue;
      const hit = hitChance(action.toHit, defender.ac);
      const knocks = action.melee && action.riders.some((rider) => rider.condition === "prone" && (rider.targetMaxSize === undefined || defender.size <= rider.targetMaxSize) && !rider.save);
      for (let swing = 0; swing < part.count; swing++) {
        lost += prone * 2 * (1 - hit) * evaluator.expectedActionDamage(action, attacker, defender);
        if (knocks) prone += (1 - prone) * hit;
      }
    }
    return lost;
  };
  // The gap that clears a grounded foe's melee and its Leap. Height beyond it is paid for in fall dice: it earns no
  // standoff, and the lowest such height is preferred. A Harpy (38 Hit Points) climbed 50 feet for nothing and owed 5d6.
  // Not over a foe with a Fly Speed still to cast: height there is movement its spell must spend and a longer fall when
  // its Concentration breaks, neither of which is priced, so the height and its falls are left as they were. An Adult
  // White Dragon held 15 feet over a Rakshasa for fear of Baleful Command won 319 fights of 400, and 374 from 35.
  const foeFlies = canFly(defender, foeState);
  const foeMayFly = defender.options.some((option, idx) => option.action.kind === "selfbuff" && !!option.action.fly && usable(foeState, idx, option));
  // Clear of the longest range of anything the foe has, too: getting beyond it takes more than one turn's climb, so the
  // threat a turn ahead does not show it. A Manticore held 15 feet over a Pirate Captain (Pistol 30/90) and was shot
  // each round where it used to climb past 90 feet, and a Sprite stayed inside a Basilisk's 30-foot gaze.
  const clearGap = foeMayFly ? Infinity : Math.max(meleeReach(defender) + leapRise(defender), ...(defenderMeta ? defenderMeta.landmarks : collectLandmarks(defender))) + 5;
  // The widest gap the sky allows this creature, however many turns the climb takes.
  const topGap = gapAt(roof);
  for (const height of heights) {
    const gap = gapAt(height);
    // Vertical separation a grounded foe simply cannot erase, unlike horizontal separation it
    // can just walk off. Identically 0 whenever both fighters are on the ground, so all-ground
    // scoring is bit-for-bit what it was before elevation existed. Without it, hovering at 20
    // feet and standing 30 feet away score the same — in both the foe threatens nothing *this*
    // turn — and a flier would climb only by accident of enumeration order.
    const unclosable = foeFlies ? 0 : Math.min(gap, clearGap);
    const excess = foeFlies ? 0 : Math.max(0, gap - clearGap);
    // Height the foe's reach still covers buys nothing and is a fall waiting for a grapple or a knock-down ("falls if it
    // has the Incapacitated or Prone condition or its Speed is reduced to 0", unless it can hover): it counts against
    // the square instead of for it. A Griffon climbed to 20 feet beside a Huge snake, was bitten there and fell.
    const climbInReach = height > currentHeight && gap <= meleeReach(defender);
    const altitudeTerm = climbInReach ? (canHover(attacker, state) ? 0 : -height * 0.002) : unclosable * 0.002 - excess * 0.0002;
    for (const ground of candidates) {
      const distance = Math.max(ground, gap);
      // Never further inside the foe's space than it already stands; see `MIN_SEPARATION`. Standing where it
      // is stays legal, so a creature that fell or was dropped beside its foe can still act from there.
      if ((distance < separationFloor && distance < engagement.distance) || distance < minDistance || distance > maxDistance) continue;
      const { any: fallback, damaging } = choicesAt(distance);
      const threat = threatAt(distance);
      // Standing inside a damaging aura costs something every turn, so it belongs in the
      // threat term: otherwise a creature happily parks in a Nightwalker's 6d6 necrotic field.
      // The foe need not close: it may attack from where this square leaves it ("you have Disadvantage on the roll if
      // you are within 5 feet of an enemy" is the one thing a square beside it takes from a ranged attack), or step
      // out to 10 feet first, through this creature's Opportunity Attack if that is beyond its reach. A Vampire
      // Familiar threw its Umbral Dagger from 20 feet at a Bandit Captain whose Pistol (8.5) beats its Scimitar (6.5).
      const foeHolds = !lookahead ? 0 : Math.max(evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false),
        distance <= 5 ? evaluator.bestRoutineEvAtDistance(defender, attacker, 10, false) - (cachedBestOaOption(evaluator, attacker, defender, distance, 10)?.ev ?? 0) : 0);
      const foeRoutineThreat = Math.max(evaluator.bestRoutineEvAtDistance(defender, attacker, lookahead ? closestFoeReach(defender, foeState, ground, gap, foeSpeed) : distance, false),
        foeHolds) * foeThreatFactor;
      // An aura that fires at the end of its owner's turn fires from where that turn's movement has brought the owner
      // ("At the end of each of the azer's turns, each creature of the azer's choice in a 5-foot Emanation"), so a step
      // the owner walks back over leaves the creature in it: an Awakened Tree backed out of an Azer Sentinel's Fire Aura
      // through an Opportunity Attack every round and burned all the same.
      const foeAura = lookahead && defender.sourceTurnAura?.onSourceTurn === "end" && !defender.sourceTurnAura.requiresGrapple
        ? sourceTurnAuraThreat(defender, foeState, attacker, state, foeSource, Math.min(distance, closestFoeReach(defender, foeState, ground, gap, foeSpeed)))
        : threat.sourceTurnAura;
      // A ranged hit that knocks a flier Prone drops it ("falls if it has the Incapacitated or Prone condition", 1d6 for
      // each 10 feet): height beyond what keeps the foe's melee off is paid for in fall dice. A Young Copper Dragon
      // climbed 40 feet over a Stone Giant whose Stone Club reaches 15, and each Boulder that hit cost it 4d6 more.
      // So does anything else that drops it: a save that knocks Prone, and a condition that Incapacitates or leaves it
      // no Speed ("or its Speed is reduced to 0"), at the odds the action lands.
      const fallDice = Math.min(20, Math.floor(height / 10)) * 3.5;
      const fallRisk = height > 0 && !canHover(attacker, state)
        ? Math.max(0, ...defender.options.map((option, idx) => {
          const action = option.action;
          if ((action.kind !== "attack" && action.kind !== "save") || option.timing !== "action" || !usable(foeState, idx, option) || !actionInRange(action, distance)) return 0;
          if (action.targetTypes && !action.targetTypes.includes(attacker.creatureType)) return 0;
          if (action.excludedTargetTypes?.includes(attacker.creatureType)) return 0;
          const lands = (rider: Rider): boolean => !!rider.condition && !attacker.conditionImmune.includes(rider.condition) && (rider.targetMaxSize === undefined || attacker.size <= rider.targetMaxSize);
          if (action.kind === "attack" && action.riders.some((rider) => rider.condition === "prone" && lands(rider))) {
            return hitChance(action.toHit, attacker.ac) * fallDice + aloftProneEv(action, defender, attacker);
          }
          // Not from an action the sky lets the creature climb beyond: the fall is priced a turn ahead and the way out
          // of range is several turns long. A Sprite afraid of a Dryad's Entangle (90 feet) stayed on the ground under
          // her Vine Lash and lost every fight, where it won 73 of 100 from 120 feet up.
          if (actionRange(action) < topGap) return 0;
          return !foeMayFly && action.riders?.some((rider) => lands(rider) && !rider.speedNotReduced && (rider.condition === "prone" || RULES_INCAPACITATED.has(rider.condition!) || SPEED_ZERO.has(rider.condition!) || rider.speedZero))
            ? riderLandChance(action, attacker) * fallDice : 0;
        }))
        : 0;
      const foeThreat = foeRoutineThreat
        + fallRisk
        + threat.aura
        + foeAura
        + threat.retaliation
        + threat.rebuke;
      const oa = oaAt(distance);
      // `movementProvokes` would re-derive this same opportunity attack uncached, so ask it
      // only for the cheap eligibility half and reuse the lookup we already have.
      // The approach rebuke is the same kind of one-off toll on the step itself, so it rides here
      // rather than in the per-turn threat above.
      const oaCost = (oa && foeCanAnswerStep ? oa.ev : 0)
        + threat.approachRebuke;
      const standoff = (distance > 5 && distance <= knockdownReach ? -distance : foeFlies ? distance : Math.max(ground, Math.min(gap, clearGap))) * 0.002 + altitudeTerm;
      // A foe this turn's damage is likely to drop does not answer next turn, though it still answers the step itself:
      // the next-turn threat is weighed by the chance the foe is left standing (none at half again its hit points,
      // even at its hit points). Without it a dragon at 18 hit points flew out of an adjacent Behir's reach to breathe
      // on its last 23, and died to the opportunity attack.
      const foeStands = foeState.hp > 0 ? 1 - Math.min(1, Math.max(0, damaging.ev / foeState.hp - 0.5)) : 1;
      // What the creature's own aura does to the foe from this square at the end of this turn ("each creature in a 5-foot
      // Emanation originating from the remorhaz takes ... Fire damage"): damage like any other, so a reach that would
      // hold the foe outside it is not a standoff. A Remorhaz bit a Grappled Ogre from 10 feet for three rounds and its
      // Heat Aura never touched it.
      const ownAura = attacker.sourceTurnAura ? sourceTurnAuraThreat(attacker, state, defender, foeState, source, distance) : 0;
      // The Opportunity Attack on the way up is paid once, and height the foe cannot climb to is kept for every round
      // the fight has left: the toll is spread over them, three at most. A Manticore beside an Ogre Rent it through a
      // Greatclub a round (0.65 x 13 = 8.5) where its Tail Spikes do the same from over a long-range Javelin (4.6).
      // Not where that attack holds the creature it hits ("the target has the Grappled condition": the climb ends there)
      // and the foe still has something to answer with at the top. An Ancient Red Dragon 30 feet from a Kraken rose
      // through a Tentacle toward its Lightning Strike, was Restrained out of reach of its own Rends, and went from 193
      // wins of 400 to 48. With nothing to fear at the top the climb is still tried (Ancient Bronze Dragon, 118 wins to 225).
      const oaAction = oa && foeCanAnswerStep ? defender.options[oa.optionIdx]?.action : undefined;
      const oaHolds = !!oaAction && "riders" in oaAction && !!oaAction.riders?.some((rider: Rider) =>
        !!rider.condition && !attacker.conditionImmune.includes(rider.condition) && (rider.targetMaxSize === undefined || attacker.size <= rider.targetMaxSize)
        && (rider.condition === "prone" || SPEED_ZERO.has(rider.condition) || !!rider.speedZero));
      const roundsLeft = !(oaHolds && foeRoutineThreat > 0) && damaging.ev > 0 && !foeFlies && !foeMayFly && gap > meleeReach(defender) + leapRise(defender) && height > currentHeight && lookahead ? Math.min(3, Math.max(1, foeState.hp / damaging.ev)) : 1;
      // A step through an Opportunity Attack that holds the creature it hits ends where it began, at the odds the attack
      // hits: the foe's answer is then the one it has from here, not from the square the step was for. A Cloud Giant 30
      // feet from a Kraken stepped back before each Thundercloud, was caught by a Tentacle every round and threw
      // Restrained. As with the climb above, not where the foe has nothing for the square the step was for: the step is
      // then worth trying every turn. Nor for a knock-down, which costs the step and not the turns after it (a Djinni
      // that stayed beside a Dragon Turtle for fear of its Tail went from 262 wins of 400 to 226). Nor for a hold the
      // creature is too big for: a Huge Behir kept beside an Aboleth, whose Tentacle Grapples "a Large or smaller
      // creature", and went from 312 wins of 400 to 235.
      const oaKeeps = oaHolds && !!oaAction && "riders" in oaAction && !!oaAction.riders?.some((rider: Rider) =>
        !!rider.condition && !attacker.conditionImmune.includes(rider.condition) && (rider.targetMaxSize === undefined || attacker.size <= rider.targetMaxSize)
        && (SPEED_ZERO.has(rider.condition) || !!rider.speedZero));
      const heldBack = oaKeeps && foeRoutineThreat > 0 && oaAction?.kind === "attack" && lookahead
        ? hitChance(oaAction.toHit, attacker.ac) * Math.max(0, evaluator.bestRoutineEvAtDistance(defender, attacker, engagement.distance, false) * foeThreatFactor - foeRoutineThreat) : 0;
      const damagingScore = damaging.ev > 0 ? damaging.ev + ownAura - (foeThreat + heldBack) * foeStands * 0.7 - oaCost * 0.7 / roundsLeft + standoff - knockdownLost(damaging.routine, distance) : -distance;
      if (damagingScore > bestDamagingScore) {
        bestDamagingScore = damagingScore;
        bestDamagingGround = ground;
        bestDamagingHeight = height;
        bestDamagingDistance = distance;
        bestDamagingEv = damaging.ev;
        bestDamagingThreat = foeThreat;
      }
      // A square to shoot from that the foe has no answer to, now or ever: above a foe that neither flies nor has
      // anything that reaches there (`sniping`, below). The one with the most damage, then the lowest.
      // An answer that deals no damage is no answer (a Mummy's Dreadful Glare under a Sprite): nothing the foe has that
      // reaches across the gap it cannot close hurts, and no aura, fall or response is priced there.
      const harmless = (): boolean => foeThreat - foeRoutineThreat <= 0
        && defender.options.every((option) => actionRange(option.action) < unclosable || evaluator.expectedActionDamage(option.action, defender, attacker) <= 0);
      if (damaging.ev > 0 && unclosable > 0 && !foeMayFly && (leapRise(defender) <= 0 || gap > meleeReach(defender) + leapRise(defender))
        && (foeThreat <= 0 && evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) <= 0 || harmless())
        && (damaging.ev > snipeEv + 1e-9 || Math.abs(damaging.ev - snipeEv) <= 1e-9 && height < snipeHeight)) {
        snipeEv = damaging.ev;
        snipeGround = ground;
        snipeHeight = height;
        snipeDistance = distance;
      }
      if (awaited && damaging.ev > 0 && damagingScore > exchangeScore) {
        exchangeScore = damagingScore;
        exchangeEv = damaging.ev;
        exchangeThreat = foeThreat + oaCost;
        exchangeIdleThreat = foeThreat - foeRoutineThreat;
      }
      // Fallback (possibly pure control) positioning. This keeps the standoff tiebreaker: the
      // decision to abandon range and close is made below by comparing against the approach
      // value, so preferring distance here no longer causes a creature to camp out of reach.
      const fallbackScore = fallback.ev > 0 ? fallback.ev - foeThreat * 0.7 - oaCost * 0.7 + standoff - followUpLost(fallback.routine, distance) : -distance;
      if (hopeless || awaited) {
        // What protects the creature (Fly, a control that locks the foe) keeps its price where there is something to be
        // protected from; damage that cannot finish only breaks ties.
        // A square it has nothing to do from costs it no retaliation: the action goes to Dodge.
        const inert = fallback.ev <= 0;
        const harm = foeThreat - (inert ? threat.retaliation + foeRoutineThreat * (1 - DISADVANTAGE_EV) : 0);
        const exposed = harm + oaCost > 0;
        const pure = !!fallback.routine?.parts.every((part) => evaluator.expectedActionDamage(attacker.options[part.optionIdx].action, attacker, defender) <= 0);
        // Out of harm's way there is nothing for a self-buff to protect from, and casting one may cost the Concentration
        // that keeps the creature there: an Archmage 180 feet up cast Invisibility over its own Fly and fell.
        const idle = !exposed && !!fallback.routine?.parts.some((part) => attacker.options[part.optionIdx].action.kind === "selfbuff");
        // In order: harm (less what protects from it), then damage that cannot finish (a draw is scored by the
        // hit points left, so chipping from safety still counts), then height the foe cannot climb to, then distance.
        // The opportunity attack on the way out is paid once and the foe's turn beside it every round: where the square
        // is out of the foe's reach the toll counts half, or a creature level with its foe stays and is worn down.
        // A foe that Dashes back beside the creature collects that toll again on every later step away: an Owlbear with
        // nothing to hurt an Ochre Jelly walked off through a Pseudopod each round (0.6 x 12.5 = 7.5) where a Dodge beside
        // it cost 0.36 x 12.5 = 4.5.
        const rejoined = closestFoeReach(defender, foeState, ground, gap, foeSpeed + nextTurnSpeed(defender, foeState)) <= meleeReach(defender);
        const toll = oaCost * (harm > 0 || rejoined ? 0.7 : 0.35);
        const safeScore = (exposed && pure ? fallback.ev : 0) - harm * 0.7 - toll;
        const safeEv = idle || inert || (exposed && pure) ? 0 : fallback.ev;
        if (safeScore > bestSafeScore + 1e-9 || (safeScore > bestSafeScore - 1e-9
          && (safeEv > bestSafeEv + 1e-9 || (safeEv > bestSafeEv - 1e-9
            && (awaited ? (unclosable > 0 && (bestSafeUnclosable <= 0 || distance < bestSafeDistance))
              : unclosable > bestSafeUnclosable || (unclosable === bestSafeUnclosable && standoff > bestSafeStandoff)))))) {
          bestSafeUnclosable = unclosable;
          bestSafeScore = safeScore;
          bestSafeEv = safeEv;
          bestSafeStandoff = standoff;
          bestSafeToll = toll;
          bestSafeGround = ground;
          bestSafeHeight = height;
          bestSafeDistance = distance;
          bestSafeIdle = idle || inert;
        }
      }
      if (probe && ground === engagement.ground && height === currentHeight) {
        currentDamagingScore = damagingScore;
        currentFallbackScore = fallbackScore;
      }
      if (squareOutranks(fallback.ev, fallbackScore, bestFallbackEv, bestFallbackScore)) {
        bestFallbackScore = fallbackScore;
        bestFallbackGround = ground;
        bestFallbackHeight = height;
        bestFallbackRoutine = fallback.routine;
        bestFallbackEv = fallback.ev;
      }
    }
  }
  // Back off and come in again. A run-up is movement toward the target before the hit ("moved 20+ feet straight toward
  // it"), and nothing says where that movement starts: a creature with Speed to spare may walk away and turn round.
  // Each pair of squares (out to `via`, back to `ground`) is scored as the square it ends on is above, with the run-up
  // the way back gives. On the ground only, only where the run-up adds something to what that square is worth without
  // it, and never through an opportunity attack: walking out of a foe's reach to ram it again lost fights (Elk against
  // Dretch 359 wins of 600 to 270, Giant Elk against Dire Wolf 592 to 538), so that way out is not taken.
  let backOff: { via: number; routine?: Routine } | undefined;
  if (!probe && !frightened && !carrying && !defender.difficultGround && currentHeight === holdHeight && heights.includes(currentHeight)
    && attacker.options.some((option, idx) => option.timing === "action" && actionHasRunUpGate(option.action) && usable(state, idx, option))) {
    const gap = gapAt(currentHeight);
    // The squares to turn round on: the search's own, and the one each run-up asks for behind each square it could end
    // on ("moved 30+ feet straight toward it"). The search's own are the pair's range landmarks, and none need lie that
    // far back: an Allosaurus 30 feet from an Owlbear walked up and Bit, where 5 feet back and 30 in is Claws and a Bite.
    const needs = new Set<number>();
    for (const option of attacker.options) {
      if (option.timing !== "action" || option.action.kind !== "attack") continue;
      for (const gate of [...option.action.riders, ...option.action.damage, option.action.followUp]) {
        if (gate && "requiresMovement" in gate && typeof gate.requiresMovement === "number") needs.add(gate.requiresMovement);
      }
    }
    const turns = new Set(everyCandidate);
    for (const need of needs) for (const ground of candidates) if (ground <= engagement.ground && ground + need <= engagement.maxDistance) turns.add(ground + need);
    // What a knock-down on the way back in opens: a Bonus Action that needs the condition (Trample needs its target
    // Prone), at the odds the hit lands it. With one, the way out through an Opportunity Attack is priced, not refused:
    // the walk back is worth the routine and that Bonus Action less the attack taken. Not through an attack that carries
    // a rider of its own (a knock-down ends the walk). A Gorgon beside a Wight Gored for six rounds (about 14 a turn)
    // where 20 feet out and back is a Gore, Prone and a Trample (about 24) for one Necrotic Sword at 30% (about 3).
    let opens = 0, opensAfter = 0, opensWithin = 0, opensBy = -1;
    for (const [idx, bonus] of attacker.options.entries()) {
      const wants = "requiresTargetCondition" in bonus.action ? bonus.action.requiresTargetCondition : undefined;
      if (bonus.timing !== "bonus" || !wants || !usable(state, idx, bonus) || hasCondition(foeState, wants) || defender.conditionImmune.includes(wants)) continue;
      for (const [by, option] of attacker.options.entries()) {
        if (option.timing !== "action" || option.action.kind !== "attack") continue;
        const knock = option.action.riders.find((rider) => rider.condition === wants && rider.requiresMovement !== undefined
          && (rider.targetMaxSize === undefined || defender.size <= rider.targetMaxSize));
        const worth = riderLandChance(option.action, defender) * evaluator.expectedActionDamage(bonus.action, attacker, defender);
        if (knock && worth > opens) { opens = worth; opensAfter = knock.requiresMovement!; opensWithin = actionRange(bonus.action); opensBy = by; }
      }
    }
    for (const via of turns) {
      const out = via - engagement.ground;
      if (out <= 0 || Math.max(via, gap) > maxDistance) continue;
      const toll = foeCanAnswerStep ? oaAt(Math.max(via, gap)) : undefined;
      const tollAction = toll && defender.options[toll.optionIdx]?.action;
      if (toll && (opens <= toll.ev || (tollAction && "riders" in tollAction && tollAction.riders?.length))) continue;
      for (const ground of candidates) {
        const back = via - ground, distance = Math.max(ground, gap);
        if (back <= 0 || out + back > speed || distance < separationFloor || distance < minDistance || ground > engagement.ground) continue;
        if (toll && (state.movedToward + back < opensAfter || distance > opensWithin)) continue;
        const through = toll ? opens - toll.ev : 0;
        const plain = choicesAt(distance).damaging.ev;
        // The attack taken is a share of the foe's turn and the Bonus Action a share of the creature's own: the way out
        // is taken only when it adds more to its own turn than to the foe's. One Glaive on the way out doubles a
        // Minotaur's turn and the Trample adds three quarters to a Gorgon's (924 wins of 1,000 fell to 866).
        if (toll && opens * evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) <= toll.ev * plain) continue;
        const choices = bestUsableRoutinesAtDistance(attacker, defender, state, foeState, source, distance, evaluator, state.movedToward + back);
        // Nor for a turn spent on something the run-up adds nothing to (a Gorgon walked out and back to breathe).
        if (toll && (choices.any.routine !== choices.damaging.routine || !choices.any.routine?.parts.some((part) => part.optionIdx === opensBy))) continue;
        if (choices.damaging.ev + through <= plain) continue;
        const threat = threatAt(distance);
        const foeThreat = evaluator.bestRoutineEvAtDistance(defender, attacker, lookahead ? closestFoeReach(defender, foeState, ground, gap, foeSpeed) : distance, false) * foeThreatFactor
          + threat.aura + threat.sourceTurnAura + threat.retaliation + threat.rebuke;
        const score = choices.damaging.ev + through - foeThreat * 0.7 - threat.approachRebuke * 0.7 + distance * 0.002;
        if (score > bestDamagingScore) {
          bestDamagingScore = score;
          bestDamagingGround = ground;
          bestDamagingHeight = currentHeight;
          bestDamagingDistance = distance;
          bestDamagingEv = choices.damaging.ev;
          backOff = { via, routine: choices.any.routine };
        }
      }
    }
  }
  if (probe) {
    // No gain is claimed from a square the search could not score the current position against.
    probe.result = bestDamagingEv > 0
      ? { ground: bestDamagingGround, height: bestDamagingHeight, gain: currentDamagingScore === undefined ? 0 : bestDamagingScore - currentDamagingScore }
      : { ground: bestFallbackGround, height: bestFallbackHeight, gain: currentFallbackScore === undefined ? 0 : bestFallbackScore - currentFallbackScore };
    return { ground: probe.result.ground, height: probe.result.height };
  }
  // It waits on the nearest such square (the breath is used from there, and a climb only to Dash back is a turn without
  // the Dodge), and comes down only for an exchange it wins by a margin: half as many rounds to kill as to be killed.
  // Out of the foe's reach for good (height it cannot climb to, no harm there, no toll on the way) with a recharge to
  // come back: the creature waits there rather than trade blows it loses, counted in rounds to kill on each side. A
  // Green Dragon Wyrmling (38 hit points, two Rends for 11) landed beside an Ankylosaurus (68, two Tails for 9.5 and a
  // knock-down) between breaths, and lost 246 fights of 400 to a foe that cannot touch it 15 feet up. Not while something
  // that does no damage and takes the foe's turns is worth more than the exchange (a Silver Dragon Wyrmling's Paralyzing
  // Breath; not a Bronze one's Repulsion Breath, which it came down to use on a foe that could not reach it).
  const control = bestFallbackEv > exchangeEv && !!bestFallbackRoutine?.parts.every((part) => {
    const action = attacker.options[part.optionIdx].action;
    return evaluator.expectedActionDamage(action, attacker, defender) <= 0
      && "riders" in action && !!action.riders?.some((rider) => RULES_INCAPACITATED.has(rider.condition ?? "") || RULES_INCAPACITATED.has(rider.transitionOnFailedSave ?? ""));
  });
  // A foe that cannot act answers this turn's blows only with what needs no action (a Fire Elemental's aura): it
  // climbed away from a tree its own breath had Paralyzed. One the blows would wake answers in full (a Flesh Golem asleep
  // to a Brass Dragon Wyrmling's Sleep Breath).
  const helpless = hasAny(foeState, RULES_INCAPACITATED) && !foeState.conditions.some((c) => c.endsOnDamage && RULES_INCAPACITATED.has(c.name));
  // The Opportunity Attack on the way out is paid once and the losing exchange every round: it does not keep the
  // creature in it (a Chimera stayed beside a Hezrou whose Leap reaches where it used to hover, and lost every fight).
  // With the recharge ready that holds only for a creature the foe's answer to one use would half kill from full Hit Points: a sturdier one
  // wins by breathing and climbing away in turn (a Young White Dragon beat a Hezrou four fights in five that way).
  // A creature that loses the exchange where its best routine is (the foe kills it in fewer rounds than it kills the
  // foe, at the averages) and has a square the foe can never answer takes the slow, certain fight from there: a Sprite
  // (10 hp, Needle Sword 6.5) flew down to a Gray Ooze (Speed 10, Pseudopod 10, no ranged attack) and died in seven
  // fights of seven with its bow unanswerable from 10 feet up. Not against Regeneration, nor when the kill would take
  // longer than the fight lasts. The exchange is also read at both sides' full Hit Points, so the plan holds to the
  // end: with a Mummy at 3 hp after 85 rounds of arrows the Sprite won the exchange "by rounds", landed for one
  // Needle Sword roll, missed, and died to the Rotting Fist in two fights of three (N03).
  if (!probe && !backOff && !frightened && snipeEv > 0 && bestDamagingEv > snipeEv && !defender.regeneration
    && (bestDamagingThreat * foeState.hp > bestDamagingEv * state.hp || bestDamagingThreat * defender.hpAvg * WAIT_MARGIN > bestDamagingEv * attacker.hpAvg)
    && foeState.hp / snipeEv <= 60) {
    return { ground: snipeGround, height: snipeHeight, routine: choicesAt(snipeDistance).damaging.routine };
  }
  if (awaited && !backOff && bestSafeScore + bestSafeToll >= -1e-9 && bestSafeUnclosable > 0 && exchangeEv > 0 && !control
    && (!awaitedReady || exchangeThreat * 2 >= attacker.hpAvg)
    && (helpless ? exchangeIdleThreat : exchangeThreat) * foeState.hp * (awaitedBlast ? WAIT_MARGIN : 1 / WAIT_MARGIN) > exchangeEv * state.hp) {
    // What it is waiting with is used from there when it is ready.
    return { ground: bestSafeGround, height: bestSafeHeight, routine: awaitedSeed && !bestSafeIdle ? choicesAt(bestSafeDistance).any.routine : undefined };
  }
  if (hopeless && bestSafeScore > -Infinity) {
    // Faster than a foe that would Dash back to its side: Dash away, and the gap grows each round. Walking off instead
    // paid an opportunity attack every round to a foe that never needed its action to attack (Fire Elemental, Speed 50,
    // against a fire-immune Imp flying 40). Only where there is room, and where the far end is out of the foe's reach.
    const away = Math.min(engagement.maxDistance, engagement.ground + speed + currentSpeed(attacker, state));
    // The foe's own Dash doubles its Speed and nothing else: what its Bonus Action or a teleport adds is added once (a
    // Troll's Dash and Charge cover 75 feet to an Ogre's 80).
    const foeDash = foeSpeed + nextTurnSpeed(defender, foeState);
    if (!frightened && !carrying && 2 * speed > foeDash && away > bestSafeGround && closestFoeReach(defender, foeState, bestSafeGround, gapAt(bestSafeHeight), foeDash) <= meleeReach(defender)
      && Math.max(away, gapAt(holdHeight)) <= maxDistance && heights.includes(holdHeight)
      && closestFoeReach(defender, foeState, away, gapAt(holdHeight), foeDash) > meleeReach(defender)
      && evaluator.bestRoutineEvAtDistance(defender, attacker, closestFoeReach(defender, foeState, away, gapAt(holdHeight), foeSpeed), false) <= 0) {
      return { ground: away, height: holdHeight, dash: true };
    }
    // The same from a foe that shoots, which cannot Dash and shoot: where Dashes outpace its walk and there is room to
    // get beyond its range before the volleys on the way kill, Dash. A Succubus with nothing to hurt a Stone Golem
    // (Speed 30, Force Bolt 120 feet) flew 60 feet and Dodged inside its range each round, and was shot down in three.
    if (!frightened && !carrying && bestSafeScore < 0 && speed + currentSpeed(attacker, state) > foeSpeed && heights.includes(holdHeight)) {
      let ground = engagement.ground;
      let harm = 0;
      for (let round = 0; round < 6 && harm < state.hp; round++) {
        ground += speed + currentSpeed(attacker, state);
        if (ground > engagement.maxDistance) break;
        const shot = closestFoeReach(defender, foeState, ground, gapAt(holdHeight), foeSpeed);
        const volley = evaluator.bestRoutineEvAtDistance(defender, attacker, shot, false);
        if (volley <= 0) return { ground: away, height: holdHeight, dash: true };
        harm += volley;
        ground = Math.max(0, ground - foeSpeed);
      }
    }
    // Still in harm's way on the best square there is: a Fly Speed the creature can give itself lifts it out of a
    // walker's reach for good, which no damage that cannot finish and no Dodge does.
    if (bestSafeScore < 0 && !canFly(attacker, state) && !canFly(defender, foeState)) {
      const lift = attacker.routines.find((routine) => routine.parts.length === 1 && routine.parts.every((part) => {
        const option = attacker.options[part.optionIdx];
        return option.timing === "action" && option.action.kind === "selfbuff" && !!option.action.fly && usable(state, part.optionIdx, option)
          && evaluator.bestRoutineEvAtDistance(defender, attacker, option.action.fly.speed, false) <= 0;
      }));
      if (lift) return { ground: bestSafeGround, height: bestSafeHeight, routine: lift };
    }
    return { ground: bestSafeGround, height: bestSafeHeight, routine: bestSafeIdle ? undefined : choicesAt(bestSafeDistance).any.routine };
  }
  if (bestDamagingEv > 0) {
    // A faster creature that shoots, beside a melee foe whose Dash brings it back each round, pays an Opportunity Attack
    // for every step away. One Dash opens a gap the foe needs several Dashes to close, and each of those rounds is a
    // volley with no Opportunity Attack: it Dashes when the attacks saved outweigh the volley given up. A Centaur
    // Trooper (Speed 50) took a Shield Guardian's Fist every round for five volleys (C18).
    if (!probe && !frightened && !backOff && !carrying && lookahead && !foeFlies && !foeMayFly && currentHeight === 0 && foeState.height === 0
      && foeCanAnswerStep && foeState.hp > 2 * bestDamagingEv) {
      const oa = oaAt(bestDamagingDistance);
      const foeReach = meleeReach(defender);
      const foeDash = foeSpeed + nextTurnSpeed(defender, foeState);
      const stride = speed + currentSpeed(attacker, state);
      const away = Math.min(engagement.maxDistance, engagement.ground + stride);
      if (oa && oa.ev > 0 && bestDamagingGround > engagement.ground && stride > foeDash && away - engagement.ground > speed
        && closestFoeReach(defender, foeState, bestDamagingGround, gapAt(0), foeSpeed) > foeReach
        && closestFoeReach(defender, foeState, bestDamagingGround, gapAt(0), foeDash) <= foeReach
        && answerEvAtDistance(defender, attacker, state, closestFoeReach(defender, foeState, bestDamagingGround, gapAt(0), foeSpeed), evaluator) <= 0) {
        let free = 0;
        let ground = away;
        for (let round = 0; round < 4; round++) {
          ground -= foeDash;
          if (ground <= foeReach) break;
          // It steps away again only as far as its volley stays whole: a Pistol (30/90 ft) is not fired from 55 feet.
          const further = Math.min(engagement.maxDistance, ground + speed);
          const whole = (from: number): boolean => evaluator.bestRoutineEvAtDistance(attacker, defender, from) >= bestDamagingEv * 0.99;
          if (whole(further)) ground = further;
          else if (!whole(ground)) break;
          free++;
        }
        if (free * 0.7 * oa.ev > bestDamagingEv) return { ground: away, height: 0, dash: true };
      }
      // The same Dash a turn sooner, from outside the foe's reach, costs no Opportunity Attack at all: when this turn's
      // step and volley would leave the foe's Dash ending beside the creature, it Dashes now and shoots on the turns
      // after. The volleys are the same two in three rounds. A Scout (Speed 30) stepped away from an Archelon (Speed
      // 20) and shot until the Archelon's Dash reached it, then left through the Bite, three times in ten rounds (N07).
      const oaNext = cachedBestOaOption(evaluator, defender, attacker, foeReach, foeReach + stride);
      // Not a creature with a Bonus Action Disengage, which leaves reach for nothing once the foe arrives (a Goblin Minion).
      const slips = attacker.options.some((option, idx) => option.timing === "bonus" && option.action.kind === "selfbuff" && option.action.condition === "disengaged" && usable(state, idx, option));
      // And only a Dash that buys a volley: from where the foe's Dash leaves it, next turn's step must keep it out of the
      // foe's next Dash. Against a wall that stride never gains ground: a Horned Devil Dashed to the 120 ft cap, a
      // Tyrannosaurus Rex Dashed back to 20 feet, and neither attacked for 100 rounds (O01).
      // The volley must reach from there too: a Brass Dragon Wyrmling Dashed 110 feet from a Rug of Smothering with its
      // Fire Breath (20 ft) ready, and had to Dash back in to use it (O12).
      const landed = closestFoeReach(defender, foeState, away, gapAt(0), foeDash);
      const whole = (from: number): boolean => evaluator.bestRoutineEvAtDistance(attacker, defender, from) >= bestDamagingEv * 0.99;
      const nextSquare = whole(Math.min(engagement.maxDistance, landed + speed)) ? Math.min(engagement.maxDistance, landed + speed) : landed;
      // A walker that loses the exchange in the foe's reach (the foe kills it in fewer rounds) keeps the Dash, which
      // holds the foe off for the draw: a Centaur Trooper lost 172 of 200 to a Minotaur of Baphomet when it stood and
      // shot instead. A flier has height to shoot from (a Manticore won 196 of 200 there).
      const losing = !canFly(attacker, state) && evaluator.bestRoutineEvAtDistance(defender, attacker, foeReach, false) * foeState.hp > bestDamagingEv * state.hp;
      const buysVolley = losing || whole(nextSquare) && closestFoeReach(defender, foeState, nextSquare, gapAt(0), foeDash) > foeReach;
      if (!slips && !oa?.ev && oaNext && oaNext.ev > 0 && engagement.distance > foeReach && bestDamagingGround > engagement.ground && stride > foeDash && away - engagement.ground > speed
        && closestFoeReach(defender, foeState, bestDamagingGround, gapAt(0), foeSpeed) > foeReach
        && closestFoeReach(defender, foeState, bestDamagingGround, gapAt(0), foeDash) <= foeReach
        && landed > foeReach && buysVolley
        && answerEvAtDistance(defender, attacker, state, closestFoeReach(defender, foeState, bestDamagingGround, gapAt(0), foeSpeed), evaluator) <= 0
        && answerEvAtDistance(defender, attacker, state, landed, evaluator) <= 0) {
        return { ground: away, height: 0, dash: true };
      }
    }
    // A melee creature that a walk never brings into reach of a ranged foe as fast as itself, one that has just stepped
    // away from it (`withdrew`) and cannot fly off, Dashes once to close: from
    // there the foe's step away leaves it within a walk, and it attacks in melee every turn after. It gives up one turn
    // of a thrown attack worth less than half its melee routine. A Bugbear Warrior walked 30 feet behind a Gnoll
    // Warrior for ten rounds, throwing a Light Hammer at long range each turn.
    // An Adult Bronze Dragon (Speed 80) traded a Guiding Bolt for three Hurl Flames with a Horned Devil (Speed 60) that
    // kept 150 feet off, where one Dash put it beside the Devil for three Rends a turn.
    if (!probe && !frightened && !backOff && currentHeight === 0 && foeState.height === 0) {
      const reach = meleeReach(attacker);
      const foeWalk = nextTurnSpeed(defender, foeState);
      const dashGround = Math.max(Math.min(engagement.distance, groundFloor(attacker, state, 0, defender, foeState)), engagement.ground - (speed + currentSpeed(attacker, state)));
      if (bestDamagingDistance > reach && engagement.ground - speed > reach && dashGround <= reach
        && foeState.withdrew && dashGround + foeWalk <= reach + currentSpeed(attacker, state)
        // A foe that flies is followed by one that flies as fast; a slower foe is still out of a walk's reach this turn,
        // and each turn spent walking after it is a turn of the weaker attack (K14).
        // Only after a foe that fights from range by choice, its answer from there no weaker than from beside the
        // creature: one that is on its way in is waited for (an Ancient Silver Dragon that Dashed at a Pit Fiend instead
        // of breathing went from 248 wins of 400 to 164).
        && ((!canFly(defender, foeState) || (canFly(attacker, state) && speed >= foeWalk))
          && (foeWalk >= speed && !canFly(defender, foeState)
            || evaluator.bestRoutineEvAtDistance(defender, attacker, bestDamagingDistance, false) >= evaluator.bestRoutineEvAtDistance(defender, attacker, reach, false) * 0.6
              // Nor in place of a limited use that is ready now: the breath is made first.
              && !!choicesAt(bestDamagingDistance).damaging.routine?.parts.every((part) => attacker.options[part.optionIdx]?.uses.t === "atWill")))
        && evaluator.bestRoutineEvAtDistance(defender, attacker, reach + foeWalk, false) > 0
        && choicesAt(reach).damaging.ev > bestDamagingEv * 2) {
        return { ground: dashGround, height: 0, dash: true };
      }
    }
    // Damage decides where to move — unless a square that is safer to stand on buys a lock the damage
    // cannot. A flier with an at-will paralysing breath and a feeble bite used to leave the altitude
    // nothing could reach it at, to bite from beside a foe that then swung back: the Silver Dragon
    // Wyrmling lost every fight to a hybrid brute it wins 10–0 without its Rend. The comparison is the
    // same score both searches already use. It is gated on a lock that outlasts the foe's own turn,
    // because only that one pays back: the controller's next turn finds the foe still held, the
    // re-application is worth nothing, and this branch goes back to hitting it. A fear effect that lapses
    // before the wailing undead acts again, or a knockdown the foe stands up from, never gets that far — the
    // comparison without the gate hovered and re-applied them for a hundred rounds.
    if (bestFallbackEv > 0 && bestFallbackScore > bestDamagingScore && routineLocksFoe(bestFallbackRoutine, attacker, defender, foeState)) {
      return { ground: bestFallbackGround, height: bestFallbackHeight, routine: bestFallbackRoutine };
    }
    // Damage decides where to move, but control may still be the best action after arriving.
    // For example, a creature can stun a foe after closing into its melee threat range.
    if (backOff) return { ground: bestDamagingGround, height: bestDamagingHeight, routine: backOff.routine, via: backOff.via };
    const { any, damaging } = choicesAt(bestDamagingDistance);
    // The square was scored with the foe's answer weighed by the chance it is left standing (`foeStands`), so the
    // action taken there is weighed the same way: a self-buff priced on the whole of the foe's next turn does not
    // outbid the blow the creature came for. A Sprite that had shot a Mummy down to 4 hit points flew down to stab it,
    // cast Invisibility beside it instead, and died.
    const stands = foeState.hp > 0 ? 1 - Math.min(1, Math.max(0, damaging.ev / foeState.hp - 0.5)) : 1;
    if (stands < 1 && damaging.routine && any.routine && any.routine !== damaging.routine && damaging.ev > any.ev * stands
      && any.routine.parts.every((part) => !evaluator.makesLethalProgress(attacker.options[part.optionIdx].action, attacker, defender))) {
      return { ground: bestDamagingGround, height: bestDamagingHeight, routine: damaging.routine };
    }
    return { ground: bestDamagingGround, height: bestDamagingHeight, routine: any.routine };
  }
  // Charmed by its foe with nothing else to do ("You can't attack the charmer or target the charmer with damaging
  // abilities"): it stands where it would fight from once the charm ends, and does not walk up to a foe it means to
  // shoot. A Bandit Captain Charmed for a turn by a Pirate walked from 20 feet to 5, Dodged, and paid an Opportunity
  // Attack to step back and fire its Pistol.
  if (!frightened && bestFallbackEv <= 0 && hasCondition(state, "charmed")) {
    const free: FighterState = { ...state, conditions: state.conditions.filter((c) => c.name !== "charmed") };
    const uncharmed: LegendaryMoveProbe = { speed: movementSpeed(attacker, state), noProvoke: false };
    chooseMovementAndRoutine(attacker, defender, free, foeState, source, engagement, evaluator, lookahead, uncharmed);
    // Only a square it would have something to do from: with the foe out of range of everything, the Dash below closes.
    if (uncharmed.result && bestUsableRoutinesAtDistance(attacker, defender, free, foeState, source,
      Math.max(uncharmed.result.ground, gapAt(uncharmed.result.height)), evaluator).any.ev > 0) {
      return { ground: uncharmed.result.ground, height: uncharmed.result.height };
    }
  }
  // No reachable position makes lethal progress. Closing could bring a damaging option online,
  // but committing is only right if arriving is actually better than holding at range: a fragile
  // controller must not charge into a melee it cannot survive just because it owns a weak attack.
  // Value each approach at the distance where its option comes online, discounted by the threat
  // waiting there, and compare against simply standing off with control.
  // Fear bars the approach outright, so the whole "is closing worth it?" search is skipped.
  let bestApproachScore = -Infinity;
  for (const [optionIdx, option] of frightened ? [] : [...attacker.options.entries()]) {
    if (!usable(state, optionIdx, option)) continue;
    if (!actionRequirementMet(option.action, foeState, source)) continue;
    const visibleRange = sightRange(eyes(attacker, state), hasCondition(state, "blinded"), unseenBy(foeState, attacker));
    const pointRange = sightRange(attacker, hasCondition(state, "blinded"), false);
    if (!actionCanMakeProgressCloser(option.action, defender, engagement.distance, visibleRange, attacker, pointRange)) continue;
    const arrival = actionTargetRange(option.action, visibleRange, pointRange);
    if (!actionTargetable(option.action, attacker, defender, arrival, foeState, state)) continue;
    const arrivalEv = choicesAt(arrival).damaging.ev;
    if (arrivalEv <= 0) continue;
    const threat = threatAt(arrival);
    const arrivalThreat = evaluator.bestRoutineEvAtDistance(defender, attacker, arrival, false) * foeThreatFactor
      + threat.aura
      + threat.sourceTurnAura
      + threat.retaliation
      + threat.rebuke
      + threat.approachRebuke;
    bestApproachScore = Math.max(bestApproachScore, arrivalEv - arrivalThreat * 0.7);
  }
  if (bestApproachScore > bestFallbackScore) {
    const ground = Math.max(candidates[0] ?? engagement.ground, Math.min(engagement.distance, groundFloor(attacker, state, closingHeight, defender, foeState)));
    // Unreachable while frightened: the approach loop above is skipped entirely.
    const fallback = choicesAt(Math.max(ground, gapAt(closingHeight))).any;
    // Not when one Dash catches the foe for good and the action it replaces deals nothing: from beside it the foe's
    // step away leaves it within a walk, and the creature attacks every turn after (the pursuit Dash above, for a
    // creature with no damage at all from range). Only after a foe that fights from where it stands, and not in place
    // of a lock. A Guardian Naga walked 40 feet behind a Spirit Naga, immune to its Poisonous Spittle, and spat twice a
    // round for the Blinded rider, never within its Bite's 10 feet (L15).
    const dashGround = Math.max(Math.min(engagement.distance, groundFloor(attacker, state, 0, defender, foeState)), engagement.ground - (speed + currentSpeed(attacker, state)));
    const catches = currentHeight === 0 && closingHeight === 0 && foeState.height === 0 && engagement.ground - speed > meleeReach(attacker)
      && dashGround <= meleeReach(attacker) && dashGround + nextTurnSpeed(defender, foeState) <= meleeReach(attacker) + currentSpeed(attacker, state)
      && (!canFly(defender, foeState) || (canFly(attacker, state) && speed >= nextTurnSpeed(defender, foeState)))
      && evaluator.bestRoutineEvAtDistance(defender, attacker, engagement.distance, false) > 0
      && choicesAt(meleeReach(attacker)).damaging.ev > 0 && !routineLocksFoe(fallback.routine, attacker, defender, foeState)
      // The action given up is one whose printed damage this foe takes none of, kept for its rider: not a self-buff
      // or a hold cast on the way in.
      && !!fallback.routine?.parts.every((part) => {
        const action = attacker.options[part.optionIdx]?.action;
        return !!action && "damage" in action && !!action.damage?.length && evaluator.expectedActionDamage(action, attacker, defender) <= 0;
      });
    if (catches) return { ground: dashGround, height: 0, dash: true, catches: true };
    // Keep a useful control action while advancing. If nothing can be done this turn,
    // preserve the existing Dash behavior so a melee chaser can still catch a kiter.
    if (fallback.ev > 0) return { ground, height: closingHeight, routine: fallback.routine };
    // A jump usable from where it stands is already priced against the Dash it would replace (`teleportEv`'s baseline),
    // so one worth anything is taken instead of the Dash.
    const jump = choicesAt(engagement.distance).any;
    // So is Fly, cast to reach a foe in the air: its price is the offence closing gives back, and the movement it
    // leaves is spent after the cast.
    const closes = (action: CombatAction | undefined): boolean => action?.kind === "teleport" || (action?.kind === "selfbuff" && !!action.fly);
    if (jump.ev > 0 && jump.routine?.parts.every((part) => closes(attacker.options[part.optionIdx]?.action))) {
      return { ground: engagement.ground, height: currentHeight, routine: jump.routine };
    }
    return { ground: Math.max(Math.min(engagement.distance, groundFloor(attacker, state, closingHeight, defender, foeState)), engagement.ground - (speed + currentSpeed(attacker, state))), height: closingHeight, dash: true };
  }
  // Nothing usable within normal movement: Dash toward the foe at double speed — unless fear
  // bars the approach, in which case the creature stands its ground and does nothing.
  if (bestFallbackEv <= 0) {
    return frightened
      ? { ground: engagement.ground, height: holdHeight }
      : { ground: Math.max(Math.min(engagement.distance, groundFloor(attacker, state, closingHeight, defender, foeState)), engagement.ground - (speed + currentSpeed(attacker, state))), height: closingHeight, dash: true };
  }
  return { ground: bestFallbackGround, height: bestFallbackHeight, routine: bestFallbackRoutine };
}

/**
 * Break a grapple by teleporting rather than by rolling for it. Runs before the escape
 * attempt because a jump is not a contest: there is nothing to fail. A bonus-action teleport
 * (Misty Step, or a trait that does the same) is preferred over an action one because it frees the
 * creature *and* leaves it its attack, which is the whole reason those options are worth
 * printing on a stat block.
 *
 * Returns the timing spent, so the caller knows whether the action survived.
 */
function teleportEscapeStep(
  actorBlock: CombatStatblock,
  foeBlock: CombatStatblock,
  actorState: FighterState,
  foeState: FighterState,
  rng: () => number,
  actor: 0 | 1,
  engagement: EngagementState,
  log: FightLog,
  evaluator: PairEvaluator,
): Timing | undefined {
  const held = actorState.conditions.some(teleportFreesHold);
  if (!held || teleportBlocked(actorState)) return undefined;
  // Cheapest adequate escape first: a bonus action beats an action because it keeps the
  // attack, and an at-will beats a limited use because a grapple can be reapplied every
  // round and a 2/day spell cannot answer it every round.
  const rank = (option: ActionOption): number =>
    (option.timing === "bonus" ? 0 : 2) + (option.uses.t === "atWill" ? 0 : 1);
  let bestIdx = -1;
  let bestTiming: Timing | undefined;
  let bestRank = Infinity;
  // A teleport that takes the action is the turn's attacks given up, as an escape roll is, and is priced the same way
  // without the roll: against a hold the foe puts straight back it buys nothing. A Nalfeshnee held by a Remorhaz at
  // 19 Hit Points teleported 5 feet away five turns running, was bitten and held again each time, and never used a
  // Rend (L02).
  let actionPays: boolean | undefined;
  actorBlock.options.forEach((option, idx) => {
    if (option.timing !== "action" && option.timing !== "bonus") return;
    if (!usable(actorState, idx, option) || !actionTeleport(option.action)) return;
    if (option.timing === "action" && !(actionPays ??= escapeWorthwhile(actorBlock, foeBlock, actorState, foeState, engagement, evaluator, true))) return;
    const score = rank(option);
    if (score >= bestRank) return;
    bestIdx = idx;
    bestTiming = option.timing;
    bestRank = score;
  });
  if (bestIdx < 0 || !bestTiming) return undefined;
  const option = actorBlock.options[bestIdx];
  spend(actorState, bestIdx, option);
  if (log.on) log.push(`${actorBlock.name} uses ${bestTiming === "bonus" ? "bonus action " : ""}${option.name} to break free`);
  resolveOptionWithTeleport(actorBlock, foeBlock, actorState, foeState, option.action, rng, actor, engagement, log, evaluator);
  settleAfterAction(actorBlock, foeBlock, actorState, foeState, actor, engagement, rng, log);
  rollDepletion(actorState, bestIdx, option, rng, log);
  return bestTiming;
}

/**
 * Standing up costs half the creature's Speed, and needs some Speed to spend. Returns true when it stood.
 * A Prone creature that cannot stand (`cannotStand`) crawls instead: "Your only movement options are to crawl or to …
 * right yourself", and crawling costs 1 extra foot per foot (SRD 5.2.1), so its Speed buys half the ground. The crawl is
 * a state of the turn (`FighterState.crawling`) that halves the Speed every reader sees (`currentSpeed`): the movement
 * chooser's squares, the move, a Dash's second Speed, a forced flight.
 */
/**
 * "The possession lasts until the body drops to 0 Hit Points or the ghost leaves as a Bonus Action." A possessor whose
 * attacks cannot damage the body (it is immune to all of them) can never end the possession the first way, so it
 * leaves; otherwise it stays in until the body drops.
 */
function leaveBodyIfUseless(block: CombatStatblock, foe: CombatStatblock, state: FighterState, foeState: FighterState, actor: 0 | 1, log: FightLog): void {
  if (!state.possessing || state.bonusSlotUsed) return;
  if (block.options.some((option) => option.action.kind === "attack" && expectedDamage(option.action.damage, foe, option.action.magical) > 0)) return;
  foeState.conditions = foeState.conditions.filter((c) => !(c.possession && c.source === actor));
  pruneLinkedConditions(foeState);
  state.possessing = false;
  state.bonusSlotUsed = true;
  if (log.on) log.push(`${block.name} leaves ${foe.name}'s body (Bonus Action)`);
  noteEndedEffects(foeState, log, foe);
}

/**
 * Mirror Image, on an attack roll that has hit: "roll a d6 for each of your remaining duplicates. If any of the d6s rolls
 * a 3 or higher, one of the duplicates is hit instead of you, and the duplicate is destroyed. ... The spell ends when
 * all three duplicates are destroyed. A creature is unaffected by this spell if it has the Blinded condition,
 * Blindsight, or Truesight."
 */
function duplicateHit(attacker: CombatStatblock, defender: CombatStatblock, aState: FighterState, dState: FighterState, distance: number, rng: () => number, log: FightLog): boolean {
  const images = dState.conditions.find((c) => (c.images ?? 0) > 0);
  if (!images || hasCondition(aState, "blinded") || seesInvisible(eyes(attacker, aState), false, distance)) return false;
  let any = false;
  for (let i = 0; i < images.images!; i++) if (d20ForDie(6, rng) >= 3) any = true;
  if (!any) return false;
  images.images!--;
  if (log.on) log.push(`${attacker.name} hits a duplicate of ${defender.name} (${images.images} left)`);
  if (images.images === 0) {
    dState.conditions = dState.conditions.filter((c) => c !== images);
    pruneLinkedConditions(dState);
  }
  return true;
}

/**
 * A printed Leap made upward at a foe in the air. "The lamia jumps up to 30 feet by spending 10 feet of movement" names
 * no direction, and "When you jump, you make either a Long Jump (horizontal) or a High Jump (vertical)" (SRD 5.2.1,
 * p184): the creature walks under the foe, jumps to where its attacks reach, makes them, and falls ("1d6 Bludgeoning
 * damage for every 10 feet it fell", landing Prone if it took any). Taken only by a creature with no Fly Speed and
 * nothing else to do with its action, when the attacks are worth more than the fall and the fall cannot drop it.
 */
function leapUpPlan(block: CombatStatblock, foe: CombatStatblock, state: FighterState, foeState: FighterState, source: 0 | 1, engagement: EngagementState, evaluator: PairEvaluator): { ground: number; height: number; optionIdx: number; routine: Routine } | undefined {
  if (state.bonusSlotUsed || state.height > 0 || canFly(block, state) || isFrightened(state) || isProne(state) || carriesTarget(foeState, source)) return undefined;
  if (state.conditions.some((c) => c.noBonusActions || c.moveOrAct || c.actionOrBonus)) return undefined;
  const gap = verticalGap(block, 0, foe, foeState.height);
  if (gap <= 0) return undefined;
  const walk = movementSpeed(block, state);
  let best: { ground: number; height: number; optionIdx: number; routine: Routine; ev: number } | undefined;
  block.options.forEach((option, optionIdx) => {
    const move = option.action.kind === "selfbuff" ? option.action.movement : undefined;
    if (option.timing !== "bonus" || move?.mode !== "leap" || !usable(state, optionIdx, option) || walk < (move.cost ?? 0)) return;
    const floor = groundFloor(block, state, 0, foe, foeState);
    // What reaches from the top of the jump: a melee attack, or a jump into the target's space (a Bulette's Deadly Leap).
    for (const reach of new Set(block.options.map((o) => o.action.kind === "save" && o.action.jumpsToTarget ? o.action.range : oaAttackReach(o.action)).filter((r): r is number => r !== undefined))) {
      const rise = gap - reach;
      const ground = Math.max(floor, Math.min(engagement.ground, reach));
      if (rise <= 0 || rise > (move.distance ?? 0) || ground > reach || engagement.ground - ground > walk - (move.cost ?? 0)) continue;
      const dice = Math.min(20, Math.floor(rise / 10));
      if (dice * 6 >= state.hp) continue;
      const choice = bestUsableRoutinesAtDistance(block, foe, state, foeState, source, separation(block, rise, foe, foeState.height, ground), evaluator, state.movedToward).any;
      if (!choice.routine || choice.ev <= dice * 3.5 || best && best.ev - Math.floor(best.height / 10) * 3.5 >= choice.ev - dice * 3.5) continue;
      best = { ground, height: rise, optionIdx, routine: choice.routine, ev: choice.ev };
    }
  });
  return best;
}

function standIfProne(actorBlock: CombatStatblock, actorState: FighterState, log: FightLog): boolean {
  const speed = movementSpeed(actorBlock, actorState);
  if (speed <= 0) return false;
  if (isProne(actorState) && cannotStand(actorState)) {
    if (!actorState.crawling) {
      actorState.crawling = true;
      if (log.on) log.push(`${actorBlock.name} cannot stand and crawls (${movementSpeed(actorBlock, actorState)} ft of movement)`);
    }
    return false;
  }
  if (!hasCondition(actorState, "prone")) return false;
  actorState.conditions = actorState.conditions.filter((c) => c.name !== "prone");
  pruneLinkedConditions(actorState);
  actorState.movementPenalty = standCost(actorBlock, actorState);
  if (log.on) log.push(`${actorBlock.name} spends half its Speed to stand`);
  return true;
}

/**
 * Removes the timed copies (`endsSourceTurn`) the actor gave its foe whose time is up, as the actor's turn starts and after
 * `startTurn` has counted it: a charm lasting 1 minute, applied on the source's turn, ends as its
 * tenth later turn begins, so the target loses ten of its own turns. What rides on the copy goes with it.
 */
function expireClockedConditions(actorBlock: CombatStatblock, foeBlock: CombatStatblock, actorState: FighterState, foeState: FighterState, actor: 0 | 1, log: FightLog): void {
  // Its own timed spell on itself (Mirror Image's minute) runs out the same way.
  const own = actorState.conditions.filter((c) => c.source === actor && c.endsSourceTurn !== undefined && actorState.turnCount >= c.endsSourceTurn);
  if (own.length) {
    actorState.conditions = actorState.conditions.filter((c) => !own.includes(c));
    pruneLinkedConditions(actorState);
    if (log.on) log.push(`${actorBlock.name} is no longer ${[...new Set(own.map((c) => c.name))].join(" or ")} (the effect reaches the end of its duration)`);
  }
  const expired = foeState.conditions.filter((c) => c.source === actor && c.endsSourceTurn !== undefined && actorState.turnCount >= c.endsSourceTurn);
  if (!expired.length) return;
  foeState.conditions = foeState.conditions.filter((c) => !expired.includes(c));
  pruneLinkedConditions(foeState);
  if (log.on) log.push(`${foeBlock.name} is no longer ${[...new Set(expired.map((c) => c.name))].join(" or ")} (${actorBlock.name}'s effect reaches the end of its duration)`);
}

/**
 * A creature sent out of play until the start of its banisher's turn "reappears in an unoccupied space of the
 * [banisher]'s choice within 120 feet": the banisher sets the ground between them. It chooses as it would choose a
 * square of its own, by the turn's square search run as a free move of that many feet along the ground at its present
 * altitude (the pair's separation is all a duel's geometry holds), and the creature keeps its altitude. A search that
 * finds nothing better leaves it where it was, which is a space the banisher may choose. A pair bound by a hold or a
 * swallow is left alone.
 */
function reappear(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, engagement: EngagementState, evaluator: PairEvaluator, lookahead: boolean, within: number, log: FightLog): void {
  const foe = actor === 0 ? 1 : 0;
  if (isDown(blocks[actor], states[actor]) || isDown(blocks[foe], states[foe])) return;
  if (states.some((s) => s.conditions.some((c) => c.name === "swallowed" || c.holdReach !== undefined || c.duration === "untilEscape"))) return;
  if (verticalGap(blocks[actor], states[actor].height, blocks[foe], states[foe].height) > within) return;
  const probe: LegendaryMoveProbe = { speed: within, noProvoke: true, groundOnly: true };
  chooseMovementAndRoutine(blocks[actor], blocks[foe], states[actor], states[foe], actor, engagement, evaluator, lookahead, probe);
  if (!probe.result || probe.result.gain <= 0) return;
  const ground = Math.min(within, engagement.maxDistance, Math.max(groundFloor(blocks[actor], states[actor], states[actor].height, blocks[foe], states[foe]), probe.result.ground));
  if (ground === engagement.ground) return;
  const from = engagement.distance;
  engagement.ground = ground;
  engagement.distance = separation(blocks[actor], states[actor].height, blocks[foe], states[foe].height, ground);
  if (log.on) log.push(`${blocks[foe].name} reappears where ${blocks[actor].name} chooses (${from} ft -> ${engagement.distance} ft)`);
}

function takeTurn(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, rng: () => number, engagement: EngagementState, log: FightLog, evaluator: PairEvaluator, lookahead = true): void {
  states[actor].ownTurn = true;
  const logged = log.lines.length;
  takeTurnSteps(blocks, states, actor, rng, engagement, log, evaluator, lookahead);
  // A turn that left no line (nothing in reach or range, and nowhere better to stand) says so.
  if (log.on && log.lines.length === logged && !isDown(blocks[actor], states[actor])) log.push(`${blocks[actor].name} does nothing on its turn`);
  states[actor].ownTurn = false;
  // A run-up is spent on the creature's own turn (it moves and then hits on the same turn). An opportunity attack or a
  // Legendary action on another creature's turn follows no move of its own,
  // so the run-up ends with the turn, on every exit of it.
  states[actor].movedToward = 0;
  states[actor].runUpSpent = 0;
}

/**
 * "The grappler can release the target at any time (no action required)" (Grappled, p. 182). A grappler whose hold bars
 * one of its own attacks ("can't be targeted by the crocodile's Tail") lets go at the start of its turn when the routine
 * that opens up is worth more than the one the hold leaves it, that routine takes the hold again, and the gain covers
 * what the foe's attacks get back while it is free. A Giant Crocodile kept its bite on and made one attack a turn.
 */
function releaseForBarredAttack(attacker: CombatStatblock, defender: CombatStatblock, state: FighterState, foeState: FighterState, source: 0 | 1, engagement: EngagementState, evaluator: PairEvaluator, log: FightLog): void {
  const held = foeState.conditions.filter((c) => c.source === source && c.heldBy === "grapple");
  if (!held.length || hasCondition(foeState, "swallowed")) return;
  const names = new Set(held.map((c) => c.name));
  const barred = (action: CombatAction): boolean => "requiresTargetMissingConditions" in action && !!action.requiresTargetMissingConditions?.some((name) => names.has(name));
  if (!attacker.options.some((option) => barred(option.action))) return;
  const free: FighterState = { ...foeState, conditions: foeState.conditions.filter((c) => !held.includes(c)) };
  pruneLinkedConditions(free);
  const distance = engagement.distance;
  const kept = bestUsableRoutinesAtDistance(attacker, defender, state, foeState, source, distance, evaluator).any;
  const open = bestUsableRoutinesAtDistance(attacker, defender, state, free, source, distance, evaluator).any;
  const retakes = !!open.routine?.parts.some((part) => {
    const action = attacker.options[part.optionIdx].action;
    // The hold must come back from an attack the hold never barred: an action that is
    // both (the rug's Smother) would only trade a hold it has for a save to get it again.
    return !barred(action) && "riders" in action && !!action.riders?.some((rider) => rider.condition === "grappled");
  });
  if (!retakes || !open.routine?.parts.some((part) => barred(attacker.options[part.optionIdx].action))) return;
  const foeGain = evaluator.bestRoutineEvAtDistance(defender, attacker, distance, false) * (1 - DISADVANTAGE_EV) * 0.5;
  if (open.ev <= kept.ev + foeGain) return;
  foeState.conditions = free.conditions;
  if (log.on) log.push(`${attacker.name} lets go of ${defender.name}`);
}

/**
 * The turn of a creature under its foe's control (`controlled`). The controller sets it up for its own attacks: the
 * creature gives up what it holds against the controller (its Concentration, its grapple), walks up to it with its
 * Speed, landing if it flies, and once within 5 feet drops Prone, where attacks from that close have Advantage on it. It
 * takes no action, and does not try to get free of a hold.
 */
function controlledTurn(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, engagement: EngagementState, rng: () => number, log: FightLog, evaluator: PairEvaluator): void {
  const foe: 0 | 1 = actor === 0 ? 1 : 0;
  const actorBlock = blocks[actor], foeBlock = blocks[foe], actorState = states[actor], foeState = states[foe];
  if (log.on) log.push(`${actorBlock.name} is under ${foeBlock.name}'s control`);
  endConcentration(actor, actorState, foeState, actorBlock, log);
  const held = foeState.conditions.filter((c) => c.source === actor && c.heldBy === "grapple");
  if (held.length) {
    foeState.conditions = foeState.conditions.filter((c) => !held.includes(c));
    pruneLinkedConditions(foeState);
    if (log.on) log.push(`${actorBlock.name} lets go of ${foeBlock.name}`);
  }
  const beside = Math.max(5, groundFloor(actorBlock, actorState, foeState.height, foeBlock, foeState));
  if (engagement.ground > beside || actorState.height !== foeState.height) {
    standIfProne(actorBlock, actorState, log);
    if (movementSpeed(actorBlock, actorState) > 0) {
      applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, beside, foeState.height, rng, log, evaluator, "is walked to its controller", true);
    }
  }
  if (isDown(actorBlock, actorState) || !controlled(actorState)) return;
  if (engagement.distance <= 5 && !isProne(actorState) && !actorBlock.conditionImmune.includes("prone")) {
    actorState.conditions.push({ name: "prone", duration: "permanent", source: foe, appliedTurn: actorState.turnCount });
    if (log.on) log.push(`${actorBlock.name} drops Prone beside ${foeBlock.name}`);
    settleFlight(blocks, states, engagement, rng, log);
    settleDeathBursts(blocks, states, engagement, rng, log);
  }
}

/**
 * The attack a Multiattack part stands in for ("It can replace one attack with a use of ..."), when the part deals no
 * damage and one hit of that attack should now drop the foe: the replacement was chosen against the foe as it stood
 * before the routine's other attacks landed. A Young Silver Dragon whose two Rends left a Guard Captain at 3 Hit Points
 * used its Paralyzing Breath on it. Not against a regenerator, which a hit that drops it does not finish (a Shambling
 * Mound's Engulf on a Troll Limb).
 */
function finishingAttack(routine: Routine, part: Routine["parts"][number], attacker: CombatStatblock, defender: CombatStatblock, state: FighterState, foeState: FighterState, distance: number, evaluator: PairEvaluator): number | undefined {
  if (defender.regeneration || !part.replacesAttack || evaluator.expectedActionDamage(attacker.options[part.optionIdx].action, attacker, defender) > 0) return undefined;
  return routine.parts.find((other) => {
    const option = attacker.options[other.optionIdx];
    return !other.replacesAttack && option?.action.kind === "attack" && usable(state, other.optionIdx, option) && actionInRange(option.action, distance)
      && evaluator.expectedActionDamage(option.action, attacker, defender) >= foeState.hp;
  })?.optionIdx;
}

function takeTurnSteps(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, rng: () => number, engagement: EngagementState, log: FightLog, evaluator: PairEvaluator, lookahead = true): void {
  for (const state of states) { state.headTurnDamage = 0; state.headLostThisTurn = false; }
  const foe = actor === 0 ? 1 : 0;
  for (const idx of [0, 1] as const) if (states[idx].possessing) states[idx].possessing = states[idx === 0 ? 1 : 0].conditions.some((c) => c.possession && c.source === idx);
  const actorBlock = blocks[actor];
  const foeBlock = blocks[foe];
  const actorState = states[actor];
  const foeState = states[foe];
  // A creature that changes into its successor form on its own turn: the old form's routine ends at the change, and the
  // new form first acts on its next turn (the same rule as the routine's down guard). The
  // new form takes no action, no Bonus Action and none of the old form's movement this turn; the turn still ends
  // (`endTurn`). Its reaction is its own from the change.
  const form = actorState.formChanges;
  const newFormEndsTurn = (): boolean => {
    if (actorState.formChanges === form) return false;
    if (log.on) log.push(`${actorBlock.name} appeared this turn and does not act`);
    endTurn(blocks, states, actor, engagement, rng, log);
    actorState.tookDamageSinceTurnEnd = false;
    return true;
  };
  // "Simultaneous Effects": "if two effects occur at the start of a player character's turn, the player decides which of
  // the effects happens first". A condition that ends at the start of this turn and a Reaction this turn's start triggers
  // are two such effects, and the order is the actor's: the foe's turn-start gaze is taken only if it could also have
  // been taken before those conditions ended (the foe able to react, each still seeing the other).
  const gaze = foeBlock.reaction?.turnStart;
  const gazeOpenBeforeLapse = !!gaze && !foeState.conditions.some((c) => c.noReactions) && !hasAny(foeState, RULES_INCAPACITATED) && !controlled(foeState)
    && canSee(foeBlock, actorState, foeState, engagement.distance)
    && canSee(actorBlock, foeState, actorState, engagement.distance);
  const reappearWithin = foeState.conditions.find((c) => c.duration === "startOfSourceNextTurn" && c.source === actor && c.reappearWithin !== undefined)?.reappearWithin;
  states[0].conditions = states[0].conditions.filter((c) => !(c.duration === "startOfSourceNextTurn" && c.source === actor));
  states[1].conditions = states[1].conditions.filter((c) => !(c.duration === "startOfSourceNextTurn" && c.source === actor));
  pruneLinkedConditions(states[0]);
  pruneLinkedConditions(states[1]);
  if (reappearWithin !== undefined) reappear(blocks, states, actor, engagement, evaluator, lookahead, reappearWithin, log);
  resolveDelayedConditions(blocks, states, actor, log);
  // A new turn: the one spell slot a turn allows is available again to both creatures.
  states[0].spellSlotSpent = false;
  states[1].spellSlotSpent = false;
  // And so is every once-per-turn effect ("only once per turn": any creature's turn), to both creatures.
  states[0].perTurnUsed.clear();
  states[1].perTurnUsed.clear();
  startTurn(actorBlock, actorState, rng, log);
  // "One Reaction on every turn of combat" (`reactionEveryTurn`): the foe's Reaction is back for this turn too.
  if (foeBlock.reactionEveryTurn) foeState.reactionUsed = false;
  settleEmanationSpeed(states, actor, engagement.distance);
  // "Until the start of its next turn" ends here, before anything this turn reads the actor's conditions:
  // an aura that stunned it at the start of its last turn rolls again against a creature no longer
  // stunned, and a stun from the source's turn never costs it this one.
  const lapsed = actorState.conditions.filter((c) => c.duration === "startOfTargetNextTurn" && actorState.turnCount > c.appliedTurn);
  if (lapsed.length) {
    actorState.conditions = actorState.conditions.filter((c) => !lapsed.includes(c));
    pruneLinkedConditions(actorState);
    if (log.on) log.push(`${actorBlock.name} is no longer ${[...new Set(lapsed.map((c) => c.name))].join(" or ")}`);
  }
  // A timed condition this creature gave its foe (a charm lasting 1 minute) runs out the same way: at
  // the point in the round it landed, ten of the source's turns later (`Rider.rounds`).
  expireClockedConditions(actorBlock, foeBlock, actorState, foeState, actor, log);
  if (gaze && gazeOpenBeforeLapse && !isDown(foeBlock, foeState) && reactionAvailable(foeBlock, foeState)
    && actionInRange(gaze, engagement.distance) && !successImmune(actorState, gaze.immuneOnSuccess)
    && !actorBlock.conditionImmune.includes("frightened")
    && canSee(foeBlock, actorState, foeState, engagement.distance)
    && canSee(actorBlock, foeState, actorState, engagement.distance)) {
    spendReaction(foeBlock, foeState);
    if (log.on) log.push(`${foeBlock.name} uses Unnerving Gaze`);
    resolveAction(foeBlock, actorBlock, foeState, actorState, gaze, rng, foe, engagement.distance, log);
  }
  // A Concentration spell's duration runs out at the point in the round it was cast: a minute is ten of
  // the caster's turns. Checked before anything else the turn does, so the spell is gone when it acts.
  if (actorState.concentrating && actorState.concentrationEndsTurn !== undefined && actorState.turnCount >= actorState.concentrationEndsTurn) {
    if (log.on) log.push(`${actorBlock.name}'s spell reaches the end of its duration`);
    endConcentration(actor, actorState, foeState, actorBlock, log);
  }
  settleDeathBursts(blocks, states, engagement, rng, log);
  // Anyone grounded by a stun or a knockdown drops before the turn resolves.
  settleFlight(blocks, states, engagement, rng, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
  if (isDown(actorBlock, actorState) || isDown(foeBlock, foeState)) return;
  resolveConditionDamage(blocks, states, actor, "start", rng, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
  if (isDown(actorBlock, actorState)) return;
  // A proximity aura triggers on the affected creature's turn, before it acts.
  resolveAura(blocks, states, actor, engagement.distance, rng, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
  // And the mirror image: an emanation the actor itself owns, on the half of the family whose
  // prose puts it at the start of the owner's turn (Barbed Hide and similar auras).
  resolveSourceTurnAura(blocks, states, actor, "start", engagement.distance, rng, log);
  // Both the start-of-turn tick above and the aura deal damage without going through an action,
  // so their rebukes are settled here rather than by `settleAfterAction`.
  settleDeathBursts(blocks, states, engagement, rng, log);
  settleSprayAndRebukes(blocks, states, engagement, rng, log); // the start of a turn
  settleDeathBursts(blocks, states, engagement, rng, log);
  settleFlight(blocks, states, engagement, rng, log);
  settleDeathBursts(blocks, states, engagement, rng, log);
  if (isDown(actorBlock, actorState)) return;
  // A form that appeared at the start of this turn (a start-of-turn tick or an aura dropped the old one) does not move or
  // act on it.
  if (newFormEndsTurn()) return;
  // An owner-turn emanation can finish the fight before its owner acts; there is nothing left
  // for the rest of the turn to do, and the fight loop reads the result on the way out. Gated on
  // the field rather than asked of every creature: without it a Barbed Devil whose Barbed Hide
  // just killed its captive would walk on and draw an opportunity attack from a corpse, and with
  // it unguarded the turn structure would change for the 1,128 creatures this stage cannot reach.
  if (actorBlock.sourceTurnAura && isDown(foeBlock, foeState)) return;
  if (hasCondition(actorState, "gibbering")) {
    const result = d20ForDie(8, rng);
    if (log.on) log.push(`${actorBlock.name} rolls Gibbering ${result}`);
    if (result >= 5 && result <= 6) {
      const speed = movementSpeed(actorBlock, actorState);
      const away = rng() < 0.5;
      applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement,
        away ? Math.min(engagement.maxDistance, engagement.ground + speed) : Math.max(5, engagement.ground - speed),
        actorState.height, rng, log, evaluator, "wanders", false, speed);
    } else if (result >= 7) {
      // "a melee attack against a randomly determined creature within its reach": reach, not a thrown weapon's range.
      const melee = actorBlock.options.find(o => o.action.kind === "attack" && o.action.melee && engagement.distance <= (o.action.reach ?? 5));
      if (melee) resolveOptionWithTeleport(actorBlock, foeBlock, actorState, foeState, melee.action, rng, actor, engagement, log, evaluator);
    }
    endTurn(blocks, states, actor, engagement, rng, log);
    return;
  }
  // Confusion's table, rolled at the start of each of the holder's turns. 1: no action, all its movement in a random
  // direction (d4; on the duel's axis one face closes, one opens, two move sideways). 2-6: nothing. 7-8: no movement and
  // one melee attack against a random creature within reach, which in a duel is the caster. 9-10: an ordinary turn.
  if (hasCondition(actorState, "confused")) {
    const result = d20ForDie(10, rng);
    if (log.on) log.push(`${actorBlock.name} rolls Confusion ${result}`);
    if (result <= 8) {
      if (result === 1) {
        const speed = movementSpeed(actorBlock, actorState), direction = d20ForDie(4, rng);
        const to = direction === 1 ? Math.max(5, engagement.ground - speed)
          : Math.min(engagement.maxDistance, direction === 2 ? engagement.ground + speed : Math.round(Math.hypot(engagement.ground, speed) / 5) * 5);
        applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, to, actorState.height, rng, log, evaluator, "wanders", false, speed);
      } else if (result >= 7) {
        const melee = actorBlock.options.find(o => o.timing === "action" && o.action.kind === "attack" && o.action.melee && engagement.distance <= (o.action.reach ?? 5));
        if (melee) resolveOptionWithTeleport(actorBlock, foeBlock, actorState, foeState, melee.action, rng, actor, engagement, log, evaluator);
      }
      endTurn(blocks, states, actor, engagement, rng, log);
      return;
    }
  }
  if (hasCondition(actorState, "commandedGrovel")) {
    actorState.conditions = actorState.conditions.filter((c) => c.name !== "commandedGrovel");
    pruneLinkedConditions(actorState);
    // "The target has the Prone condition and then ends its turn": a creature immune to Prone only ends its turn.
    const grovels = !actorBlock.conditionImmune.includes("prone");
    if (grovels) {
      actorState.conditions.push({
        name: "prone",
        duration: "permanent",
        source: foe,
        appliedTurn: actorState.turnCount,
      });
    }
    if (log.on) log.push(grovels ? `${actorBlock.name} obeys Command, falls Prone, and ends its turn` : `${actorBlock.name} obeys Command and ends its turn`);
    settleFlight(blocks, states, engagement, rng, log);
    settleDeathBursts(blocks, states, engagement, rng, log);
    endTurn(blocks, states, actor, engagement, rng, log);
    return;
  }
  // Fear: "takes the Dash action and moves away from you ... on each of its turns unless there is nowhere to move". Against
  // the wall the Dash is not forced and the creature has its turn, still Frightened.
  const corneredByFear = hasCondition(actorState, "fearSpell") && !hasCondition(actorState, "suggested")
    && engagement.ground >= engagement.maxDistance;
  if (!corneredByFear && (hasCondition(actorState, "fearSpell") || hasCondition(actorState, "suggested"))) {
    // A Prone creature stands before it flees if it can, for half its Speed out of the flight's two Speeds; one that
    // cannot stand crawls away (`standIfProne`).
    const stood = standIfProne(actorBlock, actorState, log);
    const speed = movementSpeed(actorBlock, actorState);
    const budget = speed * 2 + (stood ? standCost(actorBlock, actorState) : 0);
    // Forced flight is horizontal: altitude is a tactical choice, and a panicked creature
    // isn't making one.
    const target = Math.min(engagement.maxDistance, engagement.ground + budget);
    const label = hasCondition(actorState, "fearSpell") ? "flees in fear" : "follows the Suggestion and flees";
    applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, target, actorState.height, rng, log, evaluator, label, false, budget, false, 2);
    endTurn(blocks, states, actor, engagement, rng, log);
    return;
  }
  // "Under its control while within 60 feet of it" (`Rider.controlRange`): the controller decides what the creature
  // does with its turn (`controlledTurn`).
  if (controlled(actorState)) {
    controlledTurn(blocks, states, actor, engagement, rng, log, evaluator);
    endTurn(blocks, states, actor, engagement, rng, log);
    return;
  }
  standIfProne(actorBlock, actorState, log);
  if (hasAny(actorState, RULES_INCAPACITATED) || hasCondition(actorState, "suggested")) {
    // 2024 rules: incapacitated blocks actions but not movement; only
    // paralyzed/stunned/unconscious also reduce speed to 0. (No Dash: that's an action.)
    // A possessed creature has lost control of its body: it does not move it.
    if (actorState.conditions.some((c) => c.drawnToSource && c.source === foe)) {
      // "The target moves on its turn toward the harpy by the most direct route, trying to get within 5 feet": the
      // move is the song's, not the creature's, and an Incapacitated creature has no Dash. A Charmed Spy walked from
      // 70 feet to 100.
      const height = canFly(actorBlock, actorState) ? foeState.height : actorState.height;
      const beside = Math.max(5, groundFloor(actorBlock, actorState, height, foeBlock, foeState));
      if (movementSpeed(actorBlock, actorState) > 0 && (engagement.ground > beside || actorState.height !== height)) {
        if (!applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, Math.max(beside, engagement.ground - movementSpeed(actorBlock, actorState)), height, rng, log, evaluator, `is drawn toward ${foeBlock.name}`)) return;
      }
    } else if (!actorState.conditions.some((c) => c.possession) && movementSpeed(actorBlock, actorState) > 0) {
      const movement = chooseMovementAndRoutine(actorBlock, foeBlock, actorState, foeState, actor, engagement, evaluator, lookahead);
      const target = movement.dash
        ? Math.max(Math.min(engagement.distance, groundFloor(actorBlock, actorState, movement.height, foeBlock, foeState)), engagement.ground - movementSpeed(actorBlock, actorState))
        : movement.ground;
      if (!applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, target, movement.height, rng, log, evaluator, "is incapacitated but moves")) return;
    }
    if (log.on) log.push(`${actorBlock.name} loses its turn`);
    endTurn(blocks, states, actor, engagement, rng, log);
    return;
  }
  leaveBodyIfUseless(actorBlock, foeBlock, actorState, foeState, actor, log);
  detachFromFoeIfUseful(actorBlock, foeBlock, actorState, foeState, actor, engagement.distance, evaluator, log);
  // Escaping a grapple/restraining effect consumes the action — unless the creature can simply
  // teleport out, which is certain where the escape roll is not.
  const teleportEscape = teleportEscapeStep(actorBlock, foeBlock, actorState, foeState, rng, actor, engagement, log, evaluator);
  if (isDown(actorBlock, actorState) || isDown(foeBlock, foeState)) return;
  const actionTaken = teleportEscape === "action"
    || !!(actorState.bonusSlotUsed && actorState.conditions.some(c => c.actionOrBonus))
    || extinguishIfWorthwhile(actorBlock, foeBlock, actorState, foeState, actor, engagement.distance, evaluator, log)
    || (escapeWorthwhile(actorBlock, foeBlock, actorState, foeState, engagement, evaluator)
      && !breaksRatherThanEscapes(actorBlock, foeBlock, actorState, foeState, engagement, evaluator)
      && attemptEscapeIfNeeded(actorBlock, actorState, rng, log))
    || stanchIfWorthwhile(actorBlock, foeBlock, actorState, foeState, actor, engagement.distance, evaluator, rng, log, teleportEscape !== "bonus");
  // "It can move or take one action on its turn, not both" (`moveOrAct`). It acts, and stays where it is, when the
  // action is already spent or some routine is usable from here; otherwise it moves and takes no action.
  const moveOrAct = actorState.conditions.some(c => c.moveOrAct);
  const actsHere = moveOrAct && (actionTaken
    || bestUsableRoutinesAtDistance(actorBlock, foeBlock, actorState, foeState, actor, engagement.distance, evaluator, actorState.movedToward).any.ev > 0);
  if (actsHere) actorState.actsInsteadOfMoving = true;
  if (moveOrAct && log.on) log.push(`${actorBlock.name} can move or act, not both: it ${actsHere ? "acts" : "moves"}`);
  const actionConsumed = actionTaken || (moveOrAct && !actsHere);
  // The pre-action bonus slot runs before movement, not after it. Both things that belong here
  // need to: taking aim wants to precede the attack, and stepping out of a foe's reach is only
  // worth a bonus action if it happens *instead* of walking out and eating the opportunity
  // attack. Movement is then chosen from wherever the step left the creature.
  if (actionConsumed && !actorState.bonusSlotUsed) actorState.actionSlotUsed = true;
  // A Bonus Action Dash out of a faster melee foe's reach, where a Disengage and a walk would not clear that foe's walk:
  // twice the Speed away through one Opportunity Attack, and the action still to come. The foe must Dash to follow and
  // lands nothing that turn. Only from a foe with no attack beyond its reach, and only where the creature has something
  // to use from the far square. An Assassin beside a Hydra Disengaged, walked 25 feet, and took five Bites each round
  // (M10).
  let dashedOut = false;
  if (!actionConsumed && teleportEscape !== "bonus" && !actorState.bonusSlotUsed && !hasAny(actorState, RULES_INCAPACITATED)
    && actorState.height === 0 && foeState.height === 0 && !canFly(foeBlock, foeState) && !isFrightened(actorState) && !isProne(actorState)
    && !carriesTarget(foeState, actor) && !carriesTarget(actorState, foe)) {
    const idx = actorBlock.options.findIndex((option, i) => option.timing === "bonus" && option.action.kind === "selfbuff" && option.action.movement?.mode === "dash"
      && option.action.movement.distance === undefined && !option.action.movement.noProvoke && usable(actorState, i, option));
    const speed = currentSpeed(actorBlock, actorState);
    const foeReach = meleeReach(foeBlock);
    const foeWalk = nextTurnSpeed(foeBlock, foeState) + closingBeyondSpeed(actorBlock, actorState, foeBlock, foeState, actor);
    const far = Math.min(engagement.maxDistance, engagement.ground + 2 * speed);
    // The attack taken is a share of the foe's turn, and what the far square costs the creature's own routine (a Hand
    // Crossbow past its normal range) is a share of its own: the Dash is taken when it keeps half as much again of its own
    // turn than it leaves the foe of the foe's. Not through an attack that holds (a Giant Toad's Bite grapples).
    const toll = idx >= 0 ? cachedBestOaOption(evaluator, foeBlock, actorBlock, engagement.distance, far) : undefined;
    const tollAction = toll && foeBlock.options[toll.optionIdx]?.action;
    const near = Math.min(engagement.maxDistance, engagement.ground + speed);
    const shoots = (at: number): number => bestUsableRoutinesAtDistance(actorBlock, foeBlock, actorState, foeState, actor, at, evaluator, 0).damaging.ev;
    // What a Disengage and a walk would leave it: its best from any square that walk reaches.
    let stays = 0;
    if (idx >= 0) for (let at = engagement.ground; at <= near; at += 5) stays = Math.max(stays, shoots(Math.max(MIN_SEPARATION, at)));
    if (idx >= 0 && speed > 0 && engagement.distance <= foeReach && engagement.ground + speed - foeWalk <= foeReach && far - foeWalk > foeReach
      && foeBlock.options.every((option) => actionRange(option.action) <= foeReach || evaluator.expectedActionDamage(option.action, foeBlock, actorBlock) <= 0)
      && !(tollAction && "riders" in tollAction && tollAction.riders?.some((rider) => rider.condition === "grappled" || rider.condition === "restrained"))
      && shoots(far) > 0
      && shoots(far) * evaluator.bestRoutineEvAtDistance(foeBlock, actorBlock, foeReach, false) >= 1.5 * (toll?.ev ?? 0) * stays) {
      const option = actorBlock.options[idx];
      spend(actorState, idx, option);
      actorState.bonusSlotUsed = true;
      if (log.on) log.push(`${actorBlock.name} uses bonus action ${option.name}`);
      const from = engagement.ground;
      applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, Math.min(far, from + speed), 0, rng, log, evaluator, "uses bonus movement", false, speed, true);
      dashedOut = true;
      if (isDown(actorBlock, actorState) || isDown(foeBlock, foeState)) return;
    }
  }
  const preActionBonusUsed = teleportEscape === "bonus" || dashedOut
    || (!actionConsumed
      && bonusActionStep(actorBlock, foeBlock, actorState, foeState, rng, actor, engagement, log, evaluator, true));
  if (isDown(actorBlock, actorState) || isDown(foeBlock, foeState)) return;
  // A creature that was Prone and held at Speed 0 could not stand when the turn began; escaping gives it its
  // Speed back, and it stands before it moves. Without this a flier that fell when a web took it escaped and
  // climbed while still Prone, and fell again.
  standIfProne(actorBlock, actorState, log);
  // A creature held by an object (a web, a rope) may turn its attacks on it: the routine it does that with. It takes
  // the turn's action, like an escape attempt, but the attacks left once the object is gone are made as usual.
  const breaking = actionConsumed ? undefined : breakPlan(actorBlock, foeBlock, actorState, foeState, engagement, evaluator);
  const actionSpent = actionConsumed || !!breaking;
  if (!actionSpent) releaseForBarredAttack(actorBlock, foeBlock, actorState, foeState, actor, engagement, evaluator, log);
  // The opening turn's search is the same every fight of the pair until a die is rolled (`firstPlans`).
  const dice = evaluator.dice;
  const firstKey = evaluator.firstPlans && dice && dice.n === dice.start && actorState.turnCount === 1 && foeState.turnCount === 0
    ? `${actor}|${engagement.ground}|${engagement.maxDistance}|${engagement.ceiling}|${lookahead}|${actorState.startCount}|${foeState.startCount}` : undefined;
  const firstPlan = firstKey !== undefined ? evaluator.firstPlans!.get(firstKey) : undefined;
  let movement = firstPlan && firstPlan.attacker === actorBlock && firstPlan.defender === foeBlock ? { ...firstPlan.plan }
    : chooseMovementAndRoutine(actorBlock, foeBlock, actorState, foeState, actor, engagement, evaluator, lookahead);
  if (firstPlan && evaluator.cacheStats) evaluator.cacheStats.firstPlanHits = (evaluator.cacheStats.firstPlanHits ?? 0) + 1;
  if (firstKey !== undefined && !firstPlan) evaluator.firstPlans!.set(firstKey, { attacker: actorBlock, defender: foeBlock, plan: { ...movement } });
  // With no routine to make from anywhere it can walk to, a creature with a printed Leap may make it upward (`leapUpPlan`).
  const leapUp = actionSpent || movement.routine ? undefined : leapUpPlan(actorBlock, foeBlock, actorState, foeState, actor, engagement, evaluator);
  if (leapUp) movement = { ground: leapUp.ground, height: actorState.height, routine: leapUp.routine };
  const censusStart: CensusMovementStart | undefined = census
    ? {
      ground: engagement.ground,
      height: actorState.height,
      distance: engagement.distance,
      speed: movementSpeed(actorBlock, actorState) / (carriesTarget(foeState, actor) ? carryCost(actorBlock, foeBlock) : 1),
      current: currentSpeed(actorBlock, actorState) / (carriesTarget(foeState, actor) ? carryCost(actorBlock, foeBlock) : 1),
      usable: movement.dash && !actionSpent
        ? bestUsableRoutinesAtDistance(actorBlock, foeBlock, actorState, foeState, actor, engagement.distance, evaluator, actorState.movedToward).any
        : undefined,
      shares: mayShareSpace(actorBlock, actorState, foeBlock, foeState),
      swallowed: hasCondition(actorState, "swallowed"),
      // The catching Dash (L15) passes an option on purpose: one that deals this foe no damage.
      chased: foeState.withdrew || !!movement.catches,
    }
    : undefined;
  // A Dash toward a foe that has only melee and will walk to the creature and attack on its own turn buys nothing the
  // Dodge does not: either way the foe swings first, and after a Dodge it swings at Disadvantage. On the first turn
  // only, so two creatures that each wait for the other do not stall. A Mimic (Speed 20) Dashed 25 feet at a Polar Bear
  // and took two Rends (D17).
  const walk = movementSpeed(actorBlock, actorState);
  const foeReach = meleeReach(foeBlock);
  const letsFoeCome = movement.dash && !actionSpent && !movement.routine && actorState.turnCount === 1 && walk > 0
    && actorState.height === 0 && movement.height === 0 && foeState.height === 0 && movement.ground < engagement.ground
    && engagement.ground - movement.ground > walk
    && engagement.ground - walk - foeReach <= movementSpeed(foeBlock, foeState) && !hasAny(foeState, RULES_INCAPACITATED)
    // A foe that cannot put the creature down for good keeps away from it instead (a Hyena from a Troll Limb).
    && !noLethalLineLeft(foeBlock, foeState, actorBlock, evaluator)
    && foeBlock.options.every((option) => actionRange(option.action) <= foeReach || evaluator.expectedActionDamage(option.action, foeBlock, actorBlock) <= 0);
  // Nor does a Dash at a faster foe that has only melee, by a creature that has more than melee: the foe cannot be
  // caught and must come, and the Dash only puts the creature where the foe's walk ends in its full routine. It keeps
  // beyond that walk and Dodges, on any turn (the foe has no reason to wait). An Adult Black Dragon at 7 Hit Points, its
  // breath ready, Dashed from 200 feet to 40 from a Roc (Speed 120) and died to the Beak (K13).
  const foeWalk = movementSpeed(foeBlock, foeState);
  const foeMeleeOnly = (): boolean => foeBlock.options.every((option) => actionRange(option.action) <= foeReach || evaluator.expectedActionDamage(option.action, foeBlock, actorBlock) <= 0);
  const keepsOff = !letsFoeCome && movement.dash && !actionSpent && !movement.routine && walk > 0 && foeWalk > walk
    && actorState.height === 0 && movement.height === 0 && foeState.height === 0 && movement.ground < engagement.ground
    && engagement.ground - foeReach > foeWalk
    && !noLethalLineLeft(foeBlock, foeState, actorBlock, evaluator) && foeMeleeOnly()
    && actorBlock.options.some((option, idx) => usable(actorState, idx, option) && actionRange(option.action) > meleeReach(actorBlock)
      && evaluator.expectedActionDamage(option.action, actorBlock, foeBlock) > 0);
  // Nor does a Dash after a foe that struck, slipped away without provoking (a Bonus Action Disengage: Nimble Escape,
  // Cunning Action) and will do the same again: the Dash ends beside it with no action left, and the foe's next step
  // away costs it nothing. The creature holds where it is and Dodges; a foe with only melee must then spend its move
  // coming back and stays in reach. A Berserker Dashed after a Tiger for ten rounds, swung once, and lost all 400
  // fights in the larger room (L01). Only a foe with nothing but melee: against one that shoots from where it stepped
  // to, the Dash at least makes it spend the Bonus Action (an Awakened Tree lost its 18 wins of 400 against a Spy
  // by holding).
  const holds = !letsFoeCome && !keepsOff && movement.dash && !actionSpent && !movement.routine && walk > 0 && foeState.withdrew
    && actorState.height === 0 && movement.height === 0 && foeState.height === 0 && movement.ground < engagement.ground
    && !noLethalLineLeft(foeBlock, foeState, actorBlock, evaluator) && foeMeleeOnly()
    && foeBlock.options.some((option, idx) => option.timing === "bonus" && usable(foeState, idx, option)
      && option.action.kind === "selfbuff" && !!option.action.movement?.noProvoke);
  const movementTarget = actionSpent && movement.dash
    ? Math.max(Math.min(engagement.distance, groundFloor(actorBlock, actorState, movement.height, foeBlock, foeState)), engagement.ground - movementSpeed(actorBlock, actorState))
    : letsFoeCome ? engagement.ground - walk
    : holds ? engagement.ground
    : keepsOff ? Math.min(engagement.ground, Math.max(engagement.ground - walk, foeWalk + foeReach + 5)) : movement.ground;
  // A move the creature's Speed already covers is not a Dash and leaves it its action (to Dodge, if nothing else): an
  // Ogre Zombie "dashed" 20 feet to stand under a Manticore and took three Tail Spikes a round with no Disadvantage.
  const withinSpeed = movement.via === undefined && movement.height === actorState.height && !hasCondition(actorState, "prone")
    && Math.abs(engagement.ground - movementTarget) <= movementSpeed(actorBlock, actorState) / (carriesTarget(foeState, actor) ? carryCost(actorBlock, foeBlock) : 1);
  const dashes = movement.dash && !letsFoeCome && !keepsOff && !holds && !withinSpeed && !actionSpent && !(actorState.bonusSlotUsed && actorState.conditions.some(c => c.actionOrBonus));
  if (dashes) actorState.actionSlotUsed = true;
  let groundBefore = engagement.ground;
  const groundAtStart = engagement.ground;
  const heightBefore = actorState.height;
  // The way out of a back-off (`chooseMovementAndRoutine`): what it spends comes off the way back.
  let outward = 0;
  if (movement.via !== undefined && !movement.dash && !actionSpent) {
    const out = applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, movement.via, actorState.height, rng, log, evaluator, "moves", false, movementSpeed(actorBlock, actorState), false, 1);
    outward = Math.abs(engagement.ground - groundBefore);
    actorState.turnMoved += outward;
    if (!out) return;
    if (newFormEndsTurn()) return;
    groundBefore = engagement.ground;
  }
  // The Dash adds a whole Speed to what the turn has left: "The increase equals your Speed after applying any modifiers"
  // (SRD 5.2.1, p15). What a stand or a leap spent comes off the turn's own movement once, not off the Dash as well: a
  // Hezrou knocked Prone stood for 15 feet and then Dashed 30, not 45.
  const dashGrant = dashes && !actorState.actsInsteadOfMoving ? currentSpeed(actorBlock, actorState) : 0;
  const walkBudget = Math.max(0, movementSpeed(actorBlock, actorState) - outward);
  const moved = applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, movementTarget, movement.height, rng, log, evaluator, dashes ? "dashes" : "moves", false, Math.max(0, movementSpeed(actorBlock, actorState) + dashGrant - outward), false, dashes ? 2 : 1);
  actorState.turnMoved += Math.max(Math.abs(engagement.ground - groundBefore), Math.abs(actorState.height - heightBefore));
  actorState.withdrew = engagement.ground > groundAtStart;
  if (!moved) return;
  // A form that appeared during the move (`applyMovement` stopped it there) does not take the action chosen for the old
  // form, nor one of its own.
  if (newFormEndsTurn()) return;
  // An opportunity attack can swallow the mover partway through, and then the pair shares a space by the end of it.
  if (censusStart) censusMovement(actorBlock, actorState, engagement, movement, actionSpent, { ...censusStart, shares: censusStart.shares || mayShareSpace(actorBlock, actorState, foeBlock, foeState) });
  // An opportunity attack can leave the mover Incapacitated partway through its move: "You can't take any action, Bonus
  // Action, or Reaction" (SRD 5.2.1). The action it chose before moving is lost, not deferred; the move itself is not cut
  // (a Speed 0 condition already stopped it in `applyMovement`).
  if (hasAny(actorState, RULES_INCAPACITATED)) {
    if (log.on) log.push(`${actorBlock.name} is incapacitated and loses its action`);
    endTurn(blocks, states, actor, engagement, rng, log);
    actorState.tookDamageSinceTurnEnd = false;
    return;
  }
  if (leapUp && engagement.ground === leapUp.ground && actorState.height === 0 && !actorState.bonusSlotUsed) {
    const option = actorBlock.options[leapUp.optionIdx];
    spend(actorState, leapUp.optionIdx, option);
    actorState.movementPenalty += (option.action.kind === "selfbuff" ? option.action.movement?.cost : undefined) ?? 0;
    actorState.height = leapUp.height;
    actorState.leaping = true;
    engagement.distance = separation(blocks[0], states[0].height, blocks[1], states[1].height, engagement.ground);
    if (log.on) {
      log.push(`${actorBlock.name} uses bonus action ${option.name}`);
      log.push(`${actorBlock.name} leaps up [altitude 0 ft to ${leapUp.height} ft]`);
    }
  }
  // A move that a Speed 0 condition stopped short (an Opportunity Attack that Grapples or Restrains) leaves the creature
  // where its plan did not put it, so the action is chosen again where it stands. A Dash it had not yet needed (it was
  // stopped within its own Speed) was never taken. A Wight grappled by a Mimic's Opportunity Attack as it walked off to
  // shoot Dodged, or shot at Disadvantage from 5 feet, beside a foe its Sword Multiattack reached (O06).
  const stoppedShort = !breaking && !actionSpent && !actionConsumed && movementSpeed(actorBlock, actorState) === 0
    && (engagement.ground !== movementTarget || actorState.height !== movement.height)
    && !(actorState.bonusSlotUsed && actorState.conditions.some(c => c.actionOrBonus));
  const undashed = stoppedShort && dashes && Math.abs(engagement.ground - groundBefore) <= walkBudget;
  if (undashed) actorState.actionSlotUsed = false;
  const routine = stoppedShort && (!dashes || undashed)
    ? bestUsableRoutinesAtDistance(actorBlock, foeBlock, actorState, foeState, actor, engagement.distance, evaluator, 0).any.routine
    : breaking && !(actorState.bonusSlotUsed && actorState.conditions.some(c => c.actionOrBonus)) ? breaking
    : movement.dash || actionConsumed || (actorState.bonusSlotUsed && actorState.conditions.some(c => c.actionOrBonus)) ? undefined : movement.routine;
  let acted = false;
  if (routine) {
    let routineHits = 0;
    const ordered = attackOrder(routine, actorBlock, foeBlock, foeState, engagement.distance);
    const mixes = breaking ? undefined : combinationSet(actorBlock, routine);
    // The routine was chosen against the target as it stood; a swing is chosen afresh only once that has changed.
    const stoodAs = mixes ? foeConditionKey(foeState) : "";
    parts: for (const part of ordered) {
      // A downed creature does nothing further this turn: no later part, no all-hits effect, no Bonus Action (the
      // repetition loop below already stopped). Its own cost can down it, and so can a retaliation, a
      // rebuke or a death burst its earlier part drew.
      if (isDown(actorBlock, actorState)) break;
      const option = actorBlock.options[part.optionIdx];
      const repetitions = part.perHead ? actorState.heads ?? part.count : part.count;
      // This part's attacks go at the object while it stands; the ones left after it is destroyed go at the foe.
      let struck = 0;
      if (breaking) {
        for (let object = heldObject(actorState); object && struck < repetitions && objectDamage(option, object.spec) > 0 && usable(actorState, part.optionIdx, option) && !hasAny(actorState, RULES_INCAPACITATED); object = heldObject(actorState)) {
          spend(actorState, part.optionIdx, option);
          acted = true;
          if (log.on) log.push(`${actorBlock.name} uses ${option.name} on the ${object.spec.name}`);
          strikeObject(actorBlock, foeBlock, actorState, foeState, option, object, rng, log);
          struck++;
        }
        if (struck >= repetitions) continue;
      }
      if (!option || !usable(actorState, part.optionIdx, option) || !actionInRange(option.action, engagement.distance) || !actionRequirementMet(option.action, foeState, actor)
        || !actionTargetable(option.action, actorBlock, foeBlock, engagement.distance, foeState, actorState)
        || !preservesUsefulCharm(option.action, actorBlock, foeBlock, actorState, foeState, actor, engagement.distance)
        || !worthReusing(option.action, actorBlock, foeBlock, foeState, actor, engagement.distance, evaluator)
        || recoilForNothing(option.action, actorBlock, foeBlock, foeState, actorState, actor, engagement.distance, evaluator)) continue;
      for (let i = struck; i < repetitions && !isDown(foeBlock, foeState); i++) {
        // Each repetition pays for itself. A single `spend` before the loop let a routine
        // that repeats a limited-use option fire more times than the pool allows whenever
        // the pool held more than one use.
        // Attacks made "in any combination" are chosen one at a time, each by what the last one left (`combinationSwing`).
        const swing = mixes && foeConditionKey(foeState) !== stoodAs
          ? combinationSwing(mixes, part.optionIdx, actorBlock, foeBlock, actorState, foeState, actor, engagement.distance, evaluator)
          : finishingAttack(routine, part, actorBlock, foeBlock, actorState, foeState, engagement.distance, evaluator) ?? part.optionIdx;
        const swingOption = actorBlock.options[swing];
        if (!usable(actorState, swing, swingOption)) break;
        // "You can't take any action" (SRD 5.2.1, Incapacitated): a reaction that incapacitates the actor partway through
        // its routine ends the routine, before any further repetition or part.
        if (hasAny(actorState, RULES_INCAPACITATED)) break;
        if (!actionInRange(swingOption.action, engagement.distance)) break;
        if (!actionRequirementMet(swingOption.action, foeState, actor)) break;
        if (actorState.conditions.some(c => c.oneAttack) && (swingOption.action.kind === "attack" || swingOption.action.kind === "autohit" && swingOption.action.melee || part.replacesAttack)) {
          if ((actorState.routineAttacks ?? 0) >= 1) break;
          actorState.routineAttacks = (actorState.routineAttacks ?? 0) + 1;
        }
        spend(actorState, swing, swingOption);
        acted = true;
        if (log.on) log.push(`${actorBlock.name} uses ${swingOption.name}`);
        // What the routine still has to make after this one, for a push whose length is the attacker's (`choosePush`).
        const later = [...(i + 1 < repetitions ? [option] : []), ...ordered.slice(ordered.indexOf(part) + 1).map((p) => actorBlock.options[p.optionIdx])]
          .flatMap((o) => o ? [oaAttackReach(o.action) ?? ("range" in o.action ? o.action.range : undefined) ?? 5] : []);
        actorState.routineStillReaches = later.length ? Math.min(...later) : undefined;
        // An action that is the creature's own move into its target's space (`entersTargetSpace`) is made: it ends beside
        // the target, "without provoking Opportunity Attacks". A Gelatinous Cube engulfed a Knight from 15 feet and stayed there.
        if (swingOption.action.kind === "save" && swingOption.action.entersTargetSpace && engagement.ground > MIN_SEPARATION
          && !applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, MIN_SEPARATION, actorState.height, rng, log, evaluator, "moves", true, swingOption.action.range)) break parts;
        resolveOptionWithTeleport(actorBlock, foeBlock, actorState, foeState, swingOption.action, rng, actor, engagement, log, evaluator);
        actorState.routineStillReaches = undefined;
        settleAfterAction(actorBlock, foeBlock, actorState, foeState, actor, engagement, rng, log);
        // The old form's routine ends at a form change: `option` and every part index belong to the old stat block.
        if (actorState.formChanges !== form) break parts;
        if (actorState.lastActionHit) routineHits++;
        // Nor by an attacker its own hit brought down (a retaliation to it, such as Corrosive Form).
        if (actorState.bloodiedDamage && !actorState.bonusSlotUsed && !isDown(foeBlock, foeState) && !isDown(actorBlock, actorState)) {
          bonusActionStep(actorBlock, foeBlock, actorState, foeState, rng, actor, engagement, log, evaluator, false, true);
        }
        rollDepletion(actorState, swing, swingOption, rng, log);
        if (isDown(actorBlock, actorState)) break;
      }
    }
    // Nor the old routine's all-hits effect, nor a Bonus Action of the new form's.
    if (newFormEndsTurn()) return;
    if (routine.onAllHits && routineHits >= routine.onAllHits.requiredHits && !isDown(foeBlock, foeState) && !isDown(actorBlock, actorState)) {
      if (log.on) log.push(`${actorBlock.name} triggers ${routine.name}'s all-hit effect`);
      resolveAction(actorBlock, foeBlock, actorState, foeState, routine.onAllHits.action, rng, actor, engagement.distance, log);
      settleAfterAction(actorBlock, foeBlock, actorState, foeState, actor, engagement, rng, log);
    }
  }
  // A leap upward ends in a fall once its attacks are made.
  if (actorState.leaping) {
    actorState.leaping = false;
    if (actorState.height >= 10 || isDown(actorBlock, actorState)) settleFlight(blocks, states, engagement, rng, log);
    else {
      // "1d6 Bludgeoning damage ... for every 10 feet it fell": a shorter drop is a landing.
      actorState.height = 0;
      engagement.distance = separation(blocks[0], states[0].height, blocks[1], states[1].height, engagement.ground);
      if (log.on) log.push(`${actorBlock.name} lands`);
    }
  }
  // A Bonus Action Disengage after a melee routine: the creature steps out of a slower melee foe's walk with the
  // movement it has left, where its own walk brings it back to attack next turn. The foe must Dash to follow and so
  // attacks every second round. A Saber-Toothed Tiger (Speed 40, Nimble Escape) stood and traded with a Swarm of
  // Venomous Snakes (Speed 30) every round (D12).
  if (acted && !preActionBonusUsed && !actorState.bonusSlotUsed && !hasAny(actorState, RULES_INCAPACITATED) && !isDown(actorBlock, actorState) && !isDown(foeBlock, foeState)
    && actorState.height === 0 && foeState.height === 0 && !canFly(foeBlock, foeState) && !isFrightened(actorState)) {
    const idx = actorBlock.options.findIndex((option, i) => option.timing === "bonus" && option.action.kind === "selfbuff" && option.action.condition === "disengaged"
      && option.action.movement?.distance === 0 && !!option.action.movement.noProvoke && usable(actorState, i, option));
    const left = movementSpeed(actorBlock, actorState) - actorState.turnMoved;
    const reach = meleeReach(actorBlock);
    const foeReach = meleeReach(foeBlock);
    const foeWalk = nextTurnSpeed(foeBlock, foeState) + closingBeyondSpeed(actorBlock, actorState, foeBlock, foeState, actor);
    // No farther than clears the foe's walk and reach: the walk back must leave the movement to step out again. A
    // Panther (Speed 50) went 50 ft from a Mimic (Speed 20) that then stayed put, walked 45 ft back, and ended its
    // turn beside it every other round (N02).
    const retreat = Math.min(engagement.maxDistance, engagement.ground + left, Math.max(engagement.ground, Math.ceil((foeWalk + foeReach + 1) / 5) * 5));
    if (idx >= 0 && left > 0 && engagement.distance <= reach && !carriesTarget(foeState, actor) && !carriesTarget(actorState, foe)
      && engagement.ground - foeWalk <= foeReach && retreat - foeWalk > foeReach && retreat - reach <= currentSpeed(actorBlock, actorState)
      && foeBlock.options.every((option) => actionRange(option.action) <= foeReach || evaluator.expectedActionDamage(option.action, foeBlock, actorBlock) <= 0)
      && evaluator.bestRoutineEvAtDistance(foeBlock, actorBlock, Math.max(0, retreat - foeWalk), false) <= 0) {
      const option = actorBlock.options[idx];
      spend(actorState, idx, option);
      if (log.on) log.push(`${actorBlock.name} uses bonus action ${option.name}`);
      resolveOptionWithTeleport(actorBlock, foeBlock, actorState, foeState, option.action, rng, actor, engagement, log, evaluator);
      const from = engagement.ground;
      applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, retreat, 0, rng, log, evaluator, "moves", true, left);
      actorState.turnMoved += Math.max(0, engagement.ground - from);
      actorState.withdrew = true;
    }
  }
  // Nor a Bonus Action once incapacitated.
  if (!preActionBonusUsed && !hasAny(actorState, RULES_INCAPACITATED) && !isDown(actorBlock, actorState)) bonusActionStep(actorBlock, foeBlock, actorState, foeState, rng, actor, engagement, log, evaluator);
  // The Dodge action, with an action nothing else took: no routine part was used, nothing was broken or escaped, and
  // either no Dash was made or the Dash covered no ground (a walker under a flier). "Until the start of your next turn,
  // any attack roll made against you has Disadvantage if you can see the attacker, and you make Dexterity saving throws
  // with Advantage."
  const stoodStill = engagement.ground === groundBefore && actorState.height === heightBefore;
  if (!acted && !actionSpent && (!dashes || stoodStill || undashed) && !isDown(actorBlock, actorState) && !isDown(foeBlock, foeState)
    && !hasAny(actorState, RULES_INCAPACITATED) && !(actorState.bonusSlotUsed && actorState.conditions.some(c => c.actionOrBonus))) {
    actorState.dodging = true;
    actorState.actionSlotUsed = true;
    if (log.on) log.push(`${actorBlock.name} dodges`);
  }
  endTurn(blocks, states, actor, engagement, rng, log);
  // "...until the end of its next turn." Cleared here rather than at the start of the turn so
  // that damage taken *during* this turn — a retaliation, an opportunity attack — still counts
  // for the turn it was dealt on and then expires with it.
  actorState.tookDamageSinceTurnEnd = false;
}

/**
 * The order a Multiattack's attacks are made in. "The bear makes one Bite attack and one Claw attack" names the attacks
 * and not their order, so the attacker makes first the one that leaves the target open to the rest: a melee attack that
 * knocks Prone (for attackers within 5 feet) or Restrains, Paralyzes, Stuns or Blinds. A Brown Bear bit and then clawed
 * its target Prone, every round, and never bit a Prone one. Only where every part is an attack (a routine with a use in
 * it is printed in sequence), none waits on a run-up (whose first swing is the one that carries it), the opener is not a
 * grapple, and no other part is barred by what the opener imposes.
 */
function attackOrder(routine: Routine, attacker: CombatStatblock, defender: CombatStatblock, foeState: FighterState, distance: number): Routine["parts"] {
  if (routine.parts.length < 2) return routine.parts;
  const actions = routine.parts.map((part) => attacker.options[part.optionIdx]?.action);
  // A use that is a saving throw ("makes six Pact Blade attacks and uses Constrict") is part of the same action, and
  // the Multiattack rule sets no order on its parts (SRD 5.2.1, p257), so one that opens the target goes first too.
  // One that needs a condition on its target goes first only once the target has it: a Chuul's Paralyzing Tentacles
  // follow the Pincer that grapples, and open the next turn's Multiattack on a creature still held.
  const opensBySave = (action: CombatAction | undefined): boolean => action?.kind === "save" && !action.spell && !action.emanation && !action.zone
    && !action.entersTargetSpace && !action.jumpsToTarget && actionInRange(action, distance) && !action.requiresTargetMissingConditions?.length
    && (!action.requiresTargetCondition || hasCondition(foeState, action.requiresTargetCondition)) && !action.requiresTargetConditions?.length && !action.requiresAnyTargetConditions?.length
    && (action.targetMaxSize === undefined || defender.size <= action.targetMaxSize);
  // So does a use that needs no roll and opens the target at its present Hit Points ("uses Pummel or Spellcasting":
  // Power Word Stun on a target with 150 Hit Points or fewer). A Glabrezu made both Pincers and then Stunned. Not on a
  // target in the air, which falls out of the attacks' reach when it is Stunned.
  const stuns = (rider: Rider): boolean => OPENING_CONDITIONS.has(rider.condition) && (rider.targetHpMax === undefined || foeState.hp <= rider.targetHpMax)
    && (rider.requiresTargetHpAbove === undefined || foeState.hp > rider.requiresTargetHpAbove)
    && !defender.conditionImmune.includes(rider.condition) && !hasCondition(foeState, rider.condition);
  const opensUnrolled = (action: CombatAction | undefined): boolean => foeState.height === 0 && action?.kind === "autohit" && !action.damage?.length && actionInRange(action, distance)
    && !!action.riders?.some(stuns);
  if (!actions.every((action) => (action?.kind === "attack" && !actionHasRunUpGate(action)) || opensBySave(action) || opensUnrolled(action))) return routine.parts;
  const allMelee = actions.every((action) => action?.kind === "attack" && action.melee);
  // A knockdown by saving throw opens too ("It can replace one attack with a use of Shield Bash", p289: any one of the
  // three), where the attacks are melee and made within 5 feet, and the use leaves the target where it stood: not one
  // that also pushes it (Repulsion Breath) or throws a creature it holds (Fling).
  const attacksMelee = actions.every((action) => action?.kind !== "attack" || action.melee);
  const opened = (action: CombatAction | undefined): string[] => {
    if (action?.kind === "autohit") return (action.riders ?? []).filter(stuns).map((rider) => rider.condition);
    if (action?.kind === "save") {
      const knocksDown = attacksMelee && distance <= 5 && !action.requiresTargetCondition && !action.riders.some((rider) => rider.condition === "forcedPush");
      return action.riders.filter((rider) => (OPENING_CONDITIONS.has(rider.condition) || (rider.condition === "prone" && knocksDown))
        && !defender.conditionImmune.includes(rider.condition) && !hasCondition(foeState, rider.condition)
        && (rider.targetMaxSize === undefined || defender.size <= rider.targetMaxSize)).map((rider) => rider.condition);
    }
    return action?.kind !== "attack" || !action.melee
    || action.riders.some((rider) => rider.condition === "grappled") ? []
    : action.riders.filter((rider) => (OPENING_CONDITIONS.has(rider.condition) || (rider.condition === "prone" && allMelee && distance <= 5))
      && !defender.conditionImmune.includes(rider.condition) && !hasCondition(foeState, rider.condition)
      && (rider.targetMaxSize === undefined || defender.size <= rider.targetMaxSize)).map((rider) => rider.condition);
  };
  const opens = actions.map(opened);
  if (!opens.some((conditions, idx) => conditions.length && opens.slice(0, idx).some((earlier) => !earlier.length))) return routine.parts;
  const imposed = new Set(opens.flat());
  if (actions.some((action, idx) => !opens[idx].length && action?.kind === "attack"
    && action.requiresTargetMissingConditions?.some((condition) => imposed.has(condition)))) return routine.parts;
  return [...routine.parts.filter((_, idx) => opens[idx].length), ...routine.parts.filter((_, idx) => !opens[idx].length)];
}

const combinationSets = new WeakMap<CombatStatblock, Map<Routine, number[] | undefined>>();

/**
 * The attacks a routine may mix freely: "The lich makes three attacks, using Eldritch Burst or Paralyzing Touch in any
 * combination" (SRD 5.2.1, p304). Compiled as one routine per split, so the set is read back from them: a routine of
 * two attacks whose block also holds, at the same count, the routine of each attack alone.
 */
function combinationSet(block: CombatStatblock, routine: Routine): number[] | undefined {
  let sets = combinationSets.get(block);
  if (!sets) combinationSets.set(block, sets = new Map());
  if (sets.has(routine)) return sets.get(routine);
  const total = routine.parts.reduce((sum, part) => sum + part.count, 0);
  const members = [...new Set(routine.parts.map((part) => part.optionIdx))];
  const alone = (idx: number): boolean => block.routines.some((other) => other.parts.length === 1 && !other.onAllHits
    && other.parts[0].optionIdx === idx && other.parts[0].count === total && !other.parts[0].perHead);
  const set = members.length === 2 && !routine.onAllHits && routine.parts.every((part) => !part.perHead && block.options[part.optionIdx]?.action.kind === "attack")
    && members.every(alone) ? members : undefined;
  sets.set(routine, set);
  return set;
}

function foeConditionKey(state: FighterState): string {
  return state.conditions.map((c) => c.name).sort().join(",");
}

/**
 * Which of the mixable attacks this swing is, once an earlier one has changed the conditions the target holds: the one
 * worth most against the target as it now stands, the routine's own on a tie. A Lich whose first Paralyzing Touch landed made the second it had planned in case of a miss, for 15 Cold
 * where an Eldritch Burst on the Paralyzed target is a critical hit.
 */
function combinationSwing(set: number[], planned: number, attacker: CombatStatblock, defender: CombatStatblock, state: FighterState, foeState: FighterState,
  source: 0 | 1, distance: number, evaluator: PairEvaluator): number {
  const worth = (idx: number): number => {
    const option = attacker.options[idx];
    if (!option || !usable(state, idx, option) || !actionInRange(option.action, distance) || !actionRequirementMet(option.action, foeState, source)
      || !actionTargetable(option.action, attacker, defender, distance, foeState, state)) return -1;
    return dynamicEv(option.action, attacker, defender, foeState, state, source, distance, evaluator);
  };
  let best = planned;
  let bestEv = worth(planned);
  for (const idx of set) {
    const ev = idx === planned ? bestEv : worth(idx);
    if (ev > bestEv + 1e-9) { best = idx; bestEv = ev; }
  }
  return best;
}

/** Would this cure lift a condition that gives the caster's own attack rolls Disadvantage (Blinded, Poisoned)? */
function sharpenedByCure(block: CombatStatblock, state: FighterState, action: Extract<CombatAction, { kind: "selfheal" }>): boolean {
  const removed = restored(block, state, action);
  return !!removed && removed !== "abilityScores" && liftedBy(state, removed).some((name) => name === "blinded" || name === "poisoned");
}

/** Conditions that give attack rolls against their bearer Advantage wherever the attacker stands. */
const OPENING_CONDITIONS = new Set<string>(["restrained", "paralyzed", "stunned", "blinded", "unconscious"]);

function bonusActionStep(
  actorBlock: CombatStatblock,
  foeBlock: CombatStatblock,
  actorState: FighterState,
  foeState: FighterState,
  rng: () => number,
  actor: 0 | 1,
  engagement: EngagementState,
  log: FightLog,
  evaluator: PairEvaluator,
  preActionOnly = false,
  rampageOnly = false,
): boolean {
  if (actorState.bonusSlotUsed || actorState.conditions.some(c => c.noBonusActions) || hasAny(actorState, RULES_INCAPACITATED)) return false;
  const distance = engagement.distance;
  if (isDown(foeBlock, foeState)) return false;
  let bestIdx = -1;
  let bestEv = 0;
  let bestSharpens = false;
  // The best Bonus Action that waits for the action, as the later pass would price it: from where this turn's movement
  // can bring the creature, since the pre-action slot comes before the move.
  let laterEv = 0;
  const afterMove = preActionOnly ? Math.max(Math.min(distance, meleeReach(actorBlock)), distance - movementSpeed(actorBlock, actorState)) : distance;
  // Whether the action to come makes attack rolls, and holds no Concentration of its own to end the buff cast before it.
  let swings: boolean | undefined;
  const actionSwings = (): boolean => swings ??= (() => {
    const moved = bestUsableRoutinesAtDistance(actorBlock, foeBlock, actorState, foeState, actor, afterMove, evaluator, actorState.movedToward).any;
    const actions = (moved.routine?.parts ?? []).map((part) => actorBlock.options[part.optionIdx]?.action);
    const concentrates = (action: CombatAction | undefined): boolean => !!action && "concentration" in action && !!action.concentration;
    return actions.some((action) => action?.kind === "attack") && !actions.some(concentrates);
  })();
  actorBlock.options.forEach((option, idx) => {
    if (option.timing !== "bonus" || !usable(actorState, idx, option) || (rampageOnly && !option.requiresBloodiedDamage)) return;
    // Nor is damage dealt, with the Bonus Action left over, to a target this creature's own condition keeps from acting
    // until it is hurt ("The effect ends for a creature if it takes any damage"): an Incubus cast Hypnotic Pattern and
    // then woke the Manticore with Nightmare in the same turn, losing the spell and its Concentration (N05).
    if (!preActionOnly && "damage" in option.action && option.action.damage.length
      && foeState.conditions.some((c) => c.source === actor && c.endsOnDamage && RULES_INCAPACITATED.has(c.name))) return;
    // The pre-action slot is for things that have to happen before the attack to be worth
    // anything: taking aim, and stepping out of a foe's reach so the attack that follows is not
    // made point-blank into an opportunity attack.
    const aiming = option.action.kind === "selfbuff" && option.action.condition === "aiming"
      || option.action.kind === "selfheal" && !!option.action.selfRiders?.some((r) => r.rollEffects?.some((e) => e.roll === "attack" && e.mode === "advantage"));
    const escapeStep = option.action.kind === "teleport" && distance <= meleeReach(foeBlock);
    // And a jump to a foe this turn's walk does not reach: after it the action is the routine, where the walk leaves
    // only a Dash.
    const closingStep = preActionOnly && option.action.kind === "teleport" && distance > meleeReach(foeBlock)
      && evaluator.bestRoutineEvAtDistance(actorBlock, foeBlock, afterMove, true) <= 0
      && evaluator.bestRoutineEvAtDistance(actorBlock, foeBlock, Math.max(MIN_SEPARATION, distance - option.action.teleport.distance), true) > 0;
    const mobility = option.action.kind === "selfbuff" && !!option.action.movement;
    const control = "riders" in option.action && option.action.riders?.some(r => r.actionOrBonus || !!r.willingFor);
    // So is a Bonus Action that leaves the foe open to the attacks that follow: "Attack rolls against the target have
    // Advantage" (Restrained, Paralyzed, Stunned, Blinded, Unconscious). A Medusa clawed and bit a Knight on plain rolls
    // and only then turned her Petrifying Gaze on it. Not one that waits on something the action itself brings about.
    const opens = (option.action.kind === "save" || option.action.kind === "attack") && !option.requiresBloodiedDamage
      && !option.action.requiresTargetCondition && !option.action.requiresTargetConditions?.length && !option.action.requiresAnyTargetConditions?.length
      && !!option.action.riders?.some((r) => (OPENING_CONDITIONS.has(r.condition)
        // Or outlines the target (Faerie Fire: "Attack rolls against an affected creature have Advantage ... and the
        // affected creature can't benefit from the Invisible condition"). Cast after the action it came after a step
        // back out of its 60 feet: a Drider shot at an Invisible Oni at Disadvantage for nine rounds (L03). Only at a
        // target it cannot see: against one in plain sight the Drider's Web, from the same Recharge, is the better
        // opener, and with both in this slot it lost 13 to 24 fights of 400 to each of five visible foes.
        || !!r.rollEffects?.some((e) => e.roll === "attackAgainst" && e.mode === "advantage") && !canSee(actorBlock, foeState, actorState, distance)
        // Or a grapple the block's own attack is printed to have Advantage against ("if the target is Grappled by the
        // bugbear"): a Bugbear Stalker threw two Javelins and then made its Quick Grapple.
        || r.condition === "grappled" && !hasConditionFrom(foeState, "grappled", actor)
          && actorBlock.options.some((other) => other.action.kind === "attack" && other.action.advantageWhen === "targetGrappledByAttacker"))
        && !foeBlock.conditionImmune.includes(r.condition) && !hasCondition(foeState, r.condition));
    // And one that betters the caster's own attack rolls this turn: a bonus to them it does not hold yet (Bless), or the
    // cure of a condition that gives them Disadvantage (Lesser Restoration on a Blinded or Poisoned caster). A Planetar
    // swung three times Blinded and then cured itself; a Priest cast Bless after both Mace attacks. It goes first only
    // when it is the Bonus Action the creature would have picked after its action anyway (`laterEv`).
    const sharpens = preActionOnly && (option.action.kind === "selfbuff" && !hasCondition(actorState, option.action.condition)
        && !!option.action.rollEffects?.some((e) => e.roll === "attack" && e.mode === "bonus")
      || option.action.kind === "selfheal" && !!option.action.curesConditions && sharpenedByCure(actorBlock, actorState, option.action))
      && actionSwings();
    const early = aiming || escapeStep || closingStep || mobility || control || opens || sharpens;
    if (preActionOnly && !early) {
      if (!(aiming || mobility || control)) laterEv = Math.max(laterEv, dynamicEv(option.action, actorBlock, foeBlock, foeState, actorState, actor, afterMove, evaluator, "bonus"));
      return;
    }
    if (!preActionOnly && (aiming || mobility || control)) return;
    // A ward lasts one foe turn; a buff from the same pool of uses (Divine Aid's Bless) lasts the fight, though it is
    // priced over `CONDITION_HORIZON_TURNS` at most. In a fight expected to run longer than that the lasting one is
    // cast first and the ward gets the uses left over.
    if (option.action.kind === "selfbuff" && option.action.wardDc !== undefined) {
      const pool = "pool" in option.uses ? option.uses.pool : undefined;
      const lasting = pool !== undefined && actorBlock.options.some((other, otherIdx) => other !== option && "pool" in other.uses && other.uses.pool === pool
        && other.action.kind === "selfbuff" && !!other.action.rollEffects?.length && usable(actorState, otherIdx, other) && !hasCondition(actorState, other.action.condition));
      const ownEv = evaluator.bestRoutineEvAtDistance(actorBlock, foeBlock, Math.min(distance, meleeReach(actorBlock)), false);
      const foeEv = evaluator.bestRoutineEvAtDistance(foeBlock, actorBlock, Math.min(distance, meleeReach(foeBlock)), false);
      if (lasting && Math.min(foeState.hp / Math.max(1, ownEv), actorState.hp / Math.max(1, foeEv)) > CONDITION_HORIZON_TURNS) return;
    }
    // An option that jumps first acts from its landing, so it is priced there, as a Legendary entry is (`legendaryStep`):
    // a teleport of 30 feet that then deals damage within 15 feet of where it lands. Every other option is
    // priced where the creature stands.
    const carried = jumpFirstAction(option.action);
    const at = carried
      ? jumpFirstDistance(actorBlock, foeBlock, actorState, foeState, actor, engagement, carried, evaluator)
      : option.requiresBloodiedDamage ? Math.max(5, distance - currentSpeed(actorBlock, actorState) / 2)
      : sharpens && !(aiming || escapeStep || mobility || control || opens) ? afterMove : distance;
    const ev = dynamicEv(option.action, actorBlock, foeBlock, foeState, actorState, actor, at, evaluator, "bonus");
    if (ev > bestEv) {
      bestIdx = idx;
      bestEv = ev;
      bestSharpens = preActionOnly && sharpens && !(aiming || escapeStep || mobility || control || opens);
    }
  });
  if (bestIdx < 0 || (bestSharpens && laterEv > bestEv)) return false;
  const option = actorBlock.options[bestIdx];
  spend(actorState, bestIdx, option);
  if (log.on) log.push(`${actorBlock.name} uses bonus action ${option.name}`);
  if (option.requiresBloodiedDamage && distance > meleeReach(actorBlock)) {
    const grant = currentSpeed(actorBlock, actorState) / 2;
    applyMovement(actorBlock, actorState, foeBlock, foeState, actor, engagement, Math.max(5, engagement.ground - grant), actorState.height, rng, log, evaluator, "rampages", false, grant, true);
    if (isDown(actorBlock, actorState)) return true;
  }
  resolveOptionWithTeleport(actorBlock, foeBlock, actorState, foeState, option.action, rng, actor, engagement, log, evaluator);
  settleAfterAction(actorBlock, foeBlock, actorState, foeState, actor, engagement, rng, log);
  rollDepletion(actorState, bestIdx, option, rng, log);
  return true;
}

/**
 * Where a Legendary entry that moves and then attacks ("moves up to half its Speed, and it makes one Rend attack")
 * attacks from, when the attack is out of reach where the creature stands: the farthest square inside the grant from
 * which the attack reaches (it closes no further than it must), at the nearest such altitude. Undefined when no square
 * inside the grant brings the attack into reach, or the creature may not close (Frightened).
 */
function legendaryApproach(block: CombatStatblock, state: FighterState, foe: CombatStatblock, foeState: FighterState, engagement: EngagementState, action: CombatAction, budget: number): { ground: number; height: number; distance: number } | undefined {
  if (budget <= 0 || isFrightened(state)) return undefined;
  const reach = oaAttackReach(action) ?? ("range" in action ? action.range : undefined) ?? 5;
  let best: { ground: number; height: number; distance: number } | undefined;
  for (const height of groundBound(block, state) ? [state.height] : moveHeights(block, state.height, foe, foeState.height, budget, skyRoof(engagement, foe), undefined, state)) {
    const ground = Math.max(groundFloor(block, state, height, foe, foeState), engagement.ground - budget, Math.min(engagement.ground, reach));
    const distance = separation(block, height, foe, foeState.height, ground);
    if (!actionInRange(action, distance)) continue;
    if (!best || distance > best.distance || distance === best.distance && Math.abs(height - state.height) < Math.abs(best.height - state.height)) best = { ground, height, distance };
  }
  return best;
}

/** A Legendary entry's own flight after its action ("it can fly up to half its Fly Speed"), searched as a Legendary Move is. */
function legendaryEntryFlight(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actor: 0 | 1, engagement: EngagementState, evaluator: PairEvaluator, lookahead: boolean, move: LegendaryEntryMove): { ground: number; height: number; gain: number; budget: number } | undefined {
  const foe = actor === 0 ? 1 : 0;
  const { budget, stands } = legendaryMoveBudget(blocks[actor], states[actor], move);
  if (budget <= 0 || stands || isProne(states[actor])) return undefined;
  const probe: LegendaryMoveProbe = { speed: budget, noProvoke: move.noProvoke };
  chooseMovementAndRoutine(blocks[actor], blocks[foe], states[actor], states[foe], actor, engagement, evaluator, lookahead, probe);
  if (!probe.result || probe.result.gain <= 0 || probe.result.ground === engagement.ground && probe.result.height === states[actor].height) return undefined;
  return { ...probe.result, budget };
}

function legendaryStep(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState], actorJustEnded: 0 | 1, rng: () => number, engagement: EngagementState, log: FightLog, evaluator: PairEvaluator, lookahead = true): void {
  const actor = actorJustEnded === 0 ? 1 : 0;
  const foe = actorJustEnded;
  if (isDown(blocks[actor], states[actor]) || isDown(blocks[foe], states[foe]) || (!blocks[actor].legendaryOptions.length && !blocks[actor].legendaryMove)) return;
  if (hasAny(states[actor], RULES_INCAPACITATED) || controlled(states[actor])) return;
  let best: LegendaryEntry | undefined;
  let bestEv = 0;
  // The chosen entry's own movement: where a move-then-attack entry attacks from, and whether its action is worth using.
  let bestApproach: ReturnType<typeof legendaryApproach>;
  let bestGrant: ReturnType<typeof legendaryMoveBudget> | undefined;
  let bestActs = true;
  for (const legendary of blocks[actor].legendaryOptions) {
    if (legendary.requiresMythic && !states[actor].mythicActive) continue;
    const option = blocks[actor].options[legendary.optionIdx];
    if (!option || (!legendary.refreshesUse && !usable(states[actor], legendary.optionIdx, option))) continue;
    // An entry that jumps first acts from its landing, so it is priced there (the entry's
    // own jump, in the printed order). Every other entry is priced where the creature stands.
    const carried = jumpFirstAction(option.action);
    let at = carried
      ? jumpFirstDistance(blocks[actor], blocks[foe], states[actor], states[foe], actor, engagement, carried, evaluator)
      : engagement.distance;
    // An entry that moves and then attacks is priced where its move brings the attack into reach; in reach already, it
    // attacks from where the creature stands.
    // A Prone creature whose grant covers the stand stands first (`legendaryMoveBudget`) and is priced standing.
    // If what the stand leaves cannot bring the attack into reach, it crawls instead when the crawl can.
    let grant = legendary.move?.when === "before" ? legendaryMoveBudget(blocks[actor], states[actor], legendary.move) : undefined;
    const closes = (budget: number) => legendaryApproach(blocks[actor], states[actor], blocks[foe], states[foe], engagement, option.action, budget);
    let approach = grant && !actionInRange(option.action, at) ? closes(grant.budget) : undefined;
    if (grant?.stands && !approach && !actionInRange(option.action, at)) {
      const crawl = legendaryMoveBudget(blocks[actor], states[actor], legendary.move!, true);
      approach = closes(crawl.budget);
      if (approach) grant = crawl;
    }
    if (approach) at = approach.distance;
    const held = states[actor].conditions;
    if (grant?.stands) {
      states[actor].conditions = held.filter((c) => c.name !== "prone");
      pruneLinkedConditions(states[actor]);
    }
    let ev = dynamicEv(option.action, blocks[actor], blocks[foe], states[foe], states[actor], actor, at, evaluator, "legendary") * legendary.count;
    states[actor].conditions = held;
    // A flier that kept above a foe with no answer to it and comes down for the entry's attack is in that foe's reach on
    // its own turn, and climbs back out through an Opportunity Attack: an Adult White Dragon Pounced on a Purple Worm
    // for one Rend (12) and paid a Tail Stinger (43) to leave, six times in two fights.
    if (approach && approach.height < states[actor].height
      && evaluator.bestRoutineEvAtDistance(blocks[foe], blocks[actor], engagement.distance, false) <= 0
      && evaluator.bestRoutineEvAtDistance(blocks[foe], blocks[actor], at, false) > 0) {
      ev -= cachedBestOaOption(evaluator, blocks[foe], blocks[actor], at, engagement.distance)?.ev ?? 0;
    }
    // So is a jump that lands in the reach of a foe the creature stood outside of, when its own routine is worth as much
    // from where it stood and the foe's is worth more against it at the landing: it flies back out on its own turn. A
    // Solar 60 feet from an Ancient Green Dragon jumped to 10 feet for a Radiant Teleport (about 9) and paid a Bite to
    // return to 120 feet, twice in three jumps.
    if (carried && at < engagement.distance
      && !cachedBestOaOption(evaluator, blocks[foe], blocks[actor], engagement.distance, engagement.distance + 5)?.ev
      && evaluator.bestRoutineEvAtDistance(blocks[actor], blocks[foe], engagement.distance, false) >= evaluator.bestRoutineEvAtDistance(blocks[actor], blocks[foe], at, false)
      && evaluator.bestRoutineEvAtDistance(blocks[foe], blocks[actor], at, false) > evaluator.bestRoutineEvAtDistance(blocks[foe], blocks[actor], engagement.distance, false)) {
      ev -= cachedBestOaOption(evaluator, blocks[foe], blocks[actor], at, engagement.distance)?.ev ?? 0;
    }
    // An entry that acts and then may move is worth its action plus what the move gains by the turn's square search; with
    // an action worth nothing now (the buff already held) it is taken for the move alone.
    const acts = ev > 0;
    if (legendary.move?.when === "after") ev += legendaryEntryFlight(blocks, states, actor, engagement, evaluator, lookahead, legendary.move)?.gain ?? 0;
    // The entry's own healing counts for the Hit Points it can actually restore, and only when the action it rides on is usable.
    if (ev > 0 && legendary.selfHeal && !healBlocked(states[actor])) ev += Math.min(rollDice(legendary.selfHeal, () => 0.5, false), states[actor].maxHp - states[actor].hp);
    if (ev > bestEv) {
      best = legendary;
      bestEv = ev;
      bestApproach = approach;
      bestGrant = grant;
      bestActs = acts;
    }
  }
  // A printed Legendary Move competes with the entries above: worth what the turn's square search
  // gains by moving now, within the entry's budget, over standing still. A tie keeps the entry chosen above.
  const move = blocks[actor].legendaryMove;
  if (move) {
    // The Move's own grant, less the stand a Prone mover makes first, or halved by its crawl (`legendaryMoveBudget`).
    const { budget: speed, stands } = legendaryMoveBudget(blocks[actor], states[actor], move);
    const probe: LegendaryMoveProbe = { speed, noProvoke: move.noProvoke };
    if (speed > 0) {
      // A mover that will stand is searched as it will move: standing (Prone lifted for the search and put back). The
      // square it is on and the squares it could reach are then priced in one state, so the stand itself is not priced,
      // and a flier that stands may climb with what is left, as on its own turn.
      const held = states[actor].conditions;
      if (stands) {
        states[actor].conditions = held.filter((c) => c.name !== "prone");
        pruneLinkedConditions(states[actor]);
      }
      chooseMovementAndRoutine(blocks[actor], blocks[foe], states[actor], states[foe], actor, engagement, evaluator, lookahead, probe);
      states[actor].conditions = held;
    }
    if (probe.result && probe.result.gain > bestEv
      && (probe.result.ground !== engagement.ground || probe.result.height !== states[actor].height)) {
      if (log.on) log.push(`${blocks[actor].name} uses legendary ${move.name}`);
      if (stands) {
        // The stand is paid from the Move's grant, not the turn's movement: `movementPenalty` is untouched.
        states[actor].conditions = states[actor].conditions.filter((c) => c.name !== "prone");
        pruneLinkedConditions(states[actor]);
        if (log.on) log.push(`${blocks[actor].name} spends half its Speed to stand (${speed} ft of the Move left)`);
      }
      applyMovement(blocks[actor], states[actor], blocks[foe], states[foe], actor, engagement, probe.result.ground, probe.result.height, rng, log, evaluator, "moves", move.noProvoke, speed, true);
      return;
    }
  }
  if (!best) return;
  const option = blocks[actor].options[best.optionIdx];
  if (best.refreshesUse && option.uses.t === "recharge") {
    const resource = states[actor].recharge.get(option.uses.pool ?? best.optionIdx);
    if (resource) resource.ready = true;
  }
  const entryGrant = bestGrant;
  if (best.move?.when === "before" && bestActs && (bestApproach || actionInRange(option.action, engagement.distance))) {
    // "...moves up to half its Speed, and it makes one Rend attack": the move is the entry's own, paid from its grant.
    // A Prone creature stands with it when the grant covers the stand, in reach already or not, and then attacks.
    if (bestApproach && log.on) log.push(`${blocks[actor].name} closes for legendary ${option.name}`);
    const { budget, stands } = entryGrant!;
    if (stands) {
      states[actor].conditions = states[actor].conditions.filter((c) => c.name !== "prone");
      pruneLinkedConditions(states[actor]);
      if (log.on) log.push(`${blocks[actor].name} spends half its Speed to stand (${budget} ft of the move left)`);
    }
  }
  if (bestApproach && best.move) {
    const { budget } = entryGrant!;
    applyMovement(blocks[actor], states[actor], blocks[foe], states[foe], actor, engagement, bestApproach.ground, bestApproach.height, rng, log, evaluator, "moves", best.move.noProvoke, budget, true);
    if (isDown(blocks[actor], states[actor]) || hasAny(states[actor], RULES_INCAPACITATED)) return;
  }
  if (bestActs) spend(states[actor], best.optionIdx, option);
  // A jump-first entry is in range or not where it lands: `resolveAction` checks there, after the jump.
  const jumpsFirst = actionTeleport(option.action)?.anchor === "destination";
  for (let i = 0; bestActs && i < best.count && !isDown(blocks[foe], states[foe]); i++) {
    if (!jumpsFirst && !actionInRange(option.action, engagement.distance)) break;
    if (log.on) log.push(`${blocks[actor].name} uses legendary ${option.name}`);
    resolveOptionWithTeleport(blocks[actor], blocks[foe], states[actor], states[foe], option.action, rng, actor, engagement, log, evaluator);
    settleAfterAction(blocks[actor], blocks[foe], states[actor], states[foe], actor, engagement, rng, log);
    rollDepletion(states[actor], best.optionIdx, option, rng, log);
    if (isDown(blocks[actor], states[actor])) break;
  }
  // "...and it can fly up to half its Fly Speed": the entry's own flight, searched again now its action is done.
  if (best.move?.when === "after" && !isDown(blocks[actor], states[actor]) && !isDown(blocks[foe], states[foe]) && !hasAny(states[actor], RULES_INCAPACITATED)) {
    const flight = legendaryEntryFlight(blocks, states, actor, engagement, evaluator, lookahead, best.move);
    if (flight) {
      if (log.on) log.push(`${blocks[actor].name} flies as part of legendary ${option.name}`);
      applyMovement(blocks[actor], states[actor], blocks[foe], states[foe], actor, engagement, flight.ground, flight.height, rng, log, evaluator, "moves", best.move.noProvoke, flight.budget, true);
    }
  }
  // "...it uses Consume Memories and regains 5 (1d10) Hit Points": the entry's own healing, after the action it uses.
  if (best.selfHeal && !isDown(blocks[actor], states[actor]) && !healBlocked(states[actor])) {
    const before = states[actor].hp;
    states[actor].hp = Math.min(states[actor].maxHp, before + rollDice(best.selfHeal, rng, false));
    if (log.on && states[actor].hp > before) log.push(`${blocks[actor].name} regains ${states[actor].hp - before} hp (${states[actor].hp} hp)`);
  }
}

function startingEngagement(scenario: Scenario): EngagementState {
  // The ceiling tracks `maxDistance`: every scenario gets as much sky as it has ground.
  // Both fighters start on the floor, so the initial separation is purely horizontal.
  const maxDistance = SCENARIO_MAX_DISTANCE[scenario];
  const ground = 30;
  return { distance: ground, ground, maxDistance, ceiling: maxDistance };
}

function remainingFractions(blocks: [CombatStatblock, CombatStatblock], states: [FighterState, FighterState]): [number, number] {
  return [0, 1].map((i) =>
    Math.min(1, Math.max(0, states[i].hp) / Math.max(1, blocks[i].hpAvg))) as [number, number];
}

/** Where a creature stood, and what it could do, when its movement was chosen. */
interface CensusMovementStart {
  ground: number;
  height: number;
  distance: number;
  speed: number;
  current: number;
  /** The best routine usable from where a Dash began, which the Dash passed over. */
  usable?: RoutineChoice;
  shares: boolean;
  /** Already swallowed when the move began. */
  /** The foe had just moved away on its own turn. */
  chased: boolean;
  swallowed: boolean;
}

/** The movement rules: a creature moves within its Speed, not at all at zero, and does not Dash past a usable option. */
function censusMovement(
  actorBlock: CombatStatblock,
  actorState: FighterState,
  engagement: EngagementState,
  movement: { dash?: boolean },
  actionConsumed: boolean,
  start: CensusMovementStart,
): void {
  const record = census!;
  const dashing = !!movement.dash && !actionConsumed;
  const budget = dashing ? start.speed + start.current : start.speed;
  const voluntaryEnd = actorState.movementBeforeFoeTeleport;
  const ground = Math.abs((voluntaryEnd?.ground ?? engagement.ground) - start.ground);
  const climb = Math.max(0, (voluntaryEnd?.height ?? actorState.height) - start.height);
  const kind = dashing ? "Dash" : "move";
  const moved = `${kind} ${start.distance} ft -> ${engagement.distance} ft (ground ${start.ground} -> ${engagement.ground}, altitude ${start.height} -> ${actorState.height})`;
  // A swallow partway through the move (an opportunity attack's Swallow) carries the mover into its swallower's space
  // (`settleSwallowGeometry`): forced relocation, not the mover's own movement, so neither budget rule reads it.
  const relocated = !start.swallowed && hasCondition(actorState, "swallowed");
  if (!relocated) {
    if ((ground > 0 || climb > 0) && budget === 0) record("movedAtZeroSpeed", actorBlock.name, moved);
    else if (ground > budget || climb > budget) record("overBudget", actorBlock.name, `${moved}, budget ${budget}`);
  }
  // A Dash away is not a Dash past: a creature that cannot win Dashes out of its foe's reach with options in range.
  // Nor is a Dash to close on a foe that has just stepped away (`chooseMovementAndRoutine`): it gives up a thrown option
  // for the melee the walk never reaches.
  if (dashing && start.usable && start.usable.ev > 0 && engagement.ground <= start.ground && !start.chased) record("dashedPastUsableOption", actorBlock.name, `${moved}, an option worth ${start.usable.ev.toFixed(2)} in range at ${start.distance} ft (${start.usable.routine?.name ?? "unnamed"})`);
  if (engagement.distance < MIN_SEPARATION && start.distance >= MIN_SEPARATION && !start.shares) record("movedToZeroSeparation", actorBlock.name, moved);
}

/**
 * The range an applied action may reach, from its compiled fields alone. Mirrors `actionRange`; a corpus test
 * holds the two equal, so this restatement cannot drift silently. Leaf actions only: the hook sees a random
 * action's chosen branch, and self-targeted kinds never reach it.
 */
function censusExpectedRange(action: AttackAction | SaveAction | AutoHitAction): number {
  if (action.kind === "attack") {
    if (action.ranged) return action.longRange ?? action.range ?? 120;
    if (action.melee) return action.reach ?? action.range ?? 5;
    return action.range ?? 5;
  }
  return action.range ?? 120;
}

/**
 * The targeting rules, checked as an action is applied: within its range, with its prerequisite conditions on
 * the target, and against a target it may affect. The engine's guards run first, so a pristine fight records
 * nothing here; the observer derives each expectation itself so a broken guard is still seen. Sight, antimagic
 * and the damage gate are not checked, and the distance is the one the caller passed.
 */
function censusApplication(
  record: CensusRecorder,
  attacker: CombatStatblock,
  defender: CombatStatblock,
  target: Pick<FighterState, "conditions">,
  action: CombatAction,
  source: 0 | 1,
  distance: number,
): void {
  if (action.kind === "random" || action.kind === "selfbuff" || action.kind === "selfheal" || action.kind === "teleport") return;
  const at = `${action.kind} against ${defender.name}`;
  const range = censusExpectedRange(action);
  if (distance > range) record("appliedOutOfRange", attacker.name, `${at} at ${distance} ft, range ${range}`);

  // Mirrors `actionRequirementMet`: the list takes precedence over the single condition, and only conditions
  // this attacker applied count.
  const held = (name: string) => meetsCondition(target, name, source);
  const required = action.requiresTargetConditions || (action.requiresTargetCondition ? [action.requiresTargetCondition] : []);
  const anyOf = action.requiresAnyTargetConditions || [];
  const missing = action.requiresTargetMissingConditions || [];
  const unmet = [
    ...required.filter((name) => !held(name)).map((name) => `lacks ${name}`),
    ...(anyOf.length && !anyOf.some(held) && !target.conditions.some(c => c.source === source && c.willingFor?.toLowerCase() === action.actionName?.split(" (")[0].toLowerCase()) ? [`lacks any of ${anyOf.join(", ")}`] : []),
    ...missing.filter(held).map((name) => `already has ${name}`),
  ];
  if (unmet.length) record("appliedWithoutPrerequisite", attacker.name, `${at}: ${unmet.join("; ")}`);

  // Mirrors `actionTargetable`, without its sight gate.
  const invalid: string[] = [];
  if (action.targetMaxSize !== undefined && defender.size > action.targetMaxSize) invalid.push(`size ${defender.size} above ${action.targetMaxSize}`);
  if (action.targetTypes && !action.targetTypes.includes(defender.creatureType)) invalid.push(`type ${defender.creatureType} not in ${action.targetTypes.join(", ")}`);
  if (action.excludedTargetTypes?.includes(defender.creatureType)) invalid.push(`type ${defender.creatureType} excluded`);
  if (action.kind === "save" && action.excludedTargetTags?.some((tag) => defender.creatureTags.includes(tag))) invalid.push(`tag ${defender.creatureTags.join(", ")} excluded`);
  if (action.kind === "save") {
    for (const name of action.blockedByConditions || []) {
      if (defender.conditionImmune.includes(name)) invalid.push(`immune to ${name}`);
      // Mirrors `actionTargetable`'s rule that an elf cannot be given exhaustion.
      else if (name === "exhaustion" && defender.creatureTags.includes("elf")) invalid.push("an elf, immune to exhaustion");
    }
    if (magicalSleepOnly(action, defender)) invalid.push("magic can't put it to sleep");
  }
  if (invalid.length) record("appliedToInvalidTarget", attacker.name, `${at}: ${invalid.join("; ")}`);
}

/**
 * The use ledger: how many times each limited pool has been spent this fight, counted at the call to `spend`,
 * `spendRebuke` or `spendReaction` rather than read off the balance, so a spend that forgets to decrement is still
 * counted. Budgets come from the compiled block, never from `state.perDay`. A ledger is bound to a fighter's state
 * when the fight starts and follows its block; a successor form replaces the block's `options` array, and a new
 * array starts a fresh ledger for the new form's fresh pools. Recharge, per-turn slots, legendary points and a
 * limited option executed with no spend at all are not counted.
 */
interface CensusLedger {
  block: CombatStatblock;
  options: ActionOption[];
  spent: Map<string, number>;
}
const censusLedgers = new WeakMap<FighterState, CensusLedger>();

function censusBindLedger(block: CombatStatblock, state: FighterState): void {
  censusLedgers.set(state, { block, options: block.options, spent: new Map() });
}

function censusLedgerOf(state: FighterState): CensusLedger | undefined {
  const ledger = censusLedgers.get(state);
  if (ledger && ledger.options !== ledger.block.options) {
    ledger.options = ledger.block.options;
    ledger.spent.clear();
  }
  return ledger;
}

/**
 * A shared pool's budget. Mirrors `initState`: it walks the block's options in the same order as that function's
 * `forEach`, and the LAST option naming the pool sets the budget (a sequence option by its own total, a plain
 * option by its `max`) — matching `perDay.set` being called, and overwriting, on every option that names the
 * pool. A pooled reaction sets the budget only as a fallback when no option claimed the pool key, matching
 * `initState`'s `!perDay.has` guard. The corpus test holds every member of a pool to the same budget, so this
 * ordering is untested there; the unit fixture with unequal members is what exercises it.
 */
function censusPoolBudget(block: CombatStatblock, pool: string | number): number | undefined {
  let budget: number | undefined;
  block.options.forEach((option, idx) => {
    if (option.uses.t !== "perDay" || (option.uses.pool ?? idx) !== pool) return;
    budget = option.sequence ? option.sequence.total : option.uses.max;
  });
  if (budget !== undefined) return budget;
  const uses = block.reaction?.uses;
  return uses?.t === "perDay" && uses.pool === pool ? uses.max : undefined;
}

function censusCountUse(record: CensusRecorder, ledger: CensusLedger, key: string, budget: number, what: string): void {
  const count = (ledger.spent.get(key) ?? 0) + 1;
  ledger.spent.set(key, count);
  if (count > budget) record("perDayOverspent", ledger.block.name, `${what}: use ${count} of ${budget}`);
}

function censusPoolKey(pool: string | number): string {
  return typeof pool === "number" ? `option ${pool}` : `pool ${pool}`;
}

function censusSpend(record: CensusRecorder, state: FighterState, optionIdx: number, option: ActionOption): void {
  const ledger = censusLedgerOf(state);
  if (!ledger || option.uses.t !== "perDay") return;
  // A sustained spell used again while its Concentration lasts is the same casting and spends nothing (`spend`).
  if (sustainedReuse(state, option)) return;
  const pool = option.uses.pool ?? optionIdx;
  censusCountUse(record, ledger, censusPoolKey(pool), censusPoolBudget(ledger.block, pool) ?? option.uses.max, `${option.name}, ${censusPoolKey(pool)}`);
}

function censusSpendRebuke(record: CensusRecorder, state: FighterState, rebuke: Rebuke): void {
  const ledger = censusLedgerOf(state);
  if (!ledger || rebuke.uses.t !== "perDay") return;
  censusCountUse(record, ledger, "rebuke", rebuke.uses.max, `${rebuke.name}, rebuke`);
}

function censusSpendReaction(record: CensusRecorder, block: CombatStatblock, state: FighterState): void {
  const ledger = censusLedgerOf(state);
  const uses = block.reaction?.uses;
  if (!ledger || uses?.t !== "perDay") return;
  if (uses.pool) censusCountUse(record, ledger, censusPoolKey(uses.pool), censusPoolBudget(block, uses.pool) ?? uses.max, `reaction, ${censusPoolKey(uses.pool)}`);
  else censusCountUse(record, ledger, "reaction", uses.max, "reaction");
}

/** The hooks call through this object, so a test may wrap an entry to watch what reaches it as well as call it; the engine never replaces one. */
const censusObservers = {
  application: censusApplication,
  expectedRange: censusExpectedRange,
  bindLedger: censusBindLedger,
  spend: censusSpend,
  spendRebuke: censusSpendRebuke,
  spendReaction: censusSpendReaction,
  afterTurn: censusAfterTurn,
};

/** Test-only: the census observers. Tests call them on inputs no pristine fight can reach, and may wrap them, since the hooks call through this same object. */
export const censusObserversForTest = censusObservers;

/** Test-only: the opportunity-attack option and the melee reach movement prices a foe by. */
export const opportunityAttackForTest = { bestOaOption, meleeReach };

/** Test-only: the bonus-action step and the landing a jump-first option is priced at. */
export const bonusJumpForTest = { bonusActionStep, chooseTeleportGround, jumpFirstAction, separation };

/** Test-only: the escape roll that ends a hold, for the holder damage-share tests. */
export const attachShareForTest = { attemptEscapeIfNeeded };

/** Test-only: the delayed follow-on at the source's turn start, and the hold broken by distance. */
export const entombForTest = { resolveDelayedConditions, settleHoldGeometry };

/** Saving-throw paths, for the condition-save Advantage tests: each called with a scripted rng. */
export const saveRollForTest = { initState, rollSave, applyRiders, applyAura, resolveEndTurnConditions, resolveAction, actionTargetable, incapacitationPersistence, dynamicEv, createPairEvaluator, actionLocksFoe, actionMakesLethalProgress };
/** Exposed for the one-slot-per-turn tests: the use gate, the spend that sets the per-turn slot record, and state. */
export const slotRuleForTest = { initState, usable, spend };
/** The escape decision, priced from what is usable now. */
export const escapeDecisionForTest = { initState, createPairEvaluator, escapeWorthwhile, usableRoutineEvAtDistance };
/** The roll-effect readers, the damage packet, the escape roll and its odds. */
/** The per-turn gate's consumers and the routine price. */
export const oncePerTurnForTest = { initState, resolveAction, applyRiders, createPairEvaluator };
/** The roll, the condition tests and the chooser's price for conditional attack Advantage. */
export const conditionalAdvantageForTest = { initState, resolveAction, dynamicEv, createPairEvaluator, grantedAttackAdvantage, otherAttackAdvantage, applyMovement };
/** Test access for the aura's repeat-save immunity. */
export const auraImmunityForTest = { initState, applyAura, resolveAura, auraApplies, auraImmuneTo, auraThreat, sourceTurnAuraThreat, resolveEndTurnConditions, noteEndedEffects, applyDamage, applyRiders, resolveAction };
/** The damage packet, the action paths, lethal progress and the cap price for Hit Point maximum reductions. */
export const maxHpReductionForTest = { initState, applyDamage, resolveAction, dynamicEv, createPairEvaluator, actionMakesLethalProgress };
/** Test-only: the place-held heal block. */
export const auraHeldHealBlockForTest = { initState, startTurn, applyDamage, resolveAction, resolveAura, dynamicEv, createPairEvaluator, healBlocked, heldHealBlock, bindPlace, auraCost, transformIntoSuccessor, startingEngagement };
export const healBlockLethalProgressForTest = { initState, startTurn, applyRiders, dynamicEv, createPairEvaluator, actionMakesLethalProgress, actionAppliesHealBlock, healBlockHoldsAtNextTurnStart, bindPlace, startingEngagement };
export const regenDeathThresholdForTest = { initState, applyDamage, resolveAction, startTurn, isDown, dynamicEv, createPairEvaluator, actionMakesLethalProgress };
export const mythicResetRestoresForTest = { initState, applyDamage, resolveAction, healBlocked, isDown, heldHealBlock, bindPlace, startingEngagement };
export const healBlockForTest = { initState, startTurn, applyDamage, applyRiders, resolveAction, dynamicEv, createPairEvaluator, healBlocked, auraCost };
/** A turn, the move that provokes, and the state they work on, for opportunity attack aftermath. */
export const pointSightGateForTest = { initState, actionTargetable, actionTargetRange, actionCanMakeProgressCloser, dynamicEv, createPairEvaluator };
export const opportunityAttackAftermathForTest = { initState, takeTurn, applyMovement, createPairEvaluator, startingEngagement };
/** The mid-move Prone, the Incapacitated flier and the routine cut. */
export const incapacitatedMovementForTest = { initState, takeTurn, applyMovement, settleFlight, createPairEvaluator, startingEngagement };
/** The stand-or-crawl, the flight, the wake and the fall, on direct state. */
export const proneCannotStandForTest = { initState, takeTurn, endTurn, applyMovement, settleFlight, resolveAction, settleAfterAction, createPairEvaluator, startingEngagement, isProne };

/** The escape check's Disadvantage sources, its odds, its roll and the decision. */
export const escapeRollForTest = { initState, checkDisadvantageSources, checkOdds, escapeProspect, attemptEscapeIfNeeded, escapeWorthwhile, createPairEvaluator, applyRiders, rollSave, resolveAction };
export const rollEffectForTest = { initState, reliesOnStrength, heldRollEffects, checkOdds, applyDamage, attemptEscapeIfNeeded, escapeWorthwhile, createPairEvaluator, dynamicEv, rollSave, resolveAction, applyRiders };

/** The positional and bookkeeping rules, checked with the turn — and its legendary actions — finished. */
/** The hold's end with its holder, the tick and the turn's end. */
// The cost an option deals its own user, and the down guard of the routine loop.
export const selfCostForTest = { initState, resolveAction, paySelfCost, takeTurn, settleAfterAction, dynamicEv, createPairEvaluator, startingEngagement, isDown };
/** Test-only: the teleport ban a hold carries, at its read sites. */
export const lateRadiusRetaliationForTest = { initState, takeTurn, endTurn, applyMovement, settleAfterAction, settleRebukes, fireRebuke, createPairEvaluator, startingEngagement, isDown };
/** Test-only: the "immediately before the hit" run-up, its spend and its price. */
export const runUpFirstAttackForTest = { initState, takeTurn, applyMovement, legendaryStep, resolveAction, dynamicEv, bestUsableRoutinesAtDistance, actionHasImmediateRunUpGate, createPairEvaluator, startingEngagement };
export const successorMidRoutineForTest = { initState, takeTurn, applyMovement, createPairEvaluator, startingEngagement, isDown };
export const detachExitForTest = { initState, escapeWorthwhile, escapeProspect, attemptEscapeIfNeeded, heldOnlyByAttachment, createPairEvaluator, takeTurn, startingEngagement };
export const legendaryMoveProneForTest = { initState, legendaryStep, legendaryMoveBudget, applyMovement, currentSpeed, movementSpeed, standCost, createPairEvaluator, startingEngagement };
export const partialSpeedCutForTest = { initState, takeTurn, applyMovement, applyRiders, currentSpeed, movementSpeed, cutSpeed, standCost, escapeWorthwhile, legendaryStep, settleFlight, dynamicEv, createPairEvaluator, startingEngagement };
export const teleportBanHoldForTest = { teleportBlocked, applyTeleport, jumpFirstDistance, dynamicEv, endGrapplesOfIncapacitated, attemptEscapeIfNeeded };
export const holdEndsForTest = { initState, applyRiders, resolveAction, resolveConditionDamage, endTurn, releaseHeld, endGrapplesOfIncapacitated, endHoldsOfDowned, resolveEndTurnConditions, startingEngagement, censusAfterTurn };

function censusAfterTurn(
  blocks: [CombatStatblock, CombatStatblock],
  states: [FighterState, FighterState],
  engagement: EngagementState,
  actor: 0 | 1,
  round: number,
): void {
  const record = census!;
  // Applicability at the turn that ends the fight: a corpse's space is not modelled, so `zeroSeparation` and
  // `swallowedApart` are skipped outright rather than checked under a kill name. Every other check still runs,
  // under a separate `<name>AtKill` name, on both creatures for the positional/bookkeeping checks and on the
  // living creature only for the checks below that assume it is still taking turns. This keeps the 15 existing
  // checks' counts exactly equal to a census with no kill-turn checking at all.
  const down: [boolean, boolean] = [isDown(blocks[0], states[0]), isDown(blocks[1], states[1])];
  const kill = down[0] || down[1];
  const suffix = kill ? "AtKill" : "";
  const at = `round ${round}, after ${blocks[actor].name}'s turn`;
  if (!kill && engagement.distance < MIN_SEPARATION && !mayShareSpace(blocks[0], states[0], blocks[1], states[1])) {
    record("zeroSeparation", blocks[actor].name, `${at}: ${engagement.distance} ft apart`);
  }
  if (engagement.ground > engagement.maxDistance || engagement.ground < 0) {
    record(`outsideArena${suffix}`, blocks[actor].name, `${at}: ground ${engagement.ground} of ${engagement.maxDistance}`);
  }
  for (const idx of [0, 1] as const) {
    const block = blocks[idx];
    const state = states[idx];
    const other = blocks[idx === 0 ? 1 : 0];
    if (!kill && hasCondition(state, "swallowed") && engagement.distance > 0) {
      record("swallowedApart", block.name, `${at}: swallowed by ${other.name}, ${engagement.distance} ft away`);
    }
    if (!down[idx]) {
      // A swallowed creature has what its swallow grants for as long as it stays swallowed: not missing, and not
      // held only as a grab's condition that an escape roll takes away.
      const swallow = state.conditions.find((c) => c.name === "swallowed");
      if (swallow) {
        const swallower = blocks[swallow.source];
        for (const name of swallowGrants(swallower)) {
          if (block.conditionImmune.includes(name)) continue;
          // "If the worm dies, any swallowed creature no longer has the Restrained condition" (`releaseHeld`).
          if (name === "restrained" && down[swallow.source]) continue;
          const held = state.conditions.filter((c) => c.name === name);
          if (!held.length) record(`swallowedMissingGrant${suffix}`, block.name, `${at}: swallowed by ${swallower.name} without ${name}`);
          else if (held.every((c) => c.duration === "untilEscape")) {
            record(`swallowedGrantEscapable${suffix}`, block.name, `${at}: swallowed by ${swallower.name}, ${name} only until escape`);
          }
        }
      }
      for (const condition of state.conditions) {
        if (condition.holdReach !== undefined && engagement.distance > condition.holdReach) {
          record(`holdBeyondReach${suffix}`, block.name, `${at}: ${condition.name} with reach ${condition.holdReach} at ${engagement.distance} ft`);
        }
        // A hold ends when its holder cannot hold (`releaseHeld`): no grapple under an incapacitated grappler, and no
        // grapple, attachment or swallow's Restrained from a holder that is down.
        const holder = condition.source;
        if (holder === idx) continue;
        if (down[holder]) {
          if (condition.heldBy || (condition.name === "restrained" && swallow?.source === holder)) {
            record("heldByDownedHolderAtKill", block.name, `${at}: ${condition.name} from ${other.name}, which is down`);
          }
        } else if (condition.heldBy === "grapple" && hasAny(states[holder], RULES_INCAPACITATED)) {
          record(`grappleUnderIncapacitatedGrappler${suffix}`, block.name, `${at}: ${condition.name} from ${other.name}, which is incapacitated`);
        }
      }
      const carried = carriedAloft(blocks, states, idx);
      // Nor is a creature a lift holds up (Telekinesis: `suspended`) aloft on its own.
      if (state.height > 0 && !canFly(block, state) && !hasCondition(state, "swallowed") && !carried && !state.conditions.some((c) => c.suspended)) record(`aloftWithoutFlight${suffix}`, block.name, `${at}: ${state.height} ft up`);
      const grounded = state.conditions.some((c) => !c.speedNotReduced && (SPEED_ZERO.has(c.name) || c.speedZero));
      if (state.height > 0 && canFly(block, state) && !canHover(block, state) && grounded && !carried) {
        record(`aloftAtZeroSpeed${suffix}`, block.name, `${at}: ${state.height} ft up with ${state.conditions.map((c) => c.name).join(", ")}`);
      }
      // An Incapacitated flier that cannot hover falls (`settleFlight`).
      if (state.height > 0 && canFly(block, state) && !canHover(block, state) && !hasCondition(state, "swallowed") && !carried && hasAny(state, RULES_INCAPACITATED)) {
        record(`aloftWhileIncapacitated${suffix}`, block.name, `${at}: ${state.height} ft up with ${state.conditions.map((c) => c.name).join(", ")}`);
      }
      // A flier knocked Prone falls, and climbs again only once it has stood.
      if (state.height > 0 && canFly(block, state) && !canHover(block, state) && !hasCondition(state, "swallowed") && !carried && hasCondition(state, "prone")) {
        record(`aloftWhileProne${suffix}`, block.name, `${at}: ${state.height} ft up with ${state.conditions.map((c) => c.name).join(", ")}`);
      }
    }
    if (state.height > skyRoof(engagement, other) && !hasCondition(state, "swallowed")) record(`aboveCeiling${suffix}`, block.name, `${at}: ${state.height} ft, ceiling ${engagement.ceiling}`);
    if (state.hp > state.maxHp) record(`hpAboveMax${suffix}`, block.name, `${at}: ${state.hp} of ${state.maxHp}`);
    if (state.legendaryResistances < 0) record(`negativeLegendaryResistance${suffix}`, block.name, `${at}: ${state.legendaryResistances}`);
  }
}

/**
 * A printed count rolled when the fight starts (a creature's 1d10 brains).
 * It is drawn from its own stream, keyed by the fight's seed and the fighter's side, so the fight's dice are untouched and a
 * fight changes only where the count shuts an option (`usable`).
 */
function rollStartCount(block: CombatStatblock, seed: number, side: 0 | 1): number | undefined {
  if (!block.startCount) return undefined;
  return rollDice(block.startCount.dice, mulberry32(hashSeed(seed, "startCount", side)), false);
}
export const startCountForTest = rollStartCount;

function fightWithEvaluator(a: CombatStatblock, b: CombatStatblock, seed: number, verbose: boolean, scenario: Scenario, evaluator: PairEvaluator, lookahead = true, buildMessages = false): FightTrace {
  const draw = mulberry32(seed);
  // Counted so the opening turn can tell that nothing has been rolled since initiative (`firstPlans`).
  const dice = evaluator.dice = { n: 0, start: 0 };
  const rng = (): number => { dice.n++; return draw(); };
  const states: [FighterState, FighterState] = [initState(a, 0), initState(b, 1)];
  // Successor forms mutate the active combatant's stat block; clone only those rare
  // participants so the compiled corpus remains immutable across simulations.
  const blocks: [CombatStatblock, CombatStatblock] = [
    a.successor ? structuredClone(a) : a,
    b.successor ? structuredClone(b) : b,
  ];
  if (census) for (const idx of [0, 1] as const) censusObservers.bindLedger(blocks[idx], states[idx]);
  const engagement = startingEngagement(scenario);
  bindPlace(blocks, states, engagement);
  // `buildMessages` is the benchmark/verification ablation: it restores the old cost of building
  // every message in a non-verbose fight. Those lines are still discarded below.
  const log = new FightLog(verbose || buildMessages);
  for (const state of states) state.place!.log = log;
  for (const idx of [0, 1] as const) {
    states[idx].startCount = rollStartCount(blocks[idx], seed, idx);
    if (states[idx].startCount !== undefined && log.on) {
      log.push(`${blocks[idx].name}: ${blocks[idx].startCount!.name} ${states[idx].startCount}`);
    }
  }
  const initA = rollInitiative(a, states[0], rng);
  const initB = rollInitiative(b, states[1], rng);
  const aFirst = initA > initB || (initA === initB && rng() < 0.5);
  const order: [0 | 1, 0 | 1] = aFirst ? [0, 1] : [1, 0];
  dice.start = dice.n;
  if (log.on) log.push(`Initiative: ${a.name} ${initA}, ${b.name} ${initB} (${scenario}, ${engagement.distance} ft)`);
  for (let round = 1; round <= 100; round++) {
    if (log.on) log.push(`Round ${round}`);
    for (const actor of order) {
      // Read liveness off `blocks`, not `a`/`b`: a successor form replaces `blocks[i]`
      // wholesale, and `isDown` branches on the block's regeneration death rule.
      if (isDown(blocks[0], states[0]) || isDown(blocks[1], states[1])) break;
      takeTurn(blocks, states, actor, rng, engagement, log, evaluator, lookahead);
      settleDeathBursts(blocks, states, engagement, rng, log);
      syncConcentration(blocks, states, log);
      legendaryStep(blocks, states, actor, rng, engagement, log, evaluator, lookahead);
      // A creature downed at any point of the turn or of the Legendary step holds nothing once it is over (a turn has
      // exits that do not pass through `endTurn`).
      endHoldsOfDowned(blocks, states, log);
      if (census) censusAfterTurn(blocks, states, engagement, actor, round);
    }
    const down0 = isDown(blocks[0], states[0]);
    const down1 = isDown(blocks[1], states[1]);
    if (down0 || down1) {
      const winner = down0 && down1 ? -1 : down0 ? 1 : 0;
      // Capped at 1: a mythic reset can lift the maximum above `hpAvg`, and the ranking reads a draw's margin
      // from these fractions, so a share above one would push the opponent's below zero.
      const hpPct = winner === -1 ? 0 : Math.min(1, Math.max(0, states[winner].hp) / blocks[winner].hpAvg);
      return { winner, rounds: round, winnerHpPct: hpPct, hpPct: remainingFractions(blocks, states), log: verbose ? log.lines : [] };
    }
  }
  return { winner: -1, rounds: 100, winnerHpPct: 0, hpPct: remainingFractions(blocks, states), log: verbose ? log.lines : [] };
}

export function fight(a: CombatStatblock, b: CombatStatblock, seed = 1, verbose = false, scenario: Scenario = "max30", lookahead = true): FightTrace {
  return fightWithEvaluator(a, b, seed, verbose, resolveScenario(scenario), createPairEvaluator(a, b, true), lookahead);
}

export function runPair(a: CombatStatblock, b: CombatStatblock, iters: number, baseSeed = 1, scenario: Scenario = "max30", options: RunPairOptions = {}): PairResult {
  scenario = resolveScenario(scenario);
  if (options.shortCircuitStalemates !== false && isProvableStalemate(a, b)) {
    // Neither can hurt the other, so both finish untouched and the draw scores dead even.
    return { a: a.name, b: b.name, iters, winsA: 0, winsB: 0, draws: iters, avgRounds: 100, avgWinnerHpPct: 0, drawHpA: 1, drawHpB: 1 };
  }
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let rounds = 0;
  let winnerHp = 0;
  let drawHpA = 0;
  let drawHpB = 0;
  let scoreSum = 0;
  let scoreSquares = 0;
  const memoize = options.memoize !== false;
  const buildMessages = options.elideLogMessages === false;
  const evaluator = createPairEvaluator(
    a,
    b,
    memoize,
    memoize && options.cacheImmutableEv !== false,
    memoize && options.reuseMovementActions !== false,
    options.cacheStats,
    memoize && options.reuseMovementThreats !== false,
    memoize && options.cacheMovementMeta !== false,
  );
  if (memoize && options.reuseFirstPlan !== false) evaluator.firstPlans = new Map();
  // The budget starts at the caller's count and, under adaptive sampling, shrinks once the pilot
  // has shown how settled this pair is. It never grows past what was asked for.
  const adaptive = options.adaptive;
  let budget = iters;
  for (let i = 0; i < budget; i++) {
    const result = fightWithEvaluator(a, b, hashSeed(baseSeed, a.id, b.id, i), false, scenario, evaluator, options.lookahead !== false, buildMessages);
    // The fight's score for A as the ranking reads it (`drawScore`): a draw is worth its hit-point margin.
    let score = 0;
    if (result.winner === 0) { winsA++; score = 1; }
    else if (result.winner === 1) winsB++;
    else {
      draws++;
      drawHpA += result.hpPct[0];
      drawHpB += result.hpPct[1];
      score = 0.5 + (result.hpPct[0] - result.hpPct[1]) / 2;
    }
    scoreSum += score;
    scoreSquares += score * score;
    rounds += result.rounds;
    winnerHp += result.winnerHpPct;
    if (adaptive && i + 1 === adaptive.pilot && adaptive.pilot < budget) {
      const seen = i + 1;
      // Laplace-shrunk (one win and one loss added), so a pilot that goes 50-0 still budgets enough
      // fights to see a rare loss rather than reading zero variance and stopping dead.
      const mean = (scoreSum + 1) / (seen + 2);
      const scoreVariance = (scoreSquares + 1) / (seen + 2) - mean * mean;
      // A pilot of nothing but even draws shows less spread than a 50-0 one. It gets the 50-0 budget,
      // so a pair that decides one fight in fifty is not sized on a pilot that happened to miss it.
      const settled = (seen + 1) / ((seen + 2) * (seen + 2));
      const needed = Math.ceil(Math.max(scoreVariance, settled) / (adaptive.targetSe * adaptive.targetSe)) + 20;
      budget = Math.min(budget, Math.max(adaptive.pilot, needed));
    }
  }
  // `iters` reports what was actually run, so a pair row stays an honest record of its own cost.
  iters = budget;
  return {
    a: a.name, b: b.name, iters, winsA, winsB, draws,
    avgRounds: rounds / iters,
    avgWinnerHpPct: winnerHp / Math.max(1, winsA + winsB),
    drawHpA: drawHpA / Math.max(1, draws),
    drawHpB: drawHpB / Math.max(1, draws),
  };
}

export const srdMechanicsForTest = { attackOrder, difficultGroundStop, resolveEmanationEndTurn, settleEmanationSpeed, bindPlace, carryCost, controlled, movementSpeed, syncConcentration, moveHeights, bodyHeight, legendaryStep, rollSave, bonusActionStep, extinguishIfWorthwhile, usable, spend, reactionAvailable, rebukeAvailable, resolveOptionWithTeleport, settleAfterAction, currentSpeed, initState, applyDamage, dealDamage, resolveAction, startTurn, endTurn, takeTurn, applyRiders, stanchIfWorthwhile, movementProvokeGuard, createPairEvaluator, startingEngagement, bestUsableRoutinesAtDistance, expireClockedConditions, resolveConditionDamage, applyMovement, usableRoutineEvAtDistance, breakPlan, strikeObject, heldObject, actionTargetable, canSee, dynamicEv, holdStakes, escapeProspect, escapeWorthwhile, verticalGap, rollInitiative, liftHeight };


function d20ForDie(sides: number, rng: () => number): number { return 1 + Math.floor(rng() * sides); }

/** Counterspell's reaction is shared with Shield/rebukes, but its own spell uses are tracked separately. */
function tryCounterspell(caster: CombatStatblock, counter: CombatStatblock, casterState: FighterState, counterState: FighterState,
  spell: CombatAction, rng: () => number, source: 0 | 1, distance: number, log: FightLog): boolean {
  const feature = counter.counterspell;
  if (!feature || distance > 60 || counterState.reactionUsed || counterState.conditions.some(c => c.noReactions || (c.noVerbalSpells && feature.option.action.verbal))
    || hasAny(counterState, INCAPACITATING) || isDown(counter, counterState)
    || !canSee(counter, casterState, counterState, distance)) return false;
  const uses = feature.option.uses, key = uses.t === "atWill" ? "counterspell" : uses.pool ?? "counterspell";
  if (uses.t === "perDay" && ((counterState.perDay.get(key) ?? 0) <= 0 || (expendsSpellSlot(feature.option) && counterState.spellSlotSpent))) return false;
  if (uses.t === "recharge" && !counterState.recharge.get(key)?.ready) return false;
  counterState.reactionUsed = true;
  if (census && uses.t === "perDay") {
    const ledger = censusLedgerOf(counterState);
    if (ledger) censusCountUse(census, ledger, censusPoolKey(key), uses.max, `Counterspell, ${censusPoolKey(key)}`);
  }
  if (uses.t === "perDay") counterState.perDay.set(key, counterState.perDay.get(key)! - 1);
  if (uses.t === "recharge") counterState.recharge.get(key)!.ready = false;
  if (expendsSpellSlot(feature.option)) counterState.spellSlotSpent = true;
  if (log.on) log.push(`${counter.name} casts Counterspell`);
  if (feature.option.action.somatic && counterState.conditions.some(c => c.slowCasting) && rng() < 0.25) {
    if (log.on) log.push(`${counter.name}'s Counterspell fails (Slow)`);
    return false;
  }
  if (feature.option.action.components && tryCounterspell(counter, caster, counterState, casterState, feature.option.action, rng, source === 0 ? 1 : 0, distance, log)) return false;
  if (rollSave(caster, casterState, "con", feature.dc, true, rng)) return false;
  if (casterState.legendaryResistances > 0) {
    casterState.legendaryResistances--;
    if (log.on) log.push(`${caster.name} uses Legendary Resistance against Counterspell`);
    return false;
  }
  // A countered slot spell does not expend its slot, although the action used remains spent.
  const option = caster.options.find(o => o.action === spell) ?? (spell.spellName === "Counterspell" ? caster.counterspell?.option : undefined);
  if (option && expendsSpellSlot(option) && option.uses.t === "perDay") {
    const pool = option.uses.pool!;
    casterState.perDay.set(pool, (casterState.perDay.get(pool) ?? 0) + 1);
    casterState.spellSlotSpent = false;
    if (census) {
      const ledger = censusLedgerOf(casterState);
      const key = censusPoolKey(pool);
      if (ledger) ledger.spent.set(key, Math.max(0, (ledger.spent.get(key) ?? 0) - 1));
    }
  }
  if (log.on) log.push(`${caster.name}'s ${spell.spellName ?? "spell"} is countered`);
  return true;
}


/**
 * The chance per round that the foe sets this creature burning again: certain inside an emanation that ignites
 * (the foe's own movement brings it along), otherwise the landing chance of its best at-will attack that ignites.
 */
function reigniteChance(foe: CombatStatblock, foeState: FighterState, target: CombatStatblock, distance: number): number {
  const ignites = (riders?: Rider[]): boolean => !!riders?.some(r => r.condition === "burning");
  const closes = distance - nextTurnSpeed(foe, foeState);
  const aura = foe.sourceTurnAura;
  if (aura && ignites(aura.riders) && aura.radius !== undefined && closes <= aura.radius) return 1;
  let best = 0;
  for (const option of foe.options) {
    const action = option.action;
    if (option.uses.t !== "atWill" || action.kind !== "attack" || !ignites(action.riders)) continue;
    if (closes > Math.max(action.reach ?? 0, action.range ?? 0)) continue;
    best = Math.max(best, riderLandChance(action, target));
  }
  return best;
}

function extinguishIfWorthwhile(block: CombatStatblock, foe: CombatStatblock, state: FighterState, foeState: FighterState,
  actor: 0 | 1, distance: number, evaluator: PairEvaluator, log: FightLog): boolean {
  if (state.bonusSlotUsed && state.conditions.some(c => c.actionOrBonus)) return false;
  const burning = state.conditions.find(c => c.name === "burning" && c.startTurnDamage?.some(d => d.type === "fire" && d.dice.n === 1 && d.dice.d === 4));
  if (!burning || state.conditions.some(c => c.cannotStand)) return false;
  // "Rolling on the ground": a creature in the air has no ground to roll on.
  if (state.height > 0) return false;
  // The fire stays out only until the foe lights it again, so each of the three turns ahead counts by the chance
  // that it has not.
  const relit = reigniteChance(foe, foeState, block, distance);
  const saved = expectedDamage(burning.startTurnDamage!, block, false) * ((1 - relit) + (1 - relit) ** 2 + (1 - relit) ** 3);
  const walked = Math.max(Math.min(distance, MIN_SEPARATION), distance - movementSpeed(block, state));
  if (saved <= Math.max(bestUsableRoutinesAtDistance(block, foe, state, foeState, actor, distance, evaluator).any.ev,
    walked < distance ? bestUsableRoutinesAtDistance(block, foe, state, foeState, actor, walked, evaluator).any.ev : 0)) return false;
  state.conditions = state.conditions.filter(c => c !== burning);
  if (!isProne(state)) state.conditions.push({ name: "prone", duration: "permanent", source: actor, appliedTurn: state.turnCount });
  state.actionSlotUsed = true;
  if (log.on) log.push(`${block.name} extinguishes Burning by dropping Prone and rolling`);
  return true;
}

/** The movement ceiling and the teleport that frees a hold (PS03, PS06), for tests. */
export const holdMovementForTest = { movementCeiling, teleportFreesHold };
