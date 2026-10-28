import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { TAG, YTDLP_VERSION, GITHUB_SHA } = process.env;
const sourceCommit = execFileSync(
  'git',
  ['-C', 'upstream-yt-dlp', 'rev-parse', 'HEAD'],
  { encoding: 'utf8' },
).trim();
const manifest = JSON.parse(readFileSync('release-assets/plugin.json', 'utf8'));
if (
  TAG !== `v${manifest.version}` ||
  !/^[a-f0-9]{64}$/.test(manifest.entryHash) ||
  !/^[a-f0-9]{64}$/.test(manifest.zipHash)
) {
  throw new Error('Invalid built plugin manifest');
}
writeFileSync(
  'release-assets/yt-dlp-build.json',
  JSON.stringify(
    {
      version: YTDLP_VERSION,
      source: `https://github.com/yt-dlp/yt-dlp/tree/${sourceCommit}`,
      sourceCommit,
      pluginCommit: GITHUB_SHA,
      platform: 'linux/arm/v7',
      libc: 'musl',
      pythonImage:
        'python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322',
      smoke:
        'Alpine 3.24, QEMU ARMv7, no system Python, non-root, version/extractors/HTTP download/HTTPS metadata',
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  'release-assets/release-notes.md',
  `Songloft yt-dlp 插件 ${TAG}，附带 ARMv7 / musl 单文件 yt-dlp ${YTDLP_VERSION}。\n\n` +
    `- ARMv7 Alpine 自动从本 Release 下载 \`yt-dlp_musllinux_armv7l\`，无需安装 Python。\n` +
    `- 上游源码：[yt-dlp ${YTDLP_VERSION}](https://github.com/yt-dlp/yt-dlp/tree/${sourceCommit})。\n` +
    `- 已在 QEMU ARMv7 / 干净 Alpine 3.24 / 非 root 环境验证版本、提取器、HTTP 下载及 HTTPS 元数据解析。\n` +
    `- 尚未在玩客云真机验证；YouTube 可能需要另行安装 JS 运行时，未内置 Deno 或浏览器模拟依赖。\n` +
    `- 安装本页 \`ytdlp.jsplugin.zip\` 后，在插件设置中点击安装 yt-dlp。\n` +
    `- 校验和、依赖清单和构建信息随附；请通过插件安装器更新二进制。\n\n` +
    `Ref: songloft-org/songloft#544\n`,
);
