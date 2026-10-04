import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import {createSyncDoc,emptySyncSnapshot,listSyncConflicts,projectSyncDoc,updateSyncDoc} from '../src/peerSyncModel.ts';
import {mergeBackupSnapshot,validateBackupSnapshot} from '../src/backupBundle.ts';
import {
  MAX_COUNT,changeCount,emptyNutrition,intakeByTrend,isLogged,mergeNutrition,nextStamp,nutritionDay,nutritionSummary,
  parseNutrition,saveSupplements,shiftDay,toggleSupplement,weeklyIntake,
} from '../src/nutritionModel.ts';

const at=(time)=>new Date(`2026-10-04T${time}:00.000Z`);
const merge=(a,b)=>A.merge(A.clone(a),b);
const snapshot=(nutrition)=>({...emptySyncSnapshot(),nutrition});
const day=(date,counts={},updatedAt='2026-10-04T10:00:00.000Z',supplements=[])=>({date,meals:0,snacks:0,shakes:0,supplements,updatedAt,...counts});

test('tapping counts clamps between zero and the maximum and creates the day on first tap',()=>{
  let data=changeCount(undefined,'2026-10-04','meals',1,at('08:00'));
  data=changeCount(data,'2026-10-04','snacks',1,at('10:00'));
  data=changeCount(data,'2026-10-04','snacks',-1,at('10:01'));
  data=changeCount(data,'2026-10-04','snacks',-1,at('10:02'));
  assert.deepEqual({...nutritionDay(data,'2026-10-04'),updatedAt:undefined},{...day('2026-10-04',{meals:1}),updatedAt:undefined});
  for(let index=0;index<MAX_COUNT+5;index++) data=changeCount(data,'2026-10-04','shakes',1,at('11:00'));
  assert.equal(nutritionDay(data,'2026-10-04').shakes,MAX_COUNT);
  assert.equal(parseNutrition(data).days.length,1);
});

test('edits always get a newer stamp even when the clock is behind the last save',()=>{
  assert.equal(nextStamp('2026-10-04T12:00:00.000Z',at('09:00')),'2026-10-04T12:00:00.001Z');
  let data=changeCount(undefined,'2026-10-04','meals',1,at('12:00'));
  data=changeCount(data,'2026-10-04','meals',1,at('09:00'));
  assert.ok(nutritionDay(data,'2026-10-04').updatedAt>'2026-10-04T12:00:00.000Z');
});

test('a day with only zeros is not logged and averages skip unlogged days',()=>{
  let data=changeCount(undefined,'2026-10-04','meals',1,at('08:00'));
  data=changeCount(data,'2026-10-04','meals',-1,at('08:01'));
  assert.equal(isLogged(nutritionDay(data,'2026-10-04')),false);
  data={...emptyNutrition(),days:[day('2026-10-02',{meals:3,snacks:2}),day('2026-10-04',{meals:4,shakes:2})]};
  data=saveSupplements(data,[{id:'creatine',name:'Creatine'},{id:'d',name:'Vitamin D'}],at('07:00'));
  data=toggleSupplement(data,'2026-10-04','creatine',at('09:00'));
  const summary=nutritionSummary(data,'2026-10-04');
  assert.deepEqual({...summary},{loggedDays:2,length:7,meals:3.5,snacks:1,shakes:1,supplementRate:0.25});
});

test('nutrition syncs through the device document and concurrent edits converge on the newest save without conflicts',()=>{
  const base=createSyncDoc(snapshot({...emptyNutrition(),days:[day('2026-10-04',{meals:1},'2026-10-04T08:00:00.000Z')]}));
  const before=projectSyncDoc(base);
  const phone=updateSyncDoc(A.clone(base),before,{...before,nutrition:changeCount(before.nutrition,'2026-10-04','snacks',1,at('10:00'))});
  const laptop=updateSyncDoc(A.clone(base),before,{...before,nutrition:changeCount(before.nutrition,'2026-10-04','meals',1,at('11:00'))});
  for(const doc of [merge(phone,laptop),merge(laptop,phone)]){
    assert.deepEqual(nutritionDay(projectSyncDoc(doc).nutrition,'2026-10-04'),{...day('2026-10-04',{meals:2}),updatedAt:'2026-10-04T11:00:00.000Z'});
    assert.deepEqual(listSyncConflicts(doc),[]);
  }
  assert.deepEqual(projectSyncDoc(A.load(A.save(merge(phone,laptop)))).nutrition,projectSyncDoc(merge(phone,laptop)).nutrition);
  // Many taps reuse one register per day rather than adding fields.
  let doc=base,current=before;
  for(let index=0;index<10;index++){const next={...current,nutrition:changeCount(current.nutrition,'2026-10-04','meals',1,at(`12:0${index}`))};doc=updateSyncDoc(doc,current,next);current=projectSyncDoc(doc);}
  assert.equal(nutritionDay(current.nutrition,'2026-10-04').meals,11);
  assert.equal(Object.keys(doc.values).filter((path)=>path.includes('nutrition')).length,2);
});

