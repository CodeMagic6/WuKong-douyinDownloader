const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');
const config = require('./config');
const SSEBroadcaster = require('./src/sse');
const QueueManager = require('./src/queue-manager');

// Disable Windows QuickEdit to prevent console pause on click
try { execSync('reg add HKCU\\Console /v QuickEdit /t REG_DWORD /d 0 /f', { stdio: 'ignore', timeout: 3000 }); } catch {}
const { initBrowser, closeBrowser, restartBrowser, getPage } = require('./src/browser');
const { closeApiPage } = require('./src/video-api');
const { checkLogin } = require('./src/cookie-manager');
const ClipboardWatcher = require('./src/clipboard-watcher');

const app = express();
app.use(express.json());

// Persisted settings file
const settingsFile = path.join(process.cwd(), 'settings.json');
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const saved = JSON.parse(raw);
    if (typeof saved.clipboardCapture === 'boolean') config.clipboardCapture = saved.clipboardCapture;
    if (typeof saved.autoDownload === 'boolean') config.autoDownload = saved.autoDownload;
    if (saved.saveMode === 'auto' || saved.saveMode === 'manual') config.saveMode = saved.saveMode;
    if (typeof saved.useCustomDir === 'boolean') config.useCustomDir = saved.useCustomDir;
    if (saved.customDir) {
      config.customDownloadDir = path.resolve(saved.customDir);
      if (config.useCustomDir) config.downloadDir = config.customDownloadDir;
    }
    if (typeof saved.maxConcurrent === 'number') config.maxConcurrent = saved.maxConcurrent;
    if (typeof saved.browserHeadless === 'boolean') config.browserHeadless = saved.browserHeadless;
  } catch {}
}
function saveSettingsToFile() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      clipboardCapture: config.clipboardCapture,
      autoDownload: config.autoDownload,
      saveMode: config.saveMode,
      useCustomDir: config.useCustomDir,
      customDir: config.customDownloadDir,
      maxConcurrent: config.maxConcurrent,
      browserHeadless: config.browserHeadless
    }, null, 2), 'utf-8');
  } catch {}
}
loadSettings();

// Disable caching for frontend files so updates take effect immediately
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/app.js' || req.path === '/styles.css') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

const staticDir = typeof process.pkg !== 'undefined'
  ? path.join(path.dirname(process.execPath), 'public')
  : path.join(__dirname, 'public');
app.use(express.static(staticDir));

// Init SSE + Queue
const sse = new SSEBroadcaster();
const queue = new QueueManager(config.maxConcurrent, sse);
const clipboardWatcher = new ClipboardWatcher();
syncClipboardWatcher();

// Start/stop clipboard watcher based on config
function syncClipboardWatcher() {
  if (config.clipboardCapture) {
    clipboardWatcher.start(config, queue, sse);
  } else {
    clipboardWatcher.stop();
  }
}

let browserReady = false;
let cookieValid = false;

// ---------- Process-level crash prevention ----------
const logFile = path.join(process.cwd(), 'server.log');
try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] 启动\n'); } catch {}

// Tee console.log/error to both stdout and log file
['log', 'error', 'warn'].forEach(method => {
  const orig = console[method];
  console[method] = function(...args) {
    orig.apply(console, args);
    try {
      fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] [' + method + '] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    } catch {}
  };
});

