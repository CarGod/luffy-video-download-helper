import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fixtures, serve } from './fixtures.mjs';
await fixtures();const server=await serve();
const profile=await mkdtemp(join(tmpdir(),'luffy-extension-test-'));
await mkdir(join(profile,'NativeMessagingHosts'),{recursive:true});
await writeFile(join(profile,'NativeMessagingHosts/com.luffy.video_helper.json'),await readFile(join(process.env.HOME,'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.luffy.video_helper.json')));
await mkdir('artifacts/downloads',{recursive:true});
let context;
try{
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.LUFFY_CHROMIUM || chromium.executablePath(),headless:true,acceptDownloads:true,downloadsPath:resolve('artifacts/downloads'),args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 worker.on('console',m=>console.log('WORKER',m.type(),m.text()));
 const id=new URL(worker.url()).host;console.log('Extension loaded',id);
 const page=await context.newPage();await page.goto('http://127.0.0.1:18765');await page.locator('video').evaluate(v=>v.play());
 const tabId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'http://127.0.0.1:18765/*'});return tabs[0].id;});
 const ui=await context.newPage();ui.on('pageerror',e=>console.log('UI ERROR',e.message));
 await ui.goto(`chrome-extension://${id}/popup.html?manager=1&tab=${tabId}`);
 const rpc=(type,data={})=>ui.evaluate(async({type,data})=>{const r=await chrome.runtime.sendMessage({target:'background',type,...data});if(!r?.ok)throw Error(r?.error);return r.value;},{type,data});
 async function until(fn){for(let i=0;i<240;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,250));}throw Error('Timed out');}
 const state=await until(async()=>{const s=await rpc('state',{tabId});return s.media.length?s:null;});
 console.log('Discovered direct file',state.media[0].url);
 async function finishJob(jobId){return until(async()=>{const s=await rpc('state',{tabId});const j=s.jobs.find(x=>x.id===jobId);if(j?.status==='error')throw Error(j.error);return j?.status==='complete'?j:null;});}
 async function verifySaved(job,name){
  const result=await worker.evaluate(async id=>(await chrome.downloads.search({id}))[0],job.downloadId);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',result.filename],{encoding:'utf8'}));
  assert.ok(Number(info.format.duration)>=5.8);assert.ok(info.streams.some(s=>s.codec_type==='video'));assert.ok(info.streams.some(s=>s.codec_type==='audio'));
  console.log('PASS',name,Number(info.format.duration),info.streams.map(s=>s.codec_name).join(','));return {name,duration:info.format.duration,codecs:info.streams.map(s=>s.codec_name)};
 }
 const results=[];
 const direct=await finishJob(await rpc('start',{mediaId:state.media[0].id}));results.push(await verifySaved(direct,'direct MP4'));
 for(const path of ['plain/index.m3u8','encrypted/index.m3u8','fmp4/index.m3u8','separate/master.m3u8','range/index.m3u8','protected/index.m3u8']){
  await page.evaluate(path=>fetch('/'+path).then(r=>r.text()),path);
  const media=await until(async()=>{const s=await rpc('state',{tabId});return s.media.find(m=>m.url.endsWith(path));});
  const parsed=await rpc('inspect',{mediaId:media.id});console.log('Inspect',path,parsed.kind);
  const startedId=await rpc('start',{mediaId:media.id});if(path==='plain/index.m3u8'){await ui.goto('about:blank');await ui.goto(`chrome-extension://${id}/popup.html?manager=1&tab=${tabId}`);}const job=await finishJob(startedId);results.push(await verifySaved(job,path));
 }
 // Real preview playback: seek the rendered HLS player and verify time advances.
 await ui.reload();await ui.waitForSelector('.video-preview video');
 await ui.waitForFunction(()=>[...document.querySelectorAll('.video-preview video')].filter(v=>v.readyState>=2).length>=2);
 const previewVideo=ui.locator('.video-preview video').nth(1);
 await previewVideo.evaluate(v=>v.play());
 await ui.waitForFunction(()=>document.querySelectorAll('.video-preview video')[1].currentTime>0.4);
 console.log('PASS actual HLS preview playback');
 // Cancel a running fetch, not just a completed queue operation.
 await page.evaluate(()=>fetch('/slow/index.m3u8').then(r=>r.text()));
 const slow=await until(async()=>{const s=await rpc('state',{tabId});return s.media.find(m=>m.url.includes('/slow/'));});
 const latest=slow;
 const cancelId=await rpc('start',{mediaId:latest.id});await until(async()=>{const j=(await rpc('state',{tabId})).jobs.find(j=>j.id===cancelId);return j?.status==='downloading';});await rpc('cancel',{id:cancelId});
 assert.equal((await rpc('state',{tabId})).jobs.find(j=>j.id===cancelId).status,'cancelled');console.log('PASS cancellation');
 await ui.reload();await ui.waitForSelector('.card');await ui.screenshot({path:resolve('artifacts/extension-manager.png'),fullPage:true,animations:'disabled'});
 const helper=await rpc('helperStatus');assert.ok(helper.ffmpeg);console.log('PASS native connection',helper);
 await writeFile('artifacts/integration-results.json',JSON.stringify({results,cancellation:true,native:helper},null,2));
}finally{await context?.close();server.close();await rm(profile,{recursive:true,force:true});}
