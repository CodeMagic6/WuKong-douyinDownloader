const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getCookieHeader } = require('./cookie-manager');

function getModule(url) {
  return url.startsWith('https') ? https : http;
}

function tmpPath(dest) {
  return dest + '.tmp';
}

async function downloadVideo(context, videoUrl, destPath, onProgress, noCookies) {
  const cookieStr = noCookies ? '' : await getCookieHeader(context);
  const tmp = tmpPath(destPath);
  const maxRedirects = 5;

  console.log('[download] start url:', (videoUrl || '').substring(0, 80), 'dest:', path.basename(destPath), 'noCookies:', !!noCookies);

  // Clean stale .tmp if present
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}

  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    function doDownload(url) {
      const mod = getModule(url);
      const headers = {
        'Referer': 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (cookieStr) headers['Cookie'] = cookieStr;

      let fileWriteStream = null;
      let fd = null;
      let fdOpen = false;

      function closeFd() {
        if (fdOpen && fd !== null) {
          try { fs.closeSync(fd); } catch {}
          fdOpen = false;
        }
      }

      function cleanupAndReject(msg) {
        closeFd();
        reject(msg);
      }

      const req = mod.get(url, { headers, timeout: 10000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          console.log('[download] redirect', res.statusCode, 'to:', (res.headers.location || '').substring(0, 60));
          redirectCount++;
          if (redirectCount > maxRedirects) {
            return reject(new Error('Too many redirects'));
          }
          const location = res.headers.location;
          if (!location) return reject(new Error('Redirect with no Location'));
          const resolved = location.startsWith('http') ? location : new URL(location, url).href;
          return doDownload(resolved);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          console.log('[download] non-200:', res.statusCode, 'url:', url.substring(0, 60));
          if (cookieStr && (res.statusCode === 403 || res.statusCode === 431)) {
            return reject(new Error('CDN rejected cookies, retry without'));
          }
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        console.log('[download] 200 OK, content-length:', totalBytes, 'url:', url.substring(0, 60));
        let bytesDone = 0;
        let lastUpdate = Date.now();
        let lastBytes = 0;
        let firstByteTimer = null;

        // No-progress timeout — abort if first byte or data stalled 15s
        function resetStallTimer() {
          if (firstByteTimer) clearTimeout(firstByteTimer);
          firstByteTimer = setTimeout(function() {
            req.destroy();
            cleanupAndReject(new Error('下载停滞 (15s 无数据)'));
          }, 15000);
        }
        resetStallTimer();

        // Open fd manually so we can fsync before rename
        try { fd = fs.openSync(tmp, 'w'); fdOpen = true; } catch (e) { return reject(e); }
        fileWriteStream = fs.createWriteStream(tmp, { fd, autoClose: false });
        fileWriteStream.on('error', (e) => cleanupAndReject(e));

        res.on('data', (chunk) => {
          resetStallTimer(); // data arrived, reset stall timer
          bytesDone += chunk.length;
          const now = Date.now();
          const elapsed = now - lastUpdate;
          if (elapsed >= 200) {
            const speed = (bytesDone - lastBytes) / (elapsed / 1000);
            const remaining = totalBytes - bytesDone;
            const eta = speed > 0 ? remaining / speed : 0;
            if (onProgress) {
              onProgress({
                bytesDone,
                bytesTotal: totalBytes || bytesDone,
                speed,
                eta,
                percent: totalBytes ? Math.min(100, (bytesDone / totalBytes) * 100) : 0
              });
            }
            lastUpdate = now;
            lastBytes = bytesDone;
          }
        });

        res.on('error', (e) => cleanupAndReject(e));
        res.pipe(fileWriteStream);

        fileWriteStream.on('finish', () => {
          if (firstByteTimer) clearTimeout(firstByteTimer);
          fdOpen = false; // about to close
          // fsync before close: ensure data on disk before rename
          try { fs.fsyncSync(fd); } catch (e) { closeFd(); return reject(e); }
          try { fs.closeSync(fd); } catch (e) { return reject(e); }
          // Rename .tmp → .mp4
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.renameSync(tmp, destPath);
          } catch (e) {
            // If .tmp was deleted externally (user deleted while downloading),
            // don't retry — it'll just fail again
            if (!fs.existsSync(tmp)) {
              return reject(new Error('文件写入失败: 临时文件已被外部删除'));
            }
            return reject(e);
          }
          resolve({
            bytesTotal: bytesDone,
            filePath: destPath
          });
        });
      });

      req.on('error', (e) => cleanupAndReject(e));
      req.on('timeout', () => {
        req.destroy();
        cleanupAndReject(new Error('Download timeout (10s)'));
      });
    }

    doDownload(videoUrl);
  });
}

