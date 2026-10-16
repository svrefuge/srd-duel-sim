import type { CombatStatblock } from "../types.ts";

type Sight = Pick<CombatStatblock, "blindsight" | "truesight" | "truesightRange" | "blindBeyond">;

/** Truesight enhances physical vision; Blindsight does not require it. */
export function seesInvisible(observer: Sight, blinded: boolean, distance: number): boolean {
  if ((observer.blindsight ?? 0) > 0 && distance <= observer.blindsight!) return true;
  if (blinded || (observer.blindBeyond !== undefined && distance > observer.blindBeyond)) return false;
  // Old hand-authored blocks used the boolean. Compiled creatures always supply a range.
  const range = observer.truesightRange ?? (observer.truesight ? Infinity : 0);
  return range > 0 && distance <= range;
}

export function seesTarget(observer: Sight, blinded: boolean, invisible: boolean, distance: number): boolean {
  if ((observer.blindsight ?? 0) > 0 && distance <= observer.blindsight!) return true;
  if (blinded || (observer.blindBeyond !== undefined && distance > observer.blindBeyond)) return false;
  return !invisible || seesInvisible(observer, blinded, distance);
}

/** Farthest target this observer can currently see, for approach planning. */
export function sightRange(observer: Sight, blinded: boolean, invisible: boolean): number {
  const physical = blinded ? 0 : Math.min(observer.blindBeyond ?? Infinity,
    invisible ? (observer.truesightRange ?? (observer.truesight ? Infinity : 0)) : Infinity);
  return Math.max(observer.blindsight ?? 0, physical);
}
