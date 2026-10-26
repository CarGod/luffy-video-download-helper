import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { patchFFmpegWorker } from '../scripts/ffmpeg-worker-patch.mjs';

test('HLS resource lifecycle, unbounded media, and save recovery', { timeout: 10000 }, async () => {
const source = fs.readFileSync(new URL('../src/offscreen.js', import.meta.url), 'utf8');
const worker = patchFFmpegWorker(fs.readFileSync(new URL('../node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js', import.meta.url), 'utf8'));
const application = source.slice(source.indexOf('const queue='), source.indexOf('chrome.runtime.onMessage.addListener'));
const MiB = 1024 * 1024;
class VirtualBytes {
  constructor(length) { this.length = this.byteLength = length; this.writes = []; }
  set(chunk, offset) { assert.ok(offset + chunk.length <= this.length); this.writes.push([offset, chunk.length]); }
}
let checks = 0;
function setup({ virtual = false, execResult = 0 } = {}) {
  const events = [], updates = [], fixtures = [], engines = [];
  const env = { events, updates, fixtures, engines, onSave: async () => true, onPatch: async () => 'saving' };
  const context = vm.createContext({
    AbortController, DOMException, TypeError, Error, Map, Number, Math, JSON, Date,
    Uint8Array: virtual ? VirtualBytes : Uint8Array,
    TextEncoder, TextDecoder, setTimeout, clearTimeout,
    setInterval: (callback) => { env.heartbeat = callback; return 1; }, clearInterval: () => {},
    httpURL: (url) => url, filename: (title) => `${title}.mp4`,
    chrome: { runtime: {
      getURL: (url) => url,
      sendMessage: async (m) => {
        if (m.type === 'patch') { updates.push({ id: m.id, ...m.patch }); return { ok: true, value: await env.onPatch(m) }; }
        if (m.type === 'headerRule') return { ok: true, value: null };
        if (m.type === 'saveBlob') {
          events.push({ type: 'save', id: m.id });
          return { ok: true, value: await env.onSave(m) };
        }
        throw new Error(`unexpected rpc ${m.type}`);
      }
    } },
    URL: {
      createObjectURL: () => { events.push({ type: 'createURL' }); return `blob:test/${events.length}`; },
      revokeObjectURL: (url) => events.push({ type: 'revokeURL', url })
    },
    Blob: class {
      constructor(parts) {
        assert.equal(engines.at(-1).terminated, true, 'worker must be terminated before output Blob allocation');
        events.push({ type: 'blob', bytes: parts.reduce((sum, p) => sum + p.byteLength, 0) });
      }
    },
    FFmpeg: class {
      constructor() { this.terminated = false; this.files = new Map(); engines.push(this); events.push({ type: 'engine' }); }
      async load() {} on() {}
      async writeFile(name, bytes) { this.files.set(name, bytes.length); }
      async exec() { events.push({ type: 'merge' }); return execResult; }
      async readFile() { events.push({ type: 'read' }); return new Uint8Array(128); }
      terminate() { this.terminated = true; this.files.clear(); events.push({ type: 'terminate' }); }
    },
    fetch: async (url, options) => {
      assert.ok(fixtures.length, `unexpected fetch ${url}`);
      const f = fixtures.shift();
      if (f.error) throw f.error;
      let i = 0;
      return { ok: true, status: f.range ? 206 : 200, url,
        headers: { get: (key) => ({ 'content-length': f.length ?? null, 'content-range': f.range ?? null })[key] ?? null },
        body: { getReader: () => ({
          async read() { return i < f.chunks.length ? { value: f.chunks[i++], done: false } : { done: true }; },
          async cancel() { events.push({ type: 'cancelReader' }); },
          releaseLock() { events.push({ type: 'releaseReader' }); }
        }) }
      };
    }
  });
  vm.runInContext(`${application}\nglobalThis.api={request,run,pump,handle,release,queue,blobs,saves,get active(){return active}};`, context);
  env.api = context.api;
  env.media = (jobId) => {
    context.playlist = async () => ({ kind: 'media', targetDuration: 2, segments: [{ url: `https://test/${jobId}.ts`, duration: 2 }] });
    context.selectVariant = () => null;
    fixtures.push({ chunks: [new Uint8Array([1, 2, 3])] });
    return { job: { id: jobId, title: jobId }, source: { url: 'https://test/index.m3u8' } };
  };
  return env;
}
const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Chunk reuse preserves a subarray's byteOffset/length and avoids a new buffer.
const single = setup();
const backing = new Uint8Array([9, 1, 2, 3, 9]);
const view = backing.subarray(1, 4);
single.fixtures.push({ length: '3', chunks: [view] });
const one = await single.api.request('https://test/one', {}, signal());
assert.notEqual(one.bytes, view); assert.equal(one.bytes.buffer.byteLength, 3); assert.deepEqual([...one.bytes], [1, 2, 3]); checks++;
const whole = setup(), contiguous = new Uint8Array([1, 2, 3]); whole.fixtures.push({ chunks: [contiguous] });
assert.equal((await whole.api.request('https://test/whole', {}, signal())).bytes, contiguous); checks++;

const multi = setup();
multi.fixtures.push({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])] });
assert.deepEqual([...((await multi.api.request('https://test/multi', {}, signal())).bytes)], [1, 2, 3, 4]); checks++;

