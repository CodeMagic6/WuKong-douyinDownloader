// State
let items = {};
let settings = {};
let statusInfo = {};
let clipboardCaptureEnabled = false;
let autoDownloadEnabled = false;
let loginModalOpen = false;
let lastSSEEventTime = Date.now(); // for stale connection detection

// DOM refs
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Init
document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchQueue();
  fetchSettings();
  connectSSE();
  startSSEWatchdog(); // proactive reconnect on stale connection
  setupEnterKey();
  setupSaveModeToggle();
  setupClipboardToggles();
  setupLoginClick();
  startHealthCheck();
});

function setupSaveModeToggle() {
  const saveToggle = $('#setting-save-mode');
  if (saveToggle) {
    saveToggle.addEventListener('change', function() {
      settings.saveMode = this.checked ? 'manual' : 'auto';
      saveSettings();
    });
  }
}
function setupClipboardToggles() {
  const captureToggle = $('#setting-clipboard-capture');
  const autoDlToggle = $('#setting-auto-download');
  if (captureToggle) {
    captureToggle.addEventListener('change', function() {
      clipboardCaptureEnabled = this.checked;
      if (!clipboardCaptureEnabled && autoDlToggle) autoDlToggle.checked = false;
      saveSettings();
    });
  }
  if (autoDlToggle) {
    autoDlToggle.addEventListener('change', function() {
      autoDownloadEnabled = this.checked;
      saveSettings();
    });
  }
}

function handleCapturedLink(url) {
  const cleanUrl = url.replace(/[,.!?;:)\]}>"'$]+$/, '').replace(/^["'(<]+/, '');
  const textarea = $('#url-input');
  if (textarea) {
    textarea.value = cleanUrl;
    textarea.style.borderColor = '#2ea043';
    setTimeout(() => textarea.style.borderColor = '', 2000);
  }
  if (autoDownloadEnabled) {
    setTimeout(() => addUrls(), 300);
  }
}
let _es = null;
function connectSSE() {
  if (_es) {
    _es.close();
    _es = null;
  }

  _es = new EventSource('/api/progress');

  // Wrap addEventListener to track last event time for all SSE events
  // Used by SSE watchdog to detect stale connections
  const _origAdd = _es.addEventListener.bind(_es);
  _es.addEventListener = function(type, handler) {
    _origAdd(type, function(e) {
      lastSSEEventTime = Date.now();
      handler(e);
    });
  };

  _es.addEventListener('queue_update', (e) => {
    const data = JSON.parse(e.data);
    items = {};
    for (const item of data.items) {
      items[item.id] = item;
    }
    renderQueue();
  });

  _es.addEventListener('collection_progress', (e) => {
    const data = JSON.parse(e.data);
    if (items[data.id]) {
      items[data.id].collectionFound = data.found;
      items[data.id].progress = Math.min(95, (data.attempt / 40) * 100);
      items[data.id].collectionAttempt = data.attempt;
      updateItemProgress(data.id);
      // Update count text
      const el = document.querySelector(`.queue-item[data-id="${data.id}"]`);
      if (el) {
        const infoEl = el.querySelector('.item-title');
        if (infoEl) infoEl.textContent = `📋 ${data.label}: 已找到 ${data.found} 个视频...`;
      }
    }
  });

  _es.addEventListener('collection_complete', (e) => {
    const data = JSON.parse(e.data);
    // Remove the placeholder item from UI
    delete items[data.id];
    renderQueue();
  });

  _es.addEventListener('download_progress', (e) => {
    const data = JSON.parse(e.data);
    if (items[data.id]) {
      Object.assign(items[data.id], data);
      updateItemProgress(data.id);
    }
  });

  _es.addEventListener('download_complete', (e) => {
    const data = JSON.parse(e.data);
    if (items[data.id]) {
      items[data.id].status = 'completed';
      items[data.id].progress = 100;
      renderQueue();
      // Manual mode: auto-trigger browser Save As dialog
      if (settings.saveMode === 'manual') {
        downloadFile(data.id);
      }
    }
  });

  _es.addEventListener('download_error', (e) => {
    const data = JSON.parse(e.data);
    if (items[data.id]) {
      items[data.id].status = 'error';
      items[data.id].error = data.error;
      renderQueue();
    }
  });

  _es.addEventListener('download_cancelled', (e) => {
    const data = JSON.parse(e.data);
    if (items[data.id]) {
      items[data.id].status = 'cancelled';
      renderQueue();
    }
  });

  _es.addEventListener('status_update', (e) => {
    const data = JSON.parse(e.data);
    Object.assign(statusInfo, data);
    updateStatusBar();
  });

  _es.addEventListener('login_progress', (e) => {
    const data = JSON.parse(e.data);
    handleLoginProgress(data);
  });

  _es.addEventListener('settings_updated', (e) => {
    const data = JSON.parse(e.data);
    Object.assign(settings, data);
    updateSettingsForm();
    renderQueue(); // Re-render to update buttons based on save mode
  });

  _es.addEventListener('clipboard_captured', (e) => {
    const data = JSON.parse(e.data);
    if (data.url) handleCapturedLink(data.url);
  });

  _es.onerror = () => {
    // Increment health fail on SSE error — server might be paused
    healthFailCount++;
    lastSSEEventTime = Date.now(); // mark "event" so watchdog doesn't kill good connection
  };

  _es.onopen = () => {
    // SSE connected = server alive, reset health counter
    healthFailCount = 0;
    lastSSEEventTime = Date.now();
    if (!serverOnline) {
      serverOnline = true;
      updateStatusBar();
      hideDisconnectBanner();
      fetchQueue();
      fetchStatus();
      fetchSettings();
    }
  };
}

