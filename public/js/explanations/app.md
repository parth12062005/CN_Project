# `app.js` Explanation

## What it does
Initializes the client app startup flow: asks for username, connects signaling, creates the peer manager, and loads the video library.

## Defines
- `initUsernameModal()` for username capture and session persistence.
- Boot sequence that sets up:
  - `signaling = new SignalingClient()`
  - `peerManager = new PeerConnectionManager(...)`
  - `loadLibrary()`

## Why it is needed
This file is the app entry point that wires core modules together so the UI and P2P system can start.

