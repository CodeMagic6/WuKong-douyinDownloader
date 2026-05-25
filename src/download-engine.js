const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function tmpPath(dest) {
  return dest + '.tmp';
}

/** Primary download: use browser network stack (handles auth, WAF, IP blocks) */
async function downloadViaBrowser(context, videoUrl, destPath, onProgress) {
  let page = null;
  const tmp = tmpPath(destPath);
  try {
    page = await context.newPage();
    // Set referer so CDN serves the video (many check douyin.com referer)
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.douyin.com/' });
    console.log('[download] browser goto:', (videoUrl || '').substring(0, 80));

    // Navigate directly to video URL. cookies from context included automatically.
    // 'commit' fires as soon as server responds with headers — no wait for full load.
    const resp = await page.goto(videoUrl, {
      waitUntil: 'commit',
      timeout: 30000
    });
    if (!resp) throw new Error('no response');

    const totalBytes = parseInt(resp.headers()['content-length'] || '0', 10);
    console.log('[download] response OK, content-length:', totalBytes);

    if (onProgress) {
      onProgress({ percent: 0, bytesDone: 0, bytesTotal: totalBytes || 1, speed: 0, eta: 0 });
    }
    const buf = await resp.body();

    fs.writeFileSync(tmp, buf);
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    fs.renameSync(tmp, destPath);
    const size = fs.statSync(destPath).size;
    console.log('[download] browser success:', path.basename(destPath), size, 'bytes');
    if (onProgress) {
      onProgress({ percent: 100, bytesDone: size, bytesTotal: size, speed: 0, eta: 0 });
    }
    return { bytesTotal: size, filePath: destPath };
  } catch (e) {
    console.log('[download] browser goto failed:', e.message);
    // Fallback: page.evaluate fetch (without goto douyin.com)
    try {
      if (page) await page.close().catch(() => {});
      page = await context.newPage();
      await page.setExtraHTTPHeaders({ 'Referer': 'https://www.douyin.com/' });
      console.log('[download] browser fetch fallback, url:', (videoUrl || '').substring(0, 60));
      const escapedUrl = videoUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const result = await Promise.race([
        page.evaluate(`(async function() {
          const res = await fetch('${escapedUrl}', { credentials: 'include' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var buf = await res.arrayBuffer();
          return Array.from(new Uint8Array(buf));
        })()`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器下载超时 (30s)')), 30000))
      ]);
      if (!Array.isArray(result) || result.length === 0) throw new Error('empty');
      fs.writeFileSync(tmp, Buffer.from(result));
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      fs.renameSync(tmp, destPath);
      const size2 = fs.statSync(destPath).size;
      console.log('[download] browser fetch fallback success:', path.basename(destPath), size2, 'bytes');
      if (onProgress) {
        onProgress({ percent: 100, bytesDone: size2, bytesTotal: size2, speed: 0, eta: 0 });
      }
      return { bytesTotal: size2, filePath: destPath };
    } catch (e2) {
      throw e2;
    }
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
