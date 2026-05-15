/**
 * Phase 1 validation: Test download pipeline with 3 URLs.
 * Command: node test-download.js
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { extractAwemeId, resolveShortUrl, normalizeUrl } = require('./src/url-utils');
const { initBrowser, closeBrowser, getContext } = require('./src/browser');
const { extractVideoMetadata, getBestVideoUrl } = require('./src/video-api');
const { downloadWithRetry } = require('./src/download-engine');
const { makeFilename } = require('./src/filename-utils');
const { sleep } = require('./src/helpers');

const TEST_URLS = [
  // 替换为你要测试的视频链接
  'https://www.douyin.com/video/1234567890123456789',
  'https://www.douyin.com/video/1234567890123456790',
  'https://v.douyin.com/xxxxxxx/'
];

async function main() {
  console.log('=== 抖音视频下载测试 ===\n');

  // Ensure download dir
  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }

  // Test 1: URL parsing
  console.log('--- Test 1: URL 解析 ---');
  for (const url of TEST_URLS) {
    const id = extractAwemeId(url);
    const isShort = /v\.douyin\.com/.test(url);
    console.log(`  ${isShort ? '短链接' : '普通URL'}: ${url.substring(0, 60)}...`);
    console.log(`  → aweme_id: ${id || '需解析'}`);

    if (isShort) {
      try {
        const resolved = await resolveShortUrl(url);
        const resolvedId = extractAwemeId(resolved);
        console.log(`  → 解析后: ${resolved}`);
        console.log(`  → 解析ID: ${resolvedId}`);
      } catch (e) {
        console.log(`  → 解析失败: ${e.message}`);
      }
    }
    console.log('');
  }

  // Test 2: Browser init + cookie load
  console.log('--- Test 2: 初始化浏览器 ---');
  let browser, context, page;
  try {
    const result = await initBrowser(true);
    browser = result.browser;
    context = result.context;
    page = result.page;
    console.log('  ✅ 浏览器启动成功');
  } catch (e) {
    console.log(`  ❌ 浏览器启动失败: ${e.message}`);
    process.exit(1);
  }

  await sleep(2000);
  console.log('');

  // Test 3: Extract video info for each URL
  console.log('--- Test 3: 视频信息提取 ---');
  const videoInfos = [];

  for (let i = 0; i < TEST_URLS.length; i++) {
    const url = TEST_URLS[i];
    const awemeId = extractAwemeId(url);

    if (!awemeId) {
      console.log(`  [${i + 1}] ❌ 无法提取 aweme_id: ${url.substring(0, 50)}`);
      continue;
    }

    try {
      console.log(`  [${i + 1}] 提取中: aweme_id=${awemeId}`);
      const info = await extractVideoMetadata(awemeId);
      videoInfos.push(info);
      console.log(`  ✅ 作者: ${info.author.nickname}`);
      console.log(`  ✅ 描述: ${(info.desc || '无').substring(0, 50)}`);
      console.log(`  ✅ 下载地址数: ${info.playAddr.length}`);
      console.log(`  ✅ 时长: ${info.duration}s`);
      console.log(`  ✅ 分辨率: ${info.width}x${info.height}`);
      if (info.downloadAddr.length > 0) {
        console.log(`  ✅ 独立下载地址数: ${info.downloadAddr.length}`);
      }
    } catch (e) {
      console.log(`  [${i + 1}] ❌ 提取失败: ${e.message}`);
    }
    console.log('');
    await sleep(config.apiDelayMs);
  }

  if (videoInfos.length === 0) {
    console.log('❌ 没有成功提取的视频信息，退出测试');
    await closeBrowser();
    process.exit(1);
  }

  // Test 4: Download first working video
  console.log('--- Test 4: 视频下载测试 ---');
  const testInfo = videoInfos[0];
  const urls = getBestVideoUrl(testInfo);
  const filename = makeFilename(testInfo.author.nickname, testInfo.desc, testInfo.awemeId);
  const destPath = path.join(config.downloadDir, filename);

  console.log(`  视频: ${testInfo.author.nickname} - ${(testInfo.desc || '无描述').substring(0, 40)}`);
  console.log(`  保存到: ${destPath}`);
  console.log(`  下载地址: ${urls[0]?.substring(0, 80)}...`);

  try {
    console.log('  开始下载...');
    const result = await downloadWithRetry(
      context,
      urls,
      destPath,
      (progress) => {
        const pct = progress.percent.toFixed(1);
        const speed = (progress.speed / 1024 / 1024).toFixed(1);
        const eta = progress.eta.toFixed(0);
        process.stdout.write(`\r  进度: ${pct}% | ${speed} MB/s | ETA ${eta}s  `);
      }
    );
    console.log(`\n  ✅ 下载完成! 大小: ${(result.bytesTotal / 1024 / 1024).toFixed(1)} MB`);
  } catch (e) {
    console.log(`\n  ❌ 下载失败: ${e.message}`);
  }

  console.log('');

  // Test 5: Download second video if available
  if (videoInfos.length > 1) {
    console.log('--- Test 5: 下载第二个视频 ---');
    const info2 = videoInfos[1];
    const urls2 = getBestVideoUrl(info2);
    const fn2 = makeFilename(info2.author.nickname, info2.desc, info2.awemeId);
    const dp2 = path.join(config.downloadDir, fn2);

    console.log(`  视频: ${info2.author.nickname} - ${(info2.desc || '无描述').substring(0, 40)}`);

    try {
      const result2 = await downloadWithRetry(
        context,
        urls2,
        dp2,
        (progress) => {
          const pct = progress.percent.toFixed(1);
          const speed = (progress.speed / 1024 / 1024).toFixed(1);
          process.stdout.write(`\r  进度: ${pct}% | ${speed} MB/s`);
        }
      );
      console.log(`\n  ✅ 下载完成! 大小: ${(result2.bytesTotal / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      console.log(`\n  ❌ 下载失败: ${e.message}`);
    }
  }

  console.log('\n=== 测试完成 ===');

  // List downloaded files
  console.log('\n下载目录内容:');
  const files = fs.readdirSync(config.downloadDir).filter(f => f.endsWith('.mp4'));
  for (const f of files) {
    const stat = fs.statSync(path.join(config.downloadDir, f));
    console.log(`  ${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  }

  await closeBrowser();
}

main().catch(e => {
  console.error('\n❌ 测试异常:', e.message);
  process.exit(1);
});
