import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('@songloft/plugin-builder'))('esbuild');
function bundle(entry) { return buildSync({
  entryPoints: [fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url))],
  bundle: true,
  write: false,
  platform: 'neutral',
  format: 'iife',
  globalName: 'downloader',
}).outputFiles[0].text; }
const code = bundle('downloader');
const routes = bundle('main');

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(settings = {}, { entry = code, storageGet } = {}) {
  const calls = [], timers = new Map();
  let timerId = 0;
  const context = createContext({
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    songloft: {
      storage: { get: storageGet || (async () => ({ download_interval: 0, pause_on_error: false, ...settings })) },
      songs: { download(id, opts) { const pending = deferred(); calls.push({ id, opts, ...pending }); return pending.promise; } },
      fs: { appendFile: async () => {} },
      log: { info() {}, error() {} },
    },
  });
  runInContext(entry, context);
  async function request(path, body) {
    const response = await context.onHTTPRequest({ method: body === undefined ? 'GET' : 'POST', path, body: JSON.stringify(body) });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }
  return { api: context.downloader, calls, timers, request };
}

test('cancelling in flight keeps its real result and cancels the remaining queue', async () => {
  const { api, calls } = harness();
  await api.startBatchDownload([1, 2, 3]);
  api.cancelBatch();
  const task = api.getBatchTask();
  assert.equal(task.cancelled, true);
  assert.equal(task.done, false);
  assert.deepEqual(Array.from(task.songs, s => s.status), ['downloading', 'cancelled', 'cancelled']);
  calls[0].resolve({ status: 'ok', path: 'music/one.mp3' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(task.done, true);
  assert.equal(task.results[0].path, 'music/one.mp3');
  assert.equal(task.songs[0].status, 'ok');
});

test('cancelling a manually paused batch wakes it and allows clearing and a new batch', async () => {
  const { api, calls } = harness();
  await api.startBatchDownload([1, 2]);
  api.pauseBatch();
  calls[0].resolve({ status: 'ok' });
  await flush();
  assert.equal(calls.length, 1);
  api.cancelBatch();
  await flush();
  assert.equal(api.getBatchTask().done, true);
  assert.equal(api.getBatchTask().paused, false);
  api.resumeBatch();
  assert.equal(calls.length, 1);
  api.clearBatchTask();
  assert.equal(api.getBatchTask(), null);
  await api.startBatchDownload([3]);
  calls[1].resolve({ status: 'ok' });
  await flush();
  assert.equal(api.getBatchTask().total, 1);
  assert.equal(api.getBatchTask().songs[0].song_id, 3);
  assert.equal(api.getBatchTask().results.length, 1);
});

test('cancelling automatic error pause does not resume or download another song', async () => {
  const { api, calls } = harness({ pause_on_error: true });
  await api.startBatchDownload([1, 2]);
  calls[0].reject(new Error('unsupported URL'));
  await flush();
  assert.equal(api.getBatchTask().paused, true);
  api.cancelBatch();
  await flush();
  assert.equal(api.getBatchTask().done, true);
  assert.equal(api.getBatchTask().songs[0].status, 'failed');
  assert.equal(calls.length, 1);
});

for (const failure of [null, 'HTTP Error 429: too many requests', 'scheduler: call timeout']) {
  test(`cancellation wakes ${failure || 'download interval'} and removes its timer`, async () => {
    const { api, calls, timers } = harness({ download_interval: 300 });
    await api.startBatchDownload([1, 2]);
    if (failure) calls[0].reject(new Error(failure));
    else calls[0].resolve({ status: 'ok' });
    await flush();
    assert.equal(timers.size, 1);
    api.cancelBatch();
    await flush();
    assert.equal(timers.size, 0);
    assert.equal(api.getBatchTask().done, true);
    assert.equal(calls.length, 1);
    if (failure) assert.equal(api.getBatchTask().songs[0].status, 'cancelled');
  });
}

test('cancel during a failed host call skips retries and automatic pause', async () => {
  const { api, calls, timers } = harness({ pause_on_error: true });
  await api.startBatchDownload([1, 2]);
  api.cancelBatch();
  calls[0].reject(new Error('HTTP Error 429'));
  await flush();
  assert.equal(api.getBatchTask().done, true);
  assert.equal(api.getBatchTask().paused, false);
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 0);
});

test('active or cancelling batches cannot be overwritten or cleared', async () => {
  const { api, calls } = harness();
  await api.startBatchDownload([1, 2]);
  const original = api.getBatchTask();
  await assert.rejects(api.startBatchDownload([3]), /下载任务/);
  assert.throws(() => api.clearBatchTask(), /下载任务/);
  assert.equal(api.getBatchTask(), original);
  api.cancelBatch();
  await assert.rejects(api.startBatchDownload([4]), /下载任务/);
  calls[0].resolve({ status: 'ok' });
  await flush();
  assert.equal(original.done, true);
  assert.equal(calls.length, 1);
});

test('concurrent starts reserve the batch before asynchronous settings loading', async () => {
  const { api, calls } = harness();
  const first = api.startBatchDownload([1]);
  const second = api.startBatchDownload([2]);
  await first;
  await assert.rejects(second, /下载任务/);
  assert.equal(calls.length, 1);
  calls[0].resolve({ status: 'ok' });
  await flush();
});

test('normal retries still succeed and retain download options', async () => {
  const { api, calls, timers } = harness({ path_template: '{playlist}/{title}', transcode_format: 'mp3', transcode_bitrate: 192 });
  await api.startBatchDownload([1], { playlistName: 'My playlist' });
  calls[0].reject(new Error('call timeout'));
  await flush();
  const [id, timer] = timers.entries().next().value;
  timers.delete(id);
  timer.fn();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.path_template, 'My playlist/{title}');
  assert.equal(calls[1].opts.format, 'mp3');
  assert.equal(calls[1].opts.quality, '192');
  calls[1].resolve({ status: 'ok' });
  await flush();
  assert.equal(api.getBatchTask().done, true);
  assert.equal(api.getBatchTask().songs[0].status, 'ok');
});


