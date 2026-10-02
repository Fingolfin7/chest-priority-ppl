import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestedWeightMilestones, phaseProgress } from '../src/progressOverviewModel.ts';
import { workoutBelongsToPhase } from '../src/planModel.ts';

test('original plan includes untagged PPL history without claiming other programmes or rewriting records', () => {
  const original={id:'original-ppl-v1',startedAt:'2026-10-02T00:00:00Z'};
  const sessions=['push','pull','legs','upper'].map((workout,i)=>({id:String(i),workout,endedAt:'2026-09-01T12:00:00Z',exercises:[]}));
  sessions.push({...sessions[0],id:'tagged',training:{phaseId:'new-phase'}});
  const before=structuredClone(sessions);
  assert.equal(sessions.filter(session=>workoutBelongsToPhase(session,original)).length,3);
  assert.equal(phaseProgress(original,sessions,[],[]).workouts,3);
  assert.equal(phaseProgress({...original,id:'new-phase'},sessions,[],[]).workouts,1);
  assert.deepEqual(sessions,before);
});
test('suggested milestones stay between the observed weight and the chosen goal', () => {
  assert.deepEqual(suggestedWeightMilestones(64.5,70),[65,66,67,68,69]);
  assert.deepEqual(suggestedWeightMilestones(68,70),[69]);
  assert.deepEqual(suggestedWeightMilestones(undefined,70),[]);
  assert.deepEqual(suggestedWeightMilestones(71,70),[]);
});
test('phase insights exclude other phases and require comparable records', () => {
  const phase={id:'phase',startedAt:'2026-09-10T00:00:00Z'};
  const session=(id,phaseId,date,load,reps)=>({id,endedAt:date,training:{phaseId},exercises:[{name:'Bench',sets:[{load,reps}]}]});
  const sessions=[session('a','phase','2026-09-11T09:00:00Z','60','8'),session('b','other','2026-09-12T09:00:00Z','100','1'),session('c','phase','2026-09-13T09:00:00Z','62.5','6')];
  const readings=[{date:'2026-09-09',value:63},{date:'2026-09-11',value:64},{date:'2026-09-14',value:65},{date:'2026-10-01',value:66}];
  const result=phaseProgress(phase,sessions,readings,[], '2026-10-01T00:00:00Z');
  assert.equal(result.workouts,2);
  assert.deepEqual(result.weight,{first:64,latest:65,count:2});
  assert.equal(result.lifts[0].first.load,60);
  assert.equal(result.lifts[0].latest.load,62.5);
  assert.equal(result.lifts[0].latest.reps,6);
  assert.equal(phaseProgress(phase,[],[readings[1]],[]).weight,null);
  assert.deepEqual(phaseProgress(phase,[],[],[{date:'2026-09-11',waist:80,updatedAt:'2026-09-11T08:00:00Z'},{date:'2026-09-11',waist:81,updatedAt:'2026-09-11T09:00:00Z'}]).measurements,[]);
});
