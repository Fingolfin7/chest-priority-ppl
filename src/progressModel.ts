import type { HistoryMap } from "./historyMigration";
import type { CompletedWorkout } from "./sessionModel";

export type ChartMetric = "volume" | "load";

export type ChartPoint = {
  date: string;
  value: number;
};

export type ExerciseSeries = {
  exercise: string;
  points: ChartPoint[];
};

export function chartScale(values: number[]) {
  const finite = values.filter(Number.isFinite);
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 1;
  const span = Math.max(high - low, Math.abs(high) * .04, 1);
  const roughStep = span / 3;
  const power = 10 ** Math.floor(Math.log10(roughStep));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= roughStep)!;
  const min = Math.max(0, Math.floor(low / step) * step);
  const max = Math.ceil((high + span * .08) / step) * step;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => Number((min + index * step).toPrecision(12)));
  return { min, max, ticks };
}

function numericValue(value: string) {
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function bodyweightSeries(sessions: CompletedWorkout[], limit = 24): ChartPoint[] {
  return sessions
    .map((session) => ({ date: session.endedAt, value: numericValue(session.bodyweight) }))
    .filter((reading): reading is { date: string; value: number } => reading.value !== null)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-limit);
}

export function exerciseMetricSeries(
  history: HistoryMap,
  exercises: string[],
  metric: ChartMetric,
  limit = 16,
): ExerciseSeries[] {
  return exercises.map((exercise) => {
    const points = [...(history[exercise] ?? [])]
      .sort((left, right) => left.savedAt.localeCompare(right.savedAt))
      .map((session) => {
        const numericSets = session.sets
          .map((set) => ({ load: numericValue(set.load), reps: numericValue(set.reps) }))
          .filter((set): set is { load: number; reps: number } => set.load !== null && set.reps !== null);
        if (!numericSets.length) return null;
        const value = metric === "volume"
          ? numericSets.reduce((sum, set) => sum + set.load * set.reps, 0)
          : Math.max(...numericSets.map((set) => set.load));
        return { date: session.savedAt, value };
      })
      .filter((point): point is ChartPoint => point !== null)
      .slice(-limit);
    return { exercise, points };
  }).filter((series) => series.points.length > 0);
}

export function availableChartExercises(history: HistoryMap) {
  return Object.keys(history)
    .filter((exercise) => exerciseMetricSeries(history, [exercise], "load").length > 0)
    .sort((left, right) => left.localeCompare(right));
}
