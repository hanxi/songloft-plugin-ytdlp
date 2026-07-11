/// <reference types="@songloft/plugin-sdk" />

import type { HTTPRequest } from '@songloft/plugin-sdk';
import { jsonResponse } from '@songloft/plugin-sdk';
import { getBinName } from './binary';
import { buildCommonArgs, getSettings } from './settings';
import { logInfo, logError } from './logger';
import type { YtdlpSourceData } from './types';

function reconstructUrl(platform: string, id: string): string {
  switch (platform) {
    case 'youtube':
      return `https://www.youtube.com/watch?v=${id}`;
    case 'bilibili':
      // id 可能带 _pN 后缀（分 P 序号或搜索序号），不能拼进 /video/ 路径，去掉。
      // 真正的分 P 信息由 source_data.url 里的 ?p=N 承载（见 extractor 的 bilibiliPartUrl）。
      return `https://www.bilibili.com/video/${id.replace(/_p\d+$/, '')}`;
    case 'soundcloud':
      return `https://soundcloud.com/${id}`;
    case 'niconico':
      return `https://www.nicovideo.jp/watch/${id}`;
    default:
      throw new Error(`Cannot reconstruct URL for platform: ${platform}, missing url in source_data`);
  }
}

/**
 * 从 yt-dlp --dump-json 输出中提取直链 URL 及其所需的 HTTP 请求头。
 *
 * -f 选中单一格式（如 bestaudio）时，yt-dlp 会把该格式的 url / http_headers
 * 合并到顶层；退化情况下回退到 formats 数组的最后一个（最佳）格式。
 * http_headers 通常含 Referer（B 站防盗链必需）和 User-Agent（YouTube CDN 必需），
 * 缺失这些头会导致宿主拉流 403（无法播放 / 下载失败）。
 */
function pickUrlAndHeaders(metadata: any): { url: string; headers: Record<string, string> } {
  let url: string = metadata.url || '';
  let rawHeaders: Record<string, any> = metadata.http_headers || {};

  if (!url && Array.isArray(metadata.formats) && metadata.formats.length > 0) {
    const best = metadata.formats[metadata.formats.length - 1];
    url = best?.url || '';
    rawHeaders = best?.http_headers || rawHeaders;
  }

  // 只透传字符串值；剔除 Accept-Encoding —— 宿主 Go client 手动 set 头后不会自动解压，
  // 若携带该头会拿到 gzip 原始字节写入文件导致探测/校验失败。
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (k.toLowerCase() === 'accept-encoding') continue;
    if (typeof v === 'string') headers[k] = v;
  }

  return { url, headers };
}

/**
 * music/url handler：解析歌曲的真实播放直链，并连同 yt-dlp 给出的 http_headers
 * 一起返回给宿主。宿主会用这些头去拉流/下载（见 source/fetcher.go 的 headers 字段）。
 *
 * 不复用 SDK 的 createMusicUrlHandler，因为它只能返回单一 url 字符串、
 * 会丢弃 headers，导致 B 站 / YouTube CDN 因缺 Referer / UA 而 403。
 */
export async function musicUrlHandler(req: HTTPRequest) {
  let body: any = {};
  if (req.body) {
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : {};
    } catch {
      return jsonResponse({ error: 'invalid json body' }, 400);
    }
  }

  const sd = body.source_data as YtdlpSourceData | undefined;
  if (!sd || typeof sd !== 'object' || !sd.platform || !sd.id) {
    return jsonResponse({ error: 'Invalid source_data: missing platform or id' }, 400);
  }

  try {
    // sd.url 已是权威地址（分 P 视频带 ?p=N），直接使用；缺失时才按 platform+id 重建。
    const targetUrl = sd.url || reconstructUrl(sd.platform, sd.id);

    const binName = getBinName();
    const settings = await getSettings();
    const commonArgs = await buildCommonArgs();

    const args = [
      '-f', settings.audio_quality || 'bestaudio',
      '--dump-json',
      '--no-playlist',
      ...commonArgs,
      targetUrl,
    ];

    const result = await songloft.command.exec(binName, args, { timeout: 30000 });
    if (result.exitCode !== 0) {
      const err = result.stderr.trim();
      logError(`[music/url] 解析失败 ${sd.platform}:${sd.id} exitCode=${result.exitCode} stderr=${err}`);
      return jsonResponse({ error: err.slice(0, 300) || 'yt-dlp failed to resolve audio URL' }, 404);
    }

    let metadata: any;
    try {
      metadata = JSON.parse(result.stdout.trim().split('\n')[0]);
    } catch {
      logError(`[music/url] 解析失败 ${sd.platform}:${sd.id} 无法解析 yt-dlp 输出`);
      return jsonResponse({ error: 'failed to parse yt-dlp metadata' }, 404);
    }

    const { url, headers } = pickUrlAndHeaders(metadata);
    if (!url || !url.startsWith('http')) {
      logError(`[music/url] 解析失败 ${sd.platform}:${sd.id} yt-dlp 返回无效 URL`);
      return jsonResponse({ error: 'yt-dlp returned invalid URL' }, 404);
    }

    logInfo(`[music/url] 解析成功: ${sd.platform}:${sd.id} headers=${Object.keys(headers).join(',')}`);
    return jsonResponse({ url, headers });
  } catch (e: any) {
    logError(`[music/url] 异常 ${sd.platform}:${sd.id}: ${e?.message || String(e)}`);
    return jsonResponse({ error: e.message || String(e) }, 404);
  }
}
