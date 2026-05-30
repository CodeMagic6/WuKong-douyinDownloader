const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const { extractAwemeId, resolveShortUrl, isCollectionUrl, getCollectionLabel, isBilibiliUrl, extractBvid } = require('./url-utils');
const { extractVideoMetadata, getBestVideoUrl } = require('./video-api');
const { downloadWithRetry } = require('./download-engine');
const { makeFilename } = require('./filename-utils');
const { getVideoDownloadUrls } = require('./bilibili-api');
const { downloadBilibiliVideo } = require('./bilibili-download');
const { sleep } = require('./helpers');
const { extractCollectionWithProgress } = require('./collection-extractor');

function uid() {
  return crypto.randomUUID();
}

class QueueManager {
  constructor(maxConcurrent, sseBroadcaster) {
    this.maxConcurrent = maxConcurrent || config.maxConcurrent;
    this.sse = sseBroadcaster;
    this.items = [];
    this.running = 0;
    this.processing = false;
  }

  _addSingleItem(url) {
    const existing = this.items.find(i => i.url === url && ['pending', 'extracting', 'downloading'].includes(i.status));
    if (existing) return { id: existing.id, url, status: 'duplicate' };

    const isBili = isBilibiliUrl(url);
    const awemeId = isBili ? '' : extractAwemeId(url);
    const bvid = isBili ? extractBvid(url) : '';
    const item = {
      id: uid(),
      url,
      awemeId: awemeId || '',
      bvid: bvid || '',
      isBilibili: isBili,
      status: 'pending',
      progress: 0,
      speedBytesPerSec: 0,
      etaSec: 0,
      bytesDone: 0,
      bytesTotal: 0,
      filename: '',
      filePath: '',
      error: '',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      metadata: null,
      isCollection: false
    };
    this.items.push(item);
    return { id: item.id, url, status: 'pending' };
  }

  add(urls) {
    const results = [];
    for (const url of (Array.isArray(urls) ? urls : [urls])) {
      // Collection URLs get special handling
      if (isCollectionUrl(url)) {
        const label = getCollectionLabel(url);
        const placeholder = {
          id: uid(),
          url,
          awemeId: '',
          status: 'pending',
          progress: 0,
          speedBytesPerSec: 0,
          etaSec: 0,
          bytesDone: 0,
          bytesTotal: 0,
          filename: '',
          filePath: '',
          error: '',
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
          retryCount: 0,
          metadata: null,
          isCollection: true,
          collectionLabel: label,
          collectionFound: 0
        };
        this.items.push(placeholder);
        results.push({ id: placeholder.id, url, status: 'pending', isCollection: true, label });
      } else {
        results.push(this._addSingleItem(url));
      }
    }
    this._broadcastQueue();
    this._processQueue();
    return results;
  }

  cancel(id) {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    if (['downloading', 'extracting', 'pending'].includes(item.status)) {
      item.status = 'cancelled';
      item._cancelled = true;
      item.completedAt = Date.now();
      this._broadcastQueue();
      this.sse.broadcast('download_cancelled', { id });
    }
    return true;
  }

  remove(id) {
    const idx = this.items.findIndex(i => i.id === id);
    if (idx === -1) return false;
    if (['downloading'].includes(this.items[idx].status)) return false;
    // Mark cancelled if still processing, then remove
    if (this.items[idx].status === 'extracting') {
      this.items[idx]._cancelled = true;
    }
    this.items.splice(idx, 1);
    this._broadcastQueue();
    return true;
  }

  clearCompleted() {
    this.items = this.items.filter(i => ['pending', 'extracting', 'downloading'].includes(i.status));
    this._broadcastQueue();
  }

  getState() {
    return {
      items: this.items.map(i => ({ ...i })),
      running: this.running,
      pending: this.items.filter(i => i.status === 'pending').length,
      completed: this.items.filter(i => i.status === 'completed').length,
      errored: this.items.filter(i => i.status === 'error').length
    };
  }

