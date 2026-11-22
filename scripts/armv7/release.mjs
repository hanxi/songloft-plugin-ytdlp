import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion } from '../release-version.mjs';
import { releaseSource } from '../release-plugin.mjs';

export function updateStatus(body, message) {
  const section = `<!-- armv7-status:start -->\n${message}\n<!-- armv7-status:end -->`;
  const pattern =
    /<!-- armv7-status:start -->[\s\S]*?<!-- armv7-status:end -->/;
  return pattern.test(body)
    ? body.replace(pattern, () => section)
    : `${body}\n\n${section}\n`;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}
function gh(...args) {
  return run('gh', args);
}
function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

export function resolveRelease(repository, tag, expectedSource, request = gh) {
  if (!tag?.startsWith('v') || !isReleaseVersion(tag.slice(1))) {
    throw new Error('Invalid release tag');
  }
  const release = JSON.parse(
    request('release', 'view', tag, '--json', 'isDraft,body,assets'),
  );
  if (release.isDraft) throw new Error('Cannot attach to a draft');

  const commit = JSON.parse(request('api', `repos/${repository}/commits/${tag}`));
  const source = releaseSource(release.body) || commit.sha;
  if (
    !/^[a-f0-9]{40}$/.test(commit.sha) ||
    (source !== commit.sha && commit.parents?.[0]?.sha !== source) ||
    (expectedSource && source !== expectedSource)
  ) {
    throw new Error('Release tag does not match source');
  }
  const attached = new Set(release.assets.filter((asset) => asset.size > 0).map((asset) => asset.name));
  const skip = Boolean(expectedSource && [
    'yt-dlp_musllinux_armv7l',
    'yt-dlp-LICENSE',
    'yt-dlp-THIRD_PARTY_LICENSES.txt',
    'yt-dlp-python-requirements.txt',
    'yt-dlp-build.json',
    'yt-dlp-SHA256SUMS',
  ].every((file) => attached.has(file)));
  return { tag, source, skip };
}

function main(mode) {
  const {
    GITHUB_REPOSITORY,
    GITHUB_OUTPUT,
    RELEASE_SOURCE,
    INPUT_TAG,
    YTDLP_VERSION,
    PLUGIN_COMMIT,
    TAG,
    BUILD_STATUS,
    GITHUB_RUN_ID,
  } = process.env;
  if (mode === 'resolve') {
    const context = resolveRelease(GITHUB_REPOSITORY, INPUT_TAG, RELEASE_SOURCE);
    if (context.skip) {
      appendFileSync(GITHUB_OUTPUT, 'skip=true\n');
      return;
    }
    const version = gh(
      'api',
      'repos/yt-dlp/yt-dlp/releases/latest',
      '--jq',
      '.tag_name',
    );
    if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version))
      throw new Error('Invalid upstream version');
    appendFileSync(
      GITHUB_OUTPUT,
      `tag=${context.tag}\nplugin_commit=${context.source}\nytdlp_version=${version}\n`,
    );
  } else if (mode === 'info') {
    const sourceCommit = run('git', [
      '-C',
      'upstream-yt-dlp',
      'rev-parse',
      'HEAD',
    ]);
    writeFileSync(
      'armv7-assets/yt-dlp-build.json',
      json({
        version: YTDLP_VERSION,
        source: `https://github.com/yt-dlp/yt-dlp/tree/${sourceCommit}`,
        sourceCommit,
        pluginCommit: PLUGIN_COMMIT,
        workflowCommit: run('git', ['rev-parse', 'HEAD']),
        platform: 'linux/arm/v7',
        libc: 'musl',
        pythonImage:
          'python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322',
        smoke:
          'Alpine 3.24, QEMU ARMv7, no system Python, non-root, version/extractors/HTTP download/HTTPS metadata',
      }),
    );
  } else if (mode === 'status') {
    const body =
      JSON.parse(gh('release', 'view', TAG, '--json', 'body')).body || '';
    const url = `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
    const message =
      BUILD_STATUS === 'success'
        ? `ARMv7 二进制：yt-dlp ${YTDLP_VERSION} 已就绪，附件为 \`yt-dlp_musllinux_armv7l\`，校验和见 \`yt-dlp-SHA256SUMS\`。\n\nQEMU ARMv7 / 干净 Alpine 3.24 / uid=1000 验证版本、提取器、HTTP 下载与 HTTPS 解析通过。未做玩客云真机验收。\n\n[构建与验证记录](${url})。`
        : `ARMv7 二进制构建状态：${BUILD_STATUS}，不影响插件 Release。[查看日志并重跑独立构建](${url})。`;
    writeFileSync('armv7-release-notes.md', updateStatus(body, message));
    gh('release', 'edit', TAG, '--notes-file', 'armv7-release-notes.md');
  } else throw new Error('Expected resolve, info, or status');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv[2]);
