# `peer-manager.js` Explanation

## What it does
Manages WebRTC peer connections, DataChannel messaging, chunk serving, and chunk reassembly.

## Defines
- `PeerConnectionManager` class for:
  - Connection lifecycle and deduplication
  - Signaling handlers (`offer`, `answer`, `ice-candidate`)
  - DataChannel protocol (`have_chunk`, `chunk_request`, chunk slices)
  - Timeout/cleanup/idle eviction handling

## Why it is needed
P2P chunk exchange requires robust connection orchestration; this file is the transport backbone that makes peer-to-peer transfer reliable.

