#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { excludedPath, loadCompiled, outDir, statblocksPath, writeCompiled } from "./compile.ts";
import { writeCoverage } from "./coverage.ts";
import { fight, runPair } from "./engine/fight.ts";
import { csv, parseCsvLine, readPairs, writeMatrix } from "./report/csv.ts";
import { crCompareMarkdown, readRankingCsv } from "./report/crCompare.ts";
import { fmtCr, gauntletMarkdown, pairsCsv, readStandingsCsv, standingsCsv } from "./report/gauntletReport.ts";
import { writeRanking } from "./report/elo.ts";
import { scenarioComparisonMarkdown } from "./report/scenarioCompare.ts";
import { runGauntlet, type Tier, type TierSummary } from "./gauntlet/gauntlet.ts";
import { runAllPairs, filterBlocks } from "./sim/runner.ts";
import { verifyOptimizations, verifySweepOutput } from "./sim/verify.ts";
import { resolveScenario, SCENARIOS, SWEEP_SCENARIOS, type Scenario } from "./types.ts";
import { arg, flag } from "./args.ts";

function parseScenario(value: string | undefined, fallback: Scenario = "max600"): Scenario {
  return resolveScenario(value ?? fallback);
}

function scenarioArg(): Scenario {
  return parseScenario(arg("--scenario"));
}

const scenarioRankColumn: Record<Scenario, string> = {
  max30: "max30_rank",
  max120: "max120_rank",
  max600: "max600_rank",
};

function readRankMap(file: string): Map<string, { cr: number; rank: number }> {
  const rows = new Map<string, { cr: number; rank: number }>();
  for (const line of fs.readFileSync(file, "utf8").trim().split(/\n/).slice(1)) {
    const cols = parseCsvLine(line);
    rows.set(cols[1], { rank: Number(cols[0]), cr: Number(cols[2]) });
  }
  return rows;
}

const scenarioRankHeading: Record<Scenario, string> = {
  max30: "30-foot Arena Rank",
  max120: "120-foot Arena Rank",
  max600: "Unlimited Rank",
};

/** One row per creature with its rank in each scenario a ranking file was given for. */
function writeCombinedRankings(files: Partial<Record<Scenario, string>>): number {
  const scenarios = SCENARIOS.filter((scenario) => files[scenario]);
  const byScenario = Object.fromEntries(scenarios.map((scenario) => [scenario, readRankMap(files[scenario]!)])) as Record<Scenario, Map<string, { cr: number; rank: number }>>;
  const names = new Set(scenarios.flatMap((scenario) => [...byScenario[scenario].keys()]));
  const rows = [...names].map((name) => ({
    name,
    cr: scenarios.map((scenario) => byScenario[scenario].get(name)?.cr).find((value) => value !== undefined) || 0,
    ranks: Object.fromEntries(scenarios.map((scenario) => [scenario, byScenario[scenario].get(name)?.rank ?? ""])) as Record<Scenario, number | string>,
  })).sort((a, b) => b.cr - a.cr || a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(outDir, "ranking-combined.csv"), [
    ["cr", "name", ...scenarios.map((scenario) => scenarioRankColumn[scenario])].join(","),
    ...rows.map((row) => [row.cr, csv(row.name), ...scenarios.map((scenario) => row.ranks[scenario])].join(",")),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "ranking-combined.md"), [
    `| CR | Creature | ${scenarios.map((scenario) => scenarioRankHeading[scenario]).join(" | ")} |`,
    `|---:|---|${scenarios.map(() => "---:|").join("")}`,
    ...rows.map((row) => `| ${fmtCr(row.cr)} | ${row.name} | ${scenarios.map((scenario) => row.ranks[scenario]).join(" | ")} |`),
  ].join("\n") + "\n");
  return rows.length;
}

/** File-name suffix that keeps a filtered ladder from overwriting the full-corpus one. */
function gauntletSuffix(label: string | undefined, only: string | undefined): string {
  const slug = (label ?? only ?? "").replace(/^source\s*[=:]\s*/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug ? `-${slug}` : "";
}

function adaptiveArg(): { pilot: number; targetSe: number } | undefined {
  if (!flag("--adaptive")) return undefined;
  const pilot = Number(arg("--pilot", "70"));
  const targetSe = Number(arg("--target-se", "0.02"));
  if (!Number.isInteger(pilot) || pilot < 1 || !Number.isFinite(targetSe) || targetSe <= 0) {
    throw new Error("--pilot must be a positive integer and --target-se must be positive and finite");
  }
  return { pilot, targetSe };
}

function findMonster(name: string) {
  const blocks = loadCompiled();
  const found = blocks.find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`Monster not found: ${name}`);
  return found;
}

