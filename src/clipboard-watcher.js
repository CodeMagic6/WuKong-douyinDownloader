const { exec } = require('child_process');
const os = require('os');

class ClipboardWatcher {
  constructor() {
    this._timer = null;
    this._lastUrl = '';
    this._polling = false; // Bug 修复 1: 初始化必须为 false
    this._pollStart = 0;
  }

  start(config, queue, sse) {
    this.stop();
    this._lastUrl = '';
    this._polling = false;
    this._pollStart = 0;
    console.log('[clipboard-watcher] 启动 (异步轮询间隔 1.5s)');

    let heartbeat = 0;

    // 辅助函数：统一管理下一次轮询触发，避免重复设置 timer
    const scheduleNext = (delay = 1500) => {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(poll, delay);
    };

    const poll = () => {
      // 安全检查: 如果上一次子进程卡死超过 8 秒，强制解锁重试
      if (this._polling) {
        const elapsed = Date.now() - this._pollStart;
        if (this._pollStart > 0 && elapsed > 8000) {
          console.warn(`[clipboard-watcher] ⚠ 剪切板读取超时 (${elapsed}ms)，强制恢复轮询`);
          this._polling = false;
          this._pollStart = 0;
        } else {
          // 上一次查询仍在进行中，跳过本次循环
          scheduleNext(1500);
          return;
        }
      }

      this._polling = true;
      this._pollStart = Date.now();

      this._getClipboardTextAsync((err, text) => {
        // Bug 修复 2: 无论成功还是失败，回调结束时必须重置 _polling 为 false
        this._polling = false;
        this._pollStart = 0;

        if (err || !text) {
          heartbeat++;
          if (heartbeat % 20 === 0) console.log('[clipboard-watcher] 运行中 ...');
          scheduleNext(1500);
          return;
        }

        const urlPatterns = [
          /(https?:\/\/(?:www\.)?(?:v\.)?douyin\.com\/\S+)/,
          /(https?:\/\/(?:www\.)?bilibili\.com\/video\/\S+)/,
          /(https?:\/\/b23\.tv\/\S+)/,
          /(https?:\/\/space\.bilibili\.com\/\d+\S*)/
        ];

        let matchedUrl = null;
        for (const pattern of urlPatterns) {
          const m = text.match(pattern);
          if (m) {
            matchedUrl = m[1];
            break;
          }
        }

        if (!matchedUrl) {
          scheduleNext(1500);
          return;
        }

        // 清除 URL 结尾可能多余的标点符号
        const url = matchedUrl.replace(/[,.!?;:)\]}>"'$]+$/, '');
        if (url === this._lastUrl) {
          scheduleNext(1500);
          return;
        }

        this._lastUrl = url;
        console.log(`[clipboard-watcher] ✅ 捕获新链接: ${url}`);

        try {
          if (config && config.autoDownload) {
            if (queue && typeof queue.add === 'function') {
              queue.add([url]);
              console.log('[clipboard-watcher] ↳ 已加入下载队列');
            }
          } else if (sse && typeof sse.broadcast === 'function') {
            sse.broadcast('clipboard_captured', { url });
          }
        } catch (e) {
          console.error('[clipboard-watcher] 处理捕获链接失败:', e.message);
        }

        scheduleNext(1500);
      });
    };

    poll();
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._lastUrl = '';
    this._polling = false;
    this._pollStart = 0;
    console.log('[clipboard-watcher] 已停止');
  }

  _getClipboardTextAsync(callback) {
    const platform = os.platform();

    if (platform === 'win32') {
      // 优化: 显式设置 OutputEncoding 为 UTF8，防止 Windows 编码导致中文/特殊字符乱码或报错
      const cmd1 = `powershell -NoProfile -STA -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw"`;

      exec(cmd1, { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (!err && stdout && stdout.trim()) {
          return callback(null, stdout.trim());
        }
        this._execWinFallback(callback);
      });
    } else if (platform === 'darwin') {
      exec('pbpaste', { encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
        callback(err, stdout ? stdout.trim() : '');
      });
    } else {
      // Linux 备用方案
      exec('xclip -selection clipboard -o', { encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
        callback(err, stdout ? stdout.trim() : '');
      });
    }
  }

  _execWinFallback(callback) {
    const cmd2 = `powershell -NoProfile -STA -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"`;
    exec(cmd2, { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (err, stdout) => {
      callback(err, stdout ? stdout.trim() : '');
    });
  }
}

module.exports = ClipboardWatcher;