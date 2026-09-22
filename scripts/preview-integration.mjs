import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {fixtures,serve} from './fixtures.mjs';
import assert from 'node:assert/strict';
await fixtures();const server=await serve();const profile=await mkdtemp(join(tmpdir(),'luffy-preview-'));let c;
try{
 c=await chromium.launchPersistentContext(profile,{executablePath:process.env.LUFFY_CHROMIUM||chromium.executablePath(),headless:true,args:[`--load-extension=${resolve('dist')}`,`--disable-extensions-except=${resolve('dist')}`]});
 const w=c.serviceWorkers()[0]||await c.waitForEvent('serviceworker');const id=new URL(w.url()).host;
 const page=await c.newPage();await page.goto('http://127.0.0.1:18765');
 const tab=await w.evaluate(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:18765/*'}))[0].id);
 const ui=await c.newPage();await ui.goto(`chrome-extension://${id}/popup.html?tab=${tab}&manager=1`);
 for(const path of ['plain/index.m3u8','encrypted/index.m3u8','fmp4/index.m3u8','separate/master.m3u8','range/index.m3u8','protected/index.m3u8']){
  const before=await ui.locator('.card .video-preview video').count();
  await page.evaluate(path=>fetch('/'+path).then(r=>r.text()),path);
  await ui.waitForFunction(n=>document.querySelectorAll('.card .video-preview video').length>n,before);
  const v=ui.locator('.card .video-preview video').last();await v.scrollIntoViewIfNeeded();
  await v.evaluate(v=>new Promise((resolve,reject)=>{if(v.readyState>=2)return resolve();let timer=setTimeout(()=>reject(Error('no preview frames')),15000);v.addEventListener('loadeddata',()=>{clearTimeout(timer);resolve();},{once:true});}));
  await v.evaluate(v=>v.play());await ui.waitForFunction(()=>[...document.querySelectorAll('.card video')].at(-1)?.currentTime>0.2);
  console.log('PASS preview',path);await v.evaluate(v=>v.pause());
 }
 await ui.evaluate(()=>scrollTo(0,0));
 assert.equal(await ui.locator('.intro, .source, #platform').count(),0);
 assert.ok((await ui.locator('.card').first().boundingBox()).y<200);
 await ui.screenshot({path:resolve('artifacts/list-first-ui.png'),fullPage:true,animations:'disabled'});
 // Active video identity survives a new media discovery (polling must not restart it).
 const v=ui.locator('.card video').first();await v.evaluate(v=>{v.dataset.testIdentity='retained';});
 await page.evaluate(()=>fetch('/sample.mp4?another=1').then(r=>r.arrayBuffer()));
 await ui.waitForFunction(()=>[...document.querySelectorAll('.card video')].some(v=>v.dataset.testIdentity==='retained'));
 const own=await ui.evaluate(async()=>{const tab=await chrome.tabs.getCurrent();return (await chrome.runtime.sendMessage({target:'background',type:'state',tabId:tab.id})).value.media;});assert.equal(own.length,0,'preview traffic must not rediscover itself');
 const rulesBefore=await w.evaluate(()=>chrome.declarativeNetRequest.getSessionRules());await ui.close();
 await w.evaluate(async()=>{for(let i=0;i<40;i++){if(!(await chrome.declarativeNetRequest.getSessionRules()).length)return;await new Promise(r=>setTimeout(r,100));}throw Error('preview rule leak');});
 console.log('PASS preview cleanup and player identity');
}finally{await c?.close();server.close();await rm(profile,{recursive:true,force:true});}