// ---------- Status Bar ----------
function updateStatusBar() {
  const browser = $('#status-browser');
  const cookie = $('#status-cookie');
  const queue = $('#status-queue');
  const today = $('#status-today');

  browser.innerHTML = `浏览器: ${statusInfo.browserReady
    ? '<span class="badge badge-ok">已就绪</span>'
    : '<span class="badge badge-fail">未连接</span>'}`;

  cookie.innerHTML = `登录: ${statusInfo.cookieValid
    ? '<span class="badge badge-ok">已登录</span>'
    : '<span class="badge badge-warn">未登录 → 扫码登录</span>'}`;

  queue.textContent = `队列: ${statusInfo.queueLength || 0}`;
  today.textContent = `今日: ${statusInfo.downloadsToday || 0}`;
  // Server health indicator
  const health = $('#status-health');
  health.innerHTML = serverOnline
    ? '<span class="badge badge-ok">已连接</span>'
    : '<span class="badge badge-fail">服务器断开</span>';
}

// ---------- Queue ----------
function renderQueue() {
  const list = $('#queue-list');
  const itemArray = Object.values(items);

  if (itemArray.length === 0) {
    list.innerHTML = '<div class="empty-queue">暂无下载任务，在上方粘贴链接开始下载</div>';
    $('#queue-count').textContent = '0 项';
    return;
  }

  // Sort: newest first
  itemArray.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  let html = '';
  for (const item of itemArray) {
    html += renderItem(item);
  }
  list.innerHTML = html;

  // Update count
  const total = itemArray.length;
  const done = itemArray.filter(i => i.status === 'completed').length;
  const err = itemArray.filter(i => i.status === 'error').length;
  $('#queue-count').textContent = `${total} 项 (${done} 完成, ${err} 错误)`;
}

