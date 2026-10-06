import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import {createSyncDoc,emptySyncSnapshot,listSyncConflicts,projectSyncDoc,updateSyncDoc} from '../src/peerSyncModel.ts';
import {mergeBackupSnapshot,validateBackupSnapshot} from '../src/backupBundle.ts';
import {
  activeLiftGoals,deleteLiftGoal,emptyLiftGoals,goalMarksReachedAt,liftGoalProgress,liftSets,mergeLiftGoals,parseLiftGoal,saveLiftGoal,suggestSteps,
} from '../src/liftGoalModel.ts';

const merge=(a,b)=>A.merge(A.clone(a),b);
const snapshot=(liftGoals)=>({...emptySyncSnapshot(),liftGoals});
const session=(date,...sets)=>({id:date,savedAt:`${date}T18:00:00.000Z`,sets:sets.map(([load,reps])=>({load:String(load),reps:String(reps)}))});
const history={'Barbell bench press':[
  session('2026-09-12',[87.5,6],[87.5,5]),session('2026-09-05',[85,6]),session('2026-08-29',[85,5]),session('2026-08-22',[82.5,7]),
  session('2026-08-15',[82.5,6]),session('2026-08-08',[80,7]),session('2026-08-01',[80,6],['BW',12]),
]};
const goal=(fields={})=>({id:'bench',exercise:'Barbell bench press',load:100,reps:5,steps:[85,90,95],createdAt:'2026-08-10T00:00:00.000Z',updatedAt:'2026-08-10T00:00:00.000Z',...fields});

test('goals validate their numbers and keep steps lighter than the goal',()=>{
  assert.deepEqual(parseLiftGoal({...goal(),steps:[95,85,90,90]}).steps,[85,90,95]);
  assert.throws(()=>parseLiftGoal(goal({steps:[100]})),/lighter/);
  assert.throws(()=>parseLiftGoal(goal({reps:0})),/reps/);
  assert.throws(()=>parseLiftGoal(goal({load:-5})),/Goal weight/);
  assert.throws(()=>parseLiftGoal({...goal(),note:'hi'}),/unknown/);
  assert.throws(()=>parseLiftGoal(goal({deleted:false})),/deletion/);
});

test('steps and goals are reached only by a logged set that matches both numbers',()=>{
  const progress=liftGoalProgress(goal(),history,new Date('2026-09-13T12:00:00Z'));
  assert.deepEqual(progress.marks.map((mark)=>[mark.load,mark.reachedOn]),[[85,'2026-08-29T18:00:00.000Z'],[90,null],[95,null],[100,null]]);
  assert.equal(progress.next.load,90);
  assert.equal(progress.reached,null);
  // Text loads such as BW are ignored.
  assert.equal(liftSets(history,'Barbell bench press').some((set)=>set.reps===12),false);
  const reachedEarly=liftGoalProgress(goal({load:87.5,steps:[]}),history);
  assert.equal(reachedEarly.reached,'2026-09-12T18:00:00.000Z');
  assert.equal(reachedEarly.fraction,1);
});

test('progress runs from the estimate when the goal was set to the goal, using recent sets',()=>{
  const progress=liftGoalProgress(goal(),history,new Date('2026-09-13T12:00:00Z'));
  // Start: best in the 4 weeks before the goal (80 × 7). Now: best in the 4 weeks to the latest session (87.5 × 6).
  assert.deepEqual([progress.start.load,progress.start.reps],[80,7]);
  assert.deepEqual([progress.now.load,progress.now.reps,progress.now.date],[87.5,6,'2026-09-12T18:00:00.000Z']);
  const start=80*(1+7/30),target=100*(1+5/30);
  assert.ok(Math.abs(progress.fraction-(105-start)/(target-start))<1e-9);
  assert.ok(Math.abs(progress.nowAtGoalReps-90)<1e-9);
  assert.ok(Math.abs(progress.repsAtGoalLoad-1.5)<1e-9);
  assert.ok(progress.eta && progress.eta.from>'2026-09-13' && progress.eta.from<progress.eta.to);
  // No history yet: nothing to estimate from.
  const fresh=liftGoalProgress(goal({exercise:'Back squat'}),history);
  assert.deepEqual([fresh.now,fresh.fraction,fresh.eta],[null,null,null]);
});

test('timing is hidden when progress is flat or the data is thin',()=>{
  const flat={'Barbell bench press':[session('2026-09-12',[80,6]),session('2026-09-01',[80,6]),session('2026-08-20',[80,6]),session('2026-08-10',[80,6])]};
  assert.equal(liftGoalProgress(goal(),flat).eta,null);
  const thin={'Barbell bench press':[session('2026-09-12',[85,6]),session('2026-09-05',[80,6])]};
  assert.equal(liftGoalProgress(goal(),thin).eta,null);
});

