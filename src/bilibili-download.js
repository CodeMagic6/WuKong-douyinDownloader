const fs = require('fs');
const path = require('path');
const { getContext } = require('./browser');

const BILIBILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Origin': 'https://www.bilibili.com'
};

function tmpPath(dest) { return dest + '.tmp'; }

async function downloadViaBrowserFetch(context, url, destPath, onProgress) {
  const tmp = tmpPath(destPath);
  try {
    const resp = await context.request.fetch(url, {
      method: 'GET',
      headers: BILIBILI_HEADERS,
      timeout: 0,
      failOnStatusCode: false
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
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

async function downloadBilibiliVideo(playUrlData, destPath, onProgress) {
  const context = await getContext();
  if (!context) throw new Error('Browser context not available');

  if (playUrlData.type === 'mp4') {
    return await downloadViaBrowserFetch(context, playUrlData.url, destPath, onProgress);
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

    return await downloadViaBrowserFetch(context, videoUrl, destPath, onProgress);
  }

  throw new Error('未知的播放地址格式');
}

module.exports = { downloadBilibiliVideo };
