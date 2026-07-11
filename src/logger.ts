/// <reference types="@songloft/plugin-sdk" />

/**
 * 插件日志模块：内存环形缓冲 + 落盘持久化。
 *
 * 背景：yt-dlp 提取/播放解析/下载都在宿主侧发起网络请求，失败原因（403、超时、
 * yt-dlp stderr 等）此前被截断或吞掉，用户在前端只能看到「失败」却不知原因
 * （见 songloft-org/songloft#265）。这里统一收集关键日志，供设置页「日志」卡片查看。
 *
 * - 内存 buffer 是权威来源，保存最近 MAX_ENTRIES 条，读取快、无 IO。
 * - 同时追加到 data/ytdlp.log（JSONL，每行一条），插件重载后可从文件恢复。
 * - 每条日志同时转发到宿主 songloft.log，保留在服务端日志里。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;      // epoch ms
  level: LogLevel;
  msg: string;
}

const LOG_FILE = 'data/ytdlp.log';
const MAX_ENTRIES = 1000;        // 内存与文件保留的最大条数
const MAX_MSG_LEN = 2000;        // 单条消息上限，防止超长 stderr 撑爆
const ROTATE_EVERY = 50;         // 每写入 N 条检查一次是否需要轮转
const MAX_FILE_BYTES = 512 * 1024;

let buffer: LogEntry[] = [];
let writeCount = 0;
let restored = false;

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_MSG_LEN) return s;
  return s.slice(0, MAX_MSG_LEN) + '...(truncated)';
}

/** 把内存 buffer 全量重写到文件（用于轮转/清理）。 */
async function rewriteFile(): Promise<void> {
  try {
    const lines = buffer.map(e => JSON.stringify(e)).join('\n');
    await songloft.fs.writeFile(LOG_FILE, lines ? lines + '\n' : '', { encoding: 'utf8' });
  } catch {
    // 落盘失败不影响内存日志，静默
  }
}

/** 追加单条到文件，并按计数节流检查轮转。 */
async function persist(entry: LogEntry): Promise<void> {
  try {
    await songloft.fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
    writeCount++;
    if (writeCount % ROTATE_EVERY === 0) {
      let tooBig = false;
      try {
        const st = await songloft.fs.stat(LOG_FILE);
        tooBig = st.size > MAX_FILE_BYTES;
      } catch {
        tooBig = false;
      }
      if (tooBig) {
        // buffer 已是最近 MAX_ENTRIES 条，直接重写覆盖，实现截断
        await rewriteFile();
      }
    }
  } catch {
    // 落盘失败静默
  }
}

/** 记录一条日志：写内存 buffer + 转发宿主 + 异步落盘。 */
export function log(level: LogLevel, msg: string): void {
  const entry: LogEntry = { ts: nowMs(), level, msg: truncate(String(msg)) };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }

  // 转发到宿主日志（服务端可见）
  try {
    const fn = (songloft.log as any)[level] || songloft.log.info;
    fn.call(songloft.log, entry.msg);
  } catch {
    // ignore
  }

  // fire-and-forget 落盘
  persist(entry).catch(() => {});
}

export const logDebug = (msg: string) => log('debug', msg);
export const logInfo = (msg: string) => log('info', msg);
export const logWarn = (msg: string) => log('warn', msg);
export const logError = (msg: string) => log('error', msg);

/** 返回最近 limit 条日志（默认全部 buffer），按时间升序。 */
export function getLogs(limit?: number): LogEntry[] {
  if (!limit || limit <= 0 || limit >= buffer.length) return buffer.slice();
  return buffer.slice(buffer.length - limit);
}

/** 清空内存与文件日志。 */
export async function clearLogs(): Promise<void> {
  buffer = [];
  writeCount = 0;
  try {
    if (await songloft.fs.exists(LOG_FILE)) {
      await songloft.fs.unlink(LOG_FILE);
    }
  } catch {
    // ignore
  }
}

/** 插件启动时从文件恢复最近日志到内存（仅执行一次）。 */
export async function restoreLogs(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    if (!(await songloft.fs.exists(LOG_FILE))) return;
    const content = await songloft.fs.readFile(LOG_FILE, { encoding: 'utf8' });
    const lines = content.split('\n').filter(l => l.trim() !== '');
    const tail = lines.slice(Math.max(0, lines.length - MAX_ENTRIES));
    const restoredEntries: LogEntry[] = [];
    for (const line of tail) {
      try {
        const e = JSON.parse(line) as LogEntry;
        if (e && typeof e.ts === 'number' && e.level && typeof e.msg === 'string') {
          restoredEntries.push(e);
        }
      } catch {
        // 跳过损坏行
      }
    }
    buffer = restoredEntries;
  } catch {
    // ignore
  }
}
