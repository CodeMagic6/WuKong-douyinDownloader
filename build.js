const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, 'dist');
const NAME = 'douyin-downloader.exe';

// 清理上次运行残留的用户状态，避免把你的设置/日志/下载打进分发包
['server.log', 'settings.json', 'test_bom.bat'].forEach(f => {
  try { fs.unlinkSync(path.join(DIST, f)); } catch {}
});
try { fs.rmSync(path.join(DIST, 'downloads'), { recursive: true, force: true }); } catch {}

console.log('=== 构建抖音下载器 exe ===\n');

// Step 1: pkg compile
console.log('[1/5] 编译 exe...');
try {
  execSync(`npx pkg server.js --target node18-win-x64 --output "${path.join(DIST, NAME)}"`, {
    cwd: __dirname,
    stdio: 'inherit',
    timeout: 120000
  });
} catch (e) {
  console.error('pkg 编译失败:', e.message);
  process.exit(1);
}

// Step 2: copy node_modules for external deps (playwright)
console.log('\n[2/5] 复制 playwright 原生模块...');
const NM = path.join(DIST, 'node_modules');
const copyDirs = ['playwright', 'playwright-core'];

for (const dir of copyDirs) {
  const src = path.join(__dirname, 'node_modules', dir);
  const dest = path.join(NM, dir);
  if (!fs.existsSync(src)) {
    console.warn(`  警告: node_modules/${dir} 不存在`);
    continue;
  }
  copyRecursive(src, dest);
  console.log(`  ${dir} ✓`);
}

// Step 3: bundle Chromium so the app runs offline with no Node install
console.log('\n[3/5] 打包 Chromium 浏览器...');
let versionName = null;
try {
  const { chromium } = require('playwright');
  const exePath = chromium.executablePath();
  const versionDir = path.dirname(path.dirname(exePath)); // .../ms-playwright/chromium-1223
  versionName = path.basename(versionDir);
  if (!fs.existsSync(exePath)) {
    console.warn('  未找到本机 Chromium，跳过。请先运行: npx playwright install chromium');
    versionName = null;
  } else {
    const destBrowsers = path.join(DIST, 'ms-playwright');
    fs.rmSync(destBrowsers, { recursive: true, force: true });
    const destVersion = path.join(destBrowsers, versionName);
    fs.mkdirSync(destBrowsers, { recursive: true });
    console.log(`  复制 ${versionName} (约 400MB, 请稍候)...`);
    fs.cpSync(versionDir, destVersion, { recursive: true });
    console.log(`  ${versionName} ✓`);
  }
} catch (e) {
  console.warn('  打包 Chromium 失败:', e.message);
  versionName = null;
}

// Step 4: copy public/ (static files for express)
console.log('\n[4/5] 复制静态文件 public/...');
const publicDest = path.join(DIST, 'public');
copyAll(path.join(__dirname, 'public'), publicDest);
console.log('  public ✓');

// Step 5: create launcher files (one visible file for novices)
console.log('\n[5/5] 创建启动文件...');
['启动.exe.bat', '打开网页.url', 'launcher.vbs', '双击启动.bat', '停止服务.bat', '停止.bat'].forEach(f => {
  try { fs.unlinkSync(path.join(DIST, f)); } catch {}
});

// Hidden VBS launcher — no console window to click/pause, correct working dir
const vbsContent = 'Set fso=CreateObject("Scripting.FileSystemObject"):Set sh=CreateObject("WScript.Shell"):sh.CurrentDirectory=fso.GetParentFolderName(WScript.ScriptFullName):sh.Run "' + NAME + '",0,False\r\n';
fs.writeFileSync(path.join(DIST, 'launcher.vbs'), vbsContent, 'utf-8');

// ASCII body (no encoding pitfalls in cmd); Chinese name carries the meaning
const batContent = '@echo off\r\ncd /d "%~dp0"\r\nwscript.exe "%~dp0launcher.vbs"\r\n';
fs.writeFileSync(path.join(DIST, '双击启动.bat'), batContent, 'utf-8');

const stopBatContent = '@echo off\r\ntaskkill /f /im ' + NAME + ' >nul 2>&1\r\ntimeout /t 2 >nul\r\n';
fs.writeFileSync(path.join(DIST, '停止.bat'), stopBatContent, 'utf-8');

console.log('\n=== 构建完成 ===');
console.log(`输出目录: ${DIST}`);
console.log('分发方式: 把整个 dist 文件夹压缩发给用户, 解压后双击 "双击启动.bat"');
console.log(versionName ? '浏览器已内置, 首次运行无需联网 ✓' : '⚠️ 未内置浏览器, 首次运行需联网下载');

// Helpers
function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'test', 'tests', 'examples'].includes(entry.name)) continue;
      copyRecursive(s, d);
    } else {
      if (/\.(js|json|node|d\.ts)$/i.test(entry.name)) {
        try { fs.copyFileSync(s, d); } catch {}
      }
    }
  }
}

function copyAll(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      copyAll(s, d);
    } else {
      try { fs.copyFileSync(s, d); } catch {}
    }
  }
}
