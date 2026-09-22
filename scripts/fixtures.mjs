import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
export const root=resolve('artifacts/fixtures');
export async function fixtures(){
 await mkdir(root,{recursive:true});
 const ff=(args)=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args]);
 ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-t','6','-c:v','libx264','-pix_fmt','yuv420p','-g','48','-c:a','aac',`${root}/sample.mp4`]);
 for(const kind of ['plain','encrypted','fmp4','separate','range'])await mkdir(`${root}/${kind}`,{recursive:true});
 await writeFile(`${root}/encrypted/key.bin`,randomBytes(16));await writeFile(`${root}/encrypted/keyinfo`, `key.bin\n${root}/encrypted/key.bin\n`);
 const input=['-i',`${root}/sample.mp4`,'-c','copy','-hls_time','2','-hls_playlist_type','vod'];
 ff([...input,`${root}/plain/index.m3u8`]);
 ff([...input,'-hls_key_info_file',`${root}/encrypted/keyinfo`,`${root}/encrypted/index.m3u8`]);
 ff([...input,'-hls_flags','single_file',`${root}/range/index.m3u8`]);
 ff([...input,'-hls_segment_type','fmp4',`${root}/fmp4/index.m3u8`]);
 ff([...input,'-an',`${root}/separate/video.m3u8`]);
 ff([...input,'-vn',`${root}/separate/audio.m3u8`]);
 await writeFile(`${root}/separate/master.m3u8`,'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,AUDIO="a"\nvideo.m3u8\n');
 await writeFile(`${root}/index.html`, '<!doctype html><title>Luffy fixture video</title><h1>Luffy download verification</h1><video controls src="sample.mp4"></video><button onclick="fetch(\'/plain/index.m3u8\')">Discover HLS</button>');
}
export function serve(){return new Promise(resolveServer=>{
 const server=createServer(async(req,res)=>{
  try{
   let path=new URL(req.url,'http://localhost').pathname;
   if(process.env.LUFFY_DEBUG&&path.startsWith('/protected/'))console.log('SERVER HEADER',path,req.headers.referer);
   if(path.startsWith('/protected/') && !req.headers.referer?.startsWith('http://127.0.0.1:18765/')){res.writeHead(403);res.end();return;}
   if(path.startsWith('/protected/'))path=path.replace('/protected/','/plain/');
   if(path==='/slow/index.m3u8'){res.setHeader('Content-Type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST');return;}
   if(path==='/slow/segment.ts'){res.setHeader('Content-Type','video/mp2t');res.write(Buffer.alloc(100));const timer=setTimeout(()=>res.end(),15000);req.on('close',()=>clearTimeout(timer));return;}
   if(path==='/')path='/index.html';
   const file=resolve(root,'.'+path);if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}
   const data=await readFile(file);const type=({'.html':'text/html','.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.m4s':'video/iso.segment'})[extname(file)]||'application/octet-stream';
   res.setHeader('Content-Type',type);res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Accept-Ranges','bytes');
   if(req.headers.range){const [a,b]=req.headers.range.match(/\d+/g).map(Number);const end=Math.min(b||data.length-1,data.length-1);res.writeHead(206,{'Content-Range':`bytes ${a}-${end}/${data.length}`,'Content-Length':end-a+1});res.end(data.subarray(a,end+1));}
   else{res.setHeader('Content-Length',data.length);res.end(data);}
  }catch{res.writeHead(404);res.end();}
 });server.listen(18765,'127.0.0.1',()=>resolveServer(server));
 });}
if(process.argv[1]===new URL(import.meta.url).pathname){await fixtures();await serve();console.log('Fixtures: http://127.0.0.1:18765');}
