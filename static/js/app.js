// yt-dlp 插件前端逻辑

import './logs.js';

const API = window.SongloftPlugin || { apiGet: (p) => fetch(p).then(r => r.json()), apiPost: (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()), getAuthToken: () => '' };

// 提取/搜索会跑 yt-dlp 展开歌单，radio/mix 无限歌单可能 >30s，放宽宿主调用超时到 5min，
// 与插件侧 command.exec 的 300s 预算对齐，避免撞默认 30s 报 504 plugin call failed。
const EXTRACT_TIMEOUT_MS = 300000;

// 提取专用 POST：不走 API.apiPost（宿主注入的 common.js 以 immutable 长缓存分发，旧客户端
// 可能仍是不带超时头能力的旧版），而是直接 fetch 并显式带上 X-Plugin-Timeout-Ms 头，
// 保证放宽超时对所有客户端立即生效。auth token 走 API.getAuthToken()（各版本 common.js 都有）。
async function extractPost(url) {
    const headers = {
        'Content-Type': 'application/json',
        'X-Plugin-Timeout-Ms': String(EXTRACT_TIMEOUT_MS),
    };
    const token = (API.getAuthToken && API.getAuthToken()) || '';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // 相对路径 './api/extract' 相对页面 <base>（/api/v1/jsplugin/ytdlp/）解析，与 common.js 一致。
    const resp = await fetch('./api/extract', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url }),
    });
    const text = await resp.text();
    if (!resp.ok) {
        let msg = resp.statusText || ('HTTP ' + resp.status);
        try {
            const body = JSON.parse(text);
            if (body && (body.message || body.error)) msg = body.message || body.error;
        } catch (_) { /* 非 JSON 错误体，保留状态文案 */ }
        throw new Error(msg);
    }
    return text ? JSON.parse(text) : {};
}

// --- State ---
let extractedItems = [];
let selectedIndices = new Set();
let resultPage = 0;
let resultPageSize = 30;

let downloadPollTimer = null;
let lastProgress = null;
let dlPage = 0;
const DL_PAGE_SIZE = 30;

// --- Tab switching ---
document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

        if (tab.dataset.tab === 'download') loadRemoteSongs();
        if (tab.dataset.tab === 'settings') loadStatus();
    });
});

// --- Snackbar ---
function showSnackbar(msg) {
    const el = document.getElementById('snackbar');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

// --- Utility ---
function formatDuration(sec) {
    if (!sec) return '--:--';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function proxyThumbnail(url) {
    if (!url) return '';
    const token = API.getAuthToken();
    if (!token) return url;
    return '/api/v1/proxy?url=' + encodeURIComponent(url) + '&access_token=' + encodeURIComponent(token);
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : str;
    return d.innerHTML;
}

// ==================== Tab 1: Import ====================

// --- Mode toggle ---

document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        document.getElementById('mode-url').classList.toggle('hidden', mode !== 'url');
        document.getElementById('mode-search').classList.toggle('hidden', mode !== 'search');
        // Sync search platform from settings
        if (mode === 'search') syncSearchPlatformForImport();
    });
});

function syncSearchPlatformForImport() {
    const settingVal = getSearchPlatformValue();
    if (settingVal && settingVal !== '__custom__') {
        const sel = document.getElementById('import-search-platform');
        const option = sel.querySelector(`option[value="${settingVal}"]`);
        if (option) sel.value = settingVal;
    }
}

// --- URL 模式：提取按钮 ---

document.getElementById('btn-extract').addEventListener('click', async () => {
    const url = document.getElementById('input-url').value.trim();
    if (!url) { showSnackbar('请输入链接'); return; }

    const btn = document.getElementById('btn-extract');
    btn.disabled = true;
    document.getElementById('extract-progress').classList.remove('hidden');
    document.getElementById('extract-error').classList.add('hidden');
    document.getElementById('result-card').classList.add('hidden');
    document.getElementById('import-card').classList.add('hidden');

    try {
        const resp = await extractPost(url);
        if (resp.error) throw new Error(resp.error);

        extractedItems = resp.items || [];
        renderExtractResult(resp);
    } catch (e) {
        document.getElementById('extract-error').textContent = e.message || '提取失败';
        document.getElementById('extract-error').classList.remove('hidden');
    } finally {
        btn.disabled = false;
        document.getElementById('extract-progress').classList.add('hidden');
    }
});

