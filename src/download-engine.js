const fs = require('fs');
const path = require('path');

function tmpPath(dest) { return dest + '.tmp'; }

const BROWSER_HEADERS = {
  'Referer': 'https://www.douyin.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'video/mp4,video/webm,video/*,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'video',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
  'Origin': 'https://www.douyin.com'
};

/** Pass 1: Direct HTTP fetch via Playwright APIRequestContext (Node.js with browser cookies) */
async function downloadViaAPI(context, videoUrl, destPath, onProgress) {
  const tmp = tmpPath(destPath);
  try {
    const result = await Promise.race([
      (async () => {
        const resp = await context.request.fetch(videoUrl, {
          method: 'GET', headers: BROWSER_HEADERS,
          timeout: 60000, failOnStatusCode: false
        });
        if (!resp.ok()) throw new Error('HTTP ' + resp.status());
        const total = parseInt(resp.headers()['content-length'] || '0', 10) || 0;
        const buffer = await resp.body();
        if (!buffer || buffer.length === 0) throw new Error('empty data');
        if (onProgress) onProgress({ percent: 0, bytesDone: 0, bytesTotal: total || buffer.length, speed: 0, eta: 0 });
        fs.writeFileSync(tmp, buffer);
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        fs.renameSync(tmp, destPath);
        const size = fs.statSync(destPath).size;
        if (onProgress) onProgress({ percent: 100, bytesDone: size, bytesTotal: size, speed: 0, eta: 0 });
        return { bytesTotal: size, filePath: destPath };
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('下载超时 (90s)')), 90000))
    ]);
    return result;
  } catch (e) {
    console.log('[download] failed:', e.message);
    throw e;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

/** Pass 2: Open video page, intercept CDN response via page.route, write body to file */
async function downloadViaPage(context, awemeId, destPath, onProgress) {
  const tmp = tmpPath(destPath);
  let page = null;
  try {
    page = await context.newPage();

    let cdnBuffer = null;
    let cdnDone = false;

    await page.route('**/*douyinvod.com**', async (route) => {
      if (cdnDone) { await route.continue(); return; }
      try {
        const resp = await route.fetch();
        const buf = await resp.body();
        if (buf && buf.length > 1000) {
          cdnBuffer = buf;
          cdnDone = true;
        }
        await route.fulfill({ response: resp });
      } catch (e) {
        await route.continue().catch(() => {});
      }
    });

    await page.route('**/aweme/v1/play**', async (route) => {
      if (cdnDone) { await route.continue(); return; }
      try {
        const resp = await route.fetch();
        const buf = await resp.body();
        if (buf && buf.length > 1000) {
          cdnBuffer = buf;
          cdnDone = true;
        }
        await route.fulfill({ response: resp });
      } catch (e) {
        await route.continue().catch(() => {});
      }
    });

    const videoPageUrl = 'https://www.douyin.com/video/' + awemeId;
    await page.goto(videoPageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // Wait up to 25s for CDN response
    for (let i = 0; i < 50 && !cdnDone; i++) {
      await page.evaluate(() => { window.scrollBy(0, 200); }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    }

    if (!cdnBuffer || cdnBuffer.length === 0) throw new Error('CDN 无应答');

    if (onProgress) onProgress({ percent: 0, bytesDone: 0, bytesTotal: cdnBuffer.length, speed: 0, eta: 0 });
    fs.writeFileSync(tmp, cdnBuffer);
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    fs.renameSync(tmp, destPath);
    const size = fs.statSync(destPath).size;
    if (onProgress) onProgress({ percent: 100, bytesDone: size, bytesTotal: size, speed: 0, eta: 0 });
    return { bytesTotal: size, filePath: destPath };
  } catch (e) {
    console.log('[download] page intercept failed:', e.message);
    throw e;
  } finally {
    if (page) {
      try { await page.unroute('**/*douyinvod.com**'); } catch {}
      try { await page.unroute('**/aweme/v1/play**'); } catch {}
      await page.close().catch(() => {});
    }
  }
}

async function downloadWithRetry(context, urls, destPath, onProgress, maxRetries, refreshUrls) {
  const tmp = tmpPath(destPath);

  // Pass 1: Try APIRequestContext for each URL
  const allUrls = [...urls];
  for (let attempt = 0; attempt < Math.max(maxRetries || 1, 1); attempt++) {
    if (attempt > 0) {
      const fresh = refreshUrls ? (await refreshUrls().catch(() => null)) : null;
      if (fresh && fresh.length > 0) allUrls.push(...fresh);
    }
    for (const url of allUrls) {
      try {
        const result = await downloadViaAPI(context, url, destPath, onProgress);
        if (!fs.existsSync(destPath) || fs.existsSync(tmp)) throw new Error('文件写入失败');
        return result;
      } catch (e) {
        console.log('[download] attempt', attempt, 'failed:', e.message);
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      }
    }
  }

  // Pass 2: Page interception fallback
  if (onProgress) onProgress({ percent: 0, bytesDone: 0, bytesTotal: 0, speed: 0, eta: 0 });

  const awemeIds = new Set();
  for (const url of allUrls) {
    const m = url.match(/video_id=([^&]+)/);
    if (m) awemeIds.add(m[1]);
  }

  for (const awemeId of awemeIds) {
    try {
      const result = await downloadViaPage(context, awemeId, destPath, onProgress);
      if (!fs.existsSync(destPath) || fs.existsSync(tmp)) throw new Error('文件写入失败');
      return result;
    } catch (e) {
      console.log('[download] page fallback failed:', e.message);
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
  }

  throw new Error('所有下载方式均失败');
}

module.exports = { downloadViaAPI, downloadViaPage, downloadWithRetry };
