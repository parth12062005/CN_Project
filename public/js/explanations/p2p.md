# `p2p.js` Explanation

## What it does
Handles P2P chunk-fetch workflow and related runtime stats.

## Defines
- `p2pStats` and `updateP2PStats()`.
- `fetchChunkP2P(segIndex, videoName)`:
  - Checks local cache
  - Asks server for peer candidates
  - Tries peers via WebRTC
  - Verifies chunk integrity via SHA-256
  - Falls back when needed

## Why it is needed
This is the core logic that turns peer discovery into actual chunk transfers, reducing server load and enabling P2P acceleration.

