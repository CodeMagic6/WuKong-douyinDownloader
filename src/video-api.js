const { getPage } = require('./browser');
const { sleep } = require('./helpers');

const API_BASE = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const API_PARAMS = 'device_platform=webapp&aid=6383&channel=channel_pc_web';

function makeDetailUrl(awemeId) {
  return `${API_BASE}?aweme_id=${awemeId}&${API_PARAMS}`;
}

async function fetchVideoDetail(page, awemeId) {
  const url = makeDetailUrl(awemeId);
  // String evaluate avoids pkg bytecode serialization issue
  const expr = `fetch("${url.replace(/"/g, '\\"')}", { credentials: 'include', headers: { 'Accept': 'application/json' } }).then(r => r.text()).then(t => t ? JSON.parse(t) : null).catch(() => null)`;
  return await page.evaluate(expr);
}

function parseVideoInfo(apiResponse) {
  if (!apiResponse || apiResponse.status_code !== 0 || !apiResponse.aweme_detail) {
    return null;
  }

  const d = apiResponse.aweme_detail;
  const video = d.video || {};
  const playAddr = video.play_addr || {};
  const downloadAddr = video.download_addr || {};
  const cover = video.cover || d.video?.dynamic_cover || {};
  const author = d.author || {};
  const stats = d.statistics || {};

  return {
    awemeId: d.aweme_id,
    desc: d.desc || '',
    createTime: d.create_time || 0,
    author: {
      nickname: author.nickname || '未知作者',
      uniqueId: author.unique_id || '',
      avatar: author.avatar_thumb?.url_list?.[0] || ''
    },
    playAddr: (playAddr.url_list || []).filter(Boolean),
    downloadAddr: (downloadAddr.url_list || []).filter(Boolean),
    coverUrl: (cover.url_list || [])[0] || '',
    duration: video.duration || 0,
    width: playAddr.width || 0,
    height: playAddr.height || 0,
    statistics: {
      diggCount: stats.digg_count || 0,
      commentCount: stats.comment_count || 0,
      playCount: stats.play_count || 0,
      shareCount: stats.share_count || 0
    }
  };
}

function getBestVideoUrl(videoInfo) {
  // Prefer downloadAddr, fallback to playAddr
  const urls = videoInfo.downloadAddr.length > 0
    ? videoInfo.downloadAddr
    : videoInfo.playAddr;
  return urls;
}

// Dedicated API page — reused for all metadata calls, replaced on error
let apiPage = null;
let apiPageLock = null; // promise-based mutex for concurrent access

function timeoutRace(ms, msg) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg || `超时 ${ms}ms`)), ms));
}

async function getApiPage() {
  // Wait for any in-progress page init (with timeout to prevent cascade hang)
  if (apiPageLock) {
    try {
      await Promise.race([apiPageLock, timeoutRace(30000, 'getApiPage 等待锁超时')]);
    } catch {
      apiPageLock = null;
    }
  }

  const { getContext } = require('./browser');
  if (apiPage) {
    try {
      await Promise.race([
        apiPage.evaluate('document.location.origin'),
        timeoutRace(5000, 'API 页面健康检查超时')
      ]);
      return apiPage;
    } catch {
      await apiPage.close().catch(() => {});
      apiPage = null;
    }
  }

  // Lock to prevent concurrent creation
  // Wrap entire init in a race so lock always releases
  apiPageLock = (async () => {
    try {
      const ctx = await getContext();
      if (!ctx) throw new Error('Browser context not available');
      apiPage = await Promise.race([
        ctx.newPage(),
        timeoutRace(15000, '创建 API 页面超时')
      ]);
      await apiPage.goto('https://www.douyin.com/', {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(() => {});
      if (!apiPage) throw new Error('Failed to create API page');
      return apiPage;
    } finally {
      apiPageLock = null;
    }
  })();

  // Overall timeout: prevent lock never releasing
  try {
    return await Promise.race([apiPageLock, timeoutRace(30000, 'API 页面初始化整体超时')]);
  } catch (e) {
    apiPageLock = null;
    throw e;
  }
}

async function extractVideoMetadata(awemeId) {
  // Retry up to 2 times on context-destroyed/navigation errors
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const page = await getApiPage();
      const resp = await Promise.race([
        fetchVideoDetail(page, awemeId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('API 请求超时 (15s)')), 15000))
      ]);
      const info = parseVideoInfo(resp);
      if (!info) {
        const code = resp?.status_code;
        const fd = resp?.filter_detail;
        const reason = fd?.notice || fd?.detail_msg || '';
        const msg = code === 2100011 || reason ? `视频不可用: ${reason || '已删除或私密'}`
          : code ? `API 返回错误 (status_code: ${code})`
          : resp === null || resp === undefined ? 'API 返回空响应，可能需切换浏览器模式'
          : '无法解析视频信息';
        throw new Error(msg);
      }
      return info;
    } catch (e) {
      const isContextError = /context was destroyed|navigation|Execution context|Cannot read properties of null|Failed to create/i.test(e.message);
      if (isContextError && attempt < 3) {
        // Reset apiPage — navigation destroyed its context
        if (apiPage) { try { await apiPage.close().catch(() => {}); } catch {}; apiPage = null; }
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function closeApiPage() {
  if (apiPage) { try { await apiPage.close(); } catch {}; apiPage = null; }
}

module.exports = { fetchVideoDetail, parseVideoInfo, getBestVideoUrl, extractVideoMetadata, closeApiPage };