// --- 搜索模式：搜索按钮 ---

document.getElementById('btn-search').addEventListener('click', async () => {
    const keyword = document.getElementById('input-search').value.trim();
    if (!keyword) { showSnackbar('请输入搜索关键字'); return; }

    const platform = document.getElementById('import-search-platform').value;
    const url = `${platform}5:${keyword}`;

    const btn = document.getElementById('btn-search');
    btn.disabled = true;
    document.getElementById('extract-progress').classList.remove('hidden');
    document.getElementById('extract-error').classList.add('hidden');
    document.getElementById('result-card').classList.add('hidden');
    document.getElementById('import-card').classList.add('hidden');

    try {
        const resp = await extractPost(url);
        if (resp.error) throw new Error(resp.error);

        extractedItems = resp.items || [];
        renderExtractResult(resp);
    } catch (e) {
        document.getElementById('extract-error').textContent = e.message || '搜索失败';
        document.getElementById('extract-error').classList.remove('hidden');
    } finally {
        btn.disabled = false;
        document.getElementById('extract-progress').classList.add('hidden');
    }
});

function renderExtractResult(resp) {
    const items = resp.items || [];
    if (items.length === 0) {
        showSnackbar('未提取到任何歌曲');
        return;
    }

    // 默认全选所有项目
    selectedIndices = new Set(items.map((_, i) => i));
    resultPage = 0;

    document.getElementById('result-count').textContent = items.length;
    document.getElementById('result-card').classList.remove('hidden');
    document.getElementById('import-card').classList.remove('hidden');
    document.getElementById('check-all').checked = true;

    renderResultPage();

    if (resp.playlist_title) {
        document.getElementById('input-playlist-name').value = resp.playlist_title;
    }
}

function resultPageCount() {
    return Math.max(1, Math.ceil(extractedItems.length / resultPageSize));
}

function renderResultPage() {
    const totalPages = resultPageCount();
    if (resultPage >= totalPages) resultPage = totalPages - 1;
    if (resultPage < 0) resultPage = 0;

    const start = resultPage * resultPageSize;
    const end = Math.min(start + resultPageSize, extractedItems.length);
    const pageItems = extractedItems.slice(start, end);

    const list = document.getElementById('result-list');
    list.innerHTML = '';

    pageItems.forEach((item, offset) => {
        const i = start + offset;
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `
            <input type="checkbox" class="song-check" data-index="${i}" ${selectedIndices.has(i) ? 'checked' : ''}>
            ${item.thumbnail ? `<img class="song-thumb" src="${proxyThumbnail(item.thumbnail)}" alt="">` : '<div class="song-thumb"></div>'}
            <div class="song-info">
                <div class="song-title">${escapeHtml(item.title)}</div>
                <div class="song-meta">${escapeHtml(item.artist)}</div>
            </div>
            <span class="song-duration">${formatDuration(item.duration)}</span>
        `;
        list.appendChild(div);
    });

    // 分页控件
    const pagination = document.getElementById('result-pagination');
    pagination.classList.toggle('hidden', extractedItems.length <= resultPageSize);
    document.getElementById('result-page-info').textContent = `${resultPage + 1} / ${totalPages}`;
    document.getElementById('result-prev').disabled = resultPage === 0;
    document.getElementById('result-next').disabled = resultPage >= totalPages - 1;

    syncCheckAllState();
    syncCheckPageState(start, end);
    updateSelectedCount();
}

function syncCheckAllState() {
    document.getElementById('check-all').checked = selectedIndices.size === extractedItems.length && extractedItems.length > 0;
}

function syncCheckPageState(start, end) {
    let allChecked = end > start;
    for (let i = start; i < end; i++) {
        if (!selectedIndices.has(i)) { allChecked = false; break; }
    }
    document.getElementById('check-page').checked = allChecked;
}

function currentPageRange() {
    const start = resultPage * resultPageSize;
    const end = Math.min(start + resultPageSize, extractedItems.length);
    return [start, end];
}

// Check all（跨所有页面）
document.getElementById('check-all').addEventListener('change', (e) => {
    if (e.target.checked) {
        selectedIndices = new Set(extractedItems.map((_, i) => i));
    } else {
        selectedIndices.clear();
    }
    renderResultPage();
});

