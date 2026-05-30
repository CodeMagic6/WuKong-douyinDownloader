const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');

const bilibiliCookieFile = path.join(os.homedir(), '.claude', 'bilibili_cookies.json');

function getBilibiliCookieHeader() {
  try {
    const raw = fs.readFileSync(bilibiliCookieFile, 'utf-8');
    const cookies = JSON.parse(raw);
    return cookies.map(c => c.name + '=' + c.value).join('; ');
  } catch {}
  return '';
}

const BILIBILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Origin': 'https://www.bilibili.com'
};

function tmpPath(dest) { return dest + '.tmp'; }

function downloadFileNative(url, destPath, onProgress) {
  const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per chunk

  return new Promise((resolve, reject) => {
    const reqHeaders = { ...BILIBILI_HEADERS, 'Cookie': getBilibiliCookieHeader() };

    // First request to get total size
    const headReq = (reqUrl, cb) => {
      const c = reqUrl.startsWith('https') ? https : http;
      c.get(reqUrl, { headers: { ...reqHeaders, 'Range': 'bytes=0-0' }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          headReq(res.headers.location, cb);
          return;
        }
        const range = res.headers['content-range'] || '';
        const total = parseInt(range.split('/')[1], 10) || parseInt(res.headers['content-length'] || '0', 10) || 0;
        res.resume();
        cb(null, total);
      }).on('error', cb);
    };

    const downloadChunk = (reqUrl, start, end, cb) => {
      const headers = { ...reqHeaders, 'Range': 'bytes=' + start + '-' + end };
      const c = reqUrl.startsWith('https') ? https : http;
      c.get(reqUrl, { headers, timeout: 60000 }, (res) => {
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
      }).on('error', cb).on('timeout', function() { this.destroy(); cb(new Error('timeout')); });
    };

    headReq(url, (err, total) => {
      if (err) return reject(err);
      if (total === 0) return reject(new Error('无法获取文件大小'));

      const fs = require('fs');
      // Check existing file size for resume
      let existingSize = 0;
      if (fs.existsSync(destPath)) {
        try { existingSize = fs.statSync(destPath).size; } catch {}
      }
      const fileStream = fs.createWriteStream(destPath, { flags: existingSize > 0 ? 'a' : 'w' });
      let downloaded = existingSize;
      let lastTime = Date.now();
      let lastBytes = downloaded;

      const downloadNext = (chunkIndex) => {
        const start = chunkIndex * CHUNK_SIZE;
        if (start >= total) {
          fileStream.end();
          if (onProgress) onProgress({ percent: 100, bytesDone: downloaded, bytesTotal: total, speed: 0, eta: 0 });
          return resolve({ bytesTotal: total });
        }

        // Skip chunks that are already downloaded
        if (start < existingSize) {
          downloadNext(chunkIndex + 1);
          return;
        }

        const end = Math.min(start + CHUNK_SIZE - 1, total - 1);

        const tryDownload = (attempt) => {
          downloadChunk(url, start, end, (err, buf) => {
            if (err) {
              if (attempt < 3) {
                setTimeout(() => tryDownload(attempt + 1), 1000);
                return;
              }
              fileStream.end();
              return reject(err);
            }

            fileStream.write(buf);
            downloaded += buf.length;

            if (onProgress) {
              const now = Date.now();
              const timeDiff = (now - lastTime) / 1000;
              if (timeDiff >= 0.5) {
                const speed = (downloaded - lastBytes) / timeDiff;
                const percent = (downloaded / total * 100);
                const eta = speed > 0 ? (total - downloaded) / speed : 0;
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

async function downloadBilibiliVideo(playUrlData, destPath, onProgress) {
  const tmp = tmpPath(destPath);

  const doDownload = async (url) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await downloadFileNative(url, tmp, onProgress);
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        fs.renameSync(tmp, destPath);
        return { bytesTotal: result.bytesTotal, filePath: destPath };
      } catch (e) {
        console.log('[bilibili-download] attempt', attempt + 1, 'failed:', e.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  };

  if (playUrlData.type === 'mp4') {
    return await doDownload(playUrlData.url);
  }

  if (playUrlData.type === 'dash') {
    const videoStreams = playUrlData.video;
    if (!videoStreams || videoStreams.length === 0) {
      throw new Error('没有可用的视频流');
    }

    const bestVideo = videoStreams.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    const videoUrl = bestVideo.baseUrl || bestVideo.base_url;

    if (onProgress) {
      onProgress({ percent: 0, bytesDone: 0, bytesTotal: 0, speed: 0, eta: 0 });
    }

    return await doDownload(videoUrl);
  }

  throw new Error('未知的播放地址格式');
}

module.exports = { downloadBilibiliVideo };
