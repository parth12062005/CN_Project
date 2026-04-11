// ═══════════════════════════════════════════════
//  SIGNALING CLIENT (WebSocket)
// ═══════════════════════════════════════════════
class SignalingClient {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    log(`🔌 WebSocket connecting to ${url}...`);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.ws.send(JSON.stringify({ type: 'join', webrtcId: WEBRTC_ID }));
      log(`🔌 WebSocket CONNECTED — sent join as ${WEBRTC_ID}`);
    };

    this.ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      log(`🔌 WS ← ${msg.type} from=${msg.from || '?'}`);
      const handler = this.handlers[msg.type];
      if (handler) handler(msg);
      else log(`🔌 WS: no handler for type '${msg.type}'`);
    };

    this.ws.onclose = (evt) => {
      this.connected = false;
      log(`🔌 WebSocket CLOSED (code=${evt.code}, reason=${evt.reason || 'none'}) — reconnecting in 3s`);
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      log(`🔌 WebSocket ERROR: ${err.message || 'unknown'}`);
    };
  }

  on(type, cb) { this.handlers[type] = cb; }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      log(`🔌 WS → ${msg.type} target=${msg.target || '?'}`);
      this.ws.send(JSON.stringify(msg));
    } else {
      log(`🔌 WS SEND FAILED (readyState=${this.ws?.readyState}) — ${msg.type}`);
    }
  }
}
