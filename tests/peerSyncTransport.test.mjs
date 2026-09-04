import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createIdentity, createInvitation, parseInvitation, randomToken } from '../src/peerSyncCrypto.ts';
import { PeerSyncTransport } from '../src/peerSyncTransport.ts';

class MemoryConnection extends EventEmitter {
  open = true;
  label = 'rolling-ppl-sync-v1';
  dataChannel = { bufferedAmount: 0 };
  sent = [];
  constructor(peer) { super(); this.peer = peer; }
  send(data) { this.sent.push(data); queueMicrotask(() => { if (this.other.open) this.other.emit('data', data); }); }
  close() { if (!this.open) return; this.open = false; this.emit('close'); if (this.other.open) { this.other.open = false; this.other.emit('close'); } }
}
async function eventually(check) {
  for (let tries = 0; tries < 100 && !check(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'Expected transport event was not delivered.');
}
function fixture(identity) {
  const events = { requests: [], paired: [], connected: [], messages: [], statuses: [] };
  const transport = new PeerSyncTransport({ identity, name: identity.id.slice(-8), devices: [],
    onStatus: status => events.statuses.push(status), onPairRequest: request => events.requests.push(request),
    onPaired: device => events.paired.push(device), onConnected: id => events.connected.push(id),
    onDisconnected: () => {}, onMessage: (id, bytes) => events.messages.push({ id, bytes }),
  });
  return { transport, events, identity };
}
function wire(inviter, joiner, invite) {
  const incoming = new MemoryConnection(joiner.identity.id), outgoing = new MemoryConnection(inviter.identity.id);
  incoming.other = outgoing; outgoing.other = incoming;
  inviter.transport.attach(incoming, false);
  joiner.transport.attach(outgoing, true, invite);
  incoming.emit('open'); outgoing.emit('open');
  return { incoming, outgoing };
}

test('transport gates approval, chunks transfers and disconnects removed peers', async t => {
  const [alice, bob] = await Promise.all([createIdentity(), createIdentity()]);
  const a = fixture(alice), b = fixture(bob);
  t.after(() => { a.transport.stop(); b.transport.stop(); });
  const invite = await parseInvitation(createInvitation(alice));
  a.transport.invite = invite;
  wire(a, b, invite);
  await eventually(() => a.events.requests.length === 1);
  assert.equal(a.events.connected.length + b.events.connected.length, 0);
  assert.equal(a.events.messages.length + b.events.messages.length, 0);
  await assert.rejects(b.transport.send(alice.id, new Uint8Array([1])), /disconnected/);
  await a.transport.approvePair(bob.id);
  await eventually(() => b.events.connected.length === 1);
  assert.equal(a.events.paired[0].id, bob.id);
  assert.equal(b.events.paired[0].id, alice.id);
  assert.equal(a.transport.invite, undefined);
  const large = new Uint8Array(100_000); large[99_999] = 123;
  await b.transport.send(alice.id, large);
  await eventually(() => a.events.messages.length === 1);
  assert.deepEqual(a.events.messages[0].bytes, large);
  await a.transport.send(bob.id, new Uint8Array([9, 8, 7]));
  await eventually(() => b.events.messages.length === 1);
  assert.deepEqual(b.events.messages[0].bytes, new Uint8Array([9, 8, 7]));
  a.transport.setDevices([]);
  await assert.rejects(a.transport.send(bob.id, large), /disconnected/);
});

test('unknown identity without invitation receives no workout data', async t => {
  const [alice, stranger] = await Promise.all([createIdentity(), createIdentity()]);
  const a = fixture(alice), b = fixture(stranger);
  t.after(() => { a.transport.stop(); b.transport.stop(); });
  const { incoming } = wire(a, b);
  await eventually(() => !incoming.open);
  assert.equal(a.events.requests.length + a.events.messages.length + a.events.connected.length, 0);
  assert.equal(incoming.sent.length, 0);
  assert.ok(a.events.statuses.some(status => status.includes('not been paired')));
});

test('encrypted workout frames cannot bypass pairing approval', async t => {
  const [alice, bob] = await Promise.all([createIdentity(), createIdentity()]);
  const a = fixture(alice), b = fixture(bob);
  t.after(() => { a.transport.stop(); b.transport.stop(); });
  const invite = await parseInvitation(createInvitation(alice)); a.transport.invite = invite;
  const { outgoing } = wire(a, b, invite);
  await eventually(() => a.events.requests.length === 1);
  const state = b.transport.connections.get(alice.id);
  const frame = await state.channel.seal({ kind: 'chunk', id: randomToken(), index: 0, total: 1, data: 'AQ' });
  outgoing.send(JSON.stringify(frame));
  await eventually(() => !outgoing.open);
  assert.equal(a.events.messages.length, 0);
  assert.ok(a.events.statuses.some(status => status.includes('before pairing was approved')));
});

test('closing a connection during decryption discards its pending message', async t => {
  const [alice, bob] = await Promise.all([createIdentity(), createIdentity()]);
  const a = fixture(alice), b = fixture(bob);
  t.after(() => { a.transport.stop(); b.transport.stop(); });
  const invite = await parseInvitation(createInvitation(alice)); a.transport.invite = invite;
  wire(a, b, invite);
  await eventually(() => a.events.requests.length === 1);
  await a.transport.approvePair(bob.id);
  await eventually(() => b.events.connected.length === 1);
  const state = a.transport.connections.get(bob.id);
  let decrypted;
  state.channel.open = () => new Promise(resolve => { decrypted = resolve; });
  const delivery = a.transport.receive(state, JSON.stringify({ v: 1, type: 'sealed' }));
  a.transport.disconnect(bob.id);
  decrypted({ kind: 'chunk', id: randomToken(), index: 0, total: 1, data: 'AQ' });
  await delivery;
  assert.equal(a.events.messages.length, 0);
  assert.equal(state.active, false);
});

test('automatic QR invitation authenticates, links once, and transfers without an approval prompt', async t => {
  const [alice,bob,stranger] = await Promise.all([createIdentity(),createIdentity(),createIdentity()]);
  const a=fixture(alice),b=fixture(bob),c=fixture(stranger);
  t.after(()=>{a.transport.stop();b.transport.stop();c.transport.stop();});
  a.transport.ready=async()=>{};
  const invite=await parseInvitation(await a.transport.createInvite(true));
  wire(a,b,invite);
  await eventually(()=>a.events.connected.length===1 && b.events.connected.length===1);
  assert.equal(a.events.requests.length,0);
  assert.equal(a.transport.invite,undefined);
  assert.equal(a.transport.autoApproveInvite,undefined);
  await b.transport.send(alice.id,new Uint8Array([42]));
  await eventually(()=>a.events.messages.length===1);
  const {outgoing}=wire(a,c,invite);
  await eventually(()=>!outgoing.open);
  assert.equal(c.events.paired.length,0);
  assert.equal(a.events.paired.length,1);
});

test('automatic QR pairing still rejects the wrong secret and cancelled codes', async t => {
  const [alice,bob] = await Promise.all([createIdentity(),createIdentity()]);
  const a=fixture(alice),b=fixture(bob);
  t.after(()=>{a.transport.stop();b.transport.stop();});
  a.transport.ready=async()=>{};
  const invite=await parseInvitation(await a.transport.createInvite(true));
  const wrong=wire(a,b,{...invite,secret:randomToken()});
  await eventually(()=>!wrong.outgoing.open);
  assert.equal(a.events.paired.length,0);
  a.transport.cancelInvite();
  const cancelled=wire(a,b,invite);
  await eventually(()=>!cancelled.outgoing.open);
  assert.equal(a.events.paired.length,0);
  assert.equal(a.transport.autoApproveInvite,undefined);
});

test('manual invitations do not inherit automatic approval from a replaced QR', async t => {
  const [alice,bob] = await Promise.all([createIdentity(),createIdentity()]);
  const a=fixture(alice),b=fixture(bob);
  t.after(()=>{a.transport.stop();b.transport.stop();});
  a.transport.ready=async()=>{};
  const old=await parseInvitation(await a.transport.createInvite(true));
  const manual=await parseInvitation(await a.transport.createInvite());
  assert.equal(a.transport.autoApproveInvite,undefined);
  const stale=wire(a,b,old);
  await eventually(()=>!stale.outgoing.open);
  assert.equal(a.events.requests.length,0);
  wire(a,b,manual);
  await eventually(()=>a.events.requests.length===1);
  assert.equal(a.events.connected.length,0);
});