test('suggested steps skip reached loads and pick up to three spread out',()=>{
  const sets=liftSets(history,'Barbell bench press');
  assert.deepEqual(suggestSteps(90,100,sets,5),{options:[92.5,95,97.5],picked:[92.5,95,97.5]});
  assert.deepEqual(suggestSteps(70,100,sets,5).options,[90,95]);
  assert.deepEqual(suggestSteps(70,100),{options:[75,80,85,90,95],picked:[80,85,95]});
});

test('a session reports the steps and goals it reached for the first time',()=>{
  const data={...emptyLiftGoals(),goals:[goal()]};
  const reached=goalMarksReachedAt(data,history,'2026-08-29T18:00:00.000Z');
  assert.deepEqual(reached.map(({mark,step,steps})=>[mark.load,step,steps]),[[85,1,4]]);
  assert.deepEqual(goalMarksReachedAt(data,history,'2026-09-05T18:00:00.000Z'),[]);
  assert.deepEqual(goalMarksReachedAt({...data,goals:[goal({deleted:true})]},history,'2026-08-29T18:00:00.000Z'),[]);
});

test('saving and deleting keeps stamps moving forward and active goals exclude reached ones',()=>{
  let data=saveLiftGoal(undefined,{exercise:'Barbell bench press',load:100,reps:5,steps:[90]},new Date('2026-10-01T10:00:00Z'));
  const [created]=data.goals;
  data=saveLiftGoal(data,{id:created.id,exercise:'Barbell bench press',load:102.5,reps:5,steps:[90,95]},new Date('2026-09-01T10:00:00Z'));
  assert.equal(data.goals.length,1);
  assert.equal(data.goals[0].createdAt,created.createdAt);
  assert.ok(data.goals[0].updatedAt>created.updatedAt,'a clock behind the last save still produces a newer version');
  data=saveLiftGoal(data,{exercise:'Barbell bench press',load:85,reps:5,steps:[]});
  assert.deepEqual(activeLiftGoals(data,history).map((item)=>item.load),[102.5]);
  data=deleteLiftGoal(data,created.id);
  assert.equal(data.goals.find((item)=>item.id===created.id).deleted,true);
  assert.deepEqual(activeLiftGoals(data,history),[]);
});

test('goals sync through the device document; the newest save or deletion wins without conflicts',()=>{
  const base=createSyncDoc(snapshot({...emptyLiftGoals(),goals:[goal()]}));
  const before=projectSyncDoc(base);
  const phone=updateSyncDoc(A.clone(base),before,{...before,liftGoals:{...emptyLiftGoals(),goals:[goal({load:105,updatedAt:'2026-09-01T10:00:00.000Z'})]}});
  const laptop=updateSyncDoc(A.clone(base),before,{...before,liftGoals:deleteLiftGoal(before.liftGoals,'bench',new Date('2026-09-02T10:00:00Z'))});
  for(const doc of [merge(phone,laptop),merge(laptop,phone)]){
    assert.equal(projectSyncDoc(doc).liftGoals.goals[0].deleted,true);
    assert.deepEqual(listSyncConflicts(doc),[]);
  }
  // An older copy (journal replay, stale tab) never replaces a newer save.
  const stale=updateSyncDoc(phone,projectSyncDoc(phone),{...projectSyncDoc(phone),liftGoals:{...emptyLiftGoals(),goals:[goal({load:95,steps:[85,90],updatedAt:'2026-08-20T00:00:00.000Z'})]}});
  assert.equal(projectSyncDoc(stale).liftGoals.goals[0].load,105);
  assert.throws(()=>createSyncDoc(snapshot({...emptyLiftGoals(),goals:[goal({steps:[120]})]})));
  const wrongId=A.change(A.clone(createSyncDoc()),(d)=>{d.values[JSON.stringify(['liftGoal','other'])]=new A.ImmutableString(JSON.stringify(JSON.stringify(goal())));});
  assert.throws(()=>projectSyncDoc(wrongId),/identity/);
});

test('complete backups carry lift goals and merge them by latest save',()=>{
  const current=snapshot({...emptyLiftGoals(),goals:[goal({updatedAt:'2026-09-01T00:00:00.000Z'})]});
  const incoming=validateBackupSnapshot(snapshot({...emptyLiftGoals(),goals:[goal({load:110,updatedAt:'2026-08-15T00:00:00.000Z'}),goal({id:'squat',exercise:'Back squat',load:120,steps:[]})]}));
  const merged=mergeBackupSnapshot(current,incoming).liftGoals;
  assert.deepEqual(merged,mergeLiftGoals(current.liftGoals,incoming.liftGoals));
  assert.deepEqual(merged.goals.map((item)=>[item.id,item.load]),[['bench',100],['squat',120]]);
  assert.equal(validateBackupSnapshot(emptySyncSnapshot()).liftGoals,undefined);
});
