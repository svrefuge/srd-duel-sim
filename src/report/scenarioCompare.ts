import type { RankRow } from "./crCompare.ts";
import { spearman } from "./crCompare.ts";
import { fmtCr } from "./gauntletReport.ts";
import { SCENARIOS, SCENARIO_MAX_DISTANCE, type Scenario } from "../types.ts";

const LABELS: Record<Scenario, string> = {
  max30: "30 ft cap",
  max120: "120 ft cap",
  max600: "600 ft cap",
};

interface Shift {
  name: string;
  cr: number;
  from: number;
  to: number;
  gain: number;
}

function compare(from: RankRow[], to: RankRow[]) {
  const toByName = new Map(to.map((row) => [row.name, row]));
  const shifts: Shift[] = from.flatMap((row) => {
    const next = toByName.get(row.name);
    return next ? [{ name: row.name, cr: row.cr, from: row.rank, to: next.rank, gain: row.rank - next.rank }] : [];
  });
  const abs = shifts.map((row) => Math.abs(row.gain)).sort((a, b) => a - b);
  return {
    shifts,
    rho: spearman(shifts.map((row) => row.from), shifts.map((row) => row.to)),
    meanAbs: abs.reduce((sum, value) => sum + value, 0) / Math.max(1, abs.length),
    medianAbs: abs[Math.floor(abs.length / 2)] || 0,
    maxAbs: Math.max(...abs, 0),
  };
}

function moverTable(rows: Shift[]): string[] {
  return [
    "| Creature | CR | Before | After | Rank change |",
    "|---|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.name} | ${fmtCr(row.cr)} | ${row.from} | ${row.to} | ${row.gain > 0 ? "+" : ""}${row.gain} |`),
  ];
}

/** Compares the rankings of whichever scenarios are given: each with the next larger, then the smallest with the largest. */
export function scenarioComparisonMarkdown(rankings: Partial<Record<Scenario, RankRow[]>>, top = 15): string {
  const scenarios = SCENARIOS.filter((scenario) => rankings[scenario]);
  const adjacent = scenarios.slice(1).map((to, index): [Scenario, Scenario] => [scenarios[index], to]);
  const transitions = scenarios.length > 2 ? [...adjacent, [scenarios[0], scenarios[scenarios.length - 1]] as [Scenario, Scenario]] : adjacent;
  const comparisons = transitions.map(([from, to]) => ({ from, to, ...compare(rankings[from]!, rankings[to]!) }));
  const leaders = Array.from({ length: 20 }, (_, index) => [index + 1, ...scenarios.map((scenario) => rankings[scenario]![index]?.name || "")]);
  const caps = scenarios.map((scenario) => `${SCENARIO_MAX_DISTANCE[scenario]} feet in ${scenario}`);
  const lines = [
    "# Scenario ranking comparison",
    "",
    `All scenarios use the same full pair graph, seed, iteration count, and 30-foot starting separation. Maximum separation is ${caps.slice(0, -1).join(", ")} and ${caps[caps.length - 1]}.`,
    "",
    "## Overall similarity",
    "",
    "| Comparison | Spearman rho | Mean absolute shift | Median shift | Maximum shift |",
    "|---|---:|---:|---:|---:|",
    ...comparisons.map((item) => `| ${LABELS[item.from]} → ${LABELS[item.to]} | ${item.rho.toFixed(5)} | ${item.meanAbs.toFixed(1)} | ${item.medianAbs} | ${item.maxAbs} |`),
    "",
    "## Top 20 by scenario",
    "",
    `| Rank | ${scenarios.map((scenario) => LABELS[scenario]).join(" | ")} |`,
    `|---:|${scenarios.map(() => "---|").join("")}`,
    ...leaders.map((row) => `| ${row.join(" | ")} |`),
    "",
  ];
  for (const item of comparisons.slice(0, adjacent.length)) {
    const gainers = [...item.shifts].sort((a, b) => b.gain - a.gain || a.name.localeCompare(b.name)).slice(0, top);
    const losers = [...item.shifts].sort((a, b) => a.gain - b.gain || a.name.localeCompare(b.name)).slice(0, top);
    lines.push(
      `## ${LABELS[item.from]} → ${LABELS[item.to]}`,
      "",
      `### Biggest gainers`,
      "",
      ...moverTable(gainers),
      "",
      `### Biggest losers`,
      "",
      ...moverTable(losers),
      "",
    );
  }
  return lines.join("\n");
}