// Check page（仅当前页面）
document.getElementById('check-page').addEventListener('change', (e) => {
    const [start, end] = currentPageRange();
    for (let i = start; i < end; i++) {
        if (e.target.checked) selectedIndices.add(i);
        else selectedIndices.delete(i);
    }
    renderResultPage();
});

document.getElementById('result-list').addEventListener('change', (e) => {
    if (!e.target.classList.contains('song-check')) return;
    const idx = parseInt(e.target.dataset.index, 10);
    if (e.target.checked) selectedIndices.add(idx);
    else selectedIndices.delete(idx);
    const [start, end] = currentPageRange();
    syncCheckAllState();
    syncCheckPageState(start, end);
    updateSelectedCount();
});

document.getElementById('result-prev').addEventListener('click', () => {
    resultPage--;
    renderResultPage();
});

document.getElementById('result-next').addEventListener('click', () => {
    resultPage++;
    renderResultPage();
});

document.getElementById('result-page-size').addEventListener('change', (e) => {
    resultPageSize = parseInt(e.target.value, 10) || 30;
    resultPage = 0;
    renderResultPage();
});

function updateSelectedCount() {
    document.getElementById('selected-count').textContent = `已选 ${selectedIndices.size} 首`;
}

function getSelectedItems() {
    return Array.from(selectedIndices).sort((a, b) => a - b).map(i => extractedItems[i]);
}

// Import button
document.getElementById('btn-import').addEventListener('click', async () => {
    const items = getSelectedItems();
    if (items.length === 0) { showSnackbar('请至少选择一首歌曲'); return; }

    const mode = document.querySelector('input[name="import-mode"]:checked').value;
    const playlistName = document.getElementById('input-playlist-name').value.trim();
    const selectedPlaylistId = document.getElementById('select-playlist').value;
    const btn = document.getElementById('btn-import');
    btn.disabled = true;

    const endpoint = mode === 'import-download' ? '/api/import-download' : '/api/import';
    const body = {
        items,
        playlist_name: selectedPlaylistId ? undefined : (playlistName || undefined),
        playlist_id: selectedPlaylistId ? parseInt(selectedPlaylistId, 10) : undefined,
    };

    document.getElementById('import-progress').classList.remove('hidden');
    document.getElementById('import-status').textContent = '导入中...';

    try {
        const resp = await API.apiPost(endpoint, body);
        if (resp.error) throw new Error(resp.error);

        const playlistMsg = selectedPlaylistId ? '，已合并到歌单' : (resp.playlist_id ? '，已创建歌单' : '');
        const msg = `成功导入 ${resp.count} 首歌曲${playlistMsg}`;
        document.getElementById('import-status').textContent = msg;
        showSnackbar(msg);

        if (mode === 'import-download' && resp.download_started) {
            document.getElementById('import-status').textContent = msg + '，开始下载...';
            document.querySelector('.tab-item[data-tab="download"]').click();
            startDownloadPolling();
        }

        // Refresh playlist list and auto-select the target playlist
        await loadPlaylists();
        if (resp.playlist_id) {
            const sel = document.getElementById('select-playlist');
            sel.value = String(resp.playlist_id);
            sel.dispatchEvent(new Event('change'));
        }
    } catch (e) {
        document.getElementById('import-status').textContent = '导入失败: ' + e.message;
        showSnackbar('导入失败');
    } finally {
        btn.disabled = false;
    }
});

// ==================== Tab 2: Download Management ====================

async function loadRemoteSongs() {
    try {
        const resp = await API.apiGet('/api/download-batch/progress');
        if (resp.active) {
            lastProgress = resp;
            renderDownloadProgress(resp);
            if (!downloadPollTimer) startDownloadPolling();
        }
    } catch { /* ignore */ }

    // We can't filter by plugin_entry_path from bridge API songs.list,
    // so we use the download progress state to determine if there's an active download.
    // The remote song list would need a host API call.
    // For now, show a simple message.
    document.getElementById('remote-empty').classList.remove('hidden');
    document.getElementById('remote-list').classList.add('hidden');
    document.getElementById('remote-toolbar').classList.add('hidden');
}

document.getElementById('btn-refresh-remote').addEventListener('click', loadRemoteSongs);

