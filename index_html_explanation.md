# Deep Dive: `index.html` (Frontend Client)

The `index.html` file is the unified frontend client (1,400 lines of zero-build HTML/CSS/JS). It manages the UI, the WebSockets connection, the chunk cache, the WebRTC mesh, and deeply hooks into `HLS.js`. 

Here is a block-by-block explanation of the entire file.

---

## 1. The Head & Styling (Lines 1 - 380)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Basic Meta Tags -->
  <meta charset="UTF-8">
  <title>StreamBox - P2P LAN Streaming</title>
  
  <!-- HLS.js CDN inclusion (Crucial for playing .m3u8 playlists) -->
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
```

The first huge block of the file is purely CSS wrapped in a `<style>` tag. 
* CSS variables are declared on `:root` to establish a dark-mode theme (`--bg-primary`, `--accent`, etc.).
* Grid calculations (`display: grid`) are used to create the Library View of video cards (`.video-grid`).
* Detailed styling for the `cache-vis` system is laid out. It defines the small colored boxes you see below the player:
  * `.chunk-block` (Default dark box representing a chunk that hasn't been loaded)
  * `.chunk-block.playing` (Bright purple: currently active in the video player element)
  * `.chunk-block.cached` (Faint purple: chunk downloaded and stored in ArrayBuffer memory)
  * `.chunk-block.evicted` (Red: chuck deleted from memory because it fell behind the sliding window)
  * `.chunk-block.p2p` (Green: chunk downloaded via WebRTC from another user on the network)

---

## 2. DOM Layout & Views (Lines 381 - 465)

The interface is structured into togglable full-page "Views" controlled via JavaScript `display: block/none`.

**The Username Modal:**
Prompts the user to enter a Display Name on load. Ties them to the networking protocol.

**The Library View (`#libraryView`):**
An empty grid (`#videoGrid`) that JS will dynamically populate with video details fetched from `/api/videos`.

**The Player View (`#playerView`):**
Hidden initially. Features the actual HTML5 `<video>` tag, standard metrics containers, and the "Chunk Cache Visualizer" grid (`#cacheVis`).
```html
<div class="stats-grid">
  ... <div id="statBuffer">—</div> ...
  ... <div id="statP2P">0%</div> ...
</div>
```

---

## 3. Global Configurations (Lines 468 - 483)

```javascript
const CACHE_T       = 3;   // chunks to keep BEHIND current
const CACHE_T_PRIME = 5;   // chunks to prefetch AHEAD of current
const CHUNK_DURATION = 4;  // seconds per chunk (must match ffmpeg -hls_time)
const PEER_ID = 'peer_' + Math.random().toString(36).slice(2, 10);
...
const DC_CHUNK_SIZE = 16384; // 16KB DataChannel send slices
```
Here we generate randomized cryptographic endpoints for our browser instance:
* `PEER_ID`: Unique identity for HTTP/Server logic.
* `WEBRTC_ID`: Used strictly for WebSocket/WebRTC signaling matching.
* `DC_CHUNK_SIZE`: WebRTC fails violently if you send multi-megabyte files across UDP channels at once. $16\text{KB}$ is mathematically the safest payload size cross-browser.

---

## 4. `ChunkCache` Class (Lines 485 - 560)

```javascript
class ChunkCache {
  constructor(t, tPrime) {
    this.cache = new Map(); // segIndex → { data: ArrayBuffer, ... }
  }
}
```

This class acts as a physical memory wall against runaway downloads:
1. `store()`: When a chunk downloads, this checks if the Chunk Index ($i$) is within the mathematical window `[currentSegment - t, currentSegment + t']`. If it is, the raw binary `ArrayBuffer` is saved to memory. If it isn't (or if the data is faulty), it outright rejects the store.
2. `setCurrentSegment(segIndex)`: Hooked directly into the HLS player. Every time the video shifts forward four seconds (hitting a new chunk), this fires.
3. `_evict()`: Cleans the cache. It deletes any binary payloads from the JS `Map()` memory dictionary that fall mathematically behind `currentSegment - t`, preventing RAM crashes.

---

## 5. `SignalingClient` Class (Lines 563 - 607)

```javascript
class SignalingClient {
  connect() {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.ws.send({ type: 'join', webrtcId: WEBRTC_ID });
    ...
```

