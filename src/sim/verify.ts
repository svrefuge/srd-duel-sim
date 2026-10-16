import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { isProvableStalemate, runPair } from "../engine/fight.ts";
import { pairRow, readPairs } from "../report/csv.ts";
import { SCENARIOS, type CombatStatblock, type Scenario } from "../types.ts";
import { runAllPairs } from "./runner.ts";

export interface VerifyOptions {
  pairs: number;
  iters: number;
  seed: number;
}

/** Compare optimized and reference execution on an even sample plus every successor pair. */
export function verifyOptimizations(blocks: CombatStatblock[], options: VerifyOptions): { checked: number; successorPairs: number; stalematePairs: number } {
  const tasks: [number, number][] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) tasks.push([i, j]);
  }
  const wanted = Math.max(1, Math.min(options.pairs, tasks.length));
  const selected = new Map<string, [number, number]>();
  for (let n = 0; n < wanted; n++) {
    const task = tasks[Math.floor(n * tasks.length / wanted)];
    selected.set(`${task[0]}:${task[1]}`, task);
  }
  let successorPairs = 0;
  let stalematePairs = 0;
  for (const task of tasks) {
    const successor = !!blocks[task[0]].successor || !!blocks[task[1]].successor;
    const stalemate = isProvableStalemate(blocks[task[0]], blocks[task[1]]);
    if (!successor && !stalemate) continue;
    selected.set(`${task[0]}:${task[1]}`, task);
    if (successor) successorPairs++;
    if (stalemate) stalematePairs++;
  }
  for (const [i, j] of selected.values()) {
    for (const scenario of SCENARIOS) {
      const reference = runPair(blocks[i], blocks[j], options.iters, options.seed, scenario, { memoize: false, shortCircuitStalemates: false });
      const optimized = runPair(blocks[i], blocks[j], options.iters, options.seed, scenario, { memoize: true, shortCircuitStalemates: true });
      if (!isDeepStrictEqual(reference, optimized)) {
        throw new Error(`Memoization mismatch for ${blocks[i].name} vs ${blocks[j].name} (${scenario}):\nreference=${JSON.stringify(reference)}\noptimized=${JSON.stringify(optimized)}`);
      }
    }
  }
  return { checked: selected.size * SCENARIOS.length, successorPairs, stalematePairs };
}

/** Recompute the complete reference engine and compare it to serialized sweep output. */
export async function verifySweepOutput(
  blocks: CombatStatblock[],
  outputDir: string,
  iters: number,
  seed: number,
  workers: number,
  scenarios: readonly Scenario[] = SCENARIOS,
  progress?: (scenario: Scenario, phase: "start" | "complete") => void,
): Promise<{ checked: number; mismatches: string[] }> {
  const referenceDir = path.join(outputDir, "reference");
  fs.mkdirSync(referenceDir, { recursive: true });
  const mismatches: string[] = [];
  let checked = 0;
  for (const scenario of scenarios) {
    progress?.(scenario, "start");
    const reference = await runAllPairs(blocks, {
      iters, workers, seed, resume: false, scenario,
      pairsFile: path.join(referenceDir, `pairs-${scenario}.csv`),
      memoize: false,
      shortCircuitStalemates: false,
    });
    const actual = new Map<string, string>(readPairs(`${outputDir}/pairs-${scenario}.csv`)
      .map((row): [string, string] => [`${row.a}|${row.b}`, pairRow(row)]));
    for (const expected of reference) {
      const key = `${expected.a}|${expected.b}`;
      const got = actual.get(key);
      actual.delete(key);
      if (got !== pairRow(expected) && mismatches.length < 20) {
        mismatches.push(`${scenario}: ${key}\nexpected ${pairRow(expected).trim()}\nactual   ${got?.trim() || "missing"}`);
      }
      checked++;
    }
    if (actual.size && mismatches.length < 20) mismatches.push(`${scenario}: ${actual.size} unexpected output rows`);
    progress?.(scenario, "complete");
  }
  return { checked, mismatches };
}
