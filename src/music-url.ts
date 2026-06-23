/// <reference types="@songloft/plugin-sdk" />

import { createMusicUrlHandler } from '@songloft/plugin-sdk';
import { getBinName } from './binary';
import { buildCommonArgs, getSettings } from './settings';
import type { YtdlpSourceData } from './types';

function reconstructUrl(platform: string, id: string): string {
  switch (platform) {
    case 'youtube':
      return `https://www.youtube.com/watch?v=${id}`;
    case 'bilibili':
      return `https://www.bilibili.com/video/${id}`;
    case 'soundcloud':
      return `https://soundcloud.com/${id}`;
    case 'niconico':
      return `https://www.nicovideo.jp/watch/${id}`;
    default:
      throw new Error(`Cannot reconstruct URL for platform: ${platform}, missing url in source_data`);
  }
}

export const musicUrlHandler = createMusicUrlHandler({
  resolveUrl: async (sourceData) => {
    const sd = sourceData as unknown as YtdlpSourceData;
    if (!sd.platform || !sd.id) {
      throw new Error('Invalid source_data: missing platform or id');
    }

    const targetUrl = sd.url || reconstructUrl(sd.platform, sd.id);
    const binName = getBinName();
    const settings = await getSettings();
    const commonArgs = await buildCommonArgs();

    const args = [
      '-f', settings.audio_quality || 'bestaudio',
      '-g',
      '--no-playlist',
      ...commonArgs,
      targetUrl,
    ];

    const result = await songloft.command.exec(binName, args, { timeout: 30000 });

    if (result.exitCode !== 0) {
      const err = result.stderr.trim();
      throw new Error(err.slice(0, 300) || 'yt-dlp failed to resolve audio URL');
    }

    const url = result.stdout.trim().split('\n')[0];
    if (!url || !url.startsWith('http')) {
      throw new Error('yt-dlp returned invalid URL');
    }

    return url;
  },
});
