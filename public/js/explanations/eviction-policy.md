# `eviction-policy.js` Explanation

## What it does
Controls how cache space is reclaimed while protecting critical playback chunks.

## Defines
- `EvictionPolicy` class:
  - `makeRoom(...)` evicts low-value far-past chunks to free bytes.
  - `rebalance(...)` updates zones and enforces far-past budget caps.

## Why it is needed
Without policy-driven eviction, cache pressure would either break playback or remove chunks that are important for smooth streaming and swarm cooperation.

