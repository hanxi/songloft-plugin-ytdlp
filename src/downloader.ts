/// <reference types="@songloft/plugin-sdk" />

import { getSettings } from './settings';
import type { BatchResult, BatchTask } from './types';

let batchTask: BatchTask | null = null;

export function getBatchTask(): BatchTask | null {
  return batchTask;
}

export function clearBatchTask(): void {
  batchTask = null;
}

export async function startBatchDownload(songIds: number[]): Promise<void> {
  const settings = await getSettings();
  const template = settings.path_template;
  const embedMetadata = settings.embed_metadata;
  const interval = settings.download_interval;

  batchTask = { results: [], current: 0, total: songIds.length, done: false };

  (async () => {
    for (let i = 0; i < songIds.length; i++) {
      if (!batchTask) break;
      batchTask.current = i + 1;
      try {
        const result = await songloft.songs.download(songIds[i], {
          path_template: template,
          embed_metadata: embedMetadata,
        });
        batchTask.results.push({ song_id: songIds[i], ...result });
      } catch (e: any) {
        batchTask.results.push({ song_id: songIds[i], status: 'failed', error: e.message });
      }
      if (i < songIds.length - 1 && interval > 0) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
      }
    }
    if (batchTask) batchTask.done = true;
  })();
}
