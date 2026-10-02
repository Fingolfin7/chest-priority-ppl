import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProgress,projectWeight,projectLift,projectMeasurement,liftOutlookPoints} from '../src/projectionModel.ts';

const today='2026-10-02';
const day=offset=>new Date(Date.parse(`${today}T12:00:00Z`)+offset*86400000).toISOString().slice(0,10);
const weightPoints=(offsets,values)=>offsets.map((offset,index)=>({date:day(offset),value:Array.isArray(values)?values[index]:values,source:'weigh-in',id:String(index)}));
const sessions=(offsets,loads,reps=8)=>offsets.map((offset,index)=>({id:String(index),savedAt:`${day(offset)}T12:00:00Z`,sets:[{load:String(Array.isArray(loads)?loads[index]:loads),reps:String(Array.isArray(reps)?reps[index]:reps)}]}));
const tape=(offsets,values)=>offsets.map((offset,index)=>({id:String(index),date:day(offset),waist:Array.isArray(values)?values[index]:values,note:'',updatedAt:`${day(offset)}T12:00:00Z`}));

test('flat recorded weight produces a flat scenario with widening ranges and actual future dates',()=>{
  const result=projectWeight(weightPoints([-21,-17,-14,-10,-7,0],67),today);
  assert.equal(result.status,'ready');
  assert.equal(result.count,6);assert.equal(result.spanDays,21);
  assert.equal(result.slopePerWeek,0);
  assert.deepEqual(result.estimates.map(estimate=>estimate.date),['2026-10-16','2026-10-23','2026-10-30']);
  assert.ok(result.estimates.every(estimate=>estimate.value===67&&estimate.low<67&&estimate.high>67));
  assert.ok(result.estimates[2].high-result.estimates[2].low>result.estimates[0].high-result.estimates[0].low);
});

test('weight requires distinct recorded days, time span, and valid numeric readings',()=>{
  assert.equal(projectWeight(weightPoints([-15,-12,-9,-6,-3],67),today).status,'insufficient');
  assert.equal(projectWeight(weightPoints([-5,-4,-3,-2,-1,0],67),today).status,'insufficient');
  const repeated=weightPoints([-14,-14,-14,-14,-14,0],67);
  assert.equal(projectWeight(repeated,today).count,2);
  const invalid=[...weightPoints([-14,-10,-8,-5,-2,0],67),{date:'2026-02-30',value:67},{date:day(1),value:67},{date:day(-2),value:NaN}];
  assert.equal(projectWeight(invalid,today).count,6);
});

test('gaps use calendar dates without inventing daily observations or exaggerating the slope',()=>{
  const readings=weightPoints([-35,-28,-21,-14,-7,0],[65,65.2,65.4,65.6,65.8,66]);
  const result=projectWeight(readings,today);
  assert.equal(result.count,6);assert.equal(result.points.length,6);
  assert.ok(Math.abs(result.slopePerWeek-.2)<1e-9);
  assert.ok(Math.abs(result.estimates[0].value-66.4)<1e-9);
});

test('noisy and outlying weight readings retain an outlook but widen its scenario range',()=>{
  const flat=projectWeight(weightPoints([-21,-17,-14,-10,-7,0],67),today);
  const noisy=projectWeight(weightPoints([-21,-17,-14,-10,-7,0],[66,69,65,68,66,69]),today);
  assert.equal(noisy.status,'ready');assert.equal(noisy.quality,'noisy');
  assert.ok(noisy.estimates[2].high-noisy.estimates[2].low>flat.estimates[2].high-flat.estimates[2].low);
  const outlier=projectWeight(weightPoints([-21,-17,-14,-10,-7,0],[67,67,67,67,67,95]),today);
  assert.equal(outlier.status,'ready');assert.equal(outlier.quality,'noisy');
  assert.equal(outlier.estimates[0].value,67);
  assert.equal(outlier.latest.value,95);
});

test('stale history and values outside recent windows cannot create an outlook',()=>{
  assert.equal(projectWeight(weightPoints([-40,-37,-34,-30,-26,-22],67),today).status,'stale');
  const beyond=projectWeight(weightPoints([-80,-75,-70,-65,-60,-55],67),today);
  assert.equal(beyond.status,'insufficient');assert.equal(beyond.count,0);
  assert.equal(projectLift({Bench:sessions([-60,-50,-40,-29],60)},'Bench',today).status,'stale');
  assert.equal(projectMeasurement(tape([-110,-90,-70,-46],80),'waist',today).status,'stale');
});

test('lift outlook follows top working loads with rep context and skips unloaded or invalid sets',()=>{
  const history={Bench:sessions([-21,-14,-7,0],60,[6,7,8,9]),'Bodyweight movement':sessions([-21,-14,-7,0],'BW')};
  history.Bench[0].sets.push({load:'55',reps:'12'});
  history.Bench[3].sets.push({load:'60',reps:'10'},{load:'99',reps:''});
  const result=projectLift(history,'Bench',today);
  assert.equal(result.status,'ready');assert.equal(result.estimates[0].value,60);
  assert.equal(result.latest.reps,10);assert.equal(result.latest.value,60);
  assert.equal(liftOutlookPoints(history,'Bodyweight movement').length,0);
  assert.equal(projectLift({Bench:sessions([-13,-9,-4,0],60)},'Bench',today).status,'insufficient');
});

test('tape forecasts only actual chosen readings and picks the latest edit per day',()=>{
  const readings=tape([-28,-21,-14,0],[80,80.2,80.4,80.8]);
  readings.push({...readings[0],id:'new-edit',waist:81,updatedAt:'2026-10-02T13:00:00Z'});
  readings.push({id:'chest-only',date:day(-7),chest:95,note:'',updatedAt:`${day(-7)}T12:00:00Z`});
  const result=projectMeasurement(readings,'waist',today);
  assert.equal(result.count,4);assert.equal(result.points[0].value,81);assert.equal(result.status,'ready');
  assert.equal(projectMeasurement(readings,'arms',today).status,'insufficient');
  assert.equal(projectMeasurement(tape([-20,-14,-7,0],80),'waist',today).status,'insufficient');
});

test('nonpositive or implausibly changing extrapolations show an explicit unavailable estimate',()=>{
  const falling=projectProgress(weightPoints([-15,-12,-9,-6,-3,0],[80,70,60,50,40,30]),'weight',today);
  assert.equal(falling.status,'unstable');assert.equal(falling.estimates.length,0);
  assert.match(falling.reason,/usable range/);
});
