import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drawScore } from "../report/elo.ts";
import { runAllPairs } from "../sim/runner.ts";
import type { CombatStatblock, PairResult, Scenario } from "../types.ts";

export interface GauntletOptions {
  iters: number;
  workers: number;
  seed: number;
  scenario: Scenario;
  onTier?: (tier: Tier) => void;
}

export interface Standing {
  rank: number;
  name: string;
  /** The creature's own CR, which is below the tier's CR for a promoted entrant. */
  nativeCr: number;
  /** The tier this entrant was promoted out of, or undefined for a native. */
  promotedFrom?: number;
  /** Iterations won, counting each drawn iteration by its hit-point margin. */
  points: number;
  games: number;
  /** points / games. Every entrant plays every other, so this alone orders the tier. */
  score: number;
  matchWins: number;
  matchDraws: number;
  matchLosses: number;
  /** Sonneborn-Berger: points taken weighted by the opponent's own points. */
  sb: number;
}

/** Everything the report needs; `gauntlet-<scenario>.csv` round-trips into this. */
export interface TierSummary {
  cr: number;
  natives: number;
  entrants: number;
  standings: Standing[];
  champion: Standing;
  /** Where the creature promoted into this tier finished, if there was one. */
  promoted?: Standing;
}

export interface Tier extends TierSummary {
  pairs: PairResult[];
}

/** A match is decided when one side takes more than half the iterations. */
const MATCH_EPSILON = 1e-9;

export function tierStandings(
  entrants: CombatStatblock[],
  pairs: PairResult[],
  promotedFrom: Map<string, number>,
): Standing[] {
  const names = entrants.map((entrant) => entrant.name);
  const points = new Map(names.map((name) => [name, 0]));
  const games = new Map(names.map((name) => [name, 0]));
  const matchWins = new Map(names.map((name) => [name, 0]));
  const matchDraws = new Map(names.map((name) => [name, 0]));
  const matchLosses = new Map(names.map((name) => [name, 0]));
  const against = new Map(names.map((name) => [name, new Map<string, number>()]));

  const credit = (name: string, opponent: string, taken: number, iters: number) => {
    points.set(name, points.get(name)! + taken);
    games.set(name, games.get(name)! + iters);
    against.get(name)!.set(opponent, taken / iters);
    const margin = taken / iters - 0.5;
    if (margin > MATCH_EPSILON) matchWins.set(name, matchWins.get(name)! + 1);
    else if (margin < -MATCH_EPSILON) matchLosses.set(name, matchLosses.get(name)! + 1);
    else matchDraws.set(name, matchDraws.get(name)! + 1);
  };

  for (const pair of pairs) {
    if (!points.has(pair.a) || !points.has(pair.b)) continue;
    const drawA = drawScore(pair);
    credit(pair.a, pair.b, pair.winsA + drawA, pair.iters);
    credit(pair.b, pair.a, pair.winsB + (pair.draws - drawA), pair.iters);
  }

  const sb = new Map(names.map((name) => [
    name,
    [...against.get(name)!].reduce((sum, [opponent, share]) => sum + share * points.get(opponent)!, 0),
  ]));

  const rows = entrants.map((entrant) => ({
    rank: 0,
    name: entrant.name,
    nativeCr: entrant.cr,
    promotedFrom: promotedFrom.get(entrant.name),
    points: points.get(entrant.name)!,
    games: games.get(entrant.name)!,
    score: games.get(entrant.name)! ? points.get(entrant.name)! / games.get(entrant.name)! : 0,
    matchWins: matchWins.get(entrant.name)!,
    matchDraws: matchDraws.get(entrant.name)!,
    matchLosses: matchLosses.get(entrant.name)!,
    sb: sb.get(entrant.name)!,
  }));

  // Points first. Ties break on the mini-tournament among the tied entrants only (the
  // generalisation of head-to-head), then Sonneborn-Berger, then name for determinism.
  rows.sort((a, b) => b.score - a.score || b.sb - a.sb || a.name.localeCompare(b.name));
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && Math.abs(rows[j].score - rows[i].score) < MATCH_EPSILON) j++;
    if (j - i > 1) {
      const tied = new Set(rows.slice(i, j).map((row) => row.name));
      const mini = new Map([...tied].map((name) => [
        name,
        [...against.get(name)!].filter(([opponent]) => tied.has(opponent)).reduce((sum, [, share]) => sum + share, 0),
      ]));
      rows.splice(i, j - i, ...rows.slice(i, j).sort((a, b) =>
        mini.get(b.name)! - mini.get(a.name)! || b.sb - a.sb || a.name.localeCompare(b.name)));
    }
    i = j;
  }
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

export function tiersByCr(blocks: CombatStatblock[]): { cr: number; natives: CombatStatblock[] }[] {
  const byCr = new Map<number, CombatStatblock[]>();
  for (const block of blocks) {
    if (!byCr.has(block.cr)) byCr.set(block.cr, []);
    byCr.get(block.cr)!.push(block);
  }
  return [...byCr.keys()].sort((a, b) => a - b).map((cr) => ({
    cr,
    natives: byCr.get(cr)!.slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/**
 * A CR-matched round robin per tier, ascending, with the champion of each tier carried up
 * into the next one as an extra entrant. The promotion chain is per scenario: the three
 * distances disagree about who wins a tier, so each runs its own ladder.
 */
export async function runGauntlet(blocks: CombatStatblock[], options: GauntletOptions): Promise<Tier[]> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mcsim-gauntlet-"));
  const promotedFrom = new Map<string, number>();
  const tiers: Tier[] = [];
  try {
    let carried: CombatStatblock | undefined;
    for (const { cr, natives } of tiersByCr(blocks)) {
      const entrants = carried ? [...natives, carried] : natives;
      const pairs = entrants.length < 2 ? [] : await runAllPairs(entrants, {
        iters: options.iters,
        workers: options.workers,
        seed: options.seed,
        resume: false,
        scenario: options.scenario,
        pairsFile: path.join(scratch, `tier-${cr}.csv`),
      });
      const standings = tierStandings(entrants, pairs, promotedFrom);
      const tier: Tier = {
        cr,
        natives: natives.length,
        entrants: entrants.length,
        standings,
        champion: standings[0],
        promoted: carried ? standings.find((row) => row.name === carried!.name) : undefined,
        pairs,
      };
      tiers.push(tier);
      options.onTier?.(tier);
      carried = entrants.find((entrant) => entrant.name === tier.champion.name)!;
      promotedFrom.set(carried.name, cr);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return tiers;
}
