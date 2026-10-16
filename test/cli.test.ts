import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readPairs } from "../src/report/csv.ts";

test("SRD CLI: adaptive workers, resume, rankings, analysis, and gauntlet reports", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mcsim-srd-cli-"));
  try {
    fs.cpSync(path.join(root, "src"), path.join(scratch, "src"), { recursive: true });
    fs.mkdirSync(path.join(scratch, "data"));
    fs.writeFileSync(path.join(scratch, "package.json"), '{"type":"module"}');
    const raw = JSON.parse(fs.readFileSync(path.join(root, "data/bestiary-srd-5.2.1.json"), "utf8"));
    fs.writeFileSync(path.join(scratch, "data/bestiary-srd-5.2.1.json"), JSON.stringify({ monster: raw.monster.slice(0, 8) }));
    fs.copyFileSync(path.join(root, "data/spells-srd-5.2.1.json"), path.join(scratch, "data/spells-srd-5.2.1.json"));
    const cli = (...args: string[]) => execFileSync(process.execPath, [path.join(scratch, "src/cli.ts"), ...args], { cwd: scratch, encoding: "utf8", timeout: 30_000 });
    const out = (name: string) => path.join(scratch, "out", name);
    cli("compile");
    const adaptive = ["--iters", "100", "--adaptive", "--pilot", "5", "--target-se", "0.2", "--only", "source=SRD"];
    cli("run", ...adaptive, "--workers", "1", "--tag", "serial");
    cli("run", ...adaptive, "--workers", "3", "--tag", "parallel");
    const sorted = (file: string) => readPairs(out(file)).sort((a, b) => `${a.a}|${a.b}`.localeCompare(`${b.a}|${b.b}`));
    const parallel = sorted("pairs-parallel-max600.csv");
    assert.equal(parallel.length, 28);
    assert.deepEqual(parallel, sorted("pairs-serial-max600.csv"));
    assert.ok(parallel.some((p) => p.iters < 100));
    for (const p of parallel) {
      assert.ok(p.iters >= 5 && p.iters <= 100);
      assert.equal(p.winsA + p.winsB + p.draws, p.iters);
    }
    assert.match(cli("run", ...adaptive, "--workers", "3", "--tag", "parallel", "--resume"), /Wrote 0 new pairs/);
    cli("rank", "--tag", "parallel", "--only", "source=SRD");
    assert.equal(fs.readFileSync(out("ranking-parallel-max600.csv"), "utf8").trim().split("\n").length, 9);
    cli("analyze", ...adaptive, "--workers", "3");
    // The standard sweep is max30 and max120; max600 is run on request (`run --scenario max600`).
    assert.ok(!fs.existsSync(out("pairs-max600.csv")));
    for (const scenario of ["max30", "max120"]) {
      assert.equal(readPairs(out(`pairs-${scenario}.csv`)).length, 28);
      cli("crcompare", "--scenario", scenario);
      assert.ok(fs.existsSync(out(`cr-compare-${scenario}.md`)));
    }
    assert.equal(fs.readFileSync(out("ranking-combined.csv"), "utf8").split("\n")[0], "cr,name,max30_rank,max120_rank");
    assert.ok(!fs.readFileSync(out("scenario-comparison.md"), "utf8").includes("600"));
    assert.ok(fs.existsSync(out("scenario-comparison.md")));
    cli("gauntlet", "--iters", "2", "--workers", "3", "--only", "source=SRD", "--label", "smoke");
    assert.ok(fs.existsSync(out("gauntlet-smoke.md")));
    cli("gauntletreport", "--iters", "2", "--only", "source=SRD", "--label", "smoke");
    for (const scenario of ["max30", "max120", "max600"]) {
      assert.ok(fs.existsSync(out(`gauntlet-smoke-${scenario}.csv`)));
      assert.ok(fs.existsSync(out(`gauntlet-pairs-smoke-${scenario}.csv`)));
    }
    assert.throws(() => cli("run", "--adaptive", "--pilot", "0"), /--pilot must be a positive integer/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
