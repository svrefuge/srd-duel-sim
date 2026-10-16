import type { SkipLog } from "../types.ts";
import { stripTags } from "./tags.ts";

/** Only unconditional sight is promoted to a combat capability. */
export function parseSenses(entries: string[] = [], skipped: SkipLog[] = []): {
  blindsight?: number;
  truesightRange?: number;
  blindBeyond?: number;
  seesMagicalDarkness?: true;
  tremorsense?: number;
} {
  const senses: { blindsight?: number; truesightRange?: number; blindBeyond?: number; seesMagicalDarkness?: true; tremorsense?: number } = {};
  for (const entry of entries) {
    if (/\bunimpeded by magical Darkness\b/i.test(stripTags(entry))) senses.seesMagicalDarkness = true;
    for (const text of stripTags(entry).split(/[,;]/).map((part) => part.trim())) {
      const tremor = text.match(/^tremorsense\s+(\d+)\s*ft\.?$/i);
      if (tremor) senses.tremorsense = Math.max(senses.tremorsense ?? 0, Number(tremor[1]));
      if (!/\b(?:blindsight|truesight)\b/i.test(text)) continue;
      const match = text.match(/^(blindsight|truesight)\s+(\d+)\s*ft\.?\s*(?:\((blind|can't see) beyond this (?:radius|distance)\))?$/i);
      if (!match || Number(match[2]) <= 0) {
        skipped.push({ name: text, where: "senses", reason: "unmodeled sense: conditional or unsupported sight range" });
        continue;
      }
      const key = match[1].toLowerCase() === "blindsight" ? "blindsight" : "truesightRange";
      senses[key] = Math.max(senses[key] ?? 0, Number(match[2]));
      if (match[3]) senses.blindBeyond = Math.max(senses.blindBeyond ?? 0, Number(match[2]));
    }
  }
  return senses;
}
