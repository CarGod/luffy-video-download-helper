export function httpURL(value, base) {
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持 HTTP/HTTPS 媒体地址');
  url.hash = '';
  return url.href;
}
export function classify(url, mime = '') {
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return null; }
  if (/\.(ts|m4s|m2ts|aac|key)$/.test(path)) return null;
  if (/mpegurl/i.test(mime) || /\.m3u8$/.test(path)) return 'hls';
  if (/dash\+xml/i.test(mime) || /\.mpd$/.test(path)) return 'dash';
  if (/^(video|audio)\//i.test(mime) || /\.(mp4|webm|mkv|mov|mp3|m4a|ogg|wav)$/.test(path)) return 'file';
  return null;
}
export function filename(title, extension = 'mp4') {
  let base = (title || 'Luffy video').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\.(mp4|webm|mkv|mov|mp3|m4a|ogg|wav)$/i, '').replace(/[. ]+$/g, '').trim();
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'Luffy video';
  return Array.from(base).slice(0, 85).join('') + '.' + extension.replace(/[^a-z0-9]/gi, '');
}
export function fileExtension(url, mime = '') {
  const ext = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (['mp4','webm','mkv','mov','mp3','m4a','ogg','wav'].includes(ext)) return ext;
  return ({'video/webm':'webm','audio/mpeg':'mp3','audio/mp4':'m4a','audio/ogg':'ogg','video/quicktime':'mov'})[mime.split(';')[0]] || 'mp4';
}
export function formatBytes(n = 0) {
  if (!n) return '大小未知';
  const unit = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B','KB','MB','GB'][unit]}`;
}
export const terminal = status => ['complete', 'error', 'cancelled'].includes(status);
