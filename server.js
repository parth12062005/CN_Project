const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

http.globalAgent.maxSockets = Infinity;

const app = express();
const PORT = 3000;

// ─── Logger ─────────────────────────────────────────────
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
  bgBlue: '\x1b[44m',
};

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

const LOG = {
  req(method, url, ip, extra = '') {
    const c = COLORS;
    const methodColor = method === 'GET' ? c.green : c.yellow;
    console.log(`${c.dim}${timestamp()}${c.reset} ${methodColor}${method.padEnd(5)}${c.reset} ${url} ${c.dim}← ${ip}${c.reset}${extra ? ' ' + extra : ''}`);
  },
  chunk(videoName, segFile, ip, sizeBytes) {
    const c = COLORS;
    const sizeKB = (sizeBytes / 1024).toFixed(0);
    console.log(`${c.dim}${timestamp()}${c.reset} ${c.cyan}CHUNK${c.reset} ${videoName}/${segFile} ${c.dim}(${sizeKB}KB → ${ip})${c.reset}`);
  },
  peer(action, peerId, details = '') {
    const c = COLORS;
    const color = action === 'JOIN' ? c.green : action === 'LEAVE' ? c.red : c.blue;
    console.log(`${c.dim}${timestamp()}${c.reset} ${color}PEER ${action}${c.reset} ${peerId} ${c.dim}${details}${c.reset}`);
  },
  cache(peerId, chunks) {
    const c = COLORS;
    const range = chunks.length > 0 ? `[${chunks[0]}…${chunks[chunks.length - 1]}] (${chunks.length} chunks)` : '(empty)';
    console.log(`${c.dim}${timestamp()}${c.reset} ${c.magenta}CACHE${c.reset} ${peerId} → ${range}`);
  },
  ws(action, id, details = '') {
    const c = COLORS;
    console.log(`${c.dim}${timestamp()}${c.reset} ${c.blue}WS   ${c.reset} ${action} ${id} ${c.dim}${details}${c.reset}`);
  },
  info(msg) {
    const c = COLORS;
    console.log(`${c.dim}${timestamp()}${c.reset} ${c.white}INFO ${c.reset} ${msg}`);
  },
  warn(msg) {
    const c = COLORS;
    console.log(`${c.dim}${timestamp()}${c.reset} ${c.yellow}WARN ${c.reset} ${msg}`);
  },
};

// ─── LAN IP detection ───────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();
const OUTPUT_DIR = path.join(__dirname, 'output');

// ─── In-memory peer registry (P2P) ──────────────────────
const peers = new Map();
const signalingClients = new Map();

function cleanStalePeers() {
  const now = Date.now();
  for (const [id, peer] of peers) {
    if (now - peer.lastSeen > 30000) {
      peers.delete(id);
      LOG.peer('STALE', id, `removed after 30s inactivity`);
    }
  }
}
setInterval(cleanStalePeers, 10000);

// ─── Middleware ─────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// Request logger — logs every HTTP request
app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '?';
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const url = req.originalUrl;

    // Skip logging for static frontend assets (js, css, fonts, etc.)
    if (url.startsWith('/stream/') && url.endsWith('.ts')) {
      // Chunk requests get special logging
      const parts = url.replace('/stream/', '').split('/');
      const videoName = parts[0];
      const segFile = parts[parts.length - 1];
      const filePath = path.join(OUTPUT_DIR, videoName, segFile);
      const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      LOG.chunk(videoName, segFile, ip, size);
    } else if (url.startsWith('/stream/') && url.endsWith('.m3u8')) {
      LOG.req(req.method, url, ip, `${res.statusCode} ${ms}ms [playlist]`);
    } else if (url.startsWith('/api/')) {
      LOG.req(req.method, url, ip, `${res.statusCode} ${ms}ms`);
    }
    // Silently skip frontend static files (html, js, css, images)
  });

  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Serve HLS content per video ────────────────────────
app.use('/stream', (req, res, next) => {
  const ext = path.extname(req.url).toLowerCase();
  const mimeTypes = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  if (mimeTypes[ext]) {
    res.setHeader('Content-Type', mimeTypes[ext]);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (ext === '.m3u8') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (ext === '.ts') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
  next();
});

app.use('/stream', express.static(OUTPUT_DIR));

// ─── API: Video Library ─────────────────────────────────
app.get('/api/videos', (req, res) => {
  if (!fs.existsSync(OUTPUT_DIR)) {
    LOG.info('Library request — output dir missing, returning empty');
    return res.json({ videos: [] });
  }

  const entries = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true });
  const videos = entries
    .filter(e => e.isDirectory())
    .filter(e => fs.existsSync(path.join(OUTPUT_DIR, e.name, 'index.m3u8')))
    .map(e => {
      const dir = path.join(OUTPUT_DIR, e.name);
      const chunks = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
      const hasThumbnail = fs.existsSync(path.join(dir, 'thumbnail.jpg'));
      return {
        name: e.name,
        title: e.name.replace(/_/g, ' '),
        playlist: `/stream/${e.name}/index.m3u8`,
        thumbnail: hasThumbnail ? `/stream/${e.name}/thumbnail.jpg` : null,
        chunks: chunks.length,
      };
    });

  LOG.info(`Library: ${videos.length} video(s) found — [${videos.map(v => v.name).join(', ')}]`);
  res.json({ videos });
});

// ─── API: Server Info ───────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json({
    ip: LOCAL_IP,
    port: PORT,
    playerUrl: `http://${LOCAL_IP}:${PORT}`,
  });
});