  getItem(id) {
    return this.items.find(i => i.id === id) || null;
  }

  setConcurrency(n) {
    this.maxConcurrent = Math.max(1, Math.min(10, n));
  }

  getStats() {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();
    return {
      browserReady: false,
      cookieValid: false,
      queueRunning: this.items.some(i => ['extracting', 'downloading'].includes(i.status)),
      queueLength: this.items.length,
      downloadsToday: this.items.filter(i => i.status === 'completed' && (i.completedAt || 0) >= todayTs).length
    };
  }

  async _processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.running < this.maxConcurrent) {
      const item = this.items.find(i => i.status === 'pending');
      if (!item) break;

      this.running++;
      this._processItem(item)
        .catch(e => {
          console.error(`Queue error for ${item.id}:`, e.message);
          this._failItem(item, e.message);
        })
        .finally(() => {
          this.running--;
          setImmediate(() => this._processQueue());
        });
    }

    this.processing = false;
  }

  async _processItem(item) {
    // === Collection handling ===
    if (item.isCollection) {
      const label = item.collectionLabel || '合集';
      item.status = 'extracting';
      this._broadcastQueue();

      try {
        const videoIds = await extractCollectionWithProgress(
          item.url,
          (found, attempt) => {
            item.collectionFound = found;
            item.progress = Math.min(95, (attempt / 40) * 100);
            this.sse.broadcast('collection_progress', {
              id: item.id,
              label,
              found,
              attempt
            });
            this._broadcastQueue();
          },
          () => item._cancelled // abort check
        );

        if (item._cancelled) return;
        if (videoIds.length === 0) {
          return this._failItem(item, '未从合集中找到任何视频');
        }

        // Remove placeholder item
        const idx = this.items.indexOf(item);
        if (idx !== -1) this.items.splice(idx, 1);

        // Add individual video items
        const added = [];
        for (const vid of videoIds) {
          const videoUrl = `https://www.douyin.com/video/${vid}`;
          const r = this._addSingleItem(videoUrl);
          added.push(r);
        }

        this.sse.broadcast('collection_complete', {
          id: item.id,
          label,
          total: videoIds.length,
          added: added.length
        });
        this._broadcastQueue();
      } catch (e) {
        return this._failItem(item, `合集解析失败: ${e.message}`);
      }
      return;
    }

    // === Single video handling ===
    // Bilibili video handling
    if (item.isBilibili) {
      item.status = 'extracting';
      this._broadcastQueue();

      let videoData;
      try {
        if (!item.bvid) {
          throw new Error('无法从 URL 提取 BV 号');
        }
        videoData = await getVideoDownloadUrls(item.bvid);
        item.metadata = videoData.info;
      } catch (e) {
        return this._failItem(item, `B站视频解析失败: ${e.message}`);
      }

      await sleep(config.apiDelayMs);

      item.status = 'downloading';
      item.startedAt = Date.now();
      const safeTitle = (videoData.info.title || item.bvid).replace(/[\\/:*?"<>|]/g, '_').substring(0, 80);
      item.filename = `${videoData.info.author.name}_${safeTitle}_${item.bvid}.mp4`;
      try {
        item.filePath = path.join(config.downloadDir, item.filename);
      } catch {
        item.filePath = path.join(process.cwd(), 'downloads', item.filename);
      }
      this._broadcastQueue();

      try {
        const result = await downloadBilibiliVideo(
          videoData.playUrl,
          item.filePath,
          (progress) => {
            item.progress = progress.percent || 0;
            item.bytesDone = progress.bytesDone;
            item.bytesTotal = progress.bytesTotal;
            item.speedBytesPerSec = progress.speed || 0;
            item.etaSec = progress.eta || 0;
            this.sse.broadcast('download_progress', {
              id: item.id,
              percent: item.progress,
              speedBytesPerSec: item.speedBytesPerSec,
              etaSec: item.etaSec,
              bytesDone: item.bytesDone,
              bytesTotal: item.bytesTotal,
              status: 'downloading'
            });
          }
        );

        item.status = 'completed';
        item.progress = 100;
        item.bytesTotal = result.bytesTotal;
        item.completedAt = Date.now();
        this._broadcastQueue();
        this.sse.broadcast('download_complete', {
          id: item.id,
          awemeId: item.bvid,
          filename: item.filename,
          fileSize: result.bytesTotal,
          author: videoData.info.author.name,
          description: videoData.info.title,
          duration: videoData.info.duration,
          coverUrl: videoData.info.cover
        });
      } catch (e) {
        return this._failItem(item, `B站下载失败: ${e.message}`);
      }
      return;
    }

    // Douyin video handling
    // Step 1: Resolve short URL if needed
    if (!item.awemeId) {
      item.status = 'extracting';
      this._broadcastQueue();
      try {
        const resolved = await resolveShortUrl(item.url);
        item.awemeId = extractAwemeId(resolved) || '';
        if (!item.awemeId) throw new Error('无法从 URL 提取视频 ID');
      } catch (e) {
        return this._failItem(item, `URL 解析失败: ${e.message}`);
      }
    }

    // Step 2: Extract video metadata via Douyin API
    item.status = 'extracting';
    this._broadcastQueue();
    let videoInfo;
    try {
      videoInfo = await extractVideoMetadata(item.awemeId);
      item.metadata = videoInfo;
    } catch (e) {
      return this._failItem(item, e.message);
    }

    await sleep(config.apiDelayMs);

    // Step 3: Get download URLs
    const urls = getBestVideoUrl(videoInfo);
    if (!urls || urls.length === 0) {
      return this._failItem(item, '未找到视频下载地址');
    }

    // Step 4: Download video — stagger start to avoid CDN rate-limit pileup
    var stagger = this.running * 600; // 600ms per concurrent download
    if (stagger > 0) {
      console.log('[queue] stagger download', stagger + 'ms for', item.awemeId);
      await sleep(stagger);
    }
    item.status = 'downloading';
    item.startedAt = Date.now();
    item.filename = makeFilename(videoInfo.author.nickname, videoInfo.desc, item.awemeId);
    try {
      item.filePath = path.join(config.downloadDir, item.filename);
    } catch {
      item.filePath = path.join(process.cwd(), 'downloads', item.filename);
    }
    this._broadcastQueue();

    try {
      const browser = require('./browser');
      const context = await browser.getContext();

      const result = await downloadWithRetry(
        context,
        urls,
        item.filePath,
        (progress) => {
          item.progress = progress.percent || 0;
          item.bytesDone = progress.bytesDone;
          item.bytesTotal = progress.bytesTotal;
          item.speedBytesPerSec = progress.speed || 0;
          item.etaSec = progress.eta || 0;
          this.sse.broadcast('download_progress', {
            id: item.id,
            percent: item.progress,
            speedBytesPerSec: item.speedBytesPerSec,
            etaSec: item.etaSec,
            bytesDone: item.bytesDone,
            bytesTotal: item.bytesTotal,
            status: 'downloading'
          });
        },
        config.maxRetries,
        // Refresh URLs on retry — CDN tokens expire quickly
        async () => {
          const freshInfo = await extractVideoMetadata(item.awemeId);
          item.metadata = freshInfo;
          return getBestVideoUrl(freshInfo);
        }
      );

      item.status = 'completed';
      item.progress = 100;
      item.bytesTotal = result.bytesTotal;
      item.completedAt = Date.now();
      this._broadcastQueue();
      this.sse.broadcast('download_complete', {
        id: item.id,
        awemeId: item.awemeId,
        filename: item.filename,
        fileSize: result.bytesTotal,
        author: item.metadata?.author?.nickname || '',
        description: item.metadata?.desc || '',
        duration: item.metadata?.duration || 0,
        coverUrl: item.metadata?.coverUrl || ''
      });
    } catch (e) {
      // Retry on transient errors with fresh metadata
      if (!/2100011|不存在|已设为私密|文件写入失败/i.test(e.message) && (item.retryCount || 0) < 2) {
        item.retryCount = (item.retryCount || 0) + 1;
        item.status = 'extracting';
        this._broadcastQueue();
        await sleep(2000 * item.retryCount);
        for (let retry = 0; retry < 3; retry++) {
          try {
            const retryInfo = await extractVideoMetadata(item.awemeId);
            item.metadata = retryInfo;
            const newUrls = getBestVideoUrl(retryInfo);
            if (!newUrls || newUrls.length === 0) continue;
            item.status = 'downloading';
            this._broadcastQueue();
            const ctx = await require('./browser').getContext();
            const result = await downloadWithRetry(ctx, newUrls, item.filePath, (p) => {
              item.progress = p.percent || 0;
              item.bytesDone = p.bytesDone;
              item.bytesTotal = p.bytesTotal;
              item.speedBytesPerSec = p.speed || 0;
              item.etaSec = p.eta || 0;
              this.sse.broadcast('download_progress', {
                id: item.id, percent: item.progress,
                speedBytesPerSec: item.speedBytesPerSec,
                etaSec: item.etaSec, bytesDone: item.bytesDone,
                bytesTotal: item.bytesTotal, status: 'downloading'
              });
            }, config.maxRetries, async () => {
              const refreshInfo = await extractVideoMetadata(item.awemeId);
              item.metadata = refreshInfo;
              return getBestVideoUrl(refreshInfo);
            });
            item.status = 'completed';
            item.progress = 100;
            item.bytesTotal = result.bytesTotal;
            item.completedAt = Date.now();
            this._broadcastQueue();
            this.sse.broadcast('download_complete', {
              id: item.id, awemeId: item.awemeId,
              filename: item.filename, fileSize: result.bytesTotal,
              author: item.metadata?.author?.nickname || '',
              description: item.metadata?.desc || '',
              duration: item.metadata?.duration || 0,
              coverUrl: item.metadata?.coverUrl || ''
            });
            return;
          } catch {}
        }
      }
      return this._failItem(item, `下载失败: ${e.message}`);
    }
  }

  _failItem(item, errorMsg) {
    item.status = 'error';
    item.error = errorMsg;
    item.completedAt = Date.now();
    this._broadcastQueue();
    this.sse.broadcast('download_error', { id: item.id, error: errorMsg });
  }

  _broadcastQueue() {
    try {
      // Strip bulky metadata from SSE — frontend only needs status/progress
      const light = this.items.map(i => ({
        id: i.id, url: i.url, awemeId: i.awemeId,
        bvid: i.bvid || '', isBilibili: !!i.isBilibili,
        status: i.status, progress: i.progress,
        speedBytesPerSec: i.speedBytesPerSec, etaSec: i.etaSec,
        bytesDone: i.bytesDone, bytesTotal: i.bytesTotal,
        filename: i.filename, filePath: i.filePath,
        error: i.error, createdAt: i.createdAt,
        startedAt: i.startedAt, completedAt: i.completedAt,
        retryCount: i.retryCount,
        isCollection: !!i.isCollection,
        collectionLabel: i.collectionLabel,
        collectionFound: i.collectionFound,
        metadata: i.metadata ? {
          desc: i.metadata.desc || i.metadata.title,
          author: i.metadata.author ? { nickname: i.metadata.author.nickname || i.metadata.author.name } : null
        } : null
      }));
      this.sse.broadcast('queue_update', { items: light });
    } catch (e) {
      console.error('[queue] broadcast error:', e.message);
    }
  }

}

module.exports = QueueManager;
