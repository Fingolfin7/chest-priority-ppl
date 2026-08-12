import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type WorkoutKey = "push" | "pull" | "legs";
type Demo = { label: string; slug: string };
type Exercise = { name: string; sets: string; reps: string; rest: string; cue: string; demos: Demo[] };

const workouts: Record<WorkoutKey, { summary: string; exercises: Exercise[] }> = {
  push: {
    summary: "5 exercises · chest priority",
    exercises: [
      { name: "Barbell bench press", sets: "4", reps: "5–8", rest: "2–4 min", cue: "Set your upper back, plant your feet, and touch the same lower-chest point each rep.", demos: [{ label: "Bench press", slug: "bench" }] },
      { name: "Incline dumbbell bench press", sets: "3", reps: "6–10", rest: "2–3 min", cue: "Use a modest incline. Lower with control and press up and slightly inward.", demos: [{ label: "Incline press", slug: "incline-press" }] },
      { name: "Cable fly", sets: "2", reps: "10–15", rest: "60–90 sec", cue: "Keep a soft elbow and bring your upper arms across your chest without turning it into a press.", demos: [{ label: "Cable fly", slug: "cable-fly" }] },
      { name: "Lateral raise", sets: "2–3", reps: "12–20", rest: "60–90 sec", cue: "Lead with your elbows, stop near shoulder height, and keep momentum out of it.", demos: [{ label: "Lateral raise", slug: "lateral-raise" }] },
      { name: "Cable triceps pushdown", sets: "3", reps: "8–12", rest: "60–90 sec", cue: "Pin your upper arms, extend fully, then control the return.", demos: [{ label: "Pushdown", slug: "pushdown" }] },
    ],
  },
  pull: {
    summary: "4 exercises · back + biceps",
    exercises: [
      { name: "Bent-over barbell row", sets: "3", reps: "6–10", rest: "2–3 min", cue: "Brace before you pull, keep your torso angle steady, and drive your elbows toward your hips.", demos: [{ label: "Barbell row", slug: "barbell-row" }] },
      { name: "Lat pulldown or pull-ups", sets: "3", reps: "6–12", rest: "2–3 min", cue: "Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.", demos: [{ label: "Lat pulldown", slug: "lat-pulldown" }, { label: "Pull-ups", slug: "pullups" }] },
      { name: "Rear-delt fly or face pull", sets: "2–3", reps: "12–20", rest: "60–90 sec", cue: "Use your rear delts and upper back. Keep your ribs down and avoid shrugging.", demos: [{ label: "Rear-delt fly", slug: "rear-delt-fly" }, { label: "Face pull", slug: "face-pull" }] },
      { name: "Barbell curl", sets: "3", reps: "8–12", rest: "60–90 sec", cue: "Keep your upper arms quiet, curl without leaning back, and own the lowering phase.", demos: [{ label: "Barbell curl", slug: "barbell-curl" }] },
    ],
  },
  legs: {
    summary: "5 exercises · squat + hinge",
    exercises: [
      { name: "Back squat", sets: "3", reps: "5–8", rest: "3–5 min", cue: "Brace before descending, keep pressure through your whole foot, and use safeties just below depth.", demos: [{ label: "Back squat", slug: "back-squat" }] },
      { name: "Conventional deadlift", sets: "2", reps: "4–6", rest: "3–5 min", cue: "Wedge into the bar, push the floor away, and finish tall without leaning back.", demos: [{ label: "Deadlift", slug: "deadlift" }] },
      { name: "Leg press or Bulgarian split squat", sets: "2–3", reps: "8–12", rest: "2–3 min", cue: "Choose the option you can control through a comfortable range. Keep your knee tracking over your foot.", demos: [{ label: "Leg press", slug: "leg-press" }, { label: "Split squat", slug: "split-squat" }] },
      { name: "Leg curl", sets: "3", reps: "10–15", rest: "60–90 sec", cue: "Keep your hips anchored, curl through your hamstrings, and lower without letting the stack crash.", demos: [{ label: "Leg curl", slug: "leg-curl" }] },
      { name: "Calf raise or abdominal work", sets: "2–3", reps: "controlled", rest: "60–90 sec", cue: "For calves, pause at the stretch and top. For abs, choose a movement you can progress cleanly.", demos: [{ label: "Calf raise", slug: "calf-raise" }, { label: "Ab work", slug: "abs" }] },
    ],
  },
};

const weeks: WorkoutKey[][] = [
  ["push", "pull", "legs", "push", "pull"],
  ["legs", "push", "pull", "legs", "push"],
  ["pull", "legs", "push", "pull", "legs"],
];

