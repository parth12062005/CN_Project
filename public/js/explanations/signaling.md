# `signaling.js` Explanation

## What it does
Wraps WebSocket signaling used by WebRTC peers to exchange join/offer/answer/ICE messages.

## Defines
- `SignalingClient` class with:
  - `connect()` and reconnect behavior
  - Event registration (`on(type, cb)`)
  - Message sending (`send(msg)`)

## Why it is needed
WebRTC cannot establish peer links without signaling; this file provides the control channel that enables connection negotiation.

