class SSEBroadcaster {
  constructor() {
    this.clients = new Set();
    this._heartbeat = null;
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

    // Remove on disconnect
    req.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0 && this._heartbeat) {
        clearInterval(this._heartbeat);
        this._heartbeat = null;
      }
    });
  }

  _heartbeatAll() {
    const msg = ': heartbeat\n\n';
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        this.clients.delete(client);
      }
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
