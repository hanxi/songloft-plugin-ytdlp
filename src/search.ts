/// <reference types="@songloft/plugin-sdk" />

import type { HTTPRequest } from '@songloft/plugin-sdk';
import { execYtdlp } from './binary';
import { buildCommonArgs, getSettings } from './settings';
import { parseYtdlpError, pickThumbnail } from './extractor';
import type { YtdlpSourceData } from './types';

const DEFAULT_HOST_TIMEOUT_MS = 30000;
const MAX_HOST_TIMEOUT_MS = 60000;
const RESPONSE_MARGIN_MS = 2000;

function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function jsonResp(data: any, statusCode = 200) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function getHeader(req: HTTPRequest, name: string): string | undefined {
  return Object.entries(req.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function searchFailure(code: number, msg: string) {
  return jsonResp({ code, msg, data: null });
}

function searchTimeout() {
  return searchFailure(504, 'yt-dlp 搜索或解析音频超时，请检查网络、代理或减少搜索结果数量');
}

function searchHit(item: any, metadata: any, sourceUrl: string, audioUrl?: string) {
  const sourceData: YtdlpSourceData = {
    platform: (metadata.extractor_key || metadata.extractor || metadata.ie_key ||
      item.extractor_key || item.extractor || item.ie_key || 'youtube').toLowerCase(),
    id: metadata.id || item.id || '',
    url: sourceUrl,
  };
  return jsonResp({
    code: 0,
    msg: 'success',
    data: {
      title: metadata.title || metadata.track || item.title || item.track || '',
      artist: metadata.artist || metadata.uploader || metadata.creator || metadata.channel ||
        item.artist || item.uploader || item.creator || item.channel || '',
      album: metadata.album || item.album || '',
      duration: Math.round(metadata.duration || item.duration || 0),
      cover_url: pickThumbnail(metadata) || pickThumbnail(item),
      url: audioUrl,
      source_data: sourceData,
      // 宿主播放时借此调用 /api/music/url，取得新鲜直链及 Referer 等请求头。
      plugin_entry_path: 'ytdlp',
    },
  });
}

export async function toponeHandler(req: HTTPRequest) {
  const body = parseBody(req);
  const keyword = String(body.keyword || '').trim();
  const hint: { title?: string; artist?: string; duration?: number } | undefined = body.hint;

  if (!keyword) return jsonResp({ code: 400, msg: '缺少 keyword', data: null }, 400);

  const timeoutHeader = getHeader(req, 'x-plugin-timeout-ms')?.trim() ?? '';
  const requestedTimeout = /^\+?\d+$/.test(timeoutHeader) ? Number(timeoutHeader) : NaN;
  const hostTimeout = Number.isSafeInteger(requestedTimeout)
    ? Math.min(MAX_HOST_TIMEOUT_MS, Math.max(DEFAULT_HOST_TIMEOUT_MS, requestedTimeout))
    : DEFAULT_HOST_TIMEOUT_MS;
  const deadline = Date.now() + hostTimeout - RESPONSE_MARGIN_MS;
  const resolveUrl = getHeader(req, 'x-songloft-resolve-url') !== 'false';
  const commonArgs = await buildCommonArgs();
  const settings = await getSettings();

  const platform = settings.search_platform || 'ytsearch';
  const count = Math.max(1, Math.min(50, settings.search_count || 5));
  const searchArgs = [
    '--dump-json',
    '--flat-playlist',
    ...commonArgs,
    `${platform}${count}:${keyword}`,
  ];

  const searchBudget = deadline - Date.now();
  if (searchBudget <= 0) return searchTimeout();
  songloft.log.info(`[search/topone] yt-dlp 搜索: ${keyword}`);
  let searchResult: Awaited<ReturnType<typeof execYtdlp>>;
  try {
    searchResult = await execYtdlp(searchArgs, searchBudget);
  } catch (error) {
    return searchFailure(502, error instanceof Error ? error.message : String(error));
  }
  if (Date.now() >= deadline) return searchTimeout();
  if (searchResult.exitCode !== 0) {
    const message = parseYtdlpError(searchResult.stderr.trim()).slice(0, 300);
    songloft.log.warn(`[search/topone] yt-dlp 搜索失败: ${message}`);
    return searchFailure(502, message);
  }

  const lines = searchResult.stdout.trim().split('\n').filter(l => l.trim());
  const candidates: Array<{ score: number; item: any }> = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const title = String(obj.title || obj.track || '');
      const artist = String(obj.artist || obj.uploader || obj.creator || obj.channel || '');

      // Flat playlist entries (e.g. Bilibili bilisearch) may have empty title.
      // Keep them with minimal score; real metadata will be extracted in URL resolution phase.
      if (!title) {
        candidates.push({ score: 0.1, item: obj });
        continue;
      }

      let score = 0;
      if (hint) {
        if (hint.title) {
          if (title === hint.title) score += 0.5;
          else if (title.includes(hint.title) || hint.title.includes(title)) score += 0.3;
        }
        if (hint.artist) {
          if (artist === hint.artist) score += 0.3;
          else if (artist.includes(hint.artist) || hint.artist.includes(artist)) score += 0.15;
        }
      } else {
        score = 1;
      }

      if (score < 0.4) continue;
      candidates.push({ score, item: obj });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (!resolveUrl) {
    for (const { item } of candidates) {
      const targetUrl = item.webpage_url || item.url || '';
      if (item.id && (item.title || item.track) && /^https?:\/\//i.test(targetUrl)) {
        return searchHit(item, item, targetUrl);
      }
    }
    // 部分平台的平铺结果没有标题，继续走完整解析以取得可导入的元数据。
  }

  let lastError = '';
  for (const { item } of candidates) {
    const targetUrl = item.webpage_url || item.url || '';
    if (!targetUrl) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return searchTimeout();
    try {
      const urlArgs = [
        '-f', settings.audio_quality || 'bestaudio',
        '--dump-json',
        '--no-playlist',
        ...commonArgs,
        targetUrl,
      ];

      const urlResult = await execYtdlp(urlArgs, remaining);
      if (Date.now() >= deadline) return searchTimeout();
      if (urlResult.exitCode !== 0) {
        const stderr = urlResult.stderr.trim();
        lastError = parseYtdlpError(stderr).slice(0, 300);
        if (/sign in to confirm[^\n]*not a bot/i.test(stderr)) {
          songloft.log.warn(`[search/topone] 音频解析失败: ${lastError}`);
          return searchFailure(502, lastError);
        }
        continue;
      }

      let metadata: any;
      try {
        metadata = JSON.parse(urlResult.stdout.trim().split('\n')[0]);
      } catch {
        lastError = 'failed to parse metadata JSON';
        continue;
      }

      // Extract URL from full metadata (replaces -g which only returned URL without title/artist)
      let url = metadata.url || '';
      if (!url && metadata.formats && Array.isArray(metadata.formats)) {
        const bestFormat = metadata.formats[metadata.formats.length - 1];
        url = bestFormat?.url || '';
      }
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        lastError = 'yt-dlp 未返回音频直链';
        continue;
      }
      return searchHit(item, metadata, targetUrl, url);
    } catch (e: any) {
      lastError = e.message || String(e);
    }
  }

  if (Date.now() >= deadline) return searchTimeout();
  if (lastError) {
    songloft.log.warn(`[search/topone] 音频解析失败: ${lastError}`);
    return searchFailure(502, lastError);
  }
  return searchFailure(404, '未找到匹配的歌曲');
}
