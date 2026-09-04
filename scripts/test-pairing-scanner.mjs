// Exercises real pixel decoding and WebRTC using a synthetic camera; no webcam access.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import QRCode from 'qrcode';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url=process.env.SYNC_TEST_URL || 'http://127.0.0.1:4174/';
await mkdir('outputs/peer-scanner',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
async function until(check,label,timeout=40000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error(`Timed out: ${label}`);}
const contexts=[];
try {
  const aContext=await browser.newContext(),bContext=await browser.newContext({viewport:{width:390,height:844}});
  contexts.push(aContext,bContext);
  await aContext.addInitScript(()=>{if(!localStorage.getItem('scanner-seeded')){localStorage.setItem('scanner-seeded','1');localStorage.setItem('rolling-ppl-next-workout-v1','"legs"');}});
  await bContext.addInitScript(()=>{
    if(!navigator.mediaDevices)return;
    window.testCameraMode='normal';window.testCameraStreams=[];window.testCameraRequests=0;
    navigator.mediaDevices.getUserMedia=async()=>{
      window.testCameraRequests++;
      if(window.testCameraMode==='denied')throw new DOMException('Test denied','NotAllowedError');
      const canvas=document.createElement('canvas');canvas.width=960;canvas.height=720;
      const ctx=canvas.getContext('2d');let img;
      const paint=()=>{ctx.fillStyle='white';ctx.fillRect(0,0,960,720);if(img){ctx.imageSmoothingEnabled=false;ctx.drawImage(img,200,80,560,560);}};
      paint();const stream=canvas.captureStream(10);window.testCameraStreams.push(stream);
      const timer=setInterval(()=>{if(stream.getTracks().every(t=>t.readyState==='ended'))clearInterval(timer);else paint();},100);
      window.testCameraShow=async data=>{img=new Image();img.src=data;await img.decode();paint();};
      if(window.testCameraMode==='pending')await new Promise(resolve=>{window.testCameraGrant=resolve;});
      return stream;
    };
  });
  const a=await aContext.newPage(),b=await bContext.newPage();
  for(const page of [a,b]){page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.getByRole('button',{name:'Sync devices',exact:true}).click();}
  assert.equal(await b.evaluate(()=>window.testCameraRequests),0);
  await b.evaluate(()=>window.testCameraMode='denied');
  await b.getByRole('button',{name:'Scan QR code',exact:true}).click();
  await b.getByText(/Camera access is blocked/).waitFor();
  await b.getByRole('button',{name:'Close scanner',exact:true}).click();
  console.log('PASS: camera requested only on tap, permission denial stays recoverable');
  await b.evaluate(()=>window.testCameraMode='pending');
  await b.getByRole('button',{name:'Scan QR code',exact:true}).click();
  await until(()=>b.evaluate(()=>typeof window.testCameraGrant==='function'),'pending camera request');
  await b.getByRole('button',{name:'Close scanner',exact:true}).click();
  await b.evaluate(()=>window.testCameraGrant());
  await until(()=>b.evaluate(()=>window.testCameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),'late camera permission cleaned up');
  console.log('PASS: closing scanner before camera permission resolves stops late stream');
  await b.evaluate(()=>window.testCameraMode='normal');
  await b.getByRole('button',{name:'Scan QR code',exact:true}).click();
  await b.getByText(/Point at your other device/).waitFor();
  await b.getByRole('button',{name:'Close device sync',exact:true}).click();
  await until(()=>b.evaluate(()=>window.testCameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),'dialog close stops camera');
  await b.getByRole('button',{name:'Sync devices',exact:true}).click();
  await a.getByRole('button',{name:'Show my QR',exact:true}).click();
  const qr=a.getByAltText('QR code for pairing this browser');await qr.waitFor({timeout:30000});
  const picture=await qr.getAttribute('src');
  await b.getByRole('button',{name:'Scan QR code',exact:true}).click();
  await b.getByText(/Point at your other device/).waitFor();
  await b.evaluate(data=>window.testCameraShow(data),await QRCode.toDataURL('https://example.invalid/not-a-device'));
  await b.getByText(/Point at the QR shown in Rolling PPL/).waitFor();
  assert.equal(await a.getByTestId('paired-device').count(),0);
  await b.screenshot({path:'outputs/peer-scanner/scanner.png'});
  await b.evaluate(data=>window.testCameraShow(data),picture);
  await until(async()=>await a.getByTestId('paired-device').filter({hasText:'Up to date'}).count()===1 && await b.getByTestId('paired-device').filter({hasText:'Up to date'}).count()===1,'automatic QR pairing and sync');
  assert.equal(await a.getByRole('button',{name:'Approve pairing',exact:true}).count(),0);
  assert.equal(await b.getByRole('region',{name:'Scan a device QR code',exact:true}).count(),0);
  assert.equal(await b.evaluate(()=>window.testCameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
  assert.equal(await b.evaluate(()=>JSON.parse(localStorage.getItem('rolling-ppl-next-workout-v1'))),'legs');
  assert.equal(await qr.count(),0);
  console.log('PASS: actual QR pixels decoded, devices automatically linked, data synced, camera stopped');
  await b.setViewportSize({width:320,height:800});
  assert.equal(await b.getByRole('dialog',{name:'Device sync',exact:true}).evaluate(el=>el.scrollWidth>el.clientWidth),false);
  await b.screenshot({path:'outputs/peer-scanner/linked-320.png'});
  await a.getByRole('button',{name:'Show my QR',exact:true}).click();await qr.waitFor();
  await a.getByRole('button',{name:'Close device sync',exact:true}).click();
  await a.getByRole('button',{name:'Sync devices',exact:true}).click();
  assert.equal(await qr.count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: 320px layout, closing QR cancels invitation, no runtime errors');
} catch(error){for(let i=0;i<contexts.length;i++)for(const p of contexts[i].pages()){await p.screenshot({path:`outputs/peer-scanner/failure-${i}.png`}).catch(()=>{});console.error((await p.locator('body').innerText()).slice(0,1500));}throw error;}
finally{await browser.close();}
