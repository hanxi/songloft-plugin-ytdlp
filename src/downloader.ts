/// <reference types="@songloft/plugin-sdk" />

import { getSettings } from './settings';
import { logInfo, logError } from './logger';
import type { BatchResult, BatchTask } from './types';

let batchTask: BatchTask | null = null;

export function getBatchTask(): BatchTask | null {
  return batchTask;
}

export function clearBatchTask(): void {
  batchTask = null;
}

// 瞬时错误：调度器排队超时 / 队列背压。批量下载启动时若与导入探测撞车，
// 会短暂堵在 ytdlp 唯一 worker 上触发 scheduler 30s 硬超时，等 backlog 排空即恢复，
// 故对这类错误退避重试；非瞬时错误（不支持的 URL、解析失败等）直接失败不重试。
const TRANSIENT_ERROR_RE = /call timeout|scheduler:\s*call timeout|queue full|backpressure|\btimeout\b/i;
const RETRY_DELAYS_MS = [1000, 3000]; // 至多重试 2 次

function isTransientError(msg: string): boolean {
  return TRANSIENT_ERROR_RE.test(msg);
}

async function downloadWithRetry(
  songId: number,
  opts: { path_template: string; embed_metadata: boolean },
): Promise<{ result: any; attempts: number }> {
  let lastErr: any;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await songloft.songs.download(songId, opts);
      return { result, attempts: attempt + 1 };
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message || String(e);
      // 最后一次尝试，或非瞬时错误 → 不再重试
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientError(msg)) {
        throw e;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      logInfo(`[download] song=${songId} 瞬时失败(${msg})，${delay}ms 后重试 (${attempt + 1}/${RETRY_DELAYS_MS.length})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

export async function startBatchDownload(songIds: number[]): Promise<void> {
  const settings = await getSettings();
  const template = settings.path_template;
  const embedMetadata = settings.embed_metadata;
  const interval = settings.download_interval;

  batchTask = { results: [], current: 0, total: songIds.length, done: false };
  logInfo(`[download] 开始批量下载 ${songIds.length} 首`);

  (async () => {
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < songIds.length; i++) {
      if (!batchTask) break;
      batchTask.current = i + 1;
      try {
        const { result, attempts } = await downloadWithRetry(songIds[i], {
          path_template: template,
          embed_metadata: embedMetadata,
        });
        batchTask.results.push({ song_id: songIds[i], ...result });
        ok++;
        const retryNote = attempts > 1 ? `（重试 ${attempts - 1} 次后成功）` : '';
        logInfo(`[download] (${i + 1}/${songIds.length}) song=${songIds[i]} 成功${retryNote}`);
      } catch (e: any) {
        const msg = e?.message || String(e);
        batchTask.results.push({ song_id: songIds[i], status: 'failed', error: msg });
        failed++;
        logError(`[download] (${i + 1}/${songIds.length}) song=${songIds[i]} 失败: ${msg}`);
      }
      if (i < songIds.length - 1 && interval > 0) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
      }
    }
    if (batchTask) batchTask.done = true;
    logInfo(`[download] 批量下载结束: 成功 ${ok}, 失败 ${failed}`);
  })();
}
