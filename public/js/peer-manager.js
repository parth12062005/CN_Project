// ═══════════════════════════════════════════════
//  PEER CONNECTION MANAGER (WebRTC DataChannel)
//
//  Maintains a pool of RTCPeerConnections.
//  Each connection has a DataChannel "chunks"
//  for bidirectional chunk transfer.
// ═══════════════════════════════════════════════
class PeerConnectionManager {
  constructor(signalingClient, cache) {
    this.signaling = signalingClient;
    this.cache = cache;
    this.connections = new Map();

    signalingClient.on('offer', (msg) => this._handleOffer(msg));
    signalingClient.on('answer', (msg) => this._handleAnswer(msg));
    signalingClient.on('ice-candidate', (msg) => this._handleICE(msg));

    setInterval(() => this._cleanIdle(), 10000);
  }

  async getConnection(webrtcId) {
    const existing = this.connections.get(webrtcId);
    if (existing) {
      log(`🔗 getConnection(${webrtcId.slice(0, 8)}): existing found — ready=${existing.ready}, dc=${existing.dc?.readyState || 'null'}`);
      if (existing.ready && existing.dc && existing.dc.readyState === 'open') {
        existing.lastUsed = Date.now();
        return existing;
      }
    } else {
      log(`🔗 getConnection(${webrtcId.slice(0, 8)}): no existing connection`);
    }

    log(`🔗 Creating NEW WebRTC connection to ${webrtcId.slice(0, 8)} (initiator=true)…`);
    return this._createConnection(webrtcId, true);
  }

