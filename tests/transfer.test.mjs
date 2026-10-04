import assert from "node:assert/strict";
import test from "node:test";
import { createBackupFile, parseBackupText, prefersTextSharing, shareableBackup } from "../src/transfer.ts";

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

test("desktop browsers share JSON as importable text up front; phones keep .json unless refused before", async () => {
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0";
  const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  assert.equal(prefersTextSharing(windows), true);
  assert.equal(prefersTextSharing(android), false);
  assert.equal(prefersTextSharing(ipad, 5), false);
  assert.equal(prefersTextSharing(android, 0, true), true);
  const json = createBackupFile(history, [], "json"), csv = createBackupFile(history, [], "csv");
  const wrapped = shareableBackup(json, () => true, true);
  assert.ok(wrapped.name.endsWith(".json.txt"));
  assert.deepEqual(parseBackupText(await wrapped.text()), parseBackupText(await json.text()));
  assert.equal(shareableBackup(csv, () => true, true), csv);
});
