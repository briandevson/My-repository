/**
 * Thin WebSocket wrapper. Every message is JSON with an `op` field; handlers are
 * registered per op and missing handlers are ignored rather than throwing.
 */
export class Net {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.queue = [];
  }

  on(op, handler) {
    this.handlers.set(op, handler);
    return this;
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${protocol}://${location.host}`);

    this.socket.addEventListener('open', () => {
      for (const message of this.queue) this.socket.send(message);
      this.queue = [];
      this.handlers.get('open')?.();
    });
    this.socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handlers.get(msg.op)?.(msg);
    });
    this.socket.addEventListener('close', () => this.handlers.get('close')?.());
    this.socket.addEventListener('error', () => this.handlers.get('close')?.());
  }

  send(op, payload = {}) {
    const message = JSON.stringify({ op, ...payload });
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
    else this.queue.push(message);
  }
}
