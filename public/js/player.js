// ═══════════════════════════════════════════════
//  PLAYER — openPlayer, closePlayer, startHls,
//           renderCacheVis, Scheduler integration
// ═══════════════════════════════════════════════

// ─── Server Info ────────────────────────────────
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    lanIPEl.textContent  = info.ip;
    lanURLEl.textContent = info.playerUrl;
  } catch {
    lanIPEl.textContent  = location.hostname;
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

// ─── Scheduler global ───────────────────────────
let scheduler = null;
let inventoryInterval = null;

// ─── Player Open/Close ──────────────────────────
function openPlayer(name, playlist, title) {
  currentVideoName = name;
  libraryView.style.display  = 'none';
  playerView.style.display   = 'block';
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

  // Build new cache stack
  chunkCache = new ChunkCache(CACHE_BUDGET_MB);
  cacheParams.textContent = `±${SAFETY_PAST_SEC}s/${SAFETY_FUTURE_SEC}s safety | ${CACHE_BUDGET_MB} MB budget`;

  if (peerManager) peerManager.cache = chunkCache;

  // ─── Scheduler setup ────────────────────────
  if (scheduler) scheduler.stop();
  scheduler = new Scheduler(chunkCache.manager, chunkCache.scorer, chunkCache.evictor);
  scheduler.start(async (segIdx, priority, zone) => {
    await _schedulerFetch(segIdx, priority, zone, name);
  });

  fetch('/api/peers/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: PEER_ID, videoName: name, username: USERNAME, webrtcId: WEBRTC_ID }),
  }).catch(() => {});

  startHls(playlist);
}

function closePlayer() {
  if (hls)       { hls.destroy(); hls = null; }
  if (scheduler) { scheduler.stop(); scheduler = null; }
  video.src = '';
  if (statsInterval)    clearInterval(statsInterval);
  if (inventoryInterval) clearInterval(inventoryInterval);
  inventoryInterval = null;

  fetch('/api/peers/unregister', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: PEER_ID }),
  }).catch(() => {});

  playerView.style.display  = 'none';
  libraryView.style.display = 'block';
  headerSubtitle.textContent = 'Library';
  currentVideoName = null;
  chunkCache = null;
}

backBtn.addEventListener('click', closePlayer);

// ─── Scheduler-driven proactive fetch ───────────
//
//  Strategy per zone:
//    urgent    → server only (deadline critical)
//    safety    → P2P first → server fallback
//    future    → P2P race vs server in parallel (first wins)
//    far-past  → P2P first → server fallback (demand-gated by scheduler)
// ────────────────────────────────────────────────
async function _schedulerFetch(segIdx, priority, zone, videoName) {
  if (!chunkCache || chunkCache.has(segIdx)) {
    if (scheduler) scheduler.markComplete(segIdx);
    return;
  }

  try {
    // ── 1. URGENT: always server, zero P2P delay ──────────────────────────
    if (zone === 'urgent') {
      const data = await _httpFetch(segIdx, videoName);
      if (data && chunkCache) {
        chunkCache.store(segIdx, data.slice(0), 'server');
        log(`📥 Scheduler seg${segIdx} [urgent] ← server`);
      }
      return;
    }

    // ── 2. SAFETY: P2P preferred, server fallback ─────────────────────────
    if (zone === 'safety' || zone === 'safety-past') {
      const result = await fetchChunkP2P(segIdx, videoName);
      if (result && result.data instanceof ArrayBuffer && result.data.byteLength > 0) {
        _storeSchedulerResult(segIdx, result.data, result.source, result.peerName, zone, priority);
      } else {
        log(`📡 seg${segIdx} [${zone}]: P2P miss → server`);
        const data = await _httpFetch(segIdx, videoName);
        if (data && chunkCache) {
          _storeSchedulerResult(segIdx, data, 'server', null, zone, priority);
        }
      }
      return;
    }

    // ── 3. FUTURE [t+30s, ∞]: P2P first → server fallback ────────────────
    if (zone === 'future') {
      const result = await fetchChunkP2P(segIdx, videoName);
      if (result && result.data instanceof ArrayBuffer && result.data.byteLength > 0) {
        _storeSchedulerResult(segIdx, result.data, result.source, result.peerName, zone, priority);
      } else {
        log(`📡 seg${segIdx} [future/${priority}]: P2P miss → server`);
        const data = await _httpFetch(segIdx, videoName);
        if (data && chunkCache) {
          _storeSchedulerResult(segIdx, data, 'server', null, zone, priority);
        }
      }
      return;
    }

    // ── 4. FAR-PAST [< t−20s]: P2P first → server fallback ───────────────
    if (zone === 'far-past') {
      const result = await fetchChunkP2P(segIdx, videoName);
      if (result && result.data instanceof ArrayBuffer && result.data.byteLength > 0) {
        _storeSchedulerResult(segIdx, result.data, result.source, result.peerName, zone, priority);
      } else {
        log(`📡 seg${segIdx} [far-past]: P2P miss → server`);
        const data = await _httpFetch(segIdx, videoName);
        if (data && chunkCache) {
          _storeSchedulerResult(segIdx, data, 'server', null, zone, priority);
        }
      }
      return;
    }

  } catch (err) {
    log(`⚠ Scheduler fetch error seg${segIdx} [${zone}]: ${err.message}`);
  } finally {
    if (scheduler) scheduler.markComplete(segIdx);
    renderCacheVis();
  }
}

