import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion } from '../release-version.mjs';

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
    const context = INPUT_TAG
      ? { tag: INPUT_TAG }
      : JSON.parse(
          readFileSync('release-context/release-context.json', 'utf8'),
        );
    if (
      !isReleaseVersion(context.tag?.slice(1) || '') ||
      !context.tag.startsWith('v')
    )
      throw new Error('Invalid release tag');
    if (RELEASE_SOURCE && context.pluginCommit !== RELEASE_SOURCE)
      throw new Error('Release source mismatch');
    const release = JSON.parse(
      gh('release', 'view', context.tag, '--json', 'isDraft,targetCommitish'),
    );
    if (release.isDraft) throw new Error('Cannot attach to a draft');
    const commit = gh(
      'api',
      `repos/${GITHUB_REPOSITORY}/commits/${context.tag}`,
      '--jq',
      '.sha',
    );
    if (
      !/^[a-f0-9]{40}$/.test(commit) ||
      (context.pluginCommit && context.pluginCommit !== commit)
    )
      throw new Error('Release tag does not match source');
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
      `tag=${context.tag}\nplugin_commit=${commit}\nytdlp_version=${version}\n`,
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
