import fs from "node:fs";
import path from "node:path";
import { outDir } from "./compile.ts";
import { impactfulConditions } from "./tables.ts";
import type { ActionOption, CombatAction, CombatStatblock, Rider } from "./types.ts";

function actionRiders(action: CombatAction): Rider[] {
  if (action.kind === "random") return action.branches.flatMap(actionRiders);
  if (!("riders" in action)) return [];
  return action.kind === "attack"
    ? [...action.riders, ...(action.extraSave?.riders || [])]
    : action.riders || [];
}

function actionChoiceRiders(action: CombatAction): unknown[] {
  if (action.kind === "random") return action.branches.flatMap(actionChoiceRiders);
  return "choiceRiders" in action ? action.choiceRiders || [] : [];
}

/**
 * Conditions this action already accounts for by *requiring* them of its target. A vampire's
 * Bite names Grappled, Incapacitated and Restrained because it needs one of them, not because it
 * inflicts any; flagging that as an unmodelled effect is noise.
 */
function prerequisiteConditions(action: CombatAction): Set<string> {
  if (action.kind === "random") {
    return new Set(action.branches.flatMap((branch) => [...prerequisiteConditions(branch)]));
  }
  const named = [
    ...("requiresTargetCondition" in action && action.requiresTargetCondition ? [action.requiresTargetCondition] : []),
    ...("requiresTargetConditions" in action ? action.requiresTargetConditions || [] : []),
    ...("requiresAnyTargetConditions" in action ? action.requiresAnyTargetConditions || [] : []),
    ...("requiresTargetMissingConditions" in action ? action.requiresTargetMissingConditions || [] : []),
    ...actionRiders(action).flatMap((rider) => rider.requiresTargetCondition ? [rider.requiresTargetCondition] : []),
  ];
  return new Set(named.map((condition) => condition.toLowerCase()));
}

