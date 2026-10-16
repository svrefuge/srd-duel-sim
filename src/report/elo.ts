import fs from "node:fs";
import { csv } from "./csv.ts";
import type { CombatStatblock, PairResult } from "../types.ts";

/**
 * Score A takes from the drawn iterations of a pair.
 *
 * A 100-round stalemate is rarely an even contest. A troll-rule regenerator its opponent
 * cannot suppress typically ends at a few percent of its hit points while the opponent is
 * barely scratched — the Troll Limb finishes drawn fights at 6% against an Ancient Blue
 * Dragon on 68%, and at 30% against a Storm Giant that takes no damage at all. Counting
 * every such draw as half a win flattered those creatures by hundreds of rank places.
 *
 * The margin is scored as a centered hit-point difference, so an even draw is still exactly
 * 0.5 and the two sides always sum to the one available point.
 */
export function drawScore(pair: PairResult): number {
  return pair.draws * (0.5 + (pair.drawHpA - pair.drawHpB) / 2);
}

export function writeRanking(blocks: CombatStatblock[], pairs: PairResult[], file: string): void {
  const idx = new Map(blocks.map((b, i) => [b.name, i]));
  const n = blocks.length;
  const score = Array(blocks.length).fill(0);
  const games = Array(blocks.length).fill(0);
  const meetings = Array.from({ length: n }, () => Array(n).fill(0));
  // Every pair carries the same weight in the fit, whatever it cost to measure. With a fixed
  // fight count this is the old arithmetic scaled by 1/iters throughout — `score`, `games` and
  // `meetings` all divide by the same constant, and the MM update below is a ratio of them, so
  // nothing moves. It matters once a pair's sample count varies: weighting by `iters` would let
  // a cheaply-settled matchup count for less evidence than a hard-fought one, which is backwards.
  // What a pair is worth to the fit is one matchup's worth of information, not one run's cost.
  const WEIGHT = 1;
  for (const pair of pairs) {
    const a = idx.get(pair.a);
    const b = idx.get(pair.b);
    if (a === undefined || b === undefined) continue;
    if (pair.iters <= 0) continue;
    const shareA = (pair.winsA + drawScore(pair)) / pair.iters;
    score[a] += shareA * WEIGHT;
    score[b] += (1 - shareA) * WEIGHT;
    games[a] += WEIGHT;
    games[b] += WEIGHT;
    meetings[a][b] += WEIGHT;
    meetings[b][a] += WEIGHT;
  }
  let strength = Array(n).fill(1);
  for (let iter = 0; iter < 200; iter++) {
    const next = strength.slice();
    for (let i = 0; i < n; i++) {
      if (!games[i]) continue;
      let denom = 0;
      for (let j = 0; j < n; j++) {
        if (i === j || !meetings[i][j]) continue;
        denom += meetings[i][j] / (strength[i] + strength[j]);
      }
      if (denom > 0) next[i] = Math.max(1e-12, score[i] / denom);
    }
    const mean = next.reduce((sum, v) => sum + v, 0) / n;
    strength = next.map((v) => v / mean);
  }
  const anchors = blocks.map((b, i) => ({ cr: b.cr, s: strength[i], games: games[i] })).filter((r) => r.games > 0 && r.cr === 1).map((r) => r.s).sort((a, b) => a - b);
  const active = strength.filter((_, i) => games[i] > 0).sort((a, b) => a - b);
  const anchor = anchors[Math.floor(anchors.length / 2)] || active[Math.floor(active.length / 2)] || 1;
  const rows = blocks.flatMap((block, i) => {
    if (!games[i]) return [];
    const mean = games[i] ? score[i] / games[i] : 0.5;
    const elo = games[i] ? 1000 + 400 * Math.log10(strength[i] / anchor) : 1000;
    return [{ name: block.name, cr: block.cr, mean, elo }];
  }).sort((a, b) => b.elo - a.elo || b.mean - a.mean);
  const lines = ["rank,name,cr,elo,meanWinRate"];
  rows.forEach((r, i) => lines.push([i + 1, csv(r.name), r.cr, r.elo.toFixed(1), r.mean.toFixed(4)].join(",")));
  fs.writeFileSync(file, lines.join("\n") + "\n");
}
