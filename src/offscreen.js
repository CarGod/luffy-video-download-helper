import { parsePlaylist, selectVariant, decryptSegment } from './hls.js';
import { filename, httpURL } from './media.js';
import { FFmpeg } from './vendor/ffmpeg/index.js';

const queue=[];
const blobs=new Map();
const saves=new Map();
let active=null;
async function rpc(type,data={}) {
  const r=await chrome.runtime.sendMessage({target:'background',type,...data});
  if(!r?.ok)throw new Error(r?.error||'后台连接中断');return r.value;
}
const update=(id,patch)=>rpc('patch',{id,patch});
function abortCheck(signal){if(signal.aborted)throw new DOMException('已取消','AbortError');}
async function request(url,source,signal,{range=null,limit=Infinity}={}) {
  url=httpURL(url);
  for(let attempt=0;attempt<3;attempt++) {
    abortCheck(signal);
    let ruleId;
    const controller=new AbortController();
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(abort,45000);
    try {
      ruleId=await rpc('headerRule',{url,source});
      const headers=range?{Range:`bytes=${range.offset}-${range.offset+range.length-1}`} : {};
      const response=await fetch(url,{credentials:'include',headers,signal:controller.signal,cache:'no-store'});
      if(!response.ok){
        const e=new Error(`服务器返回 HTTP ${response.status}${[401,403].includes(response.status)?'，请在原页面登录并刷新视频':''}`);
        e.retry=response.status===429||response.status>=500;throw e;
      }
      if(range){
        const actual=response.headers.get('content-range');
        if(response.status!==206 || !actual?.startsWith(`bytes ${range.offset}-${range.offset+range.length-1}/`))throw new Error('服务器未正确响应分片字节范围');
      }
      if(Number(response.headers.get('content-length'))>limit)throw new Error('服务器响应超过资源允许大小');
      const reader=response.body.getReader();const chunks=[];let size=0;
      try {
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('服务器响应超过资源允许大小');}chunks.push(value);}
      } finally {reader.releaseLock();}
      if(range && size!==range.length)throw new Error('分片数据不完整');
      let bytes;
      if(chunks.length===1){
        const chunk=chunks[0];
        // Reuse complete buffers, but do not retain an oversized pooled buffer.
        bytes=chunk.byteOffset===0&&chunk.byteLength===chunk.buffer.byteLength?chunk:chunk.slice();
      }else{
        bytes=new Uint8Array(size);let offset=0;
        for(let i=0;i<chunks.length;i++){
          const chunk=chunks[i];bytes.set(chunk,offset);offset+=chunk.length;chunks[i]=null;
        }
      }
      chunks.length=0;
      return {bytes,url:response.url};
    }catch(e){
      abortCheck(signal);
      if(attempt===2 || (e.retry!==true && !(e instanceof TypeError) && e.name!=='AbortError'))throw e;
      await new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new DOMException('已取消','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},(attempt+1)*600);signal.addEventListener('abort',stop,{once:true});});
    }finally{
      clearTimeout(timeout);controller.abort();signal.removeEventListener('abort',abort);
      if(ruleId)await rpc('removeRule',{id:ruleId}).catch(()=>{});
    }
  }
}
async function playlist(url,source,signal) {
  const response=await request(url,source,signal,{limit:4*1024*1024});
  return parsePlaylist(new TextDecoder().decode(response.bytes),response.url);
}
async function resolveMedia(url,source,signal,depth=0) {
  if(depth>3)throw new Error('播放清单嵌套层级过深');
  const parsed=await playlist(url,source,signal);
  if(parsed.kind==='media')return parsed;
  return resolveMedia(selectVariant(parsed).url,source,signal,depth+1);
}
async function run(item) {
  const {job,source}=item;
  const controller=new AbortController();
  active={id:job.id,controller,ffmpeg:null};
  const signal=controller.signal;
  const keepalive=setInterval(()=>update(job.id,{heartbeat:Date.now()}).then(status=>{
    // Recover lost completion/release messages after a background restart.
    // Never expire a Blob while Chrome is still saving it.
    if(saves.has(job.id)&&['complete','error','cancelled','missing'].includes(status))release(job.id);
  }).catch(()=>{}),20000);
  let ffmpeg;
  try {
    await update(job.id,{status:'preparing',detail:'解析播放清单'});
    const first=await playlist(source.url,source,signal);
    const selected=selectVariant(first,item.variantIndex);
    const video=selected?await resolveMedia(selected.url,source,signal):first;
    const tracks=[video];
    if(selected?.audios.length){
      const audio=item.audioIndex==null ? (selected.audios.find(x=>x.default)||selected.audios[0]) : selected.audios[Number(item.audioIndex)];
      if(!audio)throw new Error('所选音轨已失效，请重新解析');
      if(audio.url)tracks.push(await resolveMedia(audio.url,source,signal));
    }
    abortCheck(signal);
    await update(job.id,{status:'preparing',detail:'加载本地合并引擎'});
    ffmpeg=new FFmpeg();active.ffmpeg=ffmpeg;
    await ffmpeg.load({coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
    let log=[];ffmpeg.on('log',({message})=>{log.push(message);if(log.length>12)log.shift();});
    let totalBytes=0,finished=0;
    const count=tracks.reduce((sum,t)=>sum+t.segments.length,0);
    const keys=new Map();
    const getBytes=async part=>{
      abortCheck(signal);
      const result=await request(part.url,source,signal,{range:part.range});
      totalBytes+=result.bytes.length;
      if(!part.encryption)return result.bytes;
      const enc=part.encryption;
      if(!keys.has(enc.url))keys.set(enc.url,(await request(enc.url,source,signal,{limit:16})).bytes);
      return decryptSegment(result.bytes,keys.get(enc.url),enc.iv);
    };
    await update(job.id,{status:'downloading',detail:`下载 ${count} 个分片`});
    for(let t=0;t<tracks.length;t++){
      const track=tracks[t];const maps=new Map();let lastMap='';
      const lines=['#EXTM3U','#EXT-X-VERSION:7',`#EXT-X-TARGETDURATION:${Math.ceil(track.targetDuration)}`,'#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD'];
      for(let i=0;i<track.segments.length;i++){
        abortCheck(signal);
        const segment=track.segments[i];
        if(segment.discontinuity)lines.push('#EXT-X-DISCONTINUITY');
        if(segment.map){
          const key=JSON.stringify(segment.map);
          if(!maps.has(key)){const name=`t${t}_init${maps.size}.mp4`;await ffmpeg.writeFile(name,await getBytes(segment.map));maps.set(key,name);}
          if(key!==lastMap){lines.push(`#EXT-X-MAP:URI="${maps.get(key)}"`);lastMap=key;}
        }
        const name=`t${t}_s${i}.${segment.map?'m4s':'ts'}`;
        await ffmpeg.writeFile(name,await getBytes(segment));
        lines.push(`#EXTINF:${segment.duration},`,name);
        finished++;
        await update(job.id,{bytes:totalBytes,progress:Math.round(finished/count*90),detail:`分片 ${finished} / ${count}`});
      }
      lines.push('#EXT-X-ENDLIST');
      await ffmpeg.writeFile(`track${t}.m3u8`,new TextEncoder().encode(lines.join('\n')));
    }
    abortCheck(signal);
    await update(job.id,{status:'merging',progress:93,detail:'合并音视频，保留原始画质'});
    const args=['-hide_banner','-loglevel','warning'];
    for(let t=0;t<tracks.length;t++)args.push('-allowed_extensions','ALL','-protocol_whitelist','file,crypto,data','-i',`track${t}.m3u8`);
    args.push('-map','0:v:0?','-map',tracks.length>1?'1:a:0':'0:a:0?','-c','copy','-movflags','+faststart','output.mp4');
    const result=await ffmpeg.exec(args,120000);
    if(result!==0)throw new Error('音视频合并失败，可能是编码不兼容或处理超时。');
    abortCheck(signal);
    let data=await ffmpeg.readFile('output.mp4');
    if(data.length<100)throw new Error('合并结果为空');
    // readFile transfers the result. Drop all worker/MEMFS input buffers before
    // allocating the output Blob and waiting for the browser to save it.
    ffmpeg.terminate();ffmpeg=null;active.ffmpeg=null;
    const url=URL.createObjectURL(new Blob([data],{type:'video/mp4'}));
    data=null;
    blobs.set(job.id,url);
    // A small download can finish before the saveBlob RPC returns.
    const saved=new Promise(resolve=>saves.set(job.id,resolve));
    const accepted=await rpc('saveBlob',{id:job.id,url,filename:filename(job.title)});
    if(!accepted||signal.aborted)release(job.id);
    // Avoid overlapping a large saved result with the next HLS input set.
    await saved;
  }catch(e){
    release(job.id);
    await update(job.id,{status:signal.aborted?'cancelled':'error',error:signal.aborted?'':(e.message||'下载失败')}).catch(()=>{});
  }finally{
    clearInterval(keepalive);ffmpeg?.terminate();active=null;
  }
}
function release(id){
  const url=blobs.get(id);if(url)URL.revokeObjectURL(url);blobs.delete(id);
  const resolve=saves.get(id);saves.delete(id);resolve?.();
}
let pumping=false;
async function pump(){if(pumping)return;pumping=true;try{while(queue.length)await run(queue.shift());}finally{pumping=false;}}
async function handle(m) {
  if(m.type==='ready')return true;
  if(m.type==='inspect'){
    const parsed=await playlist(m.source.url,m.source,new AbortController().signal);
    return parsed.kind==='master'?{kind:'master',variants:parsed.variants}:{kind:'media',duration:parsed.duration,segments:parsed.segments.length};
  }
  if(m.type==='enqueue'){queue.push(m);void pump();return;}
  if(m.type==='release'){release(m.id);return;}
  if(m.type==='cancel'){
    const index=queue.findIndex(x=>x.job.id===m.id);if(index>=0)queue.splice(index,1);
    if(active?.id===m.id){active.controller.abort();active.ffmpeg?.terminate();}
    release(m.id);return;
  }
  throw new Error('未知引擎操作');
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m.target!=='offscreen'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('background.js'))return;
  handle(m).then(value=>reply({ok:true,value}),e=>reply({ok:false,error:e.message}));return true;
});
