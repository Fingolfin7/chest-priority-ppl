import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {qrFrameRegion,nativeQrDetector,readQrFrame} from '../src/qrFrame.ts';

test('portrait camera crop retains sensor detail and full-frame fallback remains bounded',()=>{
  assert.deepEqual(qrFrameRegion(720,1280,true),{x:0,y:280,width:720,height:720,outputWidth:720,outputHeight:720});
  assert.deepEqual(qrFrameRegion(1080,1920,true),{x:0,y:420,width:1080,height:1080,outputWidth:1080,outputHeight:1080});
  assert.deepEqual(qrFrameRegion(1080,1920,false),{x:0,y:0,width:1080,height:1920,outputWidth:720,outputHeight:1280});
  assert.deepEqual(qrFrameRegion(1920,1080,true),{x:420,y:0,width:1080,height:1080,outputWidth:1080,outputHeight:1080});
});

test('native detection is optional and unsupported formats safely fall back',async()=>{
  const original=globalThis.BarcodeDetector;
  try {
    delete globalThis.BarcodeDetector;assert.equal(await nativeQrDetector(),undefined);
    globalThis.BarcodeDetector=class {static async getSupportedFormats(){return ['ean_13'];}};
    assert.equal(await nativeQrDetector(),undefined);
    globalThis.BarcodeDetector=class {static async getSupportedFormats(){throw Error('Unavailable');}};
    assert.equal(await nativeQrDetector(),undefined);
    globalThis.BarcodeDetector=class {static async getSupportedFormats(){return ['qr_code'];}constructor(options){assert.deepEqual(options.formats,['qr_code']);}async detect(){return[];}};
    assert.ok(await nativeQrDetector());
  } finally {if(original)globalThis.BarcodeDetector=original;else delete globalThis.BarcodeDetector;}
});

test('native reader receives the portrait crop and can return a code outside its guide',async()=>{
  const calls=[],canvas={width:0,height:0},context={drawImage(...args){calls.push(args);},getImageData(){return {data:new Uint8ClampedArray(16),width:2,height:2};}};
  const video={videoWidth:720,videoHeight:1280};let attempts=0;
  const result=await readQrFrame(video,canvas,context,{async detect(){return ++attempts===2?[{rawValue:'outside-guide'}]:[];}});
  assert.equal(result,'outside-guide');assert.equal(calls.length,2);
  assert.deepEqual(calls[0].slice(1,5),[0,280,720,720]);
  assert.deepEqual(calls[1].slice(1,5),[0,0,720,1280]);
});

test('pixel decoding still reads a QR when native detection throws',async()=>{
  const text='rolling-ppl-pixel-fallback',modules=QRCode.create(text).modules,side=(modules.size+8)*4;
  const data=new Uint8ClampedArray(side*side*4).fill(255);
  for(let y=0;y<modules.size;y++)for(let x=0;x<modules.size;x++)if(modules.get(y,x))for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++){
    const index=(((y+4)*4+dy)*side+(x+4)*4+dx)*4;data[index]=data[index+1]=data[index+2]=0;
  }
  const result=await readQrFrame({videoWidth:side,videoHeight:side},{},{drawImage(){},getImageData(){return{data,width:side,height:side};}},{async detect(){throw Error('Frame unsupported');}});
  assert.equal(result,text);
});
