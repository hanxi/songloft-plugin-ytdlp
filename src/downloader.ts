/// <reference types="@songloft/plugin-sdk" />

import { getSettings } from './settings';
import { logInfo, logError } from './logger';
import type { BatchResult, BatchTask, BatchSongInfo } from './types';

let batchTask: BatchTask | null = null;
let paused = false;
let resumeResolve: (() => void) | null = null;

export function getBatchTask(): BatchTask | null {
  if (batchTask) {
    batchTask.paused = paused;
  }
  return batchTask;
}

export function clearBatchTask(): void {
  batchTask = null;
  paused = false;
  resumeResolve = null;
}

export function pauseBatch(): void {
  paused = true;
  if (batchTask) batchTask.paused = true;
  logInfo('[download] 下载已暂停');
}

export function resumeBatch(): void {
  paused = false;
  if (batchTask) batchTask.paused = false;
  if (resumeResolve) {
    resumeResolve();
    resumeResolve = null;
  }
  logInfo('[download] 下载已恢复');
}

export function isPaused(): boolean {
  return paused;
}

function waitForResume(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise<void>(resolve => {
    resumeResolve = resolve;
  });
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
  opts: { path_template: string; embed_metadata: boolean; format?: string; quality?: string },
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

export interface StartBatchOptions {
  songTitles?: Map<number, string>;
  playlistName?: string;
}

export async function startBatchDownload(songIds: number[], options?: StartBatchOptions): Promise<void> {
  const settings = await getSettings();
  const template = settings.path_template;
  const embedMetadata = settings.embed_metadata;
  const interval = settings.download_interval;
  const transcodeFormat = settings.transcode_format;
  const transcodeBitrate = settings.transcode_bitrate;
  const pauseOnError = settings.pause_on_error;
  const playlistName = options?.playlistName || '';
  const songTitles = options?.songTitles;

  const songs: BatchSongInfo[] = songIds.map(id => ({
    song_id: id,
    title: songTitles?.get(id) || `歌曲 #${id}`,
    status: 'pending' as const,
  }));

  paused = false;
  resumeResolve = null;
  batchTask = { results: [], songs, current: 0, total: songIds.length, done: false, paused: false, playlist_name: playlistName };
  logInfo(`[download] 开始批量下载 ${songIds.length} 首`);

  (async () => {
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < songIds.length; i++) {
      if (!batchTask) break;

      // 暂停检查
      if (paused) {
        await waitForResume();
      }
      if (!batchTask) break;

      batchTask.current = i + 1;
      batchTask.songs[i].status = 'downloading';

      // 预替换 {playlist} 变量（宿主不感知歌单上下文）
      const resolvedTemplate = playlistName
        ? template.replace(/\{playlist\}/g, playlistName)
        : template.replace(/\{playlist\}\/?/g, '');

      try {
        const { result, attempts } = await downloadWithRetry(songIds[i], {
          path_template: resolvedTemplate,
          embed_metadata: embedMetadata,
          // 转码格式非空时才带上 format/quality（宿主侧空则不转码，保留源格式）
          format: transcodeFormat || undefined,
          quality: transcodeFormat && transcodeBitrate ? String(transcodeBitrate) : undefined,
        });
        batchTask.results.push({ song_id: songIds[i], ...result });
        batchTask.songs[i].status = 'ok';
        ok++;
        const retryNote = attempts > 1 ? `（重试 ${attempts - 1} 次后成功）` : '';
        logInfo(`[download] (${i + 1}/${songIds.length}) song=${songIds[i]} 成功${retryNote}`);
      } catch (e: any) {
        const msg = e?.message || String(e);
        batchTask.results.push({ song_id: songIds[i], status: 'failed', error: msg });
        batchTask.songs[i].status = 'failed';
        batchTask.songs[i].error = msg;
        failed++;
        logError(`[download] (${i + 1}/${songIds.length}) song=${songIds[i]} 失败: ${msg}`);

        // 出错自动暂停
        if (pauseOnError) {
          paused = true;
          batchTask.paused = true;
          logInfo('[download] 下载出错，已自动暂停');
          await waitForResume();
          if (!batchTask) break;
        }
      }
      if (i < songIds.length - 1 && interval > 0) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
      }
    }
    if (batchTask) batchTask.done = true;
    logInfo(`[download] 批量下载结束: 成功 ${ok}, 失败 ${failed}`);
  })();
}
