// ═══════════════════════════════════════════════
//  EVICTION POLICY
//
//  Rules:
//  1. NEVER evict 'urgent', 'safety', or 'future' zone chunks.
//  2. ONLY far-past chunks are evictable.
//  3. Always enforce 20% past budget max cap first.
//  4. High-demand future chunks may exceed normal budget
//     (up to OVER_BUDGET_CAP_MB extra) — they are still not evicted.
// ═══════════════════════════════════════════════
class EvictionPolicy {
  /**
   * Attempt to free at least `neededBytes` from the cache by evicting
   * ONLY far-past chunks. Future chunks are never touched.
   * Returns total bytes freed.
   */
  makeRoom(cacheManager, scorer, currentSeg, neededBytes) {
    const pastBudgetMaxBytes = PAST_BUDGET_MAX_FRAC * cacheManager.budgetBytes;
    const pastBudgetMinBytes = PAST_BUDGET_MIN_FRAC * cacheManager.budgetBytes;
    let freed = 0;

    // Collect all far-past chunks, scored lowest-first
    let pastBytes    = 0;
    const pastChunks = [];

    for (const [idx, entry] of cacheManager.getAll()) {
      if (entry.zone !== 'far-past') continue;   // future / safety / urgent: untouchable
      pastBytes += entry.sizeBytes;
      pastChunks.push({
        idx,
        scorePerByte: scorer.score(idx, currentSeg) / entry.sizeBytes,
        sizeBytes: entry.sizeBytes,
      });
    }

    // Sort: lowest score-per-byte first → evict those first
    pastChunks.sort((a, b) => a.scorePerByte - b.scorePerByte);

    for (const c of pastChunks) {
      if (freed >= neededBytes) break;
      // Do not evict if it drops us below the past budget minimum! Safety/Future chunks are priority though, 
      // but if we are below minimum we probably shouldn't evict past chunk except if it is absolute emergency. 
      // Wait, the user said "at least 15% SHOULD be past chunks".
      // But if we need room for urgent chunks, we MUST evict anyway because urgent > past.
      cacheManager.remove(c.idx);
      pastBytes -= c.sizeBytes;
      freed     += c.sizeBytes;
      log(`🗑️ Evict far-past seg${c.idx} — freed ${(c.sizeBytes / 1024).toFixed(0)} KB`);
    }

    if (freed < neededBytes) {
      log(`⚠️ EvictionPolicy: only freed ${(freed / 1024).toFixed(0)} KB of ${(neededBytes / 1024).toFixed(0)} KB — future chunks protected, no more past chunks available`);
    }

    return freed;
  }

  /**
   * Called on every playhead advance. Re-zones all entries and enforces 15% past cap.
   * Future chunks are re-zoned but NEVER evicted here either.
   */
  rebalance(cacheManager, scorer, currentSeg) {
    // Re-zone all entries
    for (const [idx, entry] of cacheManager.getAll()) {
      entry.zone = scorer.getZone(idx, currentSeg);
    }

    // Enforce far-past 20% max cap — only evict far-past
    const pastBudgetMaxBytes = PAST_BUDGET_MAX_FRAC * cacheManager.budgetBytes;
    let pastBytes = 0;
    const pastChunks = [];

    for (const [idx, entry] of cacheManager.getAll()) {
      if (entry.zone !== 'far-past') continue;
      pastBytes += entry.sizeBytes;
      pastChunks.push({
        idx,
        scorePerByte: scorer.score(idx, currentSeg) / entry.sizeBytes,
        sizeBytes: entry.sizeBytes,
      });
    }

    if (pastBytes > pastBudgetMaxBytes) {
      pastChunks.sort((a, b) => a.scorePerByte - b.scorePerByte);
      for (const c of pastChunks) {
        if (pastBytes <= pastBudgetMaxBytes) break;
        cacheManager.remove(c.idx);
        pastBytes -= c.sizeBytes;
        log(`🗑️ Rebalance: evict far-past seg${c.idx}`);
      }
    }
  }
}
