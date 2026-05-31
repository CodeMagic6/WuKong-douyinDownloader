const { getContext } = require('./browser');
const { sleep } = require('./helpers');
const crypto = require('crypto');
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

// WBI签名相关
const MixinArray = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiImg = null;

function getMixinKey(content) {
  let sb = '';
  for (let i = 0; i < 32; i++) {
    sb += content.charAt(MixinArray[i]);
  }
  return sb;
}

async function getWbiKeys() {
  if (wbiImg) return wbiImg;
  try {
    const ctx = await getContext();
    if (!ctx) throw new Error('No context');
    const page = await ctx.newPage();
    await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    
    // 从nav接口获取wbi keys
    const resp = await page.evaluate(async () => {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav');
      return await r.json();
    });
    
    if (resp?.data?.wbi_img) {
      const imgUrl = resp.data.wbi_img.img_url;
      const subUrl = resp.data.wbi_img.sub_url;
      const imgKey = imgUrl.substring(imgUrl.lastIndexOf('/') + 1, imgUrl.indexOf('.'));
      const subKey = subUrl.substring(subUrl.lastIndexOf('/') + 1, subUrl.indexOf('.'));
      wbiImg = imgKey + subKey;
    }
    await page.close();
  } catch (e) {
    console.error('[wbi] get keys error:', e.message);
  }
  return wbiImg;
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function encodeURL(str) {
  return encodeURIComponent(str).replace(/%20/g, '+');
}

async function encWbi(url) {
  const keys = await getWbiKeys();
  if (!keys) return url;
  
  const mixinKey = getMixinKey(keys);
  const wts = Math.floor(Date.now() / 1000);
  
  const questionIdx = url.indexOf('?');
  let paramEncodedSorted;
  let sep;
  
  if (questionIdx >= 0) {
    let paramRaw = url.substring(questionIdx + 1);
    sep = paramRaw ? '&' : '?';
    paramRaw += sep + 'wts=' + wts;
    
    const params = paramRaw.split('&').map(p => {
      const [key, ...vals] = p.split('=');
      return encodeURL(key) + '=' + encodeURL(vals.join('='));
    });
    params.sort();
    paramEncodedSorted = params.join('&');
  } else {
    sep = '?';
    paramEncodedSorted = 'wts=' + wts;
  }
  
  const wbiSign = md5(paramEncodedSorted + mixinKey);
  return url + (questionIdx >= 0 ? '&' : '?') + 'w_rid=' + wbiSign + '&wts=' + wts;
}

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
  for (let attempt = 0; attempt < 3; attempt++) {
    let page = null;
    try {
      const ctx = await getContext();
      if (!ctx) throw new Error('Browser context not available');
      // Load bilibili cookies
      try {
        const raw = fs.readFileSync(bilibiliCookieFile, 'utf-8');
        const cookies = JSON.parse(raw);
        if (cookies.length > 0) await ctx.addCookies(cookies);
      } catch {}
      page = await ctx.newPage();
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      const url = makeVideoInfoUrl(bvid);
      const resp = await Promise.race([
        fetchJsonViaBrowser(page, url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('API 请求超时 (15s)')), 15000))
      ]);

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
          page: p.page,
          part: p.part || '',
          duration: p.duration || 0
        }))
      };
    } catch (e) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
}

async function fetchPlayUrl(bvid, cid, qn = 64) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let page = null;
    try {
      const ctx = await getContext();
      if (!ctx) throw new Error('Browser context not available');
      try {
        const raw = fs.readFileSync(bilibiliCookieFile, 'utf-8');
        const cookies = JSON.parse(raw);
        if (cookies.length > 0) await ctx.addCookies(cookies);
      } catch {}
      page = await ctx.newPage();
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      const url = makePlayUrl(bvid, cid, qn, 1);
      const resp = await Promise.race([
        fetchJsonViaBrowser(page, url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('API 请求超时 (15s)')), 15000))
      ]);

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
    } catch (e) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
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

function isBilibiliSpaceUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /space\.bilibili\.com\/\d+\/video/i.test(url);
}

function parseBilibiliSpaceUrl(url) {
  const midMatch = url.match(/space\.bilibili\.com\/(\d+)/);
  return midMatch ? midMatch[1] : null;
}