function renderItem(item) {
  const statusTexts = {
    pending: '等待中',
    extracting: '解析中...',
    downloading: '下载中...',
    completed: '已完成',
    error: '失败',
    cancelled: '已取消'
  };

  const isCollection = item.isCollection;
  const author = item.metadata?.author?.nickname || '';
  const desc = isCollection
    ? `📋 ${item.collectionLabel || '合集'}: ${item.collectionFound || 0} 个视频`
    : (item.metadata?.desc || item.url);
  const trimmedDesc = desc.length > 80 ? desc.substring(0, 80) + '...' : desc;

  const isComplete = item.status === 'completed';
  const isError = item.status === 'error';
  const isDownloading = item.status === 'downloading';
  const isExtracting = item.status === 'extracting';
  const isCancelled = item.status === 'cancelled';

  const progressBarClass = isComplete ? 'progress-fill complete' : 'progress-fill';
  const progressWidth = Math.min(100, Math.max(0, item.progress || 0));

  const itemClass = isCollection ? 'extracting collection' : item.status;

  let progressHtml = '';
  if (isCollection) {
    const pct = Math.round(item.progress || 0);
    progressHtml = `
      <div class="progress-container">
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="progress-text">正在扫描: 已发现 ${item.collectionFound || 0} 个视频</span>
      </div>`;
  } else if (isDownloading) {
    const speed = item.speedBytesPerSec
      ? (item.speedBytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s'
      : '--';
    const eta = item.etaSec
      ? Math.round(item.etaSec) + 's'
      : '--';
    const done = item.bytesTotal
      ? (item.bytesDone / 1024 / 1024).toFixed(1) + ' / ' + (item.bytesTotal / 1024 / 1024).toFixed(1) + ' MB'
      : (item.bytesDone / 1024 / 1024).toFixed(1) + ' MB';
    progressHtml = `
      <div class="progress-container">
        <div class="progress-bar">
          <div class="${progressBarClass}" style="width:${progressWidth}%"></div>
        </div>
        <span class="progress-text">${speed} | ETA ${eta}</span>
      </div>
      <div class="progress-container" style="margin-top:4px">
        <span class="progress-text">${done} | ${Math.round(progressWidth)}%</span>
      </div>`;
  } else if (isComplete) {
    const size = item.bytesTotal
      ? (item.bytesTotal / 1024 / 1024).toFixed(1) + ' MB'
      : '--';
    progressHtml = `
      <div class="progress-container">
        <div class="progress-bar">
          <div class="${progressBarClass}" style="width:100%"></div>
        </div>
        <span class="progress-text">${size} | 100%</span>
      </div>`;
  } else if (isExtracting) {
    progressHtml = `<span class="item-status-text status-extracting">⏳ 正在解析视频信息...</span>`;
  } else if (isError) {
    progressHtml = `<div class="error-msg">❌ ${item.error || '下载失败'}</div>`;
  } else if (isCancelled) {
    progressHtml = `<span class="item-status-text status-cancelled">已取消</span>`;
  } else if (item.status === 'pending') {
    progressHtml = `<span class="item-status-text status-pending">⏳ 等待处理...</span>`;
  }

  // Actions
  let actionsHtml = '';
  if (isDownloading || isExtracting) {
    actionsHtml = `
      <button class="btn-icon cancel" onclick="cancelItem('${item.id}')">取消</button>
      <button class="btn-icon" onclick="removeItem('${item.id}')">删除</button>`;
  }
  if (isComplete) {
    if (settings.saveMode === 'manual') {
      actionsHtml = `
        <button class="btn-icon download-btn" onclick="downloadFile('${item.id}')">保存</button>
        <button class="btn-icon" onclick="removeItem('${item.id}')">删除</button>`;
    } else {
      actionsHtml = `
        <span class="item-status-text status-completed" style="margin-right:8px">已保存到目录</span>
        <button class="btn-icon" onclick="removeItem('${item.id}')">删除</button>`;
    }
  }
  if (isError || isCancelled) {
    actionsHtml = `
      <button class="btn-icon" onclick="retryItem('${item.id}')">重试</button>
      <button class="btn-icon" onclick="removeItem('${item.id}')">删除</button>`;
  }

  return `
    <div class="queue-item ${itemClass || item.status}" data-id="${item.id}">
      <div class="item-header">
        <div class="item-info">
          <div class="item-title" title="${escapeHtml(desc)}">${escapeHtml(trimmedDesc)}</div>
          ${author ? `<div class="item-author">${escapeHtml(author)}</div>` : ''}
          <div class="item-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
        </div>
        <div class="item-actions">${actionsHtml}</div>
      </div>
      ${progressHtml}
    </div>`;
}

function updateItemProgress(id) {
  const el = document.querySelector(`.queue-item[data-id="${id}"]`);
  if (!el) return;
  const item = items[id];
  if (!item || !['downloading', 'extracting'].includes(item.status)) return;

  // Update progress bar and text in-place
  const fill = el.querySelector('.progress-fill');
  if (fill) {
    const pct = Math.min(100, Math.max(0, item.progress || 0));
    fill.style.width = pct + '%';
  }

  const container = el.querySelector('.progress-container');
  if (container && item.status === 'downloading') {
    const speed = item.speedBytesPerSec
      ? (item.speedBytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s'
      : '--';
    const eta = item.etaSec ? Math.round(item.etaSec) + 's' : '--';
    const done = item.bytesTotal
      ? (item.bytesDone / 1024 / 1024).toFixed(1) + ' / ' + (item.bytesTotal / 1024 / 1024).toFixed(1) + ' MB'
      : (item.bytesDone / 1024 / 1024).toFixed(1) + ' MB';

    const textSpan = container.querySelector('.progress-text');
    if (textSpan) textSpan.textContent = `${speed} | ETA ${eta}`;

    const secondContainer = el.querySelectorAll('.progress-container')[1];
    if (secondContainer) {
      const sizeSpan = secondContainer.querySelector('.progress-text');
      if (sizeSpan) sizeSpan.textContent = `${done} | ${Math.round(item.progress || 0)}%`;
    }
  }
}

// ---------- Actions ----------
function addUrls() {
  const input = $('#url-input');
  const raw = input.value.trim();
  if (!raw) return;

  const urls = raw.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && (l.includes('douyin.com') || l.includes('v.douyin.com') || l.includes('bilibili.com') || l.includes('b23.tv')));

  if (urls.length === 0) {
    alert('请粘贴有效的抖音链接');
    return;
  }

  $('#btn-add').disabled = true;
  $('#btn-add').textContent = '添加中...';

  fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls })
  })
  .then(r => r.json())
  .then(data => {
    input.value = '';
    $('#btn-add').disabled = false;
    $('#btn-add').textContent = '添加下载';
    if (data.error) alert(data.error);
  })
  .catch(e => {
    $('#btn-add').disabled = false;
    $('#btn-add').textContent = '添加下载';
    const msg = !serverOnline
      ? '服务器连接已断开 (请重启程序)'
      : `网络错误: ${e.message} (服务是否在运行?)`;
    alert('添加失败: ' + msg);
  });
}