// Preserve unbounded >256 MiB media response behavior without huge allocation.
for (const declared of [true, false]) {
  const env = setup({ virtual: true });
  env.fixtures.push({ ...(declared ? { length: String(320 * MiB) } : {}), chunks: Array.from({ length: 5 }, () => ({ length: 64 * MiB, byteLength: 64 * MiB })) });
  const result = await env.api.request('https://test/large', {}, signal());
  assert.equal(result.bytes.length, 320 * MiB); assert.equal(result.bytes.writes.length, 5); checks++;
}

// Bounded metadata responses, byte ranges and cancellation stay effective.
for (const limit of [16, 4 * MiB]) {
  for (const declared of [true, false]) {
    const env = setup({ virtual: true });
    env.fixtures.push({ ...(declared ? { length: String(limit + 1) } : {}), chunks: [{ length: limit + 1, byteLength: limit + 1 }] });
    await assert.rejects(env.api.request('https://test/metadata', {}, signal(), { limit }), /服务器响应超过资源允许大小/); checks++;
  }
}
const range = setup(); range.fixtures.push({ length: '3', range: 'bytes 8-10/12', chunks: [new Uint8Array([5, 6, 7])] });
assert.deepEqual([...((await range.api.request('https://test/range', {}, signal(), { range: { offset: 8, length: 3 } })).bytes)], [5, 6, 7]); checks++;
const cancel = setup(), controller = new AbortController(); controller.abort();
await assert.rejects(cancel.api.request('https://test/cancel', {}, controller.signal), { name: 'AbortError' }); checks++;

// Saving result holds the queue, but not the worker/MEMFS. Release wakes it.
const sequential = setup();
sequential.api.queue.push(sequential.media('first'), sequential.media('second'));
const pumping = sequential.api.pump(); await tick();
assert.equal(sequential.events.filter((e) => e.type === 'save').length, 1);
assert.equal(sequential.engines.length, 1);
assert.equal(sequential.engines[0].terminated, true);
assert.equal(sequential.api.active.ffmpeg, null);
assert.equal(sequential.api.blobs.size, 1); assert.equal(sequential.api.saves.size, 1);
sequential.api.release('first'); await tick();
assert.equal(sequential.events.filter((e) => e.type === 'save').length, 2);
assert.equal(sequential.api.blobs.size, 1);
sequential.api.release('second'); await pumping;
assert.equal(sequential.api.saves.size, 0); assert.equal(sequential.api.active, null); checks++;

// Fast completion can release while saveBlob RPC has not returned yet.
const fast = setup(); fast.onSave = async ({ id }) => { fast.api.release(id); return true; };
await fast.api.run(fast.media('fast'));
assert.equal(fast.api.saves.size, 0); assert.equal(fast.api.blobs.size, 0); checks++;

// Rejection, thrown save RPC, and cancelling while saving all wake the waiter.
for (const mode of ['reject', 'throw', 'cancel']) {
  const env = setup();
  if (mode === 'reject') env.onSave = async () => false;
  if (mode === 'throw') env.onSave = async () => { throw new Error('save failed'); };
  const running = env.api.run(env.media(mode)); await tick();
  if (mode === 'cancel') await env.api.handle({ type: 'cancel', id: mode });
  await running; env.api.release(mode);
  assert.equal(env.api.saves.size, 0); assert.equal(env.api.blobs.size, 0); assert.equal(env.api.active, null);
  assert.ok(env.engines.every((e) => e.terminated)); checks++;
}
const failed = setup({ execResult: 1 }); await failed.api.run(failed.media('failed'));
assert.equal(failed.updates.at(-1).status, 'error');
assert.equal(failed.engines[0].terminated, true); assert.equal(failed.api.blobs.size, 0); checks++;