/** True if the text applies a condition the engine models, outside prerequisite/0-HP contexts. */
function hasModelableCondition(text: string, prerequisites: Set<string> = new Set()): boolean {
  for (const match of text.matchAll(/\{@condition\s+([^}|]+)[^}]*\}/gi)) {
    if (!impactfulConditions.has(match[1].trim().toLowerCase())) continue;
    if (prerequisites.has(match[1].trim().toLowerCase())) continue;
    const prefix = text.slice(Math.max(0, match.index - 60), match.index);
    const widePrefix = text.slice(Math.max(0, match.index - 280), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
    // Prerequisite (a target held by the creature, "if the target is X", "isn't X",
    // "while X") and on-0-HP contexts mirror the parser's own exclusions.
    if (/^\s+by the /.test(after)) continue;
    if (/(?:that is|target is|isn't|not be|while)\s*(?:\{@condition\s+[^}]+\}\s+or\s*)?$/i.test(prefix)) continue;
    // The newer spelling of the same prerequisite. Only the form that says the target has a named condition, never a
    // bare "it has the", which is how newer text *inflicts* a condition.
    if (/\b(?:if|when|while|unless|until)\s+(?:the |an? )?(?:target|creature)\s+(?:has|have)\s+the\s*$/i.test(prefix)) continue;
    if (/\b(?:immunity|immune) to (?:being )?(?:\{@condition\s+[^}]*\}(?:,| and| or)*\s*)*$/i.test(prefix)) continue;
    if (/\breduce[sd]?\b[^.]{0,40}\bto 0\b|drops? to 0\b|to 0 (?:\{@variantrule )?hit points/i.test(widePrefix)) continue;
    return true;
  }
  return false;
}

/**
 * A repeat save the prose offers, in either of the two shapes the corpus writes. Most are
 * "at the end of each of its turns"; one swarm's is offered only when the victim
 * takes fire damage, which is a `saveOnDamage` rider and not a per-turn one.
 */
function hasSaveEnds(action: CombatAction): boolean {
  return actionRiders(action).some((r) => r.duration === "saveEndsEachTurn" || r.saveOnDamage);
}

function hasEscape(action: CombatAction): boolean {
  return actionRiders(action).some((r) => r.duration === "untilEscape" && r.escapeDc);
}

/**
 * A petrification the parser turned into neither a rider, a second-failure transition, a delayed follow-on (a grappler
 * that petrifies its target at its next turn), nor a lethal-damage clause.
 */
function hasPetrification(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.some(hasPetrification);
  if ("damage" in action && action.damage.some((d) => d.petrifiesOnLethalDamage)) return true;
  return actionRiders(action).some((r) => r.condition === "petrified" || r.transitionOnFailedSave === "petrified" || r.delayedCondition?.condition === "petrified");
}

/** A ranged attack mode the parser had to drop because the block states no range for it. */
function hasRangedMode(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.some(hasRangedMode);
  return action.kind !== "attack" || action.ranged;
}

function hasInstantDeath(action: CombatAction): boolean {
  if (action.kind === "random") return action.branches.some(hasInstantDeath);
  // Autohits carry the threshold too — one creature's death-touch simply touches you — and
  // checking only save actions reported a modelled execute as a gap.
  return "instantDeathHpThreshold" in action && action.instantDeathHpThreshold !== undefined;
}

/** One parser-audit warning, addressed to the option it concerns. */
export interface AuditFinding {
  block: string;
  optionIdx: number;
  option: string;
  message: string;
}

/**
 * Every parser-audit warning, structured. `scripts/parser-coverage.mjs` counts the options that
 * carry none of them (the warning-free share), which needs the option index: names repeat.
 */
export function auditFindings(blocks: CombatStatblock[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const block of blocks) {
    block.options.forEach((option, optionIdx) => {
      for (const message of optionWarnings(option, block.options)) out.push({ block: block.name, optionIdx, option: option.name, message });
    });
  }
  return out;
}

function optionWarnings(option: ActionOption, siblings: ActionOption[] = []): string[] {
  const findings: string[] = [];
  const text = option.sourceText.toLowerCase();
  // An "instead of dealing damage" split leaves the printed text on both halves and
  // puts the riders and the escape on the sibling whose sourceRef is "<sourceRef>.no damage". They are the print's, so
  // they count as this option's own in the condition and escape tests.
  const split = siblings.find((other) => other.sourceRef === `${option.sourceRef}.no damage`);
  const riders = [...actionRiders(option.action), ...(split ? actionRiders(split.action) : [])];
  const choiceRiders = [...actionChoiceRiders(option.action), ...(split ? actionChoiceRiders(split.action) : [])];
  if (hasModelableCondition(text, prerequisiteConditions(option.action)) && !riders.length && !choiceRiders.length) findings.push("condition text but no modeled rider");
  if (/repeats? the sav(?:e|ing throw)|ending the effect/.test(text)
    && !/repeats? the sav(?:e|ing throw) every 24 hours/.test(text)
    && !hasSaveEnds(option.action)) findings.push("repeat-save text but no saveEndsEachTurn rider");
  if (/escape\s+\{@dc\s+\d+\}/.test(text) && !hasEscape(option.action) && !(split && hasEscape(split.action))) findings.push("escape DC text but no untilEscape rider");
  // A creature that simply dies when reduced to 0 HP is the engine's normal kill; only execute thresholds need a model.
  if (/has\s+\d+\s+\{@variantrule hit points\}\s+or fewer, it dies/.test(text) && !hasInstantDeath(option.action)) findings.push("death/execute text but no instant-death model");
  if (/\{@condition petrified/.test(text) && !hasPetrification(option.action)) findings.push("petrification text but no modeled petrification");
  if (/\{@atkr? [^}]*r[^}]*\}/.test(text) && !hasRangedMode(option.action)) findings.push("ranged mode with no stated range");
  return findings;
}

function auditOptions(blocks: CombatStatblock[]): string[] {
  return auditFindings(blocks).map((f) => `${f.block} / ${f.option}: ${f.message}`);
}

export function coverageMarkdown(blocks: CombatStatblock[]): string {
  const totalOptions = blocks.reduce((sum, b) => sum + b.options.length, 0);
  const noRoutine = blocks.filter((b) => !b.routines.length || b.routines.every((r) => !r.parts.length));
  const skipped = blocks.flatMap((b) => b.skipped.map((s) => ({ monster: b.name, ...s })));
  const audits = auditOptions(blocks);
  const reasons = new Map<string, number>();
  for (const skip of skipped) reasons.set(skip.reason, (reasons.get(skip.reason) || 0) + 1);
  const topReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const lines = [
    "# mcsim-srd Coverage",
    "",
    `- Monsters: ${blocks.length}`,
    `- Compiled action options: ${totalOptions}`,
    `- Monsters with no damaging routine: ${noRoutine.length}`,
    `- Skipped/unparsed items: ${skipped.length}`,
    `- Parser audit findings: ${audits.length}`,
    "",
    "## Top Skipped Reasons",
    "",
    "| Count | Reason |",
    "| ---: | --- |",
    ...topReasons.map(([reason, count]) => `| ${count} | ${reason.replace(/\|/g, "\\|")} |`),
    "",
    "## Monsters With No Damaging Routine",
    "",
    ...(noRoutine.length ? noRoutine.map((b) => `- ${b.name} (CR ${b.cr})`) : ["None"]),
    "",
    "## Parser Audit",
    "",
    ...(audits.length ? audits.slice(0, 200).map((line) => `- ${line}`) : ["None"]),
    audits.length > 200 ? `- ... ${audits.length - 200} more` : "",
    "",
    "## Per-Monster Skips",
    "",
  ];

  for (const block of blocks) {
    if (!block.skipped.length) continue;
    lines.push(`### ${block.name}`, "");
    for (const skip of block.skipped) lines.push(`- ${skip.where} / ${skip.name}: ${skip.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function writeCoverage(blocks: CombatStatblock[]): string {
  fs.mkdirSync(outDir, { recursive: true });
  const md = coverageMarkdown(blocks);
  fs.writeFileSync(path.join(outDir, "coverage.md"), md);
  return md;
}
