const { getFreshPage } = require('./browser');
const { sleep } = require('./helpers');

const MAX_SCROLL_ATTEMPTS = 100;
const SCROLL_DELAY_MS = 2500;
const INITIAL_WAIT_MS = 6000;

// Return all video IDs on page
function makeExtractVideosScript() {
  return `(function() {
    const results = [];
    const seen = new Set();
    for (var a of document.querySelectorAll('a[href*="/video/"]')) {
      var m = a.href.match(/\\/video\\/(\\d+)/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); results.push(m[1]); }
    }
    return results;
  })()`;
}

// Try multiple scroll strategies to trigger lazy loading
function makeScrollScript() {
  return `(function() {
    var containers = [
      document.documentElement,
      document.body,
      document.querySelector('[class*="route-scroll-container"]'),
      document.querySelector('[class*="parent-route-container"]'),
      document.querySelector('#pagelet-boot'),
      document.querySelector('[data-e2e="user-post-list"]'),
      document.querySelector('[class*="profile"]'),
      document.querySelector('[class*="user"]'),
      document.querySelector('.DouyinProfileApp')
    ];
    for (var c of containers) {
      if (c && (typeof c.scrollHeight === 'number' || typeof c.scrollTop === 'number')) {
        try {
          var prev = c.scrollTop || 0;
          c.scrollTop = c.scrollHeight;
          if (c.scrollTop > prev) return true;
        } catch(e) {}
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
    window.scrollBy(0, 500);
    return true;
  })()`;
}

async function extractCollectionVideos(url) {
  const page = await getFreshPage();
  try {
    await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(INITIAL_WAIT_MS);

    const allIds = new Set();
    let idleScrolls = 0;
    const evalScript = makeExtractVideosScript();
    const scrollScript = makeScrollScript();

    // Wait for at least some video links to appear
    for (let w = 0; w < 15; w++) {
      const ids = await page.evaluate(evalScript);
      if (ids.length > 0) break;
      await page.evaluate(scrollScript);
      await sleep(2000);
    }

    for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
      const ids = await page.evaluate(evalScript);

      const before = allIds.size;
      for (const id of ids) allIds.add(id);

      if (allIds.size === before) {
        idleScrolls++;
        if (idleScrolls >= 8) break;
      } else {
        idleScrolls = 0;
      }

      await page.evaluate(scrollScript);
      await sleep(SCROLL_DELAY_MS);
    }

    return Array.from(allIds);
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractCollectionWithProgress(url, onProgress, isCancelled) {
  const page = await getFreshPage();
  try {
    await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(INITIAL_WAIT_MS);

    const allIds = new Set();
    let idleScrolls = 0;
    const evalScript = makeExtractVideosScript();
    const scrollScript = makeScrollScript();

    // Wait for at least some video links to appear
    for (let w = 0; w < 15; w++) {
      if (isCancelled && isCancelled()) break;
      const ids = await page.evaluate(evalScript);
      if (ids.length > 0) break;
      await page.evaluate(scrollScript);
      await sleep(2000);
    }

    for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
      if (isCancelled && isCancelled()) break;

      const ids = await page.evaluate(evalScript);

      if (isCancelled && isCancelled()) break;
      const before = allIds.size;
      for (const id of ids) allIds.add(id);

      if (allIds.size === before) {
        idleScrolls++;
        if (idleScrolls >= 8) break;
      } else {
        idleScrolls = 0;
      }

      if (onProgress) onProgress(allIds.size, attempt + 1);

      await page.evaluate(scrollScript);
      await sleep(SCROLL_DELAY_MS);
    }

    return Array.from(allIds);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { extractCollectionVideos, extractCollectionWithProgress };
