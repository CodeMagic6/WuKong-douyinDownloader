/**
 * Debug: check what the collection page looks like in Playwright.
 */
const { initBrowser, closeBrowser, getPage } = require('./src/browser');

async function main() {
  await initBrowser(true); // headless mode
  const page = await getPage();

  const url = 'https://www.douyin.com/video/1234567890123456789'; // 替换为合集链接
  console.log('Navigating to:', url);
  await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(e => console.log('Nav error:', e.message));
  console.log('Page loaded, waiting 5s for render...');
  await new Promise(r => setTimeout(r, 5000));

  // Check page info
  const info = await page.evaluate(() => ({
    title: document.title,
    url: window.location.href,
    links: document.querySelectorAll('a[href*="/video/"]').length,
    bodyLen: document.body?.innerHTML?.length || 0,
    selectors: {
      videoLinks: Array.from(document.querySelectorAll('a[href*="/video/"]')).slice(0, 3).map(a => a.href),
      allLinks: Array.from(document.querySelectorAll('a')).slice(0, 20).map(a => a.href.substring(0, 80)).filter(Boolean),
      allText: (document.body?.innerText || '').substring(0, 500)
    }
  }));
  console.log('Title:', info.title);
  console.log('Final URL:', info.url);
  console.log('Video links found:', info.links);
  console.log('Body HTML length:', info.bodyLen);
  console.log('\nSample video links:', info.selectors.videoLinks);
  console.log('\nSample all links:', info.selectors.allLinks);
  console.log('\nPage text (first 500):', info.selectors.allText);

  await new Promise(r => setTimeout(r, 5000));
  await closeBrowser();
}

main().catch(e => {
  console.error('Debug error:', e.message);
  process.exit(1);
});
