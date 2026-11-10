import test from 'node:test';
import assert from 'node:assert/strict';
import {isXPost, matchingXMedia, capturePageVideo, resolvePageDownload} from '../src/page-media.js';

const post='https://x.com/author/status/123';
const poster='https://pbs.twimg.com/amplify_video_thumb/456/img/cover.jpg';
const master={id:'master',type:'hls',url:'https://video.twimg.com/amplify_video/456/pl/master.m3u8?tag=1'};
const full={id:'file',type:'file',url:'https://video.twimg.com/amplify_video/456/vid/avc1/1280x720/full.mp4'};

test('recognizes only supported X post URLs',()=>{
  for(const url of [post,post+'/video/1','https://twitter.com/author/status/123']) assert.equal(isXPost(url),true);
  for(const url of ['https://x.com.evil.test/author/status/123','https://claude.ai/artifact/example','https://x.com/home',post+'/analytics']) assert.equal(isXPost(url),false);
});
test('selects exact visible asset master ahead of files and other posts',()=>{
  const other={...master,url:master.url.replace('/456/','/999/')};
  assert.equal(matchingXMedia({poster},[other,full,master]),master);
  assert.equal(matchingXMedia({poster},[full]),full);
});
test('keeps newest master URL and complete highest resolution file fallback',()=>{
  const newer={...master,url:master.url+'&new=1',foundAt:2};
  const low={...full,url:full.url.replace('1280x720','640x360')};
  assert.equal(matchingXMedia({poster},[master,newer]),newer);
  assert.equal(matchingXMedia({poster},[low,full]),full);
});
test('never mistakes audio, HLS renditions or initialization fragments for complete video',()=>{
  for(const item of [
    {...master,url:master.url.replace('/pl/master','/pl/mp4a/128000/audio')},
    {...master,url:master.url.replace('/pl/master','/pl/avc1/1280x720/video')},
    {...full,url:full.url.replace('/vid/avc1/1280x720/','/aud/mp4a/0/0/128000/')},
    {...full,url:full.url.replace('/vid/avc1/1280x720/','/vid/avc1/0/0/1280x720/')},
    {...master,url:master.url.replace('video.twimg.com','video.twimg.com.evil.test')},
  ]) assert.equal(matchingXMedia({poster},[item]),null);
  assert.equal(matchingXMedia({poster:poster.replace('pbs.twimg.com','evil.test')},[master]),null);
  assert.equal(matchingXMedia({},[master]),null);
});
test('supports older ext_tw_video master and full MP4 paths',()=>{
  const info={poster:'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/a.jpg'};
  for(const item of [
    {type:'hls',url:'https://video.twimg.com/ext_tw_video/456/pu/pl/master.m3u8'},
    {type:'file',url:'https://video.twimg.com/ext_tw_video/456/pu/vid/1280x720/full.mp4'},
  ]) assert.equal(matchingXMedia(info,[item]),item);
});

function fixture(info){
  const tab={id:7,url:post};let reads=0;
  const deps={getTab:async()=>{reads++;return tab;},getPageMedia:async()=>info};
  return {tab,deps,get reads(){return reads;}};
}
test('X current-video download uses captured asset instead of text external link',async()=>{
  const f=fixture({...master,poster,sourcePost:'https://claude.ai/artifact/example'});
  assert.equal(await resolvePageDownload({url:post,tabId:7},f.deps),master.url);
  assert.equal(f.reads,2);
});
test('falls back to the video attribution post, never an arbitrary external page',async()=>{
  const original='https://x.com/original/status/999/video/1';
  assert.equal(await resolvePageDownload({url:post,tabId:7},fixture({poster,sourcePost:original}).deps),original);
  assert.equal(await resolvePageDownload({url:post,tabId:7},fixture({poster,sourcePost:'https://claude.ai/artifact/example'}).deps),post);
});
test('unrelated captured media is ignored and undiscovered ordinary posts retain native fallback',async()=>{
  assert.equal(await resolvePageDownload({url:post,tabId:7},fixture({...master,poster:poster.replace('/456/','/999/')}).deps),post);
  assert.equal(await resolvePageDownload({url:post,tabId:7},fixture(null).deps),post);
});
test('YouTube and direct-media downloads stay unchanged',async()=>{
  for(const url of ['https://www.youtube.com/watch?v=abc',master.url,full.url])
    assert.equal(await resolvePageDownload({url},{}),url);
});
test('captured MP4 never replaces native extraction and loses numeric quality metadata',async()=>{
  for(const quality of ['best','720','1080']){
    assert.equal(await resolvePageDownload({url:post,tabId:7,quality},fixture({...full,poster}).deps),post);
    const sourcePost='https://x.com/original/status/999/video/1';
    assert.equal(await resolvePageDownload({url:post,tabId:7,quality},fixture({...full,poster,sourcePost}).deps),sourcePost);
  }
});
test('rejects missing tab, private tab and navigation before resolving media',async()=>{
  await assert.rejects(resolvePageDownload({url:post},fixture(null).deps),/重新打开/);
  for(const change of [{incognito:true},{url:'https://x.com/other/status/999'}]){
    const f=fixture({...master,poster});Object.assign(f.tab,change);
    await assert.rejects(resolvePageDownload({url:post,tabId:7},f.deps),/页面已切换/);
  }
});
test('rejects navigation during asynchronous page resolution',async()=>{
  const f=fixture(null);f.deps.getPageMedia=async()=>{f.tab.url='https://x.com/other/status/999';return {...master,poster};};
  await assert.rejects(resolvePageDownload({url:post,tabId:7},f.deps),/页面已切换/);
});

function article(id, videos=[], images=[]) {
  return {querySelectorAll:selector=>({
    'a[href]':[{href:`https://x.com/author/status/${id}`,querySelector:()=>({})}],
    video:videos,img:images,
  })[selector] || []};
}
function capture(url, articles, expected=url) {
  const oldDocument=globalThis.document,oldLocation=globalThis.location;
  globalThis.location={href:url};
  globalThis.document={querySelectorAll:()=>articles,querySelector:()=>null};
  try{return capturePageVideo(expected);}
  finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
}
const player=(image=poster)=>({poster:image,duration:72,closest:()=>null});
test('DOM capture binds only the requested article, not a reply or recommendation',()=>{
  const info=capture(post,[article('999',[player(poster.replace('/456/','/999/'))]),article('123',[player()])]);
  assert.equal(info.poster,poster);assert.equal(info.duration,72);
  assert.equal(capture(post,[article('999',[player()])]),null);
  assert.equal(capture(post,[],post+'/video/1'),null);
});
test('DOM capture does not guess explicit video 2 or ambiguous multi-video posts',()=>{
  assert.equal(capture(post+'/video/2',[article('123',[player()])]),null);
  assert.equal(capture(post,[article('123',[player(),player(poster.replace('/456/','/999/'))])]),null);
  assert.equal(capture(post,[article('123',[],[{src:poster},{src:poster.replace('/456/','/999/')}])]),null);
  assert.equal(capture(post+'/video/1',[article('123',[player()])]).poster,poster);
});
test('DOM capture only follows attribution inside the selected player',()=>{
  const sourcePost='https://x.com/original/status/999/video/1';
  const video={...player(),closest:()=>({querySelectorAll:()=>[
    {href:'https://claude.ai/artifact/example'},{href:sourcePost},
  ]})};
  assert.equal(capture(post,[article('123',[video])]).sourcePost,sourcePost);
});
