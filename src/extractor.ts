/// <reference types="@songloft/plugin-sdk" />

import { getBinName } from './binary';
import { buildCommonArgs } from './settings';
import type { ExtractedItem, ExtractResult } from './types';

export async function extractFromURL(url: string): Promise<ExtractResult> {
  const binName = getBinName();
  const commonArgs = await buildCommonArgs();

  const args = [
    '--dump-json',
    '--flat-playlist',
    ...commonArgs,
    url,
  ];

  songloft.log.info(`[extractor] yt-dlp 提取: ${url} ${binName} ${args}`)
  const result = await songloft.command.exec(binName, args, { timeout: 300000 });
  songloft.log.info(`[extractor] yt-dlp 提取结果: ${result.stdout}`)

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(parseYtdlpError(stderr));
  }

  const items = parseNDJSON(result.stdout);
  const playlistTitle = extractPlaylistTitle(result.stdout);
  const platform = items.length > 0 ? items[0].platform : 'unknown';

  // Resolve real titles for flat playlist entries that only have fallback titles
  await resolveItemTitles(items, binName, commonArgs);

  return { items, playlist_title: playlistTitle, platform };
}

function parseNDJSON(stdout: string): ExtractedItem[] {
  const lines = stdout.trim().split('\n').filter(line => line.trim());
  const items: ExtractedItem[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Flat playlist entries (e.g. Bilibili bilisearch / multi-part videos)
      // may have empty title. Use webpage_url_basename or id as fallback.
      const partIndex = obj.playlist_index;
      const baseTitle = obj.title || obj.track || '';
      const fallbackId = obj.webpage_url_basename || obj.id || '';
      // For multi-part videos, append P{N} to make title and id distinguishable
      const title = baseTitle || (partIndex ? `${fallbackId} P${partIndex}` : fallbackId);
      const uniqueId = partIndex ? `${obj.id}_p${partIndex}` : (obj.id || '');
      const item: ExtractedItem = {
        id: uniqueId,
        title,
        artist: obj.artist || obj.uploader || obj.creator || obj.channel || '',
        album: obj.album || '',
        duration: Math.round(obj.duration || 0),
        thumbnail: pickThumbnail(obj),
        platform: (obj.extractor_key || obj.extractor || obj.ie_key || 'unknown').toLowerCase(),
        url: obj.webpage_url || obj.url || '',
      };
      if (item.id) {
        items.push(item);
      }
    } catch {
      // skip malformed lines
    }
  }

  return items;
}

/**
 * Resolve real titles for flat playlist entries that only have fallback titles
 * (e.g. Bilibili bilisearch results where flat playlist doesn't include titles).
 * For Bilibili multi-part videos, uses the pagelist API for batch resolution (1 request).
 * Falls back to individual yt-dlp --dump-json calls for other cases.
 */
async function resolveItemTitles(
  items: ExtractedItem[],
  binName: string,
  commonArgs: string[],
): Promise<void> {
  // Only resolve items whose title looks like a fallback (Bilibili av/BV-number format, or equals the id)
  const toResolve = items.filter(item =>
    item.url && (/^(av\d+|BV\w+)$/.test(item.title) || item.title === item.id || /^av\d+ P\d+$/.test(item.title) || /^BV\w+ P\d+$/.test(item.title)),
  );
  if (toResolve.length === 0) return;

  songloft.log.info(`[extractor] 需要解析标题的条目: ${toResolve.length}`);

  // Fast path: Bilibili multi-part video — use pagelist API (1 request vs N yt-dlp calls)
  if (toResolve.length >= 3) {
    const done = await resolveBilibiliTitlesBatch(toResolve);
    if (done) return;
  }

  // Fallback: resolve individually via yt-dlp --dump-json
  // Resolve in parallel batches of 2 to balance speed and resource usage
  const BATCH_SIZE = 2;
  for (let i = 0; i < toResolve.length; i += BATCH_SIZE) {
    const batch = toResolve.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (item) => {
      try {
        const args = [
          '--dump-json',
          '--no-playlist',
          ...commonArgs,
          item.url,
        ];
        const result = await songloft.command.exec(binName, args, { timeout: 30000 });
        if (result.exitCode !== 0) {
          songloft.log.warn(`[extractor] 解析标题失败 ${item.url}: ${result.stderr.trim().slice(0, 200)}`);
          return;
        }

        const metadata = JSON.parse(result.stdout.trim().split('\n')[0]);
        if (metadata.title || metadata.track) {
          item.title = metadata.title || metadata.track;
          songloft.log.info(`[extractor] 解析标题成功: ${item.url} -> ${item.title}`);
        }
        // Update id with playlist_index for multi-part videos to ensure uniqueness
        if (metadata.playlist_index && item.id) {
          // Extract base id (strip existing _p{N} suffix if present)
          const baseId = item.id.replace(/_p\d+$/, '');
          item.id = `${baseId}_p${metadata.playlist_index}`;
        }
        if (metadata.artist || metadata.uploader || metadata.creator || metadata.channel) {
          item.artist = metadata.artist || metadata.uploader || metadata.creator || metadata.channel || '';
        }
        if (metadata.album) item.album = metadata.album;
        if (metadata.duration) item.duration = Math.round(metadata.duration);
        const thumb = pickThumbnail(metadata);
        if (thumb) item.thumbnail = thumb;
      } catch (e: any) {
        songloft.log.warn(`[extractor] 解析标题异常 ${item.url}: ${e.message || String(e)}`);
        // keep fallback title on error
      }
    }));
  }
}

