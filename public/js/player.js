// ═══════════════════════════════════════════════
//  PLAYER — openPlayer, closePlayer, startHls,
//           renderCacheVis
// ═══════════════════════════════════════════════

// ─── Server Info ────────────────────────────────
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    lanIPEl.textContent = info.ip;
    lanURLEl.textContent = info.playerUrl;
  } catch {
    lanIPEl.textContent = location.hostname;
    lanURLEl.textContent = location.origin;
  }
}
fetchServerInfo();

lanURLEl.addEventListener('click', () => {
  navigator.clipboard.writeText(lanURLEl.textContent).then(() => {
    copyToast.classList.add('show');
    setTimeout(() => copyToast.classList.remove('show'), 1500);
  });
});

// ─── Library ────────────────────────────────────
async function loadLibrary() {
  try {
    const res = await fetch('/api/videos');
    const { videos } = await res.json();

    if (videos.length === 0) {
      videoGrid.innerHTML = `
        <div class="empty-library" style="grid-column:1/-1">
          <h2>No videos yet</h2>
          <p>Convert a video to start streaming:</p>
          <code>python3 hls_convertor.py video.mp4</code>
        </div>`;
      setStatus('', 'No videos');
      return;
    }

    videoGrid.innerHTML = videos.map(v => `
      <div class="video-card" data-name="${v.name}" data-playlist="${v.playlist}" data-title="${v.title}">
        ${v.thumbnail
          ? `<img class="card-thumb" src="${v.thumbnail}" alt="${v.title}" loading="lazy" />`
          : `<div class="card-thumb-placeholder">🎬</div>`
        }
        <div class="card-body">
          <div class="card-title">${v.title}</div>
          <div class="card-meta">${v.chunks} chunks</div>
        </div>
      </div>
    `).join('');

    videoGrid.querySelectorAll('.video-card').forEach(card => {
      card.addEventListener('click', () => {
        openPlayer(card.dataset.name, card.dataset.playlist, card.dataset.title);
      });
    });

    setStatus('live', `${videos.length} video(s)`);
  } catch (err) {
    videoGrid.innerHTML = `<div class="empty-library" style="grid-column:1/-1"><h2>Failed to load library</h2><p>${err.message}</p></div>`;
    setStatus('error', 'Error');
  }
}

// ─── Player Open/Close ──────────────────────────
function openPlayer(name, playlist, title) {
  currentVideoName = name;
  libraryView.style.display = 'none';
  playerView.style.display = 'block';
  headerSubtitle.textContent = 'Player';
  nowPlayingTitle.textContent = title;
  overlay.classList.remove('hidden');
  overlayText.textContent = 'Loading stream…';
  logBody.innerHTML = '';
  segmentCount = 0;
  p2pStats.peerHits = 0;
  p2pStats.serverHits = 0;
  p2pStats.peerFailures = 0;
  p2pStats.lastSource = '—';

  chunkCache = new ChunkCache(CACHE_T, CACHE_T_PRIME);
  cacheParams.textContent = `t=${CACHE_T} behind / t'=${CACHE_T_PRIME} ahead`;

  if (peerManager) peerManager.cache = chunkCache;

  fetch('/api/peers/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: PEER_ID, videoName: name, username: USERNAME, webrtcId: WEBRTC_ID }),
  }).catch(() => {});

  startHls(playlist);
}

function closePlayer() {
  if (hls) { hls.destroy(); hls = null; }
  video.src = '';
  if (statsInterval) clearInterval(statsInterval);
  if (inventoryInterval) clearInterval(inventoryInterval);

  fetch('/api/peers/unregister', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: PEER_ID }),
  }).catch(() => {});

  playerView.style.display = 'none';
  libraryView.style.display = 'block';
  headerSubtitle.textContent = 'Library';
  currentVideoName = null;
  chunkCache = null;
}

backBtn.addEventListener('click', closePlayer);

