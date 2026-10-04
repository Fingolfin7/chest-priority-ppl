import { createCsvBackup, createJsonBackup, parseCsvBackup, parseJsonBackup } from "./backup.ts";
import type { HistoryMap } from "./historyMigration.ts";
import type { CompletedWorkout } from "./sessionModel.ts";

export type ExportFormat = "json" | "csv";

export function createBackupText(history: HistoryMap, workouts: CompletedWorkout[], format: ExportFormat) {
  return format === "json" ? createJsonBackup(history, workouts) : createCsvBackup(history, workouts);
}

export function createBackupFile(history: HistoryMap, workouts: CompletedWorkout[], format: ExportFormat) {
  return new File([createBackupText(history, workouts, format)], `rolling-ppl-history-${new Date().toISOString().slice(0, 10)}.${format}`, {
    type: format === "json" ? "application/json" : "text/csv",
  });
}

// Some share sheets reject JSON files, and desktop Chromium on Windows even reports
// that it can share them but then refuses ("Permission denied"). A .json.txt text
// wrapper preserves the full backup and restores the same way.
export const JSON_AS_TEXT_KEY = "rolling-ppl-share-json-as-text-v1";
export function prefersTextSharing(userAgent: string, maxTouchPoints = 0, remembered = false) {
  if (remembered) return true;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return !mobile;
}
export function shareableBackup(file: File, canShare: (data: ShareData) => boolean, preferText = false): File | null {
  try {
    if (!(preferText && file.type === "application/json") && canShare({ files: [file] })) return file;
    const textFile = new File([file], `${file.name}.txt`, { type: "text/plain" });
    if (canShare({ files: [textFile] })) return textFile;
  } catch { /* Sharing may be blocked by this browser or its permissions policy. */ }
  return null;
}

export function downloadBackup(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseBackupText(text: string) {
  const content = text.replace(/^\uFEFF/, "").trim();
  if (!content) throw new Error("Choose a backup file or paste its contents first.");
  return content.startsWith("{") || content.startsWith("[") ? parseJsonBackup(content) : parseCsvBackup(content);
}