/**
 * Batch-resolve titles for Bilibili multi-part videos using Bilibili's pagelist API.
 * A single HTTP request (<200ms) returns all part titles instantly, avoiding
 * N individual yt-dlp calls that would be slow and risk rate-limiting.
 * Returns true if batch resolution succeeded.
 */
async function resolveBilibiliTitlesBatch(items: ExtractedItem[]): Promise<boolean> {
  // Extract BV ID or AV number from the first item's URL
  const firstUrl = items[0]?.url || '';
  const bvMatch = firstUrl.match(/bilibili\.com\/video\/(BV\w+)/);
  const avMatch = firstUrl.match(/bilibili\.com\/video\/av(\d+)/);

  let apiUrl: string;
  if (bvMatch) {
    apiUrl = `https://api.bilibili.com/x/player/pagelist?bvid=${bvMatch[1]}`;
  } else if (avMatch) {
    apiUrl = `https://api.bilibili.com/x/player/pagelist?aid=${avMatch[1]}`;
  } else {
    return false;
  }

  try {
    songloft.log.info(`[extractor] 批量获取 Bilibili 分P标题: ${apiUrl}`);
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/',
      },
    });

    if (!resp.ok) {
      songloft.log.warn(`[extractor] Bilibili pagelist API HTTP ${resp.status}`);
      return false;
    }

    const text = await resp.text();
    const data = JSON.parse(text);
    if (data.code !== 0 || !Array.isArray(data.data)) {
      songloft.log.warn(`[extractor] Bilibili pagelist API 返回异常: code=${data.code}`);
      return false;
    }

    const pages = data.data;
    songloft.log.info(`[extractor] Bilibili pagelist 获取到 ${pages.length} 个分P标题`);

    // Map pages to items by page number (Bilibili page is 1-indexed, matches playlist_index)
    let matched = 0;
    for (const page of pages) {
      const pageNum: number = page.page;
      const item = items.find(it => {
        const match = it.id.match(/_p(\d+)$/);
        return match && parseInt(match[1]) === pageNum;
      });
      if (item) {
        item.title = page.part || item.title;
        if (page.duration) item.duration = Math.round(page.duration);
        matched++;
      }
    }

    songloft.log.info(`[extractor] Bilibili 批量标题匹配成功: ${matched}/${pages.length}`);
    return matched > 0;
  } catch (e: any) {
    songloft.log.warn(`[extractor] Bilibili pagelist API 请求失败: ${e.message || String(e)}`);
    return false;
  }
}

export function pickThumbnail(obj: any): string {
  if (obj.thumbnail) return obj.thumbnail;
  if (Array.isArray(obj.thumbnails) && obj.thumbnails.length > 0) {
    const sorted = obj.thumbnails.sort((a: any, b: any) => (b.preference || 0) - (a.preference || 0));
    return sorted[0].url || '';
  }
  return '';
}

function extractPlaylistTitle(stdout: string): string {
  const lines = stdout.trim().split('\n');
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.playlist_title) return obj.playlist_title;
      if (obj.playlist) return obj.playlist;
    } catch {
      continue;
    }
  }
  return '';
}

function parseYtdlpError(stderr: string): string {
  if (stderr.includes('is not a valid URL') || stderr.includes('Unsupported URL')) {
    return '不支持的 URL 格式';
  }
  if (stderr.includes('Private video') || stderr.includes('private video')) {
    return '视频为私密状态，无法访问';
  }
  if (stderr.includes('Video unavailable') || stderr.includes('not available')) {
    return '视频不可用（可能已被删除或地区限制）';
  }
  if (stderr.includes('Sign in') || stderr.includes('bot')) {
    return '需要登录验证，请在设置中配置 Cookies';
  }
  if (stderr.includes('Unable to download webpage') || stderr.includes('urlopen error')) {
    return '网络连接失败，请检查代理设置';
  }
  if (stderr.includes('age-restricted') || stderr.includes('age restricted')) {
    return '年龄限制内容，请配置 Cookies 以访问';
  }
  const lastLine = stderr.split('\n').filter(l => l.includes('ERROR')).pop();
  return lastLine || stderr.slice(0, 300) || 'yt-dlp 执行失败';
}
