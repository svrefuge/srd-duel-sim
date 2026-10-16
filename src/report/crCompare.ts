import fs from "node:fs";
import { parseCsvLine } from "./csv.ts";
import { fmtCr } from "./gauntletReport.ts";

export interface RankRow {
  rank: number;
  name: string;
  cr: number;
  elo: number;
}

export function readRankingCsv(file: string): RankRow[] {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).slice(1);
  return lines.map((line) => {
    const cols = parseCsvLine(line); // rank,name,cr,elo,meanWinRate
    return { rank: Number(cols[0]), name: cols[1], cr: Number(cols[2]), elo: Number(cols[3]) };
  });
}

/** Average ranks (1-based) with ties sharing their mean rank. */
function averageRanks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = Array(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].v === order[start].v) end++;
    const mean = (start + end) / 2 + 1;
    for (let k = start; k <= end; k++) ranks[order[k].i] = mean;
    start = end + 1;
  }
  return ranks;
}

/** Spearman rank correlation with tie correction (Pearson on average ranks). */
export function spearman(xs: number[], ys: number[]): number {
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const n = xs.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - mx) * (ry[i] - my);
    vx += (rx[i] - mx) ** 2;
    vy += (ry[i] - my) ** 2;
  }
  // A constant side has no rank order to correlate: 0 rather than NaN.
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

/**
 * The plan's crCompare deliverable: Spearman rho between Elo and CR, plus the biggest
 * over/under-performers by rank delta (Elo rank vs. CR-implied rank).
 */
export function crCompareMarkdown(rows: RankRow[], label: string, top = 20): string {
  const rho = spearman(rows.map((r) => r.cr), rows.map((r) => r.elo));
  // CR-implied rank: average rank of the monster's CR bracket, descending CR.
  const crRanks = averageRanks(rows.map((r) => -r.cr));
  const deltas = rows.map((r, i) => ({ ...r, crRank: crRanks[i], delta: crRanks[i] - r.rank }));
  const over = [...deltas].sort((a, b) => b.delta - a.delta).slice(0, top);
  const under = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, top);
  const table = (items: typeof deltas) => [
    "| Creature | CR | Elo Rank | CR Rank | Delta |",
    "|---|---:|---:|---:|---:|",
    ...items.map((r) => `| ${r.name} | ${fmtCr(r.cr)} | ${r.rank} | ${Math.round(r.crRank)} | ${r.delta > 0 ? "+" : ""}${Math.round(r.delta)} |`),
  ];
  return [
    `# CR vs. Elo (${label})`,
    "",
    `- Monsters: ${rows.length}`,
    `- Spearman rho (Elo vs. CR): **${new Set(rows.map((r) => r.cr)).size < 2 ? "n/a (every creature has the same CR)" : rho.toFixed(4)}**`,
    "",
    `## Top ${top} Overperformers (Elo rank far better than CR suggests)`,
    "",
    ...table(over),
    "",
    `## Top ${top} Underperformers (Elo rank far worse than CR suggests)`,
    "",
    ...table(under),
    "",
  ].join("\n");
}
