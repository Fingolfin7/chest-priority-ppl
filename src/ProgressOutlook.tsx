import { useEffect, useId, useMemo, useState } from 'react';
import { MEASUREMENT_KEYS, localDay, type BodyMeasurement, type MeasurementKey, type WeightReading } from './bodyProgressModel';
import type { HistoryMap } from './historyMigration';
import { liftOutlookPoints, measurementOutlookPoints, projectLift, projectMeasurement, projectWeight, type OutlookEstimate, type OutlookPoint, type ProgressProjection, type ProjectionParameters } from './projectionModel';
import { createForecastSnapshot, FORECAST_HISTORY_CHANGE_EVENT, loadForecastHistory, saveForecastSnapshotIfDue, type ForecastSnapshot } from './forecastHistory';
import './projections.css';

const metricLabels: Record<MeasurementKey, string> = {chest:'Chest',waist:'Waist',arms:'Arms',thighs:'Thighs'};
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {day:'numeric',month:'short',year:'numeric'});
const number = (value: number) => value.toLocaleString(undefined, {maximumFractionDigits:1});
type View = 'weight' | 'lifts' | 'measurements';

function dayNumber(date: string) { return Date.parse(`${date}T12:00:00Z`) / 86_400_000; }
function valueAt(parameters: ProjectionParameters, date: string) {
  return parameters.intercept + parameters.slopePerDay * (dayNumber(date) - dayNumber(parameters.firstDate));
}
function rangeWidth(parameters: ProjectionParameters, date: string) {
  return Math.max(parameters.bandFloor, parameters.residualRms)
    * (1 + (dayNumber(date) - dayNumber(parameters.latestDate)) / Math.max(parameters.spanDays, 1));
}

function OutlookPlot({actual,original,weeks,estimate,projection,unit}: {
  actual: OutlookPoint[];
  original: ForecastSnapshot;
  weeks: 2 | 3 | 4;
  estimate: OutlookEstimate | undefined;
  projection: ProgressProjection;
  unit: string;
}) {
  const originalEstimate=original.estimates.find(item=>item.weeks===weeks);
  const currentParameters=projection.status==='ready'?projection.parameters:null;
  const dates=[...actual.map(point=>point.date),...original.points.map(point=>point.date),...(estimate?[estimate.date]:[]),...(originalEstimate?[originalEstimate.date]:[])];
  const startDate=dates.reduce((start,date)=>date<start?date:start,original.points[0].date);
  const endDate=dates.reduce((end,date)=>date>end?date:end,startDate);
  const start=dayNumber(startDate),end=dayNumber(endDate);
  const originalRange=originalEstimate?[originalEstimate.low,originalEstimate.high,valueAt(original.parameters,original.parameters.latestDate)]:[];
  const currentRange=estimate&&currentParameters?[estimate.low,estimate.high,valueAt(currentParameters,currentParameters.latestDate)]:[];
  const values=[...actual.map(point=>point.value),...original.points.map(point=>point.value),...originalRange,...currentRange];
  const minimum=Math.max(0,Math.min(...values)), maximum=Math.max(...values);
  const padding=Math.max((maximum-minimum)*.15,1),low=Math.max(0,minimum-padding),high=maximum+padding;
  const x=(date:string)=>48+((dayNumber(date)-start)/Math.max(end-start,1))*290;
  const y=(value:number)=>132-((value-low)/Math.max(high-low,1))*100;
  const band=(parameters:ProjectionParameters,forecast:OutlookEstimate)=>{
    const base=valueAt(parameters,parameters.latestDate),startWidth=rangeWidth(parameters,parameters.latestDate);
    return `${x(parameters.latestDate)},${y(base+startWidth)} ${x(forecast.date)},${y(forecast.high)} ${x(forecast.date)},${y(forecast.low)} ${x(parameters.latestDate)},${y(base-startWidth)}`;
  };
  const originalBase=valueAt(original.parameters,original.parameters.latestDate);
  const currentBase=currentParameters?valueAt(currentParameters,currentParameters.latestDate):null;
  return <figure className="outlook-plot"><svg viewBox="0 0 360 166" role="img" aria-label={`Recorded ${unit} readings, an original saved forecast${estimate?' and current projection':''}`}>
    {[low,(low+high)/2,high].map(value=><g key={value}><line x1="48" y1={y(value)} x2="338" y2={y(value)} className="outlook-grid"/><text x="40" y={y(value)+3} textAnchor="end">{number(value)}</text></g>)}
    {originalEstimate&&<polygon points={band(original.parameters,originalEstimate)} className="outlook-original-band"/>}
    {estimate&&currentParameters&&<polygon points={band(currentParameters,estimate)} className="outlook-band"/>}
    <polyline points={actual.map(point=>`${x(point.date)},${y(point.value)}`).join(' ')} className="outlook-observed"/>
    {actual.map((point,index)=><circle key={`${point.date}-${index}`} cx={x(point.date)} cy={y(point.value)} r="2.6" className="outlook-dot"/>)}
    {originalEstimate&&<><line x1={x(original.parameters.latestDate)} y1={y(originalBase)} x2={x(originalEstimate.date)} y2={y(originalEstimate.value)} className="outlook-original-forecast"/><line x1={x(originalEstimate.date)} y1={y(originalEstimate.low)} x2={x(originalEstimate.date)} y2={y(originalEstimate.high)} className="outlook-original-range-line"/></>}
    {estimate&&currentParameters&&currentBase!==null&&<><line x1={x(currentParameters.latestDate)} y1={y(currentBase)} x2={x(estimate.date)} y2={y(estimate.value)} className="outlook-projected"/><line x1={x(estimate.date)} y1={y(estimate.low)} x2={x(estimate.date)} y2={y(estimate.high)} className="outlook-range-line"/></>}
    <text x="48" y="155">{dateLabel(startDate)}</text><text x="338" y="155" textAnchor="end">{dateLabel(endDate)}</text>
  </svg><figcaption><span><i className="outlook-observed-key"/>Recorded values</span><span><i className="outlook-original-key"/>Original forecast</span>{estimate&&<span><i className="outlook-current-key"/>Current projection</span>}</figcaption></figure>;
}

