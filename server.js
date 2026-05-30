const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('./config');
const SSEBroadcaster = require('./src/sse');
const QueueManager = require('./src/queue-manager');

// Disable Windows QuickEdit — prevents console click from pausing Node process
try {
  const ps = 'Add-Type -MemberDefinition \'[DllImport("kernel32.dll")]public static extern bool SetConsoleMode(IntPtr h,uint m);[DllImport("kernel32.dll")]public static extern IntPtr GetStdHandle(int n);\' -Name C -Namespace API; [API.C]::SetConsoleMode([API.C]::GetStdHandle(-10),0x0080)';
  execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`, { stdio: 'ignore', timeout: 10000 });
} catch {}
// Registry fallback for future console sessions
try { execSync('reg add HKCU\\Console /v QuickEdit /t REG_DWORD /d 0 /f', { stdio: 'ignore', timeout: 3000 }); } catch {}
const { initBrowser, closeBrowser, restartBrowser, getPage, getContext, checkBrowserHealth } = require('./src/browser');
const { closeApiPage } = require('./src/video-api');
const { closeBilibiliPage } = require('./src/bilibili-api');
const { checkLogin } = require('./src/cookie-manager');
const { loadPlaywright } = require('./src/playwright-loader');
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
var shutdownTimer = null;
var _queueRef = null; // set after QueueManager init; used by auto-shutdown guard
const sse = new SSEBroadcaster(function() {
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(function() {
    shutdownTimer = null;
    if (sse.getClientCount() > 0) return;
    // Don't auto-shutdown if queue has active downloads
    if (_queueRef) {
      const stats = _queueRef.getStats();
      if (stats.queueRunning || stats.queueLength > 0) {
        console.log('[自动退出] 延后: 队列仍有下载任务');
        shutdownTimer = null; // allow next empty-trigger
        return;
      }
    }
    console.log('[自动退出] 页面已关闭, 清理资源...');
    // Don't stop clipboard here — if browser reconnects we restart it
    stopTmpCleanupTimer();
    stopWatchdog();
    try {
      const { getContext } = require('./src/browser');
      getContext().then(function(ctx) {
        if (ctx) {
          const { saveCookies } = require('./src/cookie-manager');
          saveCookies(ctx, config.cookieFile);
        }
      }).catch(function() {});
    } catch(e) {}
    // Graceful delay then exit
    var exitTimer = setInterval(function() {
      if (sse.getClientCount() > 0) {
        clearInterval(exitTimer);
        syncClipboardWatcher(); // Restart clipboard if browser came back
        return;
      }
    }, 5000);
    setTimeout(function() {
      clipboardWatcher.stop();
      process.exit(0);
    }, 8000);
  }, 10000);
});
const queue = new QueueManager(config.maxConcurrent, sse);
_queueRef = queue;
const clipboardWatcher = new ClipboardWatcher();
syncClipboardWatcher();

// Start/stop clipboard watcher based on config
function syncClipboardWatcher() {
  if (config.clipboardCapture) {
    clipboardWatcher.start(config, queue, sse);
    console.log('[设置] 剪贴板监听: ✅ 已开启 (复制抖音链接自动下载)');
  } else {
    clipboardWatcher.stop();
    console.log('[设置] 剪贴板监听: ❌ 已关闭');
  }
}

// Remove stale .tmp files left by previous crashed instances
// Skips files modified within last 5 min (actively being downloaded)
function cleanupStaleTmpFiles(dir) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const f of files) {
      if (f.isDirectory()) {
        cleanupStaleTmpFiles(path.join(dir, f.name));
        continue;
      }
      if (f.name.endsWith('.tmp')) {
        const fullPath = path.join(dir, f.name);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs < 300000) continue; // skip active download
        } catch {}
        fs.unlinkSync(fullPath);
        console.log(`清理残留 .tmp: ${f.name}`);
      }
    }
  } catch {}
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

// ---------- Login flow ----------
let loginInProgress = false;

async function startLoginFlow() {
  if (loginInProgress) return;
  loginInProgress = true;

  let loginBrowser = null;
  let loginContext = null;
  let loginPage = null;

  try {
    sse.broadcast('login_progress', { status: 'starting' });

    const playwright = loadPlaywright();
    const { chromium } = playwright;
    const { saveCookies } = require('./src/cookie-manager');

    loginBrowser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });

    loginContext = await loginBrowser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: config.userAgent,
      locale: 'zh-CN'
    });

    loginPage = await loginContext.newPage();

    sse.broadcast('login_progress', { status: 'waiting' });

    await loginPage.goto('https://www.douyin.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => {});

    // Poll for sessionid cookie (3 min timeout)
    const pollInterval = 1000;
    const maxAttempts = 180;
    let loggedIn = false;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval));
      try {
        const cookies = await loginContext.cookies();
        const hasSession = cookies.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
        if (hasSession) {
          loggedIn = true;
          break;
        }
      } catch {}
    }

    if (loggedIn) {
      // Save cookies to file
      await saveCookies(loginContext, config.cookieFile);

      // Update main browser context with new cookies
      try {
        const mainContext = await getContext();
        if (mainContext) {
          const cookies = await loginContext.cookies();
          await mainContext.addCookies(cookies);
        }
      } catch {}

      sse.broadcast('login_progress', { status: 'success' });
      sse.broadcast('status_update', { cookieValid: true });
      console.log('扫码登录成功');
    } else {
      sse.broadcast('login_progress', { status: 'timeout' });
      console.log('扫码登录超时');
    }
  } catch (e) {
    console.error('扫码登录失败:', e.message);
    sse.broadcast('login_progress', { status: 'error', error: e.message });
  } finally {
    if (loginPage) await loginPage.close().catch(() => {});
    if (loginBrowser) await loginBrowser.close().catch(() => {});
    loginInProgress = false;
  }
}

app.post('/api/login', (req, res) => {
  if (loginInProgress) return res.json({ status: 'in_progress' });
  // Don't await — run in background
  startLoginFlow();
  res.json({ status: 'started' });
});

app.post('/api/login/cancel', (req, res) => {
  // Endpoint for frontend to acknowledge timeout/error and reset state
  if (loginInProgress) {
    loginInProgress = false;
  }
  res.json({ status: 'cancelled' });
});

// ---------- B站 Login flow ----------
let bilibiliLoginInProgress = false;

async function startBilibiliLoginFlow() {
  if (bilibiliLoginInProgress) return;
  bilibiliLoginInProgress = true;

  let loginBrowser = null;
  let loginContext = null;
  let loginPage = null;

  try {
    sse.broadcast('bilibili_login_progress', { status: 'starting' });

    const playwright = loadPlaywright();
    const { chromium } = playwright;

    loginBrowser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });

    loginContext = await loginBrowser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: config.userAgent,
      locale: 'zh-CN'
    });

    loginPage = await loginContext.newPage();

    sse.broadcast('bilibili_login_progress', { status: 'waiting' });

    await loginPage.goto('https://passport.bilibili.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => {});

    // Poll for SESSDATA cookie (3 min timeout)
    const pollInterval = 1000;
    const maxAttempts = 180;
    let loggedIn = false;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval));
      try {
        const cookies = await loginContext.cookies();
        const hasSession = cookies.some(c => c.name === 'SESSDATA');
        if (hasSession) {
          loggedIn = true;
          break;
        }
      } catch {}
    }

    if (loggedIn) {
      // Save bilibili cookies to file
      const cookies = await loginContext.cookies();
      const fs = require('fs');
      fs.writeFileSync(config.bilibiliCookieFile, JSON.stringify(cookies, null, 2), 'utf-8');

      // Update bilibili-api page with new cookies
      try {
        const { closeBilibiliPage } = require('./src/bilibili-api');
        await closeBilibiliPage();
      } catch {}

      sse.broadcast('bilibili_login_progress', { status: 'success' });
      sse.broadcast('status_update', { bilibiliCookieValid: true });
      console.log('B站扫码登录成功');
    } else {
      sse.broadcast('bilibili_login_progress', { status: 'timeout' });
      console.log('B站扫码登录超时');
    }
  } catch (e) {
    console.error('B站扫码登录失败:', e.message);
    sse.broadcast('bilibili_login_progress', { status: 'error', error: e.message });
  } finally {
    if (loginPage) await loginPage.close().catch(() => {});
    if (loginBrowser) await loginBrowser.close().catch(() => {});
    bilibiliLoginInProgress = false;
  }
}

app.post('/api/bilibili/login', (req, res) => {
  if (bilibiliLoginInProgress) return res.json({ status: 'in_progress' });
  startBilibiliLoginFlow();
  res.json({ status: 'started' });
});

app.post('/api/bilibili/login/cancel', (req, res) => {
  if (bilibiliLoginInProgress) {
    bilibiliLoginInProgress = false;
  }
  res.json({ status: 'cancelled' });
});
// ---------- End login flow ----------

// Ping (health check)
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// Status
app.get('/api/status', (req, res) => {
  try {
    const raw = fs.readFileSync(config.cookieFile, 'utf-8');
    const cookies = JSON.parse(raw);
    cookieValid = cookies.some(c => c.name === 'sessionid');
  } catch {
    cookieValid = false;
  }
  let bilibiliCookieValid = false;
  try {
    const raw = fs.readFileSync(config.bilibiliCookieFile, 'utf-8');
    const cookies = JSON.parse(raw);
    bilibiliCookieValid = cookies.some(c => c.name === 'SESSDATA');
  } catch {}
  const stats = queue.getStats();
  res.json({
    browserReady,
    cookieValid,
    bilibiliCookieValid,
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

// Periodically clean orphaned .tmp files (every 30s)
let tmpCleanupTimer = null;
function startTmpCleanupTimer() {
  stopTmpCleanupTimer();
  tmpCleanupTimer = setInterval(() => {
    cleanupStaleTmpFiles(config.downloadDir);
  }, 30000);
}
function stopTmpCleanupTimer() {
  if (tmpCleanupTimer) {
    clearInterval(tmpCleanupTimer);
    tmpCleanupTimer = null;
  }
}

// API: manual .tmp cleanup trigger
app.post('/api/cleanup-tmp', (req, res) => {
  cleanupStaleTmpFiles(config.downloadDir);
  if (config.customDownloadDir && config.useCustomDir) {
    cleanupStaleTmpFiles(config.customDownloadDir);
  }
  res.json({ success: true, message: '临时文件已清理' });
});

// API: debug watch-later DOM structure
app.get('/api/debug/watchlater', async (req, res) => {
  try {
    const { getFreshPage } = require('./src/browser');
    const page = await getFreshPage();
    let result;
    try {
      await page.goto('https://www.douyin.com/user/self?showTab=watch_later', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const info = await page.evaluate(() => {
          const tabs = document.querySelectorAll('[data-e2e="user-watchlater-tab"]');
          for (const t of tabs) { if (t.scrollHeight > 100) return { found: true, count: t.querySelectorAll('a[href*="/video/"]').length }; }
          return { found: false };
        });
        if (info.found && info.count > 0) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      result = await page.evaluate(() => {
        const tabs = document.querySelectorAll('[data-e2e="user-watchlater-tab"]');
        let c = null;
        for (const t of tabs) { if (t.scrollHeight > 100) { c = t; break; } }
        if (!c) return { error: 'no container' };
        const links = c.querySelectorAll('a[href*="/video/"]');
        const seen = {}, items = [];
        for (let i = 0; i < links.length; i++) {
          const a = links[i]; const m = a.href.match(/\/video\/(\d+)/);
          if (!m || seen[m[1]]) continue; seen[m[1]] = 1;
          const card = a.closest('[data-e2e]') || a.closest('[class*="card"]') || a.parentElement;
          const cardE2e = (card && card.getAttribute) ? (card.getAttribute('data-e2e') || '') : '';
          const hasRemove = card ? card.querySelectorAll('[class*="remove"],[class*="delete"],[class*="del"],[class*="close"],[data-e2e*="remove"],[data-e2e*="delete"],[aria-label*="移出"],[aria-label*="删除"]').length > 0 : false;
          const p1E2e = (a.parentElement && a.parentElement.getAttribute) ? (a.parentElement.getAttribute('data-e2e') || '') : '';
          items.push({ idx: i, id: m[1], cardE2e: cardE2e.slice(0, 60), hasRemove, p1E2e: p1E2e.slice(0, 40) });
        }
        const headings = [];
        const allEls = c.querySelectorAll('*');
        for (const el of allEls) {
          if (el.children.length > 0) continue;
          const txt = (el.textContent || '').trim();
          if (txt.includes('推荐') || txt.includes('为你')) headings.push({ tag: el.tagName, text: txt.slice(0, 50) });
        }
        return { total: items.length, items, headings };
      });
    } finally { await page.close().catch(() => {}); }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Watchdog: event loop + browser health ----------
let watchdogTimers = [];

function startWatchdog() {
  stopWatchdog();

  // 1. Event loop lag monitor (every 10s)
  watchdogTimers.push(setInterval(() => {
    const now = Date.now();
    setImmediate(() => {
      const lag = Date.now() - now;
      if (lag > 500) {
        console.warn(`[看门狗] 事件循环延迟: ${lag}ms (可能进程繁忙)`);
      }
      // If lag > 10s, something is seriously wrong — log to help debugging
      if (lag > 10000) {
        console.error(`[看门狗] ⚠️ 检测到严重阻塞: ${lag}ms, 正在恢复...`);
      }
    });
  }, 10000));

  // 2. Browser health check (every 15s)
  watchdogTimers.push(setInterval(async () => {
    const healthy = await checkBrowserHealth();
    if (browserReady !== healthy) {
      browserReady = healthy;
      sse.broadcast('status_update', {
        browserReady,
        cookieValid
      });
    }
    if (!healthy) {
      console.log('[看门狗] 浏览器不健康, 自动重启...');
      try {
        await restartBrowser(config.browserHeadless);
        browserReady = true;
        // Re-check cookie status
        try {
          const raw = fs.readFileSync(config.cookieFile, 'utf-8');
          const cookies = JSON.parse(raw);
          cookieValid = cookies.some(c => c.name === 'sessionid');
        } catch {
          cookieValid = false;
        }
        sse.broadcast('status_update', { browserReady, cookieValid });
        console.log('[看门狗] 浏览器已自动重启 ✅');
      } catch (e) {
        console.error('[看门狗] 浏览器重启失败:', e.message);
      }
    }
  }, 15000));
}

function stopWatchdog() {
  for (const t of watchdogTimers) {
    clearInterval(t);
  }
  watchdogTimers = [];
}
// ---------- End watchdog ----------

// ---------- Startup ----------
async function start() {
  // Ensure download dir
  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }
  // Clean stale .tmp files from previous crashed runs
  cleanupStaleTmpFiles(config.downloadDir);
  startTmpCleanupTimer();
  startWatchdog(); // event loop + browser health monitor

  // Init browser
  console.log('启动浏览器...');
  try {
    await initBrowser(config.browserHeadless);
    browserReady = true;
    // Check cookies from file
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
    // Auto-open browser — try start, rundll32, powershell
    var _ourl = 'http://localhost:' + config.port;
    var _ocmds = [
      { cmd: 'start "" "' + _ourl + '"', label: 'start' },
      { cmd: 'rundll32 url.dll,FileProtocolHandler "' + _ourl + '"', label: 'rundll32' },
      { cmd: 'powershell -c Start-Process "' + _ourl + '"', label: 'powershell' },
    ];
    var _odone = false;
    for (var _oi = 0; _oi < _ocmds.length; _oi++) {
      try {
        require('child_process').execSync(_ocmds[_oi].cmd, { timeout: 3000, shell: 'cmd.exe' });
        console.log('自动打开浏览器OK: ' + _ocmds[_oi].label);
        _odone = true;
        break;
      } catch(e) {
        console.log('自动打开浏览器失败(' + _ocmds[_oi].label + '): ' + e.message);
      }
    }
    if (!_odone) { console.log('请手动打开浏览器: ' + _ourl); }
  });
}

start().catch(e => {
  console.error('启动失败:', e.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n关闭中...');
  stopTmpCleanupTimer();
  stopWatchdog();
  await closeApiPage();
  await closeBilibiliPage();
  await closeBrowser();
  process.exit(0);
});
