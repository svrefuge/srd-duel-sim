// Writes the pilot blocks as readable stat blocks: `node pc-pilot/markdown.mjs` -> pc-pilot/statblocks/<class>.md.
// The text is the bestiary-format record from classes.mjs with its tags written out; "Simulator notes" are the builder's
// own account of what its patch and baked-in numbers do. Generated; edit classes.mjs.
import fs from "node:fs";
import path from "node:path";
import { BUILDS, LEVELS } from "./classes.mjs";
import { compilePilot, pilotOut } from "./compile.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = path.join(here, "statblocks");
const compiled = compilePilot();
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const ATTACK = { m: "Melee Attack Roll:", r: "Ranged Attack Roll:", rs: "Ranged Attack Roll:", "m,r": "Melee or Ranged Attack Roll:" };
const SAVE = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const ord = (n) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;

/**
 * The benchmark CR of each block from the last `max120` ladder run: the monster CR at which its mean score first drops
 * below one half and stays below at the next CR (the "falls" column of fight.mjs). Empty if the ladder has not been run.
 */
function ladderCr(scenario) {
  const file = path.join(pilotOut, `ladder-${scenario}.csv`);
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const byPc = new Map();
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n").slice(1)) {
    const m = line.match(/^(.*?),".*",([^,]+),([^,]+),\d+,\d+,\d+,[^,]+$/);
    if (!m) continue;
    if (!byPc.has(m[1])) byPc.set(m[1], new Map());
    const byCr = byPc.get(m[1]);
    if (!byCr.has(Number(m[2]))) byCr.set(Number(m[2]), []);
    byCr.get(Number(m[2])).push(Number(m[3]));
  }
  for (const [pc, byCr] of byPc) {
    const ladder = [...byCr].sort((a, b) => a[0] - b[0]).map(([cr, s]) => [cr, s.reduce((x, y) => x + y, 0) / s.length]);
    const cross = ladder.findIndex(([, mean], i) => mean < 0.5 && (ladder[i + 1]?.[1] ?? 0) < 0.5);
    if (cross >= 0) out.set(pc, ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" })[ladder[cross][0]] ?? String(ladder[cross][0]));
  }
  return out;
}
const SCENARIO = "max120";
const benchmark = ladderCr(SCENARIO);

/** Bestiary tags to plain text. */
function plain(text) {
  return text
    .replace(/(\d+) \(\{@\w+ \d+d1(?: [+-] \d+)?\}\)/g, "$1") // a flat amount written as dice for the parser
    .replace(/\{@atkr ([^}]+)\}/g, (_, k) => `*${ATTACK[k]}*`)
    .replace(/\{@hit (-?\d+)\}/g, (_, n) => sign(Number(n)))
    .replace(/\{@h\}/g, "*Hit:* ")
    .replace(/\{@dc (\d+)\}/g, "DC $1")
    .replace(/\{@actSave (\w+)\}/g, (_, a) => `*${SAVE[a]} Saving Throw:*`)
    .replace(/\{@actSaveFail\}/g, "*Failure:*")
    .replace(/\{@actSaveSuccess\}/g, "*Success:*")
    .replace(/\{@actTrigger\}/g, "*Trigger:*")
    .replace(/\{@actResponse\}/g, "*Response:*")
    .replace(/\{@\w+ ([^}|]+)(\|[^}]*)?\}/g, "$1");
}
/** What a printed spell costs, read from the compiled option: "(9th-level slot)" or "(Cantrip)". Other entries carry their uses in the name. */
function cost(e, raw, c) {
  const pool = c.options.find((o) => o.name === e.name)?.uses.pool?.match(/^spell-slots:(\d)$/);
  if (pool) return ` (${ord(Number(pool[1]))}-level slot)`;
  const cantrips = (raw.spellcasting || []).flatMap((sc) => sc.spells?.[0]?.spells || []).map(plain);
  return cantrips.includes(e.name) ? " (Cantrip)" : "";
}
// "takes the Dash action, or" is there for the parser; the compiled option is the attack alone.
const body = (e) => e.entries.map(plain).join(" ").replace("The character takes the Dash action, or it makes", "The character makes");
const entries = (heading, list, raw, c) => (list?.length ? [`### ${heading}`, "", ...list.flatMap((e) => [`***${e.name}${cost(e, raw, c)}.*** ${body(e)}`, ""])] : []);

