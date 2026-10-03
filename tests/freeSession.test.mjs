import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import { defaultPlanState, programPreset } from '../src/defaultPlan.ts';
import { createFreeSession, freeSessionCatalog, addFreeSessionExercise } from '../src/freeSession.ts';
import { validateWorkoutTraining, trainingForWorkout, nextWorkoutForPhase } from '../src/planModel.ts';
import { completeWorkout, addWorkoutToHistory, workoutSummary } from '../src/sessionModel.ts';
import { nextStep, setTarget } from '../src/progression.ts';
import { createSyncDoc, emptySyncSnapshot, projectSyncDoc, updateSyncDoc } from '../src/peerSyncModel.ts';
import { validateBackupSnapshot, mergeBackupSnapshot } from '../src/backupBundle.ts';
import { createJsonBackup, createCsvBackup, parseJsonBackup, parseCsvBackup } from '../src/backup.ts';
import { validateSessionEdit } from '../src/sessionEditing.ts';

const phase = defaultPlanState().phases[0];
const startedAt = '2026-10-03T08:00:00.000Z';
const endedAt = '2026-10-03T09:00:00.000Z';
const bench = freeSessionCatalog(phase).find((exercise) => exercise.name === 'Barbell bench press');

test('catalog keeps programme prescriptions and separate alternative identities', () => {
  const catalog = freeSessionCatalog(phase);
  assert.equal(catalog.length, 19);
  assert.equal(new Set(catalog.map((exercise) => exercise.name)).size, catalog.length);
  assert.equal(bench.sets, phase.workouts.push.exercises[0].sets);
  assert.equal(bench.reps, phase.workouts.push.exercises[0].reps);
  for (const name of ['Lat pulldown', 'Pull-ups', 'Leg press', 'Bulgarian split squat']) {
    const exercise = catalog.find((item) => item.name === name);
    assert.ok(exercise);
    assert.equal(exercise.alternatives, undefined);
    assert.equal(exercise.demos.length, 1);
    assert.equal(exercise.demos[0].label, name);
  }
  const custom = { ...phase, ...programPreset('upper-lower'), sequence: ['upper', 'lower'] };
  assert.ok(freeSessionCatalog(custom).some((exercise) => exercise.name === 'Pull-ups'));
  assert.equal(freeSessionCatalog(custom).some((exercise) => exercise.name === 'Chest press machine'), false);
  catalog[0].sets = '1';
  assert.equal(phase.workouts.push.exercises[0].sets, bench.sets);
});

test('empty free session recovers and syncs before the first exercise is chosen', () => {
  const activeWorkout = createFreeSession(phase, startedAt, 'free-one');
  validateWorkoutTraining(activeWorkout.training);
  const snapshot = { ...emptySyncSnapshot(), next: 'legs', activeWorkout };
  const recovered = projectSyncDoc(A.load(A.save(createSyncDoc(snapshot))));
  assert.deepEqual(recovered.activeWorkout, activeWorkout);
  assert.equal(recovered.next, 'legs');
  const backup = validateBackupSnapshot(snapshot);
  assert.deepEqual(mergeBackupSnapshot(emptySyncSnapshot(), backup).activeWorkout, activeWorkout);
  const empty = completeWorkout({ active: activeWorkout, definitions: [], drafts: {}, bodyweight: '', note: '', endedAt });
  assert.match(empty.error, /at least one work set/);
  const normal = trainingForWorkout(phase, 'push');
  assert.throws(() => validateWorkoutTraining({ ...normal, exercises: [] }), /1.*30 exercises/);
  assert.throws(() => validateWorkoutTraining({ ...normal, sessionKind: 'unknown' }), /Invalid/);
});

test('add-as-you-go selection is unique and survives recovery with entered sets', () => {
  const empty = createFreeSession(phase, startedAt, 'free-two');
  const chosen = addFreeSessionExercise(empty, bench);
  assert.equal(empty.training.exercises.length, 0);
  assert.equal(addFreeSessionExercise(chosen, bench), chosen);
  const before = { ...emptySyncSnapshot(), activeWorkout: empty, next: 'legs' };
  const after = { ...before, activeWorkout: chosen, drafts: { [bench.name]: [{ load: '60', reps: '6' }] } };
  const recovered = projectSyncDoc(A.load(A.save(updateSyncDoc(createSyncDoc(before), before, after))));
  assert.deepEqual(recovered.activeWorkout.training.exercises, [bench]);
  assert.deepEqual(recovered.drafts[bench.name].map(({ load, reps }) => ({ load, reps })), after.drafts[bench.name]);
  assert.equal(recovered.next, 'legs');
});

test('free sessions use shared targets, update main-programme history, and leave Legs queued', () => {
  const history = { [bench.name]: [{ id: 'previous', savedAt: '2026-10-01T09:00:00.000Z', sets: Array.from({ length: 3 }, () => ({ load: '60', reps: '6' })) }] };
  const normal = phase.workouts.push.exercises[0];
  assert.equal(nextStep(bench.reps, history[bench.name], 3), nextStep(normal.reps, history[normal.name], 3));
  assert.deepEqual(setTarget(bench.reps, history[bench.name], 0, 3), { load: '60', reps: '7' });
  const active = addFreeSessionExercise(createFreeSession(phase, startedAt, 'free-three'), bench);
  const session = completeWorkout({ active, definitions: active.training.exercises, drafts: { [bench.name]: Array.from({ length: 3 }, () => ({ load: '60', reps: '7' })) }, bodyweight: '', note: 'Upper body today', endedAt }).session;
  assert.ok(session);
  assert.equal(nextWorkoutForPhase(session.workout, session.training, phase, 'legs'), 'legs');
  assert.equal(nextWorkoutForPhase('push', trainingForWorkout(phase, 'push'), phase, 'legs'), 'pull');
  const updated = addWorkoutToHistory(history, session);
  assert.deepEqual(setTarget(normal.reps, updated[normal.name], 0, 3), { load: '60', reps: '8' });
  assert.match(workoutSummary(session), /^Free session day\./);
  for (const restored of [parseJsonBackup(createJsonBackup(updated, [session])), parseCsvBackup(createCsvBackup(updated, [session]))]) {
    assert.equal(restored.workouts[0].training.sessionKind, 'free');
    assert.deepEqual(restored.workouts[0].training.exercises, session.training.exercises);
    assert.equal(nextWorkoutForPhase(restored.workouts[0].workout, restored.workouts[0].training, phase, 'legs'), 'legs');
  }
  const synced = projectSyncDoc(createSyncDoc({ ...emptySyncSnapshot(), history: updated, completed: [session], next: 'legs' }));
  assert.equal(synced.completed[0].training.sessionKind, 'free');
  assert.equal(synced.next, 'legs');
  assert.equal(validateSessionEdit(session, { ...session, note: 'Edited' }).session.training.sessionKind, 'free');
});

test('free session IDs avoid collisions with custom programme workouts', () => {
  const custom = { ...phase, sequence: ['free-session'], workouts: { 'free-session': phase.workouts.push } };
  assert.equal(createFreeSession(custom, startedAt, 'collision').workout, 'free-session-free');
});