export function ProgressOutlook({readings,measurements,history}: {readings:WeightReading[];measurements:BodyMeasurement[];history:HistoryMap}) {
  const id=useId();
  const [view,setView]=useState<View>('weight');
  const [weeks,setWeeks]=useState<2|3|4>(3);
  const [exercise,setExercise]=useState('');
  const [metric,setMetric]=useState<MeasurementKey>('chest');
  const [historyData,setHistoryData]=useState<ForecastSnapshot[]>([]);
  const [historyError,setHistoryError]=useState('');
  const [comparisonId,setComparisonId]=useState('');
  const [isOpen,setIsOpen]=useState(false);
  const today=localDay();

  useEffect(()=>{
    let mounted=true;
    const refresh=()=>{void loadForecastHistory().then(data=>{if(mounted){setHistoryData(data.snapshots);setHistoryError('');}}).catch(()=>{if(mounted)setHistoryError('Saved forecasts could not be loaded on this device.');});};
    refresh();
    window.addEventListener(FORECAST_HISTORY_CHANGE_EVENT,refresh);
    return ()=>{mounted=false;window.removeEventListener(FORECAST_HISTORY_CHANGE_EVENT,refresh);};
  },[]);

  const historicalExercises=useMemo(()=>historyData.filter(item=>item.kind==='lift').map(item=>item.targetId),[historyData]);
  const historicalMetrics=useMemo(()=>historyData.filter(item=>item.kind==='measurement').map(item=>item.targetId as MeasurementKey),[historyData]);
  const exercises=useMemo(()=>[...new Set([...Object.keys(history).filter(name=>liftOutlookPoints(history,name).length>0),...historicalExercises])].sort((a,b)=>a.localeCompare(b)),[history,historicalExercises]);
  const metrics=useMemo(()=>[...new Set([...MEASUREMENT_KEYS.filter(key=>measurements.some(record=>typeof record[key]==='number'&&Number.isFinite(record[key])&&record[key]!>0)),...historicalMetrics])],[measurements,historicalMetrics]);
  const selectedExercise=exercises.includes(exercise)?exercise:exercises[0]??'';
  const selectedMetric=metrics.includes(metric)?metric:metrics[0]??'chest';
  const projection=useMemo(()=>view==='weight'?projectWeight(readings,today):view==='lifts'?projectLift(history,selectedExercise,today):projectMeasurement(measurements,selectedMetric,today),[view,readings,history,selectedExercise,measurements,selectedMetric,today]);
  const estimate=projection.estimates.find(item=>item.weeks===weeks);
  const unit=view==='measurements'?'cm':'kg';
  const label=view==='weight'?'Bodyweight':view==='lifts'?'Top working weight':`${metricLabels[selectedMetric]} circumference`;
  const samples=view==='lifts'?'sessions':'recorded days';
  const targetId=view==='weight'?'weight':view==='lifts'?selectedExercise:selectedMetric;
  const kind=view==='weight'?'weight':view==='lifts'?'lift':'measurement';
  const candidates=useMemo(()=>historyData.filter(item=>item.kind===kind&&item.targetId===targetId).sort((a,b)=>b.observationCutoff.localeCompare(a.observationCutoff)),[historyData,kind,targetId]);
  const currentPoints=useMemo(()=>(view==='weight'?readings.map(({date,value})=>({date,value})):view==='lifts'?liftOutlookPoints(history,selectedExercise):measurementOutlookPoints(measurements,selectedMetric)).sort((a,b)=>a.date.localeCompare(b.date)),[view,readings,history,selectedExercise,measurements,selectedMetric]);
  const original=useMemo(()=>candidates.find(item=>item.id===comparisonId)
    ??candidates.find(item=>currentPoints.at(-1)?.date&&currentPoints.at(-1)!.date>item.observationCutoff)
    ??candidates[0],[candidates,comparisonId,currentPoints]);
  const actual=useMemo(()=>{
    if(!original)return currentPoints;
    const firstRelevantDate=projection.parameters?.firstDate&&projection.parameters.firstDate<original.parameters.firstDate
      ?projection.parameters.firstDate:original.parameters.firstDate;
    return currentPoints.filter(point=>point.date>=firstRelevantDate);
  },[currentPoints,original,projection.parameters]);
  const snapshot=useMemo(()=>createForecastSnapshot({kind,targetId,targetLabel:label,unit,observationCutoff:today,projection}),[kind,targetId,label,unit,today,projection]);

  useEffect(()=>{
    if(!isOpen||!snapshot)return;
    let active=true;
    void saveForecastSnapshotIfDue(snapshot).then(saved=>{if(active&&saved)setHistoryError('');}).catch(error=>{
      if(active)setHistoryError(error instanceof Error?error.message:'This device could not save the forecast history.');
    });
    return ()=>{active=false;};
  },[isOpen,snapshot]);

  return <details className="progress-outlook" onToggle={event=>setIsOpen(event.currentTarget.open)}>
    <summary><span>Short-term outlook</span><small>Explore and compare 2–4 week forecasts</small></summary>
    <div className="outlook-content">
      <div className="outlook-controls"><div className="outlook-views" role="group" aria-label="Outlook metric">{(['weight','lifts','measurements'] as const).map(value=><button type="button" key={value} aria-pressed={view===value} onClick={()=>setView(value)}>{value==='weight'?'Weight':value==='lifts'?'Lifts':'Measurements'}</button>)}</div>
        <div className="outlook-horizons" role="group" aria-label="Weeks ahead">{([2,3,4] as const).map(value=><button type="button" key={value} aria-pressed={weeks===value} onClick={()=>setWeeks(value)}>{value} weeks</button>)}</div></div>
      {view==='lifts'&&<label className="outlook-select" htmlFor={`${id}-exercise`}>Exercise<select aria-label="Exercise" id={`${id}-exercise`} value={selectedExercise} disabled={!exercises.length} onChange={event=>setExercise(event.target.value)}>{exercises.length?exercises.map(name=><option key={name} value={name}>{name}</option>):<option value="">No loaded exercise history yet</option>}</select></label>}
      {view==='measurements'&&<label className="outlook-select" htmlFor={`${id}-measurement`}>Measurement<select aria-label="Measurement" id={`${id}-measurement`} value={selectedMetric} disabled={!metrics.length} onChange={event=>setMetric(event.target.value as MeasurementKey)}>{metrics.length?metrics.map(key=><option key={key} value={key}>{metricLabels[key]}</option>):<option value="chest">No tape readings yet</option>}</select></label>}
      <div className="outlook-heading"><h4>{label}</h4><span className="outlook-quality" data-quality={projection.quality}>{projection.status==='ready'?(projection.quality==='noisy'?'Low confidence · noisy readings':projection.quality==='limited'?'Low confidence · limited history':'Rough outlook'):projection.status==='stale'?'Needs a fresh reading':projection.status==='unstable'?'Trend is too unstable':'Needs more history'}</span></div>
      <p className="outlook-evidence">{projection.count} {samples} across {projection.spanDays} days{projection.latest?` · Latest ${dateLabel(projection.latest.date)}`:''}</p>
      {projection.latest&&<dl className="outlook-values"><div><dt>Latest recorded</dt><dd>{number(projection.latest.value)} <small>{unit}</small>{view==='lifts'&&projection.latest.reps!==undefined&&<span> × {number(projection.latest.reps)} reps</span>}</dd></div><div><dt>Average of last {Math.min(3,projection.count)} readings</dt><dd>{number(projection.recentAverage!)} <small>{unit}</small></dd></div>{estimate&&<div className="outlook-future"><dt>Current rough range by {dateLabel(estimate.date)}</dt><dd>{number(estimate.low)}–{number(estimate.high)} <small>{unit}</small></dd></div>}</dl>}
      {candidates.length>0&&<label className="outlook-select outlook-compare" htmlFor={`${id}-comparison`}>Compare with forecast from<select aria-label="Compare with forecast from" id={`${id}-comparison`} value={original?.id??''} onChange={event=>setComparisonId(event.target.value)}>{candidates.map(item=><option key={item.id} value={item.id}>{dateLabel(item.observationCutoff)}</option>)}</select></label>}
      {original&&<>
        <OutlookPlot actual={actual} original={original} weeks={weeks} estimate={estimate} projection={projection} unit={unit}/>
        <p className="outlook-transparency">Original issued {dateLabel(original.observationCutoff)} using readings through {dateLabel(original.parameters.latestDate)} ({original.points.length} points, {original.quality} history). The original {weeks}-week value was {number(original.estimates.find(item=>item.weeks===weeks)!.value)} {unit} by {dateLabel(original.estimates.find(item=>item.weeks===weeks)!.date)}. Current recorded values appear on their actual dates{actual.length?'; gaps have no estimated observations.':'; there are no current readings to compare.'}</p>
        {estimate&&<p className="outlook-transparency">Current projection: {number(estimate.value)} {unit} by {dateLabel(estimate.date)} ({number(estimate.low)}–{number(estimate.high)} {unit}).</p>}
        {!estimate&&<p className="outlook-transparency">A current projection is unavailable because {projection.reason.toLowerCase()}</p>}
      </>}
      {!original&&<p className="outlook-message">No saved forecast yet. Open this outlook when there is enough history; a snapshot is saved only when the current outlook is ready.</p>}
      {historyError&&<p className="outlook-save-error" role="status">{historyError}</p>}
      <p className="outlook-message">{projection.reason}</p>
      {view==='lifts'&&<p className="outlook-lift-note">This follows the heaviest recorded working set, using the logged load convention for this exercise. More reps at the same load also count as progress. This does not estimate maximum strength.</p>}
      <p className="outlook-method">Extends the recorded trend from each issue date. Ranges widen with time and variation; they are scenario ranges, not confidence intervals or targets.</p>
    </div>
  </details>;
}
