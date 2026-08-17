import assert from "node:assert/strict";
import test from "node:test";
import { nextStep, setTarget } from "../src/progression.ts";

const session = (load, reps) => ({ sets: reps.map((value) => ({ load, reps: String(value) })) });

test("targets another rep while staying inside the range", () => {
  const history = [session("80", [6, 6, 5])];
  assert.deepEqual(setTarget("5–8", history, 0), { load: "80", reps: "7" });
  assert.deepEqual(setTarget("5–8", history, 2), { load: "80", reps: "6" });
  assert.equal(nextStep("5–8", history), "Add reps within the range next time.");
});

test("repeats top reps once before increasing weight", () => {
  const history = [session("80", [8, 8, 8])];
  assert.deepEqual(setTarget("5–8", history, 0), { load: "80", reps: "8" });
  assert.equal(nextStep("5–8", history), "Repeat the top-end reps once more, then add weight.");
});

test("targets the smallest weight increase after two top sessions", () => {
  const history = [session("80", [8, 8, 8]), session("80", [8, 8, 8])];
  assert.deepEqual(setTarget("5–8", history, 0), { load: "80 + min", reps: "5" });
  assert.equal(nextStep("5–8", history), "Add the smallest available weight next time.");
});

test("guides a reset when reps fall below the range", () => {
  const history = [session("80", [4, 4, 4])];
  assert.deepEqual(setTarget("5–8", history, 0), { load: "≤ 80", reps: "5" });
  assert.equal(nextStep("5–8", history), "Hold or reduce the load until every set is back in range.");
});

test("leaves an unperformed optional set without a target", () => {
  assert.equal(setTarget("5–8", [session("80", [8, 8, 8])], 3), null);
});
