import { readFileSync, writeFileSync } from 'node:fs';

const { TAG, GITHUB_SHA } = process.env;
const manifest = JSON.parse(readFileSync('release-assets/plugin.json', 'utf8'));
if (
  TAG !== `v${manifest.version}` ||
  !/^[a-f0-9]{40}$/.test(GITHUB_SHA || '') ||
  !/^[a-f0-9]{64}$/.test(manifest.entryHash) ||
  !/^[a-f0-9]{64}$/.test(manifest.zipHash)
) {
  throw new Error('Invalid built plugin manifest or source SHA');
}
writeFileSync(
  'release-assets/release-context.json',
  JSON.stringify(
    {
      tag: TAG,
      pluginCommit: GITHUB_SHA,
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  'release-assets/release-notes.md',
  `Songloft yt-dlp 插件 ${TAG}。\n\n` +
    `- 安装本页的 \`ytdlp.jsplugin.zip\`；预发布不更新普通插件源。\n` +
    `- ARMv7 Alpine 会从本 Release 下载 \`yt-dlp_musllinux_armv7l\`，无需安装 Python。\n` +
    `- 插件包校验和见 \`SHA256SUMS\`。ARM 二进制由独立 workflow 异步构建并追加，不阻塞插件发布。\n` +
    `- 尚未在玩客云真机验证；YouTube 可能需要另行安装 JS 运行时，未内置 Deno 或浏览器模拟依赖。\n\n` +
    `<!-- armv7-status:start -->\nARMv7 二进制：等待异步构建。附件就绪后再到插件设置中安装 yt-dlp。\n<!-- armv7-status:end -->\n\n` +
    `Source commit: ${GITHUB_SHA}\n\nRef: songloft-org/songloft#544\n`,
);
