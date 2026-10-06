import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPhotoCheckInPreferences, nextScheduledCheckIn, parsePhotoCheckInPreferences, photoCheckInDue, skipPhotoCheckIn } from '../src/photoCheckInModel.ts';

const prefs = defaultPhotoCheckInPreferences();

test('scheduled check-ins fall due two weeks after the latest photo by default', () => {
  const dates = ['2026-09-01', '2026-09-20', '2026-09-20'];
  assert.equal(nextScheduledCheckIn(dates, prefs), '2026-10-04');
  assert.equal(photoCheckInDue(dates, [], prefs, '2026-10-03'), null);
  assert.deepEqual(photoCheckInDue(dates, [], prefs, '2026-10-04'), { kind: 'interval', key: '2026-10-04', dueOn: '2026-10-04', lastPhoto: '2026-09-20' });
  assert.equal(photoCheckInDue(dates, [], { ...prefs, intervalDays: 28 }, '2026-10-04'), null);
  assert.equal(photoCheckInDue([], [], prefs, '2026-10-04'), null, 'the empty state covers a first check-in');
});

test('a sustained milestone adds a check-in unless a photo already covers its 7-day average', () => {
  const milestones = [{ target: 78, sustained: '2026-10-01' }, { target: 77, sustained: null }];
  assert.deepEqual(photoCheckInDue(['2026-09-20'], milestones, prefs, '2026-10-02'), { kind: 'milestone', key: '78:2026-10-01', target: 78, sustained: '2026-10-01' });
  assert.equal(photoCheckInDue(['2026-09-25'], milestones, prefs, '2026-10-02'), null);
  assert.equal(photoCheckInDue(['2026-09-20'], milestones, prefs, '2026-10-15').kind, 'interval', 'stale milestones give way to the schedule');
  assert.equal(photoCheckInDue([], milestones, prefs, '2026-10-02').kind, 'milestone');
});

test('skipping clears the current check-in and restarts the schedule from today', () => {
  const milestones = [{ target: 78, sustained: '2026-10-01' }];
  const due = photoCheckInDue(['2026-09-01'], milestones, prefs, '2026-10-02');
  const skipped = skipPhotoCheckIn(prefs, due, '2026-10-02');
  assert.equal(photoCheckInDue(['2026-09-01'], milestones, skipped, '2026-10-02'), null);
  assert.equal(nextScheduledCheckIn(['2026-09-01'], skipped), '2026-10-16');
  assert.equal(photoCheckInDue(['2026-09-01'], milestones, skipped, '2026-10-16').kind, 'interval');
  assert.equal(nextScheduledCheckIn(['2026-10-10'], skipped), '2026-10-24', 'new photos take over from the skip');
});

test('reminders can be turned off and stored preferences are validated', () => {
  const off = { ...prefs, intervalDays: 0 };
  assert.equal(photoCheckInDue(['2026-01-01'], [{ target: 78, sustained: '2026-10-01' }], off, '2026-10-02'), null);
  assert.equal(nextScheduledCheckIn(['2026-01-01'], off), null);
  assert.deepEqual(parsePhotoCheckInPreferences(null), prefs);
  assert.deepEqual(parsePhotoCheckInPreferences({ intervalDays: 0, skippedOn: 'soon', skippedMilestones: ['78:2026-10-01', 5] }), { intervalDays: 0, skippedMilestones: ['78:2026-10-01'] });
  assert.equal(parsePhotoCheckInPreferences({ intervalDays: 3 }).intervalDays, 14);
});
