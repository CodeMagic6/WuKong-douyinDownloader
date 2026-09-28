const fs = require('fs');
const https = require('https');
const http = require('http');
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

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk

/**
 * 从 Playwright context 提取 cookie 字符串
 */
async function getCookieString(context) {
  try {
    const cookies = await context.cookies('https://www.douyin.com/');
    return cookies.map(c => c.name + '=' + c.value).join('; ');
  } catch (e) {
    console.log('[download] 获取 cookie 失败:', e.message);
    return '';
  }
}

/**
 * 使用 Node.js 原生 HTTP 模块进行分块流式下载（类似 B 站方案）
 * 优势：内存占用低、支持断点续传、超时可控
 */
async function downloadFileNative(url, destPath, cookieStr, onProgress) {
  const startTime = Date.now();
  let lastTime = startTime;
  let lastBytes = 0;

  return new Promise((resolve, reject) => {
    const reqHeaders = {
      ...BROWSER_HEADERS,
      'Cookie': cookieStr
    };

    // 获取文件大小
    const headReq = (reqUrl, cb) => {
      const c = reqUrl.startsWith('https') ? https : http;
      c.get(reqUrl, { headers: { ...reqHeaders, 'Range': 'bytes=0-0' }, timeout: 30000, family: 4 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          headReq(res.headers.location, cb);
          return;
        }
        const range = res.headers['content-range'] || '';
        const total = parseInt(range.split('/')[1], 10) || parseInt(res.headers['content-length'] || '0', 10) || 0;
        res.resume();
        cb(null, total);
      }).on('error', cb).on('timeout', function() { this.destroy(); cb(new Error('获取文件大小超时')); });
    };

    // 下载单个分块
    const downloadChunk = (reqUrl, start, end, cb) => {
      const headers = { ...reqHeaders, 'Range': 'bytes=' + start + '-' + end };
      const c = reqUrl.startsWith('https') ? https : http;
      c.get(reqUrl, { headers, timeout: 120000, family: 4 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadChunk(res.headers.location, start, end, cb);
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          cb(new Error('HTTP ' + res.statusCode));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
        res.on('error', cb);
      }).on('error', cb).on('timeout', function() { this.destroy(); cb(new Error('分块下载超时')); });
    };

    headReq(url, (err, total) => {
      if (err) return reject(err);
      if (total === 0) {
        // 无法获取大小，回退到整体下载
        console.log('[download] 无法获取文件大小，尝试整体下载');
        return downloadWhole(url, destPath, reqHeaders, onProgress, resolve, reject);
      }

      console.log(`[download] 文件大小: ${(total / 1024 / 1024).toFixed(1)}MB, 分块大小: ${CHUNK_SIZE / 1024 / 1024}MB`);

      const fileStream = fs.createWriteStream(destPath);
      let downloaded = 0;

      const downloadNext = (chunkIndex) => {
        const start = chunkIndex * CHUNK_SIZE;
        if (start >= total) {
          fileStream.end();
          if (onProgress) onProgress({ percent: 100, bytesDone: downloaded, bytesTotal: total, speed: 0, eta: 0 });
          return resolve({ bytesTotal: total, filePath: destPath });
        }

        const end = Math.min(start + CHUNK_SIZE - 1, total - 1);

        const tryDownload = (attempt) => {
          downloadChunk(url, start, end, (err, buf) => {
            if (err) {
              if (attempt < 3) {
                console.log(`[download] 分块 ${chunkIndex} 失败，重试 ${attempt + 1}/3:`, err.message);
                setTimeout(() => tryDownload(attempt + 1), 2000 * attempt);
                return;
              }
              fileStream.end();
              return reject(new Error(`分块 ${chunkIndex} 下载失败: ${err.message}`));
            }

            fileStream.write(buf);
            downloaded += buf.length;

            if (onProgress) {
              const now = Date.now();
              const timeDiff = (now - lastTime) / 1000;
              if (timeDiff >= 0.3) {
                const speed = (downloaded - lastBytes) / timeDiff;
                const percent = Math.round(downloaded / total * 100);
                const eta = speed > 0 ? Math.round((total - downloaded) / speed) : 0;
                onProgress({ percent, bytesDone: downloaded, bytesTotal: total, speed, eta });
                lastTime = now;
                lastBytes = downloaded;
              }
            }

            downloadNext(chunkIndex + 1);
          });
        };

        tryDownload(0);
      };

      downloadNext(0);
    });
  });
}

/**
 * 整体下载（当无法获取文件大小时的回退方案）
 */
function downloadWhole(url, destPath, headers, onProgress, resolve, reject) {
  const c = url.startsWith('https') ? https : http;
  const fileStream = fs.createWriteStream(destPath);
  let downloaded = 0;
  let lastTime = Date.now();
  let lastBytes = 0;

  c.get(url, { headers, timeout: 60000, family: 4 }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      downloadWhole(res.headers.location, destPath, headers, onProgress, resolve, reject);
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      fileStream.end();
      return reject(new Error('HTTP ' + res.statusCode));
    }

    res.on('data', chunk => {
      fileStream.write(chunk);
      downloaded += chunk.length;

      const now = Date.now();
      if (now - lastTime >= 500) {
        const speed = (downloaded - lastBytes) / ((now - lastTime) / 1000);
        if (onProgress) onProgress({ percent: 0, bytesDone: downloaded, bytesTotal: downloaded, speed, eta: 0 });
        lastTime = now;
        lastBytes = downloaded;
      }
    });

    res.on('end', () => {
      fileStream.end();
      if (onProgress) onProgress({ percent: 100, bytesDone: downloaded, bytesTotal: downloaded, speed: 0, eta: 0 });
      resolve({ bytesTotal: downloaded, filePath: destPath });
    });

    res.on('error', (err) => {
      fileStream.end();
      reject(err);
    });
  }).on('error', (err) => {
    fileStream.end();
    reject(err);
  }).on('timeout', function() {
    this.destroy();
    fileStream.end();
    reject(new Error('下载超时'));
  });
}

/**
 * Pass 1: 使用原生 HTTP 分块下载（内存友好）
 */
async function downloadViaAPI(context, videoUrl, destPath, onProgress) {
  const tmp = tmpPath(destPath);
  const startTime = Date.now();
  
  try {
    const cookieStr = await getCookieString(context);
    
    // 动态超时：每MB给10秒，最少5分钟
    const timeoutPromise = new Promise((_, reject) => {
      const maxTime = 1800000; // 30分钟绝对上限
      setTimeout(() => reject(new Error('下载超时 (30分钟)')), maxTime);
    });

    const downloadPromise = downloadFileNative(videoUrl, tmp, cookieStr, onProgress);
    
    const result = await Promise.race([downloadPromise, timeoutPromise]);
    
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    fs.renameSync(tmp, destPath);
    const size = fs.statSync(destPath).size;
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[download] 完成: ${(size / 1024 / 1024).toFixed(1)}MB, 耗时 ${elapsed}s`);
    
    return { bytesTotal: size, filePath: destPath };
  } catch (e) {
    console.log('[download] failed:', e.message);
    throw e;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Pass 2: 页面拦截模式（回退方案）
 */
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

    // Wait up to 60s for CDN response (increased from 25s)
    for (let i = 0; i < 120 && !cdnDone; i++) {
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

  // Pass 1: Try native HTTP download for each URL
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
