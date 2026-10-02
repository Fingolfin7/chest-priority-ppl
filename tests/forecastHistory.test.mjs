import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWeight, PROJECTION_MODEL_VERSION } from '../src/projectionModel.ts';
import {
  createForecastSnapshot,
  forecastPointsAfterCutoff,
  mergeForecastHistory,
  parseForecastHistory,
  shouldSaveForecastSnapshot,
} from '../src/forecastHistory.ts';

const day = (base, offset) => new Date(Date.parse(`${base}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const readings = cutoff => [-35, -28, -21, -14, -7, 0].map((offset, index) => ({ date: day(cutoff, offset), value: 67 + index * .1 }));
const issue = cutoff => createForecastSnapshot({
  kind: 'weight', targetId: 'weight', targetLabel: 'Bodyweight', unit: 'kg', observationCutoff: cutoff,
  issuedAt: `${cutoff}T12:00:00.000Z`, projection: projectWeight(readings(cutoff), cutoff),
});

test('a saved issue stays frozen while later actual readings use their real dates', () => {
  const original = issue('2026-10-02');
  assert.ok(original);
  const issuedCopy = structuredClone(original);
  const chosen = original.estimates.find(estimate => estimate.weeks === 3);
  const later = [
    { date: day('2026-10-02', 7), value: 68.2 },
    { date: day('2026-10-02', 21), value: 68.8 },
  ];
  const observed = forecastPointsAfterCutoff(original, [...original.points, ...later]);
  assert.deepEqual(observed, later);
  assert.equal(observed.find(point => point.date === chosen.date).value, 68.8);
  assert.deepEqual(original, issuedCopy);
  assert.equal(original.estimates.find(estimate => estimate.weeks === 3).value, chosen.value);
  assert.equal(original.modelVersion, PROJECTION_MODEL_VERSION);
});

test('weekly issue policy allows one snapshot per target at seven-day intervals', () => {
  const previous = issue('2026-10-02');
  const sixDaysLater = issue('2026-10-08');
  const sevenDaysLater = issue('2026-10-09');
  assert.equal(shouldSaveForecastSnapshot(undefined, previous), true);
  assert.equal(shouldSaveForecastSnapshot(previous, sixDaysLater), false);
  assert.equal(shouldSaveForecastSnapshot(previous, sevenDaysLater), true);
  assert.equal(shouldSaveForecastSnapshot(previous, issue('2026-10-02')), false);
});

test('forecast backups round-trip model versions and imports never replace an issued snapshot', () => {
  const original = issue('2026-10-02');
  const parsed = parseForecastHistory({ schemaVersion: 1, snapshots: [original] }, '2026-10-03');
  assert.equal(parsed.snapshots[0].modelVersion, PROJECTION_MODEL_VERSION);
  const alteredDuplicate = { ...original, reason: 'Changed after issue' };
  const merged = mergeForecastHistory(parsed, { schemaVersion: 1, snapshots: [alteredDuplicate] });
  assert.equal(merged.snapshots.length, 1);
  assert.equal(merged.snapshots[0].reason, original.reason);
});
