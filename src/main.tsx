import { Fragment, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type WorkoutKey = "push" | "pull" | "legs";
type Theme = "light" | "dark";
type Demo = { label: string; slug: string };
type Exercise = { name: string; sets: string; reps: string; rest: string; warmup: string; cue: string; priority: "must" | "optional"; demos: Demo[] };
type LightboxImage = { src: string; alt: string };
type SetEntry = { load: string; reps: string };
type SavedSession = { id: string; savedAt: string; sets: SetEntry[] };
type HistoryMap = Record<string, SavedSession[]>;
type DraftMap = Record<string, SetEntry[]>;
type SaveResult = { ok: boolean; message: string };
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const HISTORY_KEY = "rolling-ppl-history-v1";
const DRAFTS_KEY = "rolling-ppl-drafts-v1";
const THEME_KEY = "rolling-ppl-theme-v1";

function readStoredMap<T>(key: string): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as T;
  } catch {
    return {} as T;
  }
}

function storeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // The app remains usable if private browsing or storage policy blocks persistence.
  }
}

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
      { name: "Barbell bench press", sets: "4", reps: "5–8", rest: "2–4 min", warmup: "3–4 ramp sets", cue: "Set your upper back, plant your feet, and touch the same lower-chest point each rep.", priority: "must", demos: [{ label: "Bench press", slug: "bench" }] },
      { name: "Incline dumbbell bench press", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "1–2 ramp sets × 6–8", cue: "Use a modest incline. Lower with control and press up and slightly inward.", priority: "must", demos: [{ label: "Incline press", slug: "incline-press" }] },
      { name: "Lateral raise", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Lead with your elbows, stop near shoulder height, and keep momentum out of it.", priority: "must", demos: [{ label: "Lateral raise", slug: "lateral-raise" }] },
      { name: "Chest press machine", sets: "2", reps: "8–12", rest: "90–120 sec", warmup: "1 light ramp set × 8–10", cue: "Set the seat so the handles meet mid-chest. Keep your upper back planted and control the return.", priority: "optional", demos: [{ label: "Chest press machine", slug: "chest-press-machine" }] },
      { name: "Cable triceps pushdown", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Pin your upper arms, extend fully, then control the return.", priority: "optional", demos: [{ label: "Pushdown", slug: "pushdown" }] },
    ],
  },
  pull: {
    summary: "4 exercises · back + biceps",
    exercises: [
      { name: "Bent-over barbell row", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "2–3 ramp sets × 5–8", cue: "Brace before you pull, keep your torso angle steady, and drive your elbows toward your hips.", priority: "must", demos: [{ label: "Barbell row", slug: "barbell-row" }] },
      { name: "Lat pulldown or pull-ups", sets: "3", reps: "6–12", rest: "2–3 min", warmup: "1 light or assisted set × 8–10", cue: "Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.", priority: "must", demos: [{ label: "Lat pulldown", slug: "lat-pulldown" }, { label: "Pull-ups", slug: "pullups" }] },
      { name: "Rear-delt fly or face pull", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Use your rear delts and upper back. Keep your ribs down and avoid shrugging.", priority: "must", demos: [{ label: "Rear-delt fly", slug: "rear-delt-fly" }, { label: "Face pull", slug: "face-pull" }] },
      { name: "Barbell curl", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 10–12", cue: "Keep your upper arms quiet, curl without leaning back, and own the lowering phase.", priority: "optional", demos: [{ label: "Barbell curl", slug: "barbell-curl" }] },
    ],
  },
  legs: {
    summary: "5 exercises · squat + hinge",
    exercises: [
      { name: "Back squat", sets: "3", reps: "5–8", rest: "3–5 min", warmup: "3–4 ramp sets", cue: "Brace before descending, keep pressure through your whole foot, and use safeties just below depth.", priority: "must", demos: [{ label: "Back squat", slug: "back-squat" }] },
      { name: "Conventional deadlift", sets: "2", reps: "4–6", rest: "3–5 min", warmup: "2–3 ramp sets × 3–5", cue: "Wedge into the bar, push the floor away, and finish tall without leaning back.", priority: "must", demos: [{ label: "Deadlift", slug: "deadlift" }] },
      { name: "Leg curl", sets: "3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Keep your hips anchored, curl through your hamstrings, and lower without letting the stack crash.", priority: "must", demos: [{ label: "Leg curl", slug: "leg-curl" }] },
      { name: "Leg press or Bulgarian split squat", sets: "2–3", reps: "8–12", rest: "2–3 min", warmup: "1–2 light sets × 8", cue: "Choose the option you can control through a comfortable range. Keep your knee tracking over your foot.", priority: "optional", demos: [{ label: "Leg press", slug: "leg-press" }, { label: "Split squat", slug: "split-squat" }] },
      { name: "Calf raise or abdominal work", sets: "2–3", reps: "controlled", rest: "60–90 sec", warmup: "1 easy set × 12–15", cue: "For calves, pause at the stretch and top. For abs, choose a movement you can progress cleanly.", priority: "optional", demos: [{ label: "Calf raise", slug: "calf-raise" }, { label: "Ab work", slug: "abs" }] },
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
    <article className={`exercise-row ${exercise.priority}`}>
      <div className={`demo-grid ${exercise.demos.length > 1 ? "has-options" : ""}`}>
        {exercise.demos.map((demo) => <DemoStrip key={demo.slug} demo={demo} exercise={exercise.name} onOpen={onOpen} />)}
      </div>
      <div className="exercise-info">
        <div className="exercise-title"><span>{index + 1}</span><h3>{exercise.name}</h3><strong className={`priority-badge ${exercise.priority}`}>{exercise.priority === "must" ? "Must do" : "If time"}</strong></div>
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
  const mustDoCount = data.exercises.filter((exercise) => exercise.priority === "must").length;
  const optionalCount = data.exercises.length - mustDoCount;
  return (
    <section className={`workout ${workout}`} aria-labelledby={`${workout}-title`}>
      <header className="workout-header"><div><h2 id={`${workout}-title`}>{workout}</h2><p>{data.summary}</p></div><span>{mustDoCount} must · {optionalCount} if time</span></header>
      <p className="short-session"><strong>Minimum version:</strong> complete the three Must do cards. Extra time? Continue down the If time list in order.</p>
      <div className="exercise-list">
        {data.exercises.map((exercise, index) => (
          <Fragment key={exercise.name}>
            {index === mustDoCount && <div className="optional-divider"><span>If time</span><p>Useful additions, already ranked. Stop whenever you need to.</p></div>}
            <ExerciseRow exercise={exercise} index={index} onOpen={onOpen} history={history[exercise.name] ?? []} draft={drafts[exercise.name] ?? []} onDraftChange={(entries) => onDraftChange(exercise.name, entries)} onSave={onSave} />
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function Notes() {
  return (
    <section className="notes" aria-labelledby="notes-title">
      <h2 id="notes-title">Rules you may need</h2>
      <details><summary>What if I am short on time?</summary><p>Do the three exercises marked Must do. If time remains, continue through the If time exercises in order. Skipped accessories do not need to be made up later.</p></details>
      <details><summary>How to progress</summary><p>Add reps within the range while keeping about two clean reps in reserve. When every work set reaches the top of the range cleanly twice, add the smallest available weight. Hold or reduce the load if reps collapse or technique changes.</p></details>
      <details><summary>How to warm up</summary><p>Spend 5–8 minutes raising body temperature. Then use progressively heavier, low-rep ramp sets before the first big lift—for example: bar × 10, about 50% × 5, 70% × 3, 85% × 1. Ramp sets do not count as work sets.</p></details>
      <details><summary>Why no shoulder press?</summary><p>That is intentional. Bench press and incline press already train the front delts, while lateral raises directly cover the side delts. Leaving out another heavy press keeps shoulder and triceps fatigue lower so chest performance stays the priority. Add a shoulder press only if overhead strength matters enough to accept a longer Push day.</p></details>
      <details><summary>Why four bench sets?</summary><p>Push appears five times every three weeks, or about 1.67 times per week. Four bench sets therefore average about 6–7 weekly bench sets; together with incline and optional machine pressing, the plan ranges from roughly 12 to 15 direct chest sets per week.</p></details>
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
    <div className="lightbox">
      <div className="lightbox-dialog" role="dialog" aria-modal="true" aria-label={image.alt}>
        <button className="lightbox-close" type="button" onClick={onClose} aria-label="Close enlarged image">Close <span aria-hidden="true">×</span></button>
        <img className="lightbox-image" src={image.src} alt={image.alt} />
        <p>{image.alt}</p>
      </div>
    </div>
  );
}

function App() {
  const [active, setActive] = useState<WorkoutKey>("push");
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [history, setHistory] = useState<HistoryMap>(() => readStoredMap<HistoryMap>(HISTORY_KEY));
  const [drafts, setDrafts] = useState<DraftMap>(() => readStoredMap<DraftMap>(DRAFTS_KEY));
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* Use the system theme. */ }
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    storeLocal(HISTORY_KEY, history);
  }, [history]);

  useEffect(() => {
    storeLocal(DRAFTS_KEY, drafts);
  }, [drafts]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#171d24" : "#f2f4f6");
    storeLocal(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

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
        <div className="header-actions"><a href="#schedule">Schedule</a>{installPrompt && <button className="install-button" type="button" onClick={installApp}>Install</button>}<button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span></button></div>
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}
