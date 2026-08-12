import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type WorkoutKey = "push" | "pull" | "legs";
type Theme = "light" | "dark";
type Demo = { label: string; slug: string };
type Exercise = { name: string; sets: string; reps: string; rest: string; warmup: string; cue: string; demos: Demo[] };
type LightboxImage = { src: string; alt: string };
type SetEntry = { load: string; reps: string };
type SavedSession = { id: string; savedAt: string; sets: SetEntry[] };
type HistoryMap = Record<string, SavedSession[]>;
type DraftMap = Record<string, SetEntry[]>;
type SaveResult = { ok: boolean; message: string };

const HISTORY_KEY = "rolling-ppl-history-v1";
const DRAFTS_KEY = "rolling-ppl-drafts-v1";
const THEME_KEY = "rolling-ppl-theme-v1";

function setRange(value: string) {
  const values = value.match(/\d+/g)?.map(Number) ?? [1];
  return { min: values[0], max: values.at(-1) ?? values[0] };
}

function repRange(value: string) {
  const values = value.match(/\d+/g)?.map(Number) ?? [];
  return values.length >= 2 ? { min: values[0], max: values[1] } : null;
}

function isTopSession(exercise: Exercise, session?: SavedSession) {
  const range = repRange(exercise.reps);
  if (!range || !session?.sets.length) return false;
  return session.sets.every((entry) => Number(entry.reps) >= range.max);
}

function loadSignature(session?: SavedSession) {
  return session?.sets.map((entry) => entry.load.trim().toLowerCase() || "bw").join("|") ?? "";
}

function nextStep(exercise: Exercise, sessions: SavedSession[]) {
  const latest = sessions[0];
  const range = repRange(exercise.reps);
  if (!latest) return "Log this session to get your next target.";
  if (!range) return "Add reps or difficulty after two fully controlled sessions.";
  const reps = latest.sets.map((entry) => Number(entry.reps));
  if (reps.some((value) => !Number.isFinite(value) || value < range.min)) return "Hold or reduce the load until every set is back in range.";
  if (!isTopSession(exercise, latest)) return "Add reps within the range next time.";
  const previous = sessions[1];
  if (isTopSession(exercise, previous) && loadSignature(latest) === loadSignature(previous)) return "Add the smallest available weight next time.";
  return "Repeat the top-end reps once more, then add weight.";
}

function formatSession(session: SavedSession) {
  return session.sets.map((entry) => `${entry.load.trim() || "BW"} × ${entry.reps}`).join(" · ");
}

