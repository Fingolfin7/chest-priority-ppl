import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import {createSyncDoc,emptySyncSnapshot,listSyncConflicts,migrateExerciseAliases,projectSyncDoc,resolveSyncConflict,updateSyncDoc,validateSyncDoc} from '../src/peerSyncModel.ts';
import {emptyBodyProgress,mergeBodyProgress} from '../src/bodyProgressModel.ts';
import {defaultPlanState} from '../src/defaultPlan.ts';
import {trainingForWorkout} from '../src/planModel.ts';
const exercise='Barbell bench press';
const key=(...parts)=>JSON.stringify(parts);
const merge=(a,b)=>A.merge(A.clone(a),b);
const bodyWeight=(id,kg=67,updatedAt='2026-09-20T10:00:00.000Z')=>({id,date:'2026-09-20',kg,note:'',updatedAt});
const bodySnapshot=(body)=>({...emptySyncSnapshot(),bodyProgress:{...emptyBodyProgress(),...body}});

test('paired body progress unions independent weights, measurements, goals and remains separate from photos',()=>{
  const left=bodySnapshot({weighIns:[bodyWeight('phone')],goal:{targets:[70],sustainedDays:3,minimumReadings:3,updatedAt:'2026-09-22T10:00:00.000Z'}});
  const right=bodySnapshot({weighIns:[bodyWeight('laptop',68)],measurements:[{id:'tape',date:'2026-09-20',waist:80,note:'',updatedAt:'2026-09-20T10:00:00.000Z'}]});
  const doc=merge(createSyncDoc(left),createSyncDoc(right));
  assert.deepEqual(projectSyncDoc(doc).bodyProgress,mergeBodyProgress(left.bodyProgress,right.bodyProgress));
  assert.deepEqual(projectSyncDoc(A.load(A.save(doc))).bodyProgress,projectSyncDoc(doc).bodyProgress);
  assert.deepEqual(listSyncConflicts(doc),[]);
  assert.equal(projectSyncDoc(merge(doc,createSyncDoc())).bodyProgress.goal.targets[0],70);
  assert.equal(Object.keys(doc.values).some(path=>path.includes('photo')),false);
});

test('body deletion tombstones survive stale peers, backup copies and causal edits with older timestamps',()=>{
  const original=bodySnapshot({weighIns:[bodyWeight('old')]});
  const base=createSyncDoc(original);
  const deleted=edit(A.clone(base),s=>{s.bodyProgress.weighIns=[];s.bodyProgress.deletions=[{kind:'weight',id:'old',deletedAt:'2026-09-22T10:00:00.000Z'}];});
  let doc=merge(deleted,createSyncDoc(original));
  assert.equal(projectSyncDoc(doc).bodyProgress.weighIns.length,0);
  doc=edit(doc,s=>{s.bodyProgress.weighIns=[bodyWeight('old',69,'2026-09-21T10:00:00.000Z')];});
  assert.equal(projectSyncDoc(doc).bodyProgress.weighIns.length,0);
  doc=edit(doc,s=>{s.bodyProgress.weighIns=[bodyWeight('old',70,'2026-09-23T10:00:00.000Z')];});
  assert.equal(projectSyncDoc(doc).bodyProgress.weighIns[0].kg,70);
  assert.equal(projectSyncDoc(merge(doc,base)).bodyProgress.weighIns[0].kg,70);
});

test('body record versions converge on concurrent edits and same-timestamp imports',()=>{
  const base=createSyncDoc(bodySnapshot({weighIns:[bodyWeight('w')]}));
  const left=edit(A.clone(base),s=>{s.bodyProgress.weighIns=[bodyWeight('w',68,'2026-09-21T10:00:00.000Z')];});
  const right=edit(A.clone(base),s=>{s.bodyProgress.weighIns=[bodyWeight('w',69,'2026-09-22T10:00:00.000Z')];});
  const doc=merge(left,right);
  assert.equal(projectSyncDoc(doc).bodyProgress.weighIns[0].kg,69);
  const older=edit(doc,s=>{s.bodyProgress.weighIns=[bodyWeight('w',66,'2026-09-20T10:00:00.000Z')];});
  assert.equal(projectSyncDoc(older).bodyProgress.weighIns[0].kg,69);
  const a=createSyncDoc(bodySnapshot({weighIns:[bodyWeight('same',66)]})),b=createSyncDoc(bodySnapshot({weighIns:[bodyWeight('same',68)]}));
  assert.deepEqual(projectSyncDoc(merge(a,b)).bodyProgress,projectSyncDoc(merge(b,a)).bodyProgress);
  const unchanged=edit(merge(a,b),s=>{s.bodyProgress.weighIns=[bodyWeight('same',66)];});
  assert.equal(projectSyncDoc(unchanged).bodyProgress.weighIns[0].kg,68);
});

