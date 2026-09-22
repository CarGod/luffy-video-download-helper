import { loadingState, retryConnection } from './loading.js';
import { dropdown } from './dropdown.js';
import { createCover } from './cover.js';
import { videoList } from './list-model.js';
import { createPreview, stopPreviews } from './preview.js';
import { formatBytes, terminal } from './media.js';
const $=s=>document.querySelector(s);
const params=new URLSearchParams(location.search);
const manager=params.has('manager');if(manager){document.body.classList.add('manager');document.documentElement.classList.add('manager-page');}
const choices=new Map();
const previews=new Map();const mediaCards=new Map();const settings=new Map();
let tabId=Number(params.get('tab'))||null;
let lastMedia='',lastJobs='';
let currentTab=null;
async function rpc(type,data={}){const send=()=>chrome.runtime.sendMessage({target:'background',type,...data});const r=await (['inspect','nativePreview','pageCover'].includes(type)?retryConnection(send):send());if(!r?.ok)throw new Error(r?.error||'扩展未连接');return r.value;}
function notice(text){$('#notice').textContent=text;$('#notice').hidden=!text;}
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
function button(text,cls,fn){const b=node('button',cls,text);b.onclick=async()=>{b.disabled=true;notice('');try{await fn();await refresh();}catch(e){notice(e.message);}finally{b.disabled=false;}};return b;}
function empty(title,text){const d=node('div','empty');d.append(node('div','symbol','↓'),node('strong','',title),node('p','',text));return d;}
function showTab(selected){
 stopPreviews();
 const name=typeof selected==='boolean'?(selected?'jobs':'media'):selected;
 for(const tab of ['media','jobs','mcp']){
  const active=tab===name;
  $(`#${tab}-panel`).hidden=!active;
  $(`#${tab}-tab`).classList.toggle('active',active);
  $(`#${tab}-tab`).setAttribute('aria-selected',String(active));
 }
 $('.help').hidden=name!=='media';
}
$('#media-tab').onclick=()=>showTab('media');$('#jobs-tab').onclick=()=>showTab('jobs');$('#mcp-tab').onclick=()=>showTab('mcp');
$('#expand').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL(`popup.html?manager=1&tab=${tabId||''}`)});
$('#scan').onclick=async()=>{try{if(!tabId)throw new Error('请先打开一个包含视频的网页');await rpc('scan',{tabId});notice('已扫描页面。如果仍没有视频，请播放视频或刷新原网页。');}catch(e){notice(e.message);}};
$('#clear').onclick=async()=>{try{await rpc('clear');await refresh();}catch(e){notice(e.message);}};
function nativeOptions(m,onCookiesChange){
 const value=settings.get(m.id)||{format:'mp4',quality:'best',cookies:'none'};settings.set(m.id,value);
 const details=node('details','download-options');details.append(node('summary','','下载设置 · '+(value.format==='mp4'?'MP4':value.format==='original'?'原始格式':'MKV')));
 const fields=[['format','保存格式',[['mp4','MP4 · 兼容优先'],['mkv','MKV · 原始编码'],['original','原始格式 · 不转换']]],['quality','画质',[['best','最佳画质'],['2160','最高 4K'],['1080','最高 1080p'],['720','最高 720p']]],['cookies','登录状态',[['none','不读取登录状态'],['chrome','使用 Chrome 登录'],['edge','使用 Edge 登录'],['firefox','使用 Firefox 登录']]]];
 for(const [key,label,options] of fields.filter(([key])=>m.type!=='page'||key!=='quality')){const control=dropdown({label,options:options.map(([value,label])=>({value,label})),value:value[key],onChange:selected=>{value[key]=selected;if(key==='cookies')onCookiesChange?.();details.firstChild.textContent='下载设置 · '+(value.format==='mp4'?'MP4':value.format==='original'?'原始格式':'MKV');}});control.dataset.setting=key;details.append(control);}
 return details;
}
async function nativeDownload(m){const options=settings.get(m.id)||{format:'mp4',quality:'best',cookies:'none'};await rpc('nativeStart',{url:m.url,title:m.title,...options});showTab(true);}
function renderPageVideo(m){
 const card=node('article','card page-video');card.dataset.mediaId=m.id;
 const preview=node('div','page-preview');const title=node('h2','',m.title);
 const cover=createCover(m,{tabId,rpc,cookies:()=>settings.get(m.id)?.cookies||'none',onTitle:value=>{title.textContent=value;}});
 previews.set(m.id,cover);preview.append(cover.element);
 const top=node('div','card-top');top.append(node('span','format','当前视频'),node('span','host',new URL(m.url).hostname));
 const quality=node('div','quality');let generation=0;
 const downloadSettings=nativeOptions(m,()=>{void loadQuality();});
 async function loadQuality(){
  const current=++generation;quality.replaceChildren(loadingState());
  try{
   const info=await cover.getInfo();if(current!==generation)return;
   const heights=(info.qualities||[]).filter(h=>Number.isInteger(h)&&h>0);
   const options=[{value:'best',label:'最佳画质（自动）'},...heights.map(h=>({value:String(h),label:`${h}p`}))];
   const value=settings.get(m.id);if(!options.some(o=>o.value===value.quality))value.quality='best';
   quality.replaceChildren(dropdown({label:'清晰度',options,value:value.quality,onChange:selected=>{value.quality=selected;}}));
  }catch(e){if(current!==generation)return;const message=node('div','quality-state');message.append(node('span','','画质解析失败，可按最佳画质下载'),button('重试','text-button',loadQuality));console.warn('画质解析失败',e);quality.replaceChildren(message);}
 }
 card.append(preview,top,title,quality,downloadSettings);void loadQuality();
 const actions=node('div','actions');actions.append(button('↓ 下载视频','primary',()=>nativeDownload(m)),button('复制链接','secondary',()=>navigator.clipboard.writeText(m.url)));card.append(actions);return card;
}
const inspectionQueue=[];
let inspecting=0;
function inspectChoices(m){
 const pending={status:'loading',sourceURL:m.url};choices.set(m.id,pending);
 inspectionQueue.push(async()=>{
  try{const result=await rpc('inspect',{mediaId:m.id});if(choices.get(m.id)===pending)choices.set(m.id,{...result,sourceURL:m.url});}
  catch(error){if(choices.get(m.id)===pending)choices.set(m.id,{status:'error',error:error.message,sourceURL:m.url});}
  finally{lastMedia='';void refresh();}
 });
 pumpInspections();
}
function pumpInspections(){while(inspecting<2&&inspectionQueue.length){inspecting++;inspectionQueue.shift()().finally(()=>{inspecting--;pumpInspections();});}}
function renderMedia(media){
  for(const [id,p] of previews)if(!media.some(m=>m.id===id)){p.destroy();previews.delete(id);}
  const parent=$('#media-list');
  for(const [id,entry] of mediaCards)if(!media.some(m=>m.id===id)){entry.card.remove();mediaCards.delete(id);}
  parent.querySelector('.empty')?.remove();
  if(!media.length){parent.append(empty('等你播放一段视频','打开网页并播放视频，Luffy 会在这里列出发现的媒体。'));return;}
  for(const m of media){
    if(m.type==='hls'&&choices.get(m.id)?.sourceURL!==m.url)inspectChoices(m);
    const key=JSON.stringify([m,choices.get(m.id)]);const cached=mediaCards.get(m.id);if(cached?.key===key)continue;
    if(m.type==='page'){if(cached){cached.key=key;continue;}const card=renderPageVideo(m);if(cached)cached.card.replaceWith(card);else parent.prepend(card);mediaCards.set(m.id,{key,card});continue;}
    const card=node('article','card');card.dataset.mediaId=m.id;const top=node('div','card-top');top.append(node('span','format',m.type==='hls'?'HLS':m.type==='dash'?'DASH':m.mime?.split('/')[1]?.split(';')[0]?.toUpperCase()||'VIDEO'),node('span','host',new URL(m.url).hostname));
    const meta=node('p','meta',m.type==='hls'?'分段视频 · 下载后合并为 MP4':m.type==='dash'?'DASH 分段视频 · 可用本机助手下载':formatBytes(m.size));
    if(!previews.has(m.id))previews.set(m.id,createPreview(m));
    card.append(previews.get(m.id).element,top,node('h2','',m.title),meta);
    const choice=choices.get(m.id);
    if(choice?.variants?.length){
      const row=node('div','quality');
      choice.selected??=choice.variants[0].index;
      const audioHost=node('div','audio-options');
      const updateAudio=()=>{
        audioHost.replaceChildren();const audios=choice.variants.find(v=>v.index===choice.selected)?.audios||[];
        choice.audio=audios.length?(choice.audio??Math.max(0,audios.findIndex(a=>a.default))):undefined;
        audioHost.hidden=audios.length<2;
        if(audios.length>1)audioHost.append(dropdown({label:'音轨',options:audios.map((a,i)=>({value:i,label:(/^audio$/i.test(a.name)?`音轨 ${i+1}`:a.name)+(a.language?` · ${a.language}`:'')})),value:choice.audio,onChange:value=>{choice.audio=value;}}));
      };
      row.append(dropdown({label:'清晰度',options:choice.variants.map(v=>({value:v.index,label:`${v.height?v.height+'p':'原始画质'} · ${(v.bandwidth/1e6).toFixed(1)} Mbps`})),value:choice.selected,onChange:value=>{choice.selected=value;choice.audio=undefined;updateAudio();}}),audioHost);
      updateAudio();card.append(row);
    }else if(choice?.kind==='media')meta.textContent=`HLS 点播 · ${Math.round(choice.duration)} 秒 · ${choice.segments} 个分片`;
    else if(m.type==='hls'){
      const state=choice?.status==='error'?node('div','quality-state'):loadingState();state.setAttribute('role','status');
      if(choice?.status==='error')state.append(node('span','','暂时无法获取画质'));
      if(choice?.status==='error'){state.append(button('重试','text-button',()=>{inspectChoices(m);lastMedia='';}));}
      card.append(state);
    }
    const actions=node('div','actions');
    if(m.type!=='dash'){
      const download=button('↓ 下载视频','primary',async()=>{
        const c=choices.get(m.id);await rpc('start',{mediaId:m.id,variantIndex:c?.selected,audioIndex:c?.audio});showTab(true);
      });
      download.disabled=m.type==='hls'&&!choice?.kind;actions.append(download);
    }
    if(m.type==='hls'||m.type==='dash'){card.append(nativeOptions(m));actions.append(button('本机下载','secondary',()=>nativeDownload(m)));}
    actions.append(button('复制链接','secondary',()=>navigator.clipboard.writeText(m.url).then(()=>notice('媒体链接已复制；部分网站的链接需要登录状态才能使用。'))));card.append(actions);if(cached)cached.card.replaceWith(card);else parent.append(card);mediaCards.set(m.id,{key:JSON.stringify([m,choices.get(m.id)]),card});
  }
}
const labels={queued:'等待下载',preparing:'准备中',downloading:'下载中',merging:'合并中',converting:'转换格式',saving:'保存中',complete:'已保存',cancelled:'已取消',error:'下载失败'};
function renderJobs(jobs){const parent=$('#job-list');parent.replaceChildren();if(!jobs.length){parent.append(empty('还没有下载任务','从「发现视频」选择一个视频开始下载。'));return;}
  for(const j of jobs){const card=node('article','card');const status=node('div','job-status'+(j.status==='error'?' error':''));status.append(node('span','',labels[j.status]||j.status),node('span','',j.bytes?formatBytes(j.bytes):''));card.append(status,node('h2','',j.title));
    if(!terminal(j.status)){const p=node('progress');p.max=100;p.value=j.progress||0;p.setAttribute('aria-label',`${labels[j.status]} ${j.progress||0}%`);card.append(p,node('div','meta',j.detail||'浏览器正在下载'));}
    if(j.error)card.append(node('p','error-text',j.error));
    const actions=node('div','job-actions');if(j.status==='complete'&&j.path&&!j.path.toLowerCase().endsWith('.mp4'))actions.append(button('转换为 MP4','secondary',()=>rpc('convertExisting',{id:j.id})));if(!terminal(j.status))actions.append(button('取消','secondary',()=>rpc('cancel',{id:j.id})));else if(j.status==='complete')actions.append(button('在文件夹中显示 ↗','text-button',()=>rpc('show',{id:j.id})));card.append(actions);parent.append(card);
  }
}
let refreshing=false;
async function refresh(){if(refreshing)return;refreshing=true;try{const s=await rpc('state',{tabId});currentTab=tabId?await chrome.tabs.get(tabId).catch(()=>null):null;s.media=videoList(s.media,currentTab);$('#media-count').textContent=s.media.length;$('#job-count').textContent=s.jobs.filter(j=>!terminal(j.status)).length||s.jobs.length;
  const mk=JSON.stringify(s.media);if(mk!==lastMedia){lastMedia=mk;renderMedia(s.media);}const jk=JSON.stringify(s.jobs);if(jk!==lastJobs){lastJobs=jk;renderJobs(s.jobs);}
}catch(e){notice(e.message);}finally{refreshing=false;}}
async function boot(){try{if(!tabId){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;}await refresh();setInterval(refresh,1200);}catch(e){notice(e.message);}}
window.addEventListener('pagehide',()=>{for(const p of previews.values())p.destroy();});
boot();

