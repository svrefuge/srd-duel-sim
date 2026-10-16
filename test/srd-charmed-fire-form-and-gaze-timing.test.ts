// A Charmed Fire Elemental and its charmer's space, and a gaze at the start of a turn that ends a condition. Each
// test is written from the printed SRD 5.2.1 text quoted above it; the finding id is in the test name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAll } from '../src/compile.ts';
import { FightLog, srdMechanicsForTest as e } from '../src/engine/fight.ts';
import type { CombatStatblock } from '../src/types.ts';

const blocks = compileAll();
const block = (name: string) => blocks.find((x) => x.name === name)!;
/** A Medium Humanoid bystander with 1000 hit points and no actions of its own. */
const tank = (changes: Partial<CombatStatblock> = {}): CombatStatblock => ({ ...block('Guard'), hpAvg: 1000, options: [], routines: [], ...changes });
const at = (distance: number) => ({ ...e.startingEngagement('max600'), distance, ground: distance });
type State = ReturnType<typeof e.initState>;

/** The end of the Fire Elemental's turn beside `tank()`, every d10 showing 6; returns the log and the damage dealt. */
function elementalTurnEnd(prepare?: (elemental: State) => void) {
  const fire = block('Fire Elemental'), foe = tank(), a = e.initState(fire), d = e.initState(foe), log = new FightLog(true);
  prepare?.(a);
  const before = d.hp;
  e.endTurn([fire, foe], [a, d], 0, at(5), () => 0.5, log);
  return { lines: log.lines, lost: before - d.hp };
}

test('L3-01 a Charmed Fire Elemental does not enter its charmer\'s space to burn it', () => {
  // p178, Charmed: "You can't attack the charmer or target the charmer with damaging abilities or magical effects."
  // p284, Fire Form: "it can enter a creature's space and stop there. The first time it enters a creature's space on a
  // turn, that creature takes 5 (1d10) Fire damage." Fire Aura, an Emanation that targets no one, still burns: 6, not 12.
  const { lines, lost } = elementalTurnEnd((a) => { a.conditions.push({ name: 'charmed', duration: 'permanent', source: 1, appliedTurn: 0 }); });
  assert.ok(!lines.some((l) => /Fire Form/.test(l)), lines.join('\n'));
  assert.equal(lost, 6);
});

test('L3-01 control: not Charmed, it enters and both Fire Form and Fire Aura burn', () => {
  const { lines, lost } = elementalTurnEnd();
  assert.ok(lines.some((l) => /enters Guard's space \(Fire Form\)/.test(l)));
  assert.equal(lost, 12);
});

/** The start of the Guard's turn 20 feet from a Chain Devil; returns whether Unnerving Gaze was used and the devil's state. */
function gazeAtTurnStart(prepare?: (devil: State, foe: State) => void) {
  const devil = block('Chain Devil'), foe = tank(), a = e.initState(devil), b = e.initState(foe), log = new FightLog(true);
  prepare?.(a, b);
  e.takeTurn([devil, foe], [a, b], 1, () => 0, at(20), log, e.createPairEvaluator(devil, foe, true), false);
  return { gazed: log.lines.includes('Chain Devil uses Unnerving Gaze'), devil: a };
}

test('L3-02 Unnerving Gaze is not taken at the start of the turn that ends the devil\'s Incapacitated condition', () => {
  // p187, Simultaneous Effects: "the person at the game table ... whose turn it is decides the order in which those
  // things happen. For example, if two effects occur at the start of a player character's turn, the player decides
  // which of the effects happens first." p292, Banish (Adult Gold Dragon): "the target has the Incapacitated condition
  // and is transported to a harmless demiplane until the start of the dragon's next turn". p273, Unnerving Gaze:
  // "Trigger: A creature the devil can see starts its turn within 30 feet". The creature whose turn starts has the
  // trigger checked first, while the devil cannot react: no gaze, and the Reaction is not spent.
  const { gazed, devil } = gazeAtTurnStart((a) => { a.conditions.push({ name: 'incapacitated', duration: 'startOfSourceNextTurn', source: 1, appliedTurn: 0 }); });
  assert.equal(gazed, false);
  assert.equal(devil.reactionUsed, false);
  assert.equal(devil.conditions.length, 0); // the condition did end at the start of that turn
});

test('L3-02 nor at the start of the turn that ends the Blinded condition of the creature starting it', () => {
  // "starts its turn within 30 feet of the devil and can see the devil": Blinded "until the start of its next turn",
  // it has the trigger checked before its sight returns.
  const { gazed, devil } = gazeAtTurnStart((_, b) => { b.conditions.push({ name: 'blinded', duration: 'startOfTargetNextTurn', source: 0, appliedTurn: -1 }); });
  assert.equal(gazed, false);
  assert.equal(devil.reactionUsed, false);
});

test('L3-02 control: with nothing ending at the start of the turn, the gaze is used', () => {
  const { gazed, devil } = gazeAtTurnStart();
  assert.equal(gazed, true);
  assert.equal(devil.reactionUsed, true);
});
