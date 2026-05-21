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

  // Clean stale .tmp
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}

  return new Promise((resolve, reject) => {
    const mod = getModule(videoUrl);
    const headers = {
      'Referer': 'https://www.douyin.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (cookieStr) headers['Cookie'] = cookieStr;

    const req = mod.get(videoUrl, { headers, timeout: 30000 }, (res) => {
      // Handle redirect
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect with no Location'));
        const resolved = location.startsWith('http') ? location : new URL(location, videoUrl).href;
        // Re-download with resolved URL, same context/cookie params
        resolve(downloadVideo(context, resolved, destPath, onProgress, noCookies));
        return;
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        if (cookieStr && (res.statusCode === 403 || res.statusCode === 431)) {
          return reject(new Error('CDN rejected cookies, retry without'));
        }
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let bytesDone = 0;
      let lastUpdate = Date.now();
      let lastBytes = 0;
      let stallTimer = null;

      function resetStallTimer() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          req.destroy();
          reject(new Error('下载停滞 (30s 无数据)'));
        }, 30000);
      }
      resetStallTimer();

      let fd;
      try { fd = fs.openSync(tmp, 'w'); } catch (e) { return reject(e); }
      const ws = fs.createWriteStream(tmp, { fd, autoClose: false });

      ws.on('error', (e) => {
        try { fs.closeSync(fd); } catch {}
        reject(e);
      });

      res.on('data', (chunk) => {
        resetStallTimer();
        bytesDone += chunk.length;
        const now = Date.now();
        if (now - lastUpdate >= 200) {
          const speed = (bytesDone - lastBytes) / ((now - lastUpdate) / 1000);
          if (onProgress) {
            onProgress({
              bytesDone,
              bytesTotal: totalBytes || bytesDone,
              speed,
              eta: speed > 0 ? (totalBytes - bytesDone) / speed : 0,
              percent: totalBytes ? Math.min(100, (bytesDone / totalBytes) * 100) : 0
            });
          }
          lastUpdate = now;
          lastBytes = bytesDone;
        }
      });

      res.on('error', (e) => {
        try { fs.closeSync(fd); } catch {}
        reject(e);
      });

      res.pipe(ws);

      ws.on('finish', () => {
        if (stallTimer) clearTimeout(stallTimer);
        try { fs.fsyncSync(fd); } catch (e) { try { fs.closeSync(fd); } catch {} return reject(e); }
        try { fs.closeSync(fd); } catch (e) { return reject(e); }
        try {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          fs.renameSync(tmp, destPath);
        } catch (e) {
          if (!fs.existsSync(tmp)) return reject(new Error('临时文件已被外部删除'));
          return reject(e);
        }
        resolve({ bytesTotal: bytesDone, filePath: destPath });
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout (30s)'));
    });
  });
}

async function downloadWithRetry(context, urls, destPath, onProgress, maxRetries = 3) {
  const tmp = tmpPath(destPath);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const url of urls) {
      try {
        const result = await downloadVideo(context, url, destPath, onProgress);
        if (!fs.existsSync(destPath) || fs.existsSync(tmp)) {
          throw new Error('文件写入验证失败');
        }
        return result;
      } catch (e) {
        // CDN 403 — retry without cookies
        if (e.message === 'CDN rejected cookies, retry without' || e.message.startsWith('HTTP 403')) {
          try {
            const result = await downloadVideo(context, url, destPath, onProgress, true);
            if (!fs.existsSync(destPath) || fs.existsSync(tmp)) throw new Error('verify');
            return result;
          } catch {}
        }
      }
      // Clean partial files
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Browser fallback (handles WAF / IP block)
  console.log('[download] HTTP failed, browser download for:', path.basename(destPath));
  return await downloadViaBrowser(context, urls[0], destPath, onProgress);
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

    const escapedUrl = videoUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await Promise.race([
      page.evaluate(`(async function() {
        const res = await fetch('${escapedUrl}', { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      })()`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器下载超时 (30s)')), 30000))
    ]);

    if (!Array.isArray(result) || result.length === 0) throw new Error('Browser download returned empty');
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
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = { downloadVideo, downloadWithRetry };
