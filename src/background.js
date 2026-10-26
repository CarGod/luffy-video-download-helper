import { retryConnection } from './loading.js';
import { createMcpHandler } from './mcp.js';
import { classify, httpURL, filename, fileExtension, terminal } from './media.js';
import { groupedMedia } from './media-groups.js';
const requestHeaders = new Map();
let nativePort;
let mcpEnabled=false;
const mcpReady=chrome.storage.local.get('mcpEnabled').then(s=>{mcpEnabled=s.mcpEnabled===true;});
const nativePending=new Map();
function connectNative(){
  if(nativePort)return nativePort;
  nativePort=chrome.runtime.connectNative('com.luffy.video_helper');
  nativePort.onMessage.addListener(message=>{
    if(message.event==='mcp'){
      const port=nativePort;
      (mcpEnabled ? mcpHandler(message.request) : Promise.reject(Error('MCP 服务已关闭'))).then(value=>port.postMessage({type:'mcpResponse',requestId:message.requestId,ok:true,value}),e=>port.postMessage({type:'mcpResponse',requestId:message.requestId,ok:false,error:e.message})).catch(()=>{});
    }
    else if(message.event==='job')persistPatch(message.id,message.patch);
    else {const p=nativePending.get(message.requestId);if(p){clearTimeout(p.timer);nativePending.delete(message.requestId);message.ok?p.resolve(message.value):p.reject(new Error(message.error));}}
  });
  nativePort.onDisconnect.addListener(()=>{
    const error=chrome.runtime.lastError?.message||'本机助手连接已断开';nativePort=null;
    for(const p of nativePending.values()){clearTimeout(p.timer);p.reject(new Error('本机助手未连接，请运行 Install-Luffy-Helper.command。'+error));}nativePending.clear();
    mutate(()=>{for(const j of state.jobs)if(j.type==='native'&&!terminal(j.status))Object.assign(j,{status:'error',error:'本机助手连接中断，请重新下载'});});
  });
  mcpReady.then(()=>nativeRequest('mcpControl',{enabled:mcpEnabled})).catch(()=>{});
  return nativePort;
}
function nativeRequest(type,data={}){
  return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();const timer=setTimeout(()=>{nativePending.delete(requestId);reject(new Error('本机助手响应超时'));},type==='preview'?85000:20000);nativePending.set(requestId,{resolve,reject,timer});try{connectNative().postMessage({type,requestId,...data});}catch(e){clearTimeout(timer);nativePending.delete(requestId);reject(e);}});
}
let state = {media:{}, jobs:[]};
const ready = chrome.storage.session.get('state').then(x=>{if(x.state)state=x.state;});
let chain = Promise.resolve();
function mutate(fn) {
  const task=chain.then(async()=>{await ready;const result=await fn();await chrome.storage.session.set({state});return result;});
  chain=task.catch(()=>{});return task;
}
const persistPatch = (id,patch)=>mutate(()=>{const j=state.jobs.find(j=>j.id===id);if(j && !terminal(j.status))Object.assign(j,patch);});
async function badge(tabId) {
  const n=groupedMedia(state.media[tabId]||[]).length;
  await chrome.action.setBadgeText({tabId,text:n?String(n):''}).catch(()=>{});
  await chrome.action.setBadgeBackgroundColor({tabId,color:'#b9ed65'}).catch(()=>{});
}
async function discover(tabId, data) {
  if(tabId < 0)return;
  const type=data.type||classify(data.url,data.mime);
  if(!type)return;
  const url=httpURL(data.url);
  const tab=await chrome.tabs.get(tabId).catch(()=>null);
  if(!tab || tab.incognito || tab.url?.startsWith(chrome.runtime.getURL('')))return;
  await mutate(()=>{
    const list=state.media[tabId] ||= [];
    const existing=list.find(m=>m.url===url);
    if(existing){Object.assign(existing,{...data,url,type});return;}
    list.push({id:crypto.randomUUID(),title:tab.title||data.title||'网页视频',page:tab.url||data.page||'',...data,url,type,foundAt:Date.now()});
    if(list.length>80)list.shift();
  });await badge(tabId);
}
chrome.webRequest.onBeforeSendHeaders.addListener(d=>{
  if(d.tabId<0||d.initiator?.startsWith('chrome-extension:'))return;
  const headers={};
  for(const h of d.requestHeaders||[])if(['referer','origin','authorization'].includes(h.name.toLowerCase())&&h.value)headers[h.name.toLowerCase()]=h.value;
  requestHeaders.set(d.requestId,{headers,tabId:d.tabId});
  if(requestHeaders.size>1500)requestHeaders.delete(requestHeaders.keys().next().value);
},{urls:['http://*/*','https://*/*']},['requestHeaders','extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener(d=>{
  if(d.initiator?.startsWith('chrome-extension:') || d.tabId<0 || d.statusCode<200 || d.statusCode>=300)return;
  const headers=new Map((d.responseHeaders||[]).map(h=>[h.name.toLowerCase(),h.value]));
  const mime=headers.get('content-type')||'';
  if(!classify(d.url,mime))return;
  const total=headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
  discover(d.tabId,{url:d.url,mime,size:Number(total||headers.get('content-length'))||0,headers:requestHeaders.get(d.requestId)?.headers||{}}).catch(()=>{});
},{urls:['http://*/*','https://*/*']},['responseHeaders']);
for(const event of [chrome.webRequest.onCompleted,chrome.webRequest.onErrorOccurred])event.addListener(d=>requestHeaders.delete(d.requestId),{urls:['http://*/*','https://*/*']});
chrome.tabs.onRemoved.addListener(tabId=>{mutate(()=>delete state.media[tabId]);for(const [key,x] of requestHeaders)if(x.tabId===tabId)requestHeaders.delete(key);});
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.status==='loading')mutate(()=>delete state.media[tabId]).then(()=>badge(tabId));
});

