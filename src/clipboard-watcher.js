const { execSync } = require('child_process');

class ClipboardWatcher {
  constructor() {
    this._timer = null;
    this._lastUrl = '';
  }

  start(config, queue, sse) {
    this.stop();
    this._lastUrl = '';
    console.log('[clipboard-watcher] 启动 (轮询间隔 1.5s)');

    let heartbeat = 0;
    this._timer = setInterval(() => {
      try {
        const text = this._getClipboardText();
        if (!text) {
          // Heartbeat every 30s so user knows watcher alive
          heartbeat++;
          if (heartbeat % 20 === 0) {
            console.log('[clipboard-watcher] 运行中 ...');
          }
          return;
        }

        const match = text.match(/(https?:\/\/(?:www\.)?(?:v\.)?douyin\.com\/\S+)/);
        if (!match) return;

        const url = match[1].replace(/[,.!?;:)\]}>"'$]+$/, '');
        if (url === this._lastUrl) return;
        this._lastUrl = url;

        console.log(`[clipboard-watcher] ✅ 捕获: ${url}`);
        if (config.autoDownload) {
          queue.add([url]);
          console.log('[clipboard-watcher] ↳ 已加入下载队列');
        } else {
          sse.broadcast('clipboard_captured', { url });
        }
      } catch {}
    }, 1500);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this._lastUrl = '';
      console.log('[clipboard-watcher] 已停止');
    }
  }

  _getClipboardText() {
    // Try Get-Clipboard (PowerShell 5.0+ built-in, more reliable)
    try {
      const result = execSync(
        `powershell -NoProfile -STA -Command "Get-Clipboard -Raw -TextFormatType UnicodeText 2>$null; if (-not $?) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText() }"`,
        { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
      ).trim();
      if (result) return result;
    } catch {}

    // Fallback: direct .NET method
    try {
      const result = execSync(
        `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"`,
        { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
      ).trim();
      return result;
    } catch {
      return '';
    }
  }
}

module.exports = ClipboardWatcher;
