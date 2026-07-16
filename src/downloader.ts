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

// 机器人验证 / 限流：YouTube 偶发要求「确认你不是机器人」或触发 429，属于随机/速率相关的
// 临时性拒绝，隔几秒重试常能成功（issue #265 用户反馈）。这类错误由 music/url 解析时的
// yt-dlp stderr 原样透传上来，故匹配其英文提示。
const BOT_ERROR_RE = /confirm.{0,30}not a bot|not a robot|Sign in to confirm|HTTP Error 429|too many requests|rate.?limit/i;

// 机器人验证退避比普通瞬时错误更久，给服务端限流窗口喘息，避免立刻再撞。
const RETRY_DELAYS_MS = [1000, 3000]; // 瞬时错误：至多重试 2 次
const BOT_RETRY_DELAYS_MS = [3000, 8000]; // 机器人验证：更长退避，至多重试 2 次

function isTransientError(msg: string): boolean {
  return TRANSIENT_ERROR_RE.test(msg);
}

function isBotError(msg: string): boolean {
  return BOT_ERROR_RE.test(msg);
}

async function downloadWithRetry(
  songId: number,
  opts: { path_template: string; embed_metadata: boolean },
): Promise<{ result: any; attempts: number }> {
  let lastErr: any;
  // 最大重试轮数取两类退避表中较长者（当前都是 2）。
  const maxAttempts = Math.max(RETRY_DELAYS_MS.length, BOT_RETRY_DELAYS_MS.length);
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const result = await songloft.songs.download(songId, opts);
      return { result, attempts: attempt + 1 };
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message || String(e);
      const bot = isBotError(msg);
      const transient = isTransientError(msg);
      const delays = bot ? BOT_RETRY_DELAYS_MS : RETRY_DELAYS_MS;
      // 最后一次尝试，或既非瞬时也非机器人验证错误 → 不再重试
      if (attempt >= delays.length || !(bot || transient)) {
        throw e;
      }
      const delay = delays[attempt];
      const kind = bot ? '机器人验证' : '瞬时失败';
      logInfo(`[download] song=${songId} ${kind}(${msg})，${delay}ms 后重试 (${attempt + 1}/${delays.length})`);
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