/** Store a scheduler-fetched chunk and update stats */
function _storeSchedulerResult(segIdx, data, source, peerName, zone, priority) {
  if (!chunkCache || !data) return;

  let stored = chunkCache.store(segIdx, data.slice(0), source === 'p2p' ? 'p2p' : 'server');

  // ── High-rarity future override: allow exceeding budget ───────────────
  if (!stored) {
    const rarity = chunkCache.scorer ? chunkCache.scorer.rarity(segIdx) : 0;
    if (rarity >= RARITY_OVERRIDE_THRESHOLD) {
      log(`🔥 seg${segIdx} [${zone}]: over budget but rarity=${rarity.toFixed(2)} ≥ ${RARITY_OVERRIDE_THRESHOLD} → override storage`);
      const result = chunkCache.manager.putOverBudget(
        segIdx,
        data.slice(0),
        source === 'p2p' ? 'p2p' : 'server'
      );
      stored = (result === 'stored');
    }
  }

  if (!stored) return;

  if (source === 'p2p') {
    p2pStats.peerHits++;
    p2pStats.lastSource = peerName ? `P2P: ${peerName}` : 'P2P';
  } else {
    p2pStats.serverHits++;
    p2pStats.lastSource = 'Server (HTTP)';
  }
  updateP2PStats();
  log(`📥 Scheduler seg${segIdx} [${zone}/${priority}] ← ${source}`);
}




