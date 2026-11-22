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
  libc = '',
  exists = true,
  runnable = true,
  executionError = false,
  platformFailures = 0,
  releaseSize = 40_524_824,
  receivedSize = releaseSize,
  downloadError = '',
} = {}) {
  const fetches = [],
    downloads = [],
    executions = [],
    renames = [];
  const files = new Map(exists ? [[`bin/${platform.startsWith('windows') ? 'yt-dlp.exe' : 'yt-dlp'}`, 100]] : []);
  const context = createContext({
    console: { log() {} },
    fetch: async (url) => {
      fetches.push(url);
      if (url.endsWith('/configs/server_platform')) {
        if (platformFailures > 0) {
          platformFailures--;
          throw new Error('host not ready');
        }
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
              : custom
                ? [{
                    name: 'yt-dlp_musllinux_armv7l',
                    label: 'yt-dlp 2026.10.26',
                    size: releaseSize,
                    browser_download_url: `${customBase}/yt-dlp_musllinux_armv7l`,
                  }]
                : [
                    'yt-dlp_musllinux', 'yt-dlp_linux',
                    'yt-dlp_musllinux_aarch64', 'yt-dlp_linux_aarch64',
                    'yt-dlp_macos', 'yt-dlp_arm64.exe',
                  ].map((name) => ({
                    name,
                    size: releaseSize,
                    browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/${name}`,
                  })),
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
        exists: async (name) => files.has(`bin/${name}`),
        download: async (url, name) => {
          downloads.push([url, name]);
          files.set(`bin/${name}`, receivedSize);
          if (downloadError) throw new Error(downloadError);
        },
        deleteBin: async (name) => { files.delete(`bin/${name}`); },
        exec: async (...args) => {
          executions.push(args);
          if (args[0] === 'chmod')
            return { exitCode: 0, stdout: '', stderr: '' };
          if (args[0] === 'getconf') {
            if (!libc) throw new Error('program "getconf" not found in plugin bin/ or system PATH');
            return { exitCode: 0, stdout: libc, stderr: '' };
          }
          if (executionError) throw new Error(executionError);
          return {
            exitCode: runnable ? 0 : 1,
            stdout: runnable ? '2026.10.26\n' : '',
            stderr: '',
          };
        },
      },
      fs: {
        writeFile: async () => {},
        appendFile: async () => {},
        stat: async (path) => ({ size: files.get(path) }),
        rename: async (from, to) => {
          renames.push([from, to]);
          files.set(to, files.get(from));
          files.delete(from);
        },
      },
      log: { info() {}, error() {} },
    },
  });
  runInContext(code, context);
  return { api: context.binary, fetches, downloads, executions, renames, files };
}

test('Go linux-arm uses the matching plugin release even when it is a prerelease', async () => {
  const { api, fetches, downloads, executions, renames } = harness();
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
  const staged = downloads[0][1];
  assert.notEqual(staged, 'yt-dlp');
  assert.equal(
    JSON.stringify(executions[0].slice(0, 2)),
    JSON.stringify(['chmod', ['+x', `bin/${staged}`]]),
  );
  assert.deepEqual(renames, [[`bin/${staged}`, 'bin/yt-dlp']]);
});

test('a failed platform lookup is retried and the ARM64 installer uses the ARM64 asset', async () => {
  const { api, fetches, downloads } = harness({ platform: 'linux-arm64', platformFailures: 1 });
  await api.detectPlatform();
  assert.equal((await api.downloadBinary()).success, true);
  assert.match(downloads[0][0], /\/yt-dlp_musllinux_aarch64$/);
  assert.equal(fetches.filter((url) => url.endsWith('/configs/server_platform')).length, 2);
});

test('an unavailable server platform cannot fall back to an x86-64 download', async () => {
  const { api, downloads } = harness({ platform: 'linux-arm64', platformFailures: 1 });
  const result = await api.downloadBinary();
  assert.equal(result.success, false);
  assert.match(result.error, /服务器平台/);
  assert.equal(downloads.length, 0);
});

test('an HTTP 200 partial binary is rejected without executing it or replacing the installed file', async () => {
  const { api, files, renames, executions } = harness({ receivedSize: 10_000_000 });
  const result = await api.downloadBinary();
  assert.equal(result.success, false);
  assert.match(result.error, /文件大小不符.*10000000.*40524824/);
  assert.deepEqual(executions, []);
  assert.deepEqual(renames, []);
  assert.deepEqual([...files], [['bin/yt-dlp', 100]]);
});

test('an interrupted update cleans up its candidate and preserves the installed file', async () => {
  const { api, files } = harness({ downloadError: 'connection closed' });
  const result = await api.downloadBinary();
  assert.equal(result.success, false);
  assert.match(result.error, /connection closed/);
  assert.deepEqual([...files], [['bin/yt-dlp', 100]]);
});

test('a binary that cannot run does not replace the installed file', async () => {
  const { api, files, downloads, executions, renames } = harness({ runnable: false });
  const result = await api.downloadBinary();
  assert.equal(result.success, false);
  assert.equal(executions[1][0], downloads[0][1]);
  assert.deepEqual(renames, []);
  assert.deepEqual([...files], [['bin/yt-dlp', 100]]);
});

test('a Windows update executes the candidate with its .exe extension before replacement', async () => {
  const { api, files, downloads, executions, renames } = harness({ platform: 'windows-arm64' });
  assert.equal((await api.downloadBinary()).success, true);
  const staged = downloads[0][1];
  assert.match(staged, /\.exe$/);
  assert.notEqual(staged, 'yt-dlp.exe');
  assert.deepEqual(executions.map((args) => args[0]), [staged]);
  assert.deepEqual(renames, [[`bin/${staged}`, 'bin/yt-dlp.exe']]);
  assert.deepEqual([...files], [['bin/yt-dlp.exe', 40_524_824]]);
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

for (const [platform, suffix] of [['linux-amd64', ''], ['linux-arm64', '_aarch64']]) {
  for (const [libc, asset] of [['glibc 2.36\n', 'yt-dlp_linux'], ['', 'yt-dlp_musllinux']]) {
    test(`${platform} selects a compatible release asset (${asset})`, async () => {
      const { api, downloads } = harness({ platform, libc });
      const expectedAsset = asset + suffix;
      assert.match((await api.getLatestRelease()).downloadUrl, new RegExp(`/${expectedAsset}$`));
      assert.match((await api.getBinaryInfo()).downloadUrl, new RegExp(`/${expectedAsset}$`));
      assert.equal((await api.downloadBinary()).success, true);
      assert.match(downloads[0][0], new RegExp(`/${expectedAsset}$`));
    });
  }
}

test('the glibc manual download link stays compatible when release metadata is unavailable', async () => {
  const { api } = harness({ platform: 'linux-amd64', libc: 'glibc 2.36', releaseOK: false });
  assert.equal(
    (await api.getBinaryInfo()).downloadUrl,
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
  );
});

const launchError = 'commandExec: run: fork/exec /app/data/jsplugins_data/ytdlp/bin/yt-dlp: no such file or directory';

test('an existing binary whose loader cannot be started is reported as unusable', async () => {
  const { api, executions } = harness({ executionError: launchError });
  const status = await api.getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.version, '');
  assert.match(status.error, /运行库/);
  assert.ok(status.error.includes(launchError));
  assert.equal(executions.length, 1);
});

test('status distinguishes a missing file from a usable installation', async () => {
  const missing = harness({ exists: false });
  const missingStatus = await missing.api.getStatus();
  assert.equal(missingStatus.installed, false);
  assert.equal(missingStatus.error, undefined);
  assert.equal(missing.executions.length, 0);

  const { api } = harness();
  const readyStatus = await api.getStatus();
  assert.equal(readyStatus.installed, true);
  assert.equal(readyStatus.version, '2026.10.26');
  assert.equal(readyStatus.error, undefined);
});

test('the reported ELF loader path is shown when the host provides it', async () => {
  const loader = 'ELF interpreter "/lib/ld-musl-x86_64.so.1" not found';
  const { api } = harness({
    executionError: `${launchError} (${loader} — the binary may require glibc but this system uses musl)`,
  });
  const status = await api.getStatus();
  assert.ok(status.error.endsWith(loader));
});

test('an import launch failure points to reinstalling yt-dlp in plugin settings', async () => {
  const { api } = harness({ executionError: launchError });
  await assert.rejects(
    () => api.execYtdlp(['--dump-json', 'bilisearch5:单车'], 300000),
    (error) => /插件设置.*重新安装/.test(error.message) && error.message.includes(launchError),
  );
});

test('a missing ARM asset fails before any download', async () => {
  const { api, downloads } = harness({ missingAsset: true });
  const result = await api.downloadBinary();
  assert.equal(result.success, false);
  assert.match(result.error, /尚未就绪/);
  assert.equal(downloads.length, 0);
});

for (const options of [{ runnable: false }, { executionError: launchError }]) {
  test(`non-runnable binary is rejected for download and upload: ${JSON.stringify(options)}`, async () => {
    const { api } = harness(options);
    const download = await api.downloadBinary();
    assert.equal(download.success, false);
    assert.match(download.error, /运行库/);
    await api.startUpload(1);
    await api.appendUploadChunk('AA==');
    const upload = await api.finalizeUpload();
    assert.equal(upload.success, false);
    assert.match(upload.error, /运行库/);
    if (options.executionError) {
      assert.ok(download.error.includes(launchError));
      assert.ok(upload.error.includes(launchError));
    }
  });
}