test('an older copy of a day never replaces a newer synced save',()=>{
  const newer=day('2026-10-04',{meals:3},'2026-10-04T12:00:00.000Z');
  const doc=createSyncDoc(snapshot({...emptyNutrition(),days:[newer]}));
  const current=projectSyncDoc(doc);
  const stale=updateSyncDoc(doc,{...current,nutrition:emptyNutrition()},{...current,nutrition:{...emptyNutrition(),days:[day('2026-10-04',{meals:1},'2026-10-04T09:00:00.000Z')]}});
  assert.deepEqual(nutritionDay(projectSyncDoc(stale).nutrition,'2026-10-04'),newer);
});

test('invalid nutrition records are rejected by sync validation',()=>{
  assert.throws(()=>createSyncDoc(snapshot({...emptyNutrition(),days:[day('2026-10-04',{meals:-1})]})));
  assert.throws(()=>createSyncDoc(snapshot({...emptyNutrition(),days:[{...day('2026-10-04'),calories:2000}]})));
  const base=createSyncDoc();
  const wrongDate=A.change(A.clone(base),(d)=>{d.values[JSON.stringify(['nutrition','day','2026-10-03'])]=new A.ImmutableString(JSON.stringify(JSON.stringify(day('2026-10-04'))));});
  assert.throws(()=>projectSyncDoc(wrongDate),/identity/);
});

test('complete backups carry nutrition and merge days by latest save',()=>{
  const current=snapshot({...emptyNutrition(),days:[day('2026-10-03',{meals:3},'2026-10-03T20:00:00.000Z'),day('2026-10-04',{meals:1},'2026-10-04T12:00:00.000Z')]});
  const incoming=validateBackupSnapshot(snapshot({...emptyNutrition(),days:[day('2026-10-02',{snacks:2}),day('2026-10-04',{meals:2},'2026-10-04T08:00:00.000Z')]}));
  const merged=mergeBackupSnapshot(current,incoming).nutrition;
  assert.deepEqual(merged,mergeNutrition(current.nutrition,incoming.nutrition));
  assert.deepEqual(merged.days.map((item)=>[item.date,item.meals]),[['2026-10-02',0],['2026-10-03',3],['2026-10-04',1]]);
  assert.equal(validateBackupSnapshot(emptySyncSnapshot()).nutrition,undefined);
});

test('weekly picture compares logged intake with the change in average weight',()=>{
  const today='2026-10-04',days=[],readings=[];
  // Oldest to newest: steady near 80 kg, then two gaining weeks with more food.
  const plan=[{weight:80,meals:3},{weight:80.1,meals:3},{weight:80.6,meals:4},{weight:81.1,meals:4}];
  plan.forEach((week,index)=>{
    const end=shiftDay(today,-7*(plan.length-1-index));
    for(let offset=0;offset<7;offset++){
      const date=shiftDay(end,-offset);
      if(offset<5) days.push(day(date,{meals:week.meals,snacks:1,shakes:index>1?2:1}));
      if(offset<3) readings.push({date,value:week.weight});
    }
  });
  const weeks=weeklyIntake({...emptyNutrition(),days},readings,today,4);
  assert.deepEqual(weeks.map((week)=>week.trend),['gaining','gaining','steady',null]);
  assert.equal(weeks[3].change,null,'the oldest week has no previous week to compare');
  assert.deepEqual(intakeByTrend(weeks),[{trend:'gaining',weeks:2,meals:4,snacks:1,shakes:2}]);
  // Too few logged days: the week is listed but not classified.
  const sparse=weeklyIntake({...emptyNutrition(),days:days.filter((item)=>item.date<shiftDay(today,-2))},readings,today,1);
  assert.equal(sparse[0].trend,null);
});
