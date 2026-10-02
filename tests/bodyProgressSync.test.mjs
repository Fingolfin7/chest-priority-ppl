import test from 'node:test';
import assert from 'node:assert/strict';
import {attachBodyProgressSync,emptyBodyProgress,exportBodyProgress,importBodyProgress,saveBodyProgress} from '../src/bodyProgressModel.ts';
import {PeerSyncManager} from '../src/peerSyncManager.ts';
import {emptySyncSnapshot,projectSyncDoc} from '../src/peerSyncModel.ts';

const weight=(id,kg=67,updatedAt='2026-09-20T10:00:00.000Z')=>({id,date:'2026-09-20',kg,note:'',updatedAt});

// Exercise the real storage API and bridge against an asynchronous transactional
// store. Only the browser's IndexedDB plumbing and durable sync save are replaced.
function harness(t,local=emptyBodyProgress(),synced=undefined) {
  let disk=structuredClone(local),writes=0,durable=0,events=0;
  const descriptors=new Map(['indexedDB','localStorage','window'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const database={close(){},transaction(){
    let aborted=false;
    const tx={objectStore(){return {
      get(){const request={};queueMicrotask(()=>{request.result=structuredClone(disk);request.onsuccess?.();queueMicrotask(()=>{if(!aborted)tx.oncomplete?.();});});return request;},
      put(value){disk=structuredClone(value);writes++;},
    };},abort(){aborted=true;tx.onabort?.();}};
    return tx;
  }};
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){const request={};queueMicrotask(()=>{request.result=database;request.onsuccess?.();});return request;}}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{setItem(){}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{dispatchEvent(){events++;}}});
  const manager=new PeerSyncManager({...emptySyncSnapshot(),...(synced?{bodyProgress:synced}:{})});
  manager.schedule=()=>{};
  manager.saveNow=async()=>{durable++;};
  t.after(()=>{for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return {manager,getDisk:()=>disk,getWrites:()=>writes,getDurable:()=>durable,getEvents:()=>events};
}

test('startup migrates standalone body data into initialized sync state and preserves peer deletion tombstones',async t=>{
  const local={...emptyBodyProgress(),weighIns:[weight('local'),weight('deleted')]};
  const peer={...emptyBodyProgress(),weighIns:[weight('peer',68)],deletions:[{kind:'weight',id:'deleted',deletedAt:'2026-09-21T10:00:00.000Z'}]};
  const h=harness(t,local,peer),detach=await attachBodyProgressSync(h.manager);
  t.after(detach);
  const body=await exportBodyProgress();
  assert.deepEqual(body.weighIns.map(w=>w.id),['local','peer']);
  assert.deepEqual(projectSyncDoc(h.manager.doc).bodyProgress,body);
  assert.deepEqual(h.getDisk(),body);
  assert.ok(h.getDurable()>=1);
  assert.ok(h.getWrites()<=2,'Migration must not cause an event feedback loop');
});

test('body save/import goes through manager and export flushes received body changes to its mirror',async t=>{
  const h=harness(t),detach=await attachBodyProgressSync(h.manager);
  t.after(detach);
  await saveBodyProgress({...emptyBodyProgress(),weighIns:[weight('saved')]});
  assert.equal(projectSyncDoc(h.manager.doc).bodyProgress.weighIns[0].id,'saved');
  await importBodyProgress({...emptyBodyProgress(),weighIns:[weight('imported',68)]});
  const body=await exportBodyProgress();
  assert.deepEqual(body.weighIns.map(w=>w.id),['imported','saved']);
  h.manager.set('bodyProgress',{...body,measurements:[{id:'peer-tape',date:'2026-09-20',chest:95,note:'',updatedAt:'2026-09-22T10:00:00.000Z'}]});
  const exported=await exportBodyProgress();
  assert.equal(exported.measurements[0].id,'peer-tape');
  assert.deepEqual(h.getDisk(),exported);
  assert.ok(h.getEvents()>0);
  assert.ok(h.getWrites()<10,'Mirror writes must stop without feeding a new manager edit');
});

test('durable sync failure rejects a body save while retaining the standalone recoverable copy',async t=>{
  const h=harness(t,{...emptyBodyProgress(),weighIns:[weight('existing')]});
  const detach=await attachBodyProgressSync(h.manager);t.after(detach);
  await exportBodyProgress();
  h.manager.saveNow=async()=>{throw new Error('Storage full');};
  await assert.rejects(saveBodyProgress({...emptyBodyProgress(),weighIns:[weight('new')]}),/Storage full/);
  assert.deepEqual(h.getDisk().weighIns.map(w=>w.id),['existing']);
});