test('cancel during initialization never starts a host download', async () => {
  const storage = deferred();
  const { api, calls } = harness({}, { storageGet: () => storage.promise });
  const start = api.startBatchDownload([1, 2]);
  api.cancelBatch();
  storage.resolve({});
  await start;
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(api.getBatchTask().done, true);
  assert.deepEqual(Array.from(api.getBatchTask().songs, s => s.status), ['cancelled', 'cancelled']);
});

test('settings failure releases the batch slot', async () => {
  let first = true;
  const { api, calls } = harness({}, { storageGet: async () => {
    if (first) { first = false; throw new Error('storage unavailable'); }
    return {};
  } });
  await assert.rejects(api.startBatchDownload([1]), /storage unavailable/);
  assert.equal(api.getBatchTask(), null);
  await api.startBatchDownload([2]);
  calls[0].resolve({ status: 'ok' });
  await flush();
  assert.equal(api.getBatchTask().done, true);
});

test('routes cancel idempotently, expose cancellation and guard active tasks with 409', async () => {
  const { request, calls } = harness({}, { entry: routes });
  const progress = () => request('/api/download-batch/progress');
  const post = (action, body = {}) => request('/api/download-batch/' + action, body);
  assert.equal((await post('cancel')).status, 200);
  assert.equal((await progress()).body.active, false);
  assert.equal((await request('/api/download-batch', { song_ids: [1, 2] })).status, 200);
  assert.equal((await post('clear')).status, 409);
  assert.equal((await request('/api/download-batch', { song_ids: [3] })).status, 409);
  // Busy import-download must return before creating any songs/playlists.
  assert.equal((await request('/api/import-download', { items: [{ id: 'new' }] })).status, 409);
  assert.equal((await post('cancel')).status, 200);
  assert.equal((await post('cancel')).status, 200);
  await post('resume');
  await post('pause');
  const cancelling = (await progress()).body;
  assert.equal(cancelling.cancelled, true);
  assert.equal(cancelling.done, false);
  assert.equal(cancelling.paused, false);
  assert.equal(cancelling.songs[1].status, 'cancelled');
  calls[0].resolve({ status: 'ok' });
  await flush();
  const finished = (await progress()).body;
  assert.equal(finished.done, true);
  assert.equal(finished.success, 1);
  assert.equal(finished.failed, 0);
  assert.equal(calls.length, 1);
  assert.equal((await post('clear')).status, 200);
  assert.equal((await progress()).body.active, false);
});
