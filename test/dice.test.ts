import assert from "node:assert/strict";
import test from "node:test";
import { avgDice, parseDice, rollDice } from "../src/dice.ts";
import { mulberry32 } from "../src/rng.ts";

test("parseDice handles NdM, NdM+K, NdM-K, whitespace", () => {
  assert.deepEqual(parseDice("2d10 + 5"), { n: 2, d: 10, mod: 5 });
  assert.deepEqual(parseDice("17d6"), { n: 17, d: 6, mod: 0 });
  assert.deepEqual(parseDice("1d4-1"), { n: 1, d: 4, mod: -1 });
  assert.throws(() => parseDice("banana"));
});

test("avgDice", () => {
  assert.equal(avgDice({ n: 2, d: 6, mod: 3 }), 10);
  assert.equal(avgDice({ n: 1, d: 10, mod: 0 }), 5.5);
});

test("rollDice stays in bounds and doubles dice on crit", () => {
  const rng = mulberry32(42);
  const pool = { n: 2, d: 6, mod: 3 };
  for (let i = 0; i < 1000; i++) {
    const roll = rollDice(pool, rng);
    assert.ok(roll >= 5 && roll <= 15, `roll ${roll} out of bounds`);
    const crit = rollDice(pool, rng, true);
    assert.ok(crit >= 7 && crit <= 27, `crit ${crit} out of bounds`);
  }
});

test("rollDice mean approximates avgDice", () => {
  const rng = mulberry32(7);
  const pool = { n: 3, d: 8, mod: 2 };
  let sum = 0;
  const iters = 20000;
  for (let i = 0; i < iters; i++) sum += rollDice(pool, rng);
  assert.ok(Math.abs(sum / iters - avgDice(pool)) < 0.1);
});
