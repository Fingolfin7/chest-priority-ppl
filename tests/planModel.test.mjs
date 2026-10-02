import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import { defaultPlanState } from '../src/defaultPlan.ts';
import { newPhase, trainingForWorkout, normalizePlanState, mergePlanStates } from '../src/planModel.ts';
import { createSyncDoc, emptySyncSnapshot, updateSyncDoc, projectSyncDoc } from '../src/peerSyncModel.ts';
import { completeWorkout } from '../src/sessionModel.ts';
import { validateSessionEdit } from '../src/sessionEditing.ts';
import { createJsonBackup, parseJsonBackup } from '../src/backup.ts';

test('phase edits retain original prescriptions and reject duplicate or invalid exercises', () => {
  const initial = defaultPlanState();
  const workouts = structuredClone(initial.phases[0].workouts);
  workouts.push.exercises[0].sets = '2';
  const changed = newPhase(initial,'Technique','Clean reps',workouts,'2026-10-02T08:00:00Z','second');
  assert.equal(changed.phases[0].workouts.push.exercises[0].sets,'3–4');
  assert.equal(changed.phases[1].workouts.push.exercises[0].sets,'2');
  workouts.push.exercises.push(structuredClone(workouts.push.exercises[0]));
  assert.throws(()=>newPhase(initial,'Bad','',workouts),/distinct/);
  assert.throws(()=>normalizePlanState({...initial,password:'secret'}),/Invalid/);
});
test('workouts, session editing, and JSON export keep the starting phase snapshot', () => {
  const phase = defaultPlanState().phases[0];
  const training = trainingForWorkout(phase,'push');
  const result = completeWorkout({active:{id:'one',workout:'push',startedAt:'2026-10-02T08:00:00Z',training},endedAt:'2026-10-02T09:00:00Z',bodyweight:'65',note:'',definitions:[{name:'Barbell bench press',priority:'must'}],drafts:{'Barbell bench press':[{load:'60',reps:'6'}]}});
  assert.equal(result.session.training.phaseId,phase.id);
  training.exercises[0].sets='1';
  assert.equal(result.session.training.exercises[0].sets,'3–4');
  const edited = validateSessionEdit(result.session,{...result.session,note:'updated'}).session;
  assert.equal(edited.training.phaseId,phase.id);
  const restored = parseJsonBackup(createJsonBackup({},[edited])).workouts[0];
  assert.deepEqual(restored.training,edited.training);
});
test('independent concurrent phases survive peer merge and backup import', () => {
  const initial=defaultPlanState();
  const snapshot={...emptySyncSnapshot(),planState:initial};
  const baseline=createSyncDoc(snapshot);
  const leftState=newPhase(initial,'Left','',initial.phases[0].workouts,'2026-10-02T08:00:00Z','left');
  const rightState=newPhase(initial,'Right','',initial.phases[0].workouts,'2026-10-02T09:00:00Z','right');
  const left=updateSyncDoc(A.clone(baseline),snapshot,{...snapshot,planState:leftState});
  const right=updateSyncDoc(A.clone(baseline),snapshot,{...snapshot,planState:rightState});
  const merged=projectSyncDoc(A.merge(left,right));
  assert.equal(merged.planState.phases.length,3);
  const imported=mergePlanStates(leftState,rightState);
  assert.equal(imported.phases.length,3);
  assert.equal(imported.currentId,'left');
});
