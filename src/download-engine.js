const fs = require('fs');
const path = require('path');

function tmpPath(dest) {
  return dest + '.tmp';
}

/** Primary download: use browser fetch API (handles auth, WAF, IP blocks, cookies) */
async function downloadViaBrowser(context, videoUrl, destPath, onProgress) {
  let page = null;
  const tmp = tmpPath(destPath);
  try {
    page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.douyin.com/' });
    // Navigate so page has proper origin/cookies in its realm for fetch
    await page.goto('https://www.douyin.com/', {
      waitUntil: 'domcontentloaded', timeout: 10000
    }).catch(() => {});

    console.log('[download] browser fetch url:', (videoUrl || '').substring(0, 80));

    const escapedUrl = videoUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await Promise.race([
      page.evaluate(`(async function() {
        try {
          var res = await fetch('${escapedUrl}', {
            credentials: 'include',
            headers: { 'Referer': 'https://www.douyin.com/' }
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var total = parseInt(res.headers.get('content-length') || '0', 10);
          var buf = await res.arrayBuffer();
          var bytes = new Uint8Array(buf);
          var len = bytes.length;
          // Chunked binary-string build → base64 (much faster than Array.from)
          var parts = [];
          for (var i = 0; i < len; i += 8192) {
            var end = Math.min(i + 8192, len);
            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, end)));
          }
          return { b64: btoa(parts.join('')), total: total || len };
        } catch(e) {
          return { error: e.message };
        }
      })()`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器下载超时 (120s)')), 120000))
    ]);

    if (!result || result.error) throw new Error(result?.error || 'empty response');
    if (!result.b64) throw new Error('empty data');

    if (onProgress) {
      onProgress({ percent: 0, bytesDone: 0, bytesTotal: result.total || 1, speed: 0, eta: 0 });
    }

    fs.writeFileSync(tmp, Buffer.from(result.b64, 'base64'));
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    fs.renameSync(tmp, destPath);
    const size = fs.statSync(destPath).size;
    console.log('[download] browser fetch success:', path.basename(destPath), size, 'bytes');
    if (onProgress) {
      onProgress({ percent: 100, bytesDone: size, bytesTotal: size, speed: 0, eta: 0 });
    }
    return { bytesTotal: size, filePath: destPath };
  } catch (e) {
    console.log('[download] browser fetch failed:', e.message);
    throw e;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function downloadWithRetry(context, urls, destPath, onProgress, maxRetries, refreshUrls) {
  const tmp = tmpPath(destPath);

  // Try each CDN URL via browser download until one succeeds
  const allUrls = [...urls];
  for (let attempt = 0; attempt < (maxRetries || 1); attempt++) {
    if (attempt > 0) {
      const fresh = refreshUrls ? (await refreshUrls().catch(() => null)) : null;
      if (fresh && fresh.length > 0) allUrls.push(...fresh);
    }
    for (const url of allUrls) {
      try {
        const result = await downloadViaBrowser(context, url, destPath, onProgress);
        if (!fs.existsSync(destPath) || fs.existsSync(tmp)) {
          throw new Error('文件写入失败: 重命名后验证不通过');
        }
        return result;
      } catch (e) {
        console.log('[download] attempt', attempt, 'failed:', e.message);
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      }
    }
  }
  throw new Error('所有下载方式均失败');
}

module.exports = { downloadViaBrowser, downloadWithRetry };