/** Plain HTTP fetch returning ArrayBuffer */
async function _httpFetch(segIdx, videoName) {
  try {
    const url = `/stream/${videoName}/seg${String(segIdx).padStart(3, '0')}.ts`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

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

  // Max buffer = safety future window (HLS.js soft cap)
  const maxBufSec = SAFETY_FUTURE_SEC;
  log(`HLS.js init — maxBuffer: ${maxBufSec}s | Scheduler controlling proactive fetch`);

  // ─ Custom P2PLoader ────────────────────────────
  class P2PLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
      super(config);
      this._isSegment = false;
      this._segIndex  = null;
    }

    load(context, config, callbacks) {
      const url = context.url || '';
      const isTsSegment = url.endsWith('.ts');
      this._isSegment   = isTsSegment;

      if (isTsSegment && context.frag && typeof context.frag.sn === 'number') {
        this._segIndex = context.frag.sn;
        const segIdx   = this._segIndex;

        // If scheduler already cached this chunk, serve from cache immediately
        if (chunkCache && chunkCache.has(segIdx)) {
          const data = chunkCache.getData(segIdx);
          if (data instanceof ArrayBuffer && data.byteLength > 0) {
            const src = chunkCache.isP2P(segIdx) ? '🌐 P2P (cached)' : '📡 HTTP (cached)';
            log(`⚡ seg${segIdx}: served from pre-cache (${src})`);
            p2pStats.lastSource = chunkCache.isP2P(segIdx) ? 'P2P (pre-cached)' : 'Server (pre-cached)';
            updateP2PStats();

            const now  = performance.now();
            const copy = data.slice(0); // copy for HLS internal worker transfer
            callbacks.onSuccess(
              { url: context.url, data: copy },
              { trequest: now, tfirst: now, tload: now, loaded: copy.byteLength, total: copy.byteLength },
              context,
              null,
            );
            return;
          }
        }

        // Not cached yet → try P2P then HTTP
        fetchChunkP2P(segIdx, currentVideoName).then((result) => {
          if (result && result.data && result.data instanceof ArrayBuffer && result.data.byteLength > 0) {
            p2pStats.peerHits++;
            p2pStats.lastSource = result.peerName ? `P2P: ${result.peerName}` : 'P2P';
            updateP2PStats();

            if (chunkCache) chunkCache.store(segIdx, result.data.slice(0), 'p2p');
            if (scheduler)  scheduler.markComplete(segIdx);

            const now  = performance.now();
            const copy = result.data.slice(0);
            callbacks.onSuccess(
              { url: context.url, data: copy },
              { trequest: now, tfirst: now, tload: now, loaded: copy.byteLength, total: copy.byteLength },
              context,
              null,
            );
          } else {
            // HTTP fallback
            p2pStats.serverHits++;
            p2pStats.lastSource = 'Server (HTTP)';
            if (result === null) p2pStats.peerFailures++;
            updateP2PStats();
            log(`📡 seg${segIdx}: P2P miss → HTTP fallback`);

            const wrappedCallbacks = {
              onSuccess: (response, stats, ctx, net) => {
                if (chunkCache && response.data instanceof ArrayBuffer) {
                  chunkCache.store(segIdx, response.data.slice(0), 'server');
                }
                if (scheduler) scheduler.markComplete(segIdx);
                callbacks.onSuccess(response, stats, ctx, net);
              },
              onError:    callbacks.onError,
              onTimeout:  callbacks.onTimeout,
              onAbort:    callbacks.onAbort,
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
              if (chunkCache && response.data instanceof ArrayBuffer) {
                chunkCache.store(segIdx, response.data.slice(0), 'server');
              }
              if (scheduler) scheduler.markComplete(segIdx);
              callbacks.onSuccess(response, stats, ctx, net);
            },
            onError:    callbacks.onError,
            onTimeout:  callbacks.onTimeout,
            onAbort:    callbacks.onAbort,
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

    if (scheduler) scheduler.updateSegment(0, totalSegs);
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
      statSegments.textContent = segmentCount;

      const src = chunkCache.isP2P(sn) ? '🌐 P2P' : '📡 HTTP';
      log(`📥 seg${sn} loaded (${src}) — cache: ${chunkCache.manager.totalMB().toFixed(1)} MB / ${CACHE_BUDGET_MB} MB`);
      renderCacheVis();

      const level = hls.levels[hls.currentLevel];
      let bitrateKbps = 0;
      
      if (level && level.bitrate > 0) {
        bitrateKbps = level.bitrate / 1000;
      } else {
        const bytes = data.frag.stats?.total || data.frag.stats?.loaded || 0;
        const durationSec = data.frag.duration || 1;
        bitrateKbps = (bytes * 8) / durationSec / 1000;
      }
      
      statBitrate.textContent = `${bitrateKbps.toFixed(0)} kbps`;
    }
  });

  hls.on(Hls.Events.FRAG_CHANGED, (_, data) => {
    const sn = data.frag.sn;
    if (typeof sn === 'number') {
      chunkCache.setCurrentSegment(sn);
      const totalSegs = hls.levels[0]?.details?.fragments?.length || chunkCache.totalSegments;
      if (scheduler) scheduler.updateSegment(sn, totalSegs);

      const win = chunkCache.getWindow();
      log(`▶ Playing seg${sn} — window: [${win.lo}…${win.hi}], cache: ${chunkCache.manager.totalMB().toFixed(1)} MB`);
      renderCacheVis();
    }
  });

  hls.on(Hls.Events.ERROR, (_, data) => {
    log(`⚠ ${data.type}: ${data.details}`);
    if (data.fatal) {
      setStatus('error', 'Error');
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR)  hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    }
  });

  // ─── Stats interval ─────────────────────────────
  statsInterval = setInterval(() => {
    if (video.videoWidth) statResolution.textContent = `${video.videoWidth}×${video.videoHeight}`;
    if (video.buffered.length > 0) {
      const buf = video.buffered.end(video.buffered.length - 1) - video.currentTime;
      statBuffer.textContent = `${buf.toFixed(1)}s`;
    }
    if (chunkCache) {
      statCached.textContent  = chunkCache.cache.size;
      statEvicted.textContent = chunkCache.evictionCount;
    }
    updateP2PStats();
  }, 1000);

  // ─── Inventory heartbeat (now includes sizes) ────
  const sendInventorySync = () => {
    if (chunkCache && currentVideoName) {
      fetch('/api/peers/update-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId: PEER_ID,
          chunks: chunkCache.getInventory(),
          chunkSizes: chunkCache.getInventoryWithSizes(),
        }),
      }).catch(() => {});
    }
  };

  inventoryInterval = setInterval(sendInventorySync, INVENTORY_INTERVAL);
  sendInventorySync(); // sync immediately on start


  // P2P lookups and inventory are handled via P2P.js and Signaling.
}

