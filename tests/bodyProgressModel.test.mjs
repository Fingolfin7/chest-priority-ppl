import assert from "node:assert/strict";
import test from "node:test";
import { combineWeightReadings, emptyBodyProgress, localDay, mergeBodyProgress, parseBodyNumber, parseBodyProgress, weightMilestones, recentWeightAverages } from "../src/bodyProgressModel.ts";

test('weekly averages count only recorded days and leave missing windows empty',()=>{
  const readings=[{date:'2026-09-27',value:64},{date:'2026-10-01',value:66},{date:'2026-09-24',value:63}];
  const averages=recentWeightAverages(readings,'2026-10-02');
  assert.deepEqual(averages.recent,{value:65,count:2});
  assert.deepEqual(averages.previous,{value:63,count:1});
  assert.equal(recentWeightAverages(readings,'2026-11-01').recent.value,null);
});

const stamp = "2026-09-20T10:00:00.000Z";
const weight = (id, date, kg, updatedAt = stamp) => ({ id, date, kg, note: "", updatedAt });
const session = (id, endedAt, bodyweight) => ({ id, endedAt, bodyweight });
const goal = (targets = [67], sustainedDays = 3) => ({ targets, sustainedDays, updatedAt: stamp });

test("independent weigh-ins override a workout reading on the same local day without copying or duplicating", () => {
  const date = localDay(new Date(stamp));
  const sessions = [session("first", stamp, "66.2"), session("later", "2026-09-20T11:00:00.000Z", "66,4"), session("invalid", stamp, "BW")];
  assert.deepEqual(combineWeightReadings(sessions, []), [{ date, value: 66.4, source: "workout", id: "later" }]);
  const manual = weight("manual", date, 66.7);
  assert.deepEqual(combineWeightReadings(sessions, [manual]), [{ date, value: 66.7, source: "weigh-in", id: "manual" }]);
  assert.equal(sessions.length, 3);
});
test("multiple weigh-ins on one day use the latest edit and deterministic ID tie break", () => {
  const readings = combineWeightReadings([], [weight("a", "2026-09-20", 67), weight("z", "2026-09-20", 68), weight("old", "2026-09-20", 65, "2026-09-19T10:00:00.000Z")]);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].value, 68);
});
test("first reached and sustained milestones use a seven-day average of actual readings", () => {
  const readings = combineWeightReadings([], [weight("a", "2026-09-01", 67), weight("b", "2026-09-03", 68), weight("c", "2026-09-04", 66.9), weight("d", "2026-09-05", 67), weight("e", "2026-09-06", 67.1), weight("f", "2026-09-07", 67)]);
  assert.deepEqual(weightMilestones(readings, goal([67, 70])), [{ target: 67, firstReached: "2026-09-01", sustained: "2026-09-04", currentStreak: 6 }, { target: 70, firstReached: null, sustained: null, currentStreak: 0 }]);
});

test("gaps between readings are allowed but two days or a high isolated reading do not qualify", () => {
  const readings = combineWeightReadings([], [weight('a', '2026-09-01', 67), weight('b', '2026-09-04', 67), weight('c', '2026-09-07', 67)]);
  assert.equal(weightMilestones(readings, goal())[0].sustained, '2026-09-07');
  assert.equal(weightMilestones(readings.slice(0, 2), goal())[0].sustained, null);
  assert.equal(weightMilestones([...readings.slice(0, 2), {date:'2026-09-08', value:67}], goal())[0].sustained, null);
  assert.equal(weightMilestones([{date:'2026-09-01',value:70},{date:'2026-09-03',value:64},{date:'2026-09-05',value:64}], goal())[0].sustained, null);
  assert.equal(weightMilestones(readings, {...goal(),minimumReadings:4})[0].sustained, null);
  assert.equal(weightMilestones(readings, goal([67], 30))[0].sustained, '2026-09-07');
});

