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

    this._timer = setInterval(() => {
      try {
        const text = this._getClipboardText();
        if (!text) return;

        const match = text.match(/(https?:\/\/(?:www\.)?(?:v\.)?douyin\.com\/\S+)/);
        if (!match) return;

        const url = match[1].replace(/[,.!?;:)\]}>"'$]+$/, '');
        if (url === this._lastUrl) return;
        this._lastUrl = url;

        console.log('[clipboard-watcher] 捕获:', url);
        if (config.autoDownload) {
          queue.add([url]);
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
      console.log('[clipboard-watcher] 停止');
    }
  }

  _getClipboardText() {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()';
    return execSync(
      `powershell -NoProfile -Command "${ps}"`,
      { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
  }
}

module.exports = ClipboardWatcher;
