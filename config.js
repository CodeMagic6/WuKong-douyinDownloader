const path = require('path');
const os = require('os');

// pkg: exe runs from dist/, use parent dir as base so downloads go to project root
const baseDir = typeof process.pkg !== 'undefined'
  ? path.resolve(path.dirname(process.execPath), '..')
  : __dirname;

module.exports = {
  port: parseInt(process.env.PORT || '9090', 10),
  defaultDownloadDir: path.join(baseDir, 'downloads'),
  downloadDir: path.join(baseDir, 'downloads'),
  customDownloadDir: '',
  useCustomDir: false,
  saveMode: 'auto', // 'auto' = 静默保存到目录 | 'manual' = 弹窗选路径
  clipboardCapture: false,
  autoDownload: false,
  cookieFile: path.join(os.homedir(), '.claude', 'douyin_cookies.json'),
  bilibiliCookieFile: path.join(os.homedir(), '.claude', 'bilibili_cookies.json'),
  maxConcurrent: 3,
  maxRetries: 3,
  retryDelayMs: 2000,
  apiDelayMs: 800,
  browserHeadless: true,
  viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  browserArgs: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process'
  ]
};