function cancelItem(id) {
  fetch(`/api/queue/${id}`, { method: 'DELETE' })
    .then(r => r.json())
    .catch(e => console.error('取消失败:', e));
}

function removeItem(id) {
  if (!serverOnline) { alert('服务器已断开，请重启程序'); return; }
  fetch(`/api/queue/${id}/remove`, { method: 'DELETE' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .catch(e => { if (serverOnline) alert('删除失败: ' + e.message); });
}

function retryItem(id) {
  const item = items[id];
  if (!item) return;
  if (!serverOnline) { alert('服务器已断开，请重启程序'); return; }
  fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [item.url] })
  }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .catch(e => { if (serverOnline) alert('重试失败: ' + e.message); });
}

function clearCompleted() {
  fetch('/api/queue/clear-completed', { method: 'POST' })
    .then(r => r.json())
    .catch(e => console.error('清除失败:', e));
}

function clearAll() {
  for (const id of Object.keys(items)) {
    const item = items[id];
    if (['completed', 'error', 'cancelled'].includes(item.status)) {
      fetch(`/api/queue/${id}/remove`, { method: 'DELETE' }).catch(() => {});
    } else if (['pending', 'downloading', 'extracting'].includes(item.status)) {
      fetch(`/api/queue/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

function downloadFile(id) {
  // Use anchor click for reliable Save As dialog trigger
  const a = document.createElement('a');
  a.href = `/api/file/${id}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---------- Settings ----------
function toggleSettings() {
  const panel = $('#settings-panel');
  const arrow = $('#settings-arrow');
  panel.classList.toggle('hidden');
  arrow.classList.toggle('open');
}

function fetchSettings() {
  fetch('/api/settings')
    .then(r => r.json())
    .then(data => {
      settings = data;
      updateSettingsForm();
    });
}

function updateSettingsForm() {
  if ($('#setting-dir')) $('#setting-dir').value = settings.downloadDir || '';
  if ($('#setting-concurrent')) $('#setting-concurrent').value = settings.maxConcurrent || 3;
  if ($('#setting-browser')) $('#setting-browser').value = String(settings.browserHeadless);

  // Save mode toggle
  if ($('#setting-save-mode')) {
    $('#setting-save-mode').checked = settings.saveMode === 'manual';
  }

  // Clipboard toggles — only sync from server if server knows about them
  if ('clipboardCapture' in settings && settings.clipboardCapture !== undefined) {
    if ($('#setting-clipboard-capture')) $('#setting-clipboard-capture').checked = !!settings.clipboardCapture;
    clipboardCaptureEnabled = !!settings.clipboardCapture;
  } else {
    clipboardCaptureEnabled = $('#setting-clipboard-capture') ? $('#setting-clipboard-capture').checked : false;
  }
  if ('autoDownload' in settings && settings.autoDownload !== undefined) {
    if ($('#setting-auto-download')) $('#setting-auto-download').checked = !!settings.autoDownload;
    autoDownloadEnabled = !!settings.autoDownload;
  } else {
    autoDownloadEnabled = $('#setting-auto-download') ? $('#setting-auto-download').checked : false;
  }

  // Dir hint
  const hint = $('#dir-hint');
  if (hint) hint.textContent = '当前: ' + (settings.downloadDir || '');
}

function saveSettings() {
  const saveModeChecked = $('#setting-save-mode') ? $('#setting-save-mode').checked : false;
  const captureChecked = $('#setting-clipboard-capture') ? $('#setting-clipboard-capture').checked : false;
  const autoChecked = $('#setting-auto-download') ? $('#setting-auto-download').checked : false;
  const dirValue = $('#setting-dir') ? $('#setting-dir').value.trim() : '';
  const body = {
    saveMode: saveModeChecked ? 'manual' : 'auto',
    clipboardCapture: captureChecked,
    autoDownload: autoChecked,
    customDir: dirValue || '',
    useCustomDir: !!dirValue,
    maxConcurrent: parseInt($('#setting-concurrent').value, 10) || 3,
    browserHeadless: $('#setting-browser').value === 'true'
  };

  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(r => r.json())
  .then(() => {
    fetchSettings();
  });
}

function restartBrowser() {
  fetch('/api/browser/restart', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        fetchStatus();
      } else {
        alert('重启失败: ' + (data.error || '未知错误'));
      }
    });
}

function openDownloadDir() {
  fetch('/api/open-dir', { method: 'POST' })
    .then(r => {
      if (!r.ok) console.warn('打开目录接口不可用 (旧版本服务端)');
    })
    .catch(e => console.error('打开目录失败:', e));
}

function cleanupTmpFiles() {
  fetch('/api/cleanup-tmp', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        alert('✅ ' + data.message);
      }
    })
    .catch(e => alert('清理失败: ' + e.message));
}

