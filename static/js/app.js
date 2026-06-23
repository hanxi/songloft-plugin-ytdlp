// yt-dlp 插件前端逻辑

const API = window.SongloftPlugin || { apiGet: (p) => fetch(p).then(r => r.json()), apiPost: (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()) };

// --- State ---
let extractedItems = [];
let downloadPollTimer = null;

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

// ==================== Tab 1: Import ====================

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
        const resp = await API.apiPost('/api/extract', { url });
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

function renderExtractResult(resp) {
    const items = resp.items || [];
    if (items.length === 0) {
        showSnackbar('未提取到任何歌曲');
        return;
    }

    document.getElementById('result-count').textContent = items.length;
    const list = document.getElementById('result-list');
    list.innerHTML = '';

    items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `
            <input type="checkbox" class="song-check" data-index="${i}" checked>
            ${item.thumbnail ? `<img class="song-thumb" src="${item.thumbnail}" alt="">` : '<div class="song-thumb"></div>'}
            <div class="song-info">
                <div class="song-title">${escapeHtml(item.title)}</div>
                <div class="song-meta">${escapeHtml(item.artist)}</div>
            </div>
            <span class="song-duration">${formatDuration(item.duration)}</span>
        `;
        list.appendChild(div);
    });

    document.getElementById('result-card').classList.remove('hidden');
    document.getElementById('import-card').classList.remove('hidden');
    document.getElementById('check-all').checked = true;
    updateSelectedCount();

    if (resp.playlist_title) {
        document.getElementById('input-playlist-name').value = resp.playlist_title;
    }
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// Check all / uncheck all
document.getElementById('check-all').addEventListener('change', (e) => {
    document.querySelectorAll('.song-check').forEach(cb => { cb.checked = e.target.checked; });
    updateSelectedCount();
});

document.getElementById('result-list').addEventListener('change', (e) => {
    if (e.target.classList.contains('song-check')) updateSelectedCount();
});

function updateSelectedCount() {
    const checked = document.querySelectorAll('.song-check:checked').length;
    document.getElementById('selected-count').textContent = `已选 ${checked} 首`;
}

function getSelectedItems() {
    const indices = [];
    document.querySelectorAll('.song-check:checked').forEach(cb => {
        indices.push(parseInt(cb.dataset.index));
    });
    return indices.map(i => extractedItems[i]);
}

// Import button
document.getElementById('btn-import').addEventListener('click', async () => {
    const items = getSelectedItems();
    if (items.length === 0) { showSnackbar('请至少选择一首歌曲'); return; }

    const mode = document.querySelector('input[name="import-mode"]:checked').value;
    const playlistName = document.getElementById('input-playlist-name').value.trim();
    const btn = document.getElementById('btn-import');
    btn.disabled = true;

    const endpoint = mode === 'import-download' ? '/api/import-download' : '/api/import';
    const body = { items, playlist_name: playlistName || undefined };

    document.getElementById('import-progress').classList.remove('hidden');
    document.getElementById('import-status').textContent = '导入中...';

    try {
        const resp = await API.apiPost(endpoint, body);
        if (resp.error) throw new Error(resp.error);

        const msg = `成功导入 ${resp.count} 首歌曲` + (resp.playlist_id ? '，已创建歌单' : '');
        document.getElementById('import-status').textContent = msg;
        showSnackbar(msg);

        if (mode === 'import-download' && resp.download_started) {
            document.getElementById('import-status').textContent = msg + '，开始下载...';
            startDownloadPolling();
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
            renderDownloadProgress(resp);
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
    stopDownloadPolling();
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
        renderDownloadProgress(resp);
        if (resp.done) {
            stopDownloadPolling();
            document.getElementById('btn-dl-clear').classList.remove('hidden');
            showSnackbar(`下载完成: 成功 ${resp.success}, 失败 ${resp.failed}`);
        }
    } catch { /* ignore */ }
}

function renderDownloadProgress(resp) {
    document.getElementById('download-progress-card').classList.remove('hidden');
    const pct = resp.total > 0 ? Math.round((resp.current / resp.total) * 100) : 0;
    document.getElementById('dl-progress-bar').style.width = pct + '%';
    document.getElementById('dl-current').textContent = resp.current;
    document.getElementById('dl-total').textContent = resp.total;
    document.getElementById('dl-success').textContent = resp.success || 0;
    document.getElementById('dl-failed').textContent = resp.failed || 0;
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
        document.getElementById('setting-quality').value = settings.audio_quality || 'bestaudio';
        document.getElementById('setting-cookies-browser').value = settings.cookies_browser || '';
        document.getElementById('setting-cookies-file').value = settings.cookies_file || '';
        document.getElementById('setting-path-template').value = settings.path_template || 'ytdlp/{artist}/{title}';
        document.getElementById('setting-embed-metadata').checked = settings.embed_metadata !== false;
        document.getElementById('setting-download-interval').value = settings.download_interval ?? 3;
        if (settings.github_proxy) {
            document.getElementById('github-proxy-select').value = settings.github_proxy;
        }
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
        const resp = await API.apiPost('/api/install', {});
        if (resp.error) throw new Error(resp.error);
        showSnackbar('安装成功: ' + (resp.version || ''));
        loadStatus();
    } catch (e) {
        showSnackbar('安装失败: ' + e.message);
    } finally {
        btn.disabled = false;
        document.getElementById('install-progress').classList.add('hidden');
    }
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const settings = {
        proxy: document.getElementById('setting-proxy').value,
        audio_quality: document.getElementById('setting-quality').value,
        cookies_browser: document.getElementById('setting-cookies-browser').value,
        cookies_file: document.getElementById('setting-cookies-file').value,
        path_template: document.getElementById('setting-path-template').value,
        embed_metadata: document.getElementById('setting-embed-metadata').checked,
        download_interval: parseInt(document.getElementById('setting-download-interval').value) || 3,
        github_proxy: document.getElementById('github-proxy-select').value,
    };

    try {
        await API.apiPost('/api/settings', settings);
        showSnackbar('设置已保存');
    } catch (e) {
        showSnackbar('保存失败: ' + e.message);
    }
});

// --- Init ---
loadStatus();
