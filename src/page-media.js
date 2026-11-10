const xHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

export function isXPost(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && xHosts.has(url.hostname) &&
      /^\/[^/]+\/status\/\d+(?:\/video\/\d+)?\/?$/.test(url.pathname);
  } catch { return false; }
}

// Only complete media for the visible video's exact asset may replace a post.
// Audio renditions, initialization fragments and videos in replies are not it.
export function matchingXMedia(info, media) {
  let asset;
  try {
    const poster = new URL(info?.poster);
    if (poster.hostname !== 'pbs.twimg.com') return null;
    asset = poster.pathname.match(/^\/(ext_tw_video|amplify_video)_thumb\/(\d+)\//);
  } catch { return null; }
  if (!asset) return null;
  const prefix = `/${asset[1]}/${asset[2]}/`;
  const candidates = media.flatMap(item => {
    try {
      const url = new URL(item.url);
      if (url.protocol !== 'https:' || url.hostname !== 'video.twimg.com' || !url.pathname.startsWith(prefix)) return [];
      const path = url.pathname.slice(prefix.length);
      if (item.type === 'hls' && /^(?:pu\/)?pl\/[^/]+\.m3u8$/.test(path)) return [{item, rank:Infinity}];
      const full = path.match(/^(?:pu\/)?vid\/(?:avc1\/)?(\d+)x(\d+)\/[^/]+\.mp4$/);
      return item.type === 'file' && full ? [{item, rank:Number(full[1]) * Number(full[2])}] : [];
    } catch { return []; }
  });
  candidates.sort((a,b) => b.rank - a.rank || (b.item.foundAt || 0) - (a.item.foundAt || 0));
  return candidates[0]?.item || null;
}

// Runs in the target tab through chrome.scripting, so keep it self-contained.
export function capturePageVideo(expected) {
  if (location.href !== expected) return null;
  const url = new URL(expected);
  const isX = ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname);
  let root = document;
  if (isX) {
    const status = url.pathname.match(/\/status\/(\d+)/)?.[1];
    root = [...document.querySelectorAll('article')].find(article =>
      [...article.querySelectorAll('a[href]')].some(a => a.querySelector('time') &&
        new URL(a.href).pathname.match(/\/status\/(\d+)/)?.[1] === status));
    if (!root) return null;
  }
  const videos = [...root.querySelectorAll('video')];
  const covers = [...root.querySelectorAll('img')].filter(img =>
    /^https:\/\/pbs\.twimg\.com\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(img.currentSrc || img.src));
  // Do not replace an explicit later video or an ambiguous multi-player post
  // with the first DOM video. Native extraction preserves its index semantics.
  const index = Number(url.pathname.match(/\/video\/(\d+)/)?.[1] || 1);
  if (isX && (index > 1 || videos.length > 1 || (!videos.length && covers.length > 1))) return null;
  const video = videos[0], cover = covers[0];
  const poster = video?.poster || cover?.currentSrc || cover?.src ||
    (root === document ? document.querySelector('meta[property="og:image"],meta[name="twitter:image"]')?.content : null);
  // Attribution links must belong to this player, not arbitrary post text.
  const player = isX && (video?.closest('[data-testid="videoComponent"]') || video?.closest('[data-testid="videoPlayer"]'));
  const sourcePost = player && [...player.querySelectorAll('a[href]')].map(a => a.href).find(href => {
    try {
      const target = new URL(href);
      return target.protocol === 'https:' && ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(target.hostname) &&
        /^\/[^/]+\/status\/\d+\/video\/\d+\/?$/.test(target.pathname);
    } catch { return false; }
  });
  return {poster:poster && /^https?:/.test(poster) ? poster : null,
    duration:Number.isFinite(video?.duration) ? video.duration : null,
    ...(sourcePost ? {sourcePost} : {})};
}

export async function resolvePageDownload(message, {getTab, getPageMedia}) {
  if (!isXPost(message.url)) return message.url;
  if (!Number.isInteger(message.tabId)) throw Error('请重新打开视频页面后再下载');
  const check = async () => {
    const tab = await getTab(message.tabId);
    if (!tab || tab.incognito || tab.url !== message.url) throw Error('页面已切换，请重新扫描视频后再下载');
  };
  await check();
  const info = await getPageMedia(message.tabId, message.url);
  // A direct-media URL must have been matched to this exact visible asset.
  const media = info?.url && matchingXMedia(info, [info]);
  const source = isXPost(info?.sourcePost) ? info.sourcePost : null;
  await check();
  // Preserve native extraction for ordinary posts before playback discovers media.
  // A master advertises all qualities plus audio. A captured MP4 may be only a
  // low quality, and generic yt-dlp extraction has no height for numeric caps.
  return (media?.type === 'hls' ? media.url : null) || source || message.url;
}
