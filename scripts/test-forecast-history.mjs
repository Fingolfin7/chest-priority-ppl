import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyBodyProgress, localDay } from '../src/bodyProgressModel.ts';
import { createForecastSnapshot } from '../src/forecastHistory.ts';
import { emptySyncSnapshot } from '../src/peerSyncModel.ts';
import { projectLift, projectMeasurement, projectWeight } from '../src/projectionModel.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const output = join(process.cwd(), 'outputs', 'forecast-history');
await mkdir(output, { recursive: true });
const today = localDay();
const addDays = (base, offset) => new Date(Date.parse(`${base}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const issueData = (daysAgo) => {
  const cutoff = addDays(today, -daysAgo);
  const offsets = [-35, -28, -21, -14, -7, 0];
  const points = offsets.map((offset, index) => ({ date: addDays(cutoff, offset), value: 67 + index * .2 }));
  const tape = points.map((point, index) => ({ id: `tape-${daysAgo}-${index}`, date: point.date, chest: 94 + index * .2, note: '', updatedAt: `${point.date}T12:00:00.000Z` }));
  const sessions = points.map((point, index) => ({ id: `bench-${daysAgo}-${index}`, savedAt: `${point.date}T12:00:00.000Z`, sets: [{ load: String(50 + index * 2.5), reps: '8' }] }));
  const forecasts = [
    createForecastSnapshot({ kind: 'weight', targetId: 'weight', targetLabel: 'Bodyweight', unit: 'kg', observationCutoff: cutoff, issuedAt: `${cutoff}T12:00:00.000Z`, projection: projectWeight(points, cutoff) }),
    createForecastSnapshot({ kind: 'lift', targetId: 'Synthetic bench', targetLabel: 'Synthetic bench', unit: 'kg', observationCutoff: cutoff, issuedAt: `${cutoff}T12:00:00.000Z`, projection: projectLift({ 'Synthetic bench': sessions }, 'Synthetic bench', cutoff) }),
    createForecastSnapshot({ kind: 'measurement', targetId: 'chest', targetLabel: 'Chest', unit: 'cm', observationCutoff: cutoff, issuedAt: `${cutoff}T12:00:00.000Z`, projection: projectMeasurement(tape, 'chest', cutoff) }),
  ];
  assert.ok(forecasts.every(Boolean), `fixtures should have ready historical forecasts (cutoff ${cutoff})`);
  return { cutoff, forecasts, points, tape, sessions };
};

const readyIssue = issueData(21);
const nextIssue = issueData(14);
function backup(kind, data = readyIssue, includeCurrent = true, editIssue = false) {
  const body = emptyBodyProgress();
  const snapshot = emptySyncSnapshot();
  if (includeCurrent) {
    const currentOffsets = kind === 'ready' ? [-35, -28, -21, -14, -7, 0] : [0];
    body.weighIns = currentOffsets.map((offset, index) => ({ id: `weight-${offset}`, date: addDays(today, offset), kg: 68 + index * .1, note: '', updatedAt: new Date().toISOString() }));
    body.measurements = currentOffsets.map((offset, index) => ({ id: `measurement-${offset}`, date: addDays(today, offset), chest: 96 + index * .1, note: '', updatedAt: new Date().toISOString() }));
    snapshot.history = { 'Synthetic bench': currentOffsets.map((offset, index) => ({ id: `session-${offset}`, savedAt: `${addDays(today, offset)}T12:00:00.000Z`, sets: [{ load: String(65 + index * .5), reps: '8' }] })) };
    snapshot.bodyProgress = body;
  }
  const forecasts = data.forecasts.map(forecast => ({ ...forecast, ...(editIssue ? { reason: 'Changed by later backup' } : {}) }));
  return { schema: 'rolling-ppl-complete-backup', version: 1, photosIncluded: false, body, snapshot, photos: { schema: 'rolling-ppl-progress-photos', version: 1, photos: [] }, forecastHistory: { schemaVersion: 1, snapshots: forecasts } };
}

async function restoreBackup(page, payload) {
  await page.locator('.export-menu > summary').click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByLabel('Choose complete backup', { exact: true }).setInputFiles({ name: 'synthetic-forecasts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await page.getByText('Backup checked. Review its contents before restoring.').waitFor();
  await page.getByRole('button', { name: 'Restore this backup', exact: true }).click();
  await page.getByText(/Backup restored\./).waitFor();
  await page.locator('.export-menu > summary').click();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
}

async function newPage(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.PROGRESS_TEST_URL || 'http://127.0.0.1:4187/');
  await page.getByRole('button', { name: 'Progress', exact: true }).waitFor();
  return { context, page, errors };
}

async function openComparison(page) {
  const outlook = page.locator('.progress-outlook');
  await outlook.locator(':scope > summary').click();
  await outlook.locator('.outlook-compare select').waitFor();
  return outlook;
}

try {
  const ready = await newPage({ width: 1280, height: 900 });
  await restoreBackup(ready.page, backup('ready'));
  let outlook = await openComparison(ready.page);
  assert.equal(await outlook.locator('.outlook-original-forecast').count(), 1);
  assert.equal(await outlook.locator('.outlook-projected').count(), 1);
  assert.equal(await outlook.locator('.outlook-dot').count(), 6);
  assert.match(await outlook.locator('.outlook-transparency').first().innerText(), /Original issued/);
  assert.equal(await ready.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ready.page.screenshot({ path: join(output, 'comparison-desktop.png'), fullPage: true });
  await ready.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await ready.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ready.page.screenshot({ path: join(output, 'comparison-mobile.png'), fullPage: true });

  const first = readyIssue.forecasts[0];
  const originalEstimate = first.estimates.find(item => item.weeks === 3).value;
  const alteredBackup = backup('ready', { ...nextIssue, forecasts: [...readyIssue.forecasts.map(item => ({ ...item })), ...nextIssue.forecasts] }, true, true);
  await restoreBackup(ready.page, alteredBackup);
  await ready.page.locator('.export-menu > summary').click();
  await ready.page.getByRole('button', { name: 'Backup', exact: true }).click();
  const [download] = await Promise.all([
    ready.page.waitForEvent('download'),
    ready.page.getByRole('button', { name: 'Download complete backup', exact: true }).click(),
  ]);
  const exportedPath = join(output, 'synthetic-complete-backup.json');
  await download.saveAs(exportedPath);
  const savedBeforeReload = JSON.parse(await readFile(exportedPath, 'utf8')).forecastHistory;
  assert.ok(savedBeforeReload.snapshots.filter(item => item.targetId === 'weight').length >= 2);
  assert.equal(savedBeforeReload.snapshots.find(item => item.id === first.id).estimates.find(item => item.weeks === 3).value, originalEstimate);
  assert.equal(savedBeforeReload.snapshots.find(item => item.id === first.id).reason, first.reason, 'import cannot rewrite the original issue');
  await ready.page.reload();
  outlook = await openComparison(ready.page);
  assert.ok(await outlook.locator('.outlook-compare option').count() >= 2, 'the merged issue and prior issue survive a reload');
  assert.deepEqual(ready.errors, []);
  await ready.context.close();
  console.log('PASS: ready comparison has recorded, original and current curves; backup merge preserves issued values across reload.');

  for (const [name, includeCurrent] of [['sparse', true], ['empty', false]]) {
    const test = await newPage({ width: 390, height: 844 });
    const data = issueData(21);
    await restoreBackup(test.page, backup(name, data, includeCurrent));
    outlook = await openComparison(test.page);
    await outlook.getByRole('button', { name: 'Lifts', exact: true }).click();
    await outlook.getByRole('combobox', { name: /^Exercise/ }).selectOption('Synthetic bench');
    await outlook.locator('.outlook-original-forecast').waitFor();
    assert.equal(await outlook.getByRole('combobox', { name: /^Exercise/ }).isEnabled(), true, `${name} forecast target remains selectable`);
    assert.equal(await outlook.locator('.outlook-projected').count(), 0, `${name} current projection is unavailable`);
    if (includeCurrent) assert.ok(await outlook.locator('.outlook-dot').count() > 0);
    else assert.equal(await outlook.locator('.outlook-dot').count(), 0);
    assert.equal(await test.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(test.errors, []);
    await test.context.close();
    console.log(`PASS: ${name} current history retains a visible original forecast and accurate recorded series.`);
  }
} finally {
  await browser.close();
}
