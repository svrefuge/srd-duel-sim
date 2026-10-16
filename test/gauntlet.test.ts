import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fmtCr, parseCr, readStandingsCsv, standingsCsv } from "../src/report/gauntletReport.ts";
import { runGauntlet, tierStandings, tiersByCr } from "../src/gauntlet/gauntlet.ts";
import type { CombatStatblock, PairResult } from "../src/types.ts";

function block(name: string, cr: number, hpAvg = 20, toHit = 4): CombatStatblock {
  const slam = {
    name: "Slam", sourceText: "", sourceRef: "test",
    action: { kind: "attack" as const, toHit, damage: [{ dice: { n: 1, d: 6, mod: 2 }, type: "bludgeoning" }], riders: [], magical: false, melee: true, ranged: false },
    uses: { t: "atWill" as const }, timing: "action" as const,
  };
  return {
    id: `T:${name}`, source: "T", name, cr, ac: 12, hpAvg,
    abilityMods: { str: 2, dex: 1, con: 1, int: 0, wis: 0, cha: 0 },
    saves: {}, skills: {}, initiativeBonus: 1,
    immune: [], resist: [], vulnerable: [], qualifiedDefenses: [], conditionImmune: [],
    speed: 30, size: 2, creatureType: "humanoid", creatureTags: [],
    truesight: false, flyby: false, undeadFortitude: false, magicResistance: false,
    legendaryResistances: 0, legendaryOptions: [],
    options: [slam],
    routines: [{ name: slam.name, parts: [{ optionIdx: 0, count: 1 }] }],
    skipped: [],
  };
}

function pair(a: string, b: string, winsA: number, winsB: number, draws = 0, drawHpA = 0, drawHpB = 0): PairResult {
  return { a, b, iters: winsA + winsB + draws, winsA, winsB, draws, avgRounds: 3, avgWinnerHpPct: 0.5, drawHpA, drawHpB };
}

test("tierStandings ranks by score and reports per-opponent records", () => {
  const entrants = [block("A", 5), block("B", 5), block("C", 5)];
  const rows = tierStandings(entrants, [
    pair("A", "B", 10, 0),
    pair("A", "C", 10, 0),
    pair("B", "C", 6, 4),
  ], new Map());
  assert.deepEqual(rows.map((r) => r.name), ["A", "B", "C"]);
  assert.equal(rows[0].score, 1);
  assert.deepEqual([rows[0].matchWins, rows[0].matchDraws, rows[0].matchLosses], [2, 0, 0]);
  assert.deepEqual([rows[1].matchWins, rows[1].matchDraws, rows[1].matchLosses], [1, 0, 1]);
  assert.deepEqual([rows[2].matchWins, rows[2].matchDraws, rows[2].matchLosses], [0, 0, 2]);
  assert.equal(rows.every((r) => r.games === 20), true);
});

test("tierStandings scores draws by hit-point margin, not as half a win", () => {
  const entrants = [block("Stalemater", 5), block("Bruiser", 5)];
  const rows = tierStandings(entrants, [pair("Stalemater", "Bruiser", 0, 0, 10, 0.1, 0.9)], new Map());
  assert.equal(rows[0].name, "Bruiser");
  assert.equal(rows[0].score.toFixed(4), "0.9000");
  assert.equal(rows[1].score.toFixed(4), "0.1000");
  // A dead-even draw is still worth exactly half.
  const even = tierStandings(entrants, [pair("Stalemater", "Bruiser", 0, 0, 10, 0.5, 0.5)], new Map());
  assert.deepEqual(even.map((r) => r.score), [0.5, 0.5]);
});

