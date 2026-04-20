# Technical Explanation: StreamBox Algorithms & Architecture

StreamBox relies on a series of distinct computer science networking principles and custom algorithms across the HTTP and WebRTC layers to achieve its P2P streaming capabilities.

## 1. Video Preprocessing & HLS Architecture
The core transport medium relies on **HTTP Live Streaming (HLS)**.
When `hls_convertor.py` is run, it uses FFmpeg to execute the following pipeline:
1. **Detection:** Probes to see if the video is already H.264 (video) and AAC (audio). Browser WebRTC DataChannels and HTML5 video nodes strongly rely on these specific codecs.
2. **Chunking algorithm:** Parses the video stream at designated keyframes (I-frames) every $N$ seconds (configured to 4). It creates discrete `.ts` (Transport Stream) files representing each temporal chunk of the video.
3. **Indexing:** Generates an `.m3u8` playlist acting as a simple text ledger of available `.ts` chunks.
4. **Cryptographic Hashing:** Computes a SHA-256 hash for every generated `.ts` file and exports a `hashes.json` manifest. This manifest is served to the client alongside the `.m3u8` playlist on first contact to cryptographically guarantee P2P swarm integrity.

## 2. The Independent Temporal Scheduler (`scheduler.js`)
Usually, standard video players will aggressively download over HTTP to buffer as much video as possible. This destroys P2P efficiency, because by the time Peer B connects, Peer A might have downloaded 100% of the video and flushed the start from memory.

Instead of overriding HLS.js internals, we completely decoupled the chunk downloader into a custom background asynchronous engine.
**The Algorithm:**
The Scheduler wakes up every 2 seconds (`SCHEDULER_TICK_MS`) and evaluates the `ChunkCache`. It slices the video timeline into zones:
- **Urgent** $[t, t+10s]$: Dangerously close. Pulled exclusively via HTTP.
- **Safety** $[t+10s, t+30s]$: Pulled perfectly synchronously from P2P.
- **Future** $[t+30s, \infty]$: Probabilistically pulled via Bernoulli trials based on computed scores.
- **Far-Past** $[< t-20s]$: Actively pulled if swarm rarity is dangerously high ($r > 0.7$).

## 3. Score-Based Memory Management (`ChunkScorer` & `EvictionPolicy`)
Because video files are enormous, we cannot keep the entire video in a device's RAM. Instead of a fixed slice, we implement a flexible 100MB Budgeted Cache mapped to an exponential temporal-decay equation.

**The Scoring Equation:**
Each chunk in memory is continuously evaluated using:
$$ Score = \frac{rarity \times \exp(-\lambda \times \text{distance})}{\text{size\_MB}} $$
- **Rarity**: Swarm inversion $1 / (1 + peers\_having\_chunk)$.
- **Temporal Decay**: Exponential dropoff $\lambda = 0.005$ based on distance from the playhead.

**Cooperative Eviction Logic (`rebalance` & `makeRoom`):**
When the 100MB cache fills, the `EvictionPolicy` sorts chunks lowest-score-first and deletes them. However, it behaves **Cooperatively**:
- It rigidly guarantees retaining a `< PAST_CHUNK_MIN` (15%) bound for consumed past chunks and aggressively trims back down at `PAST_CHUNK_MAX` (20%).
- This actively stops purely selfish forward-buffering, guaranteeing every peer continuously returns their fair 15% share cache back to the swarm.

## 4. Peer Discovery & Registry Lookups
The backend server (`server.py`) behaves as a **Centralized Tracker** (similar to BitTorrent).
Every 5 seconds, each device executes a heartbeat `POST /api/peers/update-cache` sending its peer ID, video identifier, and array of currently cached chunk indices $[c_1, c_2, ...]$.

