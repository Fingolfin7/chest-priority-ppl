import assert from "node:assert/strict";
import test from "node:test";
import { createBackupFile, parseBackupText, shareableBackup } from "../src/transfer.ts";

const history = { "Barbell bench press": [{ id: "lift-1", savedAt: "2026-09-03T09:00:00.000Z", sets: [{ load: "55", reps: "8" }] }] };

test("JSON sharing falls back to a lossless, importable text file when JSON is unsupported", async () => {
  const original = createBackupFile(history, [], "json");
  const shared = shareableBackup(original, ({ files }) => files[0].type === "text/plain");
  assert.ok(shared.name.endsWith(".json.txt"));
  assert.equal(await shared.text(), await original.text());
  assert.deepEqual(parseBackupText(await shared.text()), parseBackupText(await original.text()));
});

test("supported CSV files retain their original name, format, and data", async () => {
  const original = createBackupFile(history, [], "csv");
  assert.equal(shareableBackup(original, () => true), original);
  assert.equal(parseBackupText(await original.text()).sessions[0].sessionId, "lift-1");
});

test("unavailable or policy-blocked file sharing leaves the download fallback available", () => {
  const file = createBackupFile(history, [], "json");
  assert.equal(shareableBackup(file, () => false), null);
  assert.equal(shareableBackup(file, () => { throw new Error("blocked"); }), null);
});

test("pasted and downloaded backups tolerate BOM and whitespace but reject unrelated contents", async () => {
  for (const format of ["json", "csv"]) {
    assert.equal(parseBackupText(`\uFEFF  \n${await createBackupFile(history, [], format).text()}\n`).sessions.length, 1);
  }
  assert.throws(() => parseBackupText("  "), /paste its contents/);
  assert.throws(() => parseBackupText("Workout went well today"), /Rolling PPL CSV/);
  assert.throws(() => parseBackupText('{"sessions":"wrong"}'), /Rolling PPL JSON/);
});
