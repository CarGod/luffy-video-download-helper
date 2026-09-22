import test from 'node:test';
import assert from 'node:assert/strict';
import {createMcpHandler} from '../src/mcp.js';
function fixture(videos=[{id:'one',type:'file',url:'https://example.com/v.mp4'}]) {
 const tab={id:7,url:'https://example.com/watch',title:'Test'}; const calls=[];
 const chrome={tabs:{get:async()=>tab,query:async()=>[tab]}};
 const rpc=async m=>{calls.push(m);if(m.type==='state')return {media:videos,jobs:[{id:'job',status:'complete',headers:{secret:'secret'},path:'/tmp/a.mp4'}]};return 'job';};
 return {handler:createMcpHandler({chrome,rpc}),tab,calls};
}
test('lists active page and routes selected direct download',async()=>{
 const {handler,calls}=fixture();const page=await handler({action:'list'});
 assert.equal(page.tabId,7);assert.equal(calls[0].type,'scan');
 assert.equal((await handler({action:'download',tabId:7,pageUrl:page.page_url})).jobId,'job');
 assert.equal(calls.at(-1).type,'start');
});
test('rejects stale page, ambiguity, foreign IDs and private pages without download',async()=>{
 const {handler,tab,calls}=fixture([{id:'a'},{id:'b'}]);
 for(const data of [{pageUrl:'https://wrong'},{pageUrl:tab.url},{pageUrl:tab.url,mediaId:'foreign'}])
  await assert.rejects(handler({action:'download',tabId:7,...data}));
 tab.incognito=true;await assert.rejects(handler({action:'list'}));
 assert.equal(calls.some(m=>['start','nativeStart'].includes(m.type)),false);
});
test('native page uses no cookies by default and jobs omit internal fields',async()=>{
 const {handler,tab,calls}=fixture([]);tab.url='https://www.youtube.com/watch?v=abc';
 await handler({action:'download',tabId:7,pageUrl:tab.url});
 assert.equal(calls.at(-1).type,'nativeStart');assert.equal(calls.at(-1).cookies,'none');
 const {jobs}=await handler({action:'jobs'});assert.equal(jobs[0].headers,undefined);
 await assert.rejects(handler({action:'cancel',jobId:'absent'}));
 await assert.rejects(handler({action:'headerRule'}));
});
