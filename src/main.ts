/// <reference types="@songloft/plugin-sdk" />

import { jsonResponse, createRouter } from '@songloft/plugin-sdk';
import { detectPlatform, getStatus, getLatestRelease, startInstall, getInstallTask } from './binary';
import { extractFromURL } from './extractor';
import { importSongs } from './importer';
import { startBatchDownload, getBatchTask, clearBatchTask } from './downloader';
import { musicUrlHandler } from './music-url';
import { getSettings, saveSettings } from './settings';
import type { ExtractedItem } from './types';

const router = createRouter();

// --- Binary management ---

router.get('/api/status', async () => {
  const status = await getStatus();
  return jsonResponse(status);
});

router.post('/api/install', async () => {
  // fire-and-forget：立即返回，避免 ExecuteJS 30s wall-clock 超时。
  // 前端轮询 /api/install/status 获取进度。
  const task = startInstall();
  return jsonResponse({ started: true, status: task.status });
});

router.get('/api/install/status', async () => {
  return jsonResponse(getInstallTask());
});

router.get('/api/releases', async () => {
  const release = await getLatestRelease();
  if (!release) {
    return jsonResponse({ error: 'Failed to fetch release info' }, 500);
  }
  return jsonResponse(release);
});

// --- Extraction ---

router.post('/api/extract', async (req) => {
  const { url } = JSON.parse(String(req.body)) as { url: string };
  if (!url) {
    return jsonResponse({ error: 'url is required' }, 400);
  }

  try {
    const result = await extractFromURL(url);
    return jsonResponse(result);
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
});

// --- Import ---

router.post('/api/import', async (req) => {
  const { items, playlist_name, playlist_id } = JSON.parse(String(req.body)) as {
    items: ExtractedItem[];
    playlist_name?: string;
    playlist_id?: number;
  };

  if (!items || items.length === 0) {
    return jsonResponse({ error: 'items is required' }, 400);
  }

  try {
    const result = await importSongs(items, playlist_name, playlist_id);
    return jsonResponse({ count: result.songs.length, playlist_id: result.playlist_id });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
});

// --- Import + Download ---

router.post('/api/import-download', async (req) => {
  const { items, playlist_name, playlist_id } = JSON.parse(String(req.body)) as {
    items: ExtractedItem[];
    playlist_name?: string;
    playlist_id?: number;
  };

  if (!items || items.length === 0) {
    return jsonResponse({ error: 'items is required' }, 400);
  }

  try {
    const result = await importSongs(items, playlist_name, playlist_id);
    const songIds = result.songs.map(s => s.id);
    await startBatchDownload(songIds);
    return jsonResponse({
      count: result.songs.length,
      playlist_id: result.playlist_id,
      download_started: true,
    });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
});

// --- Batch download ---

router.post('/api/download-batch', async (req) => {
  const { song_ids } = JSON.parse(String(req.body)) as { song_ids: number[] };
  if (!song_ids || song_ids.length === 0) {
    return jsonResponse({ error: 'song_ids is required' }, 400);
  }

  await startBatchDownload(song_ids);
  return jsonResponse({ started: true, total: song_ids.length });
});

router.get('/api/download-batch/progress', async () => {
  const task = getBatchTask();
  if (!task) {
    return jsonResponse({ active: false });
  }
  const success = task.results.filter(r => r.status === 'ok').length;
  const failed = task.results.filter(r => r.status === 'failed').length;
  return jsonResponse({
    active: true,
    current: task.current,
    total: task.total,
    done: task.done,
    success,
    failed,
    results: task.results,
  });
});

router.post('/api/download-batch/clear', async () => {
  clearBatchTask();
  return jsonResponse({ ok: true });
});

// --- Music URL resolution ---

router.post('/api/music/url', musicUrlHandler);

// --- Settings ---

router.get('/api/settings', async () => {
  const settings = await getSettings();
  return jsonResponse(settings);
});

router.post('/api/settings', async (req) => {
  const body = JSON.parse(String(req.body));
  const updated = await saveSettings(body);
  return jsonResponse(updated);
});

// --- Lifecycle ---

globalThis.onInit = async () => {
  await detectPlatform();
};

globalThis.onHTTPRequest = (req) => router.handle(req);