document.getElementById('btn-download-batch').addEventListener('click', async () => {
    const checked = document.querySelectorAll('#remote-list .song-check:checked');
    const songIds = Array.from(checked).map(cb => parseInt(cb.dataset.songId));
    if (songIds.length === 0) { showSnackbar('请选择歌曲'); return; }

    try {
        await API.apiPost('/api/download-batch', { song_ids: songIds });
        startDownloadPolling();
    } catch (e) {
        showSnackbar('下载启动失败: ' + e.message);
    }
});

document.getElementById('btn-dl-clear').addEventListener('click', async () => {
    await API.apiPost('/api/download-batch/clear', {});
    document.getElementById('download-progress-card').classList.add('hidden');
    document.getElementById('btn-dl-clear').classList.add('hidden');
    lastProgress = null;
    dlPage = 0;
    stopDownloadPolling();
});

document.getElementById('btn-dl-pause').addEventListener('click', async () => {
    try {
        await API.apiPost('/api/download-batch/pause', {});
        document.getElementById('btn-dl-pause').classList.add('hidden');
        document.getElementById('btn-dl-resume').classList.remove('hidden');
    } catch (e) {
        showSnackbar('暂停失败: ' + e.message);
    }
});

document.getElementById('btn-dl-resume').addEventListener('click', async () => {
    try {
        await API.apiPost('/api/download-batch/resume', {});
        document.getElementById('btn-dl-resume').classList.add('hidden');
        document.getElementById('btn-dl-pause').classList.remove('hidden');
    } catch (e) {
        showSnackbar('恢复失败: ' + e.message);
    }
});

document.getElementById('btn-dl-retry').addEventListener('click', async () => {
    if (!lastProgress || !lastProgress.songs) return;
    const failedSongs = lastProgress.songs.filter(s => s.status === 'failed');
    if (failedSongs.length === 0) { showSnackbar('没有失败的歌曲'); return; }

    const songIds = failedSongs.map(s => s.song_id);
    const songTitles = {};
    failedSongs.forEach(s => { songTitles[s.song_id] = s.title; });

    try {
        await API.apiPost('/api/download-batch', {
            song_ids: songIds,
            playlist_name: lastProgress.playlist_name || undefined,
            song_titles: songTitles,
        });
        dlPage = 0;
        startDownloadPolling();
    } catch (e) {
        showSnackbar('重试失败: ' + e.message);
    }
});

document.getElementById('dl-prev').addEventListener('click', () => {
    dlPage--;
    if (lastProgress) renderDownloadSongList(lastProgress.songs || []);
});

document.getElementById('dl-next').addEventListener('click', () => {
    dlPage++;
    if (lastProgress) renderDownloadSongList(lastProgress.songs || []);
});

function startDownloadPolling() {
    stopDownloadPolling();
    document.getElementById('download-progress-card').classList.remove('hidden');
    downloadPollTimer = setInterval(pollDownloadProgress, 2000);
    pollDownloadProgress();
}

function stopDownloadPolling() {
    if (downloadPollTimer) {
        clearInterval(downloadPollTimer);
        downloadPollTimer = null;
    }
}

async function pollDownloadProgress() {
    try {
        const resp = await API.apiGet('/api/download-batch/progress');
        if (!resp.active) {
            stopDownloadPolling();
            document.getElementById('download-progress-card').classList.add('hidden');
            return;
        }
        lastProgress = resp;
        renderDownloadProgress(resp);
        if (resp.done) {
            stopDownloadPolling();
            document.getElementById('btn-dl-clear').classList.remove('hidden');
            showSnackbar(`下载完成: 成功 ${resp.success}, 失败 ${resp.failed}`);
        }
    } catch { /* ignore */ }
}

const STATUS_ICON = {
    pending: 'schedule',
    downloading: 'autorenew',
    ok: 'check_circle',
    failed: 'error',
};