// ─── Cache Visualizer ───────────────────────────
function renderCacheVis() {
  if (!chunkCache || chunkCache.totalSegments === 0) return;

  const total   = chunkCache.totalSegments;
  const win     = chunkCache.getWindow();
  const mgr     = chunkCache.manager;
  const scorer  = chunkCache.scorer;
  const cur     = win.current;
  let html = '';

  for (let i = 0; i < total; i++) {
    const zone   = scorer ? scorer.getZone(i, cur) : 'safety';
    const isP2P  = mgr.isP2P(i);
    const stored = mgr.has(i);
    const entry  = mgr.entry(i);

    let cls;
    if (i === cur) {
      cls = 'playing';
    } else if (stored && isP2P) {
      cls = 'p2p';
    } else if (stored) {
      // Differentiate cached colour by zone
      if      (zone === 'urgent')   cls = 'urgent-cached';
      else if (zone === 'far-past') cls = 'past-cached';
      else if (zone === 'future')   cls = 'future-cached';
      else                          cls = 'cached';          // safety zone
    } else if (mgr.evictedSet.has(i)) {
      cls = 'evicted';
    } else if (zone === 'urgent') {
      cls = 'urgent-empty';
    } else {
      cls = 'empty';
    }

    const sizeMB  = entry ? (entry.sizeBytes / (1024 * 1024)).toFixed(1) : '—';
    const scoreV  = scorer && entry
      ? scorer.score(i, cur, entry.sizeBytes / (1024 * 1024)).toFixed(3)
      : '—';
    const tip = `seg${String(i).padStart(3,'0')}.ts | zone: ${zone} | ${sizeMB} MB | score: ${scoreV}`;

    html += `<div class="chunk-block ${cls}" title="${tip}">${i}</div>`;
  }

  cacheVis.innerHTML = html;

  // ── Memory bar ───────────────────────────────────
  const memBar     = document.getElementById('cacheMemBar');
  const memBarPast = document.getElementById('cacheMemBarPast');
  const memLabel   = document.getElementById('cacheMemLabel');

  if (memBar && memBarPast && memLabel) {
    const totalMB  = mgr.totalMB();
    const pastMB   = mgr.pastMB();
    const budgetMB = mgr.budgetMB();
    const pct      = Math.min((totalMB / budgetMB) * 100, 100).toFixed(1);
    const pastPct  = Math.min((pastMB  / budgetMB) * 100, 100).toFixed(1);

    memBar.style.width     = `${pct}%`;
    memBarPast.style.width = `${pastPct}%`;
    memLabel.textContent   = `${totalMB.toFixed(1)} / ${budgetMB.toFixed(0)} MB`;

    // Warn red if over 85% full
    memBar.style.background = totalMB / budgetMB > 0.85
      ? 'linear-gradient(90deg,#ff4757,#ff6b81)'
      : 'linear-gradient(90deg,var(--accent),#a29bfe)';
  }
}

