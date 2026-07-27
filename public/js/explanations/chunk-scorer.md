# `chunk-scorer.js` Explanation

## What it does
Calculates chunk importance scores and classifies chunks into playback zones relative to the playhead.

## Defines
- `ChunkScorer` class with:
  - `rarity(segIdx)`
  - `distanceSec(segIdx, currentSeg)`
  - `score(segIdx, currentSeg, sizeMB)`
  - `getZone(segIdx, currentSeg)`

## Why it is needed
The scheduler and eviction logic need consistent scoring to decide what to fetch next and what can be safely evicted.

