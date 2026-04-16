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