async function main() {
  const cmd = process.argv[2] || "help";
  if (cmd === "compile") {
    const t0 = performance.now();
    const blocks = writeCompiled();
    const md = writeCoverage(blocks);
    const excluded = fs.existsSync(excludedPath) ? JSON.parse(fs.readFileSync(excludedPath, "utf8")) : [];
    console.log(`Compiled ${blocks.length} monsters to ${statblocksPath}`);
    console.log(`Excluded ${excluded.length} non-rankable records; details in ${excludedPath}`);
    console.log(`Wrote coverage (${md.length} bytes) to ${path.join(outDir, "coverage.md")}`);
    console.log(`Elapsed ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    return;
  }
  if (cmd === "coverage") {
    const blocks = loadCompiled();
    const md = writeCoverage(blocks);
    console.log(md.split("\n").slice(0, 18).join("\n"));
    console.log(`\nFull report: ${path.join(outDir, "coverage.md")}`);
    return;
  }
  if (cmd === "fight") {
    const aName = process.argv[3];
    const bName = process.argv[4];
    if (!aName || !bName) throw new Error('Usage: node src/cli.ts fight "A" "B" [--iters N] [--seed S] [--verbose] [--scenario max30|max120|max600] [--no-lookahead]');
    const a = findMonster(aName);
    const b = findMonster(bName);
    const iters = Number(arg("--iters", "1"));
    const seed = Number(arg("--seed", "1"));
    const scenario = scenarioArg();
    const lookahead = !flag("--no-lookahead");
    if (iters <= 1) {
      const result = fight(a, b, seed, flag("--verbose"), scenario, lookahead);
      console.log(JSON.stringify({ winner: result.winner === 0 ? a.name : result.winner === 1 ? b.name : "draw", rounds: result.rounds, winnerHpPct: result.winnerHpPct, scenario }, null, 2));
      if (flag("--verbose")) console.log(result.log.join("\n"));
    } else {
      console.log(JSON.stringify(runPair(a, b, iters, seed, scenario, { lookahead }), null, 2));
    }
    return;
  }
  if (cmd === "run") {
    const blocks = loadCompiled();
    const scenario = scenarioArg();
    // `--tag` scopes every output file to a sub-corpus run (`pairs-xmm-max600.csv`), so a filtered
    // sweep can never append to or resume from the authoritative all-bestiary corpus.
    const tag = arg("--tag");
    const suffix = tag ? `${tag}-${scenario}` : scenario;
    const pairsFile = path.join(outDir, `pairs-${suffix}.csv`);
    const t0 = performance.now();
    const rows = await runAllPairs(blocks, {
      iters: Number(arg("--iters", "200")),
      workers: Number(arg("--workers", String(Math.max(1, (navigator.hardwareConcurrency || 2) - 1)))),
      seed: Number(arg("--seed", "1")),
      resume: flag("--resume"),
      only: arg("--only"),
      scenario,
      pairsFile,
      lookahead: !flag("--no-lookahead"),
      adaptive: adaptiveArg(),
    });
    const allRows = readPairs(pairsFile);
    writeMatrix(filterBlocks(blocks, arg("--only")), allRows, path.join(outDir, `matrix-${suffix}.csv`));
    console.log(`Wrote ${rows.length} new pairs to ${pairsFile}`);
    console.log(`Elapsed ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    return;
  }
  if (cmd === "analyze") {
    const blocks = loadCompiled();
    const iters = Number(arg("--iters", "200"));
    const workers = Number(arg("--workers", String(Math.max(1, (navigator.hardwareConcurrency || 2) - 1))));
    const seed = Number(arg("--seed", "1"));
    const t0 = performance.now();
    for (const scenario of SWEEP_SCENARIOS) {
      const pairsFile = path.join(outDir, `pairs-${scenario}.csv`);
      const rows = await runAllPairs(blocks, { iters, workers, seed, resume: flag("--resume"), scenario, pairsFile, lookahead: !flag("--no-lookahead"), adaptive: adaptiveArg() });
      const allRows = readPairs(pairsFile);
      writeMatrix(blocks, allRows, path.join(outDir, `matrix-${scenario}.csv`));
      writeRanking(blocks, allRows, path.join(outDir, `ranking-${scenario}.csv`));
      console.log(`${scenario}: wrote ${rows.length} new pairs (${allRows.length} total)`);
    }
    const rankingFiles = Object.fromEntries(SWEEP_SCENARIOS.map((scenario) => [scenario, path.join(outDir, `ranking-${scenario}.csv`)])) as Partial<Record<Scenario, string>>;
    const combinedCount = writeCombinedRankings(rankingFiles);
    const rankings = Object.fromEntries(SWEEP_SCENARIOS.map((scenario) => [scenario, readRankingCsv(rankingFiles[scenario]!)])) as Partial<Record<Scenario, ReturnType<typeof readRankingCsv>>>;
    fs.writeFileSync(path.join(outDir, "scenario-comparison.md"), scenarioComparisonMarkdown(rankings));
    console.log(`Combined ${combinedCount} creatures; elapsed ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    return;
  }
  if (cmd === "gauntlet") {
    const blocks = loadCompiled();
    const iters = Number(arg("--iters", "1000"));
    const seed = Number(arg("--seed", "1"));
    const workers = Number(arg("--workers", String(Math.max(1, (navigator.hardwareConcurrency || 2) - 1))));
    const scenarios = arg("--scenario") ? [parseScenario(arg("--scenario"))] : [...SCENARIOS];
    const top = Number(arg("--top", "5"));
    // `--only` narrows the corpus before tiering, so a single book can run its own ladder.
    // `--label` keeps its output beside the full-corpus run instead of overwriting it.
    const only = arg("--only");
    const suffix = gauntletSuffix(arg("--label"), only);
    const corpus = filterBlocks(blocks, only);
    if (!corpus.length) throw new Error(`--only ${only} matched no creatures`);
    if (only) console.log(`Corpus filtered to ${corpus.length} of ${blocks.length} creatures by --only ${only}`);
    const t0 = performance.now();
    const tiers = {} as Record<Scenario, Tier[]>;
    for (const scenario of scenarios) {
      tiers[scenario] = await runGauntlet(corpus, {
        iters, workers, seed, scenario,
        onTier: (tier) => console.log(`${scenario} CR ${tier.cr}: ${tier.entrants} entrants, champion ${tier.champion.name}${tier.promoted ? ` (promoted ${tier.promoted.name} finished ${tier.promoted.rank})` : ""}`),
      });
      fs.writeFileSync(path.join(outDir, `gauntlet${suffix}-${scenario}.csv`), standingsCsv(tiers[scenario]));
      fs.writeFileSync(path.join(outDir, `gauntlet-pairs${suffix}-${scenario}.csv`), pairsCsv(tiers[scenario]));
    }
    if (scenarios.length === SCENARIOS.length) {
      const mdFile = path.join(outDir, `gauntlet${suffix}.md`);
      fs.writeFileSync(mdFile, gauntletMarkdown({ tiers, iters, seed, corpus: corpus.length, top, only }));
      console.log(`Wrote ${mdFile}`);
    }
    console.log(`Elapsed ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    return;
  }
  if (cmd === "gauntletreport") {
    // Re-render out/gauntlet.md from the standings CSVs, so changing the report never costs a re-run.
    const only = arg("--only");
    const suffix = gauntletSuffix(arg("--label"), only);
    const tiers = Object.fromEntries(SCENARIOS.map((scenario) =>
      [scenario, readStandingsCsv(path.join(outDir, `gauntlet${suffix}-${scenario}.csv`))])) as Record<Scenario, TierSummary[]>;
    const corpus = new Set(SCENARIOS.flatMap((scenario) => tiers[scenario].flatMap((tier) => tier.standings.map((row) => row.name)))).size;
    const md = gauntletMarkdown({
      tiers, corpus,
      iters: Number(arg("--iters", "1000")),
      seed: Number(arg("--seed", "1")),
      top: Number(arg("--top", "5")),
      only,
    });
    const mdFile = path.join(outDir, `gauntlet${suffix}.md`);
    fs.writeFileSync(mdFile, md);
    console.log(`Wrote ${mdFile}`);
    return;
  }
  if (cmd === "rank") {
    const blocks = loadCompiled();
    const scenario = scenarioArg();
    const tag = arg("--tag");
    const suffix = tag ? `${tag}-${scenario}` : scenario;
    const pairsFile = path.join(outDir, `pairs-${suffix}.csv`);
    const pairs = readPairs(pairsFile);
    if (!pairs.length) throw new Error(`No ${path.basename(pairsFile)} found. Run \`node src/cli.ts run --scenario ${scenario}\` first.`);
    const rankingFile = path.join(outDir, `ranking-${suffix}.csv`);
    writeRanking(filterBlocks(blocks, arg("--only")), pairs, rankingFile);
    console.log(`Wrote ${rankingFile}`);
    return;
  }
  if (cmd === "combine") {
    // The sweep scenarios by default; max600 joins only when its ranking file is named.
    const max600 = arg("--max600", arg("--open"));
    const files: Partial<Record<Scenario, string>> = {
      max30: path.join(outDir, arg("--max30", arg("--arena", "ranking-max30.csv"))!),
      max120: path.join(outDir, arg("--max120", arg("--arena120", "ranking-max120.csv"))!),
      ...(max600 ? { max600: path.join(outDir, max600) } : {}),
    };
    const count = writeCombinedRankings(files);
    const rankings = Object.fromEntries(SCENARIOS.filter((scenario) => files[scenario]).map((scenario) => [scenario, readRankingCsv(files[scenario]!)])) as Partial<Record<Scenario, ReturnType<typeof readRankingCsv>>>;
    fs.writeFileSync(path.join(outDir, "scenario-comparison.md"), scenarioComparisonMarkdown(rankings));
    console.log(`Wrote combined rankings and scenario-comparison.md (${count} creatures)`);
    return;
  }
  if (cmd === "crcompare") {
    // Spearman rho between Elo and CR plus biggest over/under-performers vs. CR.
    const file = arg("--ranking", `ranking-${scenarioArg()}.csv`)!;
    const label = file.replace(/^ranking-?/, "").replace(/\.csv$/, "") || "latest";
    const rows = readRankingCsv(path.join(outDir, file));
    const md = crCompareMarkdown(rows, label);
    const outFile = path.join(outDir, `cr-compare-${label}.md`);
    fs.writeFileSync(outFile, md);
    console.log(md.split("\n").slice(0, 30).join("\n"));
    console.log(`\nFull report: ${outFile}`);
    return;
  }
  if (cmd === "benchmark") {
    const a = findMonster(arg("--a", "Goblin Warrior")!);
    const b = findMonster(arg("--b", "Guard")!);
    const iters = Number(arg("--iters", "100000"));
    const t0 = performance.now();
    const result = runPair(a, b, iters, Number(arg("--seed", "1")), scenarioArg(), {
      memoize: !flag("--no-memo"),
      shortCircuitStalemates: !flag("--no-stalemate-shortcut"),
    });
    const seconds = (performance.now() - t0) / 1000;
    console.log(JSON.stringify({ ...result, seconds, fightsPerSecond: iters / seconds }, null, 2));
    return;
  }
  if (cmd === "verify") {
    const blocks = loadCompiled();
    const t0 = performance.now();
    const result = verifyOptimizations(blocks, {
      pairs: Number(arg("--pairs", "2000")),
      iters: Number(arg("--iters", "1")),
      seed: Number(arg("--seed", "1")),
    });
    console.log(`Verified ${result.checked} scenario-pairs (${result.successorPairs} successor and ${result.stalematePairs} proven-stalemate pairs included) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    return;
  }
  if (cmd === "verify-output") {
    const blocks = loadCompiled();
    const t0 = performance.now();
    const result = await verifySweepOutput(
      blocks,
      outDir,
      Number(arg("--iters", "10")),
      Number(arg("--seed", "1")),
      Number(arg("--workers", String(Math.max(1, (navigator.hardwareConcurrency || 2) - 1)))),
      arg("--scenario") ? [parseScenario(arg("--scenario"))] : SCENARIOS,
      (scenario, phase) => console.log(`${scenario}: reference sweep ${phase}`),
    );
    if (result.mismatches.length) throw new Error(`Sweep differs from reference engine:\n${result.mismatches.join("\n")}`);
    console.log(`Verified ${result.checked} sweep rows against the uncached reference engine in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    return;
  }
  console.log(`Usage:
  node src/cli.ts compile
  node src/cli.ts coverage
  node src/cli.ts fight "A" "B" [--iters N] [--seed S] [--verbose] [--scenario max30|max120|max600 --no-lookahead]
  node src/cli.ts run [--iters 200 --workers 8 --resume --only "cr<=5" --scenario max30|max120|max600 --tag NAME --no-lookahead] [--adaptive --pilot 70 --target-se 0.02]
  node src/cli.ts analyze [--iters 200 --workers 8 --resume --no-lookahead] [--adaptive --pilot 70 --target-se 0.02]   (max30 and max120)
  node src/cli.ts gauntlet [--iters 1000 --seed 1 --workers 9 --top 5 --only "source=SRD" --label srd --scenario max30|max120|max600]
  node src/cli.ts gauntletreport [--top 5 --iters 1000 --seed 1 --label srd]
  node src/cli.ts rank [--scenario max30|max120|max600 --tag NAME --only FILTER]
  node src/cli.ts combine [--max30 ranking-max30.csv --max120 ranking-max120.csv] [--max600 ranking-max600.csv]
  node src/cli.ts crcompare [--scenario max30|max120|max600 --ranking FILE]
  node src/cli.ts benchmark [--iters 100000 --scenario max600|max30 --no-memo --no-stalemate-shortcut]
  node src/cli.ts verify [--pairs 2000 --iters 1 --seed 1]
  node src/cli.ts verify-output [--iters 10 --seed 1 --workers 9 --scenario max30|max120|max600]

The old scenario names arena, arena120 and open are accepted as aliases of max30, max120 and max600.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