// Exercise the real background heartbeat/reconcile branches. Recreate this
// context from persisted terminal state to model a service-worker restart.
const background = fs.readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
const reconcileCode = background.slice(background.indexOf('async function reconcile('), background.indexOf('chrome.downloads.onChanged.addListener'));
const patchCode = background.slice(background.indexOf("    case 'patch':{"), background.indexOf("    case 'headerRule':"));
const persistCode = background.slice(background.indexOf('const persistPatch ='), background.indexOf('async function badge('));
assert.ok(reconcileCode.includes('async function reconcile('));
assert.ok(patchCode.includes("case 'patch':"));
assert.ok(persistCode.includes('const persistPatch ='));
function setupBackground(jobs, browserState = 'complete') {
  const state = { jobs: structuredClone(jobs) };
  const result = { state, browserState, releases: 0 };
  const ctx = vm.createContext({
    state,
    terminal: (status) => ['complete', 'error', 'cancelled'].includes(status),
    mutate: async (fn) => fn(),
    chrome: { downloads: { search: async () => [{ state: result.browserState, bytesReceived: 128 }] } },
    removeRule: async () => {},
    engine: async () => { result.releases++; throw new Error('release message lost'); }
  });
  vm.runInContext(`${persistCode}\n${reconcileCode}\nglobalThis.patch=async(m)=>{switch(m.type){${patchCode}}};`, ctx);
  result.patch = ctx.patch;
  return result;
}
for (const mode of ['worker-restart', 'missed-onChanged', 'cleared-history', 'rpc-error']) {
  const env = setup();
  const jobs = mode === 'cleared-history' ? [] : [{ id: mode, status: mode === 'worker-restart' ? 'complete' : 'saving', downloadId: 7, blob: true }];
  const bg = setupBackground(jobs);
  env.onPatch = async (m) => m.patch.heartbeat ? bg.patch(m) : 'saving';
  const running = env.api.run(env.media(mode)); await tick();
  assert.equal(env.api.saves.size, 1);
  if (mode === 'rpc-error') {
    env.onPatch = async () => { throw new Error('background unavailable'); };
    await env.heartbeat(); assert.equal(env.api.saves.size, 1);
    env.onPatch = async (m) => bg.patch(m);
  }
  await env.heartbeat(); await running;
  assert.equal(env.api.blobs.size, 0); assert.equal(env.api.saves.size, 0);
  if (mode !== 'cleared-history') assert.equal(bg.state.jobs[0].status, 'complete');
  checks++;
}
// Chrome in_progress takes precedence over stale local terminal status.
const stale = setup();
const staleBackground = setupBackground([{ id: 'stale', status: 'complete', downloadId: 9, blob: true }], 'in_progress');
stale.onPatch = async (m) => m.patch.heartbeat ? staleBackground.patch(m) : 'saving';
const staleRunning = stale.api.run(stale.media('stale')); await tick();
await stale.heartbeat(); assert.equal(stale.api.blobs.size, 1); assert.equal(stale.api.saves.size, 1);
staleBackground.browserState = 'complete'; await stale.heartbeat(); await staleRunning;
assert.equal(stale.api.blobs.size, 0); checks++;

// Exercise the actual wrapper's writeFile, asserting MEMFS takes ownership.
const writeSource = worker.slice(worker.indexOf('const writeFile ='), worker.indexOf('const readFile ='));
let owned;
const writeContext = vm.createContext({ ffmpeg: { FS: { writeFile: (path, data, options) => { assert.equal(options.canOwn, true); owned = data; } } } });
vm.runInContext(`${writeSource}\nglobalThis.write=writeFile;`, writeContext);
const input = new Uint8Array([1, 2, 3]);
assert.equal(writeContext.write({ path: 'segment.ts', data: input }), true); assert.equal(owned, input); checks++;

assert.ok(!source.includes('INPUT_LIMIT')); assert.ok(!source.includes('256 MB'));
assert.equal(checks, 23);
assert.throws(() => patchFFmpegWorker('changed upstream implementation'), /Unexpected FFmpeg/);

});
