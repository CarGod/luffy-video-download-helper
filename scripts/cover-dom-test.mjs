import {chromium} from 'playwright';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
const profile=await mkdtemp(join(tmpdir(),'luffy-cover-'));let context;
try{
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.LUFFY_CHROMIUM||chromium.executablePath(),headless:true,args:[`--load-extension=${resolve('dist')}`,`--disable-extensions-except=${resolve('dist')}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 await context.route('https://pbs.twimg.com/**',async route=>route.fulfill({contentType:'image/png',body:await readFile('public/icons/128.png')}));
 const site=await context.newPage();await site.route('https://x.com/**',async route=>{if(route.request().url().endsWith('.png'))return route.fulfill({contentType:'image/png',body:await readFile('public/icons/128.png')});return route.fulfill({contentType:'text/html',body:'<title>Cover matching test</title><article><a href="/someone/status/999"><time>Reply</time></a><video poster="https://x.com/wrong.png"></video></article><article><a href="/someone/status/123"><time>Current</time></a><video></video><img src="https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/correct.png"></article>'});});await site.goto('https://x.com/someone/status/123');
 // Images in the extension are intercepted separately.
 await context.route('https://pbs.twimg.com/**',async route=>route.fulfill({contentType:'image/png',body:await readFile('public/icons/128.png')}));
 const tab=await worker.evaluate(async()=>(await chrome.tabs.query({url:'https://x.com/someone/status/123'}))[0].id);
 const ui=await context.newPage();await ui.goto(`chrome-extension://${id}/popup.html?tab=${tab}`);
 await ui.locator('.cover-image').waitFor({state:'visible'});assert.equal(await ui.locator('.cover-image').getAttribute('src'),'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/correct.png');assert.equal(await ui.locator('.page-video video').count(),0);
 assert.equal(await ui.locator('#notice').isVisible(),false);console.log('PASS current post poster selected over reply; no player or native helper needed');
}finally{await context?.close();await rm(profile,{recursive:true,force:true});}
