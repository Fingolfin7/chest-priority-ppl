import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerSyncManager } from '../src/peerSyncManager.ts';
import { emptySyncSnapshot } from '../src/peerSyncModel.ts';

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
