/// <reference types="@songloft/plugin-sdk" />

import { callHostAPI } from './utils/http';
import { getSettings } from './settings';

interface PlatformAsset {
  file: string;
  url: string;
}

const PLATFORM_ASSETS: Record<string, PlatformAsset> = {
  'linux-amd64': { file: 'yt-dlp', url: 'yt-dlp_linux' },
  'linux-arm64': { file: 'yt-dlp', url: 'yt-dlp_linux_aarch64' },
  'darwin-amd64': { file: 'yt-dlp', url: 'yt-dlp_macos_legacy' },
  'darwin-arm64': { file: 'yt-dlp', url: 'yt-dlp_macos' },
  'windows-amd64': { file: 'yt-dlp.exe', url: 'yt-dlp.exe' },
  'windows-arm64': { file: 'yt-dlp.exe', url: 'yt-dlp.exe' },
};

let detectedPlatform = '';

export function getBinName(): string {
  const asset = PLATFORM_ASSETS[detectedPlatform];
  return asset?.file || 'yt-dlp';
}

export async function detectPlatform(): Promise<string> {
  if (detectedPlatform) return detectedPlatform;
  try {
    const resp = await callHostAPI<{ value: string }>('GET', '/api/v1/configs/server_platform');
    detectedPlatform = resp?.value || 'linux-amd64';
  } catch {
    detectedPlatform = 'linux-amd64';
  }
  return detectedPlatform;
}

export async function isInstalled(): Promise<boolean> {
  const binName = getBinName();
  return await songloft.command.exists(binName);
}

export async function getVersion(): Promise<string> {
  const binName = getBinName();
  try {
    const result = await songloft.command.exec(binName, ['--version'], { timeout: 5000 });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

export async function getStatus(): Promise<{ installed: boolean; version: string; platform: string }> {
  const platform = await detectPlatform();
  const installed = await isInstalled();
  const version = installed ? await getVersion() : '';
  return { installed, version, platform };
}

interface ReleaseInfo {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

export async function getLatestRelease(): Promise<{ version: string; downloadUrl: string } | null> {
  const platform = await detectPlatform();
  const asset = PLATFORM_ASSETS[platform];
  if (!asset) return null;

  try {
    const resp = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return null;

    const release = JSON.parse(await resp.text()) as ReleaseInfo;
    const found = release.assets.find(a => a.name === asset.url);
    if (!found) return null;

    return { version: release.tag_name, downloadUrl: found.browser_download_url };
  } catch {
    return null;
  }
}

function applyGithubProxy(url: string, proxy: string): string {
  if (!proxy) return url;
  const p = proxy.endsWith('/') ? proxy : proxy + '/';
  return p + url;
}

export async function downloadBinary(): Promise<{ success: boolean; version?: string; error?: string }> {
  const platform = await detectPlatform();
  const asset = PLATFORM_ASSETS[platform];
  if (!asset) {
    return { success: false, error: `Unsupported platform: ${platform}` };
  }

  const release = await getLatestRelease();
  if (!release) {
    return { success: false, error: 'Failed to fetch latest release info' };
  }

  const settings = await getSettings();
  const downloadUrl = applyGithubProxy(release.downloadUrl, settings.github_proxy);

  try {
    await songloft.command.download(downloadUrl, asset.file);

    if (!platform.startsWith('windows')) {
      await songloft.command.exec('chmod', ['+x', `bin/${asset.file}`], { timeout: 5000 });
    }

    const version = await getVersion();
    return { success: true, version };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
