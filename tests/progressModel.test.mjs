import assert from "node:assert/strict";
import test from "node:test";
import { availableChartExercises, bodyweightSeries, exerciseMetricSeries } from "../src/progressModel.ts";

const history = {
  "Barbell bench press": [
    { id: "new", savedAt: "2026-08-20T10:00:00.000Z", sets: [{ load: "57.5", reps: "6" }, { load: "57,5", reps: "5" }] },
    { id: "old", savedAt: "2026-08-10T10:00:00.000Z", sets: [{ load: "55", reps: "8" }, { load: "55", reps: "7" }] },
  ],
  "Pull-ups": [{ id: "bw", savedAt: "2026-08-11T10:00:00.000Z", sets: [{ load: "BW", reps: "8" }] }],
};

test("builds chronological recorded-volume series", () => {
  assert.deepEqual(exerciseMetricSeries(history, ["Barbell bench press"], "volume"), [{
    exercise: "Barbell bench press",
    points: [
      { date: "2026-08-10T10:00:00.000Z", value: 825 },
      { date: "2026-08-20T10:00:00.000Z", value: 632.5 },
    ],
  }]);
});

test("uses the heaviest completed set for working-weight series", () => {
  assert.deepEqual(exerciseMetricSeries(history, ["Barbell bench press"], "load")[0].points, [
    { date: "2026-08-10T10:00:00.000Z", value: 55 },
    { date: "2026-08-20T10:00:00.000Z", value: 57.5 },
  ]);
});

test("omits bodyweight-only exercises from load charts", () => {
  assert.deepEqual(availableChartExercises(history), ["Barbell bench press"]);
});

test("sorts and limits bodyweight readings", () => {
  const sessions = [
    { endedAt: "2026-08-20T10:00:00.000Z", bodyweight: "64,6" },
    { endedAt: "2026-08-10T10:00:00.000Z", bodyweight: "64.1" },
    { endedAt: "2026-08-15T10:00:00.000Z", bodyweight: "" },
  ];
  assert.deepEqual(bodyweightSeries(sessions, 1), [{ date: "2026-08-20T10:00:00.000Z", value: 64.6 }]);
});
