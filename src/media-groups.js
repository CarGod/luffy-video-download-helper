// Only use a provider's asset ID, never a page title, thumbnail or duration.
function twitterAsset(media) {
  try {
    const url = new URL(media.url);
    if (url.hostname !== 'video.twimg.com') return null;
    const match = url.pathname.match(/^\/(ext_tw_video|amplify_video|tweet_video)\/(\d+)\/(.+)$/);
    if (!match) return null;
    const path = match[3];
    const master = media.type === 'hls' && /^(?:pu\/)?pl\/[^/]+\.m3u8$/.test(path);
    return {key: `${match[1]}:${match[2]}`, master};
  } catch { return null; }
}

export function groupedMedia(media) {
  const masters = new Map();
  for (const item of media) {
    const asset = twitterAsset(item);
    // Prefer the most recently discovered complete URL (including its token).
    if (asset?.master) masters.set(asset.key, item);
  }
  const emitted = new Set();
  const result = [];
  for (const item of media) {
    const asset = twitterAsset(item);
    const representative = asset && masters.get(asset.key);
    // Without a master, keep variants accessible rather than lose a quality option.
    if (!representative) { result.push(item); continue; }
    if (emitted.has(asset.key)) continue;
    emitted.add(asset.key);
    result.push(representative);
  }
  return result;
}
