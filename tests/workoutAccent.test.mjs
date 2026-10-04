import assert from 'node:assert/strict';
import test from 'node:test';
import { workoutAccent } from '../src/workoutAccent.ts';

test('workouts take distinct accents from their programme position, with free sessions after them', () => {
  assert.deepEqual(['push', 'pull', 'legs'].map((key) => workoutAccent(key, ['push', 'pull', 'legs'])), ['accent-1', 'accent-2', 'accent-3']);
  assert.deepEqual(['upper', 'lower'].map((key) => workoutAccent(key, ['upper', 'lower'])), ['accent-1', 'accent-2']);
  assert.equal(workoutAccent('free-session', ['push', 'pull', 'legs'], true), 'accent-4');
  assert.equal(workoutAccent('w7', ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']), 'accent-1');
  // A workout from an older programme keeps a stable colour.
  assert.equal(workoutAccent('retired', ['push']), workoutAccent('retired', ['push']));
  assert.match(workoutAccent('retired', ['push']), /^accent-[1-6]$/);
});