test('incoming body versions validate identity, bounds, tombstones and hidden conflicting records',()=>{
  const base=createSyncDoc();
  const write=(parts,value)=>A.change(A.clone(base),d=>{d.values[key(...parts)]=new A.ImmutableString(JSON.stringify(JSON.stringify(value)));});
  const stamp='2026-09-20T10:00:00.000Z',path=['body','weight','w',stamp];
  assert.throws(()=>validateSyncDoc(write(path,bodyWeight('different'))),/identity/);
  assert.throws(()=>validateSyncDoc(write(path,bodyWeight('w',501))),/Weight/);
  assert.throws(()=>validateSyncDoc(write(['body','deletion','weight','w',stamp],{kind:'measurement',id:'w',deletedAt:stamp})),/identity/);
  assert.throws(()=>validateSyncDoc(write(['body','photo','w',stamp],{id:'w'})),/path/);
  assert.throws(()=>validateSyncDoc(merge(write(path,bodyWeight('w',67)),write(path,bodyWeight('w',-1)))),/Weight/);
});
function workout(id='workout-1',date='2026-09-01') {return {id,workout:'push',startedAt:`${date}T05:00:00.000Z`,endedAt:`${date}T06:00:00.000Z`,bodyweight:'65',note:'Original note',exercises:[{name:exercise,priority:'must',sets:[{load:'55',reps:'8'},{load:'55',reps:'7'}]}],sync:{status:'unsynced'}};}
function snapshot(...completed){const s=emptySyncSnapshot();s.completed=completed;for(const w of completed)for(const e of w.exercises)(s.history[e.name]??=[]).push({id:`${w.id}:${e.name}`,savedAt:w.endedAt,sets:structuredClone(e.sets)});return s;}
function edit(doc,change){const before=projectSyncDoc(doc),after=structuredClone(before);change(after);return updateSyncDoc(doc,before,after);}
function choose(doc,k,value){const c=listSyncConflicts(doc).find(c=>c.key===k);assert.ok(c,`Missing conflict ${k}`);const option=c.options.find(o=>o.value===value);assert.ok(option,`Missing option ${value}`);return resolveSyncConflict(doc,k,option.id);}
function active(){const s=emptySyncSnapshot();s.activeWorkout={id:'active-1',workout:'push',startedAt:'2026-09-01T05:00:00.000Z'};s.drafts={[exercise]:[{load:'55',reps:'8'}]};s.checkpoints={[exercise]:{workoutId:'active-1',fingerprint:JSON.stringify(s.drafts[exercise])}};s.bodyweight='65';s.sessionNote='Started on phone';return s;}
function renamedSyncPaths(doc, current, previous){return A.change(doc,draft=>{for(const path of Object.keys(draft.values)){const parts=JSON.parse(path);const index=['exercise','draftExercise','checkpoint'].includes(parts[0])?2:['history','historyLink'].includes(parts[0])?1:parts[0]==='set'?3:-1;if(parts[index]!==current)continue;parts[index]=previous;draft.values[JSON.stringify(parts)]=new A.ImmutableString(String(draft.values[path]));delete draft.values[path];}});}
function namedWorkout(id,date,name,reps){const saved=workout(id,date);saved.workout=name==='Leg press'?'legs':'pull';saved.exercises=[{name,priority:'must',sets:[{id:`${id}-set`,load:'50',reps}]}];saved.sync={status:'synced',autumnSessionId:Number(date.slice(-2))};return saved;}

test('cached projections remain isolated from callers and local validation rejects invalid edits',()=>{
  const doc=createSyncDoc(snapshot(workout()));
  const projection=projectSyncDoc(doc);
  projection.completed[0].note='Uncommitted mutation';
  assert.equal(projectSyncDoc(doc).completed[0].note,'Original note');
  validateSyncDoc(doc);
  assert.throws(()=>edit(A.clone(doc),s=>{s.completed[0].exercises[0].sets[0].reps='-1';}),/completed set reps/);
});

