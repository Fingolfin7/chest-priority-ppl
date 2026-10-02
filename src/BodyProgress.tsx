import { useEffect, useMemo, useRef, useState } from "react";
import type { CompletedWorkout } from "./sessionModel";
import { TrendChart } from "./TrendChart";
import {
  BODY_PROGRESS_EVENT, MEASUREMENT_KEYS, combineWeightReadings, emptyBodyProgress,
  exportBodyProgress, localDay, parseBodyNumber, parseBodyProgress, saveBodyProgress, recentWeightAverages,
  type BodyMeasurement, type BodyProgressData, type MeasurementKey, type WeighIn,
} from "./bodyProgressModel";
import type { TrainingPhase } from './planModel';
import type { HistoryMap } from './historyMigration';
import { GoalOverview, ProgressContext } from './ProgressOverview';
import { ProgressOutlook } from './ProgressOutlook';
import "./bodyProgress.css";

const labels: Record<MeasurementKey, string> = { chest: "Chest", waist: "Waist", arms: "Arms", thighs: "Thighs" };
const displayDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const failure = (error: unknown) => error instanceof Error ? error.message : "Body progress could not be saved. Try again.";
type MeasurementForm = { date: string; note: string } & Record<MeasurementKey, string>;
const blankMeasurement = (): MeasurementForm => ({ date: localDay(), chest: "", waist: "", arms: "", thighs: "", note: "" });

function MeasurementTrend({ records, metric }: { records: BodyMeasurement[]; metric: MeasurementKey }) {
  const points = records.filter((record) => record[metric] !== undefined).sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
  return <TrendChart series={points.length ? [{ exercise: labels[metric], points: points.map((record) => ({date:record.date,value:record[metric]!})) }] : []} unit="cm" emptyTitle={`No ${labels[metric].toLowerCase()} measurements yet`} emptyHint="Add a tape reading to start this trend." label={`${labels[metric]} measurement trend`} />;
}

