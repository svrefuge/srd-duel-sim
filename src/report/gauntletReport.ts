import fs from "node:fs";
import { csv, parseCsvLine } from "./csv.ts";
import { crToNumber } from "../tables.ts";
import type { Standing, Tier, TierSummary } from "../gauntlet/gauntlet.ts";
import { SCENARIOS, type Scenario } from "../types.ts";

const SCENARIO_LABEL: Record<Scenario, string> = {
  max30: "30 ft cap",
  max120: "120 ft cap",
  max600: "600 ft cap",
};

export function fmtCr(cr: number): string {
  if (Number.isInteger(cr)) return String(cr);
  return cr === 0.125 ? "1/8" : cr === 0.25 ? "1/4" : cr === 0.5 ? "1/2" : String(cr);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** A CR cell as `fmtCr` writes it, decimal or fraction. */
export function parseCr(text: string): number {
  return crToNumber(text);
}

/** Rebuild the tiers a report needs from `gauntlet-<scenario>.csv`, so it can re-render without re-running. */
export function readStandingsCsv(file: string): TierSummary[] {
  const tiers = new Map<number, TierSummary>();
  for (const line of fs.readFileSync(file, "utf8").trim().split(/\n/).slice(1)) {
    if (!line) continue;
    const cols = parseCsvLine(line);
    const cr = parseCr(cols[0]);
    const standing: Standing = {
      rank: Number(cols[1]),
      name: cols[2],
      nativeCr: parseCr(cols[3]),
      promotedFrom: cols[4] === "" ? undefined : parseCr(cols[4]),
      points: Number(cols[6]),
      games: Number(cols[7]),
      score: Number(cols[8]),
      matchWins: Number(cols[9]),
      matchDraws: Number(cols[10]),
      matchLosses: Number(cols[11]),
      sb: Number(cols[12]),
    };
    if (!tiers.has(cr)) tiers.set(cr, { cr, natives: 0, entrants: Number(cols[5]), standings: [], champion: standing });
    const tier = tiers.get(cr)!;
    tier.standings.push(standing);
    if (standing.rank === 1) tier.champion = standing;
    if (standing.promotedFrom === undefined) tier.natives++;
    else tier.promoted = standing;
  }
  const out = [...tiers.values()].sort((a, b) => a.cr - b.cr);
  for (const tier of out) tier.standings.sort((a, b) => a.rank - b.rank);
  return out;
}

export function standingsCsv(tiers: TierSummary[]): string {
  const lines = ["tier_cr,rank,name,native_cr,promoted_from,entrants,points,games,score,match_w,match_d,match_l,sonneborn_berger"];
  for (const tier of tiers) {
    for (const row of tier.standings) {
      lines.push([
        fmtCr(tier.cr), row.rank, csv(row.name), fmtCr(row.nativeCr),
        row.promotedFrom === undefined ? "" : fmtCr(row.promotedFrom),
        tier.entrants, row.points.toFixed(2), row.games, row.score.toFixed(4),
        row.matchWins, row.matchDraws, row.matchLosses, row.sb.toFixed(1),
      ].join(","));
    }
  }
  return lines.join("\n") + "\n";
}

export function pairsCsv(tiers: Tier[]): string {
  const lines = ["tier_cr,a,b,iters,winsA,winsB,draws,avgRounds,avgWinnerHpPct,drawHpA,drawHpB"];
  for (const tier of tiers) {
    for (const pair of tier.pairs) {
      lines.push([
        fmtCr(tier.cr), csv(pair.a), csv(pair.b), pair.iters, pair.winsA, pair.winsB, pair.draws,
        pair.avgRounds.toFixed(3), pair.avgWinnerHpPct.toFixed(4), pair.drawHpA.toFixed(4), pair.drawHpB.toFixed(4),
      ].join(","));
    }
  }
  return lines.join("\n") + "\n";
}

function championTable(tiers: TierSummary[]): string[] {
  return [
    "| Tier | Entrants | Champion | Its CR | Record (W-D-L) | Score |",
    "|---|---:|---|---:|---:|---:|",
    ...tiers.map((tier) => {
      const champ = tier.champion;
      const home = champ.promotedFrom === undefined ? "" : " ↑";
      return `| CR ${fmtCr(tier.cr)} | ${tier.entrants} | ${champ.name}${home} | ${fmtCr(champ.nativeCr)} | ${champ.matchWins}-${champ.matchDraws}-${champ.matchLosses} | ${pct(champ.score)} |`;
    }),
  ];
}

function promotionTable(tiers: TierSummary[]): string[] {
  const rows = tiers.filter((tier) => tier.promoted);
  return [
    "| Promoted into | Creature | Native CR | Finished | of | Record (W-D-L) | Score | Promoted again? |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    ...rows.map((tier) => {
      const row = tier.promoted!;
      return `| CR ${fmtCr(tier.cr)} | ${row.name} | ${fmtCr(row.nativeCr)} | ${ordinal(row.rank)} | ${tier.entrants} | ${row.matchWins}-${row.matchDraws}-${row.matchLosses} | ${pct(row.score)} | ${row.rank === 1 ? "yes" : "no"} |`;
    }),
  ];
}