test('draft-only updates preserve history and untouched conflicts through cached validation',()=>{
  const base=createSyncDoc({...snapshot(workout()),...active(),completed:[workout()]});
  const left=edit(A.clone(base),s=>{s.completed[0].note='Phone note';});
  const right=edit(A.clone(base),s=>{s.completed[0].note='Laptop note';});
  const merged=merge(left,right),before=projectSyncDoc(merged);
  const updated=updateSyncDoc(merged,before,{...before,sessionNote:'New draft note'});
  assert.deepEqual(projectSyncDoc(updated).completed,before.completed);
  assert.deepEqual(projectSyncDoc(updated).history,before.history);
  assert.deepEqual(listSyncConflicts(updated),listSyncConflicts(merged));
});
test('old combined-name sync records join newer pulldown and pull-up sessions without replacing either',()=>{
const old=namedWorkout('old-pulldown','2026-09-01','Lat pulldown','8');
const newer=namedWorkout('new-pulldown','2026-09-08','Lat pulldown','10');
const pullups=namedWorkout('new-pullups','2026-09-15','Pull-ups','6');
let legacy=renamedSyncPaths(createSyncDoc(snapshot(old)),'Lat pulldown','Lat pulldown or pull-ups');
const liftOnly=emptySyncSnapshot();liftOnly.history['Lat pulldown']=[{id:'saved-old-lift',savedAt:'2026-08-25T06:00:00.000Z',sets:[{id:'saved-old-set',load:'45',reps:'9'}]}];
legacy=merge(legacy,renamedSyncPaths(createSyncDoc(liftOnly),'Lat pulldown','Lat pulldown or pull-ups'));
assert.equal(projectSyncDoc(legacy).history['Lat pulldown'],undefined);
const mixed=merge(legacy,createSyncDoc(snapshot(newer,pullups)));
const migrated=migrateExerciseAliases(mixed),result=projectSyncDoc(migrated);
assert.deepEqual(result.completed.map(w=>w.id).sort(),['new-pulldown','new-pullups','old-pulldown']);
assert.deepEqual(result.history['Lat pulldown'].map(s=>s.sets[0].reps).sort(),['10','8','9']);
assert.deepEqual(result.history['Pull-ups'].map(s=>s.sets[0].reps),['6']);
assert.equal(result.history['Lat pulldown or pull-ups'],undefined);
assert.equal(result.completed.find(w=>w.id==='old-pulldown').sync.autumnSessionId,1);
assert.equal(result.completed.find(w=>w.id==='old-pulldown').exercises[0].sets[0].id,'old-pulldown-set');
assert.deepEqual(A.getHeads(migrateExerciseAliases(migrated)),A.getHeads(migrated));
assert.deepEqual(projectSyncDoc(A.load(A.save(migrated))),result);
assert.deepEqual(listSyncConflicts(migrated),[]);
const corrected=edit(migrated,s=>{s.completed.find(w=>w.id==='old-pulldown').exercises[0].sets[0].reps='11';});
assert.deepEqual(projectSyncDoc(corrected).history['Lat pulldown'].map(s=>s.sets[0].reps).sort(),['10','11','9']);
});
for(const [name,oldName] of [['Leg press','Leg press or Bulgarian split squat'],['Rear-delt fly','Rear-delt fly or face pull'],['Ab crunch machine','Calf raise or abdominal work']]){
test(`${oldName} history migrates into ${name}`,()=>{const old=namedWorkout(`old-${name}`,'2026-09-02',name,'12');const legacy=renamedSyncPaths(createSyncDoc(snapshot(old)),name,oldName);const result=projectSyncDoc(migrateExerciseAliases(legacy));assert.equal(result.history[name][0].sets[0].reps,'12');assert.equal(result.history[oldName],undefined);});
}
test('identical independent imports merge once, seed stable set IDs, and round-trip history',()=>{
const s=snapshot(workout()),m=merge(createSyncDoc(s),createSyncDoc(structuredClone(s))),p=projectSyncDoc(m);
assert.equal(p.completed.length,1);assert.equal(p.history[exercise].length,1);assert.ok(p.completed[0].exercises[0].sets.every(s=>s.id));assert.deepEqual(listSyncConflicts(m),[]);assert.deepEqual(projectSyncDoc(A.load(A.save(m))),p);
});
test('equivalent receipt key ordering does not create conflicts',()=>{const a=snapshot(workout()),b=structuredClone(a);a.completed[0].sync={status:'synced',projectId:3,autumnSessionId:42};b.completed[0].sync={autumnSessionId:42,status:'synced',projectId:3};assert.deepEqual(listSyncConflicts(merge(createSyncDoc(a),createSyncDoc(b))),[]);});
test('preexisting histories form a union and empty browser does not override next',()=>{const a=snapshot(workout('a')),b=snapshot(workout('b','2026-09-02'));a.next=b.next='pull';const m=merge(merge(createSyncDoc(a),createSyncDoc(b)),createSyncDoc()),p=projectSyncDoc(m);assert.equal(p.completed.length,2);assert.equal(p.history[exercise].length,2);assert.equal(p.next,'pull');assert.deepEqual(listSyncConflicts(m),[]);});
test('independent note and set edits both survive in workout and derived history',()=>{const base=createSyncDoc(snapshot(workout()));const a=edit(A.clone(base),s=>{s.completed[0].note='Laptop note';}),b=edit(A.clone(base),s=>{s.completed[0].exercises[0].sets[0].reps='10';}),m=merge(a,b),p=projectSyncDoc(m);assert.equal(p.completed[0].note,'Laptop note');assert.equal(p.completed[0].exercises[0].sets[0].reps,'10');assert.equal(p.history[exercise][0].sets[0].reps,'10');assert.deepEqual(listSyncConflicts(m),[]);});
test('same-field edits retain both values, explicit resolution and later correction converge',()=>{const base=createSyncDoc(snapshot(workout()));const a=edit(A.clone(base),s=>{s.completed[0].exercises[0].sets[0].reps='9';}),b=edit(A.clone(base),s=>{s.completed[0].exercises[0].sets[0].reps='10';});let m=merge(a,b);const c=listSyncConflicts(m);assert.equal(c.length,1);assert.match(c[0].label,/Barbell bench press.*set 1.*reps/);assert.deepEqual(c[0].options.map(o=>o.value).sort(),['10','9']);m=choose(m,c[0].key,'9');assert.equal(projectSyncDoc(m).completed[0].exercises[0].sets[0].reps,'9');assert.deepEqual(listSyncConflicts(m),[]);m=edit(m,s=>{s.completed[0].exercises[0].sets[0].reps='12';});assert.equal(projectSyncDoc(m).completed[0].exercises[0].sets[0].reps,'12');assert.deepEqual(listSyncConflicts(m),[]);});
test('repeated delivery and committed crash journal are idempotent without resolving conflicts',()=>{const base=createSyncDoc(snapshot(workout())),before=projectSyncDoc(base),after=structuredClone(before);after.completed[0].note='Journal edit';const changed=updateSyncDoc(A.clone(base),before,after);assert.deepEqual(A.getHeads(updateSyncDoc(changed,before,after)),A.getHeads(changed));const other=edit(A.clone(base),s=>{s.completed[0].note='Other edit';});const m=merge(changed,other),winner=projectSyncDoc(m),replay=updateSyncDoc(m,before,winner);assert.deepEqual(A.getHeads(replay),A.getHeads(m));assert.equal(listSyncConflicts(replay).length,1);assert.deepEqual(projectSyncDoc(merge(replay,changed)),winner);});
test('stale browser cannot resurrect deleted workout or derived lifts',()=>{const base=createSyncDoc(snapshot(workout())),d=edit(A.clone(base),s=>{s.completed=[];s.history={};}),m=merge(d,base);assert.deepEqual(projectSyncDoc(m).completed,[]);assert.deepEqual(projectSyncDoc(m).history,{});assert.deepEqual(listSyncConflicts(m),[]);});
test('concurrent delete and edit retain one actionable conflict that restores all sets',()=>{const base=createSyncDoc(snapshot(workout())),d=edit(A.clone(base),s=>{s.completed=[];s.history={};}),e=edit(A.clone(base),s=>{s.completed[0].exercises[0].sets[0].reps='11';});let m=merge(d,e);assert.deepEqual(projectSyncDoc(m).completed,[]);assert.equal(listSyncConflicts(m).length,1);m=choose(m,key('workout','workout-1','alive'),'Keep record');assert.equal(projectSyncDoc(m).completed[0].exercises[0].sets[0].reps,'11');assert.equal(projectSyncDoc(m).history[exercise].length,1);assert.deepEqual(listSyncConflicts(m),[]);});
test('concurrent independent added sets retain their UUIDs',()=>{const base=createSyncDoc(snapshot(workout())),a=edit(A.clone(base),s=>{s.completed[0].exercises[0].sets.push({id:'phone-set',load:'55',reps:'5'});}),b=edit(A.clone(base),s=>{s.completed[0].exercises[0].sets.push({id:'laptop-set',load:'50',reps:'9'});}),m=merge(a,b),sets=projectSyncDoc(m).completed[0].exercises[0].sets;assert.equal(sets.length,4);assert.equal(new Set(sets.map(s=>s.id)).size,4);assert.deepEqual(listSyncConflicts(m),[]);});
test('draft edits invalidate old checkpoints and retain independent notes',()=>{const base=createSyncDoc(active());assert.ok(projectSyncDoc(base).checkpoints[exercise]);const a=edit(A.clone(base),s=>{s.drafts[exercise][0].reps='9';}),b=edit(A.clone(base),s=>{s.sessionNote='Laptop note';}),m=merge(a,b),p=projectSyncDoc(m);assert.equal(p.drafts[exercise][0].reps,'9');assert.equal(p.sessionNote,'Laptop note');assert.equal(p.checkpoints[exercise],undefined);assert.deepEqual(listSyncConflicts(m),[]);});
test('current-session exercise choices sync and conflicting choices stay actionable',()=>{const saved=active();saved.exerciseChoices={'Vertical pull':'Lat pulldown'};assert.deepEqual(projectSyncDoc(A.load(A.save(createSyncDoc(saved)))).exerciseChoices,saved.exerciseChoices);const base=createSyncDoc(active()),a=edit(A.clone(base),s=>{s.exerciseChoices['Vertical pull']='Pull-ups';}),b=edit(A.clone(base),s=>{s.exerciseChoices['Vertical pull']='Lat pulldown';}),m=merge(a,b),conflict=listSyncConflicts(m).find(item=>item.label==='Vertical pull · selected exercise');assert.ok(conflict);assert.deepEqual(conflict.options.map(option=>option.value).sort(),['Lat pulldown','Pull-ups']);});
test('distinct active workouts keep their drafts separate',()=>{const a=active(),b=active();b.activeWorkout.id='active-2';b.drafts[exercise][0].reps='12';b.checkpoints={};const m=merge(createSyncDoc(a),createSyncDoc(b));for(const id of ['active-1','active-2']){const selected=choose(A.clone(m),key('state','activeId'),id);assert.equal(projectSyncDoc(selected).drafts[exercise][0].reps,id==='active-1'?'8':'12');}});
test('finish versus offline draft edit can reopen and correct the same workout UUID',()=>{const base=createSyncDoc(active()),finished=edit(A.clone(base),s=>{const w=workout('active-1');w.exercises[0].sets=s.drafts[exercise];s.completed=[w];s.history={};s.activeWorkout=null;s.drafts={};s.checkpoints={};s.next='pull';}),edited=edit(A.clone(base),s=>{s.drafts[exercise][0].reps='11';});let m=merge(finished,edited);assert.equal(projectSyncDoc(m).completed.length,1);assert.equal(projectSyncDoc(m).activeWorkout,null);m=choose(m,key('active','active-1','alive'),'Keep record');m=choose(m,key('state','activeId'),'active-1');let p=projectSyncDoc(m);assert.equal(p.activeWorkout.id,'active-1');assert.equal(p.drafts[exercise][0].reps,'11');m=edit(m,s=>{s.completed[0].exercises[0].sets=s.drafts[exercise];s.activeWorkout=null;s.drafts={};s.checkpoints={};});p=projectSyncDoc(m);assert.equal(p.completed.length,1);assert.equal(p.completed[0].exercises[0].sets[0].reps,'11');assert.equal(p.activeWorkout,null);assert.deepEqual(listSyncConflicts(m),[]);});
test('grouped legacy workout does not duplicate original lift',()=>{const w=workout('legacy-2026-09-01:push');w.sync={status:'legacy'};const s=snapshot(w);s.history[exercise][0].id='old-lift';assert.equal(projectSyncDoc(createSyncDoc(s)).history[exercise].length,1);});
test('remote validation rejects unknown fields, credentials, mutable text and invalid hidden conflicts',()=>{const base=createSyncDoc(snapshot(workout()));const unknown=A.change(A.clone(base),d=>{d.values[key('credentials','token')]=new A.ImmutableString('"secret"');});assert.throws(()=>validateSyncDoc(unknown),/unsupported field/);const credential=A.change(A.clone(base),d=>{d.values[key('workout','workout-1','sync')]=new A.ImmutableString(JSON.stringify(JSON.stringify({status:'synced',token:'secret'})));});assert.throws(()=>validateSyncDoc(credential),/credentials/);const mutable=A.change(A.clone(base),d=>{d.values[key('state','next')]='"pull"';});assert.throws(()=>validateSyncDoc(mutable),/non-scalar/);const setId=projectSyncDoc(base).completed[0].exercises[0].sets[0].id,invalid=A.change(A.clone(base),d=>{d.values[key('set','workout','workout-1',exercise,setId,'reps')]=new A.ImmutableString('"-3"');}),valid=edit(A.clone(base),s=>{s.completed[0].exercises[0].sets[0].reps='12';});assert.throws(()=>validateSyncDoc(merge(invalid,valid)),/completed set reps/);});

