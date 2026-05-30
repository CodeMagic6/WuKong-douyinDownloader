const { getContext } = require('./browser');
const { sleep } = require('./helpers');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bilibiliCookieFile = path.join(os.homedir(), '.claude', 'bilibili_cookies.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Origin': 'https://www.bilibili.com'
};

function extractBvid(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  const bvMatch = trimmed.match(/BV[a-zA-Z0-9]+/);
  if (bvMatch) return bvMatch[0];

  const avMatch = trimmed.match(/av(\d+)/);
  if (avMatch) return avMatch[1];

  return null;
}

function isBilibiliUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /bilibili\.com/i.test(url) || /b23\.tv/i.test(url);
}

function makeVideoInfoUrl(bvid) {
  if (/^\d+$/.test(bvid)) {
    return `https://api.bilibili.com/x/web-interface/view?avid=${bvid}`;
  }
  return `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
}

function makePlayUrl(bvid, cid, qn = 64, fnval = 1) {
  if (/^\d+$/.test(bvid)) {
    return `https://api.bilibili.com/x/player/playurl?avid=${bvid}&cid=${cid}&qn=${qn}&fnval=${fnval}&fourk=1`;
  }
  return `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=${fnval}&fourk=1`;
}

let bilibiliPage = null;

async function getBilibiliPage() {
  if (bilibiliPage) {
    try {
      await bilibiliPage.evaluate('document.location.origin');
      return bilibiliPage;
    } catch {
      await bilibiliPage.close().catch(() => {});
      bilibiliPage = null;
    }
  }

  const ctx = await getContext();
  if (!ctx) throw new Error('Browser context not available');

  // Load bilibili cookies
  try {
    const raw = fs.readFileSync(bilibiliCookieFile, 'utf-8');
    const cookies = JSON.parse(raw);
    if (cookies.length > 0) {
      await ctx.addCookies(cookies);
    }
  } catch {}

  bilibiliPage = await ctx.newPage();
  await bilibiliPage.goto('https://www.bilibili.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  }).catch(() => {});

  return bilibiliPage;
}

async function fetchJsonViaBrowser(page, url) {
  const expr = `fetch("${url.replace(/"/g, '\\"')}", { 
    credentials: 'include', 
    headers: { 'Accept': 'application/json' } 
  }).then(r => r.text()).then(t => t ? JSON.parse(t) : null).catch(() => null)`;
  return await page.evaluate(expr);
}

async function fetchVideoInfo(bvid) {
  const page = await getBilibiliPage();
  const url = makeVideoInfoUrl(bvid);
  const resp = await fetchJsonViaBrowser(page, url);

  if (!resp || resp.code !== 0) {
    throw new Error(`B站 API 错误: ${resp?.message || '未知错误'} (code: ${resp?.code})`);
  }

  const data = resp.data;
  if (!data) throw new Error('视频数据为空');

  return {
    bvid: data.bvid,
    aid: data.aid,
    cid: data.cid,
    title: data.title || '',
    desc: data.desc || '',
    duration: data.duration || 0,
    cover: data.pic || '',
    author: {
      mid: data.owner?.mid || 0,
      name: data.owner?.name || '未知作者',
      face: data.owner?.face || ''
    },
    stat: {
      view: data.stat?.view || 0,
      danmaku: data.stat?.danmaku || 0,
      reply: data.stat?.reply || 0,
      favorite: data.stat?.favorite || 0,
      coin: data.stat?.coin || 0,
      share: data.stat?.share || 0,
      like: data.stat?.like || 0
    },
    pages: (data.pages || []).map(p => ({
      cid: p.cid,
      part: p.part || '',
      duration: p.duration || 0
    }))
  };
}

async function fetchPlayUrl(bvid, cid, qn = 64) {
  const page = await getBilibiliPage();
  const url = makePlayUrl(bvid, cid, qn, 1);
  const resp = await fetchJsonViaBrowser(page, url);

  if (!resp || resp.code !== 0) {
    throw new Error(`播放地址获取失败: ${resp?.message || '未知错误'} (code: ${resp?.code})`);
  }

  const data = resp.data;
  if (!data) throw new Error('播放地址数据为空');

  if (data.dash) {
    const dash = data.dash;
    const videoStreams = (dash.video || []).filter(v => v.baseUrl || v.base_url);
    const audioStreams = (dash.audio || []).filter(a => a.baseUrl || a.base_url);

    return {
      type: 'dash',
      video: videoStreams.map(v => ({
        id: v.id,
        baseUrl: v.baseUrl || v.base_url,
        bandwidth: v.bandwidth,
        width: v.width,
        height: v.height,
        codecs: v.codecs,
        mimeType: v.mimeType || v.mime_type
      })),
      audio: audioStreams.map(a => ({
        id: a.id,
        baseUrl: a.baseUrl || a.base_url,
        bandwidth: a.bandwidth,
        codecs: a.codecs,
        mimeType: a.mimeType || a.mime_type
      })),
      duration: data.dash.duration || 0
    };
  }

  if (data.durl && data.durl.length > 0) {
    return {
      type: 'mp4',
      url: data.durl[0].url,
      size: data.durl[0].size,
      duration: data.durl[0].length
    };
  }

  throw new Error('未找到可用的视频流');
}

async function getVideoDownloadUrls(bvid) {
  const info = await fetchVideoInfo(bvid);
  await sleep(500);
  const playUrl = await fetchPlayUrl(bvid, info.cid);

  return {
    info,
    playUrl
  };
}

async function closeBilibiliPage() {
  if (bilibiliPage) {
    try { await bilibiliPage.close(); } catch {}
    bilibiliPage = null;
  }
}

function isBilibiliCollectionUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /space\.bilibili\.com\/\d+\/favlist/i.test(url);
}

