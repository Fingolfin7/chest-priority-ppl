import { useId, useMemo, useState } from 'react';
import { MEASUREMENT_KEYS, localDay, type BodyMeasurement, type MeasurementKey, type WeightReading } from './bodyProgressModel';
import type { HistoryMap } from './historyMigration';
import { liftOutlookPoints, projectLift, projectMeasurement, projectWeight, type OutlookEstimate, type ProgressProjection } from './projectionModel';
import './projections.css';

const metricLabels: Record<MeasurementKey, string> = {chest:'Chest',waist:'Waist',arms:'Arms',thighs:'Thighs'};
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {day:'numeric',month:'short'});
const number = (value: number) => value.toLocaleString(undefined, {maximumFractionDigits:1});
type View = 'weight' | 'lifts' | 'measurements';

function OutlookPlot({projection,estimate,unit}: {projection:ProgressProjection;estimate:OutlookEstimate;unit:string}) {
  const points=projection.points;
  const time=(date:string)=>Date.parse(`${date}T12:00:00Z`);
  const start=time(points[0].date),end=time(estimate.date), latest=projection.latest!;
  const values=[...points.map(point=>point.value),estimate.low,estimate.high];
  const minimum=Math.max(0,Math.min(...values)), maximum=Math.max(...values);
  const padding=Math.max((maximum-minimum)*.15,1),low=Math.max(0,minimum-padding),high=maximum+padding;
  const x=(date:string)=>48+((time(date)-start)/Math.max(end-start,1))*290;
  const y=(value:number)=>126-((value-low)/Math.max(high-low,1))*100;
  const baseline=estimate.value-projection.slopePerWeek!*((time(estimate.date)-time(latest.date))/86_400_000/7);
  return <figure className="outlook-plot"><svg viewBox="0 0 360 160" role="img" aria-label={`Recorded ${unit} readings and a rough range of ${number(estimate.low)} to ${number(estimate.high)} ${unit} by ${dateLabel(estimate.date)}`}>
    {[low,(low+high)/2,high].map(value=><g key={value}><line x1="48" y1={y(value)} x2="338" y2={y(value)} className="outlook-grid"/><text x="40" y={y(value)+3} textAnchor="end">{number(value)}</text></g>)}
    <polygon points={`${x(latest.date)},${y(baseline)} ${x(estimate.date)},${y(estimate.high)} ${x(estimate.date)},${y(estimate.low)}`} className="outlook-band"/>
    <polyline points={points.map(point=>`${x(point.date)},${y(point.value)}`).join(' ')} className="outlook-observed"/>
    {points.map((point,index)=><circle key={`${point.date}-${index}`} cx={x(point.date)} cy={y(point.value)} r="2.6" className="outlook-dot"/>)}
    <line x1={x(latest.date)} y1={y(baseline)} x2={x(estimate.date)} y2={y(estimate.value)} className="outlook-projected"/>
    <line x1={x(estimate.date)} y1={y(estimate.low)} x2={x(estimate.date)} y2={y(estimate.high)} className="outlook-range-line"/>
    <text x="48" y="149">{dateLabel(points[0].date)}</text><text x="338" y="149" textAnchor="end">{dateLabel(estimate.date)}</text>
  </svg><figcaption><span><i className="outlook-observed-key"/>Recorded</span><span><i className="outlook-range-key"/>Rough scenario range</span></figcaption></figure>;
}

