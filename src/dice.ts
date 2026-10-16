import type { DicePool } from "./types.ts";

export function parseDice(expr: string): DicePool {
  const cleaned = expr.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?$/i);
  if (!match) throw new Error(`Invalid dice expression: ${expr}`);
  const sign = match[3] === "-" ? -1 : 1;
  return { n: Number(match[1]), d: Number(match[2]), mod: match[4] ? sign * Number(match[4]) : 0 };
}

export function avgDice(dice: DicePool): number {
  return dice.n * (dice.d + 1) / 2 + dice.mod;
}

export function rollDice(dice: DicePool, rng: () => number, doubleDice = false): number {
  let total = dice.mod;
  const count = doubleDice ? dice.n * 2 : dice.n;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rng() * dice.d);
  return total;
}
