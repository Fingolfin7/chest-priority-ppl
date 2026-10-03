import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import { exerciseDefinitions } from '../src/data/exercises.ts';
import { legacyExerciseDefinitions } from '../src/legacyExerciseDefinitions.ts';
import { exerciseCatalog, exerciseDefinition, exerciseImageSources, EXERCISE_IMAGE_BASE, libraryDemoSlug, searchExercises, rememberedExercises } from '../src/exerciseLibrary.ts';
import { defaultPlanState } from '../src/defaultPlan.ts';
import { freeSessionCatalog, addFreeSessionExercise, createFreeSession } from '../src/freeSession.ts';
import { validatePlanExercises, normalizePlanState } from '../src/planModel.ts';
import { emptySyncSnapshot, createSyncDoc, projectSyncDoc } from '../src/peerSyncModel.ts';
import { createJsonBackup, parseJsonBackup } from '../src/backup.ts';
import { completeWorkout, addWorkoutToHistory } from '../src/sessionModel.ts';

test('catalogue definitions have unique demo identities and compatible prescription snapshots', () => {
  assert.equal(exerciseDefinitions.length, 876);
  assert.equal(new Set(exerciseDefinitions.map((item) => libraryDemoSlug(item.id))).size, 876);
  const catalog = exerciseCatalog();
  for (const exercise of catalog) validatePlanExercises([exercise]);
  for (const original of legacyExerciseDefinitions) {
    const selected = catalog.find((item) => item.name === original.name);
    assert.ok(selected);
    assert.deepEqual(selected.demos, original.demos);
    assert.equal(selected.loadSuffix, original.loadSuffix);
    assert.ok(exerciseDefinition(original.name));
  }
  assert.ok(!catalog.some((item) => item.name === 'Barbell Bench Press - Medium Grip'));
});

test('search matches aliases and muscle/equipment filters without merging distinct variants', () => {
  const catalog = exerciseCatalog();
  assert.equal(searchExercises(catalog, 'barbell bench press medium grip')[0].name, 'Barbell bench press');
  assert.ok(searchExercises(catalog, 'pull ups').some((item) => item.name === 'Pull-ups'));
  assert.ok(searchExercises(catalog, 'front squat').some((item) => item.name === 'Front Squat (Clean Grip)'));
  assert.deepEqual(searchExercises(catalog, 'rdl').map((item) => item.name), ['Romanian Deadlift']);
  assert.equal(exerciseDefinition('rdl').name, 'Romanian Deadlift');
  const filtered = searchExercises(catalog, '', 'biceps', 'dumbbell');
  assert.ok(filtered.length > 10);
  assert.ok(filtered.every((item) => exerciseDefinition(item.name).equipment === 'dumbbell'));
  assert.notEqual(catalog.find((item) => item.name === 'Chest press machine').name, catalog.find((item) => item.name === 'Barbell bench press').name);
});

test('programme prescriptions take precedence and constructing the library leaves saved plans/history untouched', () => {
  const plan = defaultPlanState();
  const original = JSON.stringify(plan);
  const history = { 'Barbell bench press': [{ id: 'old', savedAt: '2026-09-30T10:00:00Z', sets: [{ load: '60', reps: '8' }] }] };
  const originalHistory = structuredClone(history);
  const custom = { ...plan.phases[0].workouts.push.exercises[0], name: 'My gym chest machine', sets: '2', reps: '12–15', demos: [] };
  const catalog = freeSessionCatalog(plan.phases[0], [custom]);
  assert.equal(catalog.find((item) => item.name === 'Barbell bench press').sets, '3–4');
  assert.equal(catalog.find((item) => item.name === custom.name).reps, '12–15');
  assert.equal(JSON.stringify(plan), original);
  assert.deepEqual(history, originalHistory);
  assert.deepEqual(normalizePlanState(plan).phases[0].workouts, plan.phases[0].workouts);
  catalog.find((item) => item.name === 'Barbell bench press').cue = 'Changed preview';
  assert.equal(JSON.stringify(plan), original);
});

test('library and custom exercises retain image identity through sessions, backups and sync', () => {
  const phase = defaultPlanState().phases[0];
  const exercise = freeSessionCatalog(phase).find((item) => item.name === 'Dumbbell Bench Press');
  assert.ok(exercise.demos[0].slug.startsWith('db-'));
  const active = addFreeSessionExercise(createFreeSession(phase, '2026-10-04T10:00:00Z', 'library-session'), exercise);
  const session = completeWorkout({ active, definitions: active.training.exercises, drafts: { [exercise.name]: [{ load: '20', reps: '10' }] }, bodyweight: '', note: '', endedAt: '2026-10-04T11:00:00Z' }).session;
  assert.ok(session);
  const oldHistory = { 'Back squat': [{ id: 'untouched', savedAt: '2026-09-30T10:00:00Z', sets: [{ id: 'old-set', load: '80', reps: '6' }] }] };
  const history = addWorkoutToHistory(oldHistory, session);
  assert.deepEqual(history['Back squat'], oldHistory['Back squat']);
  const restored = parseJsonBackup(createJsonBackup(history, [session]));
  assert.deepEqual(restored.workouts[0].training.exercises, [exercise]);
  const snapshot = { ...emptySyncSnapshot(), history, completed: [session], activeWorkout: active, drafts: { [exercise.name]: [{ load: '20', reps: '10' }] }, next: 'legs' };
  const synced = projectSyncDoc(A.load(A.save(createSyncDoc(snapshot))));
  assert.deepEqual(synced.activeWorkout.training.exercises, [exercise]);
  assert.deepEqual(synced.history['Back squat'], history['Back squat']);
  assert.equal(synced.next, 'legs');
});

test('images resolve to pinned upstream assets, retaining local files for original exercises', () => {
  assert.deepEqual(exerciseImageSources('bench'), ['./exercises/bench-0.jpg', './exercises/bench-1.jpg']);
  const definition = exerciseDefinition('Dumbbell Bench Press');
  assert.deepEqual(exerciseImageSources(libraryDemoSlug(definition.id)), definition.images.map((path) => EXERCISE_IMAGE_BASE + path));
  assert.deepEqual(exerciseImageSources('db-unknown'), []);
});

test('custom exercises are reusable from saved sessions and travel through the existing backup schema', () => {
  const phase = defaultPlanState().phases[0];
  const custom = { name: 'My gym cable press', sets: '2', reps: '10–15', rest: '90 sec', warmup: '', cue: 'My seat setting', priority: 'optional', demos: [] };
  const active = addFreeSessionExercise(createFreeSession(phase, '2026-10-04T10:00:00Z', 'custom-session'), custom);
  const session = completeWorkout({ active, definitions: active.training.exercises, drafts: { [custom.name]: [{ load: '35', reps: '12' }] }, bodyweight: '', note: '', endedAt: '2026-10-04T11:00:00Z' }).session;
  const restored = parseJsonBackup(createJsonBackup(addWorkoutToHistory({}, session), [session]));
  assert.deepEqual(restored.workouts[0].training.exercises, [custom]);
  assert.deepEqual(exerciseCatalog(rememberedExercises([], restored.workouts)).find((item) => item.name === custom.name), custom);
  const newer = { ...session, training: { ...session.training, exercises: [{ ...custom, reps: '12–20' }] } };
  assert.equal(exerciseCatalog(rememberedExercises([], [newer, session])).find((item) => item.name === custom.name).reps, '12–20');
});
