const { getContext } = require('./browser');
const { sleep } = require('./helpers');

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

module.exports = {
  extractBvid,
  isBilibiliUrl,
  fetchVideoInfo,
  fetchPlayUrl,
  getVideoDownloadUrls,
  closeBilibiliPage
};
