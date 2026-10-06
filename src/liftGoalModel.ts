import type { HistoryMap } from "./historyMigration.ts";
import { nextStamp } from "./nutritionModel.ts";

// A lift goal is a load and rep target for one exercise, with optional steps at
// lighter loads and the same reps. A step or goal counts as reached only when a
// logged set matches or beats both numbers. Between those, progress uses an
// estimated max (Epley), so sets at other rep counts still move the bar.
export type LiftGoal = { id: string; exercise: string; load: number; reps: number; steps: number[]; createdAt: string; updatedAt: string; deleted?: true };
export type LiftGoalsData = { schemaVersion: 1; goals: LiftGoal[] };
export type GoalMark = { load: number; reps: number; reachedOn: string | null; final: boolean };
type LiftSet = { date: string; load: number; reps: number };
type Estimate = { max: number; date: string; load: number; reps: number };

export const MAX_ACTIVE_LIFT_GOALS = 3;
export const MAX_GOAL_STEPS = 8;
const MAX_REPS = 30;
const ESTIMATE_REP_LIMIT = 12;
const DAY = 86_400_000;
export const emptyLiftGoals = (): LiftGoalsData => ({ schemaVersion: 1, goals: [] });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Lift goals must contain valid records.");
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid lift goal date.");
  return new Date(value).toISOString();
}
function load(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000) throw new Error(`${label} must be greater than 0 and at most 1000 kg.`);
  return Math.round(value * 100) / 100;
}

export function parseLiftGoal(value: unknown): LiftGoal {
  const record = object(value);
  if (Object.keys(record).some((key) => !["id", "exercise", "load", "reps", "steps", "createdAt", "updatedAt", "deleted"].includes(key))) throw new Error("Lift goals cannot contain unknown fields.");
  if (typeof record.id !== "string" || !record.id.trim() || record.id.length > 100) throw new Error("Invalid lift goal ID.");
  if (typeof record.exercise !== "string" || !record.exercise.trim() || record.exercise.length > 120) throw new Error("Choose a lift for this goal.");
  const target = load(record.load, "Goal weight");
  if (typeof record.reps !== "number" || !Number.isInteger(record.reps) || record.reps < 1 || record.reps > MAX_REPS) throw new Error(`Goal reps must be a whole number from 1 to ${MAX_REPS}.`);
  if (!Array.isArray(record.steps) || record.steps.length > MAX_GOAL_STEPS) throw new Error(`Choose up to ${MAX_GOAL_STEPS} steps.`);
  const steps = [...new Set(record.steps.map((step) => load(step, "Step weight")))].sort((a, b) => a - b);
  if (steps.some((step) => step >= target)) throw new Error("Steps must be lighter than the goal.");
  if (record.deleted !== undefined && record.deleted !== true) throw new Error("Invalid lift goal deletion.");
  return { id: record.id, exercise: record.exercise.trim(), load: target, reps: record.reps, steps, createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt), ...(record.deleted ? { deleted: true as const } : {}) };
}
export function parseLiftGoals(value: unknown): LiftGoalsData {
  const data = object(value);
  if (data.schemaVersion !== 1) throw new Error("Unsupported lift goals version.");
  if (!Array.isArray(data.goals) || data.goals.length > 10_000) throw new Error("Invalid lift goals.");
  const goals = data.goals.map(parseLiftGoal);
  if (new Set(goals.map((goal) => goal.id)).size !== goals.length) throw new Error("Duplicate lift goal IDs.");
  return { schemaVersion: 1, goals: goals.sort((a, b) => a.id.localeCompare(b.id)) };
}