function renderDownloadProgress(resp) {
    document.getElementById('download-progress-card').classList.remove('hidden');
    const pct = resp.total > 0 ? Math.round((resp.current / resp.total) * 100) : 0;
    document.getElementById('dl-progress-bar').style.width = pct + '%';
    document.getElementById('dl-current').textContent = resp.current;
    document.getElementById('dl-total').textContent = resp.total;
    document.getElementById('dl-success').textContent = resp.success || 0;
    document.getElementById('dl-failed').textContent = resp.failed || 0;

    // 状态徽标
    const badge = document.getElementById('dl-status-badge');
    badge.classList.remove('badge--paused', 'badge--done', 'badge--failed');
    if (resp.done) {
        badge.textContent = resp.failed > 0 ? '已完成（部分失败）' : '已完成';
        badge.classList.add(resp.failed > 0 ? 'badge--failed' : 'badge--done');
    } else if (resp.paused) {
        badge.textContent = '已暂停';
        badge.classList.add('badge--paused');
    } else {
        badge.textContent = '进行中';
    }

    // 暂停/恢复/重试/清除按钮
    const pauseBtn = document.getElementById('btn-dl-pause');
    const resumeBtn = document.getElementById('btn-dl-resume');
    const retryBtn = document.getElementById('btn-dl-retry');
    const clearBtn = document.getElementById('btn-dl-clear');

    if (resp.done) {
        pauseBtn.classList.add('hidden');
        resumeBtn.classList.add('hidden');
        clearBtn.classList.remove('hidden');
        retryBtn.classList.toggle('hidden', !(resp.failed > 0));
    } else {
        clearBtn.classList.add('hidden');
        retryBtn.classList.add('hidden');
        pauseBtn.classList.toggle('hidden', !!resp.paused);
        resumeBtn.classList.toggle('hidden', !resp.paused);
    }

    renderDownloadSongList(resp.songs || []);
}

function dlPageCount(songs) {
    return Math.max(1, Math.ceil(songs.length / DL_PAGE_SIZE));
}

function renderDownloadSongList(songs) {
    const totalPages = dlPageCount(songs);
    if (dlPage >= totalPages) dlPage = totalPages - 1;
    if (dlPage < 0) dlPage = 0;

    const start = dlPage * DL_PAGE_SIZE;
    const end = Math.min(start + DL_PAGE_SIZE, songs.length);
    const pageSongs = songs.slice(start, end);

    const list = document.getElementById('dl-song-list');
    list.innerHTML = '';

    pageSongs.forEach(song => {
        const div = document.createElement('div');
        div.className = 'song-item dl-song-item';
        const icon = STATUS_ICON[song.status] || 'schedule';
        div.innerHTML = `
            <span class="song-status-icon status-${song.status}">
                <span class="material-symbols-outlined">${icon}</span>
            </span>
            <div class="song-info">
                <div class="song-title">${escapeHtml(song.title)}</div>
                ${song.status === 'failed' ? `<div class="song-meta error-text">${escapeHtml(song.error || '下载失败')}</div>` : ''}
            </div>
        `;
        // title 属性用 DOM 赋值而非字符串插值，避免 error 消息含引号时破坏属性边界
        div.querySelector('.song-status-icon').title = song.error || '';
        list.appendChild(div);
    });

    const pagination = document.getElementById('dl-pagination');
    pagination.classList.toggle('hidden', songs.length <= DL_PAGE_SIZE);
    document.getElementById('dl-page-info').textContent = `${dlPage + 1} / ${totalPages}`;
    document.getElementById('dl-prev').disabled = dlPage === 0;
    document.getElementById('dl-next').disabled = dlPage >= totalPages - 1;
}

// ==================== Tab 3: Settings ====================

async function loadStatus() {
    try {
        const status = await API.apiGet('/api/status');
        const dot = document.getElementById('ytdlp-status-dot');
        const text = document.getElementById('ytdlp-status-text');

        if (status.installed) {
            dot.className = 'status-dot running';
            text.textContent = '已安装';
            document.getElementById('btn-install-text').textContent = '更新 yt-dlp';
        } else {
            dot.className = 'status-dot stopped';
            text.textContent = '未安装';
            document.getElementById('btn-install-text').textContent = '安装 yt-dlp';
        }

        document.getElementById('ytdlp-version').textContent = status.version || '-';
        document.getElementById('ytdlp-platform').textContent = status.platform || '-';
    } catch (e) {
        document.getElementById('ytdlp-status-text').textContent = '检查失败';
    }

    try {
        const settings = await API.apiGet('/api/settings');
        document.getElementById('setting-proxy').value = settings.proxy || '';
        setSearchPlatformUI(settings.search_platform || 'ytsearch');
        document.getElementById('setting-quality').value = settings.audio_quality || 'bestaudio';
        document.getElementById('setting-cookies-browser').value = settings.cookies_browser || '';
        document.getElementById('setting-path-template').value = settings.path_template || 'ytdlp/{artist}/{title}';
        document.getElementById('setting-embed-metadata').checked = settings.embed_metadata !== false;
        document.getElementById('setting-transcode-format').value = settings.transcode_format || '';
        document.getElementById('setting-transcode-bitrate').value = String(settings.transcode_bitrate != null ? settings.transcode_bitrate : 0);
        document.getElementById('setting-download-interval').value = settings.download_interval ?? 3;
        document.getElementById('setting-pause-on-error').checked = settings.pause_on_error !== false;
        if (settings.github_proxy) {
            document.getElementById('github-proxy-select').value = settings.github_proxy;
        }
        syncBitrateEnabled();
    } catch { /* use defaults */ }
}

