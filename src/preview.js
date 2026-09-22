import Hls from 'hls.js';
export function durationText(seconds){if(!Number.isFinite(seconds)||seconds<=0)return '';const s=Math.round(seconds);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
const players=new Set();
export function stopPreviews(){for(const p of players)p.pause();}
export function createPreview(source){
 const root=document.createElement('div');root.className='video-preview';
 const video=document.createElement('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.muted=true;
 video.setAttribute('aria-label',`视频预览：${source.title||'视频'}`);
 if(/^https?:/.test(source.poster||''))video.poster=source.poster;
 const start=document.createElement('button');start.className='preview-start';start.textContent='▶ 点击预览';
 const caption=document.createElement('span');caption.className='preview-duration';caption.textContent=durationText(source.duration);
 const status=document.createElement('p');status.className='preview-status';status.setAttribute('role','status');
 root.append(video,start,caption,status);
 let hls,port,closed=false,loaded=false,counter=0;
 const pending=new Map();
 function connect(){
  if(port)return;
  port=chrome.runtime.connect({name:'luffy-preview'});
  port.onMessage.addListener(m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value);}});
  port.onDisconnect.addListener(()=>{for(const p of pending.values())p.reject(Error('预览连接已关闭'));pending.clear();});
 }
 function request(type,data={}){connect();return new Promise((resolve,reject)=>{const id=++counter;pending.set(id,{resolve,reject});port.postMessage({id,type,source,...data});});}
 function fail(text='此链接暂时无法播放，可尝试本机解析或回原网页查看。'){status.textContent=text;start.hidden=true;}
 async function load(play=false){
  if(closed)return;
  if(loaded){if(play)await video.play().catch(()=>fail('请使用播放器的播放按钮重试'));return;}
  loaded=true;start.disabled=true;status.textContent='正在加载预览…';
  try{
   if(!source.url)throw Error('没有可直接播放的音视频流，请在原网页查看。');
   if(source.type==='dash')throw Error('DASH 暂无内嵌预览，请使用上方本机解析或查看原网页。');
   if(source.type==='hls'){
    if(!Hls.isSupported())throw Error('当前浏览器不支持 HLS 预览');
    class Loader extends Hls.DefaultConfig.loader {
     load(context,config,callbacks){
      this.closed=false;
      request('rule',{url:context.url,resourceType:'xmlhttprequest'}).then(rule=>{
       this.rule=rule;if(this.closed){this.release();return;}
       const wrapped={...callbacks};for(const key of ['onSuccess','onError','onTimeout','onAbort'])if(callbacks[key])wrapped[key]=(...args)=>{this.release();callbacks[key](...args);};
       super.load(context,config,wrapped);
      }).catch(e=>{if(!this.closed)callbacks.onError({code:0,text:e.message},context,null,this.stats);});
     }
     release(){if(this.rule){request('release',{rule:this.rule}).catch(()=>{});this.rule=null;}}
     abort(){this.closed=true;this.release();super.abort();}
     destroy(){this.closed=true;this.release();super.destroy();}
    }
    hls=new Hls({enableWorker:false,loader:Loader,maxBufferLength:6,maxMaxBufferLength:12,maxBufferSize:8*1024*1024,startLevel:0,capLevelToPlayerSize:true,xhrSetup:xhr=>{xhr.withCredentials=true;}});
    hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal){console.warn('Preview failed:',data.details,data.error?.message);hls.destroy();hls=null;fail();}});
    hls.loadSource(source.url);hls.attachMedia(video);
   }else{
    await request('rule',{url:source.url,resourceType:'media'});if(closed)return;video.src=source.url;video.load();
   }
   start.hidden=true;
   if(play)video.play().catch(()=>{status.textContent='预览已加载，点击播放器播放。';});
  }catch(e){fail(e.message);}
 }
 video.addEventListener('loadedmetadata',()=>{caption.textContent=durationText(video.duration)||durationText(source.duration);});
 video.addEventListener('loadeddata',()=>{status.textContent='';root.dataset.ready='true';});
 video.addEventListener('error',()=>fail());
 video.addEventListener('play',()=>{for(const p of players)if(p!==video)p.pause();});
 players.add(video);start.onclick=()=>load(true);
 const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();void load(false);}},{rootMargin:'30px'});
 observer.observe(root);
 return {element:root,destroy(){if(closed)return;closed=true;observer.disconnect();players.delete(video);video.pause();hls?.destroy();video.removeAttribute('src');video.load();port?.disconnect();}};
}
