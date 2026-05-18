const { exec } = require('child_process');

class ClipboardWatcher {
  constructor() {
    this._timer = null;
    this._lastUrl = '';
    this._polling = false;
    this._pollStart = 0;
    this._stuckWarned = false;
  }

  start(config, queue, sse) {
    this.stop();
    this._lastUrl = '';
    this._polling = false;
    this._pollStart = 0;
    console.log('[clipboard-watcher] 启动 (异步轮询间隔 1.5s)');

    let heartbeat = 0;

    const poll = () => {
      // Safety: force reset _polling if stuck > 8s (PowerShell can hang silently on Windows)
      if (this._polling) {
        const elapsed = Date.now() - this._pollStart;
        if (this._pollStart > 0 && elapsed > 8000) {
          console.log(`[clipboard-watcher] ⚠ 轮询卡死 ${elapsed}ms, 强制恢复`);
          this._polling = false;
          this._stuckWarned = true;
        } else {
          // Still within grace window — wait
          this._timer = setTimeout(poll, 1500);
          return;
        }
      }

      this._polling = true;
      this._pollStart = Date.now();

      this._getClipboardTextAsync((err, text) => {
        this._polling = false;
        this._pollStart = 0;

        if (err) {
          heartbeat++;
          if (heartbeat % 20 === 0) console.log('[clipboard-watcher] 运行中 ...');
          this._timer = setTimeout(poll, 1500);
          return;
        }

        if (!text) {
          heartbeat++;
          if (heartbeat % 20 === 0) console.log('[clipboard-watcher] 运行中 ...');
          this._timer = setTimeout(poll, 1500);
          return;
        }

        const match = text.match(/(https?:\/\/(?:www\.)?(?:v\.)?douyin\.com\/\S+)/);
        if (!match) {
          this._timer = setTimeout(poll, 1500);
          return;
        }

        const url = match[1].replace(/[,.!?;:)\]}>"'$]+$/, '');
        if (url === this._lastUrl) {
          this._timer = setTimeout(poll, 1500);
          return;
        }
        this._lastUrl = url;

        console.log(`[clipboard-watcher] ✅ 捕获: ${url}`);
        try {
          if (config.autoDownload) {
            queue.add([url]);
            console.log('[clipboard-watcher] ↳ 已加入下载队列');
          } else {
            sse.broadcast('clipboard_captured', { url });
          }
        } catch (e) {
          console.error('[clipboard-watcher] 添加下载失败:', e.message);
        }

        this._timer = setTimeout(poll, 1500);
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

  /** Async clipboard read via PowerShell — never blocks event loop */
  _getClipboardTextAsync(callback) {
    const cmd1 = `powershell -NoProfile -STA -Command "Get-Clipboard -Raw -TextFormatType UnicodeText 2>$null; if (-not $?) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText() }"`;

    exec(cmd1, { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) {
        // Primary cmd failed — try fallback
        this._execFallback(callback);
        return;
      }
      const result = stdout.trim();
      if (result) {
        callback(null, result);
        return;
      }
      // Empty result — try fallback
      this._execFallback(callback);
    });
  }

  _execFallback(callback) {
    const cmd2 = `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"`;
    exec(cmd2, { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (err, stdout) => {
      callback(err, stdout ? stdout.trim() : '');
    });
  }
}

module.exports = ClipboardWatcher;
