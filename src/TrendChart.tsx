import { useEffect, useId, useRef, useState } from "react";
import { chartScale, type ExerciseSeries } from "./progressModel";

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const dateLabel = (date: string) => new Date(date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// Markers star the points at those dates; a target draws a dashed line that the
// scale always includes, however far it is above the readings.
export type ChartMarker = { date: string; label: string };
export function TrendChart({ series, unit, emptyTitle, emptyHint, label, showSummary = true, markers = [], target }: {
  series: ExerciseSeries[]; unit: "kg" | "kg·reps" | "cm"; emptyTitle: string; emptyHint: string; label: string; showSummary?: boolean;
  markers?: ChartMarker[]; target?: { value: number; label: string };
}) {
  const container = useRef<HTMLDivElement>(null);
  const gradient = useId();
  const [width, setWidth] = useState(600);
  const [selection, setSelection] = useState<string | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const points = series.flatMap((item, seriesIndex) => item.points.map((point, index) => ({ ...point, exercise: item.exercise, seriesIndex, key: `${item.exercise}:${point.date}:${index}` })));
  const selected = points.find((point) => point.key === selection) ?? points.reduce<typeof points[number] | undefined>((latest, point) => !latest || point.date > latest.date ? point : latest, undefined);
  const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const selectedIndex = ordered.findIndex((point) => point.key === selected?.key);
  const { min, max, ticks } = chartScale([...points.map((point) => point.value), ...(target && points.length ? [target.value] : [])]);
  const starred = markers.flatMap((marker) => { const point = points.find((item) => item.date === marker.date); return point ? [{ ...marker, point }] : []; });
  const dates = points.map((point) => Date.parse(point.date));
  const first = dates.length ? Math.min(...dates) : 0;
  const last = dates.length ? Math.max(...dates) : 0;
  const left = unit === "kg·reps" ? 62 : 48;
  const right = width - 18;
  const top = 24;
  const bottom = 224;
  const xFor = (date: string) => first === last ? (left + right) / 2 : left + (Date.parse(date) - first) / (last - first) * (right - left);
  const yFor = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
  const dateTicks = first === last ? [first] : width < 480 ? [first, last] : [first, first + (last - first) / 2, last];
  return <div className="trend-chart" ref={container}>
    {!points.length ? <div className="empty-chart"><strong>{emptyTitle}</strong><span>{emptyHint}</span></div> : <>
      {showSummary && <div className="trend-summaries">{series.map((item, index) => {
        const latest = item.points.at(-1)!;
        const delta = latest.value - item.points[0].value;
        return <div className={`trend-summary trace-${index}`} key={item.exercise}>
          <span><i />{item.exercise === "Bodyweight" ? "Latest reading" : item.exercise}</span>
          <strong>{number(latest.value)} <small>{unit}</small></strong>
          <p>{item.points.length > 1 ? `${delta > 0 ? "+" : ""}${number(delta)} ${unit} from first shown` : "First recorded reading"}</p>
        </div>;
      })}</div>}
      <div className="trend-axis-label"><span>{unit === "kg" ? "Weight (kg)" : unit === "cm" ? "Circumference (cm)" : "Recorded volume (kg × reps)"}</span><span>{Math.max(...series.map((item) => item.points.length))} reading{Math.max(...series.map((item) => item.points.length)) === 1 ? "" : "s"}{series.length > 1 ? " max per lift" : ""}</span></div>
      <svg className="trend-plot" width="100%" height="266" viewBox={`0 0 ${width} 266`} role="group" aria-label={label}>
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--trace-0)" stopOpacity=".23" /><stop offset="100%" stopColor="var(--trace-0)" stopOpacity=".015" /></linearGradient></defs>
        {ticks.map((tick) => <g className="trend-grid" key={tick}><line x1={left} x2={right} y1={yFor(tick)} y2={yFor(tick)} /><text x={left - 10} y={yFor(tick) + 4} textAnchor="end">{tick.toLocaleString(undefined, { maximumFractionDigits: 2, notation: tick >= 10000 ? "compact" : "standard" })}</text></g>)}
        {dateTicks.map((date, index) => <text className="trend-date" key={date} x={dateTicks.length === 1 ? (left + right) / 2 : index === 0 ? left : index === dateTicks.length - 1 ? right : (left + right) / 2} y="254" textAnchor={dateTicks.length === 1 ? "middle" : index === 0 ? "start" : index === dateTicks.length - 1 ? "end" : "middle"}>{new Date(date).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(new Date(first).getFullYear() !== new Date(last).getFullYear() ? { year: "2-digit" } : {}) })}</text>)}
        {series.map((item, index) => {
          const coordinates = item.points.map((point) => `${xFor(point.date)},${yFor(point.value)}`).join(" ");
          return <g className={`trace-${index}`} key={item.exercise}>
            {series.length === 1 && item.points.length > 1 && <polygon fill={`url(#${gradient})`} points={`${xFor(item.points[0].date)},${bottom} ${coordinates} ${xFor(item.points.at(-1)!.date)},${bottom}`} />}
            <polyline className="trend-line" points={coordinates} strokeDasharray={index > 2 ? "7 4" : undefined} />
          </g>;
        })}
        {target && <g className="trend-target"><line x1={left} x2={right} y1={yFor(target.value)} y2={yFor(target.value)} /><text x={left + 4} y={yFor(target.value) - 7}>{target.label}</text></g>}
        {selected && <line className="trend-crosshair" x1={xFor(selected.date)} x2={xFor(selected.date)} y1={top} y2={bottom} />}
        {points.map((point) => <g className={`trace-${point.seriesIndex}`} key={point.key}>
          <circle className="trend-dot" cx={xFor(point.date)} cy={yFor(point.value)} r={selected?.key === point.key ? 6 : 3.5} />
          <circle className="trend-hit" cx={xFor(point.date)} cy={yFor(point.value)} r="13" role="button" tabIndex={0} aria-label={`${point.exercise}, ${dateLabel(point.date)}, ${number(point.value)} ${unit}${starred.filter((star) => star.point.key === point.key).map((star) => `, reached ${star.label}`).join("")}`} aria-pressed={selected?.key === point.key} onPointerEnter={() => setSelection(point.key)} onClick={() => setSelection(point.key)} onFocus={() => setSelection(point.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelection(point.key); } }} />
        </g>)}
        {starred.map(({ point, label: text }, index) => <g className="trend-star" key={`${point.key}:${text}`} transform={`translate(${xFor(point.date)} ${yFor(point.value)})`} aria-hidden="true">
          <path d="M0 -9l2.6 5.4 5.9.7-4.4 4 1.2 5.8-5.3-3-5.3 3 1.2-5.8-4.4-4 5.9-.7z" />
          {starred.findIndex((item) => item.point.key === point.key) === index && <text y="22" x={xFor(point.date) > right - 50 ? 8 : xFor(point.date) < left + 50 ? -8 : 0} textAnchor={xFor(point.date) > right - 50 ? "end" : xFor(point.date) < left + 50 ? "start" : "middle"}>{starred.filter((item) => item.point.key === point.key).map((item) => item.label).join(" · ")} ✓</text>}
        </g>)}
      </svg>
      <div className="trend-inspector"><button type="button" aria-label={`Previous reading in ${label}`} disabled={selectedIndex <= 0} onClick={() => setSelection(ordered[selectedIndex - 1].key)}>‹</button><div className="trend-readout" aria-live="polite"><div><strong>{selected?.exercise}</strong><time>{selected && dateLabel(selected.date)}</time></div><b>{selected && number(selected.value)} <small>{unit}</small></b></div><button type="button" aria-label={`Next reading in ${label}`} disabled={selectedIndex >= ordered.length - 1} onClick={() => setSelection(ordered[selectedIndex + 1].key)}>›</button></div>
      <div className="trend-footer"><span>Tap or focus a point for details.</span><details className="trend-data"><summary>View data</summary><div><table><caption>{label}</caption><thead><tr><th scope="col">Date</th><th scope="col">Exercise</th><th scope="col">{unit}</th></tr></thead><tbody>{[...points].sort((a, b) => b.date.localeCompare(a.date)).map((point) => <tr key={point.key}><td>{dateLabel(point.date)}</td><th scope="row">{point.exercise}</th><td>{number(point.value)}</td></tr>)}</tbody></table></div></details></div>
    </>}
  </div>;
}
