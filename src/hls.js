import { Parser } from 'm3u8-parser';
import { httpURL } from './media.js';

export function ivBytes(words, sequence) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  if (words) {
    if (words.length !== 4) throw new Error('无效的 AES IV');
    words.forEach((w, i) => view.setUint32(i * 4, w));
  } else {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('无效的分片序号');
    view.setBigUint64(8, BigInt(sequence));
  }
  return bytes;
}
function encryption(key, base, sequence, isMap = false) {
  if (!key) return null;
  if (key.method !== 'AES-128' || (key.keyFormat && key.keyFormat !== 'identity')) throw new Error('此视频使用 DRM 或不支持的加密方式');
  if (isMap && !key.iv) throw new Error('加密初始化分片缺少明确 IV');
  return { url: httpURL(key.uri, base), iv: [...ivBytes(key.iv, sequence)] };
}
export function parsePlaylist(text, base) {
  if (text.length > 4 * 1024 * 1024) throw new Error('播放清单过大');
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('服务器未返回有效 HLS 清单，可能需要重新登录或刷新视频');
  // Reject unsupported encryption before a permissive parser can silently discard it.
  for (const line of text.split(/\r?\n/)) {
    if (/^#EXT-X-(KEY|SESSION-KEY):/.test(line)) {
      const method = line.match(/(?:^|[:,])METHOD=([^,]+)/)?.[1];
      const format = line.match(/KEYFORMAT="([^"]+)"/)?.[1];
      if (!['NONE','AES-128'].includes(method) || (format && format !== 'identity')) throw new Error('此视频使用 DRM 或不支持的加密方式');
      if (/SESSION-KEY/.test(line)) throw new Error('暂不支持使用 SESSION-KEY 的播放清单');
    }
  }
  if (/#EXT-X-(GAP|SKIP|PART):?/.test(text)) throw new Error('暂不支持含缺失分片或低延迟分片的清单');
  let pendingRange=null, previousRange=null, previousURI=null;
  for(const line of text.split(/\r?\n/).map(x=>x.trim())){
    if(line.startsWith('#EXT-X-BYTERANGE:'))pendingRange=line.slice(17);
    else if(line && !line.startsWith('#')){
      const uri=httpURL(line,base);
      if(pendingRange && !pendingRange.includes('@') && (!previousRange || previousURI!==uri))throw new Error('隐式字节范围缺少同一资源的前序分片');
      previousRange=pendingRange;previousURI=uri;pendingRange=null;
    }
  }
  const parser = new Parser(); parser.push(text); parser.end();
  const m = parser.manifest;
  if (m.playlists?.length) {
    const variants = m.playlists.map((p, index) => {
      const a = p.attributes || {};
      const group = m.mediaGroups?.AUDIO?.[a.AUDIO] || {};
      const audios = Object.entries(group).map(([name, x]) => ({name, language:x.language || '', default:!!x.default, url:x.uri ? httpURL(x.uri, base) : null}));
      return {index, url:httpURL(p.uri, base), bandwidth:a.BANDWIDTH || 0, height:a.RESOLUTION?.height || 0, codecs:a.CODECS || '', audios};
    }).sort((a,b)=>b.height-a.height || b.bandwidth-a.bandwidth);
    return {kind:'master', variants};
  }
  if (!m.endList) throw new Error('这是直播或未结束的播放清单；第一版仅支持点播');
  if (!m.segments?.length) throw new Error('清单中没有可下载的分片');
  if (m.segments.length > 10000) throw new Error('分片过多，超出第一版处理范围');
  const segments = m.segments.map((s, i) => {
    const url = httpURL(s.uri, base);
    let range = null;
    if (s.byterange) {
      const {length, offset} = s.byterange;
      if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的分片字节范围');
      // m3u8-parser fills implicit offsets; the spec requires the same preceding resource.
      range = {offset, length};
    }
    const map = s.map ? {url:httpURL(s.map.uri, base), range:s.map.byterange || null, encryption:encryption(s.map.key || s.key, base, m.mediaSequence+i, true)} : null;
    return {url, range, map, duration:s.duration || 0, discontinuity:!!s.discontinuity, encryption:encryption(s.key, base, (m.mediaSequence || 0)+i)};
  });
  return {kind:'media', segments, duration:segments.reduce((sum,s)=>sum+s.duration,0), targetDuration:m.targetDuration || 10};
}
export function selectVariant(playlist, index) {
  if (playlist.kind !== 'master') return null;
  const selected = index == null ? playlist.variants[0] : playlist.variants.find(v=>v.index === Number(index));
  if (!selected) throw new Error('所选清晰度已失效，请重新解析');
  return selected;
}
export async function decryptSegment(data, key, iv) {
  if (key.byteLength !== 16) throw new Error('AES-128 密钥长度无效');
  const imported = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  try { return new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC', iv:new Uint8Array(iv)}, imported, data)); }
  catch { throw new Error('分片解密失败，请刷新页面重新获取视频'); }
}
