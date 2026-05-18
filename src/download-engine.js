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

      const req = mod.get(url, { headers, timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
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
          if (cookieStr && (res.statusCode === 403 || res.statusCode === 431)) {
            return reject(new Error('CDN rejected cookies, retry without'));
          }
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let bytesDone = 0;
        let lastUpdate = Date.now();
        let lastBytes = 0;

        // Open fd manually so we can fsync before rename
        try { fd = fs.openSync(tmp, 'w'); } catch (e) { return reject(e); }
        fileWriteStream = fs.createWriteStream(tmp, { fd, autoClose: false });
        fileWriteStream.on('error', reject);

        res.on('data', (chunk) => {
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

        res.pipe(fileWriteStream);

        fileWriteStream.on('finish', () => {
          // fsync before close: ensure data on disk before rename
          try { fs.fsyncSync(fd); } catch (e) { return reject(e); }
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

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Download timeout (60s)'));
      });
    }

    doDownload(videoUrl);
  });
}

async function downloadWithRetry(context, urls, destPath, onProgress, maxRetries = 3) {
  let lastError;
  const tmp = tmpPath(destPath);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (let i = 0; i < urls.length; i++) {
      try {
        const result = await downloadVideo(context, urls[i], destPath, onProgress);
        // Verify: .mp4 must exist, .tmp must be gone
        if (!fs.existsSync(destPath) || fs.existsSync(tmp)) {
          throw new Error('文件写入失败: 重命名后验证不通过');
        }
        return result;
      } catch (e) {
        lastError = e;
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        if (e.message === 'CDN rejected cookies, retry without') {
          try {
            const result = await downloadVideo(context, urls[i], destPath, onProgress, true);
            if (!fs.existsSync(destPath) || fs.existsSync(tmp)) {
              throw new Error('文件写入失败: 重命名后验证不通过');
            }
            return result;
          } catch (e2) {
            lastError = e2;
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          }
        }
      }
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // All direct HTTP failed — fall back: download via browser
  try {
    const result = await downloadViaBrowser(context, urls[0], destPath, onProgress);
    if (!fs.existsSync(destPath) || fs.existsSync(tmp)) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      throw new Error('文件写入失败: 重命名后验证不通过');
    }
    return result;
  } catch(e) {
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

    const escapedUrl = videoUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await page.evaluate(`(async function() {
      const res = await fetch('${escapedUrl}', { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      return await new Promise(function(resolve) {
        var reader = new FileReader();
        reader.onload = function() { resolve(reader.result); };
        reader.readAsDataURL(blob);
      });
    })()`);

    const matches = result.match(/^data:.*?;base64,(.+)$/);
    if (!matches) throw new Error('Failed to decode browser download');
    // Write to .tmp, then rename
    fs.writeFileSync(tmp, Buffer.from(matches[1], 'base64'));
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    fs.renameSync(tmp, destPath);
    const size = fs.statSync(destPath).size;
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
