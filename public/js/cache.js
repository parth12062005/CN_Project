// ═══════════════════════════════════════════════
//  CHUNK CACHE CLASS (extended with binary data)
//
//  Sliding window: [current - t, current + t']
//  Stores actual ArrayBuffer data so peers
//  can serve cached chunks via DataChannel.
// ═══════════════════════════════════════════════
class ChunkCache {
  constructor(t, tPrime) {
    this.t = t;
    this.tPrime = tPrime;
    this.cache = new Map();
    this.evictedSet = new Set();
    this.currentSegment = -1;
    this.totalSegments = 0;
    this.evictionCount = 0;
    this.p2pSet = new Set();
  }

  store(segIndex, data = null, source = 'server') {
    if (this.currentSegment >= 0) {
      const lo = this.currentSegment - this.t;
      if (segIndex < lo) {
        log(`🗃️ Cache REJECT seg${segIndex} — too old (before ${lo})`);
        return false;
      }
    }
    const dataSize = data ? (data.byteLength || data.length || '?') : 'null';
    log(`🗃️ Cache STORE seg${segIndex} — source=${source}, dataSize=${dataSize}, type=${data ? data.constructor?.name : 'null'}`);
    this.cache.set(segIndex, { data, timestamp: Date.now(), source });
    this.evictedSet.delete(segIndex);
    if (source === 'p2p') this.p2pSet.add(segIndex);
    return true;
  }

  has(segIndex) { return this.cache.has(segIndex); }

  getData(segIndex) {
    const entry = this.cache.get(segIndex);
    return entry ? entry.data : null;
  }

  get(segIndex) { return this.getData(segIndex); }

  isP2P(segIndex) { return this.p2pSet.has(segIndex); }

  setCurrentSegment(segIndex) {
    if (segIndex === this.currentSegment) return;
    this.currentSegment = segIndex;
    this._evict();
  }

  _evict() {
    if (this.currentSegment < 0) return;
    const lo = this.currentSegment - this.t;
    const toEvict = [];
    for (const [idx] of this.cache) {
      if (idx < lo) toEvict.push(idx);
    }
    if (toEvict.length > 0) {
      log(`🗑️ Cache EVICT [${toEvict.join(',')}] — fallen behind ${lo}`);
    }
    for (const idx of toEvict) {
      this.cache.delete(idx);
      this.evictedSet.add(idx);
      this.evictionCount++;
    }
    return toEvict;
  }

  getInventory() {
    return Array.from(this.cache.keys()).sort((a, b) => a - b);
  }

  getWindow() {
    const cur = Math.max(0, this.currentSegment);
    return {
      lo: Math.max(0, cur - this.t),
      hi: Math.min(this.totalSegments - 1, cur + this.tPrime),
      current: cur,
    };
  }
}
