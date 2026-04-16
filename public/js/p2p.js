// ═══════════════════════════════════════════════
//  P2P STATS & CHUNK FETCH LOGIC
//
//  Flow: local cache → ask server for peers →
//        try each peer via WebRTC → fallback HTTP
// ═══════════════════════════════════════════════
const p2pStats = { peerHits: 0, serverHits: 0, peerFailures: 0, lastSource: '—' };

function updateP2PStats() {
  const total = p2pStats.peerHits + p2pStats.serverHits;
  const pct   = total > 0 ? Math.round((p2pStats.peerHits / total) * 100) : 0;
  const statP2P    = document.getElementById('statP2P');
  const statSource = document.getElementById('statSource');
  if (statP2P)    statP2P.textContent    = pct + '%';
  if (statSource) statSource.textContent = p2pStats.lastSource;
}

async function fetchChunkP2P(segIndex, videoName) {
  // 1. Check local cache
  if (chunkCache && chunkCache.has(segIndex)) {
    return { data: chunkCache.getData(segIndex), source: 'cache' };
  }

  if (!peerManager || !signaling || !signaling.connected) return null;

  // 2. Ask server for peers that have this chunk
  try {
    log(`🔍 Peer request initiated for seg${segIndex}`);
    const res = await fetch('/api/peers/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: videoName, chunkId: segIndex, requesterId: PEER_ID }),
    });
    const { peers: peerList } = await res.json();

    // Feed peer count back into the scorer for future scoring decisions
    if (chunkCache && chunkCache.scorer) {
      chunkCache.scorer.updatePeerCount(segIndex, peerList.length);
    }

    if (peerList.length === 0) {
      log(`⚠️ Server returned 0 peers for seg${segIndex}`);
      return null;
    }

    log(`👥 Found ${peerList.length} peer(s) for seg${segIndex}`);

    // 3. Randomize and try peers
    // Shuffle the peer list so simultaneous parallel fetches don't slam the same top peer
    peerList.sort(() => Math.random() - 0.5);
    const candidates = peerList.slice(0, 3); // Max 3 connection attempts per chunk

    for (const peer of candidates) {
      try {
        const startTime = Date.now();
        await peerManager.getConnection(peer.webrtcId);

        const has = await peerManager.haveChunk(peer.webrtcId, segIndex);
        if (!has) {
          log(`⏭ ${peer.username} doesn't have seg${segIndex} (haveChunk=false)`);
          continue;
        }

        log(`📥 Requesting seg${segIndex} from ${peer.username}...`);
        const data = await peerManager.requestChunk(peer.webrtcId, segIndex);
        if (data) {
          const elapsed = Date.now() - startTime;
          trackNetworkBytes(data.byteLength);
          log(`✅ Peer response success: seg${segIndex} from ${peer.username} (${elapsed}ms, ${(data.byteLength/1024).toFixed(0)} KB)`);
          return { data, source: 'p2p', peerName: peer.username };
        } else {
          log(`❌ requestChunk returned null for seg${segIndex} (timeout or not found)`);
        }
      } catch (e) {
        log(`⚠ Peer ${peer.username} failed: ${e.message}`);
      }
    }

    log(`⏳ All peers failed for seg${segIndex} → fallback`);
  } catch (e) {
    log(`❌ Peer list request failed: ${e.message}`);
  }

  return null;
}