**In-Memory Lookup Algorithm:**
When Peer B needs a chunk:
1. Peer B hits `POST /api/peers/list` providing a `chunkId`.
2. The Python/Flask tracking map iteratively filters through all active peers watching that exact video ID.
3. Drops any peer where `peers[id]["lastSeen"] > 10000ms` (stale connection).
4. Drops any peer where the required `chunkId` is NOT in their reported integer array.
5. Employs **Uniform Load Distribution**: instead of bottlenecking all network fetches linearly out of the single oldest peer, it uses a bounded `$K=5$` random uniform sampler (`random.sample()`). The list is randomly shuffled back to the clients, flawlessly dispersing the network upload load across the entire physical LAN swarm.

## 5. P2P WebRTC Signaling Negotiation & Reliability
WebRTC cannot connect directly using an IP. It requires **SDP (Session Description Protocol)** negotiation.

1. **Offer & Deduplication Check:** Before initiating, the system checks `_pendingConnections`. If a connection attempt to the peer is already in-flight, it `awaits` it instead of flooding redundant WebRTC calls, preventing "Connection Storms". If clear, Peer B generates an SDP offer mapping network constraints and sends it via WebSocket to the central Server.
2. **Glare Tie-Breakers:** A classic WebRTC "Glare" condition happens if Peer A and B send offers simultaneously, causing a split-brain deadlock. The system resolves this via a strict **Lexicographical Tie-Breaker**:
   - The peers compare their WebRTC string IDs.
   - The higher ID "wins" (ignores incoming offers).
   - The lower ID "yields" (tears down its outbound attempt and accepts the incoming offer).
3. **Relay & Answer:** The Server relays the winning JSON payload directly to the target. The target generates an SDP Answer confirming constraints, passing it back.
4. **ICE Candidates:** Both devices query Google's STUN server (`stun.l.google.com`) to map their public IP coordinates. They relay these candidates to each other over the WebSocket. Once paths align, the WebRTC mesh "punches through" NAT configuration, establishing a direct link.

## 6. The `P2PLoader`, Security, and Binary Slice Transfer
Once the physical WebRTC link connects, you cannot reliably send a 5MB `.ts` chunk in one burst across a UDP local channel without crashing the Javascript stack or overwhelming max-message limits.

**Cryptographic SHA-256 Chunk Validation:**
Because the P2P swarm is inherently untrustworthy, chunks received from peers are strictly validated before making it to the player. 
- On stream load, players download a localized tracker manifest (`hashes.json`) from the trusted server containing the expected SHA-256 checksums of every video slice.
- When `P2PLoader` fetches a file from a peer, it asynchronously hashes the `ArrayBuffer` in Javascript.
- If the hash mismatches the server manifest (i.e. data corruption or malicious interference), the connection to that peer is immediately severed, the chunk is abandoned, and it fails over cleanly to HTTP.

**Concurrent `scheduler.js` pooling:**
Instead of HLS.js crawling sequential files single-threaded, a secondary background Scheduler evaluates what blocks are urgently missing using temporal-decay equations and Rarity functions. It then spins up exactly `MAX_CONCURRENT_P2P = 3` async network pipe workers. These independently pick the top shuffled peers and violently pull blocks down in parallel, accelerating network ingestion dramatically. 

**Reassembly Protocol (Multiplexing):**
1. Peer B sends `{type: 'chunk_request', chunkId: 5}` over the DataChannel.
2. Peer A extracts the matching binary `ArrayBuffer` from its memory Cache.
3. Peer A generates a header: `{type: 'chunk_header', totalSize: 4500000}`.
4. **Slicing:** Peer A carves the `ArrayBuffer` into $16\text{KB}$ slices. It prefixes a 4-byte little-endian chunk ID onto each slice (multiplexing) and streams it via `dc.send(sliceMsg)`.
5. Peer A generates a footer: `{type: 'chunk_complete'}`.
6. Peer B's browser tracks the multiplexed ID, stores slices into an array until `chunk_complete` triggers, tightly concatenates the array into a contiguous block, hashes it for integrity, and hands the raw bytes to the video player thread.
