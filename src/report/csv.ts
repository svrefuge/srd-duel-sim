import fs from "node:fs";
import type { CombatStatblock, PairResult } from "../types.ts";
import { drawScore } from "./elo.ts";

export function pairHeader(): string {
  return "a,b,iters,winsA,winsB,draws,avgRounds,avgWinnerHpPct,drawHpA,drawHpB\n";
}

export function pairRow(row: PairResult): string {
  return [
    csv(row.a),
    csv(row.b),
    row.iters,
    row.winsA,
    row.winsB,
    row.draws,
    row.avgRounds.toFixed(3),
    row.avgWinnerHpPct.toFixed(4),
    row.drawHpA.toFixed(4),
    row.drawHpB.toFixed(4),
  ].join(",") + "\n";
}

export function csv(value: unknown): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function writeMatrix(blocks: CombatStatblock[], pairs: PairResult[], file: string): void {
  const names = blocks.map((b) => b.name);
  const byPair = new Map<string, number>();
  for (const pair of pairs) {
    // Draws are scored by hit-point margin, matching writeRanking.
    const drawA = drawScore(pair);
    byPair.set(`${pair.a}|${pair.b}`, (pair.winsA + drawA) / pair.iters);
    byPair.set(`${pair.b}|${pair.a}`, (pair.winsB + (pair.draws - drawA)) / pair.iters);
  }
  const lines = ["," + names.map(csv).join(",")];
  for (const a of names) {
    lines.push([csv(a), ...names.map((b) => a === b ? "0.5" : (byPair.get(`${a}|${b}`)?.toFixed(4) ?? ""))].join(","));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

export function readPairs(file: string): PairResult[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).slice(1);
  return lines.filter(Boolean).map((line) => {
    const cols = parseCsvLine(line);
    return {
      a: cols[0],
      b: cols[1],
      iters: Number(cols[2]),
      winsA: Number(cols[3]),
      winsB: Number(cols[4]),
      draws: Number(cols[5]),
      avgRounds: Number(cols[6]),
      avgWinnerHpPct: Number(cols[7]),
      drawHpA: Number(cols[8]),
      drawHpB: Number(cols[9]),
    };
  });
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
