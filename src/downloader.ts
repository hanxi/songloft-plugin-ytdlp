/// <reference types="@songloft/plugin-sdk" />

import { getSettings } from './settings';
import { logInfo, logError } from './logger';
import type { BatchTask, BatchSongInfo } from './types';

interface BatchRun {
  task: BatchTask;
  wake: (() => void) | null;
}

let batchTask: BatchTask | null = null;
let activeRun: BatchRun | null = null;

export class BatchBusyError extends Error {
  constructor() {
    super('下载任务尚未结束，请先取消并等待当前歌曲结束');
  }
}

export function isBatchRunning(): boolean {
  return activeRun !== null;
}

export function getBatchTask(): BatchTask | null {
  return batchTask;
}

export function clearBatchTask(): void {
  if (activeRun) throw new BatchBusyError();
  batchTask = null;
}

export function cancelBatch(): void {
  const run = activeRun;
  if (!run || run.task.cancelled) return;
  run.task.cancelled = true;
  run.task.paused = false;
  for (const song of run.task.songs) {
    if (song.status === 'pending') song.status = 'cancelled';
  }
  run.wake?.();
  logInfo('[download] 已取消后续下载，当前歌曲结束后停止');
}

export function pauseBatch(): void {
  if (!activeRun || activeRun.task.cancelled) return;
  activeRun.task.paused = true;
  logInfo('[download] 下载已暂停');
}

export function resumeBatch(): void {
  if (!activeRun || activeRun.task.cancelled || !activeRun.task.paused) return;
  activeRun.task.paused = false;
  activeRun.wake?.();
  logInfo('[download] 下载已恢复');
}

export function isPaused(): boolean {
  return activeRun?.task.paused ?? false;
}

// 暂停、重试退避与下载间隔都可被取消唤醒，不能遗留挂起 Promise 或定时器。
function wait(run: BatchRun, delay?: number): Promise<void> {
  if (run.task.cancelled) return Promise.resolve();
  return new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (run.wake === wake) run.wake = null;
      resolve();
    };
    run.wake = wake;
    if (delay !== undefined) timer = setTimeout(wake, delay);
  });
}

async function waitForResume(run: BatchRun): Promise<void> {
  while (run.task.paused && !run.task.cancelled) await wait(run);
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
  run: BatchRun,
  songId: number,
  opts: { path_template: string; embed_metadata: boolean; format?: string; quality?: string },
): Promise<{ result: any; attempts: number } | null> {
  let lastErr: any;
  // 最大重试轮数取两类退避表中较长者（当前都是 2）。
  const maxAttempts = Math.max(RETRY_DELAYS_MS.length, BOT_RETRY_DELAYS_MS.length);
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    await waitForResume(run);
    if (run.task.cancelled) return null;
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
      if (run.task.cancelled || attempt >= delays.length || !(bot || transient)) {
        throw e;
      }
      const delay = delays[attempt];
      const kind = bot ? '机器人验证' : '瞬时失败';
      logInfo(`[download] song=${songId} ${kind}(${msg})，${delay}ms 后重试 (${attempt + 1}/${delays.length})`);
      await wait(run, delay);
    }
  }
  throw lastErr;
}

export interface StartBatchOptions {
  songTitles?: Map<number, string>;
  playlistName?: string;
}

export async function startBatchDownload(songIds: number[], options?: StartBatchOptions): Promise<void> {
  if (activeRun) throw new BatchBusyError();
  const songs: BatchSongInfo[] = songIds.map(id => ({
    song_id: id,
    title: options?.songTitles?.get(id) || `歌曲 #${id}`,
    status: 'pending',
  }));
  const task: BatchTask = {
    results: [], songs, current: 0, total: songs.length,
    done: false, paused: false, cancelled: false, playlist_name: options?.playlistName || '',
  };
  const run: BatchRun = { task, wake: null };
  // 在第一个 await 前占位，避免同时启动的批次覆盖任务与回调。
  activeRun = run;
  batchTask = task;
  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    activeRun = null;
    batchTask = null;
    throw e;
  }
  const template = settings.path_template;
  const embedMetadata = settings.embed_metadata;
  const interval = settings.download_interval;
  const transcodeFormat = settings.transcode_format;
  const transcodeBitrate = settings.transcode_bitrate;
  const pauseOnError = settings.pause_on_error;
  const playlistName = options?.playlistName || '';
  logInfo(`[download] 开始批量下载 ${songIds.length} 首`);

  (async () => {
    let ok = 0;
    let failed = 0;
    try {
      for (let i = 0; i < songIds.length; i++) {
        await waitForResume(run);
        if (task.cancelled) break;

        task.current = i + 1;
        task.songs[i].status = 'downloading';

        // 预替换 {playlist} 变量（宿主不感知歌单上下文）
        const resolvedTemplate = playlistName
          ? template.replace(/\{playlist\}/g, playlistName)
          : template.replace(/\{playlist\}\/?/g, '');

        try {
          const outcome = await downloadWithRetry(run, songIds[i], {
            path_template: resolvedTemplate,
            embed_metadata: embedMetadata,
            // 转码格式非空时才带上 format/quality（宿主侧空则不转码，保留源格式）
            format: transcodeFormat || undefined,
            quality: transcodeFormat && transcodeBitrate ? String(transcodeBitrate) : undefined,
          });
          if (!outcome) {
            task.songs[i].status = 'cancelled';
            break;
          }
          const { result, attempts } = outcome;
          task.results.push({ song_id: songIds[i], ...result });
          task.songs[i].status = 'ok';
          ok++;
          const retryNote = attempts > 1 ? `（重试 ${attempts - 1} 次后成功）` : '';
          logInfo(`[download] (${i + 1}/${songIds.length}) song=${songIds[i]} 成功${retryNote}`);
        } catch (e: any) {
          const msg = e?.message || String(e);
          task.results.push({ song_id: songIds[i], status: 'failed', error: msg });
          task.songs[i].status = 'failed';
          task.songs[i].error = msg;
          failed++;
          logError(`[download] (${i + 1}/${songIds.length}) song=${songIds[i]} 失败: ${msg}`);

          // 出错自动暂停
          if (pauseOnError && !task.cancelled) {
            task.paused = true;
            logInfo('[download] 下载出错，已自动暂停');
            await waitForResume(run);
          }
        }
        if (task.cancelled) break;
        if (i < songIds.length - 1 && interval > 0) {
          await wait(run, interval * 1000);
        }
      }
    } finally {
      task.done = true;
      task.paused = false;
      run.wake?.();
      if (activeRun === run) activeRun = null;
      logInfo(`[download] 批量下载${task.cancelled ? '已取消' : '结束'}: 成功 ${ok}, 失败 ${failed}`);
    }
  })().catch(e => logError(`[download] 批量下载异常: ${e?.message || String(e)}`));
}