export function BodyProgress({ sessions, history, phase, phases, onPhotos, onPlan }: { sessions: CompletedWorkout[]; history: HistoryMap; phase?: TrainingPhase; phases?: TrainingPhase[]; onPhotos?: () => void; onPlan?: () => void }) {
  const [data, setData] = useState<BodyProgressData>(emptyBodyProgress);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [weightOpen, setWeightOpen] = useState(false);
  const [measureOpen, setMeasureOpen] = useState(false);
  const [weightId, setWeightId] = useState<string | null>(null);
  const [measureId, setMeasureId] = useState<string | null>(null);
  const [weightForm, setWeightForm] = useState({ date: localDay(), kg: "", note: "" });
  const [measureForm, setMeasureForm] = useState<MeasurementForm>(blankMeasurement);
  const [metric, setMetric] = useState<MeasurementKey>("chest");
  const [range, setRange] = useState("all");
  const [today] = useState(localDay);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const weightField = useRef<HTMLInputElement>(null);
  const measureField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (weightOpen) { weightField.current?.focus({preventScroll:true}); weightField.current?.closest('form')?.scrollIntoView({block:'nearest'}); } }, [weightOpen]);
  useEffect(() => { if (measureOpen) { measureField.current?.focus({preventScroll:true}); measureField.current?.closest('form')?.scrollIntoView({block:'nearest'}); } }, [measureOpen]);
  useEffect(() => {
    let active = true;
    const refresh = () => { void exportBodyProgress().then((next) => {
      if (!active) return;
      setData(next); setReady(true); setError("");
    }).catch((reason) => { if (active) setError(failure(reason)); }); };
    refresh(); window.addEventListener(BODY_PROGRESS_EVENT, refresh);
    return () => { active = false; window.removeEventListener(BODY_PROGRESS_EVENT, refresh); };
  }, []);
  const readings = useMemo(() => combineWeightReadings(sessions, data.weighIns), [sessions, data.weighIns]);
  const earliest = range === "all" ? "" : new Date(Date.parse(`${today}T12:00:00Z`) - (Number(range) - 1) * 86_400_000).toISOString().slice(0, 10);
  const shownWeights = readings.filter((reading) => reading.date >= earliest);
  const shownMeasurements = data.measurements.filter((reading) => reading.date >= earliest);
  const averages = recentWeightAverages(readings, today);
  async function persist(next: BodyProgressData, success: string): Promise<boolean> {
    setBusy(true); setError(""); setMessage("");
    try { const valid = parseBodyProgress(next); await saveBodyProgress(valid); setData(await exportBodyProgress()); setMessage(success); return true; }
    catch (reason) { setError(failure(reason)); return false; }
    finally { setBusy(false); }
  }
  async function saveWeight(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const record: WeighIn = { ...weightForm, kg: parseBodyNumber(weightForm.kg), id: weightId ?? crypto.randomUUID(), updatedAt: new Date().toISOString() };
    if (await persist({ ...data, weighIns: [...data.weighIns.filter((entry) => entry.id !== record.id), record] }, "Weigh-in saved on this device.")) {
      setWeightId(null); setWeightForm({ date: localDay(), kg: "", note: "" }); setWeightOpen(false);
    }
  }
  async function saveMeasurement(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const record: BodyMeasurement = { id: measureId ?? crypto.randomUUID(), date: measureForm.date, note: measureForm.note, updatedAt: new Date().toISOString() };
    for (const key of MEASUREMENT_KEYS) if (measureForm[key].trim()) record[key] = parseBodyNumber(measureForm[key]);
    if (await persist({ ...data, measurements: [...data.measurements.filter((entry) => entry.id !== record.id), record] }, "Measurements saved on this device.")) {
      setMeasureId(null); setMeasureForm(blankMeasurement()); setMeasureOpen(false);
    }
  }
  async function remove(id: string, kind: "weight" | "measurement") {
    if (await persist({ ...data, weighIns: kind === "weight" ? data.weighIns.filter((entry) => entry.id !== id) : data.weighIns, measurements: kind === "measurement" ? data.measurements.filter((entry) => entry.id !== id) : data.measurements, deletions: [...data.deletions.filter((entry) => entry.id !== id || entry.kind !== kind), { id, kind, deletedAt: new Date().toISOString() }] }, "Entry deleted.")) setDeletePending(null);
  }
  function deleteControls(id: string, kind: "weight" | "measurement") {
    return deletePending === `${kind}:${id}` ? <><span>Delete this entry?</span><button type="button" className="body-danger" disabled={busy} onClick={() => void remove(id, kind)}>Delete entry</button><button type="button" disabled={busy} onClick={() => setDeletePending(null)}>Keep entry</button></> : <button type="button" disabled={busy} onClick={() => setDeletePending(`${kind}:${id}`)}>Delete</button>;
  }
  return <section className="body-progress" aria-label="Progress overview">
    {error && <p className="body-error" role="alert">{error}{!ready && <button type="button" onClick={() => { void exportBodyProgress().then((next) => { setData(next); setReady(true); setError(""); }).catch((reason) => setError(failure(reason))); }}>Retry loading</button>}</p>}
    {message && <p className="body-success" role="status">{message}</p>}
    {!ready && !error && <p role="status">Loading body entries…</p>}
    <GoalOverview data={data} readings={readings} ready={ready} busy={busy} onSave={persist} onWeight={() => {setWeightId(null);setWeightForm({date:localDay(),kg:'',note:''});setWeightOpen(true);}} onMeasure={() => {setMeasureId(null);setMeasureForm(blankMeasurement());setMeasureOpen(true);}} onPhotos={onPhotos} />
    <article className="chart-card bodyweight-chart-card">
      <div className="journey-trend-heading"><h3>The weight trend</h3><label className="body-range">Show trends<select value={range} onChange={event => setRange(event.target.value)}><option value="all">All time</option><option value="90">Last 90 days</option><option value="30">Last 30 days</option></select></label></div>
      {weightOpen && <form className="body-entry-form" onSubmit={(event) => void saveWeight(event)}><h4>{weightId ? "Edit weigh-in" : "Independent weigh-in"}</h4><div className="body-input-grid"><label>Date<input type="date" value={weightForm.date} max={localDay()} required onChange={(event) => setWeightForm({ ...weightForm, date: event.target.value })} /></label><label>Weight (kg)<input ref={weightField} type="text" inputMode="decimal" value={weightForm.kg} placeholder="e.g. 66.2" required onChange={(event) => setWeightForm({ ...weightForm, kg: event.target.value })} /></label></div><label>Note (optional)<input type="text" maxLength={1000} value={weightForm.note} onChange={(event) => setWeightForm({ ...weightForm, note: event.target.value })} /></label><p>For comparable readings, use the same scale and time of day, ideally after the bathroom and before breakfast.</p><div className="body-actions"><button className="body-primary" disabled={busy} type="submit">{busy ? "Saving…" : "Save weigh-in"}</button><button type="button" disabled={busy} onClick={() => setWeightOpen(false)}>Cancel</button></div></form>}
      <div className="body-averages">{([{ label: "Last 7 days", data: averages.recent }, { label: "Previous 7 days", data: averages.previous }]).map(({label, data}) => <div key={label}><span>{label}</span><strong>{data.value === null ? "No readings" : `${number(data.value)} kg average`}</strong><small>{data.count} recorded day{data.count === 1 ? "" : "s"}</small></div>)}</div>
      <TrendChart series={shownWeights.length ? [{ exercise: "Bodyweight", points: shownWeights }] : []} unit="kg" emptyTitle="No weight readings in this range" emptyHint="Log a weigh-in here or save bodyweight with a workout." label="Bodyweight trend" showSummary={false} />
      <details className="body-entry-list"><summary>Manage independent weigh-ins ({data.weighIns.length})</summary>{!data.weighIns.length && <p>No independent weigh-ins yet. Workout readings can be edited in workout history.</p>}{[...data.weighIns].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).map((entry) => <div className="body-entry" key={entry.id}><div><strong>{number(entry.kg)} kg</strong><time>{displayDate(entry.date)}</time>{entry.note && <p>{entry.note}</p>}</div><div className="body-entry-actions"><button type="button" disabled={busy} onClick={() => { setWeightId(entry.id); setWeightForm({ date: entry.date, kg: String(entry.kg), note: entry.note }); setWeightOpen(true); }}>Edit</button>{deleteControls(entry.id, "weight")}</div></div>)}</details>
    </article>
    <ProgressOutlook readings={readings} measurements={data.measurements} history={history} />
    <ProgressContext data={data} readings={readings} sessions={sessions} phase={phase} phases={phases} onPhotos={onPhotos} onPlan={onPlan} />
    <article className="chart-card body-measure-card"><div className="chart-card-heading"><div><h3>Beyond the scale</h3><p>Tape measurements add another view of your progress.</p></div><button type="button" className="body-primary" disabled={!ready || busy} onClick={() => { setMeasureId(null); setMeasureForm(blankMeasurement()); setMeasureOpen(!measureOpen); }}>Log measurements</button></div>
      <details className="body-guidance"><summary>How to measure consistently</summary><p>Use a flexible tape, keep it level and snug without compressing your skin. Measure in the same posture and conditions, before training; repeat a reading if the tape slipped.</p><dl><div><dt>Chest</dt><dd>Around the fullest part of the chest, arms relaxed, after a normal exhale.</dd></div><div><dt>Waist</dt><dd>At navel height, abdomen relaxed, after a normal exhale. Keep this landmark each time.</dd></div><div><dt>Arms</dt><dd>Around the widest part of one upper arm with the arm relaxed. Use the same arm; note left or right.</dd></div><div><dt>Thighs</dt><dd>Around the widest part of one thigh, standing relaxed. Use the same leg and tape position; note the side.</dd></div></dl><p>These are manual circumference readings. They do not estimate body fat or muscle mass.</p></details>
      {measureOpen && <form className="body-entry-form" onSubmit={(event) => void saveMeasurement(event)}><h4>{measureId ? "Edit measurements" : "New tape measurements"}</h4><label>Date<input type="date" value={measureForm.date} max={localDay()} required onChange={(event) => setMeasureForm({ ...measureForm, date: event.target.value })} /></label><div className="body-input-grid body-tape-inputs">{MEASUREMENT_KEYS.map((key) => <label key={key}>{labels[key]} (cm)<input ref={key === "chest" ? measureField : undefined} type="text" inputMode="decimal" value={measureForm[key]} placeholder="Optional" onChange={(event) => setMeasureForm({ ...measureForm, [key]: event.target.value })} /></label>)}</div><label>Note (optional, e.g. side and tape position)<input type="text" maxLength={1000} value={measureForm.note} onChange={(event) => setMeasureForm({ ...measureForm, note: event.target.value })} /></label><p>Enter at least one measurement. Empty fields stay unrecorded.</p><div className="body-actions"><button type="submit" className="body-primary" disabled={busy}>{busy ? "Saving…" : "Save measurements"}</button><button type="button" disabled={busy} onClick={() => setMeasureOpen(false)}>Cancel</button></div></form>}
      <div className="measurement-snapshot">{MEASUREMENT_KEYS.map(key => { const entry = [...data.measurements].filter(item => item[key] !== undefined).sort((a,b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt))[0]; return <div key={key}><span>{labels[key]}</span><strong>{entry ? number(entry[key]!) : '—'}{entry && <small>cm</small>}</strong><time>{entry ? displayDate(entry.date) : 'No reading yet'}</time></div>; })}</div>
      <details className="measurement-explore"><summary>Explore measurement trends</summary>
      <div className="body-metric-buttons" aria-label="Measurement trend">{MEASUREMENT_KEYS.map((key) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{labels[key]}</button>)}</div><MeasurementTrend records={shownMeasurements} metric={metric} /></details>
      <details className="body-entry-list"><summary>Manage measurement entries ({data.measurements.length})</summary>{!data.measurements.length && <p>No tape measurements yet.</p>}{[...data.measurements].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).map((entry) => <div className="body-entry" key={entry.id}><div><strong>{displayDate(entry.date)}</strong><p>{MEASUREMENT_KEYS.filter((key) => entry[key] !== undefined).map((key) => `${labels[key]} ${number(entry[key]!)} cm`).join(" · ")}</p>{entry.note && <p>{entry.note}</p>}</div><div className="body-entry-actions"><button type="button" disabled={busy} onClick={() => { setMeasureId(entry.id); setMeasureForm({ date: entry.date, note: entry.note, chest: entry.chest === undefined ? "" : String(entry.chest), waist: entry.waist === undefined ? "" : String(entry.waist), arms: entry.arms === undefined ? "" : String(entry.arms), thighs: entry.thighs === undefined ? "" : String(entry.thighs) }); setMeasureOpen(true); }}>Edit</button>{deleteControls(entry.id, "measurement")}</div></div>)}</details>
    </article>
    <p className="progress-storage-note">Weigh-ins, measurements and goals travel with device sync. Photos stay on this device. Keep a separate copy with Data → Backup.</p>
  </section>;
}