const workouts: Record<WorkoutKey, { summary: string; exercises: Exercise[] }> = {
  push: {
    summary: "5 exercises · chest priority",
    exercises: [
      { name: "Barbell bench press", sets: "4", reps: "5–8", rest: "2–4 min", warmup: "3–4 ramp sets", cue: "Set your upper back, plant your feet, and touch the same lower-chest point each rep.", demos: [{ label: "Bench press", slug: "bench" }] },
      { name: "Incline dumbbell bench press", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "1–2 ramp sets × 6–8", cue: "Use a modest incline. Lower with control and press up and slightly inward.", demos: [{ label: "Incline press", slug: "incline-press" }] },
      { name: "Cable fly", sets: "2", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Keep a soft elbow and bring your upper arms across your chest without turning it into a press.", demos: [{ label: "Cable fly", slug: "cable-fly" }] },
      { name: "Lateral raise", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Lead with your elbows, stop near shoulder height, and keep momentum out of it.", demos: [{ label: "Lateral raise", slug: "lateral-raise" }] },
      { name: "Cable triceps pushdown", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Pin your upper arms, extend fully, then control the return.", demos: [{ label: "Pushdown", slug: "pushdown" }] },
    ],
  },
  pull: {
    summary: "4 exercises · back + biceps",
    exercises: [
      { name: "Bent-over barbell row", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "2–3 ramp sets × 5–8", cue: "Brace before you pull, keep your torso angle steady, and drive your elbows toward your hips.", demos: [{ label: "Barbell row", slug: "barbell-row" }] },
      { name: "Lat pulldown or pull-ups", sets: "3", reps: "6–12", rest: "2–3 min", warmup: "1 light or assisted set × 8–10", cue: "Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.", demos: [{ label: "Lat pulldown", slug: "lat-pulldown" }, { label: "Pull-ups", slug: "pullups" }] },
      { name: "Rear-delt fly or face pull", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Use your rear delts and upper back. Keep your ribs down and avoid shrugging.", demos: [{ label: "Rear-delt fly", slug: "rear-delt-fly" }, { label: "Face pull", slug: "face-pull" }] },
      { name: "Barbell curl", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 10–12", cue: "Keep your upper arms quiet, curl without leaning back, and own the lowering phase.", demos: [{ label: "Barbell curl", slug: "barbell-curl" }] },
    ],
  },
  legs: {
    summary: "5 exercises · squat + hinge",
    exercises: [
      { name: "Back squat", sets: "3", reps: "5–8", rest: "3–5 min", warmup: "3–4 ramp sets", cue: "Brace before descending, keep pressure through your whole foot, and use safeties just below depth.", demos: [{ label: "Back squat", slug: "back-squat" }] },
      { name: "Conventional deadlift", sets: "2", reps: "4–6", rest: "3–5 min", warmup: "2–3 ramp sets × 3–5", cue: "Wedge into the bar, push the floor away, and finish tall without leaning back.", demos: [{ label: "Deadlift", slug: "deadlift" }] },
      { name: "Leg press or Bulgarian split squat", sets: "2–3", reps: "8–12", rest: "2–3 min", warmup: "1–2 light sets × 8", cue: "Choose the option you can control through a comfortable range. Keep your knee tracking over your foot.", demos: [{ label: "Leg press", slug: "leg-press" }, { label: "Split squat", slug: "split-squat" }] },
      { name: "Leg curl", sets: "3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Keep your hips anchored, curl through your hamstrings, and lower without letting the stack crash.", demos: [{ label: "Leg curl", slug: "leg-curl" }] },
      { name: "Calf raise or abdominal work", sets: "2–3", reps: "controlled", rest: "60–90 sec", warmup: "1 easy set × 12–15", cue: "For calves, pause at the stretch and top. For abs, choose a movement you can progress cleanly.", demos: [{ label: "Calf raise", slug: "calf-raise" }, { label: "Ab work", slug: "abs" }] },
    ],
  },
};

const weeks: WorkoutKey[][] = [
  ["push", "pull", "legs", "push", "pull"],
  ["legs", "push", "pull", "legs", "push"],
  ["pull", "legs", "push", "pull", "legs"],
];

function DemoStrip({ demo, exercise, onOpen }: { demo: Demo; exercise: string; onOpen: (image: LightboxImage) => void }) {
  const poses = [
    { src: `./exercises/${demo.slug}-0.jpg`, alt: `${demo.label}: first position` },
    { src: `./exercises/${demo.slug}-1.jpg`, alt: `${demo.label}: second position` },
  ];
  return (
    <figure className="demo-strip">
      <div className="poses">
        <button className="image-button" type="button" onClick={() => onOpen(poses[0])} aria-label={`Enlarge ${poses[0].alt}`}>
          <img src={poses[0].src} alt={poses[0].alt} loading="lazy" />
        </button>
        <span aria-hidden="true">→</span>
        <button className="image-button" type="button" onClick={() => onOpen(poses[1])} aria-label={`Enlarge ${poses[1].alt}`}>
          <img src={poses[1].src} alt={poses[1].alt} loading="lazy" />
        </button>
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

function ExerciseRow({ exercise, index, onOpen, history, draft, onDraftChange, onSave }: {
  exercise: Exercise;
  index: number;
  onOpen: (image: LightboxImage) => void;
  history: SavedSession[];
  draft: SetEntry[];
  onDraftChange: (entries: SetEntry[]) => void;
  onSave: (exercise: Exercise, entries: SetEntry[]) => SaveResult;
}) {
  const [message, setMessage] = useState("");
  const range = setRange(exercise.sets);
  const entries = Array.from({ length: range.max }, (_, setIndex) => draft[setIndex] ?? { load: "", reps: "" });
  const previous = history[0];
  const updateEntry = (setIndex: number, field: keyof SetEntry, value: string) => {
    const next = entries.map((entry, entryIndex) => entryIndex === setIndex ? { ...entry, [field]: value } : entry);
    onDraftChange(next);
    setMessage("");
  };
  const save = () => {
    const result = onSave(exercise, entries);
    setMessage(result.message);
  };
  return (
    <article className="exercise-row">
      <div className={`demo-grid ${exercise.demos.length > 1 ? "has-options" : ""}`}>
        {exercise.demos.map((demo) => <DemoStrip key={demo.slug} demo={demo} exercise={exercise.name} onOpen={onOpen} />)}
      </div>
      <div className="exercise-info">
        <div className="exercise-title"><span>{index + 1}</span><h3>{exercise.name}</h3></div>
        <div className="prescription"><strong>{exercise.sets}</strong><small>sets</small><i>×</i><strong>{exercise.reps}</strong><small>reps</small></div>
        <p className="cue">{exercise.cue}</p>
        <div className="exercise-meta"><span>Optional warm-up: {exercise.warmup}</span><span>Rest: {exercise.rest}</span><span>Start around 2 RIR</span></div>
        <section className="set-tracker" aria-label={`Progressive overload log for ${exercise.name}`}>
          <div className="tracker-heading">
            <div><h4>Log work sets</h4><p>Warm-up sets stay separate.</p></div>
            {previous && <div className="previous-session"><span>Previous</span><strong>{formatSession(previous)}</strong></div>}
          </div>
          <div className="set-entries">
            {entries.map((entry, setIndex) => (
              <div className="set-entry" key={setIndex}>
                <div className="set-number">Set {setIndex + 1}{setIndex >= range.min && <small>optional</small>}</div>
                <label><span>Load</span><input value={entry.load} onChange={(event) => updateEntry(setIndex, "load", event.target.value)} inputMode="decimal" maxLength={12} placeholder="kg / BW" aria-label={`${exercise.name} set ${setIndex + 1} load`} /></label>
                <label><span>Reps</span><input value={entry.reps} onChange={(event) => updateEntry(setIndex, "reps", event.target.value)} type="number" inputMode="numeric" min="0" max="99" placeholder="0" aria-label={`${exercise.name} set ${setIndex + 1} reps`} /></label>
              </div>
            ))}
          </div>
          <div className="next-step"><span>Next target</span><strong>{nextStep(exercise, history)}</strong></div>
          <div className="tracker-actions"><button type="button" onClick={save}>Save exercise</button><p className={message.startsWith("Saved") ? "save-message success" : "save-message"} aria-live="polite">{message}</p></div>
          {history.length > 0 && <details className="history"><summary>History ({history.length})</summary><ol>{history.slice(0, 5).map((session) => <li key={session.id}><time dateTime={session.savedAt}>{new Date(session.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span>{formatSession(session)}</span></li>)}</ol></details>}
        </section>
      </div>
    </article>
  );
}

function Workout({ workout, onOpen, history, drafts, onDraftChange, onSave }: {
  workout: WorkoutKey;
  onOpen: (image: LightboxImage) => void;
  history: HistoryMap;
  drafts: DraftMap;
  onDraftChange: (exerciseName: string, entries: SetEntry[]) => void;
  onSave: (exercise: Exercise, entries: SetEntry[]) => SaveResult;
}) {
  const data = workouts[workout];
  return (
    <section className={`workout ${workout}`} aria-labelledby={`${workout}-title`}>
      <header className="workout-header"><div><h2 id={`${workout}-title`}>{workout}</h2><p>{data.summary}</p></div><span>{data.exercises.length} movements</span></header>
      <div className="exercise-list">{data.exercises.map((exercise, index) => <ExerciseRow exercise={exercise} index={index} key={exercise.name} onOpen={onOpen} history={history[exercise.name] ?? []} draft={drafts[exercise.name] ?? []} onDraftChange={(entries) => onDraftChange(exercise.name, entries)} onSave={onSave} />)}</div>
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

function Lightbox({ image, onClose }: { image: LightboxImage | null; onClose: () => void }) {
  useEffect(() => {
    if (!image) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [image, onClose]);

  if (!image) return null;
  return (
    <div className="lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="lightbox-dialog" role="dialog" aria-modal="true" aria-label={image.alt}>
        <button className="lightbox-close" type="button" onClick={onClose} autoFocus aria-label="Close enlarged image">Close <span aria-hidden="true">×</span></button>
        <img className="lightbox-image" src={image.src} alt={image.alt} />
        <p>{image.alt}</p>
      </div>
    </div>
  );
}

function App() {
  const [active, setActive] = useState<WorkoutKey>("push");
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [history, setHistory] = useState<HistoryMap>({});
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [storageReady, setStorageReady] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    try {
      setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}"));
      setDrafts(JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}"));
    } catch {
      setHistory({});
      setDrafts({});
    }
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (storageReady) localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history, storageReady]);

  useEffect(() => {
    if (storageReady) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  }, [drafts, storageReady]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const updateDraft = (exerciseName: string, entries: SetEntry[]) => {
    setDrafts((current) => ({ ...current, [exerciseName]: entries }));
  };

  const saveExercise = (exercise: Exercise, entries: SetEntry[]): SaveResult => {
    const range = setRange(exercise.sets);
    const selected = entries.slice(0, range.max).filter((entry, index) => index < range.min || entry.load.trim() || entry.reps.trim());
    if (selected.slice(0, range.min).some((entry) => !entry.reps.trim())) return { ok: false, message: `Add reps for the ${range.min} required work sets.` };
    if (selected.some((entry) => !entry.reps.trim() || Number(entry.reps) <= 0)) return { ok: false, message: "Add valid reps or clear the optional set." };
    const now = new Date();
    const session: SavedSession = { id: `${now.getTime()}-${exercise.name}`, savedAt: now.toISOString(), sets: selected.map((entry) => ({ load: entry.load.trim(), reps: entry.reps.trim() })) };
    setHistory((current) => {
      const existing = current[exercise.name] ?? [];
      const savedToday = existing[0] && new Date(existing[0].savedAt).toDateString() === now.toDateString();
      const nextSessions = savedToday ? [{ ...session, id: existing[0].id }, ...existing.slice(1)] : [session, ...existing];
      return { ...current, [exercise.name]: nextSessions.slice(0, 20) };
    });
    return { ok: true, message: "Saved today's work sets." };
  };
  return (
    <>
      <header className="app-header">
        <div><h1>Rolling PPL</h1><p>Chest-prioritized · five weekdays</p></div>
        <div className="header-actions"><a href="#schedule">Schedule</a><button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span></button></div>
      </header>
      <main>
        <Schedule />
        <div className="workout-tabs" role="tablist" aria-label="Choose a workout">
          {(["push", "pull", "legs"] as WorkoutKey[]).map((key) => <button key={key} role="tab" aria-selected={active === key} className={active === key ? `active ${key}` : ""} onClick={() => setActive(key)}>{key}<small>{workouts[key].exercises.length} exercises</small></button>)}
        </div>
        <p className="storage-note">Workout entries and history are saved only on this device.</p>
        <Workout workout={active} onOpen={setLightbox} history={history} drafts={drafts} onDraftChange={updateDraft} onSave={saveExercise} />
        <Notes />
      </main>
      <footer><p><strong>Rolling PPL</strong> · Keep the sequence; skip the weekly reset.</p><p>Exercise imagery from the public-domain <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer">Free Exercise DB</a> (Unlicense). Images are shown in grayscale for consistency.</p></footer>
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
