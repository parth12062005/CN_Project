# `cache-manager.js` Explanation

## What it does
Implements in-memory chunk storage with a strict byte budget and metadata tracking.

## Defines
- `CacheManager` class with methods for:
  - Storing/removing chunks (`put`, `remove`)
  - Reading/querying (`get`, `has`, `entry`)
  - Budget tracking (`totalMB`, `hasRoom`, `pastMB`)
  - Inventory reporting (`getInventory`, `getInventoryWithSizes`)

## Why it is needed
P2P and HLS playback require fast binary chunk access; this file is the single source of truth for chunk memory state.

