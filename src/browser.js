const { loadPlaywright } = require('./playwright-loader');
const playwright = loadPlaywright();
const { chromium } = playwright;
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadCookies, saveCookies, checkLogin } = require('./cookie-manager');
const config = require('../config');

let browser = null;
let context = null;
let page = null;

/** Race a promise against a timeout. Rejects with TimeoutErrorName if timeout fires first. */
function withTimeout(promise, ms, label) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`超时: ${label} 超过 ${ms}ms`)), ms)
  );
  return Promise.race([promise, timer]);
}

function ensureChromiumInstalled() {
  try {
    const p = chromium.executablePath();
    if (fs.existsSync(p)) return true;
  } catch {}
  // Chromium not found — install it
  console.log('首次启动: 正在安装 Chromium 浏览器...');
  console.log('(约 2-3 分钟, 视网络情况)');
  try {
    execSync('npx playwright install chromium', {
      stdio: 'inherit',
      timeout: 300000,
      cwd: __dirname
    });
    console.log('Chromium 安装完成');
    return true;
  } catch (e) {
    console.error('Chromium 自动安装失败:', e.message);
    return false;
  }
}

async function initBrowser(headless = config.browserHeadless) {
  if (browser) {
    try { await browser.close(); } catch {}
  }

  if (!ensureChromiumInstalled()) {
    throw new Error('Chromium 浏览器未安装。请手动运行: npx playwright install chromium');
  }

  browser = await chromium.launch({
    headless,
    args: config.browserArgs
  });

  // Detect browser disconnect (sleep/hibernate/crash) immediately
  browser.on('disconnected', () => {
    console.log('[浏览器] 检测到浏览器断开连接(可能系统休眠), 已标记失效, 等待自动重启');
    // Null references so getContext/getPage immediately restart instead of hanging
    page = null;
    context = null;
  });

  context = await browser.newContext({
    viewport: config.viewport,
    userAgent: config.userAgent,
    locale: 'zh-CN'
  });

  // Load cookies
  const result = await loadCookies(context, config.cookieFile);
  if (!result.loaded) {
    console.log(`Cookie load: ${result.reason || 'unknown'}`);
  } else {
    console.log(`Loaded ${result.count} cookies`);
  }

  page = await context.newPage();

  const loggedIn = await checkLogin(context);
  if (loggedIn) {
    console.log('Session valid (sessionid found)');
  } else {
    console.log('No session cookie. Will need manual login for API calls.');
  }

  // Navigate to douyin.com to establish session
  try {
    await page.goto('https://www.douyin.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    }).catch(() => {});
    console.log('Navigated to douyin.com');
    // Save fresh cookies after navigation
    await saveCookies(context, config.cookieFile);
  } catch (e) {
    console.log('Navigation to douyin.com failed:', e.message);
  }

  return { browser, context, page };
}

async function getPage() {
  if (!page || !context || !browser) {
    console.log('浏览器引用已失效，自动重启...');
    await initBrowser(config.browserHeadless);
    await new Promise(r => setTimeout(r, 3000));
    return page;
  }
  // Check browser still alive — auto-recover if disconnected
  try {
    await withTimeout(page.evaluate('1'), 5000, 'page.evaluate');
  } catch {
    console.log('页面断开，自动重启浏览器...');
    await initBrowser(config.browserHeadless);
    await new Promise(r => setTimeout(r, 3000));
  }
  return page;
}

async function getFreshPage() {
  if (!browser) throw new Error('Browser not initialized');
  const ctx = await getContext();
  const p = await ctx.newPage();
  return p;
}

/** Create an isolated context (no shared service workers) for collection extraction.
 *  Copies live cookies from main context so session is fresh, not stale file copy. */
async function getIsolatedPage() {
  if (!browser) throw new Error('Browser not initialized');
  var ctx = await browser.newContext({
    viewport: config.viewport,
    userAgent: config.userAgent,
    locale: 'zh-CN'
  });
  // Priority: live main context cookies > saved cookie file
  if (context) {
    try {
      var mainCookies = await context.cookies();
      if (mainCookies && mainCookies.length > 0) {
        await ctx.addCookies(mainCookies);
      } else {
        await loadCookies(ctx, config.cookieFile);
      }
    } catch(e) {
      await loadCookies(ctx, config.cookieFile);
    }
  } else {
    await loadCookies(ctx, config.cookieFile);
  }
  var p = await ctx.newPage();
  p.__isolatedContext = ctx;
  return p;
}

async function checkBrowserHealth() {
  if (!browser || !context || !page) return false;
  try {
    // Timeout: if pages() hangs after sleep, don't block watchdog
    const pages = await withTimeout(context.pages(), 5000, 'context.pages');
    await withTimeout(page.evaluate('1'), 5000, 'page.evaluate');
    return true;
  } catch {
    return false;
  }
}

async function getContext() {
  if (!context || !browser) {
    console.log('浏览器未就绪，自动重启...');
    await initBrowser(config.browserHeadless);
    return context;
  }
  // Verify context is alive — dead Playwright references pass null check
  // Timeout prevents hanging after sleep/hibernate when WebSocket is broken
  try {
    const pages = await withTimeout(context.pages(), 5000, 'context.pages');
    if (page) {
      await withTimeout(page.evaluate('1'), 5000, 'page.evaluate');
    }
  } catch {
    console.log('浏览器上下文已失效或超时(可能系统休眠), 自动重启...');
    await initBrowser(config.browserHeadless);
  }
  return context;
}

async function restartBrowser(headless) {
  return await initBrowser(headless);
}

async function closeBrowser() {
  try {
    if (context) {
      await saveCookies(context, config.cookieFile);
    }
    if (browser) await browser.close();
  } catch {}
  browser = null;
  context = null;
  page = null;
}

module.exports = { initBrowser, getPage, getContext, getFreshPage, getIsolatedPage, restartBrowser, closeBrowser, checkBrowserHealth };