document.getElementById('btn-install').addEventListener('click', async () => {
    const btn = document.getElementById('btn-install');
    btn.disabled = true;
    document.getElementById('install-progress').classList.remove('hidden');

    // Save github proxy first
    const proxy = document.getElementById('github-proxy-select').value;
    await API.apiPost('/api/settings', { github_proxy: proxy });

    try {
        // 下载任务可能超过 30s（后端 ExecuteJS 上限），后端采用
        // fire-and-forget 模式：/api/install 立即返回，这里轮询 status。
        const startResp = await API.apiPost('/api/install', {});
        if (startResp.error) throw new Error(startResp.error);

        const result = await pollInstallStatus();
        if (result.status === 'error') {
            throw new Error(result.error || '安装失败');
        }
        showSnackbar('安装成功' + (result.version ? ': ' + result.version : ''));
        loadStatus();
    } catch (e) {
        showSnackbar('安装失败: ' + e.message);
    } finally {
        btn.disabled = false;
        document.getElementById('install-progress').classList.add('hidden');
    }
});

// 轮询安装状态直到 done/error/idle。最多等 10 分钟（够应付慢网络下 100MB以内下载）。
async function pollInstallStatus(maxMs = 10 * 60 * 1000, intervalMs = 2000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const s = await API.apiGet('/api/install/status');
            if (s.status === 'done' || s.status === 'error') return s;
            // running / idle 继续等
        } catch (e) {
            // 单次轮询失败不中断，下轮重试
        }
    }
    throw new Error('安装超时（轮询中断）');
}

function collectSettings() {
    return {
        proxy: document.getElementById('setting-proxy').value,
        search_platform: getSearchPlatformValue(),
        audio_quality: document.getElementById('setting-quality').value,
        cookies_browser: document.getElementById('setting-cookies-browser').value,
        path_template: document.getElementById('setting-path-template').value,
        embed_metadata: document.getElementById('setting-embed-metadata').checked,
        transcode_format: document.getElementById('setting-transcode-format').value,
        transcode_bitrate: parseInt(document.getElementById('setting-transcode-bitrate').value, 10) || 0,
        download_interval: parseInt(document.getElementById('setting-download-interval').value) || 3,
        pause_on_error: document.getElementById('setting-pause-on-error').checked,
        github_proxy: document.getElementById('github-proxy-select').value,
    };
}

// 未选择转码格式时禁用码率下拉
function syncBitrateEnabled() {
    document.getElementById('setting-transcode-bitrate').disabled = !document.getElementById('setting-transcode-format').value;
}

let saveTimer = null;
function autoSave(immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    const delay = immediate ? 0 : 600;
    saveTimer = setTimeout(async () => {
        try {
            await API.apiPost('/api/settings', collectSettings());
            showSnackbar('设置已保存');
        } catch (e) {
            showSnackbar('保存失败: ' + e.message);
        }
    }, delay);
}

// select / checkbox 立即保存，文本输入防抖保存
document.querySelectorAll('#tab-settings select').forEach(el => {
    el.addEventListener('change', () => autoSave(true));
});
document.querySelectorAll('#tab-settings input[type="checkbox"]').forEach(el => {
    el.addEventListener('change', () => autoSave(true));
});
document.querySelectorAll('#tab-settings input[type="text"], #tab-settings input[type="number"]').forEach(el => {
    if (el.id === 'search-test-input') return;
    el.addEventListener('input', () => autoSave(false));
});
// 转码格式变化时联动禁用/启用码率下拉
document.getElementById('setting-transcode-format').addEventListener('change', syncBitrateEnabled);

// --- Search test ---

