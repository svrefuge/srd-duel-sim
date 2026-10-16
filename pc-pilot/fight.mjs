// Pilot PC blocks against the compiled SRD corpus.
//   node pc-pilot/fight.mjs ladder [--iters 40] [--scenario max30] [--only "Fighter 5"]
//       every pilot block against every SRD monster; mean score (win 1, draw 0.5) by CR, written to out/pc-pilot/
//   node pc-pilot/fight.mjs one "Fighter 5" "Troll" [--seed 1] [--scenario max30]
//       one traced fight
import fs from "node:fs";
import path from "node:path";
import { loadCompiled } from "../src/compile.ts";
import { fight, runPair } from "../src/engine/fight.ts";
import { compilePilot, pilotOut } from "./compile.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const scenario = arg("--scenario", "max30");
const pcs = compilePilot();
const corpus = loadCompiled();
// "Fighter" is every fighter and "Fighter 1" is level 1 only, not 11 and 17.
const named = (b, text) => { const n = b.name.toLowerCase(), t = text.toLowerCase(); return n === t || n.startsWith(`${t} `); };
const findPc = (text) => pcs.find((b) => named(b, text));

if (process.argv[2] === "one") {
  const pc = findPc(process.argv[3]);
  const foe = corpus.find((b) => b.name.toLowerCase() === process.argv[4].toLowerCase());
  if (!pc || !foe) throw new Error("unknown pilot block or monster");
  const trace = fight(pc, foe, Number(arg("--seed", "1")), true, scenario);
  console.log(trace.log.join("\n"));
  console.log(`winner: ${trace.winner === 0 ? pc.name : trace.winner === 1 ? foe.name : "draw"} after ${trace.rounds} rounds`);
} else {
  const iters = Number(arg("--iters", "40"));
  const only = arg("--only");
  const summary = [];
  const rows = ["pc,monster,cr,score,winsPc,winsMonster,draws,avgRounds"];
  for (const pc of pcs.filter((b) => !only || named(b, only))) {
    const byCr = new Map();
    for (const foe of corpus) {
      const r = runPair(pc, foe, iters, 1, scenario);
      const score = (r.winsA + r.draws / 2) / iters;
      rows.push([pc.name, JSON.stringify(foe.name), foe.cr, score.toFixed(3), r.winsA, r.winsB, r.draws, r.avgRounds.toFixed(1)].join(","));
      if (!byCr.has(foe.cr)) byCr.set(foe.cr, []);
      byCr.get(foe.cr).push(score);
    }
    const ladder = [...byCr].sort((a, b) => a[0] - b[0]).map(([cr, s]) => [cr, s.length, s.reduce((x, y) => x + y, 0) / s.length]);
    // The CR at which the block's mean score first drops below one half, and stays there for the next CR too.
    const cross = ladder.findIndex(([, , m], i) => m < 0.5 && (ladder[i + 1]?.[2] ?? 0) < 0.5);
    // The highest CR whose mean is still one half or more. Where it sits above "falls", the buckets between are noise.
    const holds = ladder.findLast(([, , m]) => m >= 0.5)?.[0] ?? "-";
    summary.push(`${pc.name.padEnd(26)} ${String(cross >= 0 ? ladder[cross][0] : ">30").padStart(4)}  ${String(holds).padStart(5)}   ${[1, 3, 5, 8, 11, 14, 17, 20].map((cr) => (ladder.find((l) => l[0] === cr)?.[2] ?? NaN).toFixed(2)).join("  ")}`);
    if (process.argv.includes("--full")) console.log(pc.name, ladder.filter(([cr]) => cr >= 1).map(([cr, n, m]) => `CR${cr}:${m.toFixed(2)}(${n})`).join("  "));
  }
  console.log(`${scenario}, ${iters} fights a monster. "falls" is the first CR where the mean score is under 0.5 and stays under at the next CR; "holds" is the highest CR at 0.5 or more.\n${"block".padEnd(26)} falls  holds   CR1   CR3   CR5   CR8   CR11  CR14  CR17  CR20`);
  console.log(summary.join("\n"));
  fs.mkdirSync(pilotOut, { recursive: true });
  fs.writeFileSync(path.join(pilotOut, `ladder-${scenario}.csv`), rows.join("\n") + "\n");
}
