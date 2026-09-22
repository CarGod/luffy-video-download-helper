import { loadingState } from './loading.js';
import {createPreview,durationText} from './preview.js';

// A cover is cheap to show; initialize video/segment requests only on a click.
export function createCover(source,{tabId,rpc,cookies,onTitle}){
 const element=document.createElement('div');element.className='video-cover loading';
 const button=document.createElement('button');button.className='cover-button';button.setAttribute('aria-label','▶ 预览视频');
 const img=document.createElement('img');img.className='cover-image';img.alt='视频封面';img.hidden=true;img.referrerPolicy='no-referrer';
 const play=document.createElement('span');play.className='cover-play';play.textContent='▶';
 const label=document.createElement('span');label.className='cover-label';label.textContent='正在获取视频封面…';
 const error=document.createElement('p');error.className='error-text cover-error';error.setAttribute('role','status');
 const duration=document.createElement('span');duration.className='preview-duration';
 button.append(img,play,label,duration);element.append(button,error);
 let disposed=false,player=null,metadata=null,pending=null,lastCookies=null,triedFallback=false;
 async function resolveInfo(value){
  const local=await rpc('pageCover',{tabId,url:source.url}).catch(()=>null);
  if(local?.url){
   const info={...local,title:source.title};
   if(local.type==='hls'&&local.id){const parsed=await rpc('inspect',{mediaId:local.id});info.qualities=[...new Set((parsed.variants||[]).map(v=>v.height).filter(Boolean))].sort((a,b)=>b-a);}
   return info;
  }
  return rpc('nativePreview',{url:source.url,cookies:value});
 }
 function getInfo(){
  const value=cookies();
  if(value!==lastCookies){metadata=null;pending=null;lastCookies=value;}
  if(metadata)return Promise.resolve(metadata);
  if(!pending){const choice=value;pending=resolveInfo(value).then(info=>{if(choice===lastCookies)metadata=info;return info;}).finally(()=>{if(choice===lastCookies)pending=null;});}
  return pending;
 }
 function fallback(){if(disposed||player)return;element.classList.remove('loading');label.textContent='暂无封面 · 点击预览';}
 function showPoster(url,seconds){
  if(disposed||player||!/^https?:\/\//.test(url||''))return false;
  img.onload=()=>{if(disposed||player)return;img.hidden=false;element.classList.remove('loading');label.textContent='点击播放';duration.textContent=durationText(seconds);};
  img.onerror=()=>{img.hidden=true;if(!triedFallback)void nativeCover();else fallback();};
  img.src=url;return true;
 }
 async function nativeCover(){
  if(triedFallback||disposed)return;triedFallback=true;
  try{const info=await getInfo();if(!showPoster(info.poster,info.duration))fallback();}
  catch(e){fallback();button.title=e.message;}
 }
 async function loadCover(){
  try{const info=await rpc('pageCover',{tabId,url:source.url});if(disposed)return;if(showPoster(info?.poster,info?.duration))return;}catch{}
  if(!disposed)await nativeCover();
 }
 button.onclick=async()=>{
  button.disabled=true;error.textContent='';label.textContent='正在加载视频…';const loading=loadingState('正在准备预览','连接视频资源，请稍候');loading.classList.add('cover-loading');element.append(loading);
  try{
   const info=await getInfo();if(disposed)return;
   player=createPreview(info);element.replaceChildren(player.element);element.classList.remove('loading');onTitle(info.title);
  }catch(e){if(!disposed){label.textContent='预览失败 · 点击重试';console.warn('预览加载失败',e);button.title='暂时无法加载预览，请稍后重试';error.textContent='暂时无法加载预览，请稍后重试';metadata=null;}}
  finally{loading.remove();button.disabled=false;}
 };
 void loadCover();
 return {element,getInfo,destroy(){disposed=true;img.onload=null;img.onerror=null;img.removeAttribute('src');player?.destroy();}};
}