document.getElementById('search-test-btn').addEventListener('click', async () => {
    const input = document.getElementById('search-test-input');
    const result = document.getElementById('search-test-result');
    const btn = document.getElementById('search-test-btn');
    const keyword = input.value.trim();

    if (!keyword) {
        result.style.display = 'block';
        result.style.color = 'var(--md-error)';
        result.textContent = '请输入搜索关键字';
        return;
    }

    btn.disabled = true;
    result.style.display = 'block';
    result.style.color = 'var(--md-on-surface-variant)';
    result.textContent = '搜索中（可能需要较长时间）...';

    try {
        const resp = await API.apiPost('/api/search/topone', { keyword, quality: '320k' });
        if (resp.code === 0 && resp.data) {
            const d = resp.data;
            result.style.color = 'var(--md-primary)';
            const link = document.createElement('a');
            link.href = d.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = d.url;
            link.style.cssText = 'color:inherit;word-break:break-all';
            result.textContent = `✅ 搜索成功\n\n标题: ${d.title}\n歌手: ${d.artist}\n专辑: ${d.album || '-'}\n时长: ${formatDuration(d.duration)}\nURL: `;
            result.appendChild(link);
        } else {
            result.style.color = 'var(--md-error)';
            result.textContent = `❌ 未找到结果\n\n${JSON.stringify(resp, null, 2)}`;
        }
    } catch (e) {
        result.style.color = 'var(--md-error)';
        result.textContent = '请求失败: ' + e.message;
    } finally {
        btn.disabled = false;
    }
});

// --- Search platform helpers ---

const searchPlatformSelect = document.getElementById('setting-search-platform');
const searchPlatformCustom = document.getElementById('setting-search-platform-custom');

searchPlatformSelect.addEventListener('change', () => {
    searchPlatformCustom.classList.toggle('hidden', searchPlatformSelect.value !== '__custom__');
});

function setSearchPlatformUI(value) {
    const option = searchPlatformSelect.querySelector(`option[value="${value}"]`);
    if (option && value !== '__custom__') {
        searchPlatformSelect.value = value;
        searchPlatformCustom.classList.add('hidden');
    } else {
        searchPlatformSelect.value = '__custom__';
        searchPlatformCustom.value = value;
        searchPlatformCustom.classList.remove('hidden');
    }
}

function getSearchPlatformValue() {
    if (searchPlatformSelect.value === '__custom__') {
        return searchPlatformCustom.value.trim() || 'ytsearch';
    }
    return searchPlatformSelect.value;
}

// ==================== Cookies upload ====================

async function checkCookiesStatus() {
    try {
        const resp = await API.apiGet('/api/cookies/status');
        const statusEl = document.getElementById('cookies-file-status');
        const deleteBtn = document.getElementById('btn-cookies-delete');
        if (resp.exists) {
            const sz = resp.size > 1024 ? (resp.size / 1024).toFixed(1) + ' KB' : resp.size + ' B';
            statusEl.textContent = '已上传 (' + sz + ')';
            statusEl.style.color = 'var(--md-primary)';
            deleteBtn.classList.remove('hidden');
        } else {
            statusEl.textContent = '未上传';
            statusEl.style.color = '';
            deleteBtn.classList.add('hidden');
        }
    } catch {
        document.getElementById('cookies-file-status').textContent = '检查失败';
    }
}

document.getElementById('btn-cookies-upload').addEventListener('click', () => {
    document.getElementById('setting-cookies-upload').click();
});

document.getElementById('setting-cookies-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const btn = document.getElementById('btn-cookies-upload');
    btn.disabled = true;
    const statusEl = document.getElementById('cookies-file-status');
    statusEl.textContent = '上传中...';

    try {
        const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.readAsText(file);
        });

        const resp = await API.apiPost('/api/cookies/upload', { content });
        if (resp.error) throw new Error(resp.error);

        showSnackbar('cookies.txt 上传成功');
        await checkCookiesStatus();
    } catch (e) {
        statusEl.textContent = '上传失败';
        showSnackbar('上传失败: ' + e.message);
    } finally {
        btn.disabled = false;
        e.target.value = '';
    }
});

document.getElementById('btn-cookies-delete').addEventListener('click', async () => {
    if (!confirm('确定删除 cookies.txt？')) return;
    const btn = document.getElementById('btn-cookies-delete');
    btn.disabled = true;
    try {
        const resp = await API.apiPost('/api/cookies/delete', {});
        if (resp.error) throw new Error(resp.error);
        showSnackbar('cookies.txt 已删除');
        await checkCookiesStatus();
    } catch (e) {
        showSnackbar('删除失败: ' + e.message);
    } finally {
        btn.disabled = false;
    }
});

