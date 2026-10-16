import { numberWords } from "../tables.ts";
import type { ActionOption, Routine, SkipLog } from "../types.ts";
import { flattenEntries } from "./tags.ts";

/** Cardinals from the shared table, plus the adverbs a Multiattack counts with. */
const ADVERB_COUNTS: Record<string, number> = { once: 1, twice: 2, thrice: 3 };

function wordNumber(raw: string): number {
  const key = raw.toLowerCase();
  return numberWords[key] ?? ADVERB_COUNTS[key] ?? Number(raw);
}

/** Normalize an action name: drop form suffixes like "(Bear or Hybrid Form Only)". */
function optionKey(name: string): string {
  return name.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

export function findOption(options: ActionOption[], name: string): number {
  return findOptions(options, name)[0] ?? -1;
}

/** All action options matching a referenced name (choice-list attacks can have branches). */
export function findOptions(options: ActionOption[], name: string): number[] {
  const needle = optionKey(name.replace(/^(?:melee|ranged)\s+/i, "").replace(/ attacks?$/i, ""));
  const exact = options.flatMap((o, idx) =>
    o.timing === "action" && (optionKey(o.name) === needle || o.aliases?.some((alias) => optionKey(alias) === needle))
      ? [idx]
      : []
  );
  if (exact.length) return exact;
  // Singular/plural tolerance: "Claw attacks" should find an action named "Claws".
  const alt = needle.endsWith("s") ? needle.slice(0, -1) : needle + "s";
  const plural = options.flatMap((o, idx) => o.timing === "action" && optionKey(o.name) === alt ? [idx] : []);
  return plural.length ? plural : looseMatch(options, needle);
}

/** Words that mark a needle as an unsplit phrase rather than an action's name. */
const PHRASE_WORDS = new Set([
  "or", "and", "then", "with", "using", "times", "once", "twice", "thrice", "attack", "attacks",
  ...Object.keys(numberWords),
]);

/**
 * A Multiattack names the weapon; the action names the *item*.
 *
 * A Multiattack that says the creature attacks twice with its flail, against an action with a longer, decorated
 * name, "makes two greataxe attacks" against a named Greataxe, "two staff attacks" against a
 * magic staff, "three polearm attacks" against a "+3" polearm, "two crossbow attacks" against Light
 * Crossbow. The reverse happens too: "two adamantine greatclub attacks" against a plain
 * Greatclub, where the prose carries the adjective and the action does not.
 *
 * Whole words, either direction, and **only when exactly one action matches**. A creature holding
 * both a Longsword and a Shortsword must not have "sword attacks" quietly resolved to whichever
 * came first, so an ambiguous reference stays unresolved and audible in the audit.
 */
function looseMatch(options: ActionOption[], needle: string): number[] {
  const words = (text: string) => text.split(/[^a-z0-9+']+/i).filter(Boolean);
  const covers = (haystack: string[], hay: string[]) => hay.length > 0 && hay.every((w) => haystack.includes(w));
  const needleWords = words(needle);
  if (!needleWords.length) return [];
  // A needle carrying a conjunction or a count is a phrase the caller failed to split, not a
  // name spelled loosely, and matching it hides the real bug. "<Name> three times" would
  // otherwise resolve to that named action and hand the creature a fourth use on top of its three; a leading "or"
  // would otherwise leave the stray "or" showing in the routine's name.
  if (needleWords.some((word) => PHRASE_WORDS.has(word))) return [];
  const candidates = options.flatMap((option, idx) => {
    if (option.timing !== "action") return [];
    const optionWords = words(optionKey(option.name));
    return covers(optionWords, needleWords) || covers(needleWords, optionWords) ? [idx] : [];
  });
  return candidates.length === 1 ? candidates : [];
}

const NUM = "\\d+|one|two|three|four|five|six|once|twice|thrice";
// Lowercase-initial names allowed ("two pseudopod attacks"), but a name may never be or
// contain the word "attack" itself ("replace one attack with a Tail attack").
const ATTACK_RE = new RegExp(`\\b(${NUM})\\s+(?!(?:[Aa]ttacks?|of|other)\\b)([A-Za-z+][A-Za-z0-9+' -]+?) [Aa]ttacks?\\b`, "g");
// A comma list of interchangeable attack names after a count. Items must not
// contain "attack" in either case, so per-clause lists ("one Ram attack, one Bite attack") don't match.
const LIST_ITEM = "[A-Z](?:(?!\\b[Aa]ttacks?\\b)[A-Za-z0-9+' -])*?";
const LIST_RE = new RegExp(`makes\\s+(${NUM})\\s+((?:${LIST_ITEM},\\s+)+(?:or\\s+|and\\s+)?${LIST_ITEM})\\s+[Aa]ttacks?\\b`);
// A count of attacks, each of which can be one of two named attacks (an "or" between two names)
const EACH_RE = new RegExp(`makes\\s+(${NUM})\\s+attacks?, each of which can be (?:an?\\s+)?(.+?)\\s+attacks?\\b`, "i");

/**
 * A Multiattack entry, whatever qualifier the book hangs off its name. The 2024 vampire's is
 * "Multiattack (Vampire Form Only)" and another shapechanger's is "(<Form> Form Only)"; an
 * exact-name test dropped both entirely, leaving each creature swinging once per turn.
 */
export function isMultiattack(name: unknown): boolean {
  return /^multiattack\b/i.test(String(name ?? "").trim());
}

/**
 * A single action whose header has the creature shoot N of the following magical rays at random: one action that fires
 * N random rays, printed
 * with no Multiattack to count them. Its single routine carries the count, so the action fires N rays, not one. A
 * Multiattack that uses the ray action N times is read by the segment parser.
 */
const RANDOM_VOLLEY_RE = new RegExp(`\\b(?:shoots|fires)\\s+(${NUM})\\s+of the following\\b[^.]*?\\bat random\\b`, "i");

function randomVolleyCount(option: ActionOption, actions: { name: string; entries?: unknown }[]): number {
  if (option.action.kind !== "random") return 1;
  const printed = actions.find((action) => action.name === option.name);
  const match = printed ? flattenEntries(printed.entries).match(RANDOM_VOLLEY_RE) : null;
  const count = match ? wordNumber(match[1]) : 1;
  return Number.isInteger(count) && count > 1 ? count : 1;
}

function singleRoutines(options: ActionOption[], actions: { name: string; entries?: unknown }[] = []): Routine[] {
  const routines: Routine[] = [];
  options.forEach((option, idx) => {
    if (option.timing === "action") routines.push({ name: option.name, parts: [{ optionIdx: idx, count: randomVolleyCount(option, actions) }] });
  });
  return routines;
}

/**
 * The use tail of a Multiattack ("…and it uses X", with a pronoun or a choice of names), as a list of alternatives.
 *
 * Three things kept these from resolving. The verb could carry a gendered or plural pronoun
 * (a masculine or feminine pronoun between "and" and the verb); the tail could name a choice (two names joined by "or"),
 * which was captured as one impossible name; and it could be written as its own sentence
 * *before* the attacks (a use, optionally "if available", followed by "It also makes ..." the attacks). One entry per
 * resolvable option, so the caller can offer
 * a routine per alternative and let expected value choose. A name with no matching option — a
 * bare Spellcasting or Teleport reference — simply drops out.
 */
function extraUsesAlternatives(segment: string, options: ActionOption[]): { choice: boolean; idxs: number[] } {
  // A tail where the creature can use Spellcasting to cast a named cantrip, and the shorter form where the attacks use a
  // weapon "and casts" a cantrip. The `with|using` clause below already stops at "and casts", so the cantrip was simply
  // lost. This is the only additive spell tail in the data; the others are replacements or non-damage.
  const spell = segment.match(/uses? Spellcasting to cast \{@spell ([^}|]+)[|}]/i)
    ?? segment.match(/\band (?:it |he |she |they )?casts? \{@spell ([^}|]+)[|}]/i);
  if (spell) {
    const idx = findOption(options, spell[1].trim());
    return { choice: false, idxs: idx >= 0 ? [idx] : [] };
  }
  // A tail that casts one of its spells of a one-action casting time is a use of
  // Spellcasting that names no spell: one alternative per action-time spell option.
  if (/\band (?:it |he |she |they )?casts one of (?:its|his|her|their) spells with a casting time of 1 action\b/i.test(segment)) {
    return { choice: true, idxs: spellcastingIdxs(options) };
  }
  const named = /(?:its|his|her|their)\s+/;
  const tail = `([A-Z][A-Za-z' -]+?)(?=\\s+once\\b|\\.|,|;| if | to | when |$)`;
  // The "and uses" tail takes a comma list of alternatives (three names with "or" before the
  // last: one routine each) and stops before an
  // "(if available)" suffix (a single name followed by it:
  // folded in, as "if available" already was; the option's own uses limit it). This also reads a
  // two-name "X or Y (if available)", which the lead-use reader handled with a pattern of its own, now removed.
  const listTail = `([A-Z][A-Za-z' -]+?(?:,\\s+(?:or\\s+)?[A-Z][A-Za-z' -]+?)*)(?=\\s+once\\b|\\s+\\(if available\\)|\\.|,|;| if | to | when |$)`;
  // An "and uses either X or Y" tail, with or without "if available" and with "and can use" as
  // the verb. The lower-case
  // "either" stopped the list, so each alternative compiled as a routine of its own, without the attacks.
  const match = segment.match(new RegExp(`\\b(?:and|then)(?:\\s+(?:it|he|she|they))?(?:\\s+can)?(?:\\s+also)?\\s+uses?\\s+(?:either\\s+)?(?:${named.source})?${listTail}`))
    ?? segment.match(new RegExp(`(?:^|\\.)\\s*(?:It|He|She|They|The [A-Za-z'-]+)\\s+(?:also\\s+)?uses?\\s+(?:${named.source})?${tail}`));
  if (!match) return alsoUseAlternatives(segment, options);
  const names = match[1].split(/\s*,\s*(?:or\s+)?|\s+or\s+/i);
  // One name can still resolve to several options: a sphinx's "uses Roar" names three roars that
  // fire in sequence, and taking only the first left it silent after one use.
  // A bare Spellcasting right after the verb ("and uses Spellcasting", "and
  // can use Spellcasting", or a two-name list with Spellcasting and another use) is one alternative per action-time
  // spell option, wherever the list puts it: "uses Pummel or Spellcasting" (Glabrezu) offers Pummel or any of its
  // action-time spells after the two attacks.
  const isBare = (name: string): boolean => /^Spellcasting$/i.test(name.trim());
  const bare = names.some(isBare);
  const idxs = names.flatMap((name) => isBare(name) ? spellcastingIdxs(options) : findOptions(options, name.trim()));
  return {
    // Whether the *source* offered a choice, not whether more than one name resolved. A
    // creature that chooses between Spellcasting and Teleport had only Teleport compile, and
    // folding it in as compulsory would make the creature jump every single turn.
    choice: names.length > 1 || idxs.length > 1 || bare,
    idxs,
  };
}

/**
 * The joined use in a sentence of its own, in the wordings the two patterns above
 * miss: "It can also use X.", "can also use X if available", a sentence that has the creature use X before or after the
 * attacks, one saying it can use X directly ahead of or behind a single attack when it is available, "can also use X
 * before or after making these attacks", and "can also use X (if available) or Y". Read only when neither pattern above
 * matched, so no wording they read changes, and
 * only after the first sentence or clause: a use printed before the attacks is a lead use, not read here. "Can"
 * or "if available" makes it a choice (the attack-only routine stays); a plain "uses" is folded into every routine.
 * The use is appended after the attacks (see `withExtraUses`). A use "in place of" an attack is a substitute, not
 * read here.
 */
function alsoUseAlternatives(segment: string, options: ActionOption[]): { choice: boolean; idxs: number[] } {
  const named = /(?:its|his|her|their)\s+/;
  const match = segment.match(new RegExp(`[.,]\\s*(?:[Ii]t|[Hh]e|[Ss]he|[Tt]hey|[Tt]he [A-Za-z'-]+)\\s+(can\\s+)?(?:also\\s+)?uses?\\s+(?:${named.source})?`
    + `([A-Z][A-Za-z' ()-]+?)(?=\\s+once\\b|\\s+(?:either\\s+)?(?:before|after)\\b|\\s+in place of\\b|\\.|,|;| if | to | when |$)`));
  if (!match) return { choice: false, idxs: [] };
  const rest = segment.slice((match.index ?? 0) + match[0].length);
  if (/^\s+in place of\b/i.test(rest) || /^Spellcasting\b/i.test(match[2])) return { choice: false, idxs: [] };
  const names = match[2].split(/\s+or\s+/i);
  const idxs = names.flatMap((name) => findOptions(options, name.trim()));
  const ifAvailable = /\(if available\)/i.test(match[2]) || /^,?\s+if (?:it is )?available\b/i.test(rest);
  return { choice: !!match[1] || ifAvailable || names.length > 1 || idxs.length > 1, idxs };
}

/** The action-time spell options compiled from the block's Spellcasting, the spells a bare "uses Spellcasting" can cast. */
function spellcastingIdxs(options: ActionOption[]): number[] {
  return options.flatMap((option, idx) => option.timing === "action" && /\.spellcasting$/.test(option.sourceRef ?? "") ? [idx] : []);
}

/**
 * Attach the "and it uses X" tail to each base routine. A single named option is folded straight
 * in, because the creature always does it; a choice becomes one routine per branch alongside the
 * plain base, which is also the fallback for the turns when none of them has recharged.
 */
function withExtraUses(bases: Routine[], segment: string, options: ActionOption[]): Routine[] {
  const { choice, idxs } = extraUsesAlternatives(segment, options);
  if (!idxs.length || !bases.length) return bases;
  if (!choice) {
    for (const base of bases) base.parts.push({ optionIdx: idxs[0], count: 1 });
    return bases;
  }
  return [
    ...bases,
    ...idxs.flatMap((optionIdx) => bases.map((base) => ({
      ...base,
      name: `${base.name} + ${options[optionIdx].name}`,
      parts: [...base.parts, { optionIdx, count: 1 }],
    }))),
  ];
}

/**
 * A sentence saying the creature can replace one attack with a use of Spellcasting to cast a spell, a named attack, or a
 * named option.
 *
 * Some blocks say "replace **any** attack" instead, which read as a different sentence and
 * so compiled no replacement at all. Only one swap is offered either way —
 * "any" permits more, and modelling that is a bigger change than this — but one is not none.
 */
function replacementIdxs(text: string, options: ActionOption[]): number[] {
  const out = new Set<number>();
  const add = (idx: number) => {
    if (idx >= 0) out.add(idx);
  };
  for (const spell of text.matchAll(/replace (?:one|any) attack with.*?Spellcasting to cast \{@spell ([^}|]+)[|}]/gi)) {
    add(findOption(options, spell[1].trim()));
  }
  for (const marked of text.matchAll(/\([A-Z]\)\s+(?!Spellcasting\b)([A-Z][A-Za-z' -]+?)(?=\s+or\s+\([A-Z]\)|\.|,|$)/g)) {
    add(findOption(options, marked[1].trim()));
  }
  if (!out.size) {
    const plain = text.match(/replace (?:one|any) [Aa]ttack with (?:a use of |one use of |an? )?([A-Z][A-Za-z' -]+?)(?: [Aa]ttack)?(?:\.|,|$)/);
    // Every variant the name resolves to is its own swap (see `replacementTargets`).
    if (plain) for (const idx of findOptions(options, plain[1].trim())) add(idx);
  }
  return [...out];
}

/**
 * The replacement sentence the patterns above never read, which many statblocks use:
 * a replacement of "one of the attacks" with a named attack (none of which ever made the swap), "one of these attacks",
 * "one of those", "may replace", the passive "one of them may be **swapped for**" a named option, "each of
 * them may be **exchanged for**" a use of a named option, and a replacement of **two** attacks with one use of a named
 * option. Each option the tail names gets its own swap, so a tail naming two attack options is two.
 * Added to what `replacementIdxs` finds, never in place of it.
 */
function replacementSwaps(text: string, options: ActionOption[]): { idx: number; count: number }[] {
  const out: { idx: number; count: number }[] = [];
  for (const clause of replacementClauses(text)) {
    if (clause.old !== undefined) continue;
    for (const idx of replacementTargets(clause.tail, options)) {
      if (!out.some((swap) => swap.idx === idx && swap.count === clause.count)) out.push({ idx, count: clause.count });
    }
  }
  return out;
}

/**
 * What a generic replacement replaces: "one of the attacks", "one of which", "two attacks". A phrase like "Up to
 * three of these attacks" reaches the named pattern and comes back as generic from its "of" check.
 */
const WHICH = String.raw`(?:(?:one|any|two)(?:\s+of\s+(?:the|these|those|them|which))?(?:\s+attacks?)?|one attack or one use of [A-Za-z][A-Za-z' -]*?)`;

/**
 * Each replacement clause in a Multiattack: what it replaces (a named attack, or `old` undefined for
 * any attack), how many attacks it gives up, and the words naming what replaces them. A tag keeps
 * the words the data prints (a variant-rule tag with a display name keeps the display name);
 * `{@spell}` survives for `replacementTargets`. The tail stops at the sentence, a dash or ", and",
 * which is where a second clause starts, and drops any "if" clause: ", if
 * available" needs nothing, since the engine never spends an option that is not ready, and a
 * "(if available)" inside the tail is dropped with the other parentheses by `findOption`.
 */
const UP_TO_COUNT: Record<string, number> = { two: 2, three: 3, four: 4 };
function replacementClauses(raw: string): { old?: string; count: number; tail: string; upTo?: number }[] {
  const text = raw
    .replace(/\{@(?!spell\b)[a-zA-Z0-9]+ ([^}|]+)(?:\|[^}|]*)?(?:\|([^}]*))?\}/g, (_, name: string, shown?: string) => shown || name);
  const clauses: { old?: string; count: number; tail: string; upTo?: number }[] = [];
  const clause = new RegExp(
    String.raw`\breplace\s+(${WHICH})\s+with\s+|\b(${WHICH})\s+can\s+be\s+replaced\s+(?:by|with)\s+|\beach of which (?:it|he|she|they) can replace with\s+`
      + String.raw`|\breplace\s+((?:its|the|one|up to \w+)\s+[A-Za-z][A-Za-z' -]*?)\s+attacks?\s+with\s+|\b((?:up to \w+|one|the)\s+[A-Za-z][A-Za-z' -]*?)\s+attacks?\s+can\s+be\s+replaced\s+(?:by|with)\s+`,
    "gi",
  );
  for (const match of text.matchAll(clause)) {
    const start = (match.index ?? 0) + match[0].length;
    const tail = text.slice(start).split(/\.(?:\s|$)|—|;|,\s+and\b/)[0].replace(/,?\s+if\b.*$/i, "").trim();
    const generic = match[1] ?? match[2];
    if (generic !== undefined || match[3] === undefined && match[4] === undefined) {
      clauses.push({ count: /^two\b/i.test(generic ?? "") ? 2 : 1, tail });
      continue;
    }
    const old = (match[3] ?? match[4]).replace(/^(?:its|the|one|up to \w+)\s+/i, "");
    // "one of its attacks" is any attack, not one named "of its".
    // up-to-swaps: a cap such as "Up to two tentacle attacks" ahead of a swap to a named option keeps its
    // number, so the named-swap loop can add the two-attack swap beside the one-attack swap.
    const upTo = UP_TO_COUNT[(match[3] ?? match[4]).match(/^up to (two|three|four)\b/i)?.[1].toLowerCase() ?? ""];
    clauses.push({ old: /^of\b/i.test(old) ? undefined : old, count: 1, tail, ...(upTo ? { upTo } : {}) });
  }
  return clauses;
}

/**
 * The options a replacement tail names, one per alternative: a named attack or a use of Spellcasting,
 * a lettered "(A) ... or (B) Spellcasting to cast {@spell Fireball}" pair, or a use of
 * Spellcasting to cast two tagged spells joined by "or". A name no option carries adds
 * nothing. A bare "a use of Spellcasting" still adds nothing here: the bare-Spellcasting expansion turns a
 * bare Spellcasting into the block's action-time spell options only in the wordings its scan read ("and uses
 * Spellcasting", "casts one of its spells" or a "cast a spell" substitution for an attack; `extraUsesAlternatives`,
 * `buildRoutines`). "Replace one attack with a use of Spellcasting" is the same gap in another wording, read since
 * the Spellcasting substitute reader was added.
 */
function replacementTargets(tail: string, options: ActionOption[]): number[] {
  const idxs: number[] = [];
  for (const alt of tail.split(/\s*,?\s+or\s+/i)) {
    const spells = [...alt.matchAll(/\{@spell ([^}|]+)[|}]/g)].map((spell) => spell[1].trim());
    let name = alt;
    while (true) {
      const next = name.replace(/^(?:either|\([A-Z]\)|a use of|one use of|use of|its|his|her|their|an?|one)\s+/i, "");
      if (next === name) break;
      name = next;
    }
    // A bare "a use of Spellcasting" is one swap per action-time spell
    // option (the expansion built for the bare wordings); "Spellcasting to cast X" untagged still adds nothing.
    if (!spells.length && /^Spellcasting$/i.test(name.trim())) {
      for (const idx of spellcastingIdxs(options)) if (!idxs.includes(idx)) idxs.push(idx);
      continue;
    }
    const names = spells.length ? spells : /^Spellcasting\b/i.test(name) ? [] : [name.replace(/\s+attacks?$/i, "")];
    // A name the block compiles as several variant
    // options (a use of a named option with three variants) is one swap per variant, for expected value
    // to choose between. The first variant alone was kept.
    for (const found of names) {
      for (const idx of findOptions(options, found)) if (!idxs.includes(idx)) idxs.push(idx);
    }
  }
  return idxs;
}

/** Gives up `count` attacks from the base, first part first, then adds one use of the replacement. */
/** The part a replacement adds: marked when it is not an attack roll itself (`Routine.parts.replacesAttack`). */
function swapPart(options: ActionOption[], optionIdx: number, count = 1): Routine["parts"][number] {
  return options[optionIdx]?.action.kind === "attack" ? { optionIdx, count } : { optionIdx, count, replacesAttack: true };
}

const GENERIC_ONE_ATTACK_SWAP_RE = /\breplace one of (?:the|these) attacks with\b/i;
function swapRoutine(base: Routine, count: number, idx: number, name: string, options: ActionOption[]): Routine | undefined {
  const total = base.parts.reduce((sum, p) => sum + p.count, 0);
  if (total <= count) return undefined;
  const parts = base.parts.map((p) => ({ ...p }));
  let left = count;
  for (const part of parts) {
    const taken = Math.min(part.count, left);
    part.count -= taken;
    left -= taken;
  }
  return { name, parts: [...parts.filter((p) => p.count > 0), swapPart(options, idx)], maxDistance: base.maxDistance };
}

/**
 * Wording the rest of the parser should never have to see.
 *
 * - Markup. An item tag with a source suffix inside the attack count carried braces and a source into the
 *   attack name, so nothing could reach the word "attacks" after it, and a variant-rule tag put a tag in a routine's
 *   display name. Every tag **except**
 *   `{@spell …}`, which must survive because the cantrip and Spellcasting tails match on the tag
 *   itself, is stripped (stripping those cost a Multiattack its cantrip when this first stripped all of them).
 * - A subject carrying a digit: a creature whose own name contains a number was read as the count, leaving
 *   part of its name as the weapon. Anchored to the subject rather than to "whatever
 *   precedes a verb", since "attacks" is itself such a verb, so a digit further along, such as a
 *   "+1" in a weapon name, would otherwise swallow the sentence.
 * - "any combination of", which sits between the verb and the count every pattern expects.
 * - "either", which does the same to the alternatives form.
 * - An article used as a count: a clause with "a" before each of two attack names.
 *   Only after the verb or a conjunction, so "replace one Claw attack with a Bite attack" keeps
 *   the article its own replacement pattern expects.
 */
function normalizeSegment(segment: string): string {
  return segment
    .replace(/\{@(?!spell\b)[a-zA-Z0-9]+ ([^}|]+)(?:\|[^}]*)?\}/g, "$1")
    .replace(/^(?:The\s+)?[A-Z][A-Za-z'-]*\s+\d+\s+(?=\b(?:makes?|attacks?|uses?|takes?)\b)/, "")
    .replace(/\bany combination of\s+/gi, "")
    .replace(/,?\s+either\s+(?=with|using)/gi, " ")
    .replace(/\b(makes|and)\s+(?:a|an)\s+(?=[A-Za-z][A-Za-z0-9+' -]*?\s+[Aa]ttacks?\b)/g, "$1 one ")
    // A second count that names its attack as unarmed strikes. The
    // second count names its attack without the word "attack", so ATTACK_RE dropped it. Only after "attack(s) and":
    // a slot that is an Unarmed Strike alternative to another attack, and an "or" list of attack names with
    // an Unarmed Strike in it, already compile and must not be touched.
    .replace(UNARMED_STRIKES_AFTER_ATTACKS_RE, "$1 $2 Unarmed Strike attacks");
}
const UNARMED_STRIKES_AFTER_ATTACKS_RE = new RegExp(`\\b([Aa]ttacks? and)\\s+(${NUM})\\s+[Uu]narmed [Ss]trikes?\\b(?! attacks?\\b)`, "g");

/**
 * What a slot offers. A slot of "one with its W or X" is a choice, not a weapon called "W or
 * X": reading the phrase whole resolved nothing and dropped the slot, and reading only its
 * first name made the second unreachable. The whole phrase is tried first, so an action genuinely
 * named with "or" in it still resolves as itself.
 */
function slotAlternatives(options: ActionOption[], raw: string): number[] {
  const whole = findOption(options, raw.trim());
  if (whole >= 0) return [whole];
  const idxs: number[] = [];
  for (const alt of raw.replace(/^either\s+/i, "").split(/\s*,?\s+or\s+/i)) {
    const idx = findOption(options, alt.replace(/^(?:its|his|her|their|an?)\s+/i, "").trim());
    if (idx >= 0 && !idxs.includes(idx)) idxs.push(idx);
  }
  return idxs;
}

/**
 * One routine per way of filling the slots, in the order written, for expected value to choose
 * between. A slot nothing resolves is skipped as before; the product is capped so a sentence of
 * nothing but choices cannot explode.
 */
function slotRoutines(slots: { name: string; count: number }[], options: ActionOption[]): Routine[] {
  let combos: { optionIdx: number; count: number }[][] = [[]];
  for (const slot of slots) {
    const idxs = slotAlternatives(options, slot.name);
    if (!idxs.length) continue;
    const next: { optionIdx: number; count: number }[][] = [];
    for (const combo of combos) {
      for (const idx of idxs) {
        const parts = combo.map((part) => ({ ...part }));
        const same = parts.find((part) => part.optionIdx === idx);
        if (same) same.count += slot.count;
        else parts.push({ optionIdx: idx, count: slot.count });
        next.push(parts);
      }
    }
    combos = next.slice(0, 16);
  }
  const filled = combos.filter((parts) => parts.length);
  return filled.map((parts) => ({
    name: filled.length > 1 ? `Multiattack (${parts.map((p) => options[p.optionIdx].name).join(" + ")})` : "Multiattack",
    parts,
  }));
}

function parseSegment(segment: string, options: ActionOption[]): Routine[] {
  // A named use between two explicit attack clauses keeps its printed position.
  const ordered = segment.match(/makes (\w+) ([A-Za-z' -]+?) attacks?, uses ([A-Za-z' -]+?), and makes (\w+) ([A-Za-z' -]+?) attacks?\./i);
  if (ordered) {
    const refs = [findOption(options, ordered[2]), findOption(options, ordered[3]), findOption(options, ordered[5])];
    if (refs.every(idx => idx >= 0)) return [{ name: "Multiattack", parts: [
      { optionIdx: refs[0], count: wordNumber(ordered[1]) }, { optionIdx: refs[1], count: 1 },
      { optionIdx: refs[2], count: wordNumber(ordered[4]) },
    ] }];
  }
  segment = normalizeSegment(segment);
  segment = segment.replace(new RegExp(`attacks\\s+(${NUM})\\s+times`, "i"), "makes $1 attacks");
  // A later replacement sentence describes a variant; it must not be mistaken for an
  // additional attack in the base routine. The passive form counts too: "Up to two X
  // attacks can be replaced by" a named option was read as two more X attacks.
  const baseSegment = segment.split(/\b(?:it|he|she|the [A-Za-z'-]+) can replace\b|(?:^|[.,;]\s*)(?:up to|one|any|each)\b[^.,;]*?\bcan be replaced\b/i)[0];
  const bases: Routine[] = [];

  // Fixed opener plus flexible remaining slots:
  // "makes one Bite attack and three other attacks, using Claw or Tail in any combination."
  const fixedFlex = segment.match(new RegExp(`makes\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]+?) attacks?\\s+and\\s+(${NUM})\\s+other attacks?,?\\s+using\\s+(.+?)(?:\\s+in any combination|\\.|$)`, "i"));
  if (fixedFlex) {
    const fixedIdx = findOption(options, fixedFlex[2]);
    const fixedCount = wordNumber(fixedFlex[1]);
    const flexCount = wordNumber(fixedFlex[3]);
    if (fixedIdx >= 0) {
      for (const name of fixedFlex[4].split(/\s+or\s+|\s+and\s+|,\s*/i).map((s) => s.trim()).filter(Boolean)) {
        const idx = findOption(options, name);
        if (idx >= 0) bases.push({ name: `Multiattack (${fixedFlex[2]} + ${name})`, parts: [{ optionIdx: fixedIdx, count: fixedCount }, { optionIdx: idx, count: flexCount }] });
      }
    }
    // The flexible slots "in any combination": each ordered pair of the named options, every split, first option first.
    if (fixedIdx >= 0 && flexCount > 1 && /\bin any combination\b/i.test(segment)) {
      const pure = bases.map((base) => base.parts[1].optionIdx);
      for (const first of pure) for (const second of pure) {
        if (first === second) continue;
        for (let k = flexCount - 1; k >= 1; k--) bases.push({
          name: `Multiattack (${fixedFlex[2]} + ${options[first].name} x${k} + ${options[second].name} x${flexCount - k})`,
          parts: [{ optionIdx: fixedIdx, count: fixedCount }, { optionIdx: first, count: k }, { optionIdx: second, count: flexCount - k }],
        });
      }
    }
    if (bases.length) return bases;
  }

  // A single attack using one of two names, as well as a count of another attack.
  const primaryPlus = segment.match(new RegExp(`makes\\s+(${NUM})\\s+attacks?\\s+using\\s+(.+?),?\\s+as well as\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]+?) attacks?`, "i"));
  if (primaryPlus) {
    const tailIdx = findOption(options, primaryPlus[4]);
    if (tailIdx >= 0) {
      for (const name of primaryPlus[2].split(/\s+or\s+|\s+and\s+|,\s*/i).map((s) => s.trim()).filter(Boolean)) {
        const idx = findOption(options, name);
        if (idx >= 0) bases.push({
          name: `Multiattack (${name} + ${primaryPlus[4]})`,
          parts: [{ optionIdx: idx, count: wordNumber(primaryPlus[1]) }, { optionIdx: tailIdx, count: wordNumber(primaryPlus[3]) }],
        });
      }
    }
    if (bases.length) return bases;
  }

  // A first noun that omits the repeated "attack" (a bare weapon name, then a count and another attack name).
  const sharedAttackNoun = segment.match(new RegExp(`makes\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]+?)\\s+and\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]+?) attacks?`, "i"));
  if (sharedAttackNoun) {
    const firstIdx = findOption(options, sharedAttackNoun[2]);
    // The second name can be an action compiled as several variants (a count of unarmed strike
    // attacks and one attack that names an action with three variants). One routine per
    // variant; a name with one option compiles the one routine named "Multiattack", as before.
    const secondIdxs = findOptions(options, sharedAttackNoun[4]);
    if (firstIdx >= 0 && secondIdxs.length) {
      for (const secondIdx of secondIdxs) {
        bases.push({
          name: secondIdxs.length > 1 ? `Multiattack (${options[firstIdx].name} + ${options[secondIdx].name})` : "Multiattack",
          parts: [{ optionIdx: firstIdx, count: wordNumber(sharedAttackNoun[1]) }, { optionIdx: secondIdx, count: wordNumber(sharedAttackNoun[3]) }],
        });
      }
      return withExtraUses(bases, segment, options);
    }
  }

  const combo = segment.match(new RegExp(`makes\\s+(${NUM})\\s+attacks?,?\\s+using\\s+(.+?)(?:\\s+in any combination|,? or both\\b|,? or a combination of them)`, "i"));
  if (combo) {
    const count = wordNumber(combo[1]);
    // Each item can carry its own possessive: a list of weapons each with "its", ending in "or both".
    for (const name of combo[2].split(/\s+or\s+|\s+and\s+|,\s*/i).map((s) => s.replace(/^(?:or|and)\s+/i, "").replace(/^(?:its|his|her|their)\s+/i, "").trim()).filter(Boolean)) {
      // A name with several variant options (a named attack with variant forms)
      // is one pure routine per variant.
      for (const idx of findOptions(options, name)) bases.push({ name: `Multiattack (${name})`, parts: [{ optionIdx: idx, count }] });
    }
    // "In any combination" also allows the mixed volleys: for each ordered pair of the named options, every split of
    // the count with the first option's attacks made first (a Paralyzing Touch and then two Eldritch Bursts, a Harpoon
    // that pulls and then a Bite). Interleaved orders (X, Y, X) are not offered. Expected value chooses among them.
    if (/\bin any combination\b/i.test(segment) && count > 1) {
      const pure = bases.map((base) => base.parts[0].optionIdx);
      const mixed: Routine[] = [];
      for (const first of pure) for (const second of pure) {
        if (first === second) continue;
        for (let k = count - 1; k >= 1; k--) mixed.push({
          name: `Multiattack (${options[first].name} x${k} + ${options[second].name} x${count - k})`,
          parts: [{ optionIdx: first, count: k }, { optionIdx: second, count: count - k }],
        });
      }
      bases.push(...mixed.slice(0, 12));
    }
    // Two attacks chosen from two names "in any combination", with a ", and" tail that
    // uses another option. The tail was read by every other branch and dropped by this one, so the creature never
    // used it. Only the same-sentence ", and" tail: the same wording with the use in a following sentence ("It also
    // uses ...") is the same gap in another wording, handled separately.
    // The separate sentence, an "It also uses ..." after the "in any combination" sentence,
    // joins each routine too.
    return /\bin any combination,\s+and\b/i.test(segment) || /\bin any combination\.\s+(?:It|He|She|They|The [A-Za-z'-]+)\s+(?:can\s+)?also\s+uses?\b/.test(segment)
      ? withExtraUses(bases, segment, options)
      : bases;
  }

  // A count of attacks for each of two named options, ending in "or a combination thereof."
  // Each count is the whole allowance under one option, not a slot to be added to the others:
  // summing them let a creature swing six times a turn instead of three.
  if (/\bor a combination thereof\b/i.test(baseSegment)) {
    const alternatives: Routine[] = [];
    for (const pair of baseSegment.matchAll(new RegExp(`(${NUM})\\s+([A-Za-z][A-Za-z' -]*?)\\s+attacks?\\b`, "gi"))) {
      const name = pair[2].trim();
      const idx = findOption(options, name);
      if (idx >= 0) alternatives.push({ name: `Multiattack (${name})`, parts: [{ optionIdx: idx, count: wordNumber(pair[1]) }] });
    }
    if (alternatives.length > 1) {
      return withExtraUses(alternatives, baseSegment, options);
    }
  }

  // A count of attacks each of which can be one of two names, or a count followed by a comma list of names:
  // interchangeable names, so emit one N-count routine per name and let EV pick.
  const interchangeable = segment.match(EACH_RE) || segment.match(LIST_RE);
  if (interchangeable) {
    const count = wordNumber(interchangeable[1]);
    for (const name of interchangeable[2].split(/,\s*|\s+or\s+|\s+and\s+/i).map((s) => s.replace(/^(?:or|and)\s+/i, "").replace(/^an?\s+/i, "").trim()).filter(Boolean)) {
      const idx = findOption(options, name);
      if (idx >= 0) bases.push({ name: `Multiattack (${name})`, parts: [{ optionIdx: idx, count }] });
    }
    if (bases.length) {
      return withExtraUses(bases, segment, options);
    }
  }

  // "as many Bite attacks as it has heads", and the same with a second clause adding one attack of another name,
  // which the Bite-only pattern missed outright. Every creature in
  // the data written this way has five heads.
  const heads = segment.match(new RegExp(`as many ([A-Za-z][A-Za-z' -]*?) attacks as it has heads(?:\\s+and\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]*?)\\s+attacks?\\b)?`, "i"));
  if (heads) {
    const idx = findOption(options, heads[1]);
    if (idx >= 0) {
      const parts = [{ optionIdx: idx, count: 5 }];
      const extra = heads[3] ? findOption(options, heads[3]) : -1;
      if (extra >= 0) parts.push({ optionIdx: extra, count: wordNumber(heads[2]) });
      bases.push({ name: `Multiattack (${options[idx].name})`, parts });
    }
    return bases;
  }

  // Older wording commonly spells out mixed slots: a total, a colon, then "one with its W" and
  // "two with its X" (sometimes using an em dash or "one to constrict").
  // The determiner is optional: "twice with W", "one with W" (after its item tag is
  // gone), or a slot that gives a bare attack name. Requiring "its/his/her" cost several creatures one or more of
  // their attacks —
  // silently, because a routine still came out, just a short one. A bare name has to be written
  // as a Name, though, so prose like "with advantage" is not read as a weapon.
  const slotRe = new RegExp(`(${NUM})\\s+(?:attacks?\\s+)?(?:with\\s+(?:either\\s+)?((?:its|his|her|their|an?)\\s+)?|(to)\\s+)([A-Za-z][A-Za-z' -]*?)(?=,|\\s+and\\s+(?:${NUM})\\s+(?:with|to)\\b|[—-]?\\s*and\\s+then\\b|[—-]?\\.|[—-]?$)`, "gi");
  const slotMatches = [...baseSegment.matchAll(slotRe)]
    .filter((m) => m[2] || m[3] || /^[A-Z]/.test(m[4]))
    .map((m) => ({ index: m.index ?? 0, name: m[4], count: wordNumber(m[1]) }));

  // A total, a colon, then slots mixing "one X attack" and "one attack with its Y".
  // The colon states a total and then enumerates the slots that make it up — and the same
  // sentence mixes both shapes the parser knows, "one X attack" and "one attack with its Y".
  // Read by one pattern each they became two competing routines of one attack apiece, so a
  // three-attack creature swung once. They belong to a single routine, in the order written.
  const colonTotal = baseSegment.match(new RegExp(`makes\\s+(${NUM})\\s+attacks?:`, "i"));
  if (colonTotal) {
    const found = [
      ...slotMatches,
      ...[...baseSegment.matchAll(ATTACK_RE)].map((m) => ({ index: m.index ?? 0, name: m[2], count: wordNumber(m[1]) })),
    ].sort((a, b) => a.index - b.index);
    const routines = slotRoutines(found, options);
    if (routines.length) return withExtraUses(routines, segment, options);
  }

  if (slotMatches.length) bases.push(...slotRoutines(slotMatches, options));

  // A count of attacks "with its X", and the form "attacks twice with" one or two names.
  if (!bases.length) {
    const withMatch = segment.match(new RegExp(`(?:makes\\s+(${NUM})\\s+attacks?|attacks\\s+(twice|thrice))\\s+(?:with|using)\\s+(?:one of\\s+)?(?:(?:its|his|her|their|an?)\\s+)?(.+?)(?=\\s+(?:and|or)\\s+(?:uses?|casts?)\\b|\\.|$)`, "i"));
    if (withMatch) {
      const count = wordNumber(withMatch[1] || withMatch[2]);
      const rawNames = withMatch[3].replace(/^(?:melee|ranged)\s+/, "").trim();
      const names = /weapons?$/i.test(rawNames)
        ? options.filter((o) => o.timing === "action" && o.action.kind === "attack").map((o) => o.name)
        : rawNames.split(/,\s*|\s+or\s+|\s+and\s+/i).map((name) => name.trim()).filter(Boolean);
      for (const name of names) {
        const idx = findOption(options, name);
        if (idx >= 0) bases.push({ name: `Multiattack (${name})`, parts: [{ optionIdx: idx, count }] });
      }
    }
  }

  const matches = [...baseSegment.matchAll(ATTACK_RE)];
  if (matches.length === 1) {
    // Single clause; names may hold alternatives: "two Javelin or Morningstar attacks".
    const count = wordNumber(matches[0][1]);
    for (const name of matches[0][2].split(/\s+or\s+/).map((s) => s.trim())) {
      for (const idx of findOptions(options, name)) {
        bases.push({ name: `Multiattack (${name})`, parts: [{ optionIdx: idx, count }] });
      }
    }
  } else if (matches.length > 1) {
    // Combined clauses: a count of one attack and a count of another, joined by "and".
    // A slot can name alternatives, "one X or Y attack and one Z
    // attack", or a slot of two names after a count, as in a clause with another count before it. The
    // first resolving alternative was taken and the other never joined a Multiattack. One routine per way of filling the
    // slots, for expected value to choose between (as `slotRoutines` does for the "one with its X or Y" form); a slot
    // printed "in any combination" (a count, two names joined by "or", then "attacks in any combination")
    // offers every split of its count between its alternatives. A slot with one resolving name compiles as before.
    let combos: { optionIdx: number; count: number }[][] = [[]];
    for (const match of matches) {
      const count = wordNumber(match[1]);
      const idxs = [...new Set(match[2].split(/\s+or\s+/).map((name) => findOption(options, name.trim())).filter((idx) => idx >= 0))];
      if (!idxs.length) continue;
      const anyCombination = idxs.length === 2 && count > 1
        && /^\s+in any combination\b/i.test(baseSegment.slice((match.index ?? 0) + match[0].length));
      const fills: { optionIdx: number; count: number }[][] = anyCombination
        ? Array.from({ length: count + 1 }, (_, second) => [{ optionIdx: idxs[0], count: count - second }, { optionIdx: idxs[1], count: second }]
          .filter((part) => part.count > 0))
        : idxs.map((optionIdx) => [{ optionIdx, count }]);
      combos = combos.flatMap((combo) => fills.map((fill) => [...combo, ...fill.map((part) => ({ ...part }))])).slice(0, 16);
    }
    const filled = combos.filter((parts) => parts.length);
    for (const parts of filled) {
      bases.push({ name: filled.length > 1 ? `Multiattack (${parts.map((p) => `${options[p.optionIdx].name} x${p.count}`).join(" + ")})` : "Multiattack", parts });
    }
  }

  const usesTimes = segment.match(new RegExp(`uses\\s+(?:its\\s+)?([A-Z][A-Za-z' -]+?)\\s+((?:${NUM})\\s+times|twice|thrice)`, "i"));
  if (usesTimes) {
    const idx = findOption(options, usesTimes[1]);
    if (idx >= 0) bases.push({ name: `Multiattack (${usesTimes[1]})`, parts: [{ optionIdx: idx, count: wordNumber(usesTimes[2].replace(/\s+times$/i, "")) }] });
  }

  // A count and a plural noun for strikes ("makes three unarmed strikes"), with the word "attack" absent from
  // the sentence. Every other pattern keys on "attack", so the creature struck once.
  if (!bases.length && !/\b[Aa]ttacks?\b/.test(segment)) {
    const noun = segment.match(new RegExp(`makes\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]+?)s\\b`, "i"));
    for (const idx of noun ? findOptions(options, noun[2].trim()) : []) {
      bases.push({ name: `Multiattack (${options[idx].name})`, parts: [{ optionIdx: idx, count: wordNumber(noun![1]) }] });
    }
  }

  // Last-resort older shorthand: a count of "melee/weapon attacks" without naming the action,
  // and the barest form of all, a subject that "attacks twice", which names neither a weapon nor
  // even the word "with". Emit one routine per compatible attack so EV can choose.
  if (!bases.length) {
    const generic = segment.match(new RegExp(`makes\\s+(${NUM})\\s+(melee|ranged|weapon|melee weapon|ranged weapon)?\\s*attacks?\\b`, "i"));
    const bare = generic ? null : segment.match(new RegExp(`\\battacks?\\s+(twice|thrice|(?:${NUM})\\s+times)\\s*[.,]?\\s*$`, "i"));
    if (generic || bare) {
      const count = generic ? wordNumber(generic[1]) : wordNumber(bare![1].replace(/\s+times$/i, ""));
      const mode = (generic?.[2] || "").toLowerCase();
      options.forEach((option, optionIdx) => {
        if (option.timing !== "action" || option.action.kind !== "attack") return;
        if (mode.includes("melee") && !option.action.melee) return;
        if (mode.includes("ranged") && !option.action.ranged) return;
        const maxDistance = mode.includes("melee") && option.action.kind === "attack"
          ? option.action.reach ?? option.action.range ?? 5
          : undefined;
        bases.push({ name: `Multiattack (${option.name})`, parts: [{ optionIdx, count }], maxDistance });
      });
    }
  }

  return withExtraUses(bases, segment, options);
}

/**
 * A block that takes three actions: it uses two named actions and casts one
 * spell that takes 1 action to cast. The two named actions always, plus one routine per action-time spell option
 * compiled from the block's spellcasting (and the pair alone, the fallback when no spell is usable), so expected value
 * picks the spell. Only this wording; the action count must equal the parts (two uses and one spell).
 */
const USES_AND_CASTS_RE = new RegExp(`\\btakes\\s+(${NUM})\\s+actions:\\s+(?:it|he|she|they)\\s+uses\\s+([A-Z][A-Za-z' -]+?)\\s+and\\s+([A-Z][A-Za-z' -]+?),\\s+and\\s+(?:it|he|she|they)\\s+casts\\s+a\\s+spell\\s+with\\s+a\\s+casting\\s+time\\s+of\\s+1\\s+action\\b`, "i");

function usesAndCastsRoutines(text: string, options: ActionOption[]): Routine[] | undefined {
  const match = text.match(USES_AND_CASTS_RE);
  if (!match || wordNumber(match[1]) !== 3) return undefined;
  const first = findOption(options, match[2].trim());
  const second = findOption(options, match[3].trim());
  if (first < 0 || second < 0) return undefined;
  const base = `Multiattack (${options[first].name} + ${options[second].name}`;
  const pair = () => [{ optionIdx: first, count: 1 }, { optionIdx: second, count: 1 }];
  const spells = options.map((option, idx) => ({ option, idx }))
    .filter(({ option }) => option.timing === "action" && /\.spellcasting$/.test(option.sourceRef ?? ""));
  return [
    { name: `${base})`, parts: pair() },
    ...spells.map(({ option, idx }) => ({ name: `${base} + ${option.name})`, parts: [...pair(), { optionIdx: idx, count: 1 }] })),
  ];
}

/**
 * A use printed before the attacks, in forms like a use followed by "and makes" a count of
 * attacks, "can use" a named feature then "and makes" or "make" attacks, a use in one sentence and an "also makes" or
 * "then makes" in the next, or a list of names (one with "(if available)", one of them Spellcasting) joined by "or". Returns
 * the attack clause that follows ("makes ...") for the ordinary readers, and
 * the use's alternatives; the caller puts the use first in each routine. "Can", "(if available)" or more than one name
 * make it a choice (the attack-only routines stay); a single plain "uses" is folded into every routine. A Spellcasting
 * alternative is not read here (the Spellcasting substitute reader handles it). Only when no tail reader finds a use in the
 * whole text: a use sentence with "if available" followed by "It also makes ..." is read as a tail, and
 * stays so.
 */
function leadUse(text: string, options: ActionOption[]): { rest: string; choice: boolean; idxs: number[] } | undefined {
  const match = text.match(/^(?:The\s+[a-z][A-Za-z'-]*(?:\s+(?!can\b|uses?\b)[a-z][A-Za-z'-]*)?|[A-Z][A-Za-z'-]+)\s+(can\s+)?uses?\s+(?:(?:its|his|her|their)\s+)?([A-Z].*?)(?:\s+and\s+makes?\s+|\.\s+(?:It|He|She|They)\s+(?:also|then)\s+makes\s+)/);
  if (!match || extraUsesAlternatives(text, options).idxs.length) return undefined;
  const names = match[2].split(/\s*,\s*(?:or\s+)?|\s+or\s+/i).map((name) => name.trim()).filter(Boolean);
  // A Spellcasting alternative is one per action-time spell option.
  const idxs = names.flatMap((name) => /^Spellcasting$/i.test(name) ? spellcastingIdxs(options) : findOptions(options, name));
  if (!idxs.length) return undefined;
  return {
    rest: `makes ${text.slice((match.index ?? 0) + match[0].length)}`,
    choice: !!match[1] || /\(if available\)/i.test(match[2]) || names.length > 1 || idxs.length > 1,
    idxs,
  };
}

/**
 * A clause that makes one attack "or uses" a named option "if available", followed by a second
 * clause making more attacks: the use is the alternative to the first attack, in its place in the routine.
 */
function leadAlternativeRoutines(text: string, routines: Routine[], options: ActionOption[]): Routine[] {
  const match = text.match(/\bmakes one ([A-Za-z][A-Za-z' -]*?) attack or uses ([A-Z][A-Za-z' -]+?)(?:,?\s+if available)?, and (?:it|he|she|they) makes\b/);
  const oldIdx = match ? findOption(options, match[1]) : -1;
  const newIdx = match ? findOption(options, match[2]) : -1;
  if (oldIdx < 0 || newIdx < 0) return [];
  return routines.filter((routine) => routine.parts[0]?.optionIdx === oldIdx && routine.parts[0].count === 1).map((routine) => ({
    ...routine,
    name: `${routine.name} (${options[oldIdx].name} -> ${options[newIdx].name})`,
    parts: [{ optionIdx: newIdx, count: 1 }, ...routine.parts.slice(1).map((part) => ({ ...part }))],
  }));
}

/**
 * A count of attacks of one name, a count of another, "or one of each" is three
 * alternatives, X x2, Y x2 and X + Y, not one routine of four attacks. The alternative split reads "or one" as the start of
 * a new clause, so this is read on the whole text, before the split. Only the "attacks, ... attacks, or one of each"
 * wording; a use list that ends "each one once" is not read here.
 */
function oneOfEachRoutines(text: string, options: ActionOption[]): Routine[] | undefined {
  const match = text.match(new RegExp(`\\bmakes\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]*?)\\s+attacks?,\\s+(${NUM})\\s+([A-Za-z][A-Za-z' -]*?)\\s+attacks?,\\s+or one of each\\b`, "i"));
  if (!match) return undefined;
  const first = findOption(options, match[2]);
  const second = findOption(options, match[4]);
  if (first < 0 || second < 0) return undefined;
  return [
    { name: `Multiattack (${options[first].name})`, parts: [{ optionIdx: first, count: wordNumber(match[1]) }] },
    { name: `Multiattack (${options[second].name})`, parts: [{ optionIdx: second, count: wordNumber(match[3]) }] },
    { name: `Multiattack (${options[first].name} + ${options[second].name})`, parts: [{ optionIdx: first, count: 1 }, { optionIdx: second, count: 1 }] },
  ];
}

/**
 * A count of melee attacks of which only one can be a named attack, or a form-specific sentence
 * that limits one of these attacks to a named attack. The generic readers offer one routine per attack, X x N among
 * them; the limit replaces X x N with one X after
 * N - 1 of each other attack those readers offer (O x N becomes O x (N - 1) + X x 1). The limited attack goes last: a
 * Bite that needs a grappled, incapacitated or restrained target may depend on an earlier attack making it so. An
 * attack printed for another form ("(Medusa Form Only)" against "(Serpent Form Only)") is not paired with it.
 */
function limitOneOf(text: string, routines: Routine[], options: ActionOption[]): Routine[] {
  const match = text.match(/\bonly one of (?:which|these attacks) can be (?:an? )?([A-Za-z][A-Za-z' -]*?)(?: attack)?(?:\.|,|$)/i);
  const limited = match ? findOption(options, match[1]) : -1;
  if (limited < 0) return routines;
  const form = (idx: number) => options[idx].name.match(/\(([^)]*\bForm Only)\)/i)?.[1].toLowerCase();
  const out: Routine[] = [];
  for (const routine of routines) {
    const [only] = routine.parts;
    if (routine.parts.length !== 1 || only.optionIdx !== limited || only.count < 2) {
      out.push(routine);
      continue;
    }
    for (const other of routines) {
      const [part] = other.parts;
      if (other.parts.length !== 1 || part.optionIdx === limited || part.count !== only.count) continue;
      if (form(limited) && form(part.optionIdx) && form(limited) !== form(part.optionIdx)) continue;
      out.push({
        name: `Multiattack (${options[part.optionIdx].name} + ${options[limited].name})`,
        parts: [{ optionIdx: part.optionIdx, count: only.count - 1 }, { optionIdx: limited, count: 1 }],
        maxDistance: routine.maxDistance === undefined || other.maxDistance === undefined
          ? routine.maxDistance ?? other.maxDistance
          : Math.min(routine.maxDistance, other.maxDistance),
      });
    }
  }
  return out;
}

/**
 * A sentence that makes a count of attacks, then makes a count of unarmed strike attacks, is
 * all of them: each routine the first clause offers, then the second clause's attacks (an attack the two
 * share is one part). Read on the whole text, before the alternative split; only a ", then makes N X attacks" clause.
 */
function thenClauseRoutines(text: string, options: ActionOption[]): Routine[] | undefined {
  const match = text.match(new RegExp(`^(.*?\\bmakes\\s+(?:${NUM})\\s+attacks?),\\s+then\\s+(makes\\s+(?:${NUM})\\s+[A-Za-z][A-Za-z' -]*?\\s+attacks?)\\.?$`, "i"));
  if (!match) return undefined;
  const firsts = parseSegment(match[1].replace(/^.*?\bmakes\b/i, "makes"), options);
  const seconds = parseSegment(match[2], options);
  if (!firsts.length || !seconds.length) return undefined;
  return firsts.flatMap((first) => seconds.map((second) => {
    const parts = first.parts.map((part) => ({ ...part }));
    for (const part of second.parts) {
      const same = parts.find((p) => p.optionIdx === part.optionIdx);
      if (same) same.count += part.count;
      else parts.push({ ...part });
    }
    return { name: `${first.name} then ${options[second.parts[0].optionIdx].name}`, parts, maxDistance: first.maxDistance };
  }));
}

const SAME_TARGET_BAN_RE = /\bcan['’]t (?:make both attacks against the same (?:target|creature)|target the same (?:target|creature) with both attacks)\b/i;
const SAME_TARGET_BAN_REASON = "the Multiattack's attacks can't both target the same creature (a duel has one target); each attack compiles alone";

export function buildRoutines(actions: { name: string; entries?: unknown }[], options: ActionOption[], skipped: SkipLog[], monsterName: string): Routine[] {
  const routines: Routine[] = [];
  const multi = actions.find((a) => isMultiattack(a.name));

  if (multi) {
    const text = flattenEntries(multi.entries);
    const usesAndCasts = usesAndCastsRoutines(text, options);
    if (usesAndCasts) routines.push(...usesAndCasts);
    // An "or it makes" clause with a count of a named attack, or an "or" with a count of another attack,
    // introduces alternatives, not additional attacks.
    const lead = usesAndCasts ? undefined : leadUse(text, options);
    const normalizedAlternatives = (lead?.rest ?? text).replace(/\bAlternatively,\s+(?:the [A-Za-z'-]+\s+)?/gi, " OR_ALT ");
    // An alternative can also be a *use* rather than attacks (an "or it uses" clause with a count of times), and an
    // "Alternatively, it can make" clause with a count of attacks is the same thing in the
    // subjunctive; neither was recognised, so the whole branch was lost.
    // A bare Spellcasting tail: an "or makes" clause with an attack and a use of Spellcasting drops the pronoun
    // too; read without one only before that spell tail.
    // Two more continuations the split
    // did not recognise, so both alternatives were read as one clause. A use with no pronoun (an "or uses its" clause
    // that then makes a bite attack), or one that repeats a use a number of times; and an article where the split
    // wanted a count word (an "or" followed by "a" before each of two attack names). The article form is read only
    // before "<Name> attack and", so a slot's "one X or a Y attack" stays one clause.
    const altSplit = new RegExp(`\\s+OR_ALT\\s+|,? or (?=(?:it|he|she|they) (?:makes|uses|can make) |(?:${NUM})\\s|makes [^.]*?\\band uses Spellcasting\\b|uses (?:its|his|her|their) |an? [A-Z][A-Za-z' -]*? attack and )`, "i");
    const segments = normalizedAlternatives.split(altSplit).map((raw, i) => {
      if (i === 0) return raw.replace(/^it makes\s+/i, "makes ");
      // Alternatives are written as continuations, with the subject and sometimes the verb
      // elided by the comma. Restore them so each parses like a standalone Multiattack clause.
      const body = raw.replace(/^\s*(?:it|he|she|they)\s+/i, "").replace(/^\s*can\s+make\b/i, "makes").trim();
      return /^(?:makes|uses)\b/i.test(body) ? body : `makes ${body}`;
    });
    // A shared closing tail: a closing ", and (it) uses X (if available)"
    // after sentence-level alternatives belongs to each of them: alternatives of different attack counts followed by a
    // use with "if available", or a pronoun and "its" before the named option. The split left the tail with the last
    // alternative only. Only the comma form, and only for an earlier alternative that names no use of its own: a
    // no-comma tail that pairs one of those attacks with Spellcasting is the last alternative's own.
    const sharedTail = segments.length > 1
      ? segments[segments.length - 1].match(/,\s+and\s+(?:(?:it|he|she|they)\s+)?uses\s+(?:(?:its|his|her|their)\s+)?[A-Z][A-Za-z' -]+?(?:\s+if available)?\.?\s*$/)
      : null;
    if (sharedTail) {
      for (let i = 0; i < segments.length - 1; i++) {
        if (!/\buses\b/.test(segments[i])) segments[i] = segments[i].replace(/[.,]?\s*$/, "") + sharedTail[0];
      }
    }
    let previous: Routine[] = [];
    const eachOne = usesAndCasts ? undefined : oneOfEachRoutines(text, options) ?? thenClauseRoutines(text, options);
    if (eachOne) routines.push(...eachOne);
    for (const segment of usesAndCasts || eachOne ? [] : segments) {
      // A last alternative of one of the earlier attacks followed by a use of Spellcasting:
      // one attack with any option the previous alternative named, then the spell tail.
      const ofThose = previous.length && /^makes one of (?:those|these) attacks\b/i.test(segment)
        ? withExtraUses([...new Set(previous.flatMap((routine) => routine.parts.map((part) => part.optionIdx)))]
          .map((idx) => ({ name: `Multiattack (${options[idx].name} x1)`, parts: [{ optionIdx: idx, count: 1 }] })), segment, options)
        : undefined;
      // An alternative that opens with a use, then makes a
      // bite attack: the named option first, then the attacks the rest prints.
      const leadIn = ofThose ? null : segment.match(/^uses (?:its|his|her|their) ([A-Z][A-Za-z' -]*?) and (makes\b.*)$/i);
      const leadInIdx = leadIn ? findOption(options, leadIn[1]) : -1;
      const parsed = ofThose ?? (leadIn && leadInIdx >= 0
        ? parseSegment(leadIn[2], options).map((routine) => ({
          ...routine,
          name: `${routine.name} + ${options[leadInIdx].name} first`,
          parts: [{ optionIdx: leadInIdx, count: 1 }, ...routine.parts.map((part) => ({ ...part }))],
        }))
        : parseSegment(segment, options));
      routines.push(...parsed);
      previous = parsed;
    }

    routines.splice(0, routines.length, ...limitOneOf(text, routines, options));
    const baseRoutines = [...routines];
    const swaps = replacementIdxs(text, options).map((idx) => ({ idx, count: 1 }));
    for (const swap of replacementSwaps(text, options)) {
      if (!swaps.some((known) => known.idx === swap.idx && known.count === swap.count)) swaps.push(swap);
    }
    for (const { idx, count } of swaps) {
      for (const base of baseRoutines) {
        const swapped = swapRoutine(base, count, idx, `${base.name} + ${count > 1 ? `${count} attacks -> ` : ""}${options[idx].name}`, options);
        if (swapped) routines.push(swapped);
        // A sentence that lets the creature replace one of the/these
        // attacks with X over a base of different attacks (two attack names, each with its own count) names
        // no attack, so the one given up may be any of them. `swapRoutine` takes it from the first part only; this adds
        // the routine that gives up one attack of each later part. Attack parts only (a use, such as an Engulf, is not
        // "one of these attacks").
        if (swapped && count === 1 && GENERIC_ONE_ATTACK_SWAP_RE.test(text) && options[base.parts[0].optionIdx]?.action.kind === "attack") {
          for (let give = 1; give < base.parts.length; give++) {
            if (options[base.parts[give].optionIdx]?.action.kind !== "attack") continue;
            const parts = base.parts.map((p, i) => ({ ...p, count: i === give ? p.count - 1 : p.count })).filter((p) => p.count > 0);
            routines.push({ name: `${base.name} + ${options[idx].name} (for ${options[base.parts[give].optionIdx].name})`, parts: [...parts, swapPart(options, idx)], maxDistance: base.maxDistance });
          }
        }
      }
    }

    // "It can replace any attack with a use of X": every attack may be given up, so X in place of all of them is a
    // routine too (the single swaps are above).
    if (/\breplace any attack with\b/i.test(text)) {
      for (const { idx } of swaps) {
        for (const base of baseRoutines) {
          const total = base.parts.reduce((sum, part) => sum + part.count, 0);
          if (total < 2 || base.parts.some((part) => options[part.optionIdx]?.action.kind !== "attack")) continue;
          routines.push({ name: `${base.name} + ${total} attacks -> ${options[idx].name}`, parts: [swapPart(options, idx, total)] });
        }
      }
    }

    // A sentence that lets the creature cast a spell of a one-action casting time instead of
    // one named attack, or instead of any of these attacks: one swap per action-time
    // spell option, replacing the named attack, or each different attack when "one of these attacks" leaves the
    // choice.
    const castInPlace = text.match(/\bcan cast a spell with a casting time of 1 action in place of one (?:of these attacks|([a-z][A-Za-z' -]*?) attack)\b/i);
    const namedOld = castInPlace?.[1] ? findOption(options, castInPlace[1]) : -1;
    if (castInPlace && (!castInPlace[1] || namedOld >= 0)) {
      for (const idx of spellcastingIdxs(options)) {
        for (const base of baseRoutines) {
          if (base.parts.reduce((sum, part) => sum + part.count, 0) < 2) continue;
          for (const old of new Set(base.parts.map((part) => part.optionIdx).filter((old) => namedOld < 0 || old === namedOld))) {
            const parts = base.parts.map((part) => ({ ...part }));
            parts.find((part) => part.optionIdx === old)!.count -= 1;
            routines.push({
              name: `${base.name} (${options[old].name} -> ${options[idx].name})`,
              parts: [...parts.filter((part) => part.count > 0), swapPart(options, idx)],
              maxDistance: base.maxDistance,
            });
          }
        }
      }
    }

    // A sentence that lets the creature use a named option instead of any of these attacks, or
    // "substitute" a named option for one of these
    // attacks: one swap per different attack the routine holds, the substitute last, the unreplaced
    // routine kept. A named option only (capitalised, not Spellcasting: the Spellcasting substitute reader handles that).
    const substitute = text.match(/\b(?:can|may) (?:use ([A-Z][A-Za-z' -]+?) in place of|substitute ([A-Z][A-Za-z' -]+?) for) one of (?:these|the|those|its) attacks\b/);
    const substituteIdx = substitute && !/^Spellcasting$/i.test(substitute[1] ?? substitute[2]) ? findOption(options, substitute[1] ?? substitute[2]) : -1;
    if (substituteIdx >= 0) {
      for (const base of baseRoutines) {
        if (base.parts.reduce((sum, part) => sum + part.count, 0) < 2) continue;
        for (const old of new Set(base.parts.map((part) => part.optionIdx))) {
          const parts = base.parts.map((part) => ({ ...part }));
          parts.find((part) => part.optionIdx === old)!.count -= 1;
          routines.push({
            name: `${base.name} (${options[old].name} -> ${options[substituteIdx].name})`,
            parts: [...parts.filter((part) => part.count > 0), swapPart(options, substituteIdx)],
            maxDistance: base.maxDistance,
          });
        }
      }
    }

    // Named replacement: a sentence that replaces one of its attacks with a named option under an "if" condition.
    for (const match of text.matchAll(/replace (?:(?:its|the)\s+|one\s+)([A-Z][A-Za-z' -]+?) [Aa]ttack with (?:a use of |an? )?([A-Z][A-Za-z' -]+?)(?=\s+if\b|\.|,|$)/g)) {
      const oldIdx = findOption(options, match[1]);
      const newIdx = findOption(options, match[2]);
      if (oldIdx < 0 || newIdx < 0) continue;
      for (const base of baseRoutines.filter((routine) => routine.parts.some((part) => part.optionIdx === oldIdx && part.count > 0))) {
        const parts = base.parts.map((part) => ({ ...part }));
        const replaced = parts.find((part) => part.optionIdx === oldIdx && part.count > 0)!;
        replaced.count -= 1;
        routines.push({
          name: `${base.name} (${match[1]} -> ${match[2]})`,
          parts: [...parts.filter((part) => part.count > 0), swapPart(options, newIdx)],
          maxDistance: base.maxDistance,
        });
      }
    }

    // The named form in the wordings the pattern above misses: a lowercase weapon (a sentence replacing one javelin
    // attack with a named option), "its <Breath>", a spell (a vine attack replaced with a use of
    // Spellcasting to cast a named spell), and the passive "Up to two X attacks can be
    // replaced by" a named option. A routine the pattern above already made is not made twice.
    const same = (a: Routine, b: Routine) => a.maxDistance === b.maxDistance && a.parts.length === b.parts.length
      && a.parts.every((part) => b.parts.some((other) => other.optionIdx === part.optionIdx && other.count === part.count));
    for (const clause of replacementClauses(text)) {
      if (clause.old === undefined) continue;
      const oldIdx = findOption(options, clause.old);
      if (oldIdx < 0) continue;
      for (const newIdx of replacementTargets(clause.tail, options)) {
        for (const base of baseRoutines.filter((routine) => routine.parts.some((part) => part.optionIdx === oldIdx && part.count > 0))) {
          const parts = base.parts.map((part) => ({ ...part }));
          parts.find((part) => part.optionIdx === oldIdx && part.count > 0)!.count -= 1;
          const swapped: Routine = {
            name: `${base.name} (${options[oldIdx].name} -> ${options[newIdx].name})`,
            parts: [...parts.filter((part) => part.count > 0), { optionIdx: newIdx, count: 1 }],
            maxDistance: base.maxDistance,
          };
          if (!routines.some((routine) => same(routine, swapped))) routines.push(swapped);
          // "Up to N": the swaps of 2..N of the named attack, beside the one-attack swap and the unreplaced routine.
          for (let k = 2; k <= (clause.upTo ?? 1); k++) {
            const more = base.parts.map((part) => ({ ...part }));
            const oldPart = more.find((part) => part.optionIdx === oldIdx && part.count > 0)!;
            if (oldPart.count < k) break;
            oldPart.count -= k;
            const swappedMore: Routine = {
              name: `${base.name} (${options[oldIdx].name} x${k} -> ${options[newIdx].name})`,
              parts: [...more.filter((part) => part.count > 0), { optionIdx: newIdx, count: k }],
              maxDistance: base.maxDistance,
            };
            if (!routines.some((routine) => same(routine, swappedMore))) routines.push(swappedMore);
          }
        }
      }
    }

    // A sentence letting the creature spend two named attacks on its breath once the weapon is available
    // (a head or its claws, or a bite or horns in an older statblock):
    // one swap per named attack, the substitute last, the unreplaced routine kept. The substitute is named by a lowercase
    // word ("the breath"), so it is the one action option whose name holds that word (Breath Weapon); two such options,
    // or an old attack that resolves to no option, and nothing is read. The recharge gates the swap in the engine.
    const loose = text.match(/\bcan use (?:the|its) ([a-z][a-z' -]*?) in place of (?:its|his|her|their) ([a-z][a-z' -]*?) or (?:(?:its|his|her|their) )?([a-z][a-z' -]*?)(?=\.|,|;|$)/);
    if (loose) {
      const word = new RegExp(`\\b${loose[1]}\\b`, "i");
      const named = options.flatMap((option, idx) => option.timing === "action" && word.test(option.name) ? [idx] : []);
      const olds = [findOption(options, loose[2]), findOption(options, loose[3])];
      if (named.length === 1 && olds.every((old) => old >= 0 && old !== named[0])) {
        for (const oldIdx of new Set(olds)) {
          for (const base of baseRoutines.filter((routine) => routine.parts.some((part) => part.optionIdx === oldIdx && part.count > 0))) {
            const parts = base.parts.map((part) => ({ ...part }));
            parts.find((part) => part.optionIdx === oldIdx && part.count > 0)!.count -= 1;
            const swapped: Routine = {
              name: `${base.name} (${options[oldIdx].name} -> ${options[named[0]].name})`,
              parts: [...parts.filter((part) => part.count > 0), { optionIdx: named[0], count: 1 }],
              maxDistance: base.maxDistance,
            };
            if (!routines.some((routine) => same(routine, swapped))) routines.push(swapped);
          }
        }
      }
    }

    // A use in place of the first attack, then a lead use first in each
    // routine (after every swap, so a swap never gives up the use in place of an attack).
    routines.push(...leadAlternativeRoutines(text, routines, options));
    if (lead) {
      const plain = routines.splice(0);
      const led = lead.idxs.flatMap((optionIdx) => plain.map((routine) => ({
        ...routine,
        name: `${routine.name} + ${options[optionIdx].name} first`,
        parts: [{ optionIdx, count: 1 }, ...routine.parts.map((part) => ({ ...part }))],
      })));
      routines.push(...(lead.choice ? [...plain, ...led] : led.map((routine, i) => ({ ...routine, name: plain[i].name }))));
    }

    if (!routines.length) skipped.push({ name: "Multiattack", where: `${monsterName}.action`, reason: `unparsed multiattack grammar: ${text}` });

    // A sentence forbidding both attacks against one target
    // (or barring one creature from being hit by both). A duel has one target, so the Multiattack's
    // two attacks are never made together: no routine with more than one attack
    // is offered. Each attack alone is a single-option routine below. The skip line says why no Multiattack routine exists.
    if (SAME_TARGET_BAN_RE.test(text)) {
      const kept = routines.filter((routine) => routine.parts.reduce((sum, part) => sum + part.count, 0) < 2);
      if (kept.length < routines.length) skipped.push({ name: "Multiattack", where: `${monsterName}.action`, reason: SAME_TARGET_BAN_REASON });
      routines.splice(0, routines.length, ...kept);
    }
  }

  // Always include single-action routines: recharge/limited actions (e.g. breath weapons)
  // are not part of Multiattack text and must still compete via EV.
  routines.push(...singleRoutines(options, actions));
  return routines;
}
