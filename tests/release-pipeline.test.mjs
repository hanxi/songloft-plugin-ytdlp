import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { releasePending, verifyAndBuild } from '../scripts/release-plugin.mjs';

const repository = 'example/ytdlp';
const zipName = 'ytdlp.jsplugin.zip';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ytdlp-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  const sender = join(dir, 'sender');
  const worker = join(dir, 'worker');
  const contextFile = join(dir, 'release-context.json');

  const execute = (program, args, cwd) => execFileSync(program, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const git = (...args) => execute('git', args, sender).trim();
  const inspect = (...args) => execute('git', args, worker).trim();

  execute('git', ['init', '--bare', remote], dir);
  execute('git', ['init', '-b', 'main', sender], dir);
  git('config', 'user.name', 'developer');
  git('config', 'user.email', 'dev@example.test');
  git('remote', 'add', 'origin', remote);
  writeFileSync(join(sender, 'package.json'), JSON.stringify({ version: '2026.10.28' }));
  writeFileSync(join(sender, 'plugin.json'), JSON.stringify({ version: '2026.10.28', entryPath: 'ytdlp' }));
  const commit = (file, contents) => {
    const path = join(sender, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
    git('add', '.');
    git('commit', '-m', contents);
    return git('rev-parse', 'HEAD');
  };

  commit('src/code.txt', 'old release');
  git('tag', 'v2026.10.28');
  const baseline = commit('src/code.txt', 'unreleased before activation');
  git('push', 'origin', 'main', '--tags');
  execute('git', ['clone', '--branch', 'main', remote, worker], dir);

  const builds = [];
  const releases = [];
  const flags = { failBuild: false, failPublish: false, failMainPush: false, invalidManifest: false };
  let afterBuild;
  function run(command, args, cwd) {
    if (command === 'gh') {
      if (args[0] === 'api') return JSON.stringify([releases]);
      assert.deepEqual(args.slice(0, 2), ['release', 'create']);
      if (flags.failPublish) throw new Error('release create failed');
      const tag = args[2];
      assert.ok(args.includes('--verify-tag'));
      const [zip, manifest, sums] = args.slice(3, 6);
      assert.equal(execute('unzip', ['-p', zip, 'plugin.json'], cwd), readFileSync(manifest, 'utf8'));
      assert.equal(
        readFileSync(sums, 'utf8'),
        [zip, manifest].map(file =>
          `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file.split('/').at(-1)}\n`
        ).join(''),
      );
      releases.push({
        tag_name: tag,
        draft: false,
        prerelease: args.includes('--prerelease'),
        body: readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'),
      });
      return '';
    }
    if (flags.failMainPush && command === 'git' && args.join(' ') === 'push origin HEAD:main') {
      throw new Error('push rejected');
    }
    return execute(command, args, cwd);
  }

  function build(snapshot) {
    const manifest = JSON.parse(readFileSync(join(snapshot, 'plugin.json'), 'utf8'));
    if (flags.failBuild === manifest.releaseSource) throw new Error('build failed');
    builds.push(manifest.releaseSource);
    const dist = join(snapshot, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'plugin.json'), JSON.stringify({
      ...manifest,
      releaseSource: flags.invalidManifest ? 'main' : manifest.releaseSource,
      entryHash: 'a'.repeat(64),
      zipHash: 'b'.repeat(64),
    }, null, 2) + '\n');
    execute('zip', ['-q', zipName, 'plugin.json'], dist);
    afterBuild?.();
  }

  return {
    baseline, builds, releases, flags, commit, git, inspect,
    appendDuringBuild: (fn) => { afterBuild = () => { afterBuild = undefined; fn(); }; },
    publish: (options = {}) => releasePending({
      root: worker, baseline, repository, contextFile, run, build,
      now: () => new Date('2026-10-28T03:00:00Z'),
      ...options,
    }),
    main: () => JSON.parse(inspect('show', 'origin/main:plugin.json')),
    contexts: () => JSON.parse(readFileSync(contextFile, 'utf8')),
  };
}

test('every pending code commit publishes in order from the activation boundary', (t) => {
  const f = fixture(t);
  const first = f.commit('src/code.txt', 'first package');
  f.commit('docs/icon.svg', 'doc asset');
  f.commit('README.md', 'doc only');
  const second = f.commit('src/code.txt', 'second package');
  f.git('push', 'origin', 'main');

  let third;
  f.appendDuringBuild(() => {
    third = f.commit('src/code.txt', 'arrived during build');
    f.git('push', 'origin', 'main');
  });

  const published = f.publish();
  assert.deepEqual(published, [
    { source: first, version: '2026.10.28.1' },
    { source: second, version: '2026.10.28.2' },
    { source: third, version: '2026.10.28.3' },
  ]);
  assert.deepEqual(f.contexts(), published.map(
    ({ source, version }) => ({ tag: `v${version}`, pluginCommit: source }),
  ));
  for (const { source, version } of published) {
    assert.equal(f.inspect('rev-parse', `v${version}^`), source);
    const manifest = JSON.parse(f.inspect('show', `v${version}:plugin.json`));
    assert.equal(manifest.releaseSource, source);
    assert.equal(manifest.download_url, `https://github.com/${repository}/releases/download/v${version}/${zipName}`);
  }
  assert.equal(f.main().releaseSource, third);
  assert.equal(f.main().version, '2026.10.28.3');
  assert.deepEqual(f.publish(), []);
  assert.deepEqual(f.contexts(), []);
  assert.equal(f.releases.length, 3);
});

