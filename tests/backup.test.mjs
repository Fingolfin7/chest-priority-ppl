import assert from "node:assert/strict";
import test from "node:test";
import { createCsvBackup, createJsonBackup, parseCsvBackup, parseJsonBackup } from "../src/backup.ts";

const workout = {
  id: "workout-1",
  workout: "push",
  startedAt: "2026-08-20T05:37:27.000Z",
  endedAt: "2026-08-20T06:49:19.000Z",
  bodyweight: "64.6",
  note: "Strong session, despite heat.\nNo shoulder pain.",
  exercises: [{
    name: "Incline dumbbell bench press",
    priority: "must",
    loadSuffix: " each",
    sets: [{ load: "22.5", reps: "8" }, { load: "22.5", reps: "7" }],
  }],
  sync: { status: "synced", projectId: 12, projectName: "Gym - 67kgs", autumnSessionId: 99 },
};

const history = {
  "Incline dumbbell bench press": [{
    id: "workout-1:Incline dumbbell bench press",
    savedAt: workout.endedAt,
    sets: workout.exercises[0].sets,
  }],
};

test("CSV round-trip retains workout timing, bodyweight, note, and exercise metadata", () => {
  const csv = createCsvBackup(history, [workout]);
  assert.match(csv, /"bodyweight"/);
  assert.match(csv, /"64.6"/);
  const parsed = parseCsvBackup(csv);
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.workouts.length, 1);
  assert.deepEqual(parsed.workouts[0], {
    ...workout,
    sync: { status: "legacy" },
  });
});

test("legacy lift-only CSV files remain importable", () => {
  const csv = '"exercise","session_date","session_timestamp","session_id","set_number","load","reps"\r\n"Barbell bench press","2026-08-17","2026-08-17T06:00:00.000Z","old-1","1","55","8"';
  const parsed = parseCsvBackup(csv);
  assert.equal(parsed.sessions[0].exercise, "Barbell bench press");
  assert.equal(parsed.workouts.length, 0);
});

test("JSON full backup retains bodyweight and sync receipts", () => {
  const parsed = parseJsonBackup(createJsonBackup(history, [workout], "2026-08-24T00:00:00.000Z"));
  assert.equal(parsed.workouts[0].bodyweight, "64.6");
  assert.deepEqual(parsed.workouts[0].sync, workout.sync);
});

test("backup import rejects invalid workout bodyweight", () => {
  const invalid = JSON.stringify({ schemaVersion: 2, sessions: [], workouts: [{ ...workout, bodyweight: "heavy" }] });
  assert.throws(() => parseJsonBackup(invalid), /invalid bodyweight/);
});
