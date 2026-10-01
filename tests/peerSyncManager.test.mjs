import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerSyncManager } from '../src/peerSyncManager.ts';
import { emptySyncSnapshot } from '../src/peerSyncModel.ts';
import * as A from '@automerge/automerge';
import { projectSyncDoc, updateSyncDoc } from '../src/peerSyncModel.ts';
import { recoverySnapshots } from '../src/recoveryJournal.ts';

function typingManager(t) {
  const writes = new Map();
  const storageDescriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{setItem:(key,value)=>writes.set(key,value)}});
  const initial = emptySyncSnapshot();
  initial.activeWorkout = { id:'active',workout:'push',startedAt:'2026-10-01T12:00:00Z' };
  initial.drafts = { Bench: [{load:'50',reps:'8'}] };
  const manager = new PeerSyncManager(initial);
  manager.schedule = () => {};
  t.after(() => {
    manager.listeners.clear(); manager.flushPendingInputs();
    if (storageDescriptor) Object.defineProperty(globalThis,'localStorage',storageDescriptor);
    else delete globalThis.localStorage;
  });
  return { manager, writes };
}

test('typing updates immediately without replicating or notifying device-sync views per key', t => {
  const { manager, writes } = typingManager(t);
  const originalDoc = manager.doc;
  const history = manager.getSnapshot().history;
  let renders=0;
  manager.subscribe(() => renders++);
  manager.subscribeView(() => assert.fail('Typing scanned the sync view'));
  for (const note of ['a','ab','abc']) manager.set('sessionNote',note);
  assert.equal(manager.getSnapshot().sessionNote,'abc');
  assert.equal(manager.getSnapshot().history,history);
  assert.equal(manager.doc,originalDoc);
  assert.equal(renders,3);
  const journal=JSON.parse(writes.get('rolling-ppl-sync-recovery-v1'));
  assert.deepEqual(Object.keys(journal.after),['sessionNote']);
  assert.equal(journal.after.sessionNote,'abc');
});

test('the latest keystrokes recover even when the debounce never ran', t => {
  const { manager, writes } = typingManager(t);
  manager.set('drafts', drafts => ({ ...drafts, Bench: [{ ...drafts.Bench[0],reps:'12' }] }));
  manager.set('bodyweight','65.5');
  manager.set('sessionNote','Last character!');
  const disk=A.load(A.save(manager.doc));
  const recovery=recoverySnapshots(projectSyncDoc(disk),JSON.parse(writes.get('rolling-ppl-sync-recovery-v1')));
  const recovered=projectSyncDoc(updateSyncDoc(disk,recovery.before,recovery.after));
  assert.equal(recovered.drafts.Bench[0].reps,'12');
  assert.equal(recovered.bodyweight,'65.5');
  assert.equal(recovered.sessionNote,'Last character!');
});

test('saving or finishing commits pending typing before applying the next action', t => {
  const { manager }=typingManager(t);
  manager.set('sessionNote','Typed immediately before save');
  manager.change({...manager.getSnapshot(),next:'pull'});
  assert.equal(projectSyncDoc(manager.doc).sessionNote,'Typed immediately before save');
  assert.equal(projectSyncDoc(manager.doc).next,'pull');
  assert.equal(manager.inputBaseline,undefined);
  manager.set('sessionNote','Typed immediately before finish');
  manager.change({...manager.getSnapshot(),completed:[{id:'active',workout:'push',startedAt:'2026-10-01T12:00:00Z',endedAt:'2026-10-01T13:00:00Z',bodyweight:'',note:manager.getSnapshot().sessionNote,exercises:[{name:'Bench',priority:'must',sets:manager.getSnapshot().drafts.Bench}],sync:{status:'unsynced'}}],activeWorkout:null,drafts:{},sessionNote:''});
  assert.equal(projectSyncDoc(manager.doc).completed[0].note,'Typed immediately before finish');
  assert.equal(projectSyncDoc(manager.doc).activeWorkout,null);
});

test('compact and older full journals replay idempotently after the database already committed', t => {
  const { manager,writes }=typingManager(t);
  const before=structuredClone(manager.getSnapshot());
  manager.set('sessionNote','Recovered');
  const compact=JSON.parse(writes.get('rolling-ppl-sync-recovery-v1'));
  manager.flushPendingInputs();
  const disk=A.load(A.save(manager.doc));
  for (const journal of [compact,{before,after:manager.getSnapshot()}]) {
    const recovered=recoverySnapshots(projectSyncDoc(disk),journal);
    assert.deepEqual(A.getHeads(updateSyncDoc(disk,recovered.before,recovered.after)),A.getHeads(disk));
  }
});

test('typing coalesces until a pause and still commits during continuous typing', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const { manager }=typingManager(t);
  const originalDoc=manager.doc;
  for (let i=0;i<5;i++) { manager.set('sessionNote',`Typed ${i}`); t.mock.timers.tick(200); }
  assert.notEqual(manager.doc,originalDoc);
  assert.equal(projectSyncDoc(manager.doc).sessionNote,'Typed 4');
  manager.set('sessionNote','After a pause');
  const prior=manager.doc;
  t.mock.timers.tick(249);
  assert.equal(manager.doc,prior);
  t.mock.timers.tick(1);
  assert.equal(projectSyncDoc(manager.doc).sessionNote,'After a pause');
});

test('pause during a received removal save does not use the closed transport', async () => {
  const manager = new PeerSyncManager(emptySyncSnapshot());
  const transport = { setDevices() { assert.fail('Stale transport used after save'); } };
  manager.transport = transport;
  manager.connected.add('peer'); manager.epochs.set('peer',1);
  let committed;
  manager.persist = () => new Promise(resolve => { committed = resolve; });
  const delivery = manager.receive('peer', new Uint8Array([2,...new TextEncoder().encode('["removed-peer"]')]), transport,1);
  manager.transport = undefined;
  committed();
  await delivery;
  assert.equal(manager.revoked.has('removed-peer'),true);
});

test('queued messages from an earlier connection are discarded after reconnect', async () => {
  const manager = new PeerSyncManager(emptySyncSnapshot());
  const transport = {};
  manager.transport = transport; manager.connected.add('peer'); manager.epochs.set('peer',2);
  await manager.receive('peer',new Uint8Array([2,...new TextEncoder().encode('["removed-peer"]')]),transport,1);
  assert.equal(manager.revoked.size,0);
});
