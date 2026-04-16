// ═══════════════════════════════════════════════
//  CHUNK CACHE — compatibility shim
//
//  Wraps CacheManager/ChunkScorer/EvictionPolicy
//  with the legacy API used by player.js and p2p.js.
//
//  Actual storage: CacheManager
//  Eviction:       EvictionPolicy
//  Scoring:        ChunkScorer
// ═══════════════════════════════════════════════
class ChunkCache {
  constructor(budgetMB = CACHE_BUDGET_MB) {
    this._mgr      = new CacheManager(budgetMB);
    this._scorer   = new ChunkScorer();
    this._evictor  = new EvictionPolicy();
    this.currentSegment = -1;
    this.totalSegments  = 0;
  }

  // ─── Expose internals needed by player.js ──────
  get cache()         { return this._mgr.store; }          // Map for .size access
  get evictedSet()    { return this._mgr.evictedSet; }
  get evictionCount() { return this._mgr.evictionCount; }

  // ─── scorer / manager accessors for new code ──
  get manager()  { return this._mgr;     }
  get scorer()   { return this._scorer;  }
  get evictor()  { return this._evictor; }

  // ─── Legacy write API ──────────────────────────
  store(segIdx, data, source = 'server') {
    if (!data || !(data instanceof ArrayBuffer) || data.byteLength === 0) return false;

    const zone = this.currentSegment >= 0
      ? this._scorer.getZone(segIdx, this.currentSegment)
      : 'safety';

    // Make room if necessary
    if (!this._mgr.hasRoom(data.byteLength)) {
      this._evictor.makeRoom(this._mgr, this._scorer, this.currentSegment, data.byteLength);
    }

    return this._mgr.put(segIdx, data, source, zone);
  }

  // ─── Legacy read API ───────────────────────────
  has(segIdx)      { return this._mgr.has(segIdx); }
  getData(segIdx)  { return this._mgr.get(segIdx); }
  get(segIdx)      { return this._mgr.get(segIdx); }
  isP2P(segIdx)    { return this._mgr.isP2P(segIdx); }

  // ─── Playhead advance ──────────────────────────
  setCurrentSegment(segIdx) {
    if (segIdx === this.currentSegment) return;
    this.currentSegment = segIdx;
    this._evictor.rebalance(this._mgr, this._scorer, segIdx);
  }

  // ─── Inventory ─────────────────────────────────
  getInventory() { return this._mgr.getInventory(); }

  getInventoryWithSizes() { return this._mgr.getInventoryWithSizes(); }

  // ─── Window info (for visualizer) ──────────────
  getWindow() {
    const cur = Math.max(0, this.currentSegment);
    return {
      lo: Math.max(0, cur - Math.floor(SAFETY_PAST_SEC   / CHUNK_DURATION)),
      hi: Math.min(this.totalSegments - 1, cur + Math.floor(SAFETY_FUTURE_SEC / CHUNK_DURATION)),
      current: cur,
    };
  }

  // ─── Stats ─────────────────────────────────────
  stats() { return this._mgr.stats(); }
}
