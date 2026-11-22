import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion, nextVersion } from './release-version.mjs';

const execute = (command, args, cwd, capture = true) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  }) ?? '';

const shaPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export function releaseSource(body = '') {
  return /^Source commit: ([a-f0-9]{40})$/m.exec(body)?.[1];
}

function isVersionCommit(author, subject) {
  return author === 'github-actions[bot]' &&
    /^chore\(release\): (?:bump to|更新至) v/.test(subject);
}

function hasPackageChanges(paths) {
  return paths.some((path) => path && !path.startsWith('docs/') && !/\.mdx?$/i.test(path));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJSON(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function versionCommit(source, tag) {
  return `chore(release): bump to ${tag}\n\nSource commit: ${source}`;
}

function releaseNotes(tag, source, prerelease) {
  const installation = prerelease
    ? '请从本页安装 `ytdlp.jsplugin.zip`。预发布不会更新普通插件源。'
    : '可从普通插件源更新，也可从本页安装 `ytdlp.jsplugin.zip`。';
  return `Songloft yt-dlp 插件 ${tag}。\n\n${installation}\n\n` +
    '- 插件包校验和见 `SHA256SUMS`。\n' +
    '- ARMv7 Alpine 使用本 Release 的 `yt-dlp_musllinux_armv7l`，附件由独立工作流构建。\n' +
    '- YouTube 可能需要另行安装 JS 运行时。\n\n' +
    '<!-- armv7-status:start -->\nARMv7 二进制：等待异步构建。附件就绪后再到插件设置中安装 yt-dlp。\n<!-- armv7-status:end -->\n\n' +
    `Source commit: ${source}\n`;
}

export function verifyAndBuild(snapshot, run = execute) {
  for (const args of [
    ['install', '--frozen-lockfile'],
    ['run', 'typecheck'],
    ['test'],
    ['run', 'build'],
    ['run', 'validate'],
  ]) {
    run('pnpm', args, snapshot, false);
  }
}

function verifyManifest(manifest, expected) {
  for (const key of ['entryPath', 'version', 'releaseSource', 'download_url']) {
    if (manifest[key] !== expected[key]) {
      throw new Error(`Invalid built manifest field: ${key}`);
    }
  }
  if (!hashPattern.test(manifest.entryHash) || !hashPattern.test(manifest.zipHash)) {
    throw new Error('Invalid built manifest hashes');
  }
}

export function releasePending({
  root,
  repository,
  baseline,
  contextFile,
  artifactDir,
  prerelease = false,
  inputVersion = '',
  now = () => new Date(),
  run = execute,
  build = verifyAndBuild,
} = {}) {
  if (inputVersion && !isReleaseVersion(inputVersion)) {
    throw new Error('Version must be a valid Y.M.D.N date and sequence');
  }

  const git = (...args) => run('git', args, root).trim();
  const gh = (...args) => run('gh', args, root).trim();
  const staging = mkdtempSync(join(tmpdir(), 'ytdlp-release-'));
  const published = [];
  const contexts = [];
  let requestedVersion = inputVersion;

  const fetchMain = () => git('fetch', 'origin', 'main', '--tags');
  const mainManifest = () => JSON.parse(git('show', 'origin/main:plugin.json'));

  function recordRelease(tag, source) {
    contexts.push({ tag, pluginCommit: source });
    if (contextFile) writeJSON(contextFile, contexts);
  }

  function syncMain(source, manifest) {
    // New pushes can arrive during the build. Apply only published metadata to the new tip.
    for (let attempt = 0; attempt < 3; attempt++) {
      git('fetch', 'origin', 'main');
      git('checkout', '--detach', 'origin/main');
      const current = readJSON(join(root, 'plugin.json'));
      if (current.releaseSource === source) return;
      for (const key of ['version', 'releaseSource', 'download_url', 'entryHash', 'zipHash']) {
        current[key] = manifest[key];
      }
      writeJSON(join(root, 'plugin.json'), current);
      const pkg = readJSON(join(root, 'package.json'));
      pkg.version = manifest.version;
      writeJSON(join(root, 'package.json'), pkg);
      git('add', 'plugin.json', 'package.json');
      git('commit', '-m', versionCommit(source, `v${manifest.version}`));
      try {
        git('push', 'origin', 'HEAD:main');
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }

  function publish(source, version, preview) {
    const tag = `v${version}`;
    if (git('tag', '--list', tag)) throw new Error(`Tag ${tag} already exists`);
    const snapshot = join(staging, source);
    git('worktree', 'add', '--detach', snapshot, source);
    try {
      const zipName = 'ytdlp.jsplugin.zip';
      const manifestPath = join(snapshot, 'plugin.json');
      const manifest = readJSON(manifestPath);
      Object.assign(manifest, {
        version,
        releaseSource: source,
        download_url: `https://github.com/${repository}/releases/download/${tag}/${zipName}`,
      });
      writeJSON(manifestPath, manifest);
      const packagePath = join(snapshot, 'package.json');
      const pkg = readJSON(packagePath);
      pkg.version = version;
      writeJSON(packagePath, pkg);
      build(snapshot, run);

      const zip = join(snapshot, 'dist', zipName);
      const inside = run('unzip', ['-p', zip, 'plugin.json'], snapshot);
      const built = JSON.parse(inside);
      verifyManifest(built, { ...manifest, entryPath: 'ytdlp' });
      writeJSON(manifestPath, built);
      run('git', ['add', 'plugin.json', 'package.json'], snapshot);
      run('git', ['commit', '-m', versionCommit(source, tag)], snapshot);

      const dir = join(artifactDir || join(staging, 'assets'), tag);
      mkdirSync(dir, { recursive: true });
      copyFileSync(zip, join(dir, zipName));
      writeFileSync(join(dir, 'plugin.json'), inside);
      const sums = [zipName, 'plugin.json'].map((file) => {
        const digest = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
        return `${digest}  ${file}`;
      });
      writeFileSync(join(dir, 'SHA256SUMS'), sums.join('\n') + '\n');
      writeFileSync(join(dir, 'release-notes.md'), releaseNotes(tag, source, preview));

      // Push a tag at the exact build snapshot. An allocated tag remains reserved if publishing fails.
      run('git', ['push', 'origin', `HEAD:refs/tags/${tag}`], snapshot);
      gh(
        'release', 'create', tag,
        ...[zipName, 'plugin.json', 'SHA256SUMS'].map((file) => join(dir, file)),
        '--repo', repository, '--verify-tag', '--title', tag,
        '--notes-file', join(dir, 'release-notes.md'),
        ...(preview ? ['--prerelease', '--latest=false'] : ['--latest']),
      );
      recordRelease(tag, source);
      published.push({ source, version });
      return built;
    } finally {
      git('worktree', 'remove', '--force', snapshot);
    }
  }

  function chooseVersion(current) {
    const version = requestedVersion ||
      nextVersion(git('tag', '--list').split('\n'), current.version, now());
    if (requestedVersion && !prerelease) {
      const previous = current.version.split('.').map(Number);
      const difference = version.split('.').map(
        (value, index) => Number(value) - (previous[index] ?? 0),
      ).find(Boolean);
      if (!(difference > 0)) throw new Error('Stable release version must increase');
    }
    requestedVersion = '';
    return version;
  }

  try {
    if (contextFile) writeJSON(contextFile, contexts);
    git('config', 'user.name', 'github-actions[bot]');
    git('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');

    if (prerelease) {
      fetchMain();
      publish(git('rev-parse', 'origin/main'), chooseVersion(mainManifest()), true);
      return published;
    }

    while (true) {
      fetchMain();
      const current = mainManifest();
      const base = current.releaseSource || baseline;
      if (!shaPattern.test(base)) throw new Error('Invalid release source or activation boundary');
      git('merge-base', '--is-ancestor', base, 'origin/main');
      const source = git(
        'log', '--first-parent', '--reverse', '--format=%H%x09%an%x09%s',
        `${base}..origin/main`,
      ).split('\n').filter(Boolean).map((line) => line.split('\t')).find(
        ([sha, author, subject]) => !isVersionCommit(author, subject) &&
          hasPackageChanges(git(
            'diff', '--name-only', '--no-renames', '-z', `${sha}^`, sha,
          ).split('\0')),
      )?.[0];
      if (!source) break;

      const releases = JSON.parse(gh(
        'api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`,
      )).flat();
      const existing = releases.find((item) =>
        !item.draft && !item.prerelease && releaseSource(item.body) === source);
      if (existing) {
        if (
          !existing.tag_name.startsWith('v') ||
          !isReleaseVersion(existing.tag_name.slice(1)) ||
          git('rev-parse', `${existing.tag_name}^`) !== source
        ) {
          throw new Error('Cannot resume from a mismatched release tag');
        }
        const manifest = JSON.parse(git('show', `${existing.tag_name}:plugin.json`));
        verifyManifest(manifest, {
          entryPath: 'ytdlp',
          version: existing.tag_name.slice(1),
          releaseSource: source,
          download_url: `https://github.com/${repository}/releases/download/${existing.tag_name}/ytdlp.jsplugin.zip`,
        });
        recordRelease(existing.tag_name, source);
        syncMain(source, manifest);
        continue;
      }
      syncMain(source, publish(source, chooseVersion(current), false));
    }
    return published;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Release requires main');
  console.log(releasePending({
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    repository: process.env.GITHUB_REPOSITORY,
    baseline: process.env.RELEASE_BASE_SHA,
    contextFile: process.env.RELEASE_CONTEXT_FILE,
    artifactDir: process.env.RELEASE_ARTIFACTS_DIR,
    prerelease: process.env.PRERELEASE === 'true',
    inputVersion: process.env.INPUT_VERSION,
  }));
}
