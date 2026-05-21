const { getIsolatedPage } = require('./browser');
const { sleep } = require('./helpers');
const { getCollectionType } = require('./url-utils');

// Douyin web API endpoints per collection tab type
var API_PATTERNS = {
  'watch_later': '/aweme/v1/web/watchlater/list/',
  'favorite': '/aweme/v1/web/favorite/list/',
  'post': '/aweme/v1/web/aweme/post/',
  'profile': '/aweme/v1/web/aweme/post/',
  'recommend': '/aweme/v1/web/recommend/list/'
};

async function _extractCore(url, onProgress, isCancelled) {
  var page = await getIsolatedPage();
  var collType = getCollectionType(url);
  var expectedApi = API_PATTERNS[collType] || null;

  try {
    var allIds = [];
    var apiReceived = false;

    // API intercept — capture from known endpoints
    page.on('response', function(resp) {
      var rUrl = resp.url();

      // Match expected endpoint, or any known collection endpoint
      var matched = false;
      if (expectedApi && rUrl.includes(expectedApi)) matched = true;
      if (!matched) {
        for (var k in API_PATTERNS) {
          if (rUrl.includes(API_PATTERNS[k])) { matched = true; break; }
        }
      }
      // Fallback: any /aweme/v1/web/ list endpoint
      if (!matched && /\/aweme\/v1\/web\/\w+\/list\//.test(rUrl)) matched = true;

      if (!matched) return;
      apiReceived = true;

      resp.json().then(function(body) {
        if (!body || !body.items) {
          if (body && body.status_code && body.status_code !== 0) {
            console.log('[collection] API error:', body.status_code, body.status_msg || '', 'url:', rUrl.substring(0, 60));
          }
          return;
        }
        console.log('[collection] API batch:', body.items.length, 'has_more:', body.has_more, 'type:', collType);
        for (var i = 0; i < body.items.length; i++) {
          var id = String(body.items[i].aweme_id || body.items[i].id || '');
          if (id && allIds.indexOf(id) === -1) allIds.push(id);
        }
      }).catch(function() {});
    });

    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(function(e) {
      console.log('[collection] goto failed:', e.message);
    });
    if (isCancelled && isCancelled()) return [];

    // Wait for first API batch (up to 15s, checking every 500ms)
    for (var w = 0; w < 30; w++) {
      if (allIds.length > 0) break;
      if (isCancelled && isCancelled()) return [];
      await sleep(500);
    }
    console.log('[collection] initial:', allIds.length, 'apiReceived:', apiReceived,
      'type:', collType, 'expectedApi:', expectedApi,
      'pageUrl:', (page.url() || '').substring(0, 80));

    // No API data — fail fast, don't scroll into a hang
    if (allIds.length === 0) {
      var msg = '[collection] no data, skipping scroll (type: ' + collType;
      if (expectedApi) msg += ', api: ' + expectedApi;
      msg += ', apiReceived: ' + apiReceived + ')';
      console.log(msg);
      // Diagnostic: log page state
      try {
        var pageTitle = await page.title();
        var pageUrl = page.url();
        console.log('[collection] page title:', pageTitle, 'url:', pageUrl.substring(0, 100));
        // Try one reload in case SPA didn't boot
        if (!apiReceived && expectedApi) {
          console.log('[collection] retry: reload page once');
          await page.reload({ timeout: 30000, waitUntil: 'domcontentloaded' }).catch(function() {});
          for (var rw = 0; rw < 20; rw++) {
            if (allIds.length > 0) break;
            if (isCancelled && isCancelled()) return [];
            await sleep(500);
          }
          if (allIds.length > 0) {
            console.log('[collection] retry succeeded:', allIds.length);
          } else {
            console.log('[collection] retry also got no data');
            return [];
          }
        } else {
          return [];
        }
      } catch(e) {
        console.log('[collection] diagnostic error:', e.message);
        return [];
      }
    }

    // Scroll via mouse wheel + container scroll for lazy pagination
    var prev = allIds.length;
    var stale = 0;
    for (var s = 0; s < 25; s++) {
      if (isCancelled && isCancelled()) return [];

      // Step 1: Mouse wheel at viewport center (hits scrollable content area)
      await page.mouse.move(720, 450).catch(function() {});
      await page.mouse.wheel(0, 6000).catch(function() {});
      await sleep(600);

      // Step 2: Programmatic incremental scroll on best scrollable container
      await page.evaluate(function() {
        var all = document.querySelectorAll('body *');
        var best = null, bestH = 0;
        for (var i = 0; i < all.length; i++) {
          try {
            var e = all[i];
            var s = window.getComputedStyle(e);
            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 5) {
              if (e.scrollHeight > bestH) { bestH = e.scrollHeight; best = e; }
            }
          } catch(ex) {}
        }
        if (best) {
          // Incremental scroll: each iteration scrolls ~80% of viewport height
          // Avoids scrollTop = scrollHeight which may not fire scroll event if value unchanged
          var nearBottom = best.scrollTop + best.clientHeight >= best.scrollHeight - 50;
          if (nearBottom) {
            // Bounce up so next scroll fires event
            best.scrollTop = Math.max(0, best.scrollTop - 200);
          } else {
            best.scrollTop = Math.min(best.scrollTop + best.clientHeight * 0.8, best.scrollHeight);
          }
        } else {
          window.scrollBy(0, 2000);
        }
      }).catch(function() {});
      await sleep(2000);

      if (allIds.length > prev) {
        console.log('[collection] scroll', s, 'ids:', allIds.length);
        if (onProgress) onProgress(allIds.length, s + 1);
        prev = allIds.length;
        stale = 0;
      } else {
        stale++;
        if (stale >= 5) break;
      }
    }

    console.log('[collection] done:', allIds.length);
    return allIds;

  } finally {
    var ctx = page.__isolatedContext;
    await page.close().catch(function() {});
    if (ctx) await ctx.close().catch(function() {});
  }
}

module.exports = { extractCollectionVideos: _extractCore, extractCollectionWithProgress: _extractCore };