// Keep the MCP controls available in both the popup and the management page.
let mcpState=null,mcpBusy=false;
function renderMcp(value){
 mcpState=value;
 const indicatorState=value.error?'error':value.running?'running':value.enabled?'error':'off';
 const indicatorLabel={error:'MCP 服务异常',running:'MCP 服务运行正常',off:'MCP 服务未开启'}[indicatorState];
 $('#mcp-indicator').dataset.state=indicatorState;
 $('#mcp-indicator').title=indicatorLabel;
 $('#mcp-indicator').setAttribute('aria-label',indicatorLabel);
 $('#mcp-tab').title=indicatorLabel;
 $('#mcp-status').textContent=value.running?'运行中':value.error?(value.enabled?'连接失败':'助手未连接'):'已关闭';
 $('#mcp-status').dataset.running=String(!!value.running);
 $('#mcp-toggle').textContent=value.enabled?'关闭服务':'开启服务';
 $('#mcp-toggle').setAttribute('aria-checked',String(!!value.enabled));
 $('#mcp-toggle').disabled=mcpBusy;
 $('#mcp-copy').disabled=!value.config;
 $('#mcp-copy-json').disabled=!value.config;
 $('#mcp-retry').hidden=!value.error;
 $('#mcp-error').hidden=!value.error;
 $('#mcp-error').textContent=value.error||'';
 const configText=value.config?JSON.stringify(value.config,null,2):'更新本机助手后可读取此电脑的 MCP 配置。';
 if($('#mcp-config-text').value!==configText)$('#mcp-config-text').value=configText;
}
async function refreshMcp(){
 if(mcpBusy)return;mcpBusy=true;
 try{renderMcp(await rpc('mcpStatus'));}
 catch(e){renderMcp({enabled:mcpState?.enabled||false,running:false,error:e.message});}
 finally{mcpBusy=false;$('#mcp-toggle').disabled=false;}
}
async function setMcp(enabled){
 if(mcpBusy)return;mcpBusy=true;$('#mcp-toggle').disabled=true;
 try{renderMcp(await rpc('mcpSetEnabled',{enabled}));}
 catch(e){renderMcp({...mcpState,running:false,error:e.message});}
 finally{mcpBusy=false;$('#mcp-toggle').disabled=false;}
}
$('#mcp-toggle').onclick=()=>setMcp(!mcpState?.enabled);
$('#mcp-retry').onclick=()=>mcpState?.enabled?setMcp(true):refreshMcp();
function mcpInstallInstructions(){
 return `请帮我在当前本地 Agent 客户端中安装 Luffy 视频下载 MCP 服务。它可以读取浏览器当前页面的视频、下载指定视频、查询进度和取消任务。

接入方式：stdio。以下是这台电脑的实际配置，请按当前客户端支持的格式添加 luffy-video，并保留已有的其他 MCP 配置。

${JSON.stringify(mcpState.config,null,2)}

先检查 command 指向的启动脚本是否存在。如果不存在，请提示我运行 Luffy 安装包中的 Install-Luffy-Helper.command，不要猜测其他路径。

配置完成后，连接服务并检查工具列表及 list_connections。浏览器需要保持打开，并在 Luffy 的「MCP 服务」Tab 开启服务；没有连接时，请提醒我检查开关。若客户端需要重启或重新加载配置，请告诉我具体步骤。最后报告是否接入成功。`;
}
async function copyMcp(text,buttonId,label,fallbackId){
 try{await navigator.clipboard.writeText(text);$(buttonId).textContent='已复制';setTimeout(()=>{$(buttonId).textContent=label;},2000);}
 catch{const field=$(fallbackId);field.value=text;field.hidden=false;field.focus();field.select();notice('自动复制失败，已选中文本，请按 ⌘C / Ctrl+C 复制。');}
}
$('#mcp-copy').onclick=()=>{if(mcpState?.config)return copyMcp(mcpInstallInstructions(),'#mcp-copy','复制安装说明，发给 Agent','#mcp-install-text');};
$('#mcp-copy-json').onclick=()=>{if(mcpState?.config)return copyMcp(JSON.stringify(mcpState.config,null,2),'#mcp-copy-json','复制 JSON','#mcp-config-text');};
$('#app-version').textContent='v'+chrome.runtime.getManifest().version;
void refreshMcp();setInterval(refreshMcp,4000);