// Later saves win, deletions included. Equal stamps pick the same copy everywhere.
export function newerLiftGoal(left: LiftGoal, right: LiftGoal): LiftGoal {
  return left.updatedAt > right.updatedAt ? left : left.updatedAt < right.updatedAt ? right : JSON.stringify(left) >= JSON.stringify(right) ? left : right;
}
export function mergeLiftGoals(left: LiftGoalsData, right: LiftGoalsData): LiftGoalsData {
  const goals = new Map<string, LiftGoal>();
  for (const goal of [...left.goals, ...right.goals]) goals.set(goal.id, goals.has(goal.id) ? newerLiftGoal(goals.get(goal.id)!, goal) : goal);
  return { schemaVersion: 1, goals: [...goals.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function saveLiftGoal(data: LiftGoalsData | undefined, input: Pick<LiftGoal, "exercise" | "load" | "reps" | "steps"> & { id?: string }, now = new Date()): LiftGoalsData {
  const current = data ?? emptyLiftGoals();
  const existing = current.goals.find((goal) => goal.id === input.id);
  const goal = parseLiftGoal({ exercise: input.exercise, load: input.load, reps: input.reps, steps: input.steps, id: existing?.id ?? crypto.randomUUID(), createdAt: existing?.createdAt ?? now.toISOString(), updatedAt: nextStamp(existing?.updatedAt ?? "", now) });
  return { schemaVersion: 1, goals: [...current.goals.filter((item) => item.id !== goal.id), goal].sort((a, b) => a.id.localeCompare(b.id)) };
}
// A deleted goal stays as a tombstone so the deletion syncs.
export function deleteLiftGoal(data: LiftGoalsData, id: string, now = new Date()): LiftGoalsData {
  return { schemaVersion: 1, goals: data.goals.map((goal) => goal.id === id ? { ...goal, deleted: true as const, updatedAt: nextStamp(goal.updatedAt, now) } : goal) };
}

export const estimatedMax = (weight: number, reps: number) => weight * (1 + reps / 30);
export const loadForReps = (max: number, reps: number) => max / (1 + reps / 30);
export const repsAtLoad = (max: number, weight: number) => 30 * (max / weight - 1);

function number(value: string) {
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
// Sessions are dated by when they were saved, the same as the lift chart.
export function liftSets(history: HistoryMap, exercise: string): LiftSet[] {
  return (history[exercise] ?? []).flatMap((session) => session.sets.map((set) => ({ date: session.savedAt, load: number(set.load), reps: number(set.reps) })))
    .filter((set): set is LiftSet => set.load !== null && set.reps !== null && Number.isInteger(set.reps))
    .sort((a, b) => a.date.localeCompare(b.date));
}
export function reachedOn(sets: LiftSet[], weight: number, reps: number): string | null {
  return sets.find((set) => set.load >= weight - 1e-9 && set.reps >= reps)?.date ?? null;
}
function best(sets: LiftSet[], repLimit: number): Estimate | null {
  return sets.filter((set) => set.reps <= repLimit).reduce<Estimate | null>((top, set) => {
    const max = estimatedMax(set.load, set.reps);
    return !top || max > top.max ? { max, date: set.date, load: set.load, reps: set.reps } : top;
  }, null);
}
const within = (sets: LiftSet[], from: number, to: number) => sets.filter((set) => Date.parse(set.date) >= from && Date.parse(set.date) <= to);

export function isGoalReached(goal: LiftGoal, history: HistoryMap) {
  return reachedOn(liftSets(history, goal.exercise), goal.load, goal.reps) !== null;
}
export function activeLiftGoals(data: LiftGoalsData | undefined, history: HistoryMap) {
  return (data?.goals ?? []).filter((goal) => !goal.deleted && !isGoalReached(goal, history));
}

export type LiftGoalProgress = {
  marks: GoalMark[];
  next: GoalMark | null;
  reached: string | null;
  start: Estimate | null;
  now: Estimate | null;
  // Share of the way from the starting estimate to the goal, 0 to 1.
  fraction: number | null;
  nowAtGoalReps: number | null;
  repsAtGoalLoad: number | null;
  eta: { from: string; to: string } | null;
};

// "Now" is the best estimate in the four weeks up to the latest session, so a
// break from a lift shows its last known strength. The start is the best in the
// four weeks before the goal was set, or the first session afterwards.
export function liftGoalProgress(goal: LiftGoal, history: HistoryMap, today = new Date()): LiftGoalProgress {
  const sets = liftSets(history, goal.exercise);
  const marks: GoalMark[] = [...goal.steps.map((step) => ({ load: step, reps: goal.reps, reachedOn: reachedOn(sets, step, goal.reps), final: false })), { load: goal.load, reps: goal.reps, reachedOn: reachedOn(sets, goal.load, goal.reps), final: true }];
  const reached = marks.at(-1)!.reachedOn;
  const repLimit = Math.max(ESTIMATE_REP_LIMIT, goal.reps);
  const created = Date.parse(goal.createdAt);
  const start = best(within(sets, created - 28 * DAY, created), repLimit) ?? best(sets.filter((set) => Date.parse(set.date) > created).slice(0, 1).flatMap((first) => sets.filter((set) => set.date === first.date)), repLimit);
  const latest = sets.at(-1) ? Date.parse(sets.at(-1)!.date) : null;
  const now = latest === null ? null : best(within(sets, latest - 28 * DAY, latest), repLimit);
  const goalMax = estimatedMax(goal.load, goal.reps);
  const fraction = reached ? 1 : !now ? null : !start || goalMax <= start.max ? Math.min(1, now.max / goalMax) : Math.min(1, Math.max(0, (now.max - start.max) / (goalMax - start.max)));
  return { marks, next: marks.find((mark) => !mark.reachedOn) ?? null, reached, start, now, fraction,
    nowAtGoalReps: now ? loadForReps(now.max, goal.reps) : null,
    repsAtGoalLoad: now ? Math.max(0, repsAtLoad(now.max, goal.load)) : null,
    eta: reached || !now ? null : goalEta(sets, repLimit, goalMax, now.max, today) };
}

// Fit a line through each session's best estimate over the last eight weeks.
// Shown as a range that allows for progress slowing; hidden when progress is
// flat, the data is thin, or the goal is more than a year away.
function goalEta(sets: LiftSet[], repLimit: number, goalMax: number, nowMax: number, today: Date) {
  const latest = Date.parse(sets.at(-1)!.date);
  const sessions = [...new Set(within(sets, latest - 56 * DAY, latest).map((set) => set.date))].map((date) => ({ day: Date.parse(date) / DAY, max: best(sets.filter((set) => set.date === date), repLimit)?.max })).filter((item): item is { day: number; max: number } => item.max !== undefined);
  if (sessions.length < 4 || sessions.at(-1)!.day - sessions[0].day < 21) return null;
  const meanDay = sessions.reduce((sum, item) => sum + item.day, 0) / sessions.length;
  const meanMax = sessions.reduce((sum, item) => sum + item.max, 0) / sessions.length;
  const slope = sessions.reduce((sum, item) => sum + (item.day - meanDay) * (item.max - meanMax), 0) / sessions.reduce((sum, item) => sum + (item.day - meanDay) ** 2, 0);
  if (!(slope > 0)) return null;
  const days = (goalMax - nowMax) / slope;
  if (days > 365) return null;
  const at = (factor: number) => new Date(today.getTime() + Math.max(0, days) * factor * DAY).toISOString();
  return { from: at(0.8), to: at(1.6) };
}

// Steps at round loads between the current estimate and the goal. Wider ranges
// use bigger jumps; up to three spread-out steps are picked by default.
export function suggestSteps(fromLoad: number | null, goalLoad: number, sets: LiftSet[] = [], reps = 1): { options: number[]; picked: number[] } {
  const floor = fromLoad ?? 0;
  const span = goalLoad - floor;
  const increment = span <= 15 ? 2.5 : span <= 40 ? 5 : 10;
  const options: number[] = [];
  for (let value = (Math.floor(floor / increment) + 1) * increment; value < goalLoad - 1e-9 && options.length < MAX_GOAL_STEPS; value += increment) {
    if (!reachedOn(sets, value, reps)) options.push(Math.round(value * 100) / 100);
  }
  const picked = options.length <= 3 ? options : [1, 2, 3].map((part) => options[Math.round(part * (options.length + 1) / 4) - 1]);
  return { options, picked: [...new Set(picked)] };
}

// Steps and goals first reached by the session saved at this time.
export function goalMarksReachedAt(data: LiftGoalsData | undefined, history: HistoryMap, savedAt: string) {
  return (data?.goals ?? []).filter((goal) => !goal.deleted).flatMap((goal) => {
    const { marks } = liftGoalProgress(goal, history);
    return marks.map((mark, index) => ({ goal, mark, step: index + 1, steps: marks.length })).filter(({ mark }) => mark.reachedOn === savedAt);
  });
}
