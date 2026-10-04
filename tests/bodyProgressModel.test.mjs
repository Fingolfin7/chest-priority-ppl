import assert from "node:assert/strict";
import test from "node:test";
import { checkEntryDate, combineWeightReadings, emptyBodyProgress, localDay, mergeBodyProgress, parseBodyNumber, parseBodyProgress, weightGoal, weightMilestones, recentWeightAverages } from "../src/bodyProgressModel.ts";

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
  const parsed = parseBodyProgress(data);
  assert.deepEqual(parsed.goal.targets, [67, 70]);
  assert.equal(parsed.measurements[0].waist, undefined);
  assert.throws(() => parseBodyProgress({ ...data, weighIns: [weight("w", "2026-02-30", 66)] }), /valid date/);
  for (const kg of [NaN, Infinity, 0, -1, 501, "66"]) assert.throws(() => parseBodyProgress({ ...data, weighIns: [weight("w", "2026-09-20", kg)] }));
  assert.throws(() => parseBodyProgress({ ...data, measurements: [{ id: "m", date: "2026-09-20", note: "", updatedAt: stamp }] }), /at least one/);
  assert.throws(() => parseBodyProgress({ ...data, goal: goal([67], 1) }), /2 to 30/);
  assert.throws(() => parseBodyProgress({ ...data, goal: goal([67, 67]) }), /different/);
  assert.throws(() => parseBodyProgress({ ...data, weighIns: [data.weighIns[0], data.weighIns[0]] }), /Duplicate/);
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

test("only the entry form rejects future dates; stored, merged and synced records still load", () => {
  assert.throws(() => checkEntryDate("2026-09-21", "2026-09-20"), /on or before today/);
  assert.throws(() => checkEntryDate("2026-02-30", "2026-09-20"), /valid date/);
  assert.doesNotThrow(() => checkEntryDate("2026-09-20", "2026-09-20"));
  const tomorrow = localDay(new Date(Date.now() + 2 * 86_400_000));
  const stored = { ...emptyBodyProgress(), weighIns: [weight("west", tomorrow, 66)], measurements: [{ id: "m", date: tomorrow, chest: 95, note: "", updatedAt: stamp }] };
  assert.equal(parseBodyProgress(stored).weighIns[0].date, tomorrow);
  const merged = parseBodyProgress(mergeBodyProgress(parseBodyProgress(stored), { ...emptyBodyProgress(), weighIns: [weight("old", "2026-09-19", 65)] }));
  assert.deepEqual(merged.weighIns.map((record) => record.id), ["old", "west"]);
  const readings = combineWeightReadings([], merged.weighIns);
  assert.equal(readings.at(-1).date, tomorrow);
  assert.deepEqual(recentWeightAverages(readings, localDay()).recent, { value: 66, count: 1 });
});
test("weight-loss goals are reached and sustained going down, with milestones ordered toward the goal", () => {
  const lossGoal = { targets: [72, 70, 71], sustainedDays: 3, updatedAt: "2026-09-01T08:00:00.000Z" };
  const start = [weight("a", "2026-09-01", 73.4), weight("b", "2026-09-02", 73)];
  assert.deepEqual(weightGoal(combineWeightReadings([], start), lossGoal), { target: 70, loss: true });
  assert.deepEqual(weightMilestones(combineWeightReadings([], start), lossGoal).map((item) => [item.target, item.firstReached, item.sustained]), [[72, null, null], [71, null, null], [70, null, null]]);
  const later = combineWeightReadings([], [...start, weight("c", "2026-09-05", 69.8), weight("d", "2026-09-06", 70.4), weight("e", "2026-09-07", 69.9), weight("f", "2026-09-08", 69.6), weight("g", "2026-09-09", 69.5)]);
  const result = weightMilestones(later, lossGoal);
  assert.deepEqual(result.map((item) => item.target), [72, 71, 70]);
  assert.equal(result[2].firstReached, "2026-09-05");
  assert.equal(weightMilestones(later.slice(0, -1), lossGoal)[2].sustained, null);
  assert.equal(result[2].sustained, "2026-09-09");
  assert.equal(result[0].sustained, "2026-09-06");
  // A cut after a bulk: the reading when the goal was saved sets the direction, not the first ever reading.
  assert.deepEqual(weightGoal([{ date: "2026-01-01", value: 60 }, ...later], { ...lossGoal, updatedAt: "2026-09-02T08:00:00.000Z" }), { target: 70, loss: true });
  // Gain goals keep their existing direction and order.
  assert.deepEqual(weightGoal(combineWeightReadings([], start), goal([75, 74])), { target: 75, loss: false });
  assert.deepEqual(weightGoal([], goal([75, 74])), { target: 75, loss: false });
});
