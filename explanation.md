# Technical Explanation: StreamBox Algorithms & Architecture

StreamBox relies on a series of distinct computer science networking principles and custom algorithms across the HTTP and WebRTC layers to achieve its P2P streaming capabilities.

## 1. Video Preprocessing & HLS Architecture
The core transport medium relies on **HTTP Live Streaming (HLS)**.
When `hls_convertor.py` is run, it uses FFmpeg to execute the following pipeline:
1. **Detection:** Probes to see if the video is already H.264 (video) and AAC (audio). Browser WebRTC DataChannels and HTML5 video nodes strongly rely on these specific codecs.
2. **Chunking algorithm:** Parses the video stream at designated keyframes (I-frames) every $N$ seconds (configured to 4). It creates discrete `.ts` (Transport Stream) files representing each temporal chunk of the video.
3. **Indexing:** Generates an `.m3u8` playlist acting as a simple text ledger of available `.ts` chunks.

## 2. TCP Buffer Strict Contention (The HLS.js Hack)
Usually, standard video players will aggressively download over TCP to buffer as much video as possible. This breaks P2P, because by the time Peer B connects, Peer A might have downloaded 100% of the video and flushed it from memory.

**The Algorithm:**
The HLS.js configuration is strictly bound using `maxBufferLength` corresponding to our Cache $t'$ (lookahead) value.
If $t' = 5$ and a chunk is 4 seconds:
$$ maxBufferLength = 5 \times 4 = 20\text{ seconds} $$

The client reads chunks sequentially over HTTP, and the underlying TCP socket mathematically stops pulling bytes into the network buffer once exactly 20 seconds of video are loaded. It only requests the next chunk when $N$ seconds of video actually play, moving the playhead.

## 3. The Sliding Window Cache ($t$, $t'$)
Because video files are enormous, we cannot keep the entire video in a device's RAM to share over P2P. We implement an **idempotent sliding-window buffer**.

Let $c$ be the currently playing chunk sequence number.
Let $t$ be the number of chunks kept *behind* the playhead.
Let $t'$ be the number of chunks permitted to load *ahead* of the playhead.

**Cache Window Boundaries:**
$$ [c - t, \quad c + t'] $$

**Eviction Logic (`_evict()`):** 
On every `FRAG_CHANGED` (when the playhead moves), the `ChunkCache` iteratively drops keys (binary `ArrayBuffers` representing old `.ts` files) that fall below $c - t$. 
This keeps RAM usage completely static (number of cached chunks = $t + t'$) regardless of if the video is 10 minutes or 10 hours long. Only this subset of integers is reported to the server.

## 4. Peer Discovery & Registry Lookups
The backend server behaves as a **Centralized Tracker** (similar to BitTorrent).
Every 5 seconds, each device executes a heartbeat `POST /api/peers/update-cache` sending its peer ID, video identifier, and array of currently cached chunk indices $[c_1, c_2, ...]$.

**In-Memory Lookup Algorithm:**
When Peer B needs a chunk:
1. Peer B hits `POST /api/peers/list` providing a `chunkId`.
2. The Node.js tracking map iteratively filters through all active peers watching that exact video ID.
3. Drops any peer where `peers[id].lastSeen > 10000ms` (stale connection).
4. Drops any peer where the required `chunkId` is NOT in their reported integer array.
5. Sorts the resulting candidate peers by `lastSeen` (newest first) and takes the top $K$ candidates (where $K=5$).

## 5. P2P WebRTC Signaling Negotiation
WebRTC cannot connect directly using an IP. It requires **SDP (Session Description Protocol)** negotiation.

1. **Offer:** Peer B (Requester) generates an SDP offer mapping out its network cryptography constraints and sends it via WebSocket to the central Server.
2. **Relay:** The Server looks up Peer A's WebSocket ID, and relays the JSON payload directly to them.
3. **Answer:** Peer A generates an SDP Answer confirming constraints, passing it back via Server to B.
4. **ICE Candidates:** Both devices query Google's STUN server (`stun.l.google.com`) to map their public IP coordinates. They relay these candidates to each other over the WebSocket. Once paths align, the WebRTC mesh "punches through" NAT configuration, establishing a direct link.

## 6. The `P2PLoader` and Binary Slice Transfer
Once the physical WebRTC link connects, you cannot reliably send a 5MB `.ts` chunk in one burst across a UDP local channel without crashing the Javascript stack or overwhelming max-message limits.

**HLS `fLoader` Override:**
The player overrides the fundamental network fetch method in HLS.js. Before hitting `fetch()`, it triggers the WebRTC DataChannel check. 

**Reassembly Protocol:**
1. Peer B sends `{type: 'chunk_request', chunkId: 5}` over the DataChannel.
2. Peer A extracts the matching binary `ArrayBuffer` from its memory Cache.
3. Peer A generates a header: `{type: 'chunk_header', totalSize: 4500000}`.
4. **Slicing:** Peer A carves the `ArrayBuffer` into $16\text{KB}$ slices. It enters a loop, iteratively running `dc.send(slice)` for all chunks.
5. Peer A generates a footer: `{type: 'chunk_complete'}`.
6. Peer B's browser captures the events asynchronously. It stores slices into an array until the `chunk_complete` message triggers, at which point it uses a `Uint8Array` constructor to tightly concatenate the array slices into a contiguous block matching `totalSize`, and hands the raw bytes to the video player thread.
