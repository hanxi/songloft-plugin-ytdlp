import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(
  require.resolve('@songloft/plugin-builder'),
)('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url)),
);
const code = buildSync({
  entryPoints: [root + 'src/binary.ts'],
  bundle: true,
  write: false,
  platform: 'neutral',
  format: 'iife',
  globalName: 'binary',
}).outputFiles[0].text;
const customBase = `https://github.com/hanxi/songloft-plugin-ytdlp/releases/download/v${version}`;

function harness({
  platform = 'linux-arm',
  releaseOK = true,
  missingAsset = false,
  proxy = '',
  runnable = true,
  executionError = false,
} = {}) {
  const fetches = [],
    downloads = [],
    executions = [];
  const context = createContext({
    console: { log() {} },
    fetch: async (url) => {
      fetches.push(url);
      if (url.endsWith('/configs/server_platform')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ value: platform }),
        };
      }
      const custom = url.includes('/hanxi/songloft-plugin-ytdlp/');
      return {
        ok: releaseOK,
        text: async () =>
          JSON.stringify({
            tag_name: custom ? `v${version}` : '2026.10.26',
            assets: missingAsset
              ? []
              : [
                  {
                    name: custom
                      ? 'yt-dlp_musllinux_armv7l'
                      : {
                          'linux-amd64': 'yt-dlp_musllinux',
                          'linux-arm64': 'yt-dlp_musllinux_aarch64',
                          'darwin-arm64': 'yt-dlp_macos',
                          'windows-arm64': 'yt-dlp_arm64.exe',
                        }[platform],
                    label: custom ? 'yt-dlp 2026.10.26' : null,
                    browser_download_url: custom
                      ? `${customBase}/yt-dlp_musllinux_armv7l`
                      : 'https://github.com/yt-dlp/yt-dlp/upstream-binary',
                  },
                ],
          }),
      };
    },
    songloft: {
      plugin: {
        getHostUrl: async () => 'http://host',
        getToken: async () => 'test-token',
      },
      storage: { get: async () => ({ github_proxy: proxy }) },
      command: {
        exists: async () => true,
        download: async (...args) => downloads.push(args),
        exec: async (...args) => {
          executions.push(args);
          if (args[0] === 'chmod')
            return { exitCode: 0, stdout: '', stderr: '' };
          if (executionError) throw new Error('no such file or directory');
          return {
            exitCode: runnable ? 0 : 1,
            stdout: runnable ? '2026.10.26\n' : '',
            stderr: '',
          };
        },
      },
      fs: { writeFile: async () => {}, appendFile: async () => {} },
      log: { info() {}, error() {} },
    },
  });
  runInContext(code, context);
  return { api: context.binary, fetches, downloads, executions };
}

test('Go linux-arm uses the matching plugin release even when it is a prerelease', async () => {
  const { api, fetches, downloads, executions } = harness();
  const result = await api.downloadBinary();
  assert.equal(result.success, true);
  assert.equal(result.version, '2026.10.26');
  assert(
    fetches.includes(
      `https://api.github.com/repos/hanxi/songloft-plugin-ytdlp/releases/tags/v${version}`,
    ),
  );
  assert(!fetches.some((url) => url.endsWith('/releases/latest')));
  assert.equal(downloads[0][0], `${customBase}/yt-dlp_musllinux_armv7l`);
  assert.equal(downloads[0][1], 'yt-dlp');
  assert.equal(
    JSON.stringify(executions[0].slice(0, 2)),
    JSON.stringify(['chmod', ['+x', 'bin/yt-dlp']]),
  );
});

test('manual download fallback and GitHub proxy keep the same custom release', async () => {
  const { api } = harness({ releaseOK: false, proxy: 'https://proxy.example' });
  const info = await api.getBinaryInfo();
  assert.equal(
    info.downloadUrl,
    `https://proxy.example/${customBase}/yt-dlp_musllinux_armv7l`,
  );
  assert.equal(info.binName, 'yt-dlp');
});

test('automatic custom download applies GitHub proxy', async () => {
  const { api, downloads } = harness({ proxy: 'https://proxy.example/' });
  assert.equal((await api.downloadBinary()).success, true);
  assert.equal(
    downloads[0][0],
    `https://proxy.example/${customBase}/yt-dlp_musllinux_armv7l`,
  );
});

for (const platform of [
  'linux-amd64',
  'linux-arm64',
  'darwin-arm64',
  'windows-arm64',
]) {
  test(`${platform} continues to use upstream latest`, async () => {
    const { api, fetches } = harness({ platform });
    const release = await api.getLatestRelease();
    assert.equal(release.version, '2026.10.26');
    assert(
      fetches.includes(
        'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
      ),
    );
  });
}

test('a missing ARM asset fails before any download', async () => {
  const { api, downloads } = harness({ missingAsset: true });
  const result = await api.downloadBinary();
  assert.equal(result.success, false);
  assert.match(result.error, /尚未就绪/);
  assert.equal(downloads.length, 0);
});

for (const options of [{ runnable: false }, { executionError: true }]) {
  test(`non-runnable binary is rejected for download and upload: ${JSON.stringify(options)}`, async () => {
    const { api } = harness(options);
    assert.equal((await api.downloadBinary()).success, false);
    await api.startUpload(1);
    await api.appendUploadChunk('AA==');
    assert.equal((await api.finalizeUpload()).success, false);
  });
}
