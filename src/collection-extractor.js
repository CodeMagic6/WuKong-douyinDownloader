const { getFreshPage } = require('./browser');
const { sleep } = require('./helpers');

async function _extractCore(url, onProgress, isCancelled) {
  var page = await getFreshPage();

  try {
    var allIds = [];
    var apiReceived = false;

    // API intercept — only way to exclude recommended videos
    page.on('response', function(resp) {
      if (!resp.url().includes('/aweme/v1/web/watchlater/list/')) return;
      apiReceived = true;
      resp.json().then(function(body) {
        if (!body || !body.items) {
          if (body && body.status_code && body.status_code !== 0) {
            console.log('[collection] API error:', body.status_code, body.status_msg || '');
          }
          return;
        }
        for (var i = 0; i < body.items.length; i++) {
          var id = String(body.items[i].aweme_id || body.items[i].id || '');
          if (id && allIds.indexOf(id) === -1) allIds.push(id);
        }
      }).catch(function() {});
    });

    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(function() {});
    if (isCancelled && isCancelled()) return [];

    // Wait for first API batch (up to 8s)
    for (var w = 0; w < 8; w++) {
      if (allIds.length > 0) break;
      if (isCancelled && isCancelled()) return [];
      await sleep(1000);
    }
    console.log('[collection] initial:', allIds.length, 'apiReceived:', apiReceived, 'pageUrl:', page.url().substring(0, 80));

    // No API data — fail fast, don't scroll into a hang
    if (allIds.length === 0) {
      console.log('[collection] no data, skipping scroll');
      return [];
    }

    // Scroll to top first — ensures consistent scroll distance each run
    await page.evaluate(function() { window.scrollTo(0, 0); }).catch(function() {});
    await sleep(500);

    // Scroll via mouse wheel + JS to trigger lazy pagination
    var prev = allIds.length;
    var stale = 0;
    for (var s = 0; s < 25; s++) {
      if (isCancelled && isCancelled()) return [];

      // Scroll with timeout to prevent freeze on bad page state
      await Promise.race([
        page.mouse.move(600, 400).then(function() { return page.mouse.wheel(0, 5000); }),
        sleep(5000)
      ]).catch(function() {});
      page.evaluate(function() { window.scrollBy(0, 2000); }).catch(function() {});
      await sleep(2000);

      if (allIds.length > prev) {
        console.log('[collection] scroll', s, 'ids:', allIds.length);
        if (onProgress) onProgress(allIds.length, s + 1);
        prev = allIds.length;
        stale = 0;
      } else {
        stale++;
        if (stale >= 3) break;
      }
    }

    console.log('[collection] done:', allIds.length);
    return allIds;

  } finally {
    await page.close().catch(function() {});
  }
}

module.exports = { extractCollectionVideos: _extractCore, extractCollectionWithProgress: _extractCore };
