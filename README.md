# StreamBox 🎬
**P2P-Ready LAN HLS Video Streaming System**

StreamBox is a local-network (LAN) video streaming system that allows multiple devices on the same Wi-Fi network to browse and watch videos via HTTP Live Streaming (HLS). 

Under the hood, StreamBox implements a **sliding-window chunk cache** and a **WebRTC Peer-to-Peer (P2P) DataChannel**. This means if two devices on the same network are watching the same video, they can exchange video chunks directly with each other (P2P) instead of fetching everything from the server, drastically reducing server load.

---

## 🏗 System Architecture

The repository consists of exactly 3 core files:

1. **`hls_convertor.py` (The Preprocessor)**
   A Python script that takes a raw video file (e.g., `video.mp4`) and uses `ffmpeg` to transcode it into H.264/AAC and chop it into 4-second `.ts` (Transport Stream) chunks along with an `.m3u8` playlist. It stores these in the `output/` directory alongside an automatically generated thumbnail.

2. **`server.py` (The Server)**
   A pure Python backend powered by `Flask` and `flask-sock` (running on Waitress/Eventlet) that does three things:
   * **Video Server:** Serves the `.m3u8` playlists and `.ts` chunk files via HTTP to devices on the LAN.
   * **Peer Registry (P2P API):** Tracks what video each client is watching and what chunks they currently have cached in memory. It automatically scrambles and load-balances the peer connection requests.
   * **WebRTC Signaling:** Runs a WebSocket server (`ws://`) that helps browsers negotiate direct P2P connections (via SDP Offers, Answers, and Glare-resistant ICE Candidates).

3. **`public/` Stack (The Modular Client)**
   A zero-build vanilla HTML/JS frontend utilizing `HLS.js`, split completely into a strictly decoupled architecture:
   * **Library Interface:** A polished grid to select available videos.
   * **Adaptive P2P Scheduler (`scheduler.js`):** Intelligently prioritizes chunks via a probabilistic temporal-decay heuristic. Executes concurrent P2P transfers while halting selfish future-buffering to enforce cooperative peer uploading.
   * **Sliding Cache (`CacheManager`):** A strictly managed 100MB memory buffer that conditionally retains past chunks (15-20%) to sustain swarm health while trimming old data automatically.
   * **P2P Loader (`P2PLoader`):** A custom HLS.js fragment loader that intercepts downloads, aggressively pooling connections over WebRTC DataChannels to fetch the binary chunks via an optimized concurrent worker pool.
   * **Live Stats & Visualizer:** Real-time metrics showing buffer health, live network download speeds (in Mbps), and a dynamic cache map showing HTTP vs P2P transfers.

---

## 🚀 Getting Started

### Prerequisites
* **Python 3.x**
* **FFmpeg** (must be installed on the system path)

### 1. Installation

1. Clone this repository and enter the directory.
2. Install the necessary Python dependencies:
   ```bash
   pip install flask flask-cors flask-sock waitress
   ```

### 2. Preparing a Video

To stream a video, you first need to convert it into HLS format.

```bash
python3 hls_convertor.py /path/to/your/video.mp4
```

This will:
* Create a folder inside `output/` named after your video.
* Chunk the video using FFmpeg.
* Generate a `thumbnail.jpg` from the 25% mark of the video.

*You can run this command on multiple videos to build up your library.*

### 3. Starting the Server

```bash
python3 server.py
```

The server will automatically detect your local LAN IP and bind to `0.0.0.0` on port 3003. It will output a sharing URL in the terminal (e.g., `http://192.168.1.5:3003`).

*(Note: Depending on your firewall settings, you may need to allow traffic on port 3003. Example: `sudo ufw allow 3003/tcp`).*

### 4. Watching and P2P Sharing

1. Open the share URL on your phone, laptop, or tablet while connected to the same Wi-Fi.
2. Enter a display name.
3. Play a video.

**To trigger P2P mode:** Open the same URL on *another* device on the network and start playing the same video. Open the "Chunk Cache" and "System Stats" metrics below the player. You will see chunks transferring securely via WebRTC DataChannels (displayed as **Green** blocks, with the "Source" reading **P2P**).

---

## 🔍 How the Cache Works

The system implements a rigid sliding-window chunk cache designed specifically to make WebRTC transfers easy:

* $t$ (Behind): The number of chunks to keep in memory *before* the current playing segment. Once a chunk falls behind $t$, it is evicted to save RAM.
* $t'$ (Ahead): The max number of chunks fetched ahead. TCP requests are bounded so the player never "runs away" and aggressively over-downloads.

When a chunk falls inside this window, the client saves its raw `ArrayBuffer` in memory and periodically reports its numeric chunk inventory (e.g., `[ 6, 7, 8, 9, 10 ]`) back to the server. When Peer B asks the server for chunk `9`, the server points them to Peer A, initializing the WebRTC channel.
