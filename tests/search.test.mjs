import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('@songloft/plugin-builder'))('esbuild');
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'neutral',
  format: 'iife',
}).outputFiles[0].text;

const first = { id: 'one', title: '单车合唱版', ie_key: 'Youtube', url: 'https://video.test/one' };
const best = { id: 'two', title: '单车', channel: '陈奕迅', duration: 216, ie_key: 'Youtube', url: 'https://video.test/two' };
const output = (...items) => ({ exitCode: 0, stdout: items.map(item => JSON.stringify(item)).join('\n'), stderr: '' });
const failure = stderr => ({ exitCode: 1, stdout: '', stderr });

function fixture(respond) {
  const calls = [];
  let now = 1000;
  const context = createContext({
    Date: { now: () => now },
    songloft: {
      storage: { get: async () => ({ proxy: 'http://proxy.test' }) },
      fs: { exists: async () => false },
      plugin: { getHostUrl: async () => '' },
      log: { info() {}, warn() {}, error() {} },
      command: {
        async exec(_program, args, { timeout }) {
          calls.push({ args, timeout });
          return respond(calls.at(-1), calls.length, ms => { now += ms; });
        },
      },
    },
  });
  runInContext(code, context);
  return {
    calls,
    async search(headers = {}, body = { keyword: '单车' }) {
      const response = await context.onHTTPRequest({
        method: 'POST', path: '/api/search/topone', headers, body: JSON.stringify(body),
      });
      return JSON.parse(response.body);
    },
  };
}

test('metadata request returns the best candidate with playback source data after one command', async () => {
  const h = fixture((_call, index) => index === 1 ? output(first, best) : failure('unexpected resolution'));
  const result = await h.search({ 'X-Songloft-Resolve-Url': 'false' }, { keyword: '单车', hint: { title: '单车', artist: '陈奕迅' } });
  assert.equal(result.code, 0);
  assert.equal(result.data.title, '单车');
  assert.equal(result.data.artist, '陈奕迅');
  assert.equal(result.data.duration, 216);
  assert.equal(result.data.plugin_entry_path, 'ytdlp');
  assert.equal(result.data.url ?? '', '');
  assert.deepEqual(result.data.source_data, { platform: 'youtube', id: 'two', url: best.url });
  assert.equal(h.calls.length, 1);
});

test('metadata mode falls back to resolving entries without usable flat metadata', async () => {
  const flat = { id: 'one', ie_key: 'BiliBili', url: first.url };
  const h = fixture((_call, index) => index === 1 ? output(flat) : output({ ...flat, title: '单车', url: 'https://audio.test/one' }));
  const result = await h.search({ 'x-songloft-resolve-url': 'false' });
  assert.equal(result.data.title, '单车');
  assert.equal(result.data.url, 'https://audio.test/one');
  assert.equal(h.calls.length, 2);
});

test('direct URL is still returned by default and a failed candidate can fall back', async () => {
  const h = fixture((_call, index) => {
    if (index === 1) return output(first, best);
    if (index === 2) return failure('Video unavailable');
    return output({ ...best, url: 'https://audio.test/two' });
  });
  const result = await h.search();
  assert.equal(result.code, 0);
  assert.equal(result.data.url, 'https://audio.test/two');
  assert.equal(h.calls.length, 3);
});

test('direct search shares one budget and stops before launching another candidate', async () => {
  const h = fixture(({ timeout }, index, advance) => {
    if (index === 1) {
      advance(7000);
      return output(first, best);
    }
    advance(timeout);
    return { exitCode: -1, stdout: '', stderr: '' };
  });
  const result = await h.search();
  assert.equal(result.code, 504);
  assert.deepEqual(h.calls.map(call => call.timeout), [28000, 21000]);
});

test('direct search reports upstream authentication failures with the existing settings guidance', async () => {
  const h = fixture((_call, index) => index === 1 ? output(first, best) : failure('ERROR: Sign in to confirm you’re not a bot.'));
  const result = await h.search({ 'X-Plugin-Timeout-Ms': '60000' });
  assert.equal(result.code, 502);
  assert.match(result.msg, /Cookies/);
  assert.equal(h.calls[0].timeout, 58000);
  assert.equal(h.calls.length, 2);
});

test('an invalid host timeout header keeps the plugin within the default budget', async () => {
  const h = fixture(() => output());
  const result = await h.search({ 'X-Plugin-Timeout-Ms': '6e4' });
  assert.equal(result.code, 404);
  assert.equal(h.calls[0].timeout, 28000);
});