Instead of using AJAX, this creates a persistent two-way pipe to the Node.js backend using WebSockets. 
All this class does is maintain the connection and route JSON messages with types like `offer`, `answer`, and `ice-candidate` to callback handlers, allowing devices on the LAN to negotiate a cryptographic hole-punching layer.

---

## 6. `PeerConnectionManager` Class (Lines 609 - 891)

This is the hardest and thickest logic block in the entire file.
It manages `RTCPeerConnection` paths (The actual browser WebRTC API logic).

**Connection Establishment (`_createConnection`, `_handleOffer`, `_handleAnswer`):**
Whenever we find a peer with chunks we want, we ping them with `$getConnection()`.
1. It initializes an `RTCPeerConnection`.
2. It generates an `RTCDataChannel` (called `chunks`).
3. It packages our constraints into an `Offer` via `setLocalDescription`, and fires it to the other Peer over the `SignalingClient` WebSocket.
4. The other Peer hits `_handleOffer`, locks the constraint to `setRemoteDescription`, responds with an `Answer`, and fires it back.
5. While this is happening, Google's external STUN servers figure out network maps and ping `ice-candidate` packets to link the UDP layers together tightly.

**Data Transfer Protocol (`_setupDC`, `_serveChunk`, `_concat`):**
Once the channel (`dc`) opens, it takes over traffic operations from HTTP.
* `haveChunk()`/`requestChunk()`: Wrap network triggers in Javascript Promises (to institute 100ms/2000ms timeouts just in case peers suddenly drop offline or freeze).
* `_serveChunk()`: Extracts the chunk binary `ArrayBuffer` from the `ChunkCache`, checks its physical size, and loops sequentially, sending `16KB` slices across the connection until sent, flanked by JSON `{type: "chunk_header"}` and `{type: "chunk_complete"}`.
* `dc.onmessage`: The receiver detects the `chunk_header`. It allocates a `received: []` temporary array. As binary arrays spray randomly out of the socket layer, it dumps them sequentially into `received`. When `chunk_complete` fires, it triggers `_concat()` which allocates a contiguous `Uint8Array` of `totalSize` bytes, and mathematically re-merges the binary back together into a valid `ArrayBuffer`! Finally, it resolves the Javascript Promise.

---

## 7. `fetchChunkP2P` & Custom `P2PLoader` Hook (Lines 1091 - 1241)

When we play a video using the HLS Javascript library, its job is to fire `XMLHttpRequest` commands into the network layer sequentially forever (`fetch chunk 1, fetch chunk 2`).

```javascript
class P2PLoader extends Hls.DefaultConfig.loader { ... }
```
We **hack** the HLS protocol by directly overriding the Fetch logic via class extension.
1. When a chunk must be downloaded, `P2PLoader` intercepts the URL request.
2. It triggers `fetchChunkP2P(segIndex)`.
3. The script asks the Server API: *"Who on the network has Chunk X?"*
4. Server Replies: `[ {webrtcId: "Bob_123"}, {webrtcId: "Steve_05"} ]`
5. The `PeerConnectionManager` automatically handshakes a DataChannel to Bob, negotiates a transfer, slices down the binary, and rebuilds the `ArrayBuffer`.
6. Once the Promise resolves, it crafts a forged HLS HTTP Response Context struct out of thin air containing `tfirst/tload/total` HTTP timings and forces it into the HLS `onSuccess` callback. HLS.js fundamentally does not realize the data didn't come from the physical HTTP server!

*(Fallback Logic)*: If `fetchChunkP2P()` fails (Bob disconnects, timeouts, or nobody has the chunk), the catch-block simply fires `super.load()`, invoking the native HTTP loader to grab the file straight from the Node.js backend.

---

## 8. Final Player Initialization (Lines 1243 - 1400)

```javascript
hls = new Hls({ ...
    maxBufferLength: maxBufSec, // strictly constrains download ahead bounds
    loader: P2PLoader // injects our P2P extension class
})
```

Once a user clicks on a grid item in the Library View `openPlayer()` is called. 
* Sets the `CACHE_T_PRIME` max-ahead math onto the HLS layer (e.g. bounding lookahead strictly to 20 seconds).
* Mounts HLS onto the DOM `<video>` object.
* Every time `Hls.Events.FRAG_LOADED` happens (meaning ANY chunk loads, via P2P or HTTP), it fires a hook to ensure `ChunkCache.store()` is called, immediately offering that chunk to the rest of the network!
* Periodically (`inventoryInterval`), it POSTs arrays of integers straight to server to track mathematical cache distributions.