let creating;
async function ensureEngine() {
  if(creating){await creating;return;}
  if((await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length)return;
  if(!creating)creating=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],justification:'Download HLS segments and merge audio/video locally.'}).finally(()=>{creating=null;});
  await creating;
}
async function engine(type,data={}) {
  await ensureEngine();
  await retryConnection(async()=>{const ready=await chrome.runtime.sendMessage({target:'offscreen',type:'ready'});if(!ready?.ok)throw Error('媒体处理引擎无响应');},{attempts:5});
  const send=()=>chrome.runtime.sendMessage({target:'offscreen',type,...data});
  const r=type==='inspect'?await retryConnection(send):await send();
  if(!r?.ok)throw new Error(r?.error||'媒体处理引擎无响应');
  return r.value;
}
// Rules target exact URLs and ONLY requests initiated by this extension.
// No Cookie is copied; the browser applies its own cookie policy.
let ruleCounter=1;
const rules=new Set();
async function headerRule(url,source,resourceType='xmlhttprequest') {
  httpURL(url);
  const h=source?.headers||{};
  const headers=[];
  for(const key of ['referer','origin','authorization']) {
    const value=h[key] || (key==='referer' ? source?.page : null);
    if(!value)continue;
    if(key==='authorization' && new URL(url).origin!==new URL(source.url).origin)continue;
    if(/[\r\n]/.test(value))continue;
    headers.push({header:key,operation:'set',value});
  }
  if(!headers.length)return null;
  const id=++ruleCounter;
  const regex='^'+url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
  await chrome.declarativeNetRequest.updateSessionRules({addRules:[{id,priority:1,action:{type:'modifyHeaders',requestHeaders:headers},condition:{regexFilter:regex,isUrlFilterCaseSensitive:true,initiatorDomains:[chrome.runtime.id],resourceTypes:[resourceType]}}]});
  rules.add(id);return id;
}
async function removeRule(id){if(id){await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[id]});rules.delete(id);}}
const init=ready.then(async()=>{
  const old=await chrome.declarativeNetRequest.getSessionRules();
  ruleCounter=Math.max(1,...old.map(r=>r.id));old.forEach(r=>rules.add(r.id));
  const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
  if(!contexts.length){
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:old.map(r=>r.id)});rules.clear();
    await mutate(()=>{for(const j of state.jobs)if(!terminal(j.status)&&!j.downloadId)Object.assign(j,{status:'error',error:'浏览器或扩展已重启，请重新下载'});});
  }
  for(const j of state.jobs.filter(j=>j.downloadId&&!terminal(j.status)))await reconcile(j.downloadId);
});
async function reconcile(downloadId) {
  const [d]=await chrome.downloads.search({id:downloadId});
  if(!d)return;
  const job=state.jobs.find(j=>j.downloadId===downloadId);
  if(!job)return;
  if(d.state==='complete'||d.state==='interrupted'){
    await persistPatch(job.id,{status:d.state==='complete'?'complete':d.error==='USER_CANCELED'?'cancelled':'error',error:d.error||'',progress:d.state==='complete'?100:job.progress,bytes:d.bytesReceived});
    if(job.ruleId)await removeRule(job.ruleId);
    if(job.blob)await engine('release',{id:job.id}).catch(()=>{});
  }
  return d.state;
}
chrome.downloads.onChanged.addListener(d=>{ready.then(()=>reconcile(d.id)).catch(()=>{});});
async function saveBlob(m) {
  const j=state.jobs.find(j=>j.id===m.id);
  if(!j||terminal(j.status))return false;
  if(!m.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`))throw new Error('无效的输出文件');
  const downloadId=await chrome.downloads.download({url:m.url,filename:m.filename,saveAs:false,conflictAction:'uniquify'});
  if(terminal(j.status)){await chrome.downloads.cancel(downloadId).catch(()=>{});return false;}
  await persistPatch(j.id,{downloadId,status:'saving',filename:m.filename,blob:true,progress:99});
  await reconcile(downloadId);return true;
}
async function startDownload(m) {
  const media=Object.values(state.media).flat().find(x=>x.id===m.mediaId);
  if(!media)throw new Error('视频记录已失效，请刷新页面重新发现');
  if(media.type==='dash')throw new Error('第一版尚未支持 DASH 下载');
  const job={id:crypto.randomUUID(),mediaId:media.id,title:media.title,status:'queued',progress:0,bytes:0,createdAt:Date.now(),type:media.type};
  await mutate(()=>{if(state.jobs.filter(j=>!terminal(j.status)).length>=10)throw new Error('最多同时保留 10 个未完成任务');state.jobs.unshift(job);state.jobs=state.jobs.filter((j,i)=>i<50||!terminal(j.status));});
  try {
    if(media.type==='file') {
      const ruleId=await headerRule(media.url,media,'other');
      await persistPatch(job.id,{ruleId});
      const downloadId=await chrome.downloads.download({url:media.url,filename:filename(media.title,fileExtension(media.url,media.mime)),saveAs:false,conflictAction:'uniquify'});
      if(terminal(job.status)){await chrome.downloads.cancel(downloadId).catch(()=>{});await removeRule(ruleId);return job.id;}
      await persistPatch(job.id,{downloadId,status:'downloading'});await reconcile(downloadId);
    } else {await engine('enqueue',{job,source:media,variantIndex:m.variantIndex,audioIndex:m.audioIndex});if(terminal(job.status))await engine('cancel',{id:job.id});}
  }catch(e){if(job.ruleId)await removeRule(job.ruleId);await persistPatch(job.id,{status:'error',error:e.message});}
  return job.id;
}
async function cancel(id) {
  const job=state.jobs.find(j=>j.id===id);if(!job||terminal(job.status))return;
  // Record cancellation before awaiting I/O so late completion messages cannot revive it.
  await persistPatch(id,{status:'cancelled'});
  if(job.downloadId)await chrome.downloads.cancel(job.downloadId).catch(()=>{});
  if(job.type==='native')await nativeRequest('cancel',{jobId:id}).catch(()=>{});
  if(job.type==='hls')await engine('cancel',{id}).catch(()=>{});
  if(job.ruleId)await removeRule(job.ruleId);
}
function trustedPage(sender) {return sender.id===chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('')) && !sender.tab?.incognito;}
async function handle(m,sender) {
  await init;
  if(m.type==='discovered') {
    if(sender.id!==chrome.runtime.id||!sender.tab||sender.tab.incognito)return;
    return discover(sender.tab.id,{url:m.url,title:String(m.title||'').slice(0,300),page:sender.url,poster:/^https?:/.test(m.poster||'')?m.poster:undefined,duration:Number.isFinite(m.duration)?m.duration:undefined});
  }
  if(!trustedPage(sender))throw new Error('消息来源无效');
  const fromEngine=sender.url===chrome.runtime.getURL('offscreen.html');
  if(['patch','headerRule','removeRule','saveBlob'].includes(m.type)&&!fromEngine)throw new Error('消息来源无效');
  switch(m.type) {
    case 'state':{
      for(const j of state.jobs.filter(j=>j.downloadId&&!terminal(j.status))){
        const [d]=await chrome.downloads.search({id:j.downloadId});
        if(d){j.bytes=d.bytesReceived;if(d.totalBytes>0)j.progress=Math.round(d.bytesReceived/d.totalBytes*100);}
      }
      return {media:groupedMedia(state.media[m.tabId]||[]).map(({headers,...rest})=>rest),jobs:state.jobs};
    }
    case 'inspect':{
      const source=Object.values(state.media).flat().find(x=>x.id===m.mediaId);if(!source)throw new Error('视频记录已失效');
      return engine('inspect',{source});
    }
    case 'pageCover':{
      const tab=await chrome.tabs.get(m.tabId);if(tab.incognito||tab.url!==m.url)return null;
      const result=await chrome.scripting.executeScript({target:{tabId:m.tabId},func:(expected)=>{
        if(location.href!==expected)return null;
        const url=new URL(expected);let root=document;
        if(['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)){
          const status=url.pathname.match(/\/status\/(\d+)/)?.[1];
          root=[...document.querySelectorAll('article')].find(article=>[...article.querySelectorAll('a[href]')].some(a=>a.querySelector('time')&&new URL(a.href).pathname.match(/\/status\/(\d+)/)?.[1]===status));
          // Never use a recommended/reply video's poster for the current post.
          if(!root)return null;
        }
        const video=root.querySelector('video');
        const coverImage=[...root.querySelectorAll('img')].find(img=>/^https:\/\/pbs\.twimg\.com\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(img.currentSrc||img.src));
        const poster=video?.poster || coverImage?.currentSrc || coverImage?.src || (root===document?document.querySelector('meta[property="og:image"],meta[name="twitter:image"]')?.content:null);
        return {poster:poster&&/^https?:/.test(poster)?poster:null,duration:Number.isFinite(video?.duration)?video.duration:null};
      },args:[m.url]});
      const info=result[0]?.result;if(!info)return null;
      // Bind only a matching asset, never whichever media happened to be discovered first.
      const asset=info.poster?.match(/pbs\.twimg\.com\/(ext_tw_video|amplify_video)_thumb\/(\d+)\//);
      const media=asset&&groupedMedia(state.media[m.tabId]||[]).find(item=>{try{return new URL(item.url).hostname==='video.twimg.com'&&new URL(item.url).pathname.startsWith(`/${asset[1]}/${asset[2]}/`);}catch{return false;}});
      return media?{...media,...info}:info;
    }
    case 'nativePreview':return nativeRequest('preview',{url:httpURL(m.url),cookies:m.cookies});
    case 'helperStatus':return nativeRequest('status');
    case 'mcpStatus':{
      await mcpReady;
      try{return {enabled:mcpEnabled,...await nativeRequest('mcpStatus')};}
      catch(e){return {enabled:mcpEnabled,running:false,error:e.message==='未知操作'?'本机助手版本过旧，请重新运行 Install-Luffy-Helper.command，重启浏览器后再连接。':e.message};}
    }
    case 'mcpSetEnabled':{
      await mcpReady;
      if(typeof m.enabled!=='boolean')throw Error('无效的 MCP 开关');
      mcpEnabled=m.enabled;
      await chrome.storage.local.set({mcpEnabled});
      if(mcpEnabled)await chrome.alarms.create('luffy-mcp-connect',{periodInMinutes:1});
      else await chrome.alarms.clear('luffy-mcp-connect');
      try{return {enabled:mcpEnabled,...await nativeRequest('mcpControl',{enabled:mcpEnabled})};}
      catch(e){return {enabled:mcpEnabled,running:false,error:e.message==='未知操作'?'本机助手版本过旧，请重新运行 Install-Luffy-Helper.command，重启浏览器后再连接。':e.message};}
    }
    case 'convertExisting':{
      const source=state.jobs.find(j=>j.id===m.id&&j.status==='complete'&&j.path);if(!source)throw Error('没有可转换的已下载文件');
      const job={id:crypto.randomUUID(),title:source.title+' · MP4',type:'native',status:'queued',progress:0,bytes:0,createdAt:Date.now()};
      await mutate(()=>state.jobs.unshift(job));
      try{await nativeRequest('convert',{jobId:job.id,path:source.path});}catch(e){await persistPatch(job.id,{status:'error',error:e.message});throw e;}return job.id;
    }
    case 'nativeStart':{
      const url=httpURL(m.url);const job={id:crypto.randomUUID(),title:m.title||new URL(url).hostname,type:'native',status:'queued',progress:0,bytes:0,createdAt:Date.now()};
      await mutate(()=>{if(state.jobs.filter(j=>j.type==='native'&&!terminal(j.status)).length>=2)throw new Error('本机助手最多同时下载两个任务');state.jobs.unshift(job);state.jobs=state.jobs.filter((j,i)=>i<50||!terminal(j.status));});
      try{await nativeRequest('start',{jobId:job.id,url,quality:m.quality,cookies:m.cookies,format:m.format});}catch(e){await persistPatch(job.id,{status:'error',error:e.message});throw e;}return job.id;
    }
    case 'start':return startDownload(m);
    case 'cancel':return cancel(m.id);
    case 'patch':{
      await persistPatch(m.id,m.patch);
      const job=state.jobs.find(j=>j.id===m.id);
      // Saving heartbeats recover missed download events and release messages,
      // including after this service worker restarts.
      if(m.patch?.heartbeat&&job?.downloadId){
        const downloadState=await reconcile(job.downloadId);
        if(downloadState==='in_progress')return 'saving';
      }
      return state.jobs.find(j=>j.id===m.id)?.status||'missing';
    }
    case 'headerRule':return headerRule(m.url,m.source);
    case 'removeRule':return removeRule(m.id);
    case 'saveBlob':return saveBlob(m);
    case 'clear':return mutate(()=>{state.jobs=state.jobs.filter(j=>!terminal(j.status));});
    case 'show':{const j=state.jobs.find(j=>j.id===m.id);if(j?.downloadId)await chrome.downloads.show(j.downloadId);else if(j?.path)await nativeRequest('show',{path:j.path});return;}
    case 'scan':await chrome.tabs.sendMessage(m.tabId,{type:'scan'}).catch(()=>chrome.scripting.executeScript({target:{tabId:m.tabId,allFrames:true},files:['content.js']}));return;
    default:throw new Error('未知操作');
  }
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(m.target!=='background')return;
  handle(m,sender).then(value=>respond({ok:true,value}),e=>respond({ok:false,error:e.message}));return true;
});

// Preview rules live only as long as the popup/player's port does.
chrome.runtime.onConnect.addListener(port=>{
 if(port.name!=='luffy-preview'||!trustedPage(port.sender))return;
 let closed=false;const owned=new Set();
 port.onDisconnect.addListener(()=>{closed=true;for(const id of owned)removeRule(id).catch(()=>{});owned.clear();});
 port.onMessage.addListener(async m=>{
  try{
   await init;let value;
   if(m.type==='rule'){
    const source=m.source?.id?Object.values(state.media).flat().find(x=>x.id===m.source.id):m.source;
    if(!source)throw Error('预览记录已失效');
    value=await headerRule(httpURL(m.url),source,m.resourceType==='media'?'media':'xmlhttprequest');
    if(value){if(closed){await removeRule(value);return;}owned.add(value);}
   }else if(m.type==='release'&&owned.has(m.rule)){await removeRule(m.rule);owned.delete(m.rule);}
   if(!closed)port.postMessage({id:m.id,value});
  }catch(e){if(!closed)port.postMessage({id:m.id,error:e.message});}
 });
});

const mcpHandler = createMcpHandler({chrome, rpc: m => handle(m, {id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')})});
// Restore the user's MCP switch; ordinary native downloads also work while it is off.
chrome.alarms.onAlarm.addListener(alarm => {if(alarm.name==='luffy-mcp-connect')mcpReady.then(()=>{if(mcpEnabled)connectNative();});});
async function restoreMcp(){await mcpReady;if(mcpEnabled){await chrome.alarms.create('luffy-mcp-connect',{periodInMinutes:1});connectNative();}else await chrome.alarms.clear('luffy-mcp-connect');}
chrome.runtime.onStartup.addListener(()=>{void restoreMcp();});
init.then(restoreMcp).catch(()=>{});
