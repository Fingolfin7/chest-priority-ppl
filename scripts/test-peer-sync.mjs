// Isolated Chrome contexts only: never opens a user's existing browser profile.
// npm install --no-save playwright, or set PLAYWRIGHT_MODULE to its index.mjs.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.SYNC_TEST_URL || 'http://127.0.0.1:4173/';
const output = 'outputs/peer-sync';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const pages = [];
const workout = (id, date) => ({ id, workout: 'push', startedAt: `${date}T05:00:00.000Z`, endedAt: `${date}T06:00:00.000Z`, bodyweight: '65', note: id, exercises: [{ name: 'Barbell bench press', priority: 'must', sets: [{load:'55',reps:'8'}] }], sync: {status:'unsynced'} });
const shared = workout('shared-session', '2026-09-01');
async function makePage(name, sessions, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width:390,height:844 } : {width:1280,height:900} });
  await context.addInitScript(({sessions,name}) => {
    if (localStorage.getItem('test-seeded')) return;
    localStorage.setItem('test-seeded', '1');
    localStorage.setItem('rolling-ppl-workouts-v2', JSON.stringify(sessions));
    localStorage.setItem('rolling-ppl-next-workout-v1', JSON.stringify('push'));
    if (name === 'Laptop test') localStorage.setItem('rolling-ppl-autumn-v1', JSON.stringify({ baseUrl:'https://example.invalid', token:'synthetic-local-only-token', username:'synthetic' }));
  }, {sessions,name});
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  // Production's first worker installation can reload the initial page.
  if (process.env.SYNC_TEST_PRODUCTION) {
    await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((_,reject) => setTimeout(() => reject(new Error('Service worker did not activate within 20 seconds')),20000))]));
    await page.waitForLoadState('networkidle');
  }
  await page.getByRole('button', {name:'Sync devices',exact:true}).click();
  await page.getByLabel('This browser name').fill(name);
  await page.getByRole('button', {name:'Save name',exact:true}).click();
  return page;
}
async function state(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('rolling-ppl-workouts-v2') || '[]')); }
async function waitFor(check, description, timeout=45000) {
  const until=Date.now()+timeout;
  while(Date.now()<until) { if(await check()) return; await new Promise(resolve=>setTimeout(resolve,150)); }
  throw new Error(`Timed out: ${description}`);
}
const open = async page => { if (!await page.getByRole('dialog',{name:'Device sync',exact:true}).isVisible()) await page.getByRole('button',{name:'Sync devices',exact:true}).click(); };
const close = page => page.getByRole('button',{name:'Close device sync',exact:true}).click();
const current = page => page.getByTestId('paired-device').filter({hasText:'Up to date'}).count();
try {
  const a=await makePage('Laptop test',[shared,workout('laptop-session','2026-09-02')]);
  const b=await makePage('Phone test',[shared,workout('phone-session','2026-09-03')],true);
  await a.getByRole('button',{name:'Add device',exact:true}).click();
  await a.getByLabel('Pairing link',{exact:true}).waitFor({timeout:30000});
  const invitation=await a.getByLabel('Pairing link',{exact:true}).inputValue();
  await b.goto(invitation);
  await b.getByRole('button',{name:'Pair this browser',exact:true}).waitFor();
  await waitFor(()=>new URL(b.url()).hash==='','pairing fragment removed');
  await b.reload();
  await b.getByRole('button',{name:'Pair this browser',exact:true}).waitFor();
  assert.equal((await b.getByLabel('Pairing link or code',{exact:true}).inputValue()).length>50,true);
  await b.getByRole('button',{name:'Pair this browser',exact:true}).click();
  await a.getByRole('button',{name:'Approve pairing',exact:true}).waitFor({timeout:45000});
  assert.equal((await state(a)).length,2); assert.equal((await state(b)).length,2);
  console.log('PASS: no data exchanged before approval');
  await a.getByRole('button',{name:'Approve pairing',exact:true}).click();
  await waitFor(async()=> (await state(a)).length===3 && (await state(b)).length===3 && await current(a) && await current(b),'initial union and durable acknowledgements');
  assert.deepEqual(await state(a),await state(b));
  assert.equal(await b.evaluate(()=>localStorage.getItem('rolling-ppl-autumn-v1')?.includes('synthetic-local-only-token')||false),false);
  console.log('PASS: authenticated WebRTC sync, union, deduplication, credentials remain local');
  await close(a); await close(b);
  await a.getByRole('button',{name:'Start push',exact:true}).click();
  await waitFor(()=>b.getByRole('button',{name:'Finish workout',exact:true}).isVisible(),'active workout propagation');
  const reps=page=>page.getByLabel(/Barbell bench press set 1 reps/);
  const load=page=>page.getByLabel(/Barbell bench press set 1 load/);
  await load(a).fill('57.5'); await reps(a).fill('8');
  await waitFor(async()=>await load(b).inputValue()==='57.5' && await reps(b).inputValue()==='8','live draft values');
  await open(a); await open(b);
  await waitFor(async()=>await current(a) && await current(b),'draft acknowledged');
  if (!process.env.SYNC_TEST_FINISH_ONLY) {
  await a.getByRole('button',{name:'Pause sync',exact:true}).click();
  await b.getByRole('button',{name:'Pause sync',exact:true}).click();
  await close(a); await close(b);
  await reps(a).fill('9'); await load(b).fill('60');
  await open(a); await open(b);
  await a.getByRole('button',{name:'Resume sync',exact:true}).click();
  await b.getByRole('button',{name:'Resume sync',exact:true}).click();
  await waitFor(async()=>await current(a) && await current(b),'offline different-field edits');
  assert.equal(await a.getByTestId('sync-conflict').count(),0);
  await close(a); await close(b);
  assert.equal(await reps(b).inputValue(),'9'); assert.equal(await load(a).inputValue(),'60');
  console.log('PASS: offline different-field edits merge');
  await open(a); await open(b);
  await a.getByRole('button',{name:'Pause sync',exact:true}).click(); await b.getByRole('button',{name:'Pause sync',exact:true}).click();
  await close(a); await close(b); await reps(a).fill('10'); await reps(b).fill('11');
  await open(a); await open(b);
  await a.getByRole('button',{name:'Resume sync',exact:true}).click(); await b.getByRole('button',{name:'Resume sync',exact:true}).click();
  await a.getByTestId('sync-conflict').waitFor({timeout:45000});
  await a.getByRole('button',{name:'Use 10',exact:true}).click();
  await waitFor(async()=>await current(a) && await current(b) && await b.getByTestId('sync-conflict').count()===0,'conflict resolution');
  await close(a); await close(b); assert.equal(await reps(a).inputValue(),'10'); assert.equal(await reps(b).inputValue(),'10');
  console.log('PASS: same-field conflict and explicit resolution converge');
  } else {
    await close(a); await close(b); await reps(a).fill('10');
    await waitFor(async()=>await reps(b).inputValue()==='10','latest set value');
  }
  const bench = page => page.getByRole('region',{name:'Progressive overload log for Barbell bench press',exact:true});
  await bench(a).getByRole('button',{name:'Save exercise',exact:true}).click();
  await waitFor(()=>bench(b).getByRole('button',{name:'Saved ✓',exact:true}).isVisible(),'exercise checkpoint');
  await a.getByRole('button',{name:'Finish workout',exact:true}).click();
  await a.getByLabel(/^Bodyweight/).fill('66.2');
  await a.getByLabel('Session note',{exact:true}).fill('Two browsers, one workout');
  await a.getByRole('button',{name:'Save workout',exact:true}).click();
  await waitFor(async()=> (await state(b)).length===4 && await b.getByRole('button',{name:'Start pull',exact:true}).isVisible(),'completed workout and next sequence');
  const finished=(await state(b)).find(s=>s.note==='Two browsers, one workout');
  assert.equal(finished.bodyweight,'66.2'); assert.equal(finished.exercises[0].sets[0].reps,'10');
  console.log('PASS: exercise checkpoint, finish, bodyweight, note and next workout sync');
  await b.reload(); await b.getByRole('button',{name:'Sync devices',exact:true}).click(); await open(a);
  await waitFor(async()=>await current(a) && await current(b),'reload reconnect');
  assert.equal((await state(b)).length,4);
  await b.screenshot({path:`${output}/mobile-sync.png`});
  await b.setViewportSize({width:320,height:800});
  assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await b.getByRole('dialog',{name:'Device sync',exact:true}).evaluate(el=>el.scrollWidth>el.clientWidth),false);
  await b.screenshot({path:`${output}/mobile-320-sync.png`});
  await a.screenshot({path:`${output}/desktop-sync.png`});
  console.log('PASS: persisted identity, reconnect, 320px/390px layout');
  await a.getByRole('button',{name:'Remove device',exact:true}).click();
  await waitFor(async()=>await a.getByTestId('paired-device').count()===0 && (await b.getByTestId('peer-sync-status').innerText()).includes('was removed'),'device removal');
  assert.equal((await state(b)).length,4);
  console.log('PASS: removal disconnects peer and retains local workouts');
  if (process.env.SYNC_TEST_PRODUCTION) {
    await b.context().setOffline(true); await b.reload();
    await b.getByRole('button',{name:'Start pull',exact:true}).waitFor();
    assert.equal((await state(b)).length,4);
    console.log('PASS: production service worker loads full local workout copy offline');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: no browser runtime errors');
} catch(error) {
  for(let i=0;i<pages.length;i++) { await pages[i].screenshot({path:`${output}/failure-${i}.png`}).catch(()=>{}); console.error(`Browser ${i}:`,await pages[i].getByTestId('peer-sync-status').innerText().catch(()=>'')); }
  console.error('Browser errors:',errors);
  for(const page of pages) console.error('Page text:',(await page.locator('body').innerText()).slice(0,1000));
  throw error;
} finally { await browser.close(); }