// ==================== Binary manual download/upload ====================

document.getElementById('btn-show-download-url').addEventListener('click', async () => {
    const btn = document.getElementById('btn-show-download-url');
    btn.disabled = true;
    try {
        const info = await API.apiGet('/api/binary/info');
        const urlDiv = document.getElementById('binary-download-url');
        const link = document.getElementById('binary-url-link');
        if (info.downloadUrl) {
            link.href = info.downloadUrl;
            link.textContent = info.downloadUrl;
            urlDiv.classList.remove('hidden');
        } else {
            showSnackbar('无法获取下载链接');
        }
    } catch (e) {
        showSnackbar('获取下载链接失败: ' + e.message);
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('btn-copy-url').addEventListener('click', () => {
    const link = document.getElementById('binary-url-link');
    const url = link.textContent;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => showSnackbar('链接已复制'));
    } else {
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showSnackbar('链接已复制');
    }
});

document.getElementById('btn-binary-upload').addEventListener('click', () => {
    document.getElementById('binary-upload-input').click();
});

document.getElementById('binary-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const btn = document.getElementById('btn-binary-upload');
    const statusEl = document.getElementById('binary-upload-status');
    btn.disabled = true;
    statusEl.style.color = 'var(--md-on-surface-variant)';
    statusEl.classList.remove('hidden');

    // 分片上传：每片 512KB 原始数据（base64 后约 680KB），避免大文件 OOM
    const CHUNK_RAW_SIZE = 512 * 1024;

    try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const totalChunks = Math.ceil(bytes.length / CHUNK_RAW_SIZE);

        statusEl.textContent = `准备上传 (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${totalChunks} 片)...`;

        // 1. 通知后端开始
        const startResp = await API.apiPost('/api/binary/upload/start', { total_chunks: totalChunks });
        if (startResp.error) throw new Error(startResp.error);

        // 2. 逐片上传（顺序发送，后端直接追加写入文件）
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_RAW_SIZE;
            const end = Math.min(start + CHUNK_RAW_SIZE, bytes.length);
            const slice = bytes.slice(start, end);

            let binary = '';
            const encChunk = 8192;
            for (let j = 0; j < slice.length; j += encChunk) {
                binary += String.fromCharCode(...slice.slice(j, j + encChunk));
            }
            const base64 = btoa(binary);

            statusEl.textContent = `上传中 ${i + 1}/${totalChunks}...`;
            const chunkResp = await API.apiPost('/api/binary/upload/chunk', { data: base64 });
            if (chunkResp.error) throw new Error(chunkResp.error);
        }

        // 3. 通知后端完成组装
        statusEl.textContent = '正在写入文件...';
        const finalResp = await API.apiPost('/api/binary/upload/finalize', {});
        if (finalResp.error) throw new Error(finalResp.error);

        statusEl.style.color = 'var(--md-primary)';
        statusEl.textContent = '上传成功' + (finalResp.version ? ': ' + finalResp.version : '');
        showSnackbar('yt-dlp 上传成功');
        loadStatus();
    } catch (err) {
        statusEl.style.color = 'var(--md-error)';
        statusEl.textContent = '上传失败: ' + err.message;
        showSnackbar('上传失败: ' + err.message);
    } finally {
        btn.disabled = false;
        e.target.value = '';
    }
});

// ==================== Playlist selector ====================

let cachedPlaylists = [];

async function loadPlaylists() {
    try {
        const playlists = await API.apiGet('/api/playlists');
        cachedPlaylists = Array.isArray(playlists) ? playlists : [];
        const sel = document.getElementById('select-playlist');
        // Keep the first "新建歌单" option
        sel.innerHTML = '<option value="">新建歌单</option>';
        cachedPlaylists.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name}（${p.song_count} 首）`;
            sel.appendChild(opt);
        });
    } catch { /* ignore */ }
}

document.getElementById('select-playlist').addEventListener('change', () => {
    const sel = document.getElementById('select-playlist');
    const newRow = document.getElementById('new-playlist-row');
    newRow.classList.toggle('hidden', sel.value !== '');
});

// --- Init ---
loadStatus();
checkCookiesStatus();
loadPlaylists();