// 通用B站URL解析器：自动识别单视频、收藏夹、UP主视频页
function parseBilibiliUrl(url) {
  if (!url || typeof url !== 'string') return { type: 'unknown' };
  const trimmed = url.trim();
  
  // 单视频: BV... 或 av... 或 bilibili.com/video/...
  const bvid = extractBvid(trimmed);
  if (bvid) return { type: 'video', bvid };
  
  // 收藏夹: space.bilibili.com/mid/favlist?fid=xxx
  if (/space\.bilibili\.com\/\d+\/favlist/i.test(trimmed)) {
    const mid = trimmed.match(/space\.bilibili\.com\/(\d+)/)?.[1];
    const fid = trimmed.match(/fid=(\d+)/)?.[1];
    return { type: 'collection', mid, fid };
  }
  
  // UP主视频页: space.bilibili.com/mid/video
  if (/space\.bilibili\.com\/\d+\/video/i.test(trimmed)) {
    const mid = trimmed.match(/space\.bilibili\.com\/(\d+)/)?.[1];
    return { type: 'space', mid };
  }
  
  // 通用space页面: space.bilibili.com/mid (默认当UP主视频)
  if (/space\.bilibili\.com\/\d+/i.test(trimmed)) {
    const mid = trimmed.match(/space\.bilibili\.com\/(\d+)/)?.[1];
    return { type: 'space', mid };
  }
  
  return { type: 'unknown' };
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

  const allVideos = [];
  let collectionTitle = '';
  let pn = 1;
  const ps = 40;
  let hasMore = true;

  while (hasMore) {
    if (isCancelled && isCancelled()) break;

    let page = null;
    try {
      const ctx = await getContext();
      if (!ctx) throw new Error('Browser context not available');
      try {
        const raw = fs.readFileSync(bilibiliCookieFile, 'utf-8');
        const cookies = JSON.parse(raw);
        if (cookies.length > 0) await ctx.addCookies(cookies);
      } catch {}
      page = await ctx.newPage();
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      const apiUrl = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${fid}&pn=${pn}&ps=${ps}&keyword=&order=mtime&type=0&tid=0&platform=web`;
      const resp = await Promise.race([
        fetchJsonViaBrowser(page, apiUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('API 请求超时')), 15000))
      ]);

      if (!resp || resp.code !== 0) {
        throw new Error(`B站收藏夹 API 错误: ${resp?.message || '未知错误'} (code: ${resp?.code})`);
      }

      const data = resp.data;
      if (!data) break;

      if (data.info && data.info.title && !collectionTitle) {
        collectionTitle = data.info.title;
      }

      if (!data.medias || data.medias.length === 0) break;

      let added = 0;
      for (const m of data.medias) {
        if (m.bvid) {
          if (!allVideos.find(v => v.bvid === m.bvid)) {
            allVideos.push({
              bvid: m.bvid,
              title: (m.title || '').substring(0, 100),
              author: m.upper?.name || ''
            });
            added++;
          }
        } else {
          console.log('[bilibili-collection] skip no-bvid:', m.title, 'type:', m.type);
        }
      }

      hasMore = data.has_more === true;
      pn++;

      console.log('[bilibili-collection] page', pn - 1, 'medias:', data.medias.length, 'added:', added, 'total:', allVideos.length, 'has_more:', hasMore);
      if (onProgress) onProgress(allVideos.length, pn);
      await sleep(800);
    } catch (e) {
      console.error('[bilibili-collection] page error:', e.message);
      break;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  console.log('[bilibili-collection] done:', allVideos.length, 'title:', collectionTitle);
  return { videos: allVideos, title: collectionTitle };
}

async function extractBilibiliSpaceWithProgress(url, onProgress, isCancelled) {
  const mid = parseBilibiliSpaceUrl(url);
  if (!mid) throw new Error('无法从 URL 提取用户 ID');

  const allVideos = [];
  let userName = '';
  let pn = 1;
  const ps = 30;
  let hasMore = true;

  while (hasMore) {
    if (isCancelled && isCancelled()) break;

    let page = null;
    try {
      const ctx = await getContext();
      if (!ctx) throw new Error('Browser context not available');
      try {
        const raw = fs.readFileSync(bilibiliCookieFile, 'utf-8');
        const cookies = JSON.parse(raw);
        if (cookies.length > 0) await ctx.addCookies(cookies);
      } catch {}
      page = await ctx.newPage();
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      // 使用WBI签名的API
      let apiUrl = `https://api.bilibili.com/x/space/wbi/arc/search?mid=${mid}&ps=${ps}&tid=0&pn=${pn}&keyword=&order=pubdate&platform=web`;
      apiUrl = await encWbi(apiUrl);
      
      const resp = await Promise.race([
        fetchJsonViaBrowser(page, apiUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('API 请求超时')), 15000))
      ]);

      if (!resp || resp.code !== 0) {
        throw new Error(`B站用户视频 API 错误: ${resp?.message || '未知错误'} (code: ${resp?.code})`);
      }

      const data = resp.data;
      if (!data) break;

      if (data.list && data.list.vlist && !userName && data.list.vlist.length > 0) {
        userName = data.list.vlist[0]?.author || '';
      }

      const vlist = data.list?.vlist || [];
      if (vlist.length === 0) break;

      let added = 0;
      for (const v of vlist) {
        if (v.bvid) {
          if (!allVideos.find(x => x.bvid === v.bvid)) {
            allVideos.push({
              bvid: v.bvid,
              title: (v.title || '').substring(0, 100),
              author: v.author || userName
            });
            added++;
          }
        }
      }

      if (onProgress) {
        onProgress(allVideos.length, pn);
      }

      const totalPages = Math.ceil((data.page?.count || 0) / ps);
      hasMore = pn < totalPages && added > 0;
      pn++;

      console.log('[bilibili-space] page', pn - 1, 'added:', added, 'total:', allVideos.length);
      await sleep(800);

    } catch (e) {
      console.error('[bilibili-space] page', pn, 'error:', e.message);
      hasMore = false;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  console.log('[bilibili-space] done:', allVideos.length, 'user:', userName);
  return { videos: allVideos, title: userName || 'UP主视频' };
}

module.exports = {
  extractBvid,
  isBilibiliUrl,
  fetchVideoInfo,
  fetchPlayUrl,
  getVideoDownloadUrls,
  closeBilibiliPage,
  parseBilibiliUrl,
  extractBilibiliCollectionWithProgress,
  extractBilibiliSpaceWithProgress
};
