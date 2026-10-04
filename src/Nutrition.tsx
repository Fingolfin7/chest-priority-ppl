import { useEffect, useMemo, useState, type FormEvent } from "react";
import { combineWeightReadings, localDay, type BodyProgressData } from "./bodyProgressModel";
import type { CompletedWorkout } from "./sessionModel";
import {
  MAX_SUPPLEMENTS, NUTRITION_COUNTERS, SUGGESTED_SUPPLEMENTS, changeCount, intakeByTrend, isLogged, nutritionDay, nutritionSummary,
  saveSupplements, shiftDay, toggleSupplement, weeklyIntake, type NutritionCounter, type NutritionData, type Supplement,
} from "./nutritionModel";
import "./nutrition.css";

type Update = (edit: (previous: NutritionData | undefined) => NutritionData) => void;
const counters: Record<NutritionCounter, { label: string; one: string; hint: string }> = {
  meals: { label: "Meals", one: "meal", hint: "On a plate or in a bowl" },
  snacks: { label: "Snacks", one: "snack", hint: "Eaten from your hand" },
  shakes: { label: "Shakes", one: "shake", hint: "Protein shakes" },
};
const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const weekday = (date: string, style: "short" | "narrow" = "short") => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: style });
const dayTitle = (date: string, today: string) => date === today ? "Today" : date === shiftDay(today, -1) ? "Yesterday" : `${weekday(date)} ${shortDate(date)}`;
const one = (value: number | null) => value === null ? "–" : value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const kg = (value: number | null) => value === null ? "–" : `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`;
const counted = (count: number, key: NutritionCounter) => `${count} ${count === 1 ? counters[key].one : counters[key].label.toLowerCase()}`;
const newId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `supplement-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function SupplementEditor({ supplements, onSave, onClose }: { supplements: Supplement[]; onSave: (next: Supplement[]) => string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const save = (next: Supplement[]) => { const problem = onSave(next); setError(problem); return !problem; };
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const existing = supplements.find((item) => item.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) { setError(`${existing.name} is already on your list.`); return; }
    if (save([...supplements, { id: newId(), name: trimmed }])) setName("");
  };
  const submit = (event: FormEvent) => { event.preventDefault(); add(name); };
  const suggestions = SUGGESTED_SUPPLEMENTS.filter((item) => !supplements.some((saved) => saved.name.toLowerCase() === item.toLowerCase()));
  return <div className="supplement-editor">
    {supplements.length > 0 && <ul>{supplements.map((item) => <li key={item.id}><span>{item.name}</span><button type="button" className="text-action" onClick={() => save(supplements.filter((saved) => saved.id !== item.id))}>Remove</button></li>)}</ul>}
    {suggestions.length > 0 && supplements.length < MAX_SUPPLEMENTS && <div className="supplement-suggestions" aria-label="Suggested supplements">{suggestions.map((item) => <button type="button" key={item} onClick={() => add(item)}>+ {item}</button>)}</div>}
    <form onSubmit={submit}><label>Add your own<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="e.g. Electrolytes" /></label><button className="secondary-action" type="submit" disabled={!name.trim() || supplements.length >= MAX_SUPPLEMENTS}>Add</button></form>
    {error && <p className="nutrition-error" role="alert">{error}</p>}
    <button className="text-action" type="button" onClick={onClose}>Done</button>
  </div>;
}

function FoodAndWeight({ nutrition, readings, today }: { nutrition: NutritionData | undefined; readings: Array<{ date: string; value: number }>; today: string }) {
  const weeks = useMemo(() => weeklyIntake(nutrition, readings, today), [nutrition, readings, today]);
  const groups = intakeByTrend(weeks);
  const shown = weeks.filter((week) => week.loggedDays || week.weight !== null);
  const trendLabel = { gaining: "Weeks you gained", steady: "Weeks you held steady", losing: "Weeks you lost" };
  return <section className="nutrition-panel food-weight" aria-labelledby="food-weight-title">
    <div className="nutrition-panel-heading"><h3 id="food-weight-title">Food and weight</h3><span>Rolling 7-day weeks</span></div>
    {groups.length > 0
      ? <div className="intake-trends">{groups.map((group) => <article key={group.trend} data-trend={group.trend}><span>{trendLabel[group.trend]}</span><strong>{one(group.meals)} meals · {one(group.snacks)} snacks · {one(group.shakes)} shakes</strong><p>a day, across {group.weeks} weeks</p></article>)}</div>
      : <p className="nutrition-hint">Once there are two comparable weeks, this shows what a typical day looked like in weeks you gained, held steady or lost. A week counts when it has at least 4 logged days and 3 weigh-ins, plus 3 weigh-ins the week before.</p>}
    {shown.length > 0 && <div className="food-weight-table" role="table" aria-label="Weekly food and weight">
      <div role="row" className="food-weight-row head"><span role="columnheader">Week</span><span role="columnheader">Logged</span><span role="columnheader">Meals</span><span role="columnheader">Snacks</span><span role="columnheader">Shakes</span><span role="columnheader">Weight</span></div>
      {shown.map((week) => <div role="row" className="food-weight-row" key={week.end} data-trend={week.trend ?? undefined}>
        <span role="cell">{shortDate(week.start)} – {shortDate(week.end)}</span><span role="cell">{week.loggedDays}/7</span>
        <span role="cell">{one(week.meals)}</span><span role="cell">{one(week.snacks)}</span><span role="cell">{one(week.shakes)}</span>
        <span role="cell">{week.change !== null ? kg(week.change) : week.weight !== null ? "First week" : "–"}</span>
      </div>)}
    </div>}
    <p className="nutrition-footnote">Averages use logged days only. Weight change compares each week&apos;s average with the week before; within ±0.2 kg counts as steady.</p>
  </section>;
}

export function Nutrition({ nutrition, sessions, body, onChange }: { nutrition: NutritionData | undefined; sessions: CompletedWorkout[]; body: BodyProgressData | undefined; onChange: Update }) {
  const [today, setToday] = useState(localDay);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  // The app can stay open overnight; move "today" forward when it returns.
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setToday(localDay()); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  const date = selected && selected < today ? selected : today;
  const day = nutritionDay(nutrition, date);
  const supplements = nutrition?.settings.supplements ?? [];
  const readings = useMemo(() => combineWeightReadings(sessions, body?.weighIns ?? []), [sessions, body?.weighIns]);
  const summary = nutritionSummary(nutrition, today);
  const recent = Array.from({ length: 7 }, (_, index) => shiftDay(today, index - 6));
  const update = (edit: (previous: NutritionData | undefined) => NutritionData) => {
    try { onChange(edit); setError(""); return ""; } catch (reason) { const message = reason instanceof Error ? reason.message : "Food log could not be saved."; setError(message); return message; }
  };
  const goTo = (next: string) => setSelected(next >= today ? null : next);
  return <section className="nutrition" aria-labelledby="nutrition-title">
    <div className="section-heading"><div><h2 id="nutrition-title">Food</h2></div></div>
    <div className="nutrition-day-nav">
      <button type="button" aria-label="Previous day" onClick={() => goTo(shiftDay(date, -1))}>‹</button>
      <div><strong>{dayTitle(date, today)}</strong><span>{isLogged(day) ? "Logged" : "Nothing logged yet"}</span></div>
      <button type="button" aria-label="Next day" disabled={date >= today} onClick={() => goTo(shiftDay(date, 1))}>›</button>
    </div>
    <div className="nutrition-counters">{NUTRITION_COUNTERS.map((key) => {
      const count = day?.[key] ?? 0;
      return <article className="nutrition-counter" key={key} data-counter={key}>
        <div><h3>{counters[key].label}</h3><p>{counters[key].hint}</p></div>
        <strong aria-live="polite" aria-label={counted(count, key)}>{count}</strong>
        <div className="nutrition-counter-actions">
          <button type="button" className="counter-minus" aria-label={`Remove a ${counters[key].one}`} disabled={count === 0} onClick={() => update((previous) => changeCount(previous, date, key, -1))}>−</button>
          <button type="button" className="counter-plus" aria-label={`Add a ${counters[key].one}`} onClick={() => update((previous) => changeCount(previous, date, key, 1))}>+</button>
        </div>
      </article>;
    })}</div>
    <details className="nutrition-rules"><summary>What counts as a meal or a snack?</summary>
      <p><b>Plate or bowl = meal. In your hand = snack.</b> A banana or an oats bar at work is a snack. Two bars and a yoghurt can be two snacks or one meal; pick one and stay consistent. Being consistent matters more than being exact.</p>
      <p>Forgot to tap? Fill in the day later, or go back to a previous day with the arrows.</p>
    </details>
    {error && <p className="nutrition-error" role="alert">{error}</p>}
    <section className="nutrition-panel" aria-labelledby="supplements-title">
      <div className="nutrition-panel-heading"><h3 id="supplements-title">Supplements</h3>{!editing && <button className="text-action" type="button" onClick={() => setEditing(true)}>{supplements.length ? "Edit list" : "Set up"}</button>}</div>
      {editing ? <SupplementEditor supplements={supplements} onSave={(next) => update((previous) => saveSupplements(previous, next))} onClose={() => setEditing(false)} />
        : supplements.length ? <div className="supplement-checklist">{supplements.map((item) => {
          const taken = day?.supplements.includes(item.id) ?? false;
          return <button type="button" key={item.id} aria-pressed={taken} onClick={() => update((previous) => toggleSupplement(previous, date, item.id))}><span aria-hidden="true">{taken ? "✓" : ""}</span>{item.name}</button>;
        })}</div>
          : <p className="nutrition-hint">Add the supplements you take once, then tick them off each day.</p>}
    </section>
    <section className="nutrition-panel" aria-labelledby="nutrition-week-title">
      <div className="nutrition-panel-heading"><h3 id="nutrition-week-title">Last 7 days</h3><span>{summary.loggedDays} of 7 days logged</span></div>
      <div className="nutrition-week">{recent.map((item) => {
        const entry = nutritionDay(nutrition, item);
        return <button type="button" key={item} aria-current={item === date ? "date" : undefined} aria-label={`${dayTitle(item, today)}: ${isLogged(entry) ? NUTRITION_COUNTERS.map((key) => counted(entry[key], key)).join(", ") : "not logged"}`} onClick={() => goTo(item)} data-logged={isLogged(entry)}>
          <span>{weekday(item, "narrow")}</span>
          <strong>{isLogged(entry) ? entry.meals : "–"}</strong>
          <small aria-hidden="true">{isLogged(entry) ? `${entry.snacks} · ${entry.shakes}` : ""}</small>
        </button>;
      })}</div>
      <p className="nutrition-week-legend" aria-hidden="true">Meals, with snacks · shakes below</p>
      {summary.loggedDays > 0 && <p className="nutrition-averages">On logged days: <b>{one(summary.meals)}</b> meals, <b>{one(summary.snacks)}</b> snacks, <b>{one(summary.shakes)}</b> shakes{summary.supplementRate !== null && <>, <b>{Math.round(summary.supplementRate * 100)}%</b> of supplements</>}.</p>}
    </section>
    <FoodAndWeight nutrition={nutrition} readings={readings} today={today} />
  </section>;
}
