import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://localhost').pathname;const path=['/ui.js','/app.css','/popup.html'].includes(name)?name:'/popup.html';res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(`dist${path}`));}catch{res.statusCode=500;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true,channel:process.env.LUFFY_CHROMIUM_CHANNEL||'chrome'});const page=await browser.newPage({viewport:{width:440,height:600}});
 await page.addInitScript(()=>{
  window.calls=[];let attempts=0;let previewAttempts=0;
  window.IntersectionObserver=class{observe(){}disconnect(){}};
  const variants=[{index:0,height:1080,bandwidth:2000000,audios:[{name:'Audio',default:true}]},{index:1,height:720,bandwidth:1000000,audios:[{name:'中文',default:true},{name:'English',language:'en'}]}];
  window.chrome={tabs:{get:async()=>({url:location.search.includes('current')?'https://x.com/person/status/123':'https://x.com/home'}),query:async()=>[{id:1}]},runtime:{sendMessage:async m=>{
   calls.push(m);
   if(m.type==='pageCover')return {ok:true,value:null};
   if(m.type==='nativePreview'){if(location.search.includes('failure')&&previewAttempts++===0)return {ok:false,error:'测试：本机解析暂时不可用'};return {ok:true,value:{qualities:[1280,720],title:'当前视频',url:'https://example.com/test.mp4',type:'file'}};}
   if(m.type==='state')return {ok:true,value:{media:[{id:'one',url:'https://video.twimg.com/ext_tw_video/123/pu/pl/master.m3u8',title:'测试视频',type:'hls'},{id:'retry',url:'https://example.com/master.m3u8',title:'重试视频',type:'hls'}],jobs:[]}};
   if(m.type==='inspect'){await new Promise(r=>setTimeout(r,600));if(m.mediaId==='retry'&&attempts++===0)return {ok:false,error:'测试网络错误'};return {ok:true,value:{kind:'master',variants}};}
   return {ok:true,value:'job'};
  }}};
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/popup.html?tab=1`);
 await page.getByRole('progressbar').first().waitFor();
 assert.equal(await page.getByRole('progressbar').first().getAttribute('aria-valuenow'),null);
 await page.screenshot({path:'artifacts/loading-state.png'});
 const card=page.locator('[data-media-id="one"]');const retry=page.locator('[data-media-id="retry"]');
 await card.getByRole('button',{name:'清晰度',exact:true}).waitFor();
 assert.equal(await page.locator('select').count(),0);
 assert.equal(await card.getByRole('button',{name:'音轨',exact:true}).count(),0);
 assert.equal(await page.getByText('选择清晰度',{exact:true}).count(),0);
 assert.equal(await card.getByRole('button',{name:'↓ 下载视频',exact:true}).isEnabled(),true);
 const trigger=card.getByRole('button',{name:'清晰度',exact:true});await trigger.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 assert.match(await trigger.textContent(),/720p/);
 await card.getByRole('button',{name:'音轨',exact:true}).click();await card.getByRole('option',{name:'English · en'}).click();
 await trigger.click();await page.keyboard.press('Escape');assert.equal(await trigger.getAttribute('aria-expanded'),'false');
 await trigger.click();await card.locator('h2').click();assert.equal(await trigger.getAttribute('aria-expanded'),'false');
 await retry.getByRole('button',{name:'重试',exact:true}).click();await retry.getByRole('button',{name:'清晰度',exact:true}).waitFor();
 await card.locator('summary').click();await card.getByRole('button',{name:'保存格式',exact:true}).click();await card.getByRole('option',{name:'MKV · 原始编码'}).click();assert.match(await card.locator('summary').textContent(),/MKV/);
 await card.getByRole('button',{name:'↓ 下载视频',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.type==='start')),{target:'background',type:'start',mediaId:'one',variantIndex:1,audioIndex:1});
 await page.getByRole('button',{name:/发现视频/}).click();await trigger.click();await page.screenshot({path:'artifacts/custom-dropdown.png',fullPage:true});
 await page.goto(`http://127.0.0.1:${server.address().port}/popup.html?tab=1&current`);
 const current=page.locator('.page-video');await current.getByRole('button',{name:'清晰度',exact:true}).waitFor();
 assert.equal(await current.getByRole('button',{name:'画质',exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.type==='nativePreview').length),1,'cover and quality share metadata request');
 await current.getByRole('button',{name:'清晰度',exact:true}).click();await current.getByRole('option',{name:'1280p',exact:true}).click();
 await current.getByRole('button',{name:'↓ 下载视频',exact:true}).click();
 assert.equal(await page.evaluate(()=>calls.find(c=>c.type==='nativeStart').quality),'1280');
 await page.goto(`http://127.0.0.1:${server.address().port}/popup.html?tab=1&current&failure`);
 await page.locator('.page-video').getByText('画质解析失败，可按最佳画质下载',{exact:true}).waitFor();
 await page.locator('.page-video').getByRole('button',{name:'重试',exact:true}).click();
 await page.locator('.page-video').getByRole('button',{name:'清晰度',exact:true}).waitFor();
 console.log('PASS current-page automatic custom quality, shared metadata, actual download quality and recovery');
 console.log('PASS automatic inspection, no native selects, single/multiple audio, keyboard, outside click, retry, settings and download arguments');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
