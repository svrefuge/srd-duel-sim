import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { outDir } from "../compile.ts";
import { runPair } from "../engine/fight.ts";
import { pairHeader, pairRow, parseCsvLine } from "../report/csv.ts";
import { crToNumber } from "../tables.ts";
import type { CombatStatblock, PairResult, Scenario } from "../types.ts";

export interface RunOptions {
  iters: number;
  workers: number;
  seed: number;
  resume: boolean;
  only?: string;
  scenario: Scenario;
  pairsFile?: string;
  memoize?: boolean;
  shortCircuitStalemates?: boolean;
  lookahead?: boolean;
  /** Size each pair from a pilot run instead of using the full fight count. */
  adaptive?: { pilot: number; targetSe: number };
}

export function filterBlocks(blocks: CombatStatblock[], only?: string): CombatStatblock[] {
  if (!only) return blocks;
  // `source=<code>` restricts the corpus to one bestiary, so a single book can be ranked on its own
  // without the others distorting the Elo fit.
  const bySource = only.match(/^source\s*[=:]\s*(\w+)$/i);
  if (bySource) {
    const want = bySource[1].toUpperCase();
    return blocks.filter((b) => b.source.toUpperCase() === want);
  }
  // A CR is written as a decimal or as a printed fraction (`cr<=1/2`).
  const match = only.match(/^cr\s*(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?|\d+\/\d+)$/i);
  if (!match) return blocks.filter((b) => b.name.toLowerCase().includes(only.toLowerCase()));
  const op = match[1];
  const value = crToNumber(match[2]);
  return blocks.filter((b) => op === "<=" ? b.cr <= value : op === ">=" ? b.cr >= value : op === "<" ? b.cr < value : op === ">" ? b.cr > value : b.cr === value);
}

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

/** Bounds on how many pairs one worker is handed at a time; see `runAllPairs`. */
const MAX_BATCH = 2048;
const MIN_BATCH = 16;

export async function runAllPairs(blocksIn: CombatStatblock[], options: RunOptions): Promise<PairResult[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const blocks = filterBlocks(blocksIn, options.only);
  // Scenario-scoped by default. A shared `pairs.csv` made `--resume` unsafe across scenarios:
  // the second run would read the first's pair keys and silently skip every matchup.
  const pairsFile = options.pairsFile || path.join(outDir, `pairs-${options.scenario}.csv`);
  const existing = new Set<string>();
  if (options.resume && fs.existsSync(pairsFile)) {
    const lines = fs.readFileSync(pairsFile, "utf8").trim().split(/\n/).slice(1);
    for (const line of lines) {
      const [a, b] = parseCsvLine(line);
      existing.add(pairKey(a, b));
    }
  } else {
    fs.writeFileSync(pairsFile, pairHeader());
  }

  const tasks: [number, number][] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (!existing.has(pairKey(blocks[i].name, blocks[j].name))) tasks.push([i, j]);
    }
  }

  if (options.workers <= 1 || tasks.length < 20) {
    const rows: PairResult[] = [];
    for (const [i, j] of tasks) {
      const row = runPair(blocks[i], blocks[j], options.iters, options.seed, options.scenario, {
        memoize: options.memoize,
        shortCircuitStalemates: options.shortCircuitStalemates,
        lookahead: options.lookahead,
        adaptive: options.adaptive,
      });
      fs.appendFileSync(pairsFile, pairRow(row));
      rows.push(row);
    }
    return rows;
  }

  const workerCount = Math.min(options.workers, tasks.length);
  const workerUrl = fileURLToPath(import.meta.url);
  const allRows: PairResult[] = [];
  // Work is handed out on demand rather than partitioned up front. A fixed round-robin split gave
  // every worker the same number of pairs, but not the same amount of time: on a 10-core M1 Max one
  // worker finished a third of the way before the rest and its core then sat idle — 5.7% of the
  // max30 sweep's wall time, 8.1% of max120's. See `out/fight-loop-speedups-notes.md`.
  let cursor = 0;
  const nextBatch = (): [number, number][] | undefined => {
    if (cursor >= tasks.length) return undefined;
    // Large enough that a round trip (well under a millisecond) disappears against the batch's own
    // work, and shrinking as the queue drains so no worker is left holding the last long job alone.
    const size = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.ceil((tasks.length - cursor) / (workerCount * 8))));
    const batch = tasks.slice(cursor, cursor + size);
    cursor += batch.length;
    return batch;
  };
  // One failure ends the run: the siblings are terminated rather than left to finish the sweep around a hole in
  // the pairs file, and the error reaches the caller at once.
  const workers: Worker[] = [];
  await Promise.all(Array.from({ length: workerCount }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: {
      blocks, iters: options.iters, seed: options.seed, scenario: options.scenario,
      memoize: options.memoize, shortCircuitStalemates: options.shortCircuitStalemates,
      lookahead: options.lookahead,
      adaptive: options.adaptive,
    } });
    workers.push(worker);
    const fail = (error: Error): void => {
      for (const other of workers) if (other !== worker) void other.terminate();
      reject(error);
    };
    const dispatch = (): void => {
      const batch = nextBatch();
      worker.postMessage(batch ? { tasks: batch } : { done: true });
    };
    worker.on("message", (message: { results: PairResult[] }) => {
      // Refill before touching the disk: the worker is computing again while the append runs.
      dispatch();
      fs.appendFileSync(pairsFile, message.results.map(pairRow).join(""));
      allRows.push(...message.results);
    });
    worker.on("error", fail);
    worker.on("exit", (code) => code ? fail(new Error(`worker exited ${code}`)) : resolve());
    dispatch();
  })));
  return allRows;
}

if (!isMainThread) {
  const { blocks, iters, seed, scenario, memoize, shortCircuitStalemates, lookahead, adaptive } = workerData as {
    blocks: CombatStatblock[]; iters: number; seed: number; scenario: Scenario;
    memoize?: boolean; shortCircuitStalemates?: boolean; lookahead?: boolean;
    adaptive?: { pilot: number; targetSe: number };
  };
  // Every pair a batch names is run here, all its iterations together, in the order the queue
  // handed them over. A pair's seeds come from its own two ids, so which worker takes it, and
  // when, changes nothing about the fights it runs.
  parentPort!.on("message", (message: { tasks?: [number, number][] }) => {
    if (!message.tasks) {
      parentPort!.close();
      return;
    }
    const results: PairResult[] = [];
    for (const [i, j] of message.tasks) {
      results.push(runPair(blocks[i], blocks[j], iters, seed, scenario, { memoize, shortCircuitStalemates, lookahead, adaptive }));
    }
    parentPort!.postMessage({ results });
  });
}