// ---------- Utils ----------
function fetchStatus() {
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      statusInfo = data;
      updateStatusBar();
    });
}

function fetchQueue() {
  fetch('/api/queue')
    .then(r => r.json())
    .then(data => {
      items = {};
      for (const item of data.items) {
        items[item.id] = item;
      }
      renderQueue();
    });
}

// Health check — detect server disconnect (10 strikes ≈ 30s = disconnected)
let serverOnline = true;
let healthFailCount = 0;
function startHealthCheck() {
  setInterval(() => {
    fetch('/api/ping', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error(r.status);
        healthFailCount = 0;
      })
      .catch(() => {
        healthFailCount++;
        if (healthFailCount >= 10 && serverOnline) {
          serverOnline = false;
          updateStatusBar();
          showDisconnectBanner();
        }
      });
  }, 3000);
}

function showDisconnectBanner() {
  let banner = $('#disconnect-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'disconnect-banner';
    document.body.prepend(banner);
  }
  banner.innerHTML = '<strong>服务器连接已断开</strong> — 可能点击了控制台窗口导致进程暂停。最小化程序窗口或等待自动恢复...';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#e74c3c;color:#fff;text-align:center;padding:12px;font-size:15px;cursor:pointer;';
  banner.onclick = () => window.location.reload();
}

