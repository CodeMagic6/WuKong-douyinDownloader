const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getCookieHeader } = require('./cookie-manager');

function getModule(url) {
  return url.startsWith('https') ? https : http;
}

async function downloadVideo(context, videoUrl, destPath, onProgress, noCookies) {
  const cookieStr = noCookies ? '' : await getCookieHeader(context);
  const maxRedirects = 5;

  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    function doDownload(url) {
      const mod = getModule(url);
      const headers = {
        'Referer': 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (cookieStr) headers['Cookie'] = cookieStr;

      // Check for partial download resume (delete stale locked files first)
      let resumeOffset = 0;
      let fileWriteStream = null;
      let fileOpenMode = 'w';
      if (fs.existsSync(destPath)) {
        try {
          const stat = fs.statSync(destPath);
          if (stat.size > 0) {
            resumeOffset = stat.size;
            headers['Range'] = `bytes=${resumeOffset}-`;
            fileOpenMode = 'a';
          }
        } catch {
          // Can't stat — delete and start fresh
          try { fs.unlinkSync(destPath); } catch {}
        }
      }

      const req = mod.get(url, { headers, timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          redirectCount++;
          if (redirectCount > maxRedirects) {
            return reject(new Error('Too many redirects'));
          }
          const location = res.headers.location;
          if (!location) return reject(new Error('Redirect with no Location'));
          // Handle relative redirect
          const resolved = location.startsWith('http') ? location : new URL(location, url).href;
          return doDownload(resolved);
        }

        if (res.statusCode === 206) {
          // Partial content — resume
          fileOpenMode = 'a';
        } else if (res.statusCode !== 200) {
          res.resume();
          if (cookieStr && (res.statusCode === 403 || res.statusCode === 431)) {
            return reject(new Error('CDN rejected cookies, retry without'));
          }
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10) + (fileOpenMode === 'a' ? (resumeOffset || 0) : 0);
        let bytesDone = fileOpenMode === 'a' ? (resumeOffset || 0) : 0;
        let lastUpdate = Date.now();
        let lastBytes = 0;

        try {
          fileWriteStream = fs.createWriteStream(destPath, { flags: fileOpenMode });
        } catch (e2) {
          // EPERM — stale locked file, wait+retry (Windows Defender race)
          if (e2.code === 'EPERM' || e2.code === 'EACCES') {
            const _sb = new SharedArrayBuffer(4);
            const _ia = new Int32Array(_sb);
            let retried = false;
            for (let w = 0; w < 5; w++) {
              try { fs.unlinkSync(destPath); } catch {}
              try { Atomics.wait(_ia, 0, 0, 500); } catch {}
              try { fileWriteStream = fs.createWriteStream(destPath, { flags: 'w' }); retried = true; break; } catch {}
            }
            if (!retried) throw e2;
          } else {
            throw e2;
          }
        }
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
          fileWriteStream.close();
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

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (let i = 0; i < urls.length; i++) {
      try {
        return await downloadVideo(context, urls[i], destPath, onProgress);
      } catch (e) {
        lastError = e;
        if (fs.existsSync(destPath)) {
          try { fs.unlinkSync(destPath); } catch {}
        }
        if (e.message === 'CDN rejected cookies, retry without') {
          try {
            return await downloadVideo(context, urls[i], destPath, onProgress, true);
          } catch (e2) {
            lastError = e2;
            if (fs.existsSync(destPath)) {
              try { fs.unlinkSync(destPath); } catch {}
            }
          }
        }
      }
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // All direct HTTP failed — fall back: download via browser (uses full cookie jar)
  try { return await downloadViaBrowser(context, urls[0], destPath, onProgress); } catch(e) { throw lastError; }
}

async function downloadViaBrowser(context, videoUrl, destPath, onProgress) {
  let page = null;
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
    fs.writeFileSync(destPath, Buffer.from(matches[1], 'base64'));
    const size = fs.statSync(destPath).size;
    if (onProgress) {
      onProgress({ percent: 100, bytesDone: size, bytesTotal: size, speed: 0, eta: 0 });
    }
    return { bytesTotal: size, filePath: destPath };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = { downloadVideo, downloadWithRetry };