process.on('uncaughtException', (e) => {
  console.error('未捕获异常 (服务器继续运行):', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('未捕获 Promise 异常 (服务器继续运行):', e.message);
});

// ---------- Routes ----------

// Ping (health check)
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// Status
app.get('/api/status', (req, res) => {
  // Re-check cookie from file on each status request
  try {
    const raw = fs.readFileSync(config.cookieFile, 'utf-8');
    const cookies = JSON.parse(raw);
    cookieValid = cookies.some(c => c.name === 'sessionid');
  } catch {
    cookieValid = false;
  }
  const stats = queue.getStats();
  res.json({
    browserReady,
    cookieValid,
    queueRunning: stats.queueRunning,
    queueLength: stats.queueLength,
    downloadsToday: stats.downloadsToday,
    port: config.port,
    downloadDir: config.downloadDir
  });
});

// Add download
app.post('/api/download', (req, res) => {
  const { urls } = req.body;
  if (!urls || (Array.isArray(urls) && urls.length === 0) || (typeof urls === 'string' && !urls.trim())) {
    return res.status(400).json({ error: '请至少提供一个 URL' });
  }
  const urlList = Array.isArray(urls) ? urls : [urls];
  const results = queue.add(urlList);
  res.json({ items: results });
});

// Queue state
app.get('/api/queue', (req, res) => {
  res.json(queue.getState());
});

// Cancel download
app.delete('/api/queue/:id', (req, res) => {
  const ok = queue.cancel(req.params.id);
  res.json({ success: ok });
});

// Remove from list (only completed/error/cancelled)
app.delete('/api/queue/:id/remove', (req, res) => {
  const ok = queue.remove(req.params.id);
  res.json({ success: ok });
});

// Clear completed
app.post('/api/queue/clear-completed', (req, res) => {
  queue.clearCompleted();
  res.json({ success: true });
});

// SSE progress
app.get('/api/progress', (req, res) => {
  sse.addClient(req, res);
});

// Serve completed file
app.get('/api/file/:id', (req, res) => {
  const item = queue.getItem(req.params.id);
  if (!item || item.status !== 'completed' || !item.filePath) {
    return res.status(404).json({ error: '文件未找到' });
  }
  if (!fs.existsSync(item.filePath)) {
    return res.status(404).json({ error: '文件已不存在' });
  }
  res.download(item.filePath, item.filename);
});

// Settings
app.get('/api/settings', (req, res) => {
  res.json({
    downloadDir: config.downloadDir,
    defaultDir: config.defaultDownloadDir,
    customDir: config.customDownloadDir,
    useCustomDir: config.useCustomDir,
    saveMode: config.saveMode,
    clipboardCapture: config.clipboardCapture,
    autoDownload: config.autoDownload,
    maxConcurrent: config.maxConcurrent,
    browserHeadless: config.browserHeadless
  });
});

app.put('/api/settings', (req, res) => {
  const { customDir, useCustomDir, saveMode, clipboardCapture, autoDownload, maxConcurrent, browserHeadless } = req.body;

  if (typeof useCustomDir === 'boolean') {
    config.useCustomDir = useCustomDir;
  }
  if (customDir && typeof customDir === 'string') {
    config.customDownloadDir = path.resolve(customDir);
    if (!fs.existsSync(config.customDownloadDir)) {
      fs.mkdirSync(config.customDownloadDir, { recursive: true });
    }
  }
  // Resolve effective download dir
  if (config.useCustomDir && config.customDownloadDir) {
    config.downloadDir = config.customDownloadDir;
  } else {
    config.downloadDir = config.defaultDownloadDir;
  }

  if (saveMode === 'auto' || saveMode === 'manual') {
    config.saveMode = saveMode;
  }

  if (typeof maxConcurrent === 'number') {
    config.maxConcurrent = Math.max(1, Math.min(10, maxConcurrent));
    queue.setConcurrency(config.maxConcurrent);
  }
  if (typeof browserHeadless === 'boolean') {
    config.browserHeadless = browserHeadless;
  }
  if (typeof clipboardCapture === 'boolean') {
    config.clipboardCapture = clipboardCapture;
  }
  if (typeof autoDownload === 'boolean') {
    config.autoDownload = autoDownload;
  }
  saveSettingsToFile();
  syncClipboardWatcher();
  sse.broadcast('settings_updated', {
    downloadDir: config.downloadDir,
    defaultDir: config.defaultDownloadDir,
    customDir: config.customDownloadDir,
    useCustomDir: config.useCustomDir,
    saveMode: config.saveMode,
    clipboardCapture: config.clipboardCapture,
    autoDownload: config.autoDownload,
    maxConcurrent: config.maxConcurrent
  });
  res.json({ success: true });
});

// Restart browser
app.post('/api/browser/restart', async (req, res) => {
  try {
    await restartBrowser(config.browserHeadless);
    browserReady = true;
    try {
      const raw = fs.readFileSync(config.cookieFile, 'utf-8');
      const cookies = JSON.parse(raw);
      cookieValid = cookies.some(c => c.name === 'sessionid');
    } catch {
      cookieValid = false;
    }
    sse.broadcast('status_update', { browserReady, cookieValid });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open download directory in explorer
app.post('/api/open-dir', (req, res) => {
  const dir = config.downloadDir;
  try {
    const { execSync } = require('child_process');
    execSync(`explorer "${dir}"`, { timeout: 3000 });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Startup ----------
async function start() {
  // Ensure download dir
  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }

  // Init browser
  console.log('启动浏览器...');
  try {
    await initBrowser(config.browserHeadless);
    browserReady = true;
    // Check cookies from file (more reliable than context after navigation)
    try {
      const raw = fs.readFileSync(config.cookieFile, 'utf-8');
      const cookies = JSON.parse(raw);
      cookieValid = cookies.some(c => c.name === 'sessionid');
    } catch {
      cookieValid = false;
    }
    console.log(`浏览器状态: ${browserReady ? '✅ 已就绪' : '❌ 失败'}`);
    console.log(`Cookie 状态: ${cookieValid ? '✅ 已登录' : '⚠️ 未登录'}`);
  } catch (e) {
    console.error('浏览器初始化失败:', e.message);
    console.log('服务器将继续运行，但下载功能不可用');
  }

  // Broadcast initial status
  sse.broadcast('status_update', queue.getStats());

  app.listen(config.port, () => {
    console.log(`\n服务器启动: http://localhost:${config.port}`);
    console.log(`下载目录: ${config.downloadDir}`);
    // Auto-open browser
    try {
      const url = `http://localhost:${config.port}`;
      const { execSync } = require('child_process');
      execSync(`start "" "${url}"`, { timeout: 3000 });
      console.log('已自动打开浏览器');
    } catch {}
  });
}

start().catch(e => {
  console.error('启动失败:', e.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n关闭中...');
  await closeApiPage();
  await closeBrowser();
  process.exit(0);
});