app.get('/api/status', (req, res) => {
  LOG.info(`Status check — ${peers.size} active peer(s)`);
  res.json({
    status: 'running',
    server: { ip: LOCAL_IP, port: PORT },
    peers: peers.size,
  });
});

// ─── API: Peer Registry (P2P) ───────────────────────────
app.post('/api/peers/register', (req, res) => {
  const { peerId, videoName, username, webrtcId } = req.body;
  if (!peerId || !videoName) return res.status(400).json({ error: 'peerId and videoName required' });

  const ip = req.ip || req.connection?.remoteAddress || '?';
  peers.set(peerId, {
    videoName,
    username: username || 'Anonymous',
    chunks: [],
    lastSeen: Date.now(),
    webrtcId: webrtcId || null,
    ip,
  });

  LOG.peer('JOIN', peerId, `video="${videoName}" ip=${ip} total=${peers.size}`);
  res.json({ ok: true, peerId, totalPeers: peers.size });
});

app.post('/api/peers/update-cache', (req, res) => {
  const { peerId, chunks } = req.body;
  if (!peerId) return res.status(400).json({ error: 'peerId required' });

  const peer = peers.get(peerId);
  if (!peer) {
    LOG.warn(`Cache update from unknown peer: ${peerId}`);
    return res.status(404).json({ error: 'peer not registered' });
  }

  peer.chunks = chunks || [];
  peer.lastSeen = Date.now();

  LOG.cache(peerId, peer.chunks);
  res.json({ ok: true });
});

app.get('/api/peers/:videoName', (req, res) => {
  const videoName = req.params.videoName;
  const result = [];

  for (const [id, peer] of peers) {
    if (peer.videoName === videoName) {
      result.push({ peerId: id, username: peer.username, chunks: peer.chunks });
    }
  }

  LOG.info(`Peer list for "${videoName}": ${result.length} peer(s)`);
  res.json({ videoName, peers: result });
});

app.post('/api/peers/unregister', (req, res) => {
  const { peerId } = req.body;
  const peer = peers.get(peerId);
  if (peer) {
    LOG.peer('LEAVE', peerId, `video="${peer.videoName}" was watching for ${((Date.now() - peer.lastSeen) / 1000).toFixed(0)}s`);
  }
  peers.delete(peerId);
  res.json({ ok: true });
});

// ─── API: Peer Lookup for P2P chunk fetch ───────────────
const PEER_LIST_K = 5;
const PEER_FRESH_MS = 10000;

app.post('/api/peers/list', (req, res) => {
  const { videoId, chunkId, requesterId } = req.body;
  if (videoId === undefined || chunkId === undefined) {
    return res.status(400).json({ error: 'videoId and chunkId required' });
  }

  const now = Date.now();
  const candidates = [];

  for (const [id, peer] of peers) {
    if (id === requesterId) continue;
    if (peer.videoName !== videoId) continue;
    if (now - peer.lastSeen > PEER_FRESH_MS) continue;
    if (!peer.chunks.includes(chunkId)) continue;
    if (!peer.webrtcId) continue;

    candidates.push({
      peerId: id,
      username: peer.username,
      webrtcId: peer.webrtcId,
      ip: peer.ip,
      lastSeen: peer.lastSeen,
      chunks: peer.chunks,
    });
  }

  candidates.sort((a, b) => b.lastSeen - a.lastSeen);
  const result = candidates.slice(0, PEER_LIST_K);

  LOG.info(`P2P lookup: chunk ${chunkId} of "${videoId}" → ${result.length} peer(s) have it`);
  res.json({ peers: result });
});

// ─── Create HTTP server (needed for WebSocket) ──────────
const server = http.createServer(app);

// ─── WebSocket Signaling Server ─────────────────────────
let wss;
try {
  const { WebSocketServer } = require('ws');
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    let myWebrtcId = null;
    const ip = req.socket.remoteAddress || '?';
    LOG.ws('CONNECT', ip);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'join': {
          myWebrtcId = msg.webrtcId;
          if (myWebrtcId) {
            signalingClients.set(myWebrtcId, ws);
            LOG.ws('JOIN', myWebrtcId, `from ${ip}`);
          }
          break;
        }
        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          const target = signalingClients.get(msg.target);
          if (target && target.readyState === 1) {
            target.send(JSON.stringify({
              type: msg.type,
              from: myWebrtcId,
              payload: msg.payload,
            }));
            LOG.ws('RELAY', `${msg.type}`, `${myWebrtcId} → ${msg.target}`);
          } else {
            LOG.ws('MISS', `${msg.type}`, `target ${msg.target} not found`);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (myWebrtcId) {
        signalingClients.delete(myWebrtcId);
        LOG.ws('LEAVE', myWebrtcId);
      }
    });

    ws.on('error', (err) => {
      if (myWebrtcId) signalingClients.delete(myWebrtcId);
      LOG.warn(`WS error from ${myWebrtcId || ip}: ${err.message}`);
    });
  });

  LOG.info('WebSocket signaling server enabled');
} catch (e) {
  LOG.warn('ws module not found — WebSocket signaling disabled');
}

// ─── Start ──────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎬 HLS Streaming Server (LAN + P2P)`);
  console.log(`─────────────────────────────────────`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   LAN:     http://${LOCAL_IP}:${PORT}`);
  if (wss) console.log(`   WS:      ws://${LOCAL_IP}:${PORT}`);
  console.log(`─────────────────────────────────────`);
  console.log(`\n📱 Share: http://${LOCAL_IP}:${PORT}`);
  console.log(`🔥 Firewall: sudo ufw allow ${PORT}/tcp`);
  console.log(`\n📋 Logs: watching for requests...\n`);
});
