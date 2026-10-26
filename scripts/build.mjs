import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { patchFFmpegWorker } from './ffmpeg-worker-patch.mjs';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
await cp('public','dist',{recursive:true});
await build({entryPoints:['src/background.js','src/offscreen.js','src/ui.js','src/content.js'],outdir:'dist',bundle:true,format:'esm',target:'chrome116',minify:false,legalComments:'eof',external:['./vendor/ffmpeg/index.js']});
await cp('node_modules/@ffmpeg/ffmpeg/dist/esm','dist/vendor/ffmpeg',{recursive:true});
// writeFile transfers the buffer to the worker. Let MEMFS own that buffer
// instead of cloning every input segment. Fail if the pinned wrapper changes.
const workerPath='dist/vendor/ffmpeg/worker.js';
const worker=await readFile(workerPath,'utf8');
await writeFile(workerPath,patchFFmpegWorker(worker));
await cp('node_modules/@ffmpeg/core/dist/esm','dist/vendor/core',{recursive:true});
await cp('THIRD_PARTY_NOTICES.md','dist/THIRD_PARTY_NOTICES.md');
await mkdir('dist/licenses',{recursive:true});
for (const [name,path] of [['ffmpeg-wrapper','@ffmpeg/ffmpeg'],['ffmpeg-core','@ffmpeg/core'],['m3u8-parser','m3u8-parser']]) {
  for (const f of ['LICENSE','LICENSE.md','LICENSE.txt']) {
    try { await cp(`node_modules/${path}/${f}`,`dist/licenses/${name}.txt`);break; } catch {}
  }
}
console.log('Built dist/ — load this directory as an unpacked extension.');