  async _createConnection(webrtcId, isInitiator) {
    log(`🔗 _createConnection(${webrtcId.slice(0, 8)}, initiator=${isInitiator})`);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const conn = {
      pc,
      dc: null,
      lastUsed: Date.now(),
      pendingRequests: new Map(),
      ready: false,
      reassembly: new Map(),
    };

    this.connections.set(webrtcId, conn);

    let iceCount = 0;
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        iceCount++;
        if (iceCount <= 3) log(`🧊 ICE candidate #${iceCount} → ${e.candidate.type} ${e.candidate.protocol} ${e.candidate.address}:${e.candidate.port}`);
        this.signaling.send({
          type: 'ice-candidate',
          target: webrtcId,
          payload: e.candidate,
        });
      } else {
        log(`🧊 ICE gathering complete (${iceCount} candidates)`);
      }
    };

    pc.oniceconnectionstatechange = () => {
      log(`🧊 ICE connection state: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      log(`🔗 Connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        log(`🔗 Connection ${pc.connectionState} — cleaning up ${webrtcId.slice(0, 8)}`);
        this._cleanup(webrtcId);
      }
    };

    if (isInitiator) {
      log(`🔗 Creating DataChannel 'chunks' (ordered)...`);
      const dc = pc.createDataChannel('chunks', { ordered: true });
      dc.binaryType = 'arraybuffer';
      conn.dc = dc;
      this._setupDC(dc, webrtcId, conn);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      log(`🔗 SDP offer created & sent to ${webrtcId.slice(0, 8)}`);
      this.signaling.send({
        type: 'offer',
        target: webrtcId,
        payload: pc.localDescription,
      });

      log(`🔗 Waiting for DataChannel to open...`);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { log(`❌ DC open TIMEOUT (5s) for ${webrtcId.slice(0, 8)}`); reject(new Error('DC open timeout')); }, 5000);
        dc.onopen = () => { clearTimeout(timeout); conn.ready = true; log(`🤝 DataChannel OPEN (outgoing to ${webrtcId.slice(0, 8)}) readyState=${dc.readyState}`); resolve(); };
        dc.onerror = (e) => { clearTimeout(timeout); log(`❌ DC error: ${e.error?.message || 'unknown'}`); reject(new Error('DC error')); };
      });
    } else {
      log(`🔗 Waiting for incoming DataChannel from ${webrtcId.slice(0, 8)}...`);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { log(`❌ DC incoming TIMEOUT (5s)`); reject(new Error('DC incoming timeout')); }, 5000);
        pc.ondatachannel = (evt) => {
          clearTimeout(timeout);
          const dc = evt.channel;
          log(`🔗 Incoming DataChannel received: label=${dc.label}, readyState=${dc.readyState}`);
          dc.binaryType = 'arraybuffer';
          conn.dc = dc;
          this._setupDC(dc, webrtcId, conn);
          dc.onopen = () => { conn.ready = true; log(`🤝 DataChannel OPEN (incoming from ${webrtcId.slice(0, 8)})`); resolve(); };
        };
      });
    }

    log(`🔗 Connection to ${webrtcId.slice(0, 8)} fully established`);
    return conn;
  }

  _setupDC(dc, webrtcId, conn) {
    dc.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }

        if (msg.type === 'have_chunk') {
          const have = this.cache ? this.cache.has(msg.chunkId) : false;
          const dataType = this.cache ? (this.cache.getData(msg.chunkId) ? typeof this.cache.getData(msg.chunkId) : 'null') : 'no-cache';
          log(`📋 have_chunk query for seg${msg.chunkId} → ${have} (dataType=${dataType})`);
          dc.send(JSON.stringify({
            type: 'have_chunk_response',
            chunkId: msg.chunkId,
            have,
          }));
        } else if (msg.type === 'have_chunk_response') {
          log(`📋 have_chunk_response for seg${msg.chunkId} → ${msg.have}`);
          const req = conn.pendingRequests.get('have_' + msg.chunkId);
          if (req) { clearTimeout(req.timer); req.resolve(msg.have); conn.pendingRequests.delete('have_' + msg.chunkId); }
          else { log(`⚠️ No pending request found for have_${msg.chunkId}`); }
        } else if (msg.type === 'chunk_request') {
          log(`📬 Received chunk_request for seg${msg.chunkId} — calling _serveChunk...`);
          this._serveChunk(dc, msg.chunkId);
        } else if (msg.type === 'chunk_header') {
          log(`📦 chunk_header received for seg${msg.chunkId} — totalSize=${msg.totalSize} bytes (${(msg.totalSize/1024).toFixed(0)}KB)`);
          conn.reassembly.set(msg.chunkId, {
            totalSize: msg.totalSize,
            received: [],
            receivedBytes: 0,
          });
        } else if (msg.type === 'chunk_complete') {
          const ra = conn.reassembly.get(msg.chunkId);
          if (ra) {
            try {
              log(`📦 Finalizing reassembly for seg${msg.chunkId} (${ra.receivedBytes}/${ra.totalSize} bytes)...`);
              const fullBuf = this._concat(ra.received, ra.totalSize);
              conn.reassembly.delete(msg.chunkId);
              const req = conn.pendingRequests.get('chunk_' + msg.chunkId);
              if (req) { clearTimeout(req.timer); req.resolve(fullBuf); conn.pendingRequests.delete('chunk_' + msg.chunkId); }
            } catch (err) {
              log(`❌ Reassembly crash for seg${msg.chunkId}: ${err.message}`);
            }
          } else {
             log(`❌ Received chunk_complete but no reassembly state for seg${msg.chunkId}`);
          }
        } else if (msg.type === 'chunk_not_found') {
          log(`🚫 chunk_not_found received for seg${msg.chunkId}`);
          const req = conn.pendingRequests.get('chunk_' + msg.chunkId);
          if (req) { clearTimeout(req.timer); req.resolve(null); conn.pendingRequests.delete('chunk_' + msg.chunkId); }
        } else {
          log(`⚠️ Unknown DC message type: ${msg.type}`);
        }
      } else {
        let found = false;
        for (const [id, ra] of conn.reassembly) {
          ra.received.push(new Uint8Array(evt.data));
          ra.receivedBytes += evt.data.byteLength;
          if (ra.received.length === 1) {
            log(`📡 Receiving first binary slice for seg${id}...`);
          }
          found = true;
          break;
        }
        if (!found) {
          log(`⚠️ Received binary data, but no active reassembly window!`);
        }
      }
    };

    dc.onclose = () => { log(`🔗 DataChannel CLOSED for ${webrtcId.slice(0, 8)}`); this._cleanup(webrtcId); };
    dc.onerror = (e) => { log(`❌ DataChannel ERROR for ${webrtcId.slice(0, 8)}: ${e.error?.message || 'unknown'}`); this._cleanup(webrtcId); };
  }

  async _serveChunk(dc, chunkId) {
    if (!this.cache) {
      log(`🚫 _serveChunk(seg${chunkId}): NO CACHE object`);
      dc.send(JSON.stringify({ type: 'chunk_not_found', chunkId }));
      return;
    }
    const data = this.cache.getData(chunkId);
    const dataInfo = data ? `type=${data.constructor?.name}, size=${data.byteLength || data.length || '?'}` : 'NULL';
    log(`🔬 _serveChunk(seg${chunkId}): data=${dataInfo}`);

    if (!data || data === true || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
      dc.send(JSON.stringify({ type: 'chunk_not_found', chunkId }));
      log(`🚫 Can't serve seg${chunkId} — not an ArrayBuffer (got ${dataInfo})`);
      return;
    }

    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const bytes = new Uint8Array(buf);
    log(`📤 Serving seg${chunkId} to peer (${(bytes.byteLength / 1024).toFixed(0)}KB)`);

    try {
      dc.send(JSON.stringify({ type: 'chunk_header', chunkId, totalSize: bytes.byteLength }));

      let offset = 0;
      dc.bufferedAmountLowThreshold = 65536;

      let slicesSent = 0;
      let backpressureHits = 0;

      const sendSlices = async () => {
        try {
          while (offset < bytes.byteLength) {
            if (dc.readyState !== 'open') {
              log(`❌ DC closed mid-send seg${chunkId} at offset ${offset}/${bytes.byteLength}`);
              return;
            }

            if (dc.bufferedAmount > 65536) {
              backpressureHits++;
              await new Promise(r => setTimeout(r, 10));
              continue;
            }

            const end = Math.min(offset + DC_CHUNK_SIZE, bytes.byteLength);
            dc.send(bytes.subarray(offset, end));
            offset = end;
            slicesSent++;

            const pct = Math.floor((offset / bytes.byteLength) * 100);
            if (pct % 25 === 0 && pct > 0 && slicesSent > 1) {
              log(`📤 seg${chunkId} sending: ${pct}% (${slicesSent} slices, ${backpressureHits} waits, buffered=${dc.bufferedAmount})`);
            }
          }

          dc.send(JSON.stringify({ type: 'chunk_complete', chunkId }));
          log(`📤 ✅ Finished sending seg${chunkId} — ${bytes.byteLength} bytes, ${slicesSent} slices, ${backpressureHits} backpressure waits`);
        } catch (err) {
          log(`❌ DataChannel send CRASH seg${chunkId} at offset ${offset}: ${err.message}`);
        }
      };

      sendSlices();

    } catch (err) {
      log(`❌ DataChannel start send error seg${chunkId}: ${err.message}`);
    }
  }

  _concat(chunks, totalSize) {
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result.buffer;
  }

  haveChunk(webrtcId, chunkId) {
    const conn = this.connections.get(webrtcId);
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
      log(`📋 haveChunk(${webrtcId.slice(0, 8)}, seg${chunkId}): NO open DC — returning false`);
      return Promise.resolve(false);
    }

    log(`📋 haveChunk → sending have_chunk query for seg${chunkId} to ${webrtcId.slice(0, 8)} (timeout=${P2P_HAVE_TIMEOUT}ms)`);
    return new Promise((resolve) => {
      const key = 'have_' + chunkId;
      const timer = setTimeout(() => {
        log(`📋 haveChunk TIMEOUT for seg${chunkId} from ${webrtcId.slice(0, 8)} (${P2P_HAVE_TIMEOUT}ms)`);
        conn.pendingRequests.delete(key); resolve(false);
      }, P2P_HAVE_TIMEOUT);
      conn.pendingRequests.set(key, { resolve, timer });
      conn.dc.send(JSON.stringify({ type: 'have_chunk', chunkId }));
    });
  }

  requestChunk(webrtcId, chunkId) {
    const conn = this.connections.get(webrtcId);
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
      log(`📥 requestChunk(${webrtcId.slice(0, 8)}, seg${chunkId}): NO open DC — returning null`);
      return Promise.resolve(null);
    }

    log(`📥 requestChunk → sending chunk_request for seg${chunkId} to ${webrtcId.slice(0, 8)} (timeout=${P2P_CHUNK_TIMEOUT}ms)`);
    conn.lastUsed = Date.now();
    return new Promise((resolve) => {
      const key = 'chunk_' + chunkId;
      const timer = setTimeout(() => {
        log(`📥 requestChunk TIMEOUT for seg${chunkId} from ${webrtcId.slice(0, 8)} (${P2P_CHUNK_TIMEOUT}ms) — reassembly had ${conn.reassembly.get(chunkId)?.receivedBytes || 0} bytes`);
        conn.pendingRequests.delete(key); conn.reassembly.delete(chunkId); resolve(null);
      }, P2P_CHUNK_TIMEOUT);
      conn.pendingRequests.set(key, { resolve, timer });
      conn.dc.send(JSON.stringify({ type: 'chunk_request', chunkId }));
    });
  }

  async _handleOffer(msg) {
    try {
      log(`📨 Received WebRTC OFFER from ${msg.from.slice(0, 8)}`);
      if (this.connections.has(msg.from)) {
        log(`📨 Cleaning up existing connection to ${msg.from.slice(0, 8)} before accepting offer`);
        this._cleanup(msg.from);
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      const conn = { pc, dc: null, lastUsed: Date.now(), pendingRequests: new Map(), ready: false, reassembly: new Map() };
      this.connections.set(msg.from, conn);

      let iceCount = 0;
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          iceCount++;
          this.signaling.send({ type: 'ice-candidate', target: msg.from, payload: e.candidate });
        } else {
          log(`🧊 ICE gathering complete for incoming (${iceCount} candidates)`);
        }
      };
      pc.oniceconnectionstatechange = () => {
        log(`🧊 ICE state (incoming from ${msg.from.slice(0, 8)}): ${pc.iceConnectionState}`);
      };
      pc.onconnectionstatechange = () => {
        log(`🔗 Conn state (incoming from ${msg.from.slice(0, 8)}): ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this._cleanup(msg.from);
      };

      pc.ondatachannel = (evt) => {
        const dc = evt.channel;
        log(`📨 Incoming DataChannel label=${dc.label} readyState=${dc.readyState}`);
        dc.binaryType = 'arraybuffer';
        conn.dc = dc;
        this._setupDC(dc, msg.from, conn);
        dc.onopen = () => { conn.ready = true; log(`🤝 DataChannel OPEN (incoming from ${msg.from.slice(0, 8)})`); };
      };

      await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send({ type: 'answer', target: msg.from, payload: pc.localDescription });
      log(`📨 SDP ANSWER sent to ${msg.from.slice(0, 8)}`);
    } catch (e) {
      log(`⚠ Failed to handle offer from ${msg.from}: ${e.message}`);
    }
  }

  async _handleAnswer(msg) {
    log(`📨 Received SDP ANSWER from ${msg.from.slice(0, 8)}`);
    const conn = this.connections.get(msg.from);
    if (conn && conn.pc) {
      try {
        await conn.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
        log(`📨 Remote description set for ${msg.from.slice(0, 8)}`);
      } catch (e) {
        log(`⚠ Failed to set remote description from ${msg.from.slice(0, 8)}: ${e.message}`);
      }
    } else {
      log(`⚠ _handleAnswer: no connection found for ${msg.from.slice(0, 8)}`);
    }
  }

  _handleICE(msg) {
    const conn = this.connections.get(msg.from);
    if (conn && conn.pc) {
      conn.pc.addIceCandidate(new RTCIceCandidate(msg.payload)).catch((e) => {
        log(`⚠ ICE candidate add failed from ${msg.from.slice(0, 8)}: ${e.message}`);
      });
    } else {
      log(`⚠ _handleICE: no connection for ${msg.from.slice(0, 8)}`);
    }
  }

  _cleanup(webrtcId) {
    const conn = this.connections.get(webrtcId);
    if (conn) {
      log(`🧹 Cleaning up connection to ${webrtcId.slice(0, 8)} — pending=${conn.pendingRequests.size}, reassembly=${conn.reassembly.size}`);
      if (conn.dc) try { conn.dc.close(); } catch {}
      if (conn.pc) try { conn.pc.close(); } catch {}
      for (const [key, req] of conn.pendingRequests) {
        log(`🧹 Rejecting pending request: ${key}`);
        clearTimeout(req.timer);
        req.resolve(null);
      }
      this.connections.delete(webrtcId);
    }
  }

  _cleanIdle() {
    const now = Date.now();
    for (const [id, conn] of this.connections) {
      if (now - conn.lastUsed > CONN_IDLE_TIMEOUT) {
        this._cleanup(id);
      }
    }
  }

  destroy() {
    for (const [id] of this.connections) this._cleanup(id);
  }
}