test("tierStandings breaks a points tie on the mini-tournament among the tied entrants", () => {
  const entrants = [block("A", 5), block("B", 5), block("C", 5), block("D", 5)];
  // A and B both take 1.5 of 3; A beat B head to head.
  const rows = tierStandings(entrants, [
    pair("A", "B", 10, 0),
    pair("A", "C", 5, 5),
    pair("A", "D", 0, 10),
    pair("B", "C", 10, 0),
    pair("B", "D", 5, 5),
    pair("C", "D", 5, 5),
  ], new Map());
  const a = rows.find((r) => r.name === "A")!;
  const b = rows.find((r) => r.name === "B")!;
  assert.equal(a.score, b.score);
  assert.ok(a.rank < b.rank, "head-to-head winner ranks ahead");
});

test("tiersByCr groups ascending with name-stable membership", () => {
  const tiers = tiersByCr([block("Z", 2), block("A", 2), block("M", 1), block("Q", 0.5)]);
  assert.deepEqual(tiers.map((t) => t.cr), [0.5, 1, 2]);
  assert.deepEqual(tiers[2].natives.map((n) => n.name), ["A", "Z"]);
});

test("runGauntlet carries each tier champion up into the next tier", async () => {
  // Hit points are the only difference, so the biggest creature in a tier wins it.
  const blocks = [
    block("Weak 1", 1, 10), block("Weak 2", 1, 12), block("Strong 1", 1, 400),
    block("Mid 2a", 2, 30), block("Mid 2b", 2, 35),
    block("Big 3a", 3, 900), block("Big 3b", 3, 60),
  ];
  const tiers = await runGauntlet(blocks, { iters: 20, workers: 1, seed: 1, scenario: "max30" });
  assert.deepEqual(tiers.map((t) => t.cr), [1, 2, 3]);
  assert.equal(tiers[0].entrants, 3);
  assert.equal(tiers[0].promoted, undefined);
  assert.equal(tiers[0].champion.name, "Strong 1");

  // The CR 1 champion is an extra entrant at CR 2 and, at 400 hp, wins there too.
  assert.equal(tiers[1].entrants, 3);
  assert.equal(tiers[1].promoted?.name, "Strong 1");
  assert.equal(tiers[1].promoted?.promotedFrom, 1);
  assert.equal(tiers[1].promoted?.nativeCr, 1);
  assert.equal(tiers[1].champion.name, "Strong 1");

  // It climbs again but loses to a genuinely bigger CR 3 creature.
  assert.equal(tiers[2].entrants, 3);
  assert.equal(tiers[2].promoted?.name, "Strong 1");
  assert.equal(tiers[2].champion.name, "Big 3a");
  assert.ok(tiers[2].promoted!.rank > 1);

  // Every entrant plays every other entrant exactly once.
  for (const tier of tiers) assert.equal(tier.pairs.length, (tier.entrants * (tier.entrants - 1)) / 2);
});

test("standings CSV round-trips into the tiers the report needs", () => {
  const entrants = [block("A", 5), block("B", 5), block("Climber", 4)];
  const rows = tierStandings(entrants, [
    pair("A", "B", 10, 0),
    pair("A", "Climber", 10, 0),
    pair("B", "Climber", 7, 3),
  ], new Map([["Climber", 4]]));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcsim-srd-report-")), "gauntlet-max30.csv");
  fs.writeFileSync(file, standingsCsv([{ cr: 5, natives: 2, entrants: 3, standings: rows, champion: rows[0], promoted: rows.find((r) => r.name === "Climber") }]));
  const back = readStandingsCsv(file);
  assert.equal(back.length, 1);
  assert.equal(back[0].cr, 5);
  assert.equal(back[0].natives, 2);
  assert.equal(back[0].champion.name, "A");
  assert.equal(back[0].promoted?.name, "Climber");
  assert.equal(back[0].promoted?.promotedFrom, 4);
  assert.deepEqual(back[0].standings.map((r) => r.rank), [1, 2, 3]);
});

test("fractional CRs survive the CSV round trip", () => {
  for (const cr of [0, 0.125, 0.25, 0.5, 1, 30]) assert.equal(parseCr(fmtCr(cr)), cr);
});
