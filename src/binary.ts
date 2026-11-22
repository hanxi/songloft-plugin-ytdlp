/// <reference types="@songloft/plugin-sdk" />

import { callHostAPI } from './utils/http';
import { getSettings } from './settings';
import { logInfo, logError } from './logger';
import { version as pluginVersion } from '../package.json';

interface PlatformAsset {
  file: string;
  url: string;
  glibcUrl?: string;
  repository?: string;
  tag?: string;
}

const PLATFORM_ASSETS: Record<string, PlatformAsset> = {
  'linux-amd64': {
    file: 'yt-dlp',
    url: 'yt-dlp_musllinux',
    glibcUrl: 'yt-dlp_linux',
  },
  'linux-arm64': {
    file: 'yt-dlp',
    url: 'yt-dlp_musllinux_aarch64',
    glibcUrl: 'yt-dlp_linux_aarch64',
  },
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

function getBinName(): string {
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
    const platform = resp?.value?.trim();
    if (platform) detectedPlatform = platform;
  } catch {
    // Retry on demand if the host API is temporarily unavailable.
  }
  return detectedPlatform;
}

async function getPlatformAsset(platform: string): Promise<PlatformAsset | undefined> {
  const asset = PLATFORM_ASSETS[platform];
  if (!asset?.glibcUrl) return asset;
  try {
    const result = await songloft.command.exec('getconf', ['GNU_LIBC_VERSION'], {
      timeout: 2000,
    });
    if (result.exitCode === 0 && /^glibc\s/.test(result.stdout.trim())) {
      return { ...asset, url: asset.glibcUrl };
    }
  } catch {
    // getconf is optional on musl systems and minimal images.
  }
  return asset;
}

const REINSTALL_HINT =
  '请在插件设置中重新安装 yt-dlp，并检查服务器架构、运行库和执行权限';

export async function execYtdlp(args: string[], timeout: number, binName?: string) {
  if (!binName) {
    await detectPlatform();
    binName = getBinName();
  }
  try {
    return await songloft.command.exec(binName, args, { timeout });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes('not found in plugin bin/ or system PATH')) {
      throw new Error(`找不到 yt-dlp，请在插件设置中安装 yt-dlp。\n${detail}`);
    }
    if (
      /no such file or directory|permission denied|exec format error|not a valid win32 application/i.test(detail)
    ) {
      const interpreter = detail.match(/ELF interpreter "[^"]+" not found/)?.[0];
      throw new Error(`无法启动 yt-dlp。${REINSTALL_HINT}。\n${interpreter || detail}`);
    }
    throw error;
  }
}

async function probeVersion(binName = getBinName()): Promise<string> {
  const result = await execYtdlp(['--version'], 15000, binName);
  const version = result.stdout.trim();
  if (result.exitCode !== 0 || !version) {
    const detail = result.stderr.trim() || `--version 退出码为 ${result.exitCode}`;
    throw new Error(`yt-dlp 版本检查失败。${REINSTALL_HINT}。\n${detail}`);
  }
  return version;
}

export async function getStatus(): Promise<{
  installed: boolean;
  version: string;
  platform: string;
  error?: string;
}> {
  const platform = await detectPlatform();
  const exists = await songloft.command.exists(getBinName());
  if (!exists) return { installed: false, version: '', platform };

  try {
    return { installed: true, version: await probeVersion(), platform };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { installed: false, version: '', platform, error: detail };
  }
}

interface ReleaseInfo {
  tag_name: string;
  assets: {
    name: string;
    browser_download_url: string;
    label?: string | null;
    size: number;
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

async function fetchRelease(asset: PlatformAsset): Promise<{
  version: string;
  downloadUrl: string;
  size: number;
} | null> {
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
    return { version, downloadUrl: found.browser_download_url, size: found.size };
  } catch {
    return null;
  }
}

export async function getLatestRelease() {
  const asset = await getPlatformAsset(await detectPlatform());
  const release = asset ? await fetchRelease(asset) : null;
  return release ? { version: release.version, downloadUrl: release.downloadUrl } : null;
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
  const asset = await getPlatformAsset(platform);
  if (!asset) {
    return { platform, binName: 'yt-dlp', downloadUrl: '', version: '' };
  }

  const release = await fetchRelease(asset);
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

    const version = await probeVersion();
    logInfo(`[install] yt-dlp 手动上传成功: ${version}`);
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
  if (!platform) {
    return { success: false, error: '无法读取 Songloft 服务器平台，请稍后重试' };
  }
  const asset = await getPlatformAsset(platform);
  if (!asset) {
    return { success: false, error: `Unsupported platform: ${platform}` };
  }

  const release = await fetchRelease(asset);
  if (!release) {
    return {
      success: false,
      error: asset.repository
        ? 'ARMv7 二进制尚未就绪或暂时无法访问。请查看本插件 Release 的独立构建状态，稍后重试'
        : 'Failed to fetch latest release info',
    };
  }
  if (!Number.isSafeInteger(release.size) || release.size <= 0) {
    return { success: false, error: 'GitHub Release 未提供有效的 yt-dlp 文件大小，请稍后重试' };
  }

  const settings = await getSettings();
  const downloadUrl = applyGithubProxy(
    release.downloadUrl,
    settings.github_proxy,
  );

  logInfo(
    `[install] 下载 ${asset.url} ${release.version}（${platform}，${release.size} 字节）`,
  );
  const candidate = `download-${Date.now()}-${Math.random().toString(36).slice(2)}-${asset.file}`;
  const candidatePath = `bin/${candidate}`;
  try {
    await songloft.command.download(downloadUrl, candidate);
    const { size } = await songloft.fs.stat(candidatePath);
    if (size !== release.size) {
      throw new Error(`yt-dlp 文件大小不符，收到 ${size} 字节，应为 ${release.size} 字节。请重试或切换 GitHub 代理`);
    }

    if (!platform.startsWith('windows')) {
      const chmod = await songloft.command.exec('chmod', ['+x', candidatePath], {
        timeout: 5000,
      });
      if (chmod.exitCode !== 0) {
        throw new Error(`无法设置 yt-dlp 执行权限。${chmod.stderr.trim()}`);
      }
    }

    const version = await probeVersion(candidate);
    await songloft.fs.rename(candidatePath, `bin/${asset.file}`);
    logInfo(`[install] yt-dlp 安装成功: ${version}`);
    return { success: true, version };
  } catch (e: any) {
    try {
      await songloft.command.deleteBin(candidate);
    } catch (cleanupError) {
      logError(`[install] 清理下载文件失败: ${String(cleanupError)}`);
    }
    logError(`[install] yt-dlp 安装失败: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || String(e) };
  }
}
