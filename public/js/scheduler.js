// ═══════════════════════════════════════════════
//  SCHEDULER
//
//  Runs every SCHEDULER_TICK_MS (2s).
//  Decides WHAT to fetch and at what priority.
//
//  Priority tiers:
//    1. 'urgent'        → safety zone + urgent zone missing chunks (server only for urgent)
//    2. 'deterministic' → top-K future chunks by score
//    3. 'probabilistic' → weighted-random sample from remaining future
//    4. 'past-demand'   → far-past chunks with high demand or rarity
// ═══════════════════════════════════════════════
class Scheduler {
  constructor(cacheManager, scorer, evictionPolicy) {
    this.cacheManager    = cacheManager;
    this.scorer          = scorer;
    this.evictionPolicy  = evictionPolicy;
    this.currentSeg      = 0;
    this.totalSegs       = 0;
    this.lastDecision    = [];
    this._timer          = null;
    this._onFetch        = null; // callback(segIdx, priority) set by player.js
    this._inFlight       = new Set(); // segIdx being fetched right now
  }

  // ─── Lifecycle ─────────────────────────────────
  start(onFetch) {
    this._onFetch = onFetch;
    this._timer = setInterval(() => this._tick(), SCHEDULER_TICK_MS);
    log(`📅 Scheduler started (tick=${SCHEDULER_TICK_MS}ms, det=${TOPK_DET}, rest=Bernoulli)`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._inFlight.clear();
  }

  updateSegment(seg, total) {
    this.currentSeg = seg;
    this.totalSegs  = total;
    // Rebalance zones + past-budget whenever playhead moves
    this.evictionPolicy.rebalance(this.cacheManager, this.scorer, seg);
  }

  markInFlight(segIdx)   { this._inFlight.add(segIdx); }
  markComplete(segIdx)   { this._inFlight.delete(segIdx); }

  // ─── Tick ──────────────────────────────────────
  async _tick() {
    if (!this.totalSegs || !this._onFetch || this._isTicking) return;
    this._isTicking = true;

    try {
      const decision = this._computeFetchList();
      this.lastDecision = decision;

      for (const item of decision) {
        if (this._inFlight.has(item.segIdx)) continue;
        if (this.cacheManager.has(item.segIdx)) continue;
        this._inFlight.add(item.segIdx);
        // Execute sequentially to avoid P2P race conditions and connection storms.
        await this._onFetch(item.segIdx, item.priority, item.zone);
      }
    } finally {
      this._isTicking = false;
    }
  }

  // ─── Fetch-list computation ────────────────────
  _computeFetchList() {
    const cur   = this.currentSeg;
    const total = this.totalSegs;
    const toFetch = [];

    const safetyLo = Math.max(0,         cur - Math.floor(SAFETY_PAST_SEC   / CHUNK_DURATION));
    const safetyHi = Math.min(total - 1, cur + Math.floor(SAFETY_FUTURE_SEC / CHUNK_DURATION));
    const urgentHi = Math.min(total - 1, cur + Math.floor(URGENT_SEC        / CHUNK_DURATION));

    // 1. Urgent zone: [cur, cur+2] — must prefetch, always from server
    for (let i = cur; i <= urgentHi; i++) {
      if (!this.cacheManager.has(i)) {
        toFetch.push({ segIdx: i, zone: 'urgent', priority: 'urgent' });
      }
    }

    // 2. Safety zone (non-urgent): missing → highest P2P-eligible priority
    for (let i = safetyLo; i <= safetyHi; i++) {
      if (i >= cur && i <= urgentHi) continue; // already handled above
      if (!this.cacheManager.has(i)) {
        const zone = i < cur ? 'safety-past' : 'safety';
        toFetch.push({ segIdx: i, zone, priority: 'deterministic' });
      }
    }

    // 3. Extended future: score-based selection
    const futureCandidates = [];
    for (let i = safetyHi + 1; i < total; i++) {
      if (this.cacheManager.has(i) || this._inFlight.has(i)) continue;
      const score = this.scorer.score(i, cur, 1 /* estimated 1 MB */);
      futureCandidates.push({ segIdx: i, score, zone: 'future' });
    }
    futureCandidates.sort((a, b) => b.score - a.score);

    // ── Deterministic top-4 (always fetched) ──────────
    for (const c of futureCandidates.slice(0, TOPK_DET)) {
      toFetch.push({ segIdx: c.segIdx, zone: c.zone, priority: 'deterministic' });
    }

    // ── Probabilistic Bernoulli trials for all remainder ──
    // Normalize by the max remaining score so the best leftover chunk
    // always has p=1.0 and all others fall off proportionally.
    // Each chunk is independently included — no fixed sample count.
    const remainder = futureCandidates.slice(TOPK_DET);
    if (remainder.length > 0) {
      const maxScore = remainder[0].score; // already sorted descending
      if (maxScore > 0) {
        for (const c of remainder) {
          const p = c.score / maxScore;   // ∈ (0, 1]
          if (Math.random() < p) {
            toFetch.push({ segIdx: c.segIdx, zone: c.zone, priority: 'probabilistic' });
          }
        }
      }
    }

    // 4. Far-past: fetch if highly demanded (demand > 0.8) or very rare (rarity > 0.7)
    for (let i = safetyLo - 1; i >= 0; i--) {
      if (this.cacheManager.has(i) || this._inFlight.has(i)) continue;
      const d = this.scorer.demand(i);
      const r = this.scorer.rarity(i);
      if (d > 0.8 || r > 0.7) {
        toFetch.push({ segIdx: i, zone: 'far-past', priority: 'past-demand' });
      }
      // Only scan up to 10 past chunks to avoid wasted effort
      if (safetyLo - i >= 10) break;
    }

    return toFetch;
  }
}
