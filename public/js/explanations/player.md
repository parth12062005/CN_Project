# `player.js` Explanation

## What it does
Implements the full playback flow: library loading, player open/close, HLS startup, scheduler integration, cache visualization, and telemetry updates.

## Defines
- UI flow functions (`loadLibrary`, `openPlayer`, `closePlayer`).
- Scheduler fetch pipeline (`_schedulerFetch`, `_httpFetch`, `_storeSchedulerResult`).
- Custom `P2PLoader` for HLS.js to use cache/P2P before HTTP fallback.
- Cache visualizer (`renderCacheVis`) and periodic inventory/stat syncing.

## Why it is needed
This file coordinates playback and all supporting systems, so users get smooth streaming with P2P-assisted chunk delivery.