export function ProgressOutlook({readings,measurements,history}: {readings:WeightReading[];measurements:BodyMeasurement[];history:HistoryMap}) {
  const id=useId();
  const [view,setView]=useState<View>('weight');
  const [weeks,setWeeks]=useState<2|3|4>(3);
  const [exercise,setExercise]=useState('');
  const [metric,setMetric]=useState<MeasurementKey>('chest');
  const today=localDay();
  const exercises=useMemo(()=>Object.keys(history).filter(name=>liftOutlookPoints(history,name).length>0).sort((a,b)=>a.localeCompare(b)),[history]);
  const metrics=useMemo(()=>MEASUREMENT_KEYS.filter(key=>measurements.some(record=>typeof record[key]==='number' && Number.isFinite(record[key]) && record[key]!>0)),[measurements]);
  const selectedExercise=exercises.includes(exercise)?exercise:exercises[0]??'';
  const selectedMetric=metrics.includes(metric)?metric:metrics[0]??'chest';
  const projection=useMemo(()=>view==='weight'?projectWeight(readings,today):view==='lifts'?projectLift(history,selectedExercise,today):projectMeasurement(measurements,selectedMetric,today),[view,readings,history,selectedExercise,measurements,selectedMetric,today]);
  const estimate=projection.estimates.find(item=>item.weeks===weeks);
  const unit=view==='measurements'?'cm':'kg';
  const label=view==='weight'?'Bodyweight':view==='lifts'?'Top working weight':`${metricLabels[selectedMetric]} circumference`;
  const samples=view==='lifts'?'sessions':'recorded days';
  return <details className="progress-outlook">
    <summary><span>Short-term outlook</span><small>Explore the next 2–4 weeks</small></summary>
    <div className="outlook-content">
      <div className="outlook-controls"><div className="outlook-views" role="group" aria-label="Outlook metric">{(['weight','lifts','measurements'] as const).map(value=><button type="button" key={value} aria-pressed={view===value} onClick={()=>setView(value)}>{value==='weight'?'Weight':value==='lifts'?'Lifts':'Measurements'}</button>)}</div>
        <div className="outlook-horizons" role="group" aria-label="Weeks ahead">{([2,3,4] as const).map(value=><button type="button" key={value} aria-pressed={weeks===value} onClick={()=>setWeeks(value)}>{value} weeks</button>)}</div></div>
      {view==='lifts'&&<label className="outlook-select" htmlFor={`${id}-exercise`}>Exercise<select id={`${id}-exercise`} value={selectedExercise} disabled={!exercises.length} onChange={event=>setExercise(event.target.value)}>{exercises.length?exercises.map(name=><option key={name} value={name}>{name}</option>):<option value="">No loaded exercise history yet</option>}</select></label>}
      {view==='measurements'&&<label className="outlook-select" htmlFor={`${id}-measurement`}>Measurement<select id={`${id}-measurement`} value={selectedMetric} disabled={!metrics.length} onChange={event=>setMetric(event.target.value as MeasurementKey)}>{metrics.length?metrics.map(key=><option key={key} value={key}>{metricLabels[key]}</option>):<option value="chest">No tape readings yet</option>}</select></label>}
      <div className="outlook-heading"><h4>{label}</h4><span className="outlook-quality" data-quality={projection.quality}>{projection.status==='ready'?(projection.quality==='noisy'?'Low confidence · noisy readings':projection.quality==='limited'?'Low confidence · limited history':'Rough outlook'):projection.status==='stale'?'Needs a fresh reading':projection.status==='unstable'?'Trend is too unstable':'Needs more history'}</span></div>
      <p className="outlook-evidence">{projection.count} {samples} across {projection.spanDays} days{projection.latest?` · Latest ${dateLabel(projection.latest.date)}`:''}</p>
      {projection.latest&&<dl className="outlook-values"><div><dt>Latest recorded</dt><dd>{number(projection.latest.value)} <small>{unit}</small>{view==='lifts'&&projection.latest.reps!==undefined&&<span> × {number(projection.latest.reps)} reps</span>}</dd></div><div><dt>Average of last {Math.min(3,projection.count)} readings</dt><dd>{number(projection.recentAverage!)} <small>{unit}</small></dd></div>{estimate&&<div className="outlook-future"><dt>Rough range by {dateLabel(estimate.date)}</dt><dd>{number(estimate.low)}–{number(estimate.high)} <small>{unit}</small></dd></div>}</dl>}
      {estimate&&<OutlookPlot projection={projection} estimate={estimate} unit={unit}/>}
      <p className="outlook-message">{projection.reason}</p>
      {view==='lifts'&&<p className="outlook-lift-note">This follows the heaviest recorded working set, using the logged load convention for this exercise. More reps at the same load also count as progress. This does not estimate maximum strength.</p>}
      <p className="outlook-method">Extends the recent recorded trend if it continues. The range widens with time and variation; it is a scenario range, not a 95% confidence interval or a target.</p>
    </div>
  </details>;
}
