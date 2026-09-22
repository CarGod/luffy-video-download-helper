import test from 'node:test';
import assert from 'node:assert/strict';
import {retryConnection} from '../src/loading.js';
test('retries a receiver starting up and returns its result',async()=>{let calls=0;assert.equal(await retryConnection(()=>{if(++calls<3)throw Error('Could not establish connection. Receiving end does not exist.');return 'ready';},{wait:async()=>{}}),'ready');assert.equal(calls,3);});
test('persistent connection failure stops; content errors are not retried',async()=>{for(const [message,count] of [['Receiving end does not exist',3],['403 Forbidden',1]]){let calls=0;await assert.rejects(retryConnection(()=>{calls++;throw Error(message);},{wait:async()=>{}}));assert.equal(calls,count);}});
