/// <reference types="@songloft/plugin-sdk" />

import type { HTTPRequest } from '@songloft/plugin-sdk';
import { getBinName } from './binary';
import { buildCommonArgs, getSettings } from './settings';
import { pickThumbnail } from './extractor';
import type { YtdlpSourceData } from './types';

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

export async function toponeHandler(req: HTTPRequest) {
  const body = parseBody(req);
  const keyword = String(body.keyword || '').trim();
  const hint: { title?: string; artist?: string; duration?: number } | undefined = body.hint;

  if (!keyword) return jsonResp({ code: 400, msg: '缺少 keyword', data: null }, 400);

  const binName = getBinName();
  const commonArgs = await buildCommonArgs();
  const settings = await getSettings();

  const platform = settings.search_platform || 'ytsearch';
  const searchArgs = [
    '--dump-json',
    '--flat-playlist',
    ...commonArgs,
    `${platform}5:${keyword}`,
  ];

  songloft.log.info(`[search/topone] yt-dlp 搜索: ${keyword} ${binName} ${searchArgs}`);
  const searchResult = await songloft.command.exec(binName, searchArgs, { timeout: 60000 });
  songloft.log.info(`[search/topone] yt-dlp 搜索结果: ${searchResult.stdout}`);  

  if (searchResult.exitCode !== 0) {
    songloft.log.warn(`[search/topone] yt-dlp 搜索失败: ${searchResult.stderr.trim().slice(0, 300)}`);
    return jsonResp({ code: 404, msg: 'search failed', data: null });
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

  if (candidates.length === 0) {
    return jsonResp({ code: 404, msg: 'song not found', data: null });
  }

  candidates.sort((a, b) => b.score - a.score);

  let lastError = '';
  for (const { item } of candidates) {
    const targetUrl = item.webpage_url || item.url || '';
    if (!targetUrl) continue;

    try {
      const urlArgs = [
        '-f', settings.audio_quality || 'bestaudio',
        '--dump-json',
        '--no-playlist',
        ...commonArgs,
        targetUrl,
      ];

      const urlResult = await songloft.command.exec(binName, urlArgs, { timeout: 30000 });
      if (urlResult.exitCode !== 0) {
        lastError = urlResult.stderr.trim().slice(0, 300);
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
      if (!url || !url.startsWith('http')) continue;

      const platform = (metadata.extractor_key || metadata.extractor || metadata.ie_key || 'youtube').toLowerCase();
      const sourceData: YtdlpSourceData = {
        platform,
        id: metadata.id || item.id || '',
        url: targetUrl,
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
          url,
          source_data: sourceData,
        },
      });
    } catch (e: any) {
      lastError = e.message || String(e);
    }
  }

  songloft.log.warn(`[search/topone] 所有候选 URL 获取均失败，最后错误: ${lastError}`);
  return jsonResp({ code: 404, msg: 'song not found', data: null });
}
