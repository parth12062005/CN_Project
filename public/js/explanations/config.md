# `config.js` Explanation

## What it does
Centralizes tunable constants and generated runtime identifiers used across client modules.

## Defines
- Cache and scheduling constants (budget, windows, tick rate, top-K).
- P2P/network constants (timeouts, chunk size, inventory interval).
- Runtime IDs (`PEER_ID`, `WEBRTC_ID`) and persisted `USERNAME`.

## Why it is needed
It prevents hard-coded magic values spread across files and keeps behavior consistent across the full client stack.