function spellcasting(raw) {
  const out = [];
  for (const sc of raw.spellcasting || []) {
    out.push(`***${sc.name}.*** ${sc.headerEntries.map(plain).join(" ")}`, "");
    for (const [level, row] of Object.entries(sc.spells || {})) {
      const label = level === "0" ? "Cantrips (at will)" : `${ord(Number(level))} level (${row.slots} slot${row.slots === 1 ? "" : "s"})`;
      out.push(`- **${label}:** ${row.spells.map(plain).join(", ")}`);
    }
    for (const [key, list] of Object.entries(sc.daily || {})) out.push(`- **${parseInt(key, 10)}/Day${key.endsWith("e") ? " each" : ""}:** ${list.map(plain).join(", ")}`);
    out.push("");
  }
  return out;
}

function block({ raw, notes }, c) {
  const speed = Object.entries(raw.speed).map(([k, v]) => (k === "walk" ? `${v} ft.` : `${title(k)} ${v} ft.`)).join(", ");
  const mod = (a) => Math.floor((raw[a] - 10) / 2);
  const out = [
    `## ${raw.name}`, "",
    `*Medium Humanoid. Proficiency Bonus ${sign(2 + Math.floor((Number(raw.cr) - 1) / 4))}.*`, "",
    `**AC** ${c.ac} | **HP** ${c.hpAvg} | **Speed** ${speed} | **Initiative** ${sign(c.initiativeBonus)}`, "",
    ...(benchmark.has(raw.name) ? [`**Duels like CR** ${benchmark.get(raw.name)} (\`${SCENARIO}\`)`, ""] : []),
    `| | ${ABILITIES.map((a) => a.toUpperCase()).join(" | ")} |`,
    `|---|${ABILITIES.map(() => "---").join("|")}|`,
    `| Score | ${ABILITIES.map((a) => raw[a]).join(" | ")} |`,
    `| Modifier | ${ABILITIES.map((a) => sign(mod(a))).join(" | ")} |`,
    `| Save | ${ABILITIES.map((a) => raw.save[a] ?? sign(mod(a))).join(" | ")} |`, "",
  ];
  const lines = [];
  if (raw.skill) lines.push(`**Skills** ${Object.entries(raw.skill).map(([k, v]) => `${title(k)} ${v}`).join(", ")}`);
  if (raw.resist) lines.push(`**Resistances** ${raw.resist.map(title).join(", ")}`);
  if (raw.conditionImmune) lines.push(`**Condition Immunities** ${raw.conditionImmune.map(title).join(", ")}`);
  if (lines.length) out.push(lines.join("  \n"), "");
  out.push(...entries("Traits", raw.trait, raw, c));
  const cast = spellcasting(raw);
  out.push(...entries("Actions", raw.action, raw, c));
  if (cast.length) out.push(...(raw.action?.length ? [] : ["### Actions", ""]), ...cast);
  out.push(...entries("Bonus Actions", raw.bonus, raw, c), ...entries("Reactions", raw.reaction, raw, c));
  if (notes?.length) out.push("### Simulator notes", "", ...notes.map((n) => `- ${n}`), "");
  return out.join("\n");
}

fs.mkdirSync(dir, { recursive: true });
for (let k = 0; k < BUILDS.length; k += LEVELS.length) {
  const klass = BUILDS[k].raw.name.split(" ")[0];
  const sub = BUILDS[k].raw.name.match(/\((.*)\)/)[1];
  const head = [
    `# ${klass} (${sub})`, "",
    `Benchmark stat blocks at levels ${LEVELS.join(", ")}, as the duel simulator fights them. Generated by \`node pc-pilot/markdown.mjs\` from \`classes.mjs\`; do not edit.`, "",
    "How to read them: limited uses are for the one fight, with every slot and use available. A spell printed under Actions is the same spell as in the list, with a class feature's bonus in its dice: it is marked with the slot it spends, and that slot is shared with the other spells of its level. \"Simulator notes\" list what the text alone does not show. \"Duels like CR\" is the monster CR at which the block's mean score in the last `max120` ladder first drops below one half and stays below at the next CR; one CR either way is noise, and more than that at level 17. Conventions and what is left out are in `../README.md`.", "",
  ].join("\n");
  const body = LEVELS.map((_, j) => block(BUILDS[k + j], compiled[k + j])).join("\n");
  fs.writeFileSync(path.join(dir, `${klass.toLowerCase()}.md`), `${head}\n${body}`);
}
console.log(`wrote ${BUILDS.length / LEVELS.length} files to ${dir}`);
