// ═══════════════════════════════════════════════
//  UTILS — DOM refs, log(), setStatus(), globals
// ═══════════════════════════════════════════════

// DOM elements
const libraryView    = document.getElementById('libraryView');
const playerView     = document.getElementById('playerView');
const videoGrid      = document.getElementById('videoGrid');
const backBtn        = document.getElementById('backBtn');
const headerSubtitle = document.getElementById('headerSubtitle');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const video          = document.getElementById('videoPlayer');
const overlay        = document.getElementById('overlay');
const overlayText    = document.getElementById('overlayText');
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const lanIPEl        = document.getElementById('lanIP');
const lanURLEl       = document.getElementById('lanURL');
const copyToast      = document.getElementById('copyToast');
const logBody        = document.getElementById('logBody');

const statResolution = document.getElementById('statResolution');
const statSpeed      = document.getElementById('statSpeed');
const statBuffer     = document.getElementById('statBuffer');
const statSegments   = document.getElementById('statSegments');
const statCached     = document.getElementById('statCached');
const statEvicted    = document.getElementById('statEvicted');
const cacheVis       = document.getElementById('cacheVis');
const cacheParams    = document.getElementById('cacheParams');

// Mutable global state
let hls = null;
let chunkCache = null;
let peerManager = null;
let signaling = null;
let currentVideoName = null;
let segmentCount = 0;
let statsInterval = null;
let inventoryInterval = null;

// ─── Chunk Integrity (SHA-256 hash registry) ────
//  Populated per-video from /stream/<name>/hashes.json
let chunkHashes = null;

/**
 * Compute SHA-256 hex digest of an ArrayBuffer.
 * Pure-JS implementation (RFC 6234) — works in any browser context.
 * @param {ArrayBuffer} buffer
 * @returns {string} lowercase hex hash
 */
function computeSHA256(buffer) {
  return _sha256Fallback(new Uint8Array(buffer));
}


/**
 * Pure-JavaScript SHA-256 (RFC 6234).
 * No dependencies — works in any browser context.
 */
function _sha256Fallback(data) {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);

  function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
  function ch(x, y, z)  { return (x & y) ^ (~x & z); }
  function maj(x, y, z) { return (x & y) ^ (x & z) ^ (y & z); }
  function sigma0(x) { return rotr(2, x) ^ rotr(13, x) ^ rotr(22, x); }
  function sigma1(x) { return rotr(6, x) ^ rotr(11, x) ^ rotr(25, x); }
  function gamma0(x) { return rotr(7, x) ^ rotr(18, x) ^ (x >>> 3); }
  function gamma1(x) { return rotr(17, x) ^ rotr(19, x) ^ (x >>> 10); }

  // Pre-processing: padding
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  // pad to 64-byte blocks: msg + 0x80 + zeros + 8-byte big-endian length
  const padLen = 64 - ((msgLen + 9) % 64);
  const totalLen = msgLen + 1 + (padLen === 64 ? 0 : padLen) + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(data);
  padded[msgLen] = 0x80;
  // Write 64-bit big-endian bit length (only lower 32 bits needed for < 512MB)
  const dv = new DataView(padded.buffer);
  dv.setUint32(totalLen - 4, bitLen, false);
  if (bitLen > 0xFFFFFFFF) dv.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);

  // Initialize hash values
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const W = new Uint32Array(64);
  const view = new DataView(padded.buffer);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) W[i] = (gamma1(W[i-2]) + W[i-7] + gamma0(W[i-15]) + W[i-16]) | 0;

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + sigma1(e) + ch(e, f, g) + K[i] + W[i]) | 0;
      const t2 = (sigma0(a) + maj(a, b, c)) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  // Convert to hex
  function toHex(n) { return (n >>> 0).toString(16).padStart(8, '0'); }
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

// Real-time Network bandwidth tracker
const downloadHistory = [];
function trackNetworkBytes(byteLength) {
  downloadHistory.push({ ts: Date.now(), bytes: byteLength });
}

// Logger
function log(msg) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span>${msg}`;
  logBody.appendChild(entry);
  logBody.scrollTop = logBody.scrollHeight;
  // Keep max 200 entries
  while (logBody.children.length > 200) logBody.removeChild(logBody.firstChild);

  // Send to server
  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: typeof USERNAME !== 'undefined' ? USERNAME : '',
      peerId: typeof PEER_ID !== 'undefined' ? PEER_ID : '',
      msg: msg,
      time: time
    })
  }).catch(() => {});
}

// Status updater
function setStatus(state, text) {
  statusDot.className = 'status-dot' + (state === 'live' ? ' live' : state === 'error' ? ' error' : '');
  statusText.textContent = text;
}
