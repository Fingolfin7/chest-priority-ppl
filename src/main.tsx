import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type WorkoutKey = "push" | "pull" | "legs";
type Exercise = {
  name: string;
  sets: string;
  reps: string;
  cue: string;
  rest: string;
  motion: string;
  options: { label: string; url: string }[];
};

const demo = (query: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(`ACE Fitness ${query} exercise technique`)}`;

const workouts: Record<WorkoutKey, { note: string; exercises: Exercise[] }> = {
  push: {
    note: "Chest leads. Delts and triceps finish the work without stealing recovery.",
    exercises: [
      { name: "Barbell bench press", sets: "4", reps: "5–8", rest: "2–4 min", cue: "Set the upper back, keep feet planted, and touch the same lower-chest point each rep.", motion: "press", options: [{ label: "Bench press demo", url: demo("barbell bench press") }] },
      { name: "Incline dumbbell bench press", sets: "3", reps: "6–10", rest: "2–3 min", cue: "Use a modest incline. Lower with control and press up and slightly inward.", motion: "incline", options: [{ label: "Incline press demo", url: "https://www.acefitness.org/resources/everyone/exercise-library/25/incline-chest-press/" }] },
      { name: "Cable fly", sets: "2", reps: "10–15", rest: "60–90 sec", cue: "Keep a soft elbow, bring the upper arms across the chest, and avoid turning it into a press.", motion: "fly", options: [{ label: "Cable fly demo", url: "https://www.acefitness.org/resources/everyone/exercise-library/160/standing-chest-fly/" }] },
      { name: "Lateral raise", sets: "2–3", reps: "12–20", rest: "60–90 sec", cue: "Lead with the elbows, stop near shoulder height, and keep momentum out of it.", motion: "raise", options: [{ label: "Lateral raise demo", url: demo("dumbbell lateral raise") }] },
      { name: "Cable triceps pushdown", sets: "3", reps: "8–12", rest: "60–90 sec", cue: "Pin the upper arms, extend fully without rolling the shoulders forward, then return slowly.", motion: "pushdown", options: [{ label: "Pushdown demo", url: demo("cable triceps pushdown") }] },
    ],
  },
  pull: {
    note: "A short, complete back and biceps session that protects room for the next Push day.",
    exercises: [
      { name: "Bent-over barbell row", sets: "3", reps: "6–10", rest: "2–3 min", cue: "Brace before the pull, keep the torso angle steady, and drive elbows toward the hips.", motion: "row", options: [{ label: "Barbell row demo", url: demo("bent-over barbell row") }] },
      { name: "Lat pulldown or pull-ups", sets: "3", reps: "6–12", rest: "2–3 min", cue: "Start by bringing the shoulders down; pull elbows toward the ribs without swinging.", motion: "pulldown", options: [{ label: "Lat pulldown demo", url: demo("lat pulldown") }, { label: "Pull-up demo", url: demo("pull-up") }] },
      { name: "Rear-delt fly or face pull", sets: "2–3", reps: "12–20", rest: "60–90 sec", cue: "Move through the rear delts and upper back; keep ribs down and avoid shrugging.", motion: "rear", options: [{ label: "Rear-delt fly demo", url: demo("rear delt fly") }, { label: "Face pull demo", url: demo("cable face pull") }] },
      { name: "Barbell curl", sets: "3", reps: "8–12", rest: "60–90 sec", cue: "Keep the upper arms quiet, curl without leaning back, and own the lowering phase.", motion: "curl", options: [{ label: "Barbell curl demo", url: demo("barbell biceps curl") }] },
    ],
  },
  legs: {
    note: "The main squat and hinge patterns, then just enough single-leg, hamstring, and lower-leg work.",
    exercises: [
      { name: "Back squat", sets: "3", reps: "5–8", rest: "3–5 min", cue: "Brace before descending, keep pressure through the whole foot, and use safeties set just below depth.", motion: "squat", options: [{ label: "Back squat demo", url: demo("barbell back squat") }] },
      { name: "Conventional deadlift", sets: "2", reps: "4–6", rest: "3–5 min", cue: "Wedge into the bar, push the floor away, and finish tall without leaning back.", motion: "hinge", options: [{ label: "Deadlift demo", url: demo("conventional barbell deadlift") }] },
      { name: "Leg press or Bulgarian split squat", sets: "2–3", reps: "8–12", rest: "2–3 min", cue: "Use the option you can control through a comfortable range. Keep knee tracking over the foot.", motion: "legs", options: [{ label: "Leg press demo", url: demo("leg press") }, { label: "Split squat demo", url: "https://www.acefitness.org/resources/everyone/exercise-library/11/bulgarian-split-squat/" }] },
      { name: "Leg curl", sets: "3", reps: "10–15", rest: "60–90 sec", cue: "Keep hips anchored, curl through the hamstrings, and lower without letting the stack crash.", motion: "legcurl", options: [{ label: "Leg curl demo", url: demo("machine leg curl") }] },
      { name: "Calf raise or abdominal work", sets: "2–3", reps: "controlled", rest: "60–90 sec", cue: "For calves, pause at the stretch and top. For abs, choose a movement you can progress without yanking the neck.", motion: "calf", options: [{ label: "Calf raise demo", url: "https://www.acefitness.org/resources/everyone/exercise-library/73/standing-calf-raises-wall/" }, { label: "Ab exercise library", url: "https://www.acefitness.org/resources/everyone/exercise-library/body-part/abs/" }] },
    ],
  },
};

const sequence: WorkoutKey[] = ["push", "pull", "legs"];
const weeks: WorkoutKey[][] = [
  ["push", "pull", "legs", "push", "pull"],
  ["legs", "push", "pull", "legs", "push"],
  ["pull", "legs", "push", "pull", "legs"],
];

function MovementSketch({ motion }: { motion: string }) {
  return (
    <div className="movement-sketch" data-motion={motion} aria-hidden="true">
      <span className="sketch-label">start</span>
      <span className="sketch-floor" />
      <span className="sketch-body"><i className="head" /><i className="torso" /><i className="limb a" /><i className="limb b" /></span>
      <span className="sketch-gear"><i /><i /></span>
      <span className="sketch-arrow">↗</span>
      <span className="sketch-end">finish</span>
    </div>
  );
}

function RollingTracker() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const saved = Number(localStorage.getItem("rolling-ppl-next") || 0);
    if (Number.isFinite(saved)) setIndex(((saved % 3) + 3) % 3);
  }, []);
  const update = (next: number) => {
    const normalized = ((next % 3) + 3) % 3;
    setIndex(normalized);
    localStorage.setItem("rolling-ppl-next", String(normalized));
  };
  const current = sequence[index];
  return (
    <aside className={`tracker ${current}`} aria-label="Rolling workout tracker">
      <p className="eyebrow">Your next session</p>
      <div className="tracker-main">
        <strong>{current}</strong>
        <span>Missed a day? Leave this here. The sequence waits for you.</span>
      </div>
      <div className="tracker-actions">
        <button className="primary-button" onClick={() => update(index + 1)}>Mark complete <span>→</span></button>
        <button className="text-button" onClick={() => update(index - 1)}>Undo last</button>
      </div>
    </aside>
  );
}

function Schedule() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  return (
    <section className="schedule section" id="schedule">
      <div className="section-heading">
        <p className="eyebrow">01 / The rolling map</p>
        <h2>Three weeks. One uninterrupted sequence.</h2>
        <p>Weekdays advance the Push → Pull → Legs rotation. Weekends recover. After Week 3, return to Week 1.</p>
      </div>
      <div className="schedule-grid" role="table" aria-label="Three-week rolling workout schedule">
        <div className="day-row header-row" role="row">
          <span aria-hidden="true">week</span>{days.map((day) => <span key={day} role="columnheader">{day}</span>)}
        </div>
        {weeks.map((week, weekIndex) => (
          <div className="day-row" role="row" key={weekIndex}>
            <span className="week-label">0{weekIndex + 1}</span>
            {week.map((day, dayIndex) => <a key={`${day}-${dayIndex}`} className={`day-chip ${day}`} href={`#${day}`} aria-label={`Week ${weekIndex + 1} ${days[dayIndex]}: ${day}`}>{day.slice(0, 1).toUpperCase()}</a>)}
          </div>
        ))}
      </div>
      <div className="weekend-note"><span>Sat + Sun</span><strong>Rest / recover</strong><p>No reset. Monday resumes wherever Friday left off.</p></div>
    </section>
  );
}