test('the ARM handoff includes completed publishes even when a later source fails', (t) => {
  const f = fixture(t);
  const first = f.commit('src/code.txt', 'first');
  const second = f.commit('src/code.txt', 'second');
  f.git('push', 'origin', 'main');
  f.flags.failBuild = second;
  assert.throws(() => f.publish(), /build failed/);
  assert.deepEqual(f.contexts(), [{ tag: 'v2026.10.28.1', pluginCommit: first }]);
  assert.equal(f.main().releaseSource, first);

  f.flags.failBuild = false;
  assert.deepEqual(f.publish(), [{ source: second, version: '2026.10.28.2' }]);
  assert.deepEqual(f.contexts(), [{ tag: 'v2026.10.28.2', pluginCommit: second }]);
});

test('rerun recovers a published release after a failed metadata push', (t) => {
  const f = fixture(t);
  const source = f.commit('src/code.txt', 'feature');
  f.git('push', 'origin', 'main');
  f.flags.failMainPush = true;
  assert.throws(() => f.publish(), /push rejected/);
  assert.equal(f.releases.length, 1);
  f.inspect('fetch', 'origin', '--tags');
  assert.equal(f.inspect('rev-parse', 'v2026.10.28.1^'), source);
  assert.deepEqual(f.contexts(), [{ tag: 'v2026.10.28.1', pluginCommit: source }]);

  f.flags.failMainPush = false;
  assert.deepEqual(f.publish(), []);
  assert.equal(f.main().releaseSource, source);
  assert.deepEqual(f.builds, [source]);
  assert.deepEqual(f.contexts(), [{ tag: 'v2026.10.28.1', pluginCommit: source }]);
});

test('a manual prerelease reserves a version without advancing the stable queue', (t) => {
  const f = fixture(t);
  const source = f.commit('src/code.txt', 'feature');
  f.git('push', 'origin', 'main');
  assert.deepEqual(f.publish({ prerelease: true, inputVersion: '2026.10.28.4' }), [
    { source, version: '2026.10.28.4' },
  ]);
  assert.equal(f.main().releaseSource, undefined);
  assert.equal(f.main().version, '2026.10.28');
  assert.equal(f.releases[0].prerelease, true);
  assert.deepEqual(f.publish(), [{ source, version: '2026.10.28.5' }]);
  assert.equal(f.main().releaseSource, source);
  assert.equal(f.releases[1].prerelease, false);
});

test('failed publication leaves the allocated tag reserved', (t) => {
  const f = fixture(t);
  const source = f.commit('src/code.txt', 'feature');
  f.git('push', 'origin', 'main');
  f.flags.failPublish = true;
  assert.throws(() => f.publish(), /release create failed/);
  assert.deepEqual(f.contexts(), []);
  f.inspect('fetch', 'origin', '--tags');
  assert.equal(f.inspect('rev-parse', 'v2026.10.28.1^'), source);
  f.flags.failPublish = false;
  assert.deepEqual(f.publish(), [{ source, version: '2026.10.28.2' }]);
});

test('a mismatched package manifest cannot allocate a tag or publish', (t) => {
  const f = fixture(t);
  f.commit('src/code.txt', 'feature');
  f.git('push', 'origin', 'main');
  f.flags.invalidManifest = true;
  assert.throws(() => f.publish(), /Invalid built manifest field: releaseSource/);
  assert.equal(f.inspect('tag', '--list'), 'v2026.10.28');
  assert.deepEqual(f.contexts(), []);
  assert.equal(f.releases.length, 0);
});

test('an explicit stable version must increase the store version', (t) => {
  const f = fixture(t);
  f.commit('src/code.txt', 'feature');
  f.git('push', 'origin', 'main');
  assert.throws(() => f.publish({ inputVersion: '2026.10.28.0' }), /version must increase/);
  assert.deepEqual(f.builds, []);
});

test('the release build uses frozen dependencies and validates the package', () => {
  const commands = [];
  verifyAndBuild('/snapshot', (...args) => commands.push(args));
  assert.deepEqual(commands, [
    ['pnpm', ['install', '--frozen-lockfile'], '/snapshot', false],
    ['pnpm', ['run', 'typecheck'], '/snapshot', false],
    ['pnpm', ['test'], '/snapshot', false],
    ['pnpm', ['run', 'build'], '/snapshot', false],
    ['pnpm', ['run', 'validate'], '/snapshot', false],
  ]);
});
