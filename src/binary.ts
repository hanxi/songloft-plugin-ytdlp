/// <reference types="@songloft/plugin-sdk" />

import { callHostAPI } from './utils/http';
import { getSettings } from './settings';
import { logInfo, logError } from './logger';
import { version as pluginVersion } from '../package.json';

interface PlatformAsset {
  file: string;
  url: string;
  repository?: string;
  tag?: string;
}

const PLATFORM_ASSETS: Record<string, PlatformAsset> = {
  'linux-amd64': { file: 'yt-dlp', url: 'yt-dlp_musllinux' },
  'linux-arm64': { file: 'yt-dlp', url: 'yt-dlp_musllinux_aarch64' },
  // Go reports GOARCH=arm on armv7l. This single-file build includes Python.
  'linux-arm': {
    file: 'yt-dlp',
    url: 'yt-dlp_musllinux_armv7l',
    repository: 'hanxi/songloft-plugin-ytdlp',
    tag: `v${pluginVersion}`,
  },
  'darwin-amd64': { file: 'yt-dlp', url: 'yt-dlp_macos' },
  'darwin-arm64': { file: 'yt-dlp', url: 'yt-dlp_macos' },
  'windows-amd64': { file: 'yt-dlp.exe', url: 'yt-dlp.exe' },
  'windows-arm64': { file: 'yt-dlp.exe', url: 'yt-dlp_arm64.exe' },
};

let detectedPlatform = '';

export function getBinName(): string {
  const asset = PLATFORM_ASSETS[detectedPlatform];
  return asset?.file || 'yt-dlp';
}