function hideDisconnectBanner() {
  const banner = $('#disconnect-banner');
  if (banner) banner.remove();
}

// SSE watchdog — reconnect if no events received for 35s (stale connection)
let _sseWatchdogTimer = null;
function startSSEWatchdog() {
  if (_sseWatchdogTimer) clearInterval(_sseWatchdogTimer);
  _sseWatchdogTimer = setInterval(() => {
    const elapsed = Date.now() - lastSSEEventTime;
    if (elapsed > 35000) {
      console.warn('SSE 连接疑似断开 (' + Math.round(elapsed/1000) + 's 无事件), 强制重连...');
      // Reset tracker immediately to avoid reconnect loop
      lastSSEEventTime = Date.now();
      connectSSE();
    }
  }, 10000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Login ----------
function setupLoginClick() {
  const cookieEl = $('#status-cookie');
  if (cookieEl) {
    cookieEl.addEventListener('click', () => {
      if (!statusInfo.cookieValid) {
        startLogin();
      }
    });
  }
}

function startLogin() {
  if (loginModalOpen) return;
  loginModalOpen = true;

  const modal = $('#login-modal');
  const statusText = $('#login-status-text');
  const loading = $('#login-loading');
  const cancelBtn = $('#btn-login-cancel');

  if (!modal) return;

  // Reset modal state
  modal.classList.remove('hidden');
  if (loading) loading.innerHTML = '<div class="spinner"></div>';
  if (statusText) statusText.textContent = '正在打开浏览器窗口...';
  if (statusText) statusText.style.color = '#c9d1d9';
  if (cancelBtn) cancelBtn.textContent = '取消';

  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
  .then(r => r.json())
  .then(data => {
    if (data.status === 'in_progress') {
      if (statusText) statusText.textContent = '登录窗口已打开，请在浏览器中扫码...';
    }
  })
  .catch(e => {
    if (statusText) statusText.textContent = '启动登录失败: ' + e.message;
    if (loading) loading.innerHTML = '<div class="login-success-icon" style="color:#f85149">✕</div>';
  });
}

function handleLoginProgress(data) {
  const statusText = $('#login-status-text');
  const loading = $('#login-loading');
  const cancelBtn = $('#btn-login-cancel');

  if (!statusText) return;

  switch (data.status) {
    case 'starting':
      statusText.textContent = '正在打开浏览器窗口...';
      break;
    case 'waiting':
      statusText.textContent = '请在打开的浏览器窗口中扫码登录';
      if (cancelBtn) cancelBtn.textContent = '关闭';
      break;
    case 'success':
      if (loading) loading.innerHTML = '<div class="login-success-icon">✓</div>';
      statusText.textContent = '登录成功！';
      statusText.style.color = '#3fb950';
      if (cancelBtn) cancelBtn.textContent = '完成';
      // Update status bar immediately
      statusInfo.cookieValid = true;
      updateStatusBar();
      // Close modal after 2s
      setTimeout(() => closeLoginModal(), 2000);
      break;
    case 'timeout':
      if (loading) loading.innerHTML = '<div class="login-success-icon" style="color:#d29922">⏱</div>';
      statusText.textContent = '扫码超时 (3分钟)，请重试';
      statusText.style.color = '#d29922';
      if (cancelBtn) cancelBtn.textContent = '关闭';
      fetch('/api/login/cancel', { method: 'POST' }).catch(() => {});
      break;
    case 'error':
      if (loading) loading.innerHTML = '<div class="login-success-icon" style="color:#f85149">✕</div>';
      statusText.textContent = '登录失败: ' + (data.error || '未知错误');
      statusText.style.color = '#f85149';
      if (cancelBtn) cancelBtn.textContent = '关闭';
      fetch('/api/login/cancel', { method: 'POST' }).catch(() => {});
      break;
  }
}

function closeLoginModal() {
  const modal = $('#login-modal');
  if (modal) modal.classList.add('hidden');
  loginModalOpen = false;
  fetch('/api/login/cancel', { method: 'POST' }).catch(() => {});
}

function setupEnterKey() {
  $('#url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      addUrls();
    }
  });
}