async function downloadWithRetry(context, urls, destPath, onProgress, maxRetries = 3) {
  let lastError;
  const tmp = tmpPath(destPath);

  // Phase 1: try direct HTTP with total deadline (covers DNS/TCP/TLS stall)
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (let i = 0; i < urls.length; i++) {
      try {
        const result = await Promise.race([
          downloadVideo(context, urls[i], destPath, onProgress),
          new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP 请求超时 (15s 无响应)')), 15000))
        ]);
        if (!fs.existsSync(destPath) || fs.existsSync(tmp)) {
          throw new Error('文件写入失败: 重命名后验证不通过');
        }
        return result;
      } catch (e) {
        console.log('[download] HTTP attempt', attempt, 'url', i, 'failed:', e.message);
        lastError = e;
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        // CDN 403 — retry this URL without cookies
        if (e.message === 'CDN rejected cookies, retry without' || e.message.startsWith('HTTP 403')) {
          console.log('[download] retry without cookies for:', path.basename(destPath));
          try {
            const result = await Promise.race([
              downloadVideo(context, urls[i], destPath, onProgress, true),
              new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP 请求超时 (15s 无响应)')), 15000))
            ]);
            if (!fs.existsSync(destPath) || fs.existsSync(tmp)) throw 'verify';
            return result;
          } catch (e2) {
            lastError = e2;
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          }
        }
        // Timeout or other error — try next URL/attempt
      }
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Phase 2: browser download (handles auth, WAF, IP blocks)
  console.log('[download] HTTP failed, browser download for:', path.basename(destPath));
  try {
    const result = await downloadViaBrowser(context, urls[0], destPath, onProgress);
    if (!fs.existsSync(destPath) || fs.existsSync(tmp)) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      throw new Error('文件写入失败: 重命名后验证不通过');
    }
    return result;
  } catch(e) {
    // Throw original HTTP error if browser also fails (gives more context)
    if (lastError && lastError.message && !e.message.includes('浏览器')) throw lastError;
    throw e;
  }
}

async function downloadViaBrowser(context, videoUrl, destPath, onProgress) {
  let page = null;
  const tmp = tmpPath(destPath);
  try {
    page = await context.newPage();
    await page.goto('https://www.douyin.com/', {
      waitUntil: 'domcontentloaded', timeout: 15000
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    console.log('[download] browser fallback, url:', (videoUrl || '').substring(0, 60));
    const escapedUrl = videoUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await Promise.race([
      page.evaluate(`(async function() {
        const res = await fetch('${escapedUrl}', { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var buf = await res.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      })()`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器下载超时 (15s)')), 15000))
    ]);

    if (!Array.isArray(result) || result.length === 0) throw new Error('Browser download returned empty');
    // Write to .tmp, then rename
    fs.writeFileSync(tmp, Buffer.from(result));
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    fs.renameSync(tmp, destPath);
    const size = fs.statSync(destPath).size;
    console.log('[download] browser fallback success:', path.basename(destPath), size, 'bytes');
    if (onProgress) {
      onProgress({ percent: 100, bytesDone: size, bytesTotal: size, speed: 0, eta: 0 });
    }
    return { bytesTotal: size, filePath: destPath };
  } catch (e) {
    // Clean up orphaned .tmp on failure
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = { downloadVideo, downloadWithRetry };
