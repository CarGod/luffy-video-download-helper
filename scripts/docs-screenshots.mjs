// Capture the actual UI with synthetic media and an explicitly illustrative MCP state.
// No browsing history, user profile, downloaded videos or personal paths are used.
import {chromium} from 'playwright';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fixtures,serve} from './fixtures.mjs';
await fixtures();const server=await serve();
const profile=await mkdtemp(join(tmpdir(),'luffy-docs-'));
let context;
try{
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.LUFFY_CHROMIUM||chromium.executablePath(),headless:true,viewport:{width:440,height:600},args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage();await page.goto('http://127.0.0.1:18765');
 await page.locator('video').evaluate(v=>v.play());
 const tabId=await worker.evaluate(async()=>(await chrome.tabs.query({url:'http://127.0.0.1:18765/*'}))[0].id);
 const ui=await context.newPage();
 await ui.addInitScript(()=>{
  const original=chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage=(m,...args)=>m.target==='background'&&m.type==='mcpStatus'
   ?Promise.resolve({ok:true,value:{enabled:true,running:true,config:{mcpServers:{'luffy-video':{command:'/Users/your-name/Library/Application Support/LuffyVideoHelper/launch-mcp.sh'}}}}})
   :original(m,...args);
 });
 await ui.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html?tab=${tabId}`);
 await ui.locator('#media-list .card').waitFor();
 await ui.waitForFunction(()=>document.querySelector('#media-list video')?.readyState>=2);
 await ui.addStyleTag({content:'html:not(.manager-page){height:auto;overflow:visible}body:not(.manager){height:auto;min-height:0;overflow:visible}'});
 await mkdir('docs/images',{recursive:true});
 await ui.screenshot({path:'docs/images/videos.png',fullPage:true,animations:'disabled'});
 await ui.locator('#mcp-tab').click();
 await ui.screenshot({path:'docs/images/mcp.png',fullPage:true,animations:'disabled'});
 console.log('Saved documentation screenshots with synthetic media and example MCP configuration.');
}finally{await context?.close();server.close();await rm(profile,{recursive:true,force:true});}
