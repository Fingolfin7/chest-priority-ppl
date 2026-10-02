import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySyncSnapshot } from '../src/peerSyncModel.ts';
import { mergeBackupSnapshot, validateBackupSnapshot } from '../src/backupBundle.ts';
import {emptyBodyProgress} from '../src/bodyProgressModel.ts';

const workout = (id) => ({ id, workout:'push', startedAt:'2026-09-01T08:00:00Z', endedAt:'2026-09-01T09:00:00Z', bodyweight:'64', note:'', exercises:[{ name:'Bench', priority:'must', sets:[{load:'60',reps:'6'}]}], sync:{status:'unsynced'} });
test('complete backup validation strips unrelated credentials and rejects broken data', () => {
  const clean = validateBackupSnapshot({ ...emptySyncSnapshot(), password:'secret', completed:[workout('one')] });
  assert.equal(clean.completed.length,1);
  assert.equal('password' in clean,false);
  assert.throws(() => validateBackupSnapshot({ completed:'bad' }), /invalid/);
  assert.throws(() => validateBackupSnapshot({ ...emptySyncSnapshot(), completed:[{...workout('one'),bodyweight:'bad'}] }), /invalid/);
});
test('restore merges records while preserving an existing active session and next selection', () => {
  const current = { ...emptySyncSnapshot(), completed:[workout('old')], activeWorkout:{id:'active',workout:'legs',startedAt:'2026-10-01T08:00:00Z'}, next:'legs' };
  const incoming = {...emptySyncSnapshot(), completed:[workout('new')]};
  const merged = mergeBackupSnapshot(current,incoming);
  assert.equal(merged.completed.length,2);
  assert.equal(merged.activeWorkout.id,'active');
  assert.equal(merged.next,'legs');
  assert.equal(mergeBackupSnapshot(merged,incoming).completed.length,2);
});
test('empty browser recovers active draft from complete backup', () => {
  const incoming = {...emptySyncSnapshot(), activeWorkout:{id:'active',workout:'pull',startedAt:'2026-10-01T08:00:00Z'}, drafts:{Row:[{load:'50',reps:'8'}]}};
  const restored = mergeBackupSnapshot(emptySyncSnapshot(),incoming);
  assert.equal(restored.activeWorkout.id,'active');
  assert.equal(restored.drafts.Row[0].load,'50');
});
test('restore keeps entered sets in a browser without completed history', () => {
  const current = {...emptySyncSnapshot(), drafts:{Bench:[{load:'50',reps:'8'}]}};
  const incoming = {...emptySyncSnapshot(), drafts:{Row:[{load:'60',reps:'9'}]}};
  assert.deepEqual(mergeBackupSnapshot(current,incoming).drafts,current.drafts);
});

test('complete backup body restore unions distinct records without reviving deleted readings',()=>{
  const record=id=>({id,date:'2026-09-20',kg:67,note:'',updatedAt:'2026-09-20T10:00:00.000Z'});
  const current={...emptySyncSnapshot(),bodyProgress:{...emptyBodyProgress(),weighIns:[record('current')],deletions:[{kind:'weight',id:'deleted',deletedAt:'2026-09-21T10:00:00.000Z'}]}};
  const incoming=validateBackupSnapshot({...emptySyncSnapshot(),bodyProgress:{...emptyBodyProgress(),weighIns:[record('restored'),record('deleted')]}});
  const restored=mergeBackupSnapshot(current,incoming);
  assert.deepEqual(restored.bodyProgress.weighIns.map(w=>w.id),['current','restored']);
  assert.deepEqual(mergeBackupSnapshot(restored,incoming).bodyProgress,restored.bodyProgress);
});
