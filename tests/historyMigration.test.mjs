import assert from "node:assert/strict";
import test from "node:test";
import { canonicalExerciseName, canonicalizeHistory } from "../src/historyMigration.ts";

test("maps the former rear-delt exercise name to the current card", () => {
  assert.equal(canonicalExerciseName("Rear-delt fly or face pull"), "Rear-delt fly");
  assert.equal(canonicalExerciseName("Rear-delt fly"), "Rear-delt fly");
});

test("moves the former combined calf and ab history to the chosen ab machine card", () => {
  assert.equal(canonicalExerciseName("Calf raise or abdominal work"), "Ab crunch machine");
});

test("merges legacy history into the current exercise without duplicates", () => {
  const shared = { id: "session-1", savedAt: "2026-08-13T06:30:54.413Z", sets: [{ load: "10", reps: "10" }] };
  const migrated = canonicalizeHistory({
    "Rear-delt fly or face pull": [shared],
    "Rear-delt fly": [shared, { id: "session-2", savedAt: "2026-08-14T06:30:54.413Z", sets: [{ load: "12", reps: "12" }] }],
  });

  assert.deepEqual(Object.keys(migrated), ["Rear-delt fly"]);
  assert.deepEqual(migrated["Rear-delt fly"].map((session) => session.id), ["session-2", "session-1"]);
});
