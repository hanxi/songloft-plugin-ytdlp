// yt-dlp 插件前端逻辑

import './logs.js';

const API = window.SongloftPlugin || { apiGet: (p) => fetch(p).then(r => r.json()), apiPost: (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()), getAuthToken: () => '' };

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

function proxyThumbnail(url) {
    if (!url) return '';
    const token = API.getAuthToken();
    if (!token) return url;
    return '/api/v1/proxy?url=' + encodeURIComponent(url) + '&access_token=' + encodeURIComponent(token);
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
        const resp = await API.apiPost('/api/extract', { url });
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

    document.getElementById('result-count').textContent = items.length;
    const list = document.getElementById('result-list');
    list.innerHTML = '';

    items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `
            <input type="checkbox" class="song-check" data-index="${i}" checked>
            ${item.thumbnail ? `<img class="song-thumb" src="${proxyThumbnail(item.thumbnail)}" alt="">` : '<div class="song-thumb"></div>'}
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
        setSearchPlatformUI(settings.search_platform || 'ytsearch');
        document.getElementById('setting-quality').value = settings.audio_quality || 'bestaudio';
        document.getElementById('setting-cookies-browser').value = settings.cookies_browser || '';
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
        download_interval: parseInt(document.getElementById('setting-download-interval').value) || 3,
        github_proxy: document.getElementById('github-proxy-select').value,
    };
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

// --- Init ---
loadStatus();
checkCookiesStatus();
