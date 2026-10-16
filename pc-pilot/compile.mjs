// Compiles the records built by classes.mjs with the SRD compiler, applies their patches, and prints each block's options, routines and skip log.
// Output goes to out/pc-pilot/statblocks.json; the main corpus (out/statblocks.json) is not touched.
import fs from "node:fs";
import path from "node:path";
import { BUILDS } from "./classes.mjs";
import { compileMonster, dataDir, outDir, SPELLS_FILE } from "../src/compile.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
export const pilotOut = path.join(outDir, "pc-pilot");

export function compilePilot({ writeRecords = false } = {}) {
  const spellData = JSON.parse(fs.readFileSync(path.join(dataDir, SPELLS_FILE), "utf8"));
  const spells = new Map((spellData.spell || []).map((s) => [s.name.toLowerCase(), s]));
  // blocks.json is written from classes.mjs so the records can be read; it is not an input.
  if (writeRecords) fs.writeFileSync(path.join(here, "blocks.json"), JSON.stringify({ monster: BUILDS.map((b) => b.raw) }, null, 1));
  return BUILDS.map(({ raw, patch }) => {
    const block = compileMonster(structuredClone(raw), spells);
    patch?.(block);
    return block;
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const blocks = compilePilot({ writeRecords: true });
  fs.mkdirSync(pilotOut, { recursive: true });
  fs.writeFileSync(path.join(pilotOut, "statblocks.json"), JSON.stringify(blocks, null, 2));
  const uses = (u) => u.t === "atWill" ? "at will" : u.t === "perDay" ? `${u.max}/day${u.pool ? ` [${u.pool}]` : ""}` : `recharge ${u.min}`;
  for (const b of blocks) {
    console.log(`\n== ${b.name}  AC ${b.ac}  HP ${b.hpAvg}  init ${b.initiativeBonus}`);
    for (const o of b.options) console.log(`   ${o.timing.padEnd(6)} ${uses(o.uses).padEnd(22)} ${o.name}  <${o.action.kind}${o.action.condition ? `:${o.action.condition}` : ""}>`);
    if (process.argv.includes("--routines")) for (const r of b.routines) console.log(`   routine ${r.name}: ${r.parts.map((p) => `${p.count}x ${b.options[p.optionIdx].name}`).join(" + ")}`);
    for (const k of ["reaction", "rebuke", "evasion", "counterspell"]) if (b[k]) console.log(`   ${k}: ${JSON.stringify(b[k]).slice(0, 150)}`);
    for (const s of b.skipped) console.log(`   SKIP ${s.name}: ${s.reason}`);
  }
}
