#!/usr/bin/env node
// Writes the verbose log of one fight per pair, for every pair in the corpus, as gzipped JSONL.
//   node src/fight-logs.ts [--scenario max120 --seed 1 --workers 9 --out DIR]
// One line per pair: {a, b, scenario, seed, winner, rounds, winnerHpPct, log: [...]}. Each worker takes
// every Nth pair and writes its own part file, so the parts together hold each pair exactly once.
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { compileAll } from "./compile.ts";
import { fight } from "./engine/fight.ts";
import { resolveScenario } from "./types.ts";
import { arg } from "./args.ts";

const FLUSH_EVERY = 500;

const scenario = resolveScenario(arg("--scenario", "max120") as Parameters<typeof resolveScenario>[0]);
const seed = Number(arg("--seed", "1"));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(arg("--out", path.join(root, "out", `fight-logs-${scenario}-s${seed}`))!);
const partFile = (part: number) => path.join(outDir, `part-${String(part).padStart(2, "0")}.jsonl.gz`);

function runPart(part: number, parts: number): void {
  const blocks = compileAll();
  const file = partFile(part);
  fs.rmSync(file, { force: true });
  let lines: string[] = [];
  let fights = 0;
  let errors = 0;
  // Each flush appends a complete gzip member; concatenated members read back as one stream.
  const flush = () => {
    if (!lines.length) return;
    fs.appendFileSync(file, zlib.gzipSync(lines.join("\n") + "\n"));
    lines = [];
  };
  let k = 0;
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (k++ % parts !== part) continue;
      const a = blocks[i];
      const b = blocks[j];
      try {
        const result = fight(a, b, seed, true, scenario);
        const winner = result.winner === 0 ? a.name : result.winner === 1 ? b.name : "draw";
        lines.push(JSON.stringify({ a: a.name, b: b.name, scenario, seed, winner, rounds: result.rounds, winnerHpPct: result.winnerHpPct, log: result.log }));
      } catch (error) {
        errors++;
        lines.push(JSON.stringify({ a: a.name, b: b.name, scenario, seed, error: String(error) }));
      }
      fights++;
      if (lines.length >= FLUSH_EVERY) flush();
    }
  }
  flush();
  process.send?.({ part, fights, errors });
}

async function main(): Promise<void> {
  const parts = Number(arg("--workers", String(Math.max(1, (navigator.hardwareConcurrency || 2) - 1))));
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) if (/^part-\d+\.jsonl\.gz$/.test(name)) fs.rmSync(path.join(outDir, name));
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: parts }, (_, part) => new Promise<{ part: number; fights: number; errors: number }>((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--scenario", scenario, "--seed", String(seed), "--out", outDir, "--part", String(part), "--parts", String(parts)]);
    let report: { part: number; fights: number; errors: number } | undefined;
    child.on("message", (message) => { report = message as typeof report; });
    child.on("exit", (code) => (code === 0 && report ? resolve(report) : reject(new Error(`part ${part} exited with code ${code}`))));
  })));
  const fights = results.reduce((sum, r) => sum + r.fights, 0);
  const errors = results.reduce((sum, r) => sum + r.errors, 0);
  const bytes = results.reduce((sum, r) => sum + fs.statSync(partFile(r.part)).size, 0);
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ scenario, seed, parts, fights, errors, bytes, written: new Date().toISOString() }, null, 2) + "\n");
  console.log(`${fights} fights (${errors} errors) in ${((Date.now() - started) / 1000).toFixed(1)} s, ${(bytes / 1e6).toFixed(1)} MB gzipped -> ${path.relative(process.cwd(), outDir)}`);
}

if (arg("--part") !== undefined) runPart(Number(arg("--part")), Number(arg("--parts")));
else await main();