test("milestone windows defensively count duplicate days once and minimum readings are validated", () => {
  assert.equal(weightMilestones([{date:'2026-09-01',value:67},{date:'2026-09-01',value:67},{date:'2026-09-01',value:67}], goal())[0].sustained,null);
  for(const minimumReadings of [2,8,3.5,'3']) assert.throws(()=>parseBodyProgress({...emptyBodyProgress(),goal:{...goal(),minimumReadings}}),/Minimum readings/);
  assert.equal(parseBodyProgress({...emptyBodyProgress(),goal:{...goal(),minimumReadings:5}}).goal.minimumReadings,5);
});
test("three readings on a single day cannot earn sustained milestone", () => {
  const readings = combineWeightReadings([], [weight("a", "2026-09-20", 67), weight("b", "2026-09-20", 68), weight("c", "2026-09-20", 69)]);
  assert.equal(weightMilestones(readings, goal())[0].sustained, null);
});
test("validates real dates, numerical bounds, optional fields and goal rules without inventing missing measurements", () => {
  const data = { ...emptyBodyProgress(), weighIns: [weight("w", "2026-09-20", 66.5)], measurements: [{ id: "m", date: "2026-09-20", chest: 95, note: "left", updatedAt: stamp }], goal: goal([70, 67]) };
  const parsed = parseBodyProgress(data, "2026-09-20");
  assert.deepEqual(parsed.goal.targets, [67, 70]);
  assert.equal(parsed.measurements[0].waist, undefined);
  assert.throws(() => parseBodyProgress({ ...data, weighIns: [weight("w", "2026-02-30", 66)] }, "2026-09-20"), /valid date/);
  assert.throws(() => parseBodyProgress({ ...data, weighIns: [weight("w", "2026-09-21", 66)] }, "2026-09-20"), /valid date/);
  for (const kg of [NaN, Infinity, 0, -1, 501, "66"]) assert.throws(() => parseBodyProgress({ ...data, weighIns: [weight("w", "2026-09-20", kg)] }, "2026-09-20"));
  assert.throws(() => parseBodyProgress({ ...data, measurements: [{ id: "m", date: "2026-09-20", note: "", updatedAt: stamp }] }, "2026-09-20"), /at least one/);
  assert.throws(() => parseBodyProgress({ ...data, goal: goal([67], 1) }, "2026-09-20"), /2 to 30/);
  assert.throws(() => parseBodyProgress({ ...data, goal: goal([67, 67]) }, "2026-09-20"), /different/);
  assert.throws(() => parseBodyProgress({ ...data, weighIns: [data.weighIns[0], data.weighIns[0]] }, "2026-09-20"), /Duplicate/);
  assert.ok(Number.isNaN(parseBodyNumber("")));
  assert.equal(parseBodyNumber("66,5"), 66.5);
});
test("merging a backup preserves unrelated records, resolves edits and respects deletion tombstones", () => {
  const left = { ...emptyBodyProgress(), weighIns: [weight("existing", "2026-09-20", 66), weight("edited", "2026-09-20", 65)], deletions: [{ kind: "weight", id: "deleted", deletedAt: "2026-09-21T10:00:00.000Z" }] };
  const right = { ...emptyBodyProgress(), weighIns: [weight("added", "2026-09-20", 67), weight("edited", "2026-09-20", 68, "2026-09-21T10:00:00.000Z"), weight("deleted", "2026-09-20", 66)], goal: goal([70]) };
  const merged = mergeBodyProgress(left, right);
  assert.deepEqual(merged.weighIns.map((record) => [record.id, record.kg]), [["added", 67], ["edited", 68], ["existing", 66]]);
  assert.deepEqual(merged.goal.targets, [70]);
  assert.deepEqual(mergeBodyProgress(right, left), merged);
  assert.deepEqual(mergeBodyProgress(merged, right), merged);
});
test("same-timestamp conflicts converge independent of import order", () => {
  const left = { ...emptyBodyProgress(), weighIns: [weight("w", "2026-09-20", 66)] };
  const right = { ...emptyBodyProgress(), weighIns: [weight("w", "2026-09-20", 67)] };
  assert.deepEqual(mergeBodyProgress(left, right), mergeBodyProgress(right, left));
});