// ─── HLS Streaming (with P2P custom loader) ─────
function startHls(playlist) {
  if (!Hls.isSupported()) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlist;
      video.addEventListener('loadedmetadata', () => {
        overlay.classList.add('hidden');
        setStatus('live', 'Streaming');
        video.play();
      });
      return;
    }
    overlayText.textContent = 'HLS not supported';
    setStatus('error', 'Unsupported');
    return;
  }

  const maxBufSec = CACHE_T_PRIME * CHUNK_DURATION;
  log(`HLS.js init — maxBuffer: ${maxBufSec}s (${CACHE_T_PRIME} chunks × ${CHUNK_DURATION}s)`);

  // Custom fragment loader with P2P
  class P2PLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
      super(config);
      this._isSegment = false;
      this._segIndex = null;
    }

    load(context, config, callbacks) {
      const url = context.url || '';
      const isTsSegment = url.endsWith('.ts');
      this._isSegment = isTsSegment;

      if (isTsSegment && context.frag && typeof context.frag.sn === 'number') {
        this._segIndex = context.frag.sn;
        const segIdx = this._segIndex;

        fetchChunkP2P(segIdx, currentVideoName).then((result) => {
          if (result && result.data && result.data instanceof ArrayBuffer && result.data.byteLength > 0) {
            p2pStats.peerHits++;
            p2pStats.lastSource = result.peerName ? `P2P: ${result.peerName}` : 'P2P';
            updateP2PStats();

            if (chunkCache) chunkCache.store(segIdx, result.data.slice(0), 'p2p');

            const now = performance.now();
            const response = { url: context.url, data: result.data };
            const stats = {
              trequest: now,
              tfirst: now,
              tload: now,
              loaded: result.data.byteLength,
              total: result.data.byteLength,
            };
            callbacks.onSuccess(response, stats, context, null);
          } else {
            p2pStats.serverHits++;
            p2pStats.lastSource = 'Server (HTTP)';
            if (result === null) p2pStats.peerFailures++;
            updateP2PStats();
            log(`📡 seg${segIdx}: P2P miss → HTTP fallback`);

            const wrappedCallbacks = {
              onSuccess: (response, stats, ctx, net) => {
                if (chunkCache && response.data) {
                  chunkCache.store(segIdx, response.data.slice(0), 'server');
                }
                callbacks.onSuccess(response, stats, ctx, net);
              },
              onError: callbacks.onError,
              onTimeout: callbacks.onTimeout,
              onAbort: callbacks.onAbort,
              onProgress: callbacks.onProgress,
            };
            super.load(context, config, wrappedCallbacks);
          }
        }).catch((err) => {
          log(`⚠ P2P loader error: ${err.message} → HTTP fallback`);
          p2pStats.serverHits++;
          p2pStats.lastSource = 'Server (HTTP)';
          updateP2PStats();
          const wrappedCallbacks = {
            onSuccess: (response, stats, ctx, net) => {
              if (chunkCache && response.data) {
                chunkCache.store(segIdx, response.data.slice(0), 'server');
              }
              callbacks.onSuccess(response, stats, ctx, net);
            },
            onError: callbacks.onError,
            onTimeout: callbacks.onTimeout,
            onAbort: callbacks.onAbort,
            onProgress: callbacks.onProgress,
          };
          super.load(context, config, wrappedCallbacks);
        });
      } else {
        super.load(context, config, callbacks);
      }
    }
  }

  hls = new Hls({
    debug: false,
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: maxBufSec,
    maxMaxBufferLength: maxBufSec + CHUNK_DURATION,
    maxBufferSize: 60 * 1000 * 1000,
    maxBufferHole: 0.5,
    loader: P2PLoader,
  });

  hls.loadSource(playlist);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
    const totalSegs = hls.levels[0]?.details?.fragments?.length || 0;
    chunkCache.totalSegments = totalSegs;
    log(`Manifest: ${totalSegs} segments, ${data.levels.length} level(s)`);
    overlay.classList.add('hidden');
    setStatus('live', 'Streaming');
    video.play().catch(() => {});
    renderCacheVis();
  });

  hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
    const sn = data.frag.sn;
    if (typeof sn === 'number') {
      segmentCount++;
      if (!chunkCache.has(sn)) {
        chunkCache.store(sn, data.frag.data || null, 'server');
      }
      statSegments.textContent = segmentCount;

      const src = chunkCache.isP2P(sn) ? '🌐 P2P' : '📡 HTTP';
      log(`📥 seg${sn} loaded (${src}) → cached [${chunkCache.getInventory().join(',')}]`);
      renderCacheVis();

      const level = hls.levels[hls.currentLevel];
      if (level) {
        statBitrate.textContent = `${(level.bitrate / 1000).toFixed(0)} kbps`;
      }
    }
  });

  hls.on(Hls.Events.FRAG_CHANGED, (_, data) => {
    const sn = data.frag.sn;
    if (typeof sn === 'number') {
      chunkCache.setCurrentSegment(sn);
      const win = chunkCache.getWindow();
      log(`▶ Playing seg${sn} — window: [${win.lo}…${win.hi}], cached: [${chunkCache.getInventory().join(',')}]`);
      renderCacheVis();
    }
  });

  hls.on(Hls.Events.ERROR, (_, data) => {
    log(`⚠ ${data.type}: ${data.details}`);
    if (data.fatal) {
      setStatus('error', 'Error');
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    }
  });

  // Stats
  statsInterval = setInterval(() => {
    if (video.videoWidth) statResolution.textContent = `${video.videoWidth}×${video.videoHeight}`;
    if (video.buffered.length > 0) {
      const buf = video.buffered.end(video.buffered.length - 1) - video.currentTime;
      statBuffer.textContent = `${buf.toFixed(1)}s`;
    }
    if (chunkCache) {
      statCached.textContent = chunkCache.cache.size;
      statEvicted.textContent = chunkCache.evictionCount;
    }
    updateP2PStats();
  }, 1000);

  // Report inventory to server (P2P)
  inventoryInterval = setInterval(() => {
    if (chunkCache && currentVideoName) {
      fetch('/api/peers/update-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: PEER_ID, chunks: chunkCache.getInventory() }),
      }).catch(() => {});
    }
  }, INVENTORY_INTERVAL);
}

// ─── Cache Visualizer ───────────────────────────
function renderCacheVis() {
  if (!chunkCache || chunkCache.totalSegments === 0) return;

  const total = chunkCache.totalSegments;
  const win = chunkCache.getWindow();
  let html = '';

  for (let i = 0; i < total; i++) {
    let cls = 'empty';
    if (i === win.current) cls = 'playing';
    else if (chunkCache.has(i) && chunkCache.isP2P(i)) cls = 'p2p';
    else if (chunkCache.has(i)) cls = 'cached';
    else if (chunkCache.evictedSet.has(i)) cls = 'evicted';
    html += `<div class="chunk-block ${cls}" title="seg${String(i).padStart(3,'0')}.ts">${i}</div>`;
  }

  cacheVis.innerHTML = html;
}
