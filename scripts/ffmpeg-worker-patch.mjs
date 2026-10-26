// FFmpeg.writeFile transfers ownership to the worker, so MEMFS can adopt the
// input buffer. Keep the patch explicit and fail when the pinned wrapper changes.
export function patchFFmpegWorker(source) {
  const original='ffmpeg.FS.writeFile(path, data);';
  if(source.split(original).length!==2)throw new Error('Unexpected FFmpeg writeFile implementation; review buffer ownership patch.');
  return source.replace(original,'ffmpeg.FS.writeFile(path, data, { canOwn: true });');
}
