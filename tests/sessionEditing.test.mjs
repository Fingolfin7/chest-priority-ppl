import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSessionEdit } from '../src/sessionEditing.ts';
import { createSyncDoc, emptySyncSnapshot, projectSyncDoc, updateSyncDoc } from '../src/peerSyncModel.ts';
const original = { id: 'session-1', workout: 'push', startedAt: '2026-09-01T08:00:00.123Z', endedAt: '2026-09-01T09:00:00.456Z', bodyweight: '65', note: 'Original', exercises: [{ name: 'Barbell bench press', priority: 'must', sets: [{ id: 'set-1', load: '50', reps: '8' }, { id: 'set-2', load: '50', reps: '7' }] }], sync: { status: 'synced', autumnSessionId: 123, projectId: 7, projectName: 'Gym' } };

test('editing preserves identity, set IDs and the Autumn receipt without mutating the original', () => {
  const draft = structuredClone(original);
  draft.note = ' Corrected ';
  draft.exercises[0].sets[0].load = '55';
  const {session, error} = validateSessionEdit(original, draft);
  assert.equal(error, undefined);
  assert.equal(session.id, original.id);
  assert.equal(session.exercises[0].sets[0].id, 'set-1');
  assert.deepEqual(session.sync, original.sync);
  assert.equal(session.note, 'Corrected');
  assert.equal(original.exercises[0].sets[0].load, '50');
  assert.equal(session.startedAt, original.startedAt);
});

test('rejects invalid dates, backwards times, invalid weight, empty workouts and missing reps', () => {
  for (const patch of [{startedAt:'bad'}, {endedAt:'2026-08-01T00:00:00Z'}, {bodyweight:'-1'}, {exercises:[]}, {exercises:[{...original.exercises[0],sets:[{load:'50',reps:''}]}]}]) {
    assert.ok(validateSessionEdit(original, {...original,...patch}).error);
  }
  assert.ok(validateSessionEdit({...original,sync:{status:'syncing'}},original).error);
});

test('saved edits replace derived history, remove sets and preserve active work and other sessions', () => {
  const other = {...structuredClone(original), id:'other'};
  const initial = {...emptySyncSnapshot(),completed:[original,other],activeWorkout:{id:'active',workout:'legs',startedAt:original.startedAt},drafts:{Squat:[{load:'60',reps:'5'}]},next:'legs'};
  const doc = createSyncDoc(initial);
  const before = projectSyncDoc(doc);
  const current = before.completed.find(s=>s.id===original.id);
  const draft = structuredClone(current);
  draft.endedAt = '2026-09-02T09:00:00.000Z';
  draft.exercises[0].sets = [{...draft.exercises[0].sets[0],load:'55'}];
  const {session} = validateSessionEdit(current,draft);
  const after = projectSyncDoc(updateSyncDoc(doc,before,{...before,completed:before.completed.map(s=>s.id===session.id?session:s)}));
  const history = after.history['Barbell bench press'];
  assert.equal(history.length,2);
  assert.equal(history[0].savedAt,draft.endedAt);
  assert.equal(history[0].sets.length,1);
  assert.equal(history[0].sets[0].load,'55');
  assert.deepEqual(after.activeWorkout,before.activeWorkout);
  assert.deepEqual(after.drafts,before.drafts);
  assert.equal(after.next,before.next);
  assert.deepEqual(after.completed.find(s=>s.id==='other'),before.completed.find(s=>s.id==='other'));
});
