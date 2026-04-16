// ═══════════════════════════════════════════════
//  CACHE MANAGER
//
//  Single source of truth for binary chunk storage.
//  Tracks memory in bytes, enforces the 200 MB budget.
//  Zones: 'urgent' | 'safety' | 'future' | 'far-past'
// ═══════════════════════════════════════════════
class CacheManager {
  constructor(budgetMB) {
    this.budgetBytes  = budgetMB * 1024 * 1024;
    this.store        = new Map(); // segIdx → entry
    this.totalBytes   = 0;
    this.evictionCount = 0;
    this.p2pSet       = new Set();
    this.evictedSet   = new Set(); // for visualizer (never cleared)
  }

  // ─── Write ─────────────────────────────────────
  /**
   * Store a chunk. Caller must ensure this.hasRoom(sizeBytes) or call
   * evictionPolicy.makeRoom() first.
   * @returns {boolean} true if stored
   */
  put(segIdx, data, source = 'server', zone = 'safety') {
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) {
      log(`⚠️ CacheManager.put seg${segIdx}: invalid data (${data?.byteLength ?? 'null'} bytes)`);
      return false;
    }

    const sizeBytes = data.byteLength;

    // If already exists, subtract old size before overwriting
    if (this.store.has(segIdx)) {
      this.totalBytes -= this.store.get(segIdx).sizeBytes;
    }

    // Reject if over budget
    if (this.totalBytes + sizeBytes > this.budgetBytes) {
      log(`⚠️ CacheManager.put seg${segIdx}: over budget (${this.totalMB().toFixed(1)}/${(this.budgetBytes/(1024*1024)).toFixed(0)} MB) — rejected`);
      return false;
    }

    this.store.set(segIdx, { data, sizeBytes, source, zone, ts: Date.now() });
    this.totalBytes += sizeBytes;
    this.evictedSet.delete(segIdx);
    if (source === 'p2p') this.p2pSet.add(segIdx);

    log(`🗃️ Cache STORE seg${segIdx} [${zone}] — ${(sizeBytes/1024).toFixed(0)} KB via ${source} — total ${this.totalMB().toFixed(1)} MB`);
    return true;
  }

  /**
   * Store a high-demand future chunk that is allowed to exceed the normal budget
   * by up to OVER_BUDGET_CAP_MB. Used only for future chunks with demand > threshold.
   * @returns {'stored'|'over-hard-cap'|'invalid'} result code
   */
  putOverBudget(segIdx, data, source = 'server') {
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return 'invalid';

    const sizeBytes   = data.byteLength;
    const hardCapBytes = this.budgetBytes + (OVER_BUDGET_CAP_MB * 1024 * 1024);

    // If already exists, subtract old size
    if (this.store.has(segIdx)) {
      this.totalBytes -= this.store.get(segIdx).sizeBytes;
    }

    if (this.totalBytes + sizeBytes > hardCapBytes) {
      log(`🚫 CacheManager.putOverBudget seg${segIdx}: exceeds hard cap (${this.totalMB().toFixed(1)} MB + ${(sizeBytes/1024).toFixed(0)} KB > ${(hardCapBytes/(1024*1024)).toFixed(0)} MB)`);
      return 'over-hard-cap';
    }

    this.store.set(segIdx, { data, sizeBytes, source, zone: 'future', ts: Date.now(), overBudget: true });
    this.totalBytes += sizeBytes;
    this.evictedSet.delete(segIdx);
    if (source === 'p2p') this.p2pSet.add(segIdx);

    log(`🔥 Cache OVER-BUDGET seg${segIdx} [future/high-demand] — ${(sizeBytes/1024).toFixed(0)} KB via ${source} — total ${this.totalMB().toFixed(1)} MB (budget+${OVER_BUDGET_CAP_MB}MB cap)`);
    return 'stored';
  }



  // ─── Read ──────────────────────────────────────
  get(segIdx) {
    const e = this.store.get(segIdx);
    return e ? e.data : null;
  }

  has(segIdx) { return this.store.has(segIdx); }

  hasRoom(sizeBytes) {
    return (this.totalBytes + sizeBytes) <= this.budgetBytes;
  }

  entry(segIdx) { return this.store.get(segIdx) || null; }

  // ─── Remove ────────────────────────────────────
  remove(segIdx) {
    const e = this.store.get(segIdx);
    if (!e) return false;
    this.totalBytes -= e.sizeBytes;
    this.store.delete(segIdx);
    this.evictedSet.add(segIdx);
    this.evictionCount++;
    return true;
  }

  // ─── Zone update ───────────────────────────────
  updateZone(segIdx, zone) {
    const e = this.store.get(segIdx);
    if (e) e.zone = zone;
  }

  // ─── Queries ───────────────────────────────────
  totalMB()  { return this.totalBytes   / (1024 * 1024); }
  budgetMB() { return this.budgetBytes  / (1024 * 1024); }

  pastMB() {
    let bytes = 0;
    for (const [, e] of this.store) {
      if (e.zone === 'far-past') bytes += e.sizeBytes;
    }
    return bytes / (1024 * 1024);
  }

  getInventory() {
    return Array.from(this.store.keys()).sort((a, b) => a - b);
  }

  // Returns { chunkIdx: sizeBytes } for inventory heartbeat
  getInventoryWithSizes() {
    const out = {};
    for (const [idx, e] of this.store) {
      out[idx] = e.sizeBytes;
    }
    return out;
  }

  getAll() { return this.store.entries(); }

  isP2P(segIdx) { return this.p2pSet.has(segIdx); }

  // ─── Stats ─────────────────────────────────────
  stats() {
    let byZone = { urgent: 0, safety: 0, future: 0, 'far-past': 0 };
    for (const [, e] of this.store) byZone[e.zone] = (byZone[e.zone] || 0) + 1;
    return {
      totalMB: this.totalMB().toFixed(1),
      budgetMB: this.budgetMB().toFixed(0),
      chunks: this.store.size,
      evictions: this.evictionCount,
      byZone,
    };
  }
}
