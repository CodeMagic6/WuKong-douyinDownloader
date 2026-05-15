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
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }
  // Check browser still alive — auto-recover if disconnected
  try {
    await page.evaluate('1');
  } catch {
    console.log('页面断开，自动重启浏览器...');
    await initBrowser(config.browserHeadless);
    // Wait for page to settle after navigation
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

async function getContext() {
  if (!context || !browser) {
    console.log('浏览器未就绪，自动重启...');
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

module.exports = { initBrowser, getPage, getContext, getFreshPage, restartBrowser, closeBrowser };