test('legacy lift aliases survive corrections after meeting a lift-only browser',()=>{const saved=workout('legacy-2026-09-01:push');saved.sync={status:'legacy'};const a=snapshot(saved);a.history[exercise][0].id='old-lift-session';const b={...emptySyncSnapshot(),history:structuredClone(a.history)};let doc=merge(createSyncDoc(a),createSyncDoc(b));assert.equal(projectSyncDoc(doc).history[exercise].length,1);doc=edit(doc,s=>{s.completed[0].exercises[0].sets[0].reps='12';});assert.equal(projectSyncDoc(doc).history[exercise].length,1);assert.equal(projectSyncDoc(doc).history[exercise][0].sets[0].reps,'12');doc=edit(doc,s=>{s.completed=[];s.history={};});assert.deepEqual(projectSyncDoc(doc).history,{});});
test('concurrent valid start/end and workout/sequence edits merge into a repaired, still-syncable snapshot',()=>{
  const base=createSyncDoc(snapshot(workout()));
  const phone=edit(A.clone(base),s=>{s.completed[0].startedAt='2026-09-01T05:50:00.000Z';});
  const laptop=edit(A.clone(base),s=>{s.completed[0].endedAt='2026-09-01T05:30:00.000Z';});
  // Mirror PeerSyncManager.receive: every received document must validate.
  const docs=[phone,laptop],states=[A.initSyncState(),A.initSyncState()];
  for(let turn=0,quiet=0;quiet<2;turn++){const from=turn%2,to=1-from,[state,message]=A.generateSyncMessage(docs[from],states[from]);states[from]=state;if(!message){quiet++;continue;}quiet=0;const [received,next]=A.receiveSyncMessage(A.clone(docs[to]),states[to],message);validateSyncDoc(received);docs[to]=migrateExerciseAliases(received);states[to]=next;}
  assert.deepEqual(A.getHeads(docs[0]),A.getHeads(docs[1]));
  const doc=docs[0];
  const p=projectSyncDoc(doc);
  assert.equal(p.completed[0].startedAt,'2026-09-01T05:50:00.000Z');
  assert.ok(Date.parse(p.completed[0].endedAt)>=Date.parse(p.completed[0].startedAt));
  assert.equal(p.history[exercise][0].savedAt,p.completed[0].endedAt);
  assert.deepEqual(projectSyncDoc(A.load(A.save(doc))),p);
  const fixed=edit(doc,s=>{s.completed[0].endedAt='2026-09-01T06:40:00.000Z';});
  assert.equal(projectSyncDoc(fixed).completed[0].endedAt,'2026-09-01T06:40:00.000Z');
  const phase=defaultPlanState().phases[0],tagged=workout();tagged.training=trainingForWorkout(phase,'push');
  const planned=createSyncDoc(snapshot(tagged));
  const retyped=edit(A.clone(planned),s=>{s.completed[0].workout='legs';});
  const resequenced=edit(A.clone(planned),s=>{s.completed[0].training.sequence=['push','pull'];});
  const repaired=projectSyncDoc(merge(retyped,resequenced)).completed[0];
  assert.equal(repaired.workout,'legs');
  assert.equal(repaired.training.sequence,undefined);
  assert.equal(repaired.training.phaseId,phase.id);
});

test('deleting a completed workout alone also removes its derived lift history on every peer',()=>{
  const base=createSyncDoc(snapshot(workout(),workout('workout-2','2026-09-03')));
  const deleted=edit(A.clone(base),s=>{s.completed=s.completed.filter((item)=>item.id!=='workout-1');});
  const merged=merge(base,deleted);
  assert.deepEqual(projectSyncDoc(merged).completed.map((item)=>item.id),['workout-2']);
  assert.deepEqual(Object.values(projectSyncDoc(merged).history).flat().map((item)=>item.id),['workout-2:'+exercise]);
  assert.doesNotThrow(()=>validateSyncDoc(merged));
});
