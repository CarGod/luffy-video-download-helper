import { chromium } from 'playwright';
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { execFileSync } from 'node:child_process';
const profile=await mkdtemp(join(tmpdir(),'luffy-native-test-'));
await mkdir(join(profile,'NativeMessagingHosts'));
await writeFile(join(profile,'NativeMessagingHosts/com.luffy.video_helper.json'),await readFile(join(process.env.HOME,'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.luffy.video_helper.json')));
let context;
try {
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.LUFFY_CHROMIUM || chromium.executablePath(),headless:true,args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 const site=await context.newPage();
 await site.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<!doctype html><title>Luffy platform test</title><h1>Video page fixture</h1>'}):route.continue());
 const ui=await context.newPage();
 const inputs=[{name:'YouTube',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw'}, {name:'X',url:'https://x.com/oshtru/status/1577855540407197696'}];
 const results=[];
 for(const input of inputs){
  await site.goto(input.url);
  const sourceTab=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,input.url);
  await ui.goto(`chrome-extension://${id}/popup.html?manager=1&tab=${sourceTab}`);
  await ui.waitForSelector('.page-video');
  const card=ui.locator('.page-video');
  await card.locator('.cover-image').waitFor({state:'visible',timeout:90000});
  if(await card.locator('video').count())throw Error('Cover must not initialize video before click');
  await ui.screenshot({path:resolve(`artifacts/cover-${input.name}.png`),fullPage:true,animations:'disabled'});
  console.log('PASS automatic cover before playback',input.name);
  await card.getByRole('button',{name:'▶ 预览视频'}).click();
  await ui.waitForFunction(()=>document.querySelector('.page-video video')?.readyState>=2,undefined,{timeout:90000});
  await card.locator('video').evaluate(v=>v.play());
  await ui.waitForFunction(()=>document.querySelector('.page-video video')?.currentTime>0.4);
  console.log('PASS current-page card and playback',input.name);
  await card.locator('summary').click();
  if(await card.getByLabel('保存格式').inputValue()!=='mp4')throw Error('MP4 must be default');
  await card.getByLabel('画质',{exact:true}).selectOption('720');
  await card.getByRole('button',{name:'↓ 下载视频',exact:true}).click();
  const started=Date.now();let job;
  while(Date.now()-started<180000){
   const r=await ui.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'state'}));
   job=r.value.jobs[0];if(job&&['complete','error','cancelled'].includes(job.status))break;await new Promise(r=>setTimeout(r,1000));
  }
  if(job?.status==='complete'){
   const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',job.path],{encoding:'utf8'}));
   if(!job.path.endsWith('.mp4')||!probe.streams.some(s=>s.codec_name==='h264')||!probe.streams.some(s=>s.codec_name==='aac'))throw Error('MP4 compatibility conversion failed');
   results.push({name:input.name,status:'complete',path:job.path,duration:probe.format.duration,codecs:probe.streams.map(s=>s.codec_name)});
  } else results.push({name:input.name,status:job?.status,error:job?.error});
  console.log(results.at(-1));
 }
 await ui.waitForFunction(()=>document.querySelectorAll('#job-list .card').length===2 && document.querySelector('#notice').hidden);
 await ui.screenshot({path:resolve('artifacts/native-downloads.png'),fullPage:true,animations:'disabled'});
 await writeFile('artifacts/native-results.json',JSON.stringify(results,null,2));
}finally{await context?.close();await rm(profile,{recursive:true,force:true});}