function WorkoutSection({ id }: { id: WorkoutKey }) {
  const workout = workouts[id];
  return (
    <section className={`workout-section ${id}`} id={id}>
      <header className="workout-heading">
        <div><p className="eyebrow">{id === "push" ? "02" : id === "pull" ? "03" : "04"} / Session card</p><h2>{id}</h2></div>
        <p>{workout.note}</p>
      </header>
      <ol className="exercise-list">
        {workout.exercises.map((exercise, index) => (
          <li className="exercise-card" key={exercise.name}>
            <div className="exercise-number">{String(index + 1).padStart(2, "0")}</div>
            <div className="exercise-copy">
              <h3>{exercise.name}</h3>
              <div className="prescription"><strong>{exercise.sets}</strong><span>sets</span><b>×</b><strong>{exercise.reps}</strong><span>reps</span></div>
              <p className="cue"><span>Cue</span>{exercise.cue}</p>
              <p className="rest"><span className="clock">◷</span> Rest {exercise.rest}</p>
              <div className="demo-links">
                {exercise.options.map((option) => <a href={option.url} target="_blank" rel="noreferrer" key={option.label}>{option.label}<span aria-hidden="true">↗</span></a>)}
              </div>
            </div>
            <MovementSketch motion={exercise.motion} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Rules() {
  return (
    <section className="rules section" id="rules">
      <div className="section-heading"><p className="eyebrow">05 / Run the plan</p><h2>Simple rules. Clean reps.</h2></div>
      <div className="rule-grid">
        <article className="progression-card">
          <p className="eyebrow">Double progression</p>
          <div className="rule-steps">
            <div><span>1</span><p>Start each work set with about <strong>2 clean reps in reserve.</strong></p></div>
            <div><span>2</span><p>Add reps inside the listed range while technique stays the same.</p></div>
            <div><span>3</span><p>Hit the top of the range on every work set, cleanly, <strong>twice.</strong></p></div>
            <div><span>4</span><p>Add the smallest available weight and build the reps again.</p></div>
          </div>
          <p className="hold-line">If reps collapse or technique changes, hold the load—or reduce it.</p>
        </article>
        <article className="guidance-card">
          <h3>Warm up without wasting work</h3>
          <p>Spend 5–8 minutes raising body temperature, then rehearse the first lift with progressively heavier, low-rep ramp-up sets. Ramp sets prepare you; they do not count as work sets.</p>
          <div className="warmup-example"><span>Example ramp</span><b>bar × 10</b><b>~50% × 5</b><b>~70% × 3</b><b>~85% × 1</b></div>
          <small>Use fewer steps for lighter movements; add a step when the working load is heavy.</small>
        </article>
        <article className="guidance-card rest-card">
          <h3>Rest enough to repeat quality</h3>
          <dl><div><dt>Big compound lifts</dt><dd>2–4 min</dd></div><div><dt>Squat + deadlift</dt><dd>3–5 min</dd></div><div><dt>Accessory work</dt><dd>60–120 sec</dd></div></dl>
          <p>Start the next set when breathing is controlled and you can brace with intent. The clock guides you; rep quality decides.</p>
        </article>
        <article className="safety-card">
          <p className="eyebrow">Non-negotiables</p>
          <h3>Train hard. Keep the exits open.</h3>
          <ul><li>Use safeties or a spotter for barbell bench and squat.</li><li>Do not normalize joint pain. Change the movement, range, or load.</li><li>Controlled reps and repeatable technique matter more than load.</li></ul>
        </article>
      </div>
    </section>
  );
}

function Why() {
  return (
    <section className="why section" id="why">
      <div><p className="eyebrow">Why this works</p><h2>Chest gets the spotlight. Everything else keeps moving.</h2></div>
      <div className="why-copy">
        <p>With five weekday sessions, Push appears five times every three weeks. That averages about <strong>15 direct chest sets per week</strong>—enough to make the priority unmistakable without turning every day into chest day.</p>
        <p>The rotation prevents a missed Monday from deleting a muscle group. You never reshuffle or “make up” sessions: perform the next card, then move on. That is the low-overhead advantage.</p>
      </div>
    </section>
  );
}

function App() {
  return (
    <>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Rolling PPL home"><span>R</span>Rolling PPL</a>
        <nav aria-label="Primary navigation"><a href="#schedule">Schedule</a><a href="#push">Push</a><a href="#pull">Pull</a><a href="#legs">Legs</a><a href="#rules">Rules</a></nav>
      </header>
      <main id="top">
        <section className="hero">
          <div className="hero-copy"><p className="eyebrow">Chest-priority / 5 weekdays / rolling sequence</p><h1>The next workout <em>wins.</em></h1><p className="hero-lede">Push. Pull. Legs. Keep the order, skip the guilt, and make chest the clear priority without living in the gym.</p><a className="jump-link" href="#schedule">See the 3-week map <span>↓</span></a></div>
          <div className="sequence-mark" aria-label="Push Pull Legs sequence"><span className="push">P<small>push</small></span><i>→</i><span className="pull">P<small>pull</small></span><i>→</i><span className="legs">L<small>legs</small></span></div>
        </section>
        <RollingTracker />
        <Schedule />
        <div className="workouts-wrap"><WorkoutSection id="push" /><WorkoutSection id="pull" /><WorkoutSection id="legs" /></div>
        <Rules />
        <Why />
      </main>
      <footer><div className="brand footer-brand"><span>R</span>Rolling PPL</div><p>Sequence over calendar. Quality over load.</p><p className="credits">Original movement diagrams. External technique references: <a href="https://www.acefitness.org/resources/everyone/exercise-library/" target="_blank" rel="noreferrer">ACE Exercise Library</a> and clearly labeled YouTube searches for ACE Fitness technique demonstrations. Linked media remains the property of its creators.</p></footer>
      <nav className="mobile-nav" aria-label="Quick jump"><a href="#schedule">Map</a><a href="#push">Push</a><a href="#pull">Pull</a><a href="#legs">Legs</a><a href="#rules">Rules</a></nav>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