export async function detectPlatform(): Promise<string> {
  if (detectedPlatform) return detectedPlatform;
  try {
    const resp = await callHostAPI<{ value: string }>(
      'GET',
      '/api/v1/configs/server_platform',
    );
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
    const result = await songloft.command.exec(binName, ['--version'], {
      timeout: 5000,
    });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

export async function getStatus(): Promise<{
  installed: boolean;
  version: string;
  platform: string;
}> {
  const platform = await detectPlatform();
  const installed = await isInstalled();
  const version = installed ? await getVersion() : '';
  return { installed, version, platform };
}

interface ReleaseInfo {
  tag_name: string;
  assets: {
    name: string;
    browser_download_url: string;
    label?: string | null;
  }[];
}

function releaseURL(asset: PlatformAsset, api: boolean): string {
  const repository = asset.repository || 'yt-dlp/yt-dlp';
  if (api) {
    const release = asset.tag ? `tags/${asset.tag}` : 'latest';
    return `https://api.github.com/repos/${repository}/releases/${release}`;
  }
  const release = asset.tag ? `download/${asset.tag}` : 'latest/download';
  return `https://github.com/${repository}/releases/${release}/${asset.url}`;
}

export async function getLatestRelease(): Promise<{
  version: string;
  downloadUrl: string;
} | null> {
  const platform = await detectPlatform();
  const asset = PLATFORM_ASSETS[platform];
  if (!asset) return null;

  try {
    const resp = await fetch(releaseURL(asset, true), {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return null;

    const release = JSON.parse(await resp.text()) as ReleaseInfo;
    const found = release.assets.find((a) => a.name === asset.url);
    if (!found) return null;

    console.log('Found release:', release.tag_name, found.browser_download_url);
    // Custom releases label the asset with the upstream yt-dlp version.
    const version =
      asset.repository && found.label?.startsWith('yt-dlp ')
        ? found.label.slice('yt-dlp '.length)
        : release.tag_name;
    return { version, downloadUrl: found.browser_download_url };
  } catch {
    return null;
  }
}

function applyGithubProxy(url: string, proxy: string): string {
  if (!proxy) return url;
  const p = proxy.endsWith('/') ? proxy : proxy + '/';
  return p + url;
}

// 安装任务状态：后端 ExecuteJS 有 30s wall-clock 上限，而 yt-dlp 二进制
// 几十 MB，慢网络下下载会超时。这里把安装做成 fire-and-forget 任务，
// HTTP 端点立即返回，前端通过 /api/install/status 轮询进度。
export interface InstallTask {
  status: 'idle' | 'running' | 'done' | 'error';
  version?: string;
  error?: string;
  startedAt?: number;
}

let installTask: InstallTask = { status: 'idle' };

export function getInstallTask(): InstallTask {
  return installTask;
}

export function startInstall(): InstallTask {
  if (installTask.status === 'running') {
    return installTask;
  }
  installTask = { status: 'running', startedAt: Date.now() };
  // fire-and-forget：不 await，让 onHTTPRequest 立即返回，
  // 避免 ExecuteJS 30s wall-clock 触发 504。
  // 注意：ExecuteJS 返回后游离 Promise 仍会继续推进（QuickJS 的 host
  // Promise 由宿主 goroutine 完成后回填，下一次 ExecuteJS 进入事件循环
  // 时会被 pump）。
  downloadBinary()
    .then((r) => {
      installTask = r.success
        ? {
            status: 'done',
            version: r.version,
            startedAt: installTask.startedAt,
          }
        : { status: 'error', error: r.error, startedAt: installTask.startedAt };
    })
    .catch((e: any) => {
      installTask = {
        status: 'error',
        error: e?.message || String(e),
        startedAt: installTask.startedAt,
      };
    });
  return installTask;
}

export async function getBinaryInfo(): Promise<{
  platform: string;
  binName: string;
  downloadUrl: string;
  version: string;
}> {
  const platform = await detectPlatform();
  const asset = PLATFORM_ASSETS[platform];
  if (!asset) {
    return { platform, binName: 'yt-dlp', downloadUrl: '', version: '' };
  }

  const release = await getLatestRelease();
  const settings = await getSettings();
  const rawUrl = release?.downloadUrl || releaseURL(asset, false);
  const downloadUrl = applyGithubProxy(rawUrl, settings.github_proxy);

  return {
    platform,
    binName: asset.file,
    downloadUrl,
    version: release?.version || '',
  };
}

// 分片上传状态
let uploadExpectedChunks = 0;
let uploadReceivedChunks = 0;
let uploadBinPath = '';

export async function startUpload(totalChunks: number): Promise<void> {
  const platform = await detectPlatform();
  const asset = PLATFORM_ASSETS[platform];
  uploadBinPath = `bin/${asset?.file || 'yt-dlp'}`;
  uploadExpectedChunks = totalChunks;
  uploadReceivedChunks = 0;
  // 清空目标文件
  await songloft.fs.writeFile(uploadBinPath, '', { encoding: 'utf8' });
}

export async function appendUploadChunk(
  data: string,
): Promise<{ received: number; total: number }> {
  // 每片独立解码并追加原始字节，不在内存中拼接完整 base64
  await songloft.fs.appendFile(uploadBinPath, data, { encoding: 'base64' });
  uploadReceivedChunks++;
  return { received: uploadReceivedChunks, total: uploadExpectedChunks };
}

export async function finalizeUpload(): Promise<{
  success: boolean;
  version?: string;
  error?: string;
}> {
  const platform = await detectPlatform();

  if (uploadReceivedChunks !== uploadExpectedChunks) {
    return {
      success: false,
      error: `分片不完整: 收到 ${uploadReceivedChunks}/${uploadExpectedChunks}`,
    };
  }

  try {
    if (!platform.startsWith('windows')) {
      await songloft.command.exec('chmod', ['+x', uploadBinPath], {
        timeout: 5000,
      });
    }

    const version = await getVersion();
    if (!version) {
      throw new Error(
        'yt-dlp 上传后无法运行，请检查二进制的平台、运行库与执行权限',
      );
    }
    logInfo(`[install] yt-dlp 手动上传成功: ${version || '未知版本'}`);
    return { success: true, version };
  } catch (e: any) {
    logError(`[install] yt-dlp 上传失败: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || String(e) };
  }
}

export async function downloadBinary(): Promise<{
  success: boolean;
  version?: string;
  error?: string;
}> {
  const platform = await detectPlatform();
  const asset = PLATFORM_ASSETS[platform];
  if (!asset) {
    return { success: false, error: `Unsupported platform: ${platform}` };
  }

  const release = await getLatestRelease();
  if (!release) {
    return {
      success: false,
      error: asset.repository
        ? 'ARMv7 二进制尚未就绪或暂时无法访问。请查看本插件 Release 的独立构建状态，稍后重试'
        : 'Failed to fetch latest release info',
    };
  }

  const settings = await getSettings();
  const downloadUrl = applyGithubProxy(
    release.downloadUrl,
    settings.github_proxy,
  );

  logInfo(
    `[install] 下载 yt-dlp ${platform} ${release.version} from ${downloadUrl}`,
  );
  try {
    await songloft.command.download(downloadUrl, asset.file);

    if (!platform.startsWith('windows')) {
      await songloft.command.exec('chmod', ['+x', `bin/${asset.file}`], {
        timeout: 5000,
      });
    }

    const version = await getVersion();
    if (!version) {
      throw new Error(
        'yt-dlp 安装后无法运行，请检查二进制的平台、运行库与执行权限',
      );
    }
    logInfo(`[install] yt-dlp 安装成功: ${version || '未知版本'}`);
    return { success: true, version };
  } catch (e: any) {
    logError(`[install] yt-dlp 安装失败: ${e?.message || String(e)}`);
    return { success: false, error: e.message };
  }
}
