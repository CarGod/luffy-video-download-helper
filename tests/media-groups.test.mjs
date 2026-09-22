import test from 'node:test';
import assert from 'node:assert/strict';
import { groupedMedia } from '../src/media-groups.js';

const media = (id, path, type = 'hls') => ({id, type, url: `https://video.twimg.com/${path}`, title: '主页 / X', duration: 52});
const master = media('master', 'ext_tw_video/123/pu/pl/master.m3u8?tag=12');
const low = media('low', 'ext_tw_video/123/pu/pl/480x600/low.m3u8');
const high = media('high', 'ext_tw_video/123/pu/pl/720x900/high.m3u8');
const audio = media('audio', 'ext_tw_video/123/pu/pl/mp4a/128000/audio.m3u8');
const mp4 = media('mp4', 'ext_tw_video/123/pu/vid/720x900/video.mp4', 'file');

test('X master, quality variants, audio and MP4 appear as one playable master', () => {
  for (const input of [[master, low, high, audio, mp4], [low, mp4, audio, high, master]]) {
    assert.deepEqual(groupedMedia(input), [master]);
    assert.equal(input.length, 5, 'raw download sources are retained');
    assert.equal(groupedMedia(input)[0].id, 'master', 'inspection/download resolves the original source');
  }
});
test('master token refresh keeps the complete latest URL', () => {
  const refreshed = {...master, id: 'new', url: master.url + '&token=new'};
  assert.deepEqual(groupedMedia([master, high, refreshed]), [refreshed]);
});
test('different asset IDs and namespaces remain separate even with identical metadata', () => {
  const other = media('other', 'ext_tw_video/456/pu/pl/master.m3u8');
  const amplify = media('amplify', 'amplify_video/123/pl/master.m3u8');
  const amplifyChild = media('amplify-low', 'amplify_video/123/pl/640x360/low.m3u8');
  assert.deepEqual(groupedMedia([master, low, other, amplify, amplifyChild]), [master, other, amplify]);
});
test('without a master every quality remains accessible, including when master arrives later', () => {
  assert.deepEqual(groupedMedia([low, high, audio, mp4]), [low, high, audio, mp4]);
  assert.deepEqual(groupedMedia([low, high, master]), [master]);
});
test('unrecognized hosts, paths and query-based media identities are never guessed', () => {
  const others = [
    {...master, id: 'other-host', url: master.url.replace('video.twimg.com', 'example.com')},
    {...master, id: 'spoof', url: master.url.replace('video.twimg.com', 'video.twimg.com.example.com')},
    {...master, id: 'unknown', url: 'https://video.twimg.com/unknown/master.m3u8'},
    {...master, id: 'a', url: 'https://example.com/play.m3u8?id=1'},
    {...master, id: 'b', url: 'https://example.com/play.m3u8?id=2'},
  ];
  assert.deepEqual(groupedMedia([master, ...others]), [master, ...others]);
});
