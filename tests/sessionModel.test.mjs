import assert from "node:assert/strict";
import test from "node:test";
import {
  addWorkoutToHistory,
  completeWorkout,
  liftMilestones,
  migrateLegacyHistory,
  nextWorkout,
  workoutSummary,
} from "../src/sessionModel.ts";

const active = { id: "5ea0ebd5-a632-4bda-9fb6-8bbf5799ac0a", workout: "push", startedAt: "2026-08-23T05:00:00.000Z" };
const definitions = [
  { name: "Barbell bench press", priority: "must" },
  { name: "Incline dumbbell bench press", priority: "must", loadSuffix: " each" },
  { name: "Chest press machine", priority: "optional" },
];

test("keeps the rolling sequence independent of weekdays", () => {
  assert.equal(nextWorkout("push"), "pull");
  assert.equal(nextWorkout("pull"), "legs");
  assert.equal(nextWorkout("legs"), "push");
});

test("finishes a shortened workout without requiring every must-do exercise", () => {
  const result = completeWorkout({
    active,
    definitions,
    drafts: { "Barbell bench press": [{ load: "57.5", reps: "6" }, { load: "57.5", reps: "5" }] },
    bodyweight: "64.6",
    note: "Short session before work.",
    endedAt: "2026-08-23T06:00:00.000Z",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.session.exercises.length, 1);
  assert.equal(result.session.sync.status, "unsynced");
});

test("rejects a partially entered set without manufacturing missing work", () => {
  const result = completeWorkout({
    active,
    definitions,
    drafts: { "Barbell bench press": [{ load: "57.5", reps: "" }] },
    bodyweight: "",
    note: "",
    endedAt: "2026-08-23T06:00:00.000Z",
  });
  assert.match(result.error, /valid rep count/);
});

test("builds readable Autumn prose and labels per-dumbbell loads", () => {
  const result = completeWorkout({
    active,
    definitions,
    drafts: {
      "Barbell bench press": [{ load: "57.5", reps: "6" }, { load: "57.5", reps: "5" }],
      "Incline dumbbell bench press": [{ load: "22.5", reps: "8" }, { load: "22.5", reps: "8" }],
    },
    bodyweight: "64.6",
    note: "Felt fresh.",
    endedAt: "2026-08-23T06:00:00.000Z",
  });
  assert.equal(workoutSummary(result.session), [
    "Push day.",
    "",
    "Barbell bench press: 57.5 kg × 6, 5",
    "Incline dumbbell bench press: 22.5 kg each × 8, 8",
    "",
    "Bodyweight: 64.6 kg.",
    "",
    "Felt fresh.",
  ].join("\n"));
});

test("adds completed exercises to progression history under one workout identity", () => {
  const result = completeWorkout({
    active,
    definitions,
    drafts: { "Barbell bench press": [{ load: "57.5", reps: "6" }] },
    bodyweight: "",
    note: "",
    endedAt: "2026-08-23T06:00:00.000Z",
  });
  const history = addWorkoutToHistory({}, result.session);
  assert.equal(history["Barbell bench press"][0].id, `${active.id}:Barbell bench press`);
  assert.deepEqual(history["Barbell bench press"][0].sets, [{ load: "57.5", reps: "6" }]);
});

test("groups legacy exercise history into dated workouts without making it syncable", () => {
  const history = {
    "Barbell bench press": [{ id: "a", savedAt: "2026-08-20T06:30:00.000Z", sets: [{ load: "57.5", reps: "6" }] }],
    "Lateral raise": [{ id: "b", savedAt: "2026-08-20T06:45:00.000Z", sets: [{ load: "7.5", reps: "13" }] }],
  };
  const migrated = migrateLegacyHistory(history, { "Barbell bench press": "push", "Lateral raise": "push" });
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].exercises.length, 2);
  assert.equal(migrated[0].sync.status, "legacy");
});

test("reports only improvements after an established lift baseline as milestones", () => {
  const history = { "Barbell bench press": [
    { id: "c", savedAt: "2026-08-20T06:00:00.000Z", sets: [{ load: "57.5", reps: "6" }] },
    { id: "b", savedAt: "2026-08-17T06:00:00.000Z", sets: [{ load: "55", reps: "8" }] },
    { id: "a", savedAt: "2026-08-12T06:00:00.000Z", sets: [{ load: "55", reps: "6" }] },
  ] };
  assert.deepEqual(liftMilestones(history).map(({ kind, load, reps }) => ({ kind, load, reps })), [
    { kind: "load", load: "57.5", reps: "6" },
    { kind: "reps", load: "55", reps: "8" },
  ]);
});
