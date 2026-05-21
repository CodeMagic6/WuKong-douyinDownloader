const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, 'dist');
const NAME = 'douyin-downloader.exe';

console.log('=== 构建抖音下载器 exe ===\n');

// Step 1: pkg compile
console.log('[1/3] 编译 exe...');
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
console.log('\n[2/3] 复制 playwright 原生模块...');
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

// Step 3: copy public/ (static files for express)
console.log('\n[3/3] 复制静态文件 public/...');
const publicDest = path.join(DIST, 'public');
copyAll(path.join(__dirname, 'public'), publicDest);
console.log('  public ✓');

// Step 4: create start/stop scripts
console.log('\n[4/4] 创建启动文件...');
const batContent = `@echo off
title Douyin Downloader
echo Starting...
wscript.exe "%~dp0launcher.vbs"
echo Open http://localhost:3000 in browser
echo Stop: double-click stop.bat
pause
`;
fs.writeFileSync(path.join(DIST, '启动.exe.bat'), batContent, 'utf-8');

const stopBatContent = `@echo off
echo Stopping...
taskkill /f /im ${NAME} >nul 2>&1
timeout /t 2 >nul
echo Stopped
pause
`;
fs.writeFileSync(path.join(DIST, '停止服务.bat'), stopBatContent, 'utf-8');

// Hidden VBS launcher — no console window to click/pause
const vbsContent = 'CreateObject("WScript.Shell").Run "' + NAME + '", 0, False\n';
fs.writeFileSync(path.join(DIST, 'launcher.vbs'), vbsContent, 'utf-8');

	// Browser shortcut for manual open
	const urlContent = '[InternetShortcut]\nURL=http://localhost:3000\n';
	fs.writeFileSync(path.join(DIST, '打开网页.url'), urlContent, 'utf-8');

console.log('\n=== 构建完成 ===');
console.log(`输出目录: ${DIST}`);
console.log(`启动方式: 双击 "启动.exe.bat"`);
console.log(`首次启动会自动安装 Chromium 浏览器 (约 2-3 分钟)\n`);

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