function podium(tier: TierSummary, depth: number): string[] {
  return tier.standings.slice(0, depth).map((row) => {
    const tag = row.promotedFrom === undefined ? "" : ` _(promoted from CR ${fmtCr(row.promotedFrom)})_`;
    return `${row.rank}. **${row.name}**${tag} — ${pct(row.score)}, ${row.matchWins}-${row.matchDraws}-${row.matchLosses}`;
  });
}

export interface GauntletReportInput {
  tiers: Record<Scenario, TierSummary[]>;
  iters: number;
  seed: number;
  corpus: number;
  /** How many placings to list per tier. */
  top: number;
  /** The `--only` predicate the corpus was filtered by, if any. */
  only?: string;
}

export function gauntletMarkdown(input: GauntletReportInput): string {
  const anyTiers = input.tiers[SCENARIOS[0]];
  const out: string[] = [
    "# CR-matched gauntlet",
    "",
    `Every creature fights every other creature **of its own Challenge Rating**, ${input.iters} iterations`,
    `per pair (seed ${input.seed}). Tiers run in ascending CR order and the champion of each tier is`,
    "carried up into the next one as an extra entrant, so a CR 6 winner plays the CR 7 gauntlet.",
    "A promoted creature that wins again keeps climbing.",
    "",
    `Corpus: ${input.corpus} creatures across ${anyTiers.length} tiers${input.only ? ` (filtered by \`${input.only}\`)` : ""}. Each of the three`,
    "distance scenarios runs its own independent ladder, because they disagree about who wins a tier.",
    "",
    "Scoring matches the main ranking: a creature's points are the iterations it won plus each drawn",
    "iteration scored by hit-point margin. **Score** is points over iterations played; **record** counts",
    "opponents beaten, tied and lost to. Ties break on the mini-tournament among the tied entrants,",
    "then Sonneborn-Berger.",
    "",
    "This is a separate corpus from the all-vs-all sweep — nothing here feeds `ranking-*.csv`.",
    "",
  ];
  for (const scenario of SCENARIOS) {
    const tiers = input.tiers[scenario];
    out.push(`## ${SCENARIO_LABEL[scenario]} (\`${scenario}\`)`, "");
    out.push("### Tier champions", "", ...championTable(tiers), "");
    out.push("↑ marks a champion that was promoted into the tier from below.", "");
    out.push("### How the promoted champions fared one tier up", "", ...promotionTable(tiers), "");
    const thin = tiers.filter((tier) => tier.entrants < 4);
    if (thin.length) {
      out.push(`Thin tiers — fewer than four entrants, so the standing is close to a single duel: ${thin.map((tier) => `CR ${fmtCr(tier.cr)} (${tier.entrants})`).join(", ")}.`, "");
    }
    out.push(`### Top ${input.top} per tier`, "");
    for (const tier of tiers) {
      out.push(`**CR ${fmtCr(tier.cr)}** (${tier.entrants} entrants)`, "", ...podium(tier, input.top), "");
    }
  }
  return out.join("\n");
}
