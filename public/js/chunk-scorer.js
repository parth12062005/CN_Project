// ═══════════════════════════════════════════════
//  CHUNK SCORER
//
//  Score = (rarity × demand × exp(−λ × distance)) / size_MB
//
//  Inputs:
//    rarity  = 1 / (1 + peers_having_chunk)
//    demand  = server-broadcast importance (0–1)
//    distance = |chunk_time − current_time| in seconds
//    size_MB = chunk size in megabytes
// ═══════════════════════════════════════════════
class ChunkScorer {
  constructor() {
    this.demandMap  = new Map(); // segIdx (int) → float 0-1
    this.rarityMap  = new Map(); // segIdx (int) → float 0-1  (server-supplied)
    this.peerCounts = new Map(); // segIdx (int) → int (local tracking)
    this.lambda     = LAMBDA;
  }

  // ─── Server demand broadcast ───────────────────
  /**
   * Called when /api/demand responds.
   * payload: { demand: {"12": 0.9, ...}, peerCounts: {"12": 2, ...} }
   */
  updateFromServer(payload) {
    if (payload.demand) {
      for (const [k, v] of Object.entries(payload.demand)) {
        this.demandMap.set(parseInt(k), parseFloat(v));
      }
    }
    if (payload.peerCounts) {
      for (const [k, v] of Object.entries(payload.peerCounts)) {
        this.peerCounts.set(parseInt(k), parseInt(v));
      }
    }
  }

  /** Update peer count for a specific chunk (from P2P lookup responses) */
  updatePeerCount(segIdx, count) {
    this.peerCounts.set(segIdx, count);
  }

  // ─── Score components ──────────────────────────
  rarity(segIdx) {
    // Use local peerCount if available, else assume 0 peers (max rarity)
    const count = this.peerCounts.get(segIdx) ?? 0;
    return 1 / (1 + count);
  }

  demand(segIdx) {
    // Default 0.5 mid-demand if server hasn't signalled
    return this.demandMap.get(segIdx) ?? 0.5;
  }

  distanceSec(segIdx, currentSeg) {
    return Math.abs(segIdx - currentSeg) * CHUNK_DURATION;
  }

  /**
   * Full scoring function.
   * sizeMB: actual chunk size or estimated (e.g. 1 MB) if unknown
   */
  score(segIdx, currentSeg, sizeMB = 1) {
    const dist = this.distanceSec(segIdx, currentSeg);
    const r    = this.rarity(segIdx);
    const d    = this.demand(segIdx);
    const sz   = Math.max(sizeMB, 0.01); // guard div-by-zero
    return (r * d * Math.exp(-this.lambda * dist)) / sz;
  }

  // ─── Zone classification ───────────────────────
  /**
   * Returns the zone name for a given segIdx relative to currentSeg.
   *
   *  far-past  …│ SAFETY_PAST │ urgent │ SAFETY_FUTURE │… future
   *             t-20s        t        t+10s           t+30s
   */
  getZone(segIdx, currentSeg) {
    const diffSec = (segIdx - currentSeg) * CHUNK_DURATION; // signed

    if (diffSec >= 0 && diffSec <= URGENT_SEC)         return 'urgent';
    if (diffSec > -SAFETY_PAST_SEC && diffSec <= SAFETY_FUTURE_SEC) return 'safety';
    if (diffSec > SAFETY_FUTURE_SEC)                   return 'future';
    return 'far-past'; // diffSec <= -SAFETY_PAST_SEC
  }

  isSafetyZone(segIdx, currentSeg) {
    const z = this.getZone(segIdx, currentSeg);
    return z === 'urgent' || z === 'safety';
  }
}
