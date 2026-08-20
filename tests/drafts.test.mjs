import assert from "node:assert/strict";
import test from "node:test";
import { pruneCompletedDrafts } from "../src/drafts.ts";

const saved = {
  "Barbell curl": [{
    id: "curl-session",
    savedAt: "2026-08-20T10:00:00.000Z",
    sets: [{ load: "20", reps: "10" }, { load: "20", reps: "9" }],
  }],
};

test("removes a draft that duplicates the latest saved session", () => {
  const drafts = {
    "Barbell curl": [{ load: "20", reps: "10" }, { load: "20", reps: "9" }, { load: "", reps: "" }],
  };
  assert.deepEqual(pruneCompletedDrafts(drafts, saved), {});
});

test("preserves an unfinished draft that differs from saved history", () => {
  const drafts = {
    "Barbell curl": [{ load: "22.5", reps: "8" }, { load: "", reps: "" }],
  };
  assert.deepEqual(pruneCompletedDrafts(drafts, saved), drafts);
});
