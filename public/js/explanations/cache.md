# `cache.js` Explanation

## What it does
Provides a compatibility wrapper class (`ChunkCache`) around the modular cache subsystem.

## Defines
- `ChunkCache` class that combines:
  - `CacheManager` (storage)
  - `ChunkScorer` (priority scoring)
  - `EvictionPolicy` (space recovery)
- Legacy APIs like `store`, `getData`, `has`, `getInventory`, and `setCurrentSegment`.

## Why it is needed
It keeps older modules working while internally using the newer modular cache design, avoiding widespread refactors.

