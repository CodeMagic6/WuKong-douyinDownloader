const https = require('https');
const http = require('http');

function isBilibiliUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /bilibili\.com/i.test(url) || /b23\.tv/i.test(url);
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

function extractAwemeId(url) {
  if (!url || typeof url !== 'string') return null;

  const trimmed = url.trim();

  // Direct /video/{id}
  const videoMatch = trimmed.match(/\/video\/(\d+)/);
  if (videoMatch) return videoMatch[1];

  // iesdouyin.com/share/note/{id}
  const noteMatch = trimmed.match(/\/share\/note\/(\d+)/);
  if (noteMatch) return noteMatch[1];

  // modal_id={id}
  const modalMatch = trimmed.match(/modal_id=(\d+)/);
  if (modalMatch) return modalMatch[1];

  // raw digits
  if (/^\d+$/.test(trimmed)) return trimmed;

  // v.douyin.com short URL — can't resolve sync, return original for later resolution
  if (trimmed.includes('v.douyin.com')) return null;

  return null;
}

function isShortUrl(url) {
  return /v\.douyin\.com/i.test(url);
}

function isCollectionUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  // Has modal_id → single video, not collection
  if (/modal_id=\d+/.test(u)) return false;
  // user/self page with showTab param = collection (watch_later, record, favorite, recommend, post)
  if (/douyin\.com\/user\/self/i.test(u) && /showTab=/i.test(u)) return true;
  // user profile page /user/{profileId} — treat as collection
  if (/douyin\.com\/user\/(?!self\b|video\b)[^\/\?]+/i.test(u)) return true;
  return false;
}

function getCollectionType(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/showTab=(\w+)/);
  if (m) return m[1];
  return 'profile';
}

function getCollectionLabel(url) {
  const type = getCollectionType(url);
  const labels = {
    'watch_later': '稍后再看',
    'recommend': '推荐',
    'favorite': '收藏',
    'record': '作品',
    'post': '作品',
    'profile': '个人主页'
  };
  return labels[type] || type || '合集';
}

function validateDouyinUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return /douyin\.com/i.test(trimmed) || /^\d+$/.test(trimmed);
}

function normalizeUrl(url) {
  const id = extractAwemeId(url);
  if (id) return `https://www.douyin.com/video/${id}`;
  if (isShortUrl(url)) return url.trim();
  return url.trim();
}

function resolveShortUrl(url) {
  return new Promise((resolve, reject) => {
    if (!isShortUrl(url)) {
      return resolve(url);
    }

    const client = url.startsWith('https') ? https : http;

    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    }, (res) => {
      // Follow redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location;
        const id = extractAwemeId(location);
        if (id) {
          res.resume();
          return resolve(`https://www.douyin.com/video/${id}`);
        }
        res.resume();
        return resolve(location);
      }
      res.resume();
      resolve(url);
    }).on('error', reject).on('timeout', () => reject(new Error('Short URL resolve timeout')));
  });
}

module.exports = { extractAwemeId, isShortUrl, isCollectionUrl, getCollectionType, getCollectionLabel, validateDouyinUrl, normalizeUrl, resolveShortUrl, isBilibiliUrl, extractBvid };
