// Isolated synthetic projection and custom-programme UI checks.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {emptySyncSnapshot} from '../src/peerSyncModel.ts';
import {emptyBodyProgress} from '../src/bodyProgressModel.ts';
await mkdir('outputs/body-progress',{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844}});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(process.env.PROGRESS_TEST_URL||'http://127.0.0.1:4187/');
 await page.getByRole('button',{name:'Plan',exact:true}).click();
 await page.getByRole('button',{name:'New programme',exact:true}).click();
 await page.getByRole('button',{name:/Build your own/}).click();
 await page.getByLabel('Programme name',{exact:true}).fill('Two day strength');
 await page.getByLabel('Phase focus',{exact:true}).fill('Build a base');
 await page.getByRole('button',{name:'Review workouts',exact:true}).click();
 await page.getByLabel('Exercise name',{exact:true}).first().fill('Test press');
 await page.getByText('Names and workout order (1)',{exact:true}).click();
 await page.getByLabel('Workout 1 name',{exact:true}).fill('Strength A');
 await page.getByRole('button',{name:'Add workout',exact:true}).click();
 await page.getByLabel('Workout 2 name',{exact:true}).fill('Strength B');
 await page.getByLabel('Exercise name',{exact:true}).first().fill('Test row');
 await page.getByRole('button',{name:'Save and start phase',exact:true}).click();
 await page.getByText('New phase saved. It applies to your next workout.',{exact:true}).waitFor();
 await page.screenshot({path:'outputs/body-progress/custom-program-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Train',exact:true}).click();
 await page.getByRole('button',{name:'Start Strength A',exact:true}).click();
 await page.getByLabel(/Test press set 1 load/).fill('30');
 await page.getByLabel('Test press set 1 reps',{exact:true}).fill('8');
 await page.getByRole('button',{name:'Finish workout',exact:true}).click();
 await page.getByRole('button',{name:'Save workout',exact:true}).click();
 await page.getByRole('button',{name:'Start Strength B',exact:true}).waitFor();
 await page.reload();
 await page.getByRole('button',{name:'Start Strength B',exact:true}).waitFor();
 console.log('PASS: arbitrary named programme, workout completion and persisted sequence');
 const backup={schema:'rolling-ppl-complete-backup',version:1,body:emptyBodyProgress(),snapshot:emptySyncSnapshot(),photosIncluded:false,photos:{schema:'rolling-ppl-progress-photos',version:1,photos:[]}};
 const today=new Date();
 const ago=n=>{const date=new Date(today);date.setDate(date.getDate()-n);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
 backup.body.measurements=[0,7,14,21,28].map((n,i)=>({id:`tape-${i}`,date:ago(n),chest:96-i*.3,waist:78-i*.1,note:'Synthetic UI test',updatedAt:today.toISOString()}));
 backup.body.weighIns=[0,3,6,9,12,15,18,21].map((n,i)=>({id:`weight-${i}`,date:ago(n),kg:66-i*.15,note:'Synthetic UI test',updatedAt:today.toISOString()}));
 backup.snapshot.bodyProgress=backup.body;
 backup.snapshot.history={'Synthetic bench':[0,7,14,21,28].map((n,i)=>({id:`bench-${i}`,savedAt:`${ago(n)}T12:00:00.000Z`,sets:[{load:String(60-i*2.5),reps:'8'}]}))};
 await page.locator('.export-menu > summary').click();
 await page.getByRole('button',{name:'Restore',exact:true}).click();
 await page.getByLabel('Choose complete backup',{exact:true}).setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
 await page.getByRole('button',{name:'Restore this backup',exact:true}).click();
 await page.getByText(/Backup restored\./).waitFor();
 await page.locator('.export-menu > summary').click();
 await page.getByRole('button',{name:'Progress',exact:true}).click();
 await page.locator('.progress-outlook > summary').click();
 const outlook=page.locator('.progress-outlook');
 for(const kind of ['Weight','Lifts','Measurements']) {
   await outlook.getByRole('button',{name:kind,exact:true}).click();
   if(kind==='Lifts') await outlook.getByRole('combobox').selectOption('Synthetic bench');
   await outlook.locator('svg').waitFor();
   await outlook.getByRole('button',{name:'4 weeks',exact:true}).click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,kind+' overflow');
   await outlook.screenshot({path:`outputs/body-progress/outlook-${kind.toLowerCase()}.png`});
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: weight, lift and tape outlook charts with 2–4 week controls on mobile');
} catch(e) {console.error((await page.locator('body').innerText()).slice(0,4000));await page.screenshot({path:'outputs/body-progress/outlook-failure.png',fullPage:true});throw e;}
finally{await browser.close();}