function DemoStrip({ demo, exercise }: { demo: Demo; exercise: string }) {
  return (
    <figure className="demo-strip">
      <div className="poses">
        <img src={`./exercises/${demo.slug}-0.jpg`} alt={`${demo.label}: first position`} loading="lazy" />
        <span aria-hidden="true">→</span>
        <img src={`./exercises/${demo.slug}-1.jpg`} alt={`${demo.label}: second position`} loading="lazy" />
      </div>
      <figcaption>{demo.label}</figcaption>
      <a className="image-source" href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer" aria-label={`Public-domain image source for ${exercise}`}>source</a>
    </figure>
  );
}

function Schedule() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  return (
    <section className="schedule" id="schedule" aria-labelledby="schedule-title">
      <div className="schedule-title-row">
        <div><h2 id="schedule-title">Rolling schedule</h2><p>Miss a day? Do the next workout in sequence. Weekends are for recovery.</p></div>
        <div className="sequence" aria-label="Push, then Pull, then Legs">Push <span>→</span> Pull <span>→</span> Legs</div>
      </div>
      <div className="schedule-table" role="table" aria-label="Three-week rolling schedule">
        <div className="schedule-row schedule-head" role="row"><span>Week</span>{days.map((day) => <span key={day}>{day}</span>)}</div>
        {weeks.map((week, index) => <div className="schedule-row" role="row" key={index}><b>{index + 1}</b>{week.map((day, dayIndex) => <span className={day} key={`${day}-${dayIndex}`}>{day}</span>)}</div>)}
      </div>
    </section>
  );
}

function ExerciseRow({ exercise, index }: { exercise: Exercise; index: number }) {
  return (
    <article className="exercise-row">
      <div className={`demo-grid ${exercise.demos.length > 1 ? "has-options" : ""}`}>
        {exercise.demos.map((demo) => <DemoStrip key={demo.slug} demo={demo} exercise={exercise.name} />)}
      </div>
      <div className="exercise-info">
        <div className="exercise-title"><span>{index + 1}</span><h3>{exercise.name}</h3></div>
        <div className="prescription"><strong>{exercise.sets}</strong><small>sets</small><i>×</i><strong>{exercise.reps}</strong><small>reps</small></div>
        <p className="cue">{exercise.cue}</p>
        <div className="exercise-meta"><span>Rest: {exercise.rest}</span><span>Start around 2 RIR</span></div>
      </div>
    </article>
  );
}

function Workout({ workout }: { workout: WorkoutKey }) {
  const data = workouts[workout];
  return (
    <section className={`workout ${workout}`} aria-labelledby={`${workout}-title`}>
      <header className="workout-header"><div><h2 id={`${workout}-title`}>{workout}</h2><p>{data.summary}</p></div><span>{data.exercises.length} movements</span></header>
      <div className="exercise-list">{data.exercises.map((exercise, index) => <ExerciseRow exercise={exercise} index={index} key={exercise.name} />)}</div>
    </section>
  );
}

function Notes() {
  return (
    <section className="notes" aria-labelledby="notes-title">
      <h2 id="notes-title">Rules you may need</h2>
      <details><summary>How to progress</summary><p>Add reps within the range while keeping about two clean reps in reserve. When every work set reaches the top of the range cleanly twice, add the smallest available weight. Hold or reduce the load if reps collapse or technique changes.</p></details>
      <details><summary>How to warm up</summary><p>Spend 5–8 minutes raising body temperature. Then use progressively heavier, low-rep ramp sets before the first big lift—for example: bar × 10, about 50% × 5, 70% × 3, 85% × 1. Ramp sets do not count as work sets.</p></details>
      <details><summary>Safety and rest</summary><p>Use safeties or a spotter for bench press and squat. Do not normalize joint pain. Controlled, repeatable technique matters more than load. Rest 2–4 minutes for compounds, 3–5 for squats and deadlifts, and 60–120 seconds for accessories.</p></details>
    </section>
  );
}

function App() {
  const [active, setActive] = useState<WorkoutKey>("push");
  return (
    <>
      <header className="app-header"><div><h1>Rolling PPL</h1><p>Chest-prioritized · five weekdays</p></div><a href="#schedule">Schedule</a></header>
      <main>
        <Schedule />
        <div className="workout-tabs" role="tablist" aria-label="Choose a workout">
          {(["push", "pull", "legs"] as WorkoutKey[]).map((key) => <button key={key} role="tab" aria-selected={active === key} className={active === key ? `active ${key}` : ""} onClick={() => setActive(key)}>{key}<small>{workouts[key].exercises.length} exercises</small></button>)}
        </div>
        <Workout workout={active} />
        <Notes />
      </main>
      <footer><p><strong>Rolling PPL</strong> · Keep the sequence; skip the weekly reset.</p><p>Exercise imagery from the public-domain <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer">Free Exercise DB</a> (Unlicense). Images are shown in grayscale for consistency.</p></footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
