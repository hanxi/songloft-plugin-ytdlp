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
      // Flat playlist entries (e.g. Bilibili bilisearch) may have empty title.
      // Use webpage_url_basename or id as fallback to avoid filtering out valid entries.
      const title = obj.title || obj.track || obj.webpage_url_basename || obj.id || '';
      const item: ExtractedItem = {
        id: obj.id || '',
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
 * Runs yt-dlp --dump-json on each individual URL to get full metadata.
 */
async function resolveItemTitles(
  items: ExtractedItem[],
  binName: string,
  commonArgs: string[],
): Promise<void> {
  // Only resolve items whose title looks like a fallback (Bilibili av-number format)
  const toResolve = items.filter(item => /^av\d+$/.test(item.title) && item.url);
  if (toResolve.length === 0) return;

  songloft.log.info(`[extractor] 需要解析标题的条目: ${toResolve.length}`);

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
