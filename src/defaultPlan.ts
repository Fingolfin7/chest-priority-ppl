import type { PlanState, PlanWorkouts } from "./planModel.ts";

export const defaultWorkouts: PlanWorkouts = {
  push: { summary: "6 exercises · chest priority", exercises: [
    { name: "Barbell bench press", sets: "3–4", reps: "5–8", rest: "2–4 min", warmup: "3–4 ramp sets", cue: "Set your upper back, plant your feet, and touch the same lower-chest point each rep. The fourth work set is optional.", priority: "must", demos: [{ label: "Bench press", slug: "bench" }] },
    { name: "Incline dumbbell bench press", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "1–2 ramp sets × 6–8", cue: "Use a modest incline. Lower with control and press up and slightly inward.", priority: "must", loadSuffix: " each", demos: [{ label: "Incline press", slug: "incline-press" }] },
    { name: "Lateral raise", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Lead with your elbows, stop near shoulder height, and keep momentum out of it.", priority: "must", loadSuffix: " each", demos: [{ label: "Lateral raise", slug: "lateral-raise" }] },
    { name: "Cable triceps pushdown", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Pin your upper arms, extend fully, then control the return.", priority: "must", demos: [{ label: "Pushdown", slug: "pushdown" }] },
    { name: "Overhead dumbbell triceps extension", sets: "2–3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Hold one dumbbell with both hands. Keep your upper arms steady and use a comfortable depth. The third work set is optional.", priority: "optional", demos: [{ label: "Overhead dumbbell extension", slug: "overhead-db-extension" }] },
    { name: "Chest press machine", sets: "2", reps: "8–12", rest: "90–120 sec", warmup: "1 light ramp set × 8–10", cue: "Set the seat so the handles meet mid-chest. Keep your upper back planted and control the return.", priority: "optional", demos: [{ label: "Chest press machine", slug: "chest-press-machine" }] },
  ] },
  pull: { summary: "5 exercises · back + biceps", exercises: [
    { name: "Bent-over barbell row", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "2–3 ramp sets × 5–8", cue: "Brace before you pull, keep your torso angle steady, and drive your elbows toward your hips.", priority: "must", demos: [{ label: "Barbell row", slug: "barbell-row" }] },
    { name: "Vertical pull", alternatives: ["Lat pulldown", "Pull-ups"], sets: "3", reps: "6–12", rest: "2–3 min", warmup: "1 light or assisted set × 8–10", cue: "Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.", priority: "must", demos: [{ label: "Lat pulldown", slug: "lat-pulldown" }, { label: "Pull-ups", slug: "pullups" }] },
    { name: "Rear-delt fly", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Use your rear delts and upper back. Keep your ribs down and avoid shrugging.", priority: "must", demos: [{ label: "Rear-delt fly", slug: "rear-delt-fly" }] },
    { name: "Barbell curl", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 10–12", cue: "Keep your upper arms quiet, curl without leaning back, and own the lowering phase.", priority: "must", demos: [{ label: "Barbell curl", slug: "barbell-curl" }] },
    { name: "Dumbbell hammer curl", sets: "2–3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 10–12", cue: "Keep a neutral grip, leave your elbows by your sides, and lower without swinging. The third work set is optional.", priority: "optional", loadSuffix: " each", demos: [{ label: "Hammer curl", slug: "hammer-curl" }] },
  ] },
  legs: { summary: "6 exercises · squat + hinge", exercises: [
    { name: "Back squat", sets: "3", reps: "5–8", rest: "3–5 min", warmup: "3–4 ramp sets", cue: "Brace before descending, keep pressure through your whole foot, and use safeties just below depth.", priority: "must", demos: [{ label: "Back squat", slug: "back-squat" }] },
    { name: "Conventional deadlift", sets: "2", reps: "4–6", rest: "3–5 min", warmup: "2–3 ramp sets × 3–5", cue: "Wedge into the bar, push the floor away, and finish tall without leaning back.", priority: "must", demos: [{ label: "Deadlift", slug: "deadlift" }] },
    { name: "Leg curl", sets: "3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Keep your hips anchored, curl through your hamstrings, and lower without letting the stack crash.", priority: "must", demos: [{ label: "Leg curl", slug: "leg-curl" }] },
    { name: "Quad accessory", alternatives: ["Leg press", "Bulgarian split squat"], sets: "2–3", reps: "8–12", rest: "2–3 min", warmup: "1–2 light sets × 8", cue: "Choose the option you can control through a comfortable range. Keep your knee tracking over your foot.", priority: "optional", demos: [{ label: "Leg press", slug: "leg-press" }, { label: "Bulgarian split squat", slug: "split-squat" }] },
    { name: "Calf raise", sets: "2–3", reps: "10–15", rest: "60–90 sec", warmup: "1 easy set × 12–15", cue: "Use a full comfortable stretch, pause briefly at the top, and avoid bouncing. The third work set is optional.", priority: "optional", demos: [{ label: "Calf raise", slug: "calf-raise" }] },
    { name: "Ab crunch machine", sets: "2–3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Bring your ribs toward your pelvis, pause in the crunch, and control the return. The third work set is optional.", priority: "optional", demos: [{ label: "Ab crunch machine", slug: "ab-crunch-machine" }] },
  ] },
};


export function defaultPlanState(): PlanState { return { currentId: "original-ppl-v1", phases: [{ id: "original-ppl-v1", name: "Chest emphasis", purpose: "Build strength and muscle with a rolling Push, Pull, Legs sequence.", startedAt: "2026-10-02T00:00:00.000Z", workouts: structuredClone(defaultWorkouts) }] }; }
