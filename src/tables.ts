import type { Ability } from "./types.ts";

export const abilities: Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

export const longAbility: Record<string, Ability> = {
  strength: "str",
  dexterity: "dex",
  constitution: "con",
  intelligence: "int",
  wisdom: "wis",
  charisma: "cha",
  str: "str",
  dex: "dex",
  con: "con",
  int: "int",
  wis: "wis",
  cha: "cha",
};

export const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twice: 2,
  thrice: 3,
};

export const damageTypes = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
];

export const impactfulConditions = new Set([
  "blinded",
  "charmed",
  "frightened",
  "grappled",
  "incapacitated",
  "paralyzed",
  // Petrification ends a duel outright, so it has to be representable. Every two-stage
  // petrifier in the corpus was otherwise compiling as a plain save-ends Restrained.
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
]);

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function crToNumber(cr: unknown): number {
  const raw = typeof cr === "object" && cr && "cr" in cr ? (cr as { cr: unknown }).cr : cr;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return 0;
  if (raw.includes("/")) {
    const [a, b] = raw.split("/").map(Number);
    return b ? a / b : 0;
  }
  return Number(raw) || 0;
}

export function proficiencyFromCr(cr: number): number {
  if (cr <= 4) return 2;
  if (cr <= 8) return 3;
  if (cr <= 12) return 4;
  if (cr <= 16) return 5;
  if (cr <= 20) return 6;
  if (cr <= 24) return 7;
  if (cr <= 28) return 8;
  return 9;
}

export function normalizeDamageType(type: string | undefined): string {
  return (type || "untyped").toLowerCase();
}
