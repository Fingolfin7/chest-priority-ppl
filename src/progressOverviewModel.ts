import type { CompletedWorkout } from './sessionModel';
import type { TrainingPhase } from './planModel';
import { workoutBelongsToPhase } from './planModel.ts';
import { localDay, MEASUREMENT_KEYS, type BodyMeasurement, type WeightReading } from './bodyProgressModel.ts';

export function suggestedWeightMilestones(latest: number | undefined, target: number): number[] {
  if (latest === undefined || !Number.isFinite(latest) || !Number.isFinite(target) || latest <= 0 || target <= 0 || target > 500 || target === latest) return [];
  const result: number[] = [];
  // Whole kilograms strictly between the latest reading and the goal, either direction.
  if (target > latest) for (let value = Math.floor(latest) + 1; value < target; value += 1) result.push(value);
  else for (let value = Math.ceil(latest) - 1; value > target; value -= 1) result.unshift(value);
  return result;
}

export function phaseProgress(phase: TrainingPhase, sessions: CompletedWorkout[], readings: WeightReading[], measurements: BodyMeasurement[], endedAt?: string) {
  const training = sessions.filter((session) => workoutBelongsToPhase(session, phase)).sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  const firstSession = training[0];
  const startedAt = phase.id === "original-ppl-v1" && firstSession && firstSession.endedAt < phase.startedAt ? (firstSession.startedAt ?? firstSession.endedAt) : phase.startedAt;
  const start = localDay(new Date(startedAt));
  const end = endedAt ? localDay(new Date(endedAt)) : undefined;
  const during = (date: string) => date >= start && (!end || date < end);
  const weights = readings.filter((reading) => during(reading.date)).sort((a, b) => a.date.localeCompare(b.date));
  const tape = MEASUREMENT_KEYS.flatMap((key) => {
    const records = measurements.filter((record) => during(record.date) && record[key] !== undefined).sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
    if (records.length < 2 || records[0].date === records.at(-1)!.date) return [];
    return [{ key, first: records[0][key]!, latest: records.at(-1)![key]! }];
  });
  const lifts = new Map<string, Array<{ load: number; reps: number; date: string }>>();
  for (const session of training) for (const exercise of session.exercises) {
    const numeric = exercise.sets.map((set) => ({ load: Number(set.load.trim().replace(',', '.')), reps: Number(set.reps) })).filter((set) => Number.isFinite(set.load) && set.load > 0 && Number.isFinite(set.reps) && set.reps > 0);
    const best = numeric.sort((a, b) => b.load - a.load || b.reps - a.reps)[0];
    if (best) lifts.set(exercise.name, [...(lifts.get(exercise.name) ?? []), { ...best, date: session.endedAt }]);
  }
  return {
    startedAt,
    workouts: training.length,
    weight: weights.length >= 2 ? { first: weights[0].value, latest: weights.at(-1)!.value, count: weights.length } : null,
    measurements: tape,
    lifts: [...lifts].flatMap(([name, sets]) => sets.length < 2 ? [] : [{ name, first: sets[0], latest: sets.at(-1)! }]).slice(0, 3),
  };
}
