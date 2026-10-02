import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import { defaultPlanState, programPreset } from '../src/defaultPlan.ts';
import { newPhase, trainingForWorkout, normalizePlanState, mergePlanStates, phaseSequence, nextWorkoutForPhase, validateWorkoutTraining } from '../src/planModel.ts';
import { createSyncDoc, emptySyncSnapshot, updateSyncDoc, projectSyncDoc } from '../src/peerSyncModel.ts';
import { completeWorkout, addWorkoutToHistory, nextWorkout, workoutLabel, workoutSummary, isWorkoutKey } from '../src/sessionModel.ts';
import { validateSessionEdit } from '../src/sessionEditing.ts';
import { createJsonBackup, parseJsonBackup, createCsvBackup, parseCsvBackup } from '../src/backup.ts';

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

test('legacy phases and session backups migrate without losing PPL prescriptions or identities', () => {
  const original = defaultPlanState();
  const {programId, programName, sequence, ...legacy} = original.phases[0];
  const migrated = normalizePlanState({currentId: legacy.id, phases: [legacy]});
  assert.equal(migrated.phases[0].id, legacy.id);
  assert.equal(migrated.phases[0].programId, programId);
  assert.equal(migrated.phases[0].programName, programName);
  assert.deepEqual(phaseSequence(migrated.phases[0]), sequence);
  assert.deepEqual(migrated.phases[0].workouts, legacy.workouts);
  assert.deepEqual(mergePlanStates(original, {currentId: legacy.id, phases: [legacy]}), original);
  const oldTraining = {phaseId: legacy.id, phaseName: legacy.name, purpose: legacy.purpose, exercises: legacy.workouts.push.exercises};
  const saved = completeWorkout({active:{id:'legacy-active', workout:'push', startedAt:'2026-10-02T08:00:00Z',training:oldTraining},endedAt:'2026-10-02T09:00:00Z',bodyweight:'',note:'',definitions:[{name:'Barbell bench press',priority:'must'}],drafts:{'Barbell bench press':[{load:'60',reps:'6'}]}}).session;
  assert.deepEqual(parseJsonBackup(createJsonBackup({},[saved])).workouts[0].training, oldTraining);
});

function customPhase() {
  const initial = defaultPlanState();
  const preset = programPreset('upper-lower');
  const state = newPhase(initial, 'Build toward 70 kg', '', preset.workouts, '2026-10-02T07:00:00Z', 'upper-lower-phase', {programId:'upper-lower-program',programName:preset.name,sequence:preset.sequence});
  return {state, phase: state.phases.at(-1)};
}

test('a custom programme completes and advances in its own order, with names preserved in exports', () => {
  const {phase} = customPhase();
  const training = trainingForWorkout(phase, 'upper');
  const session = completeWorkout({active:{id:'upper-1',workout:'upper',startedAt:'2026-10-02T08:00:00Z',training},endedAt:'2026-10-02T09:00:00Z',bodyweight:'65',note:'',definitions:[{name:'Barbell bench press',priority:'must'}],drafts:{'Barbell bench press':[{load:'60',reps:'6'}]}}).session;
  assert.equal(nextWorkout(session.workout, session.training.sequence), 'lower');
  assert.equal(nextWorkout('lower', session.training.sequence), 'upper');
  assert.equal(nextWorkoutForPhase(session.workout, session.training, phase), 'lower');
  assert.equal(workoutLabel(session.workout, session.training), 'Upper');
  assert.match(workoutSummary(session), /^Upper day\./);
  assert.deepEqual(parseJsonBackup(createJsonBackup({},[session])).workouts[0].training, training);
  const history = addWorkoutToHistory({}, session);
  const csv = parseCsvBackup(createCsvBackup(history, [session]));
  assert.equal(csv.workouts[0].workout, 'upper');
  assert.deepEqual(csv.workouts[0].training, training);
});

test('an active workout keeps its phase name, exercises and sequence through programme transitions', () => {
  const {state, phase} = customPhase();
  const activeTraining = trainingForWorkout(phase,'upper');
  const changedWorkouts = structuredClone(phase.workouts);
  changedWorkouts.upper.name = 'Upper strength';
  changedWorkouts.upper.exercises[0].sets = '2';
  const changed = newPhase(state, 'Technique', '', changedWorkouts, '2026-10-03T07:00:00Z', 'technique-phase');
  assert.equal(activeTraining.phaseName,'Build toward 70 kg');
  assert.equal(activeTraining.workoutName,'Upper');
  assert.equal(activeTraining.exercises[0].sets,'3–4');
  assert.deepEqual(activeTraining.sequence,['upper','lower']);
  assert.equal(changed.phases.at(-1).programId,phase.programId);
  assert.equal(nextWorkoutForPhase('upper',activeTraining,changed.phases.at(-1)),'lower');
  const full = programPreset('full-body');
  const switched = newPhase(changed, 'Full body focus', '', full.workouts, '2026-10-04T07:00:00Z', 'full-body-phase', {programId:'full-program',programName:full.name,sequence:full.sequence});
  assert.equal(nextWorkoutForPhase('upper',activeTraining,switched.phases.at(-1)),'full-body');
  assert.equal(nextWorkout('full-body',full.sequence),'full-body');
  assert.deepEqual(switched.phases[1], phase);
});

test('workout IDs and sequence validation reject unsafe, duplicate and unbounded data', () => {
  for (const key of ['Upper day', '__proto__', 'constructor', '', 'a'.repeat(121)]) assert.equal(isWorkoutKey(key),false);
  for (const key of ['push','full-body','workout-123']) assert.equal(isWorkoutKey(key),true);
  const {state,phase} = customPhase();
  assert.throws(()=>normalizePlanState({...state,phases:[{...phase,sequence:['upper','upper']}],currentId:phase.id}),/distinct/);
  assert.throws(()=>normalizePlanState({...state,phases:[{...phase,sequence:['upper']}],currentId:phase.id}),/distinct/);
  assert.throws(()=>validateWorkoutTraining({...trainingForWorkout(phase,'upper'),sequence:Array.from({length:13},(_,i)=>`workout-${i}`)}),/Invalid/);
  assert.throws(()=>trainingForWorkout(phase,'push'),/not part/);
});

test('custom programme and frozen active prescriptions survive synced state and session corrections', () => {
  const {state,phase} = customPhase();
  const active = {id:'custom-active',workout:'lower',startedAt:'2026-10-02T08:00:00Z',training:trainingForWorkout(phase,'lower')};
  const initial = {...emptySyncSnapshot(),planState:state,activeWorkout:active,next:'lower',drafts:{'Back squat':[{load:'60',reps:'6'}]}};
  const restored = projectSyncDoc(createSyncDoc(initial));
  assert.equal(restored.next,'lower');
  assert.deepEqual(restored.planState,state);
  assert.deepEqual(restored.activeWorkout.training,active.training);
  const session = completeWorkout({active:restored.activeWorkout,endedAt:'2026-10-02T09:00:00Z',bodyweight:'65',note:'',definitions:[{name:'Back squat',priority:'must'}],drafts:restored.drafts}).session;
  const corrected = validateSessionEdit(session,{...session,note:'corrected',training:trainingForWorkout(defaultPlanState().phases[0],'push')}).session;
  assert.deepEqual(corrected.training,active.training);
  const completed = projectSyncDoc(createSyncDoc({...restored,activeWorkout:null,completed:[corrected],next:nextWorkoutForPhase(session.workout,session.training,phase)}));
  assert.equal(completed.next,'upper');
  assert.deepEqual(completed.completed[0].training,active.training);
});