function parseBilibiliCollectionUrl(url) {
  const fidMatch = url.match(/fid=(\d+)/);
  const midMatch = url.match(/space\.bilibili\.com\/(\d+)/);
  return {
    fid: fidMatch ? fidMatch[1] : null,
    mid: midMatch ? midMatch[1] : null
  };
}

async function extractBilibiliCollectionWithProgress(url, onProgress, isCancelled) {
  const { fid } = parseBilibiliCollectionUrl(url);
  if (!fid) throw new Error('无法从 URL 提取收藏夹 ID');

  const { getIsolatedPage } = require('./browser');
  const ctx = await getContext();
  // Load bilibili cookies
  try {
    const raw = fs.readFileSync(bilibiliCookieFile, 'utf-8');
    const cookies = JSON.parse(raw);
    if (cookies.length > 0 && ctx) {
      await ctx.addCookies(cookies);
    }
  } catch {}

  const page = await getIsolatedPage();
  const allVideos = [];

  try {
    // Intercept fav/resource/list API responses
    let collectionTitle = '';
    page.on('response', function(resp) {
      var rUrl = resp.url();
      if (!rUrl.includes('/x/v3/fav/resource/list')) return;
      resp.json().then(function(body) {
        if (!body || body.code !== 0 || !body.data || !body.data.medias) return;
        if (body.data.info && body.data.info.title && !collectionTitle) {
          collectionTitle = body.data.info.title;
        }
        console.log('[bilibili-collection] API batch:', body.data.medias.length, 'has_more:', body.data.has_more);
        for (var i = 0; i < body.data.medias.length; i++) {
          var m = body.data.medias[i];
          if (m.bvid && m.type === 2) {
            var found = false;
            for (var j = 0; j < allVideos.length; j++) {
              if (allVideos[j].bvid === m.bvid) { found = true; break; }
            }
            if (!found) {
              allVideos.push({
                bvid: m.bvid,
                title: (m.title || '').substring(0, 100),
                author: m.upper?.name || ''
              });
            }
          }
        }
      }).catch(function() {});
    });

    // Navigate to collection page — this triggers API calls
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(function(e) {
      console.log('[bilibili-collection] goto failed:', e.message);
    });
    if (isCancelled && isCancelled()) return [];

    // Wait for first API batch
    for (var w = 0; w < 30; w++) {
      if (allVideos.length > 0) break;
      if (isCancelled && isCancelled()) return [];
      await sleep(500);
    }

    if (allVideos.length === 0) {
      console.log('[bilibili-collection] no data from initial load, page url:', page.url());
      return [];
    }

    if (onProgress) onProgress(allVideos.length, 1);

    // Scroll to trigger "load more" which fires additional API calls
    var prev = allVideos.length;
    var stale = 0;
    for (var s = 0; s < 50; s++) {
      if (isCancelled && isCancelled()) break;

      await page.evaluate(function() {
        window.scrollTo(0, document.body.scrollHeight);
      }).catch(function() {});
      await sleep(2000);

      if (allVideos.length > prev) {
        console.log('[bilibili-collection] scroll', s, 'videos:', allVideos.length);
        if (onProgress) onProgress(allVideos.length, s + 2);
        prev = allVideos.length;
        stale = 0;
      } else {
        stale++;
        if (stale >= 5) break;
      }
    }

    console.log('[bilibili-collection] done:', allVideos.length, 'title:', collectionTitle);
    return { videos: allVideos, title: collectionTitle };
  } finally {
    var isoCtx = page.__isolatedContext;
    await page.close().catch(function() {});
    if (isoCtx) await isoCtx.close().catch(function() {});
  }
}

module.exports = {
  extractBvid,
  isBilibiliUrl,
  fetchVideoInfo,
  fetchPlayUrl,
  getVideoDownloadUrls,
  closeBilibiliPage,
  isBilibiliCollectionUrl,
  extractBilibiliCollectionWithProgress
};
