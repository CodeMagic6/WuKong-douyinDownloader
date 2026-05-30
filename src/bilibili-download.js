const fs = require('fs');
const https = require('https');
const http = require('http');
const { getContext } = require('./browser');

const BILIBILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Origin': 'https://www.bilibili.com'
};

function tmpPath(dest) { return dest + '.tmp'; }

function downloadFileNative(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const reqHeaders = { ...BILIBILI_HEADERS };

    const doRequest = (reqUrl, redirectCount) => {
      if (redirectCount > 5) return reject(new Error('重定向次数过多'));

      const c = reqUrl.startsWith('https') ? https : http;
      c.get(reqUrl, { headers: reqHeaders, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          doRequest(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }

        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let downloaded = 0;
        let lastTime = Date.now();
        let lastBytes = 0;
        let lastLogTime = 0;

        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          fileStream.write(chunk);

          if (onProgress) {
            const now = Date.now();
            const timeDiff = (now - lastTime) / 1000;
            if (timeDiff >= 1) {
              const speed = (downloaded - lastBytes) / timeDiff;
              const percent = total ? (downloaded / total * 100) : 0;
              const eta = speed > 0 ? (total - downloaded) / speed : 0;
              onProgress({ percent, bytesDone: downloaded, bytesTotal: total, speed, eta });
              lastTime = now;
              lastBytes = downloaded;
            }
            // Log every 30 seconds
            if (now - lastLogTime > 30000) {
              console.log('[bilibili-download]', (downloaded / 1024 / 1024).toFixed(1) + 'MB / ' + (total / 1024 / 1024).toFixed(1) + 'MB');
              lastLogTime = now;
            }
          }
        });

        res.on('end', () => {
          fileStream.end();
          console.log('[bilibili-download] done:', (downloaded / 1024 / 1024).toFixed(1) + 'MB');
          if (onProgress) {
            onProgress({ percent: 100, bytesDone: downloaded, bytesTotal: total || downloaded, speed: 0, eta: 0 });
          }
          resolve({ bytesTotal: total || downloaded });
        });

        res.on('error', (e) => {
          console.error('[bilibili-download] stream error:', e.message, 'downloaded:', (downloaded / 1024 / 1024).toFixed(1) + 'MB');
          fileStream.end();
          reject(e);
        });
      }).on('error', (e) => {
        console.error('[bilibili-download] request error:', e.message);
        reject(e);
      }).on('timeout', function() {
        console.error('[bilibili-download] connection timeout');
        this.destroy();
        reject(new Error('连接超时'));
      });
    };

    doRequest(url, 0);
  });
}

async function downloadBilibiliVideo(playUrlData, destPath, onProgress) {
  const tmp = tmpPath(destPath);

  const doDownload = async (url) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
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
