import { readFileSync, writeFileSync } from 'node:fs';
import { isReleaseVersion } from './release-version.mjs';

const {
  VERSION,
  TAG,
  GITHUB_REPOSITORY = 'hanxi/songloft-plugin-ytdlp',
} = process.env;
if (!isReleaseVersion(VERSION || '') || TAG !== `v${VERSION}`) {
  throw new Error('VERSION must be Y.M.D.N and TAG must match vVERSION');
}
for (const file of ['package.json', 'plugin.json']) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.version = VERSION;
  if (file === 'plugin.json') {
    manifest.download_url = `https://github.com/${GITHUB_REPOSITORY}/releases/download/${TAG}/ytdlp.jsplugin.zip`;
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
