class SSEBroadcaster {
  constructor(onEmpty) {
    this.clients = new Set();
    this._heartbeat = null;
    this._staleTimer = null;
    this._onEmpty = onEmpty || null;
  }

  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    this.clients.add(res);

    // Start heartbeat if first client
    if (!this._heartbeat) {
      this._heartbeat = setInterval(() => {
        this._heartbeatAll();
      }, 25000);
    }

    // Periodically clean stale clients (no activity check)
    if (!this._staleTimer) {
      this._staleTimer = setInterval(() => {
        this._cleanStale();
      }, 30000);
    }

    // Remove on disconnect
    req.on('close', () => {
      this.clients.delete(res);
      this._maybeStopTimers();
    });
  }

  /** Send heartbeat comments to all clients, remove those whose write fails */
  _heartbeatAll() {
    const msg = ': heartbeat\n\n';
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        this.clients.delete(client);
      }
    }
    this._maybeStopTimers();
  }

  /** Probe stale connections by sending a heartbeat; remove silent failures */
  _cleanStale() {
    if (this.clients.size === 0) return;
    const msg = ': stale-check\n\n';
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        this.clients.delete(client);
      }
    }
    this._maybeStopTimers();
  }

  _maybeStopTimers() {
    if (this.clients.size > 0) return;
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    if (this._staleTimer) {
      clearInterval(this._staleTimer);
      this._staleTimer = null;
    }
    if (this._onEmpty) {
      var cb = this._onEmpty;
      this._onEmpty = null; // Fire once
      cb();
    }
  }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  getClientCount() {
    return this.clients.size;
  }
}

module.exports = SSEBroadcaster;
