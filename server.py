#!/usr/bin/env python3
"""
StreamBox — HLS Streaming Server (LAN + P2P)
Python equivalent of server.js using Flask + flask-sock
"""

import os
import json
import time
import socket
import threading
from pathlib import Path
from datetime import datetime

from flask import Flask, request, jsonify, send_from_directory, abort
from flask_cors import CORS
from flask_sock import Sock

# ─── Config ──────────────────────────────────────────────
PORT = 3003
BASE_DIR = Path(__file__).parent.resolve()
OUTPUT_DIR = BASE_DIR / "output"
PUBLIC_DIR = BASE_DIR / "public"
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)
SERVER_LOG_FILE = LOGS_DIR / "server_terminal.log"

import re
ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

# ─── Logger ──────────────────────────────────────────────
C = {
    "reset": "\x1b[0m",
    "dim": "\x1b[2m",
    "bold": "\x1b[1m",
    "green": "\x1b[32m",
    "yellow": "\x1b[33m",
    "blue": "\x1b[34m",
    "magenta": "\x1b[35m",
    "cyan": "\x1b[36m",
    "red": "\x1b[31m",
    "white": "\x1b[37m",
}


def ts():
    return datetime.now().strftime("%H:%M:%S")


class LOG:
    @staticmethod
    def _write_to_file(msg):
        # Remove ANSI color codes for file log
        clean_msg = ansi_escape.sub('', msg)
        with open(SERVER_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(clean_msg + "\n")

    @staticmethod
    def req(method, url, ip, extra=""):
        color = C["green"] if method == "GET" else C["yellow"]
        msg = f'{C["dim"]}{ts()}{C["reset"]} {color}{method:<5}{C["reset"]} {url} {C["dim"]}← {ip}{C["reset"]}{" " + extra if extra else ""}'
        print(msg)
        LOG._write_to_file(msg)

    @staticmethod
    def chunk(video_name, seg_file, ip, size_bytes):
        size_kb = size_bytes // 1024
        msg = f'{C["dim"]}{ts()}{C["reset"]} {C["cyan"]}CHUNK{C["reset"]} {video_name}/{seg_file} {C["dim"]}({size_kb}KB → {ip}){C["reset"]}'
        print(msg)
        LOG._write_to_file(msg)

    @staticmethod
    def peer(action, peer_id, details=""):
        color = C["green"] if action == "JOIN" else C["red"] if action == "LEAVE" else C["blue"]
        msg = f'{C["dim"]}{ts()}{C["reset"]} {color}PEER {action}{C["reset"]} {peer_id} {C["dim"]}{details}{C["reset"]}'
        print(msg)
        LOG._write_to_file(msg)

    @staticmethod
    def cache(peer_id, chunks):
        r = f"[{chunks[0]}…{chunks[-1]}] ({len(chunks)} chunks)" if chunks else "(empty)"
        msg = f'{C["dim"]}{ts()}{C["reset"]} {C["magenta"]}CACHE{C["reset"]} {peer_id} → {r}'
        print(msg)
        LOG._write_to_file(msg)

    @staticmethod
    def ws(action, id_, details=""):
        msg = f'{C["dim"]}{ts()}{C["reset"]} {C["blue"]}WS   {C["reset"]} {action} {id_} {C["dim"]}{details}{C["reset"]}'
        print(msg)
        LOG._write_to_file(msg)

    @staticmethod
    def info(msg):
        out = f'{C["dim"]}{ts()}{C["reset"]} {C["white"]}INFO {C["reset"]} {msg}'
        print(out)
        LOG._write_to_file(out)

    @staticmethod
    def warn(msg):
        out = f'{C["dim"]}{ts()}{C["reset"]} {C["yellow"]}WARN {C["reset"]} {msg}'
        print(out)
        LOG._write_to_file(out)


# ─── LAN IP detection ───────────────────────────────────
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


LOCAL_IP = get_local_ip()

# ─── In-memory peer registry (P2P) ──────────────────────
peers = {}            # peerId → { videoName, username, chunks, chunkSizes, lastSeen, webrtcId, ip }
signaling_clients = {}  # webrtcId → websocket object

# ─── Demand tracking ─────────────────────────────────────
# chunk_requests[videoId][chunkIdx] = count of requests in last 60s
import collections
chunk_requests = collections.defaultdict(lambda: collections.defaultdict(int))
chunk_request_times = collections.defaultdict(list)  # (videoId, chunkIdx) → [timestamps]

# ─── Stale peer cleanup thread ───────────────────────────
def clean_stale_peers():
    while True:
        time.sleep(10)
        now = time.time() * 1000  # ms
        stale = [pid for pid, p in peers.items() if now - p["lastSeen"] > 30000]
        for pid in stale:
            del peers[pid]
            LOG.peer("STALE", pid, "removed after 30s inactivity")


cleanup_thread = threading.Thread(target=clean_stale_peers, daemon=True)
cleanup_thread.start()

# ─── Flask App ───────────────────────────────────────────
app = Flask(__name__, static_folder=None)
CORS(app, resources={r"/*": {"origins": "*"}})
sock = Sock(app)

# ─── Request Logger (after_request) ─────────────────────
@app.after_request
def log_request(response):
    url = request.path
    ip = request.remote_addr or "?"
    method = request.method

    if url.startswith("/stream/") and url.endswith(".ts"):
        parts = url.replace("/stream/", "").split("/")
        video_name = parts[0]
        seg_file = parts[-1]
        file_path = OUTPUT_DIR / video_name / seg_file
        size = file_path.stat().st_size if file_path.exists() else 0
        LOG.chunk(video_name, seg_file, ip, size)
    elif url.startswith("/stream/") and url.endswith(".m3u8"):
        LOG.req(method, url, ip, f"{response.status_code} [playlist]")
    elif url.startswith("/api/"):
        LOG.req(method, url, ip, f"{response.status_code}")

    return response


# ─── Serve frontend (public/) ────────────────────────────
@app.route("/")
def serve_index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/<path:filename>")
def serve_public(filename):
    file_path = PUBLIC_DIR / filename
    if file_path.is_file():
        return send_from_directory(PUBLIC_DIR, filename)
    abort(404)


# ─── Serve HLS content (/stream/) ───────────────────────
MIME_TYPES = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


@app.route("/stream/<path:filepath>")
def serve_stream(filepath):
    full_path = OUTPUT_DIR / filepath
    if not full_path.is_file():
        abort(404)

    ext = full_path.suffix.lower()
    mime = MIME_TYPES.get(ext)

    response = send_from_directory(OUTPUT_DIR, filepath)

    if mime:
        response.headers["Content-Type"] = mime
        response.headers["Access-Control-Allow-Origin"] = "*"
        if ext == ".m3u8":
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        elif ext == ".ts":
            response.headers["Cache-Control"] = "public, max-age=3600"

    return response


# ─── API: Video Library ──────────────────────────────────
@app.route("/api/videos")
def api_videos():
    if not OUTPUT_DIR.exists():
        LOG.info("Library request — output dir missing, returning empty")
        return jsonify({"videos": []})

    videos = []
    for entry in sorted(OUTPUT_DIR.iterdir()):
        if not entry.is_dir():
            continue
        if not (entry / "index.m3u8").exists():
            continue

        chunks = [f for f in entry.iterdir() if f.suffix == ".ts"]
        has_thumb = (entry / "thumbnail.jpg").exists()
        videos.append({
            "name": entry.name,
            "title": entry.name.replace("_", " "),
            "playlist": f"/stream/{entry.name}/index.m3u8",
            "thumbnail": f"/stream/{entry.name}/thumbnail.jpg" if has_thumb else None,
            "chunks": len(chunks),
        })

    LOG.info(f'Library: {len(videos)} video(s) found — [{", ".join(v["name"] for v in videos)}]')
    return jsonify({"videos": videos})


# ─── API: Server Info ────────────────────────────────────
@app.route("/api/info")
def api_info():
    return jsonify({
        "ip": LOCAL_IP,
        "port": PORT,
        "playerUrl": f"http://{LOCAL_IP}:{PORT}",
    })


@app.route("/api/status")
def api_status():
    LOG.info(f"Status check — {len(peers)} active peer(s)")
    return jsonify({
        "status": "running",
        "server": {"ip": LOCAL_IP, "port": PORT},
        "peers": len(peers),
    })


# ─── API: Peer Registry (P2P) ───────────────────────────
@app.route('/api/logs', methods=['POST'])
def receive_peer_logs():
    data = request.json or {}
    msg = data.get('msg', '')
    peer_name = data.get('username', '').strip()
    if not peer_name:
        peer_name = data.get('peerId', 'unknown_peer').strip()
    
    # Sanitize peer name for filename
    safe_name = "".join(c for c in peer_name if c.isalnum() or c in " ._-").strip() or "unknown_peer"
    
    log_file = LOGS_DIR / f"{safe_name}.log"
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    
    return jsonify({"status": "ok"})

@app.route("/api/peers/register", methods=["POST"])
def api_peers_register():
    data = request.get_json(silent=True) or {}
    peer_id = data.get("peerId")
    video_name = data.get("videoName")
    if not peer_id or not video_name:
        return jsonify({"error": "peerId and videoName required"}), 400

    ip = request.remote_addr or "?"
    peers[peer_id] = {
        "videoName": video_name,
        "username": data.get("username", "Anonymous"),
        "chunks": [],
        "lastSeen": time.time() * 1000,
        "webrtcId": data.get("webrtcId"),
        "ip": ip,
    }

    LOG.peer("JOIN", peer_id, f'video="{video_name}" ip={ip} total={len(peers)}')
    return jsonify({"ok": True, "peerId": peer_id, "totalPeers": len(peers)})


@app.route("/api/peers/update-cache", methods=["POST"])
def api_peers_update_cache():
    data = request.get_json(silent=True) or {}
    peer_id = data.get("peerId")
    if not peer_id:
        return jsonify({"error": "peerId required"}), 400

    peer = peers.get(peer_id)
    if not peer:
        LOG.warn(f"Cache update from unknown peer: {peer_id}")
        return jsonify({"error": "peer not registered"}), 404

    peer["chunks"]     = data.get("chunks", [])
    peer["chunkSizes"] = data.get("chunkSizes", {})  # {"12": 3145728, ...}
    peer["lastSeen"]   = time.time() * 1000

    LOG.cache(peer_id, peer["chunks"])
    return jsonify({"ok": True})


@app.route("/api/peers/<video_name>")
def api_peers_by_video(video_name):
    result = []
    for pid, peer in peers.items():
        if peer["videoName"] == video_name:
            result.append({"peerId": pid, "username": peer["username"], "chunks": peer["chunks"]})

    LOG.info(f'Peer list for "{video_name}": {len(result)} peer(s)')
    return jsonify({"videoName": video_name, "peers": result})


@app.route("/api/peers/unregister", methods=["POST"])
def api_peers_unregister():
    data = request.get_json(silent=True) or {}
    peer_id = data.get("peerId")
    peer = peers.get(peer_id)
    if peer:
        elapsed = (time.time() * 1000 - peer["lastSeen"]) / 1000
        LOG.peer("LEAVE", peer_id, f'video="{peer["videoName"]}" was watching for {elapsed:.0f}s')
    peers.pop(peer_id, None)
    return jsonify({"ok": True})


# ─── API: Peer Lookup for P2P chunk fetch ────────────────
PEER_LIST_K = 5
PEER_FRESH_MS = 10000


@app.route("/api/peers/list", methods=["POST"])
def api_peers_list():
    data = request.get_json(silent=True) or {}
    video_id     = data.get("videoId")
    chunk_id     = data.get("chunkId")
    requester_id = data.get("requesterId")

    if video_id is None or chunk_id is None:
        return jsonify({"error": "videoId and chunkId required"}), 400

    # Track request for demand scoring
    now_sec = time.time()
    key = (str(video_id), int(chunk_id) if chunk_id is not None else 0)
    chunk_request_times[key].append(now_sec)
    # Prune old requests (> 60s)
    chunk_request_times[key] = [t for t in chunk_request_times[key] if now_sec - t < 60]

    now = time.time() * 1000
    candidates = []

    for pid, peer in peers.items():
        if pid == requester_id:
            continue
        if peer["videoName"] != video_id:
            continue
        if now - peer["lastSeen"] > PEER_FRESH_MS:
            continue
        if chunk_id not in peer["chunks"]:
            continue
        if not peer.get("webrtcId"):
            continue

        candidates.append({
            "peerId":   pid,
            "username": peer["username"],
            "webrtcId": peer["webrtcId"],
            "ip":       peer["ip"],
            "lastSeen": peer["lastSeen"],
            "chunks":   peer["chunks"],
        })

    candidates.sort(key=lambda x: x["lastSeen"], reverse=True)
    result = candidates[:PEER_LIST_K]

    LOG.info(f'P2P lookup: chunk {chunk_id} of "{video_id}" → {len(result)} peer(s) have it')
    return jsonify({"peers": result})


# ─── API: Demand Signal ──────────────────────────────────
@app.route("/api/demand")
def api_demand():
    video_id = request.args.get("videoId")
    if not video_id:
        return jsonify({"error": "videoId required"}), 400

    now_sec = time.time()
    now_ms  = now_sec * 1000

    # Count how many fresh peers hold each chunk
    peer_count_per_chunk = collections.defaultdict(int)  # chunkIdx → count
    for pid, peer in peers.items():
        if peer["videoName"] != video_id:
            continue
        if now_ms - peer["lastSeen"] > PEER_FRESH_MS:
            continue
        for c in peer["chunks"]:
            peer_count_per_chunk[c] += 1

    # Collect all chunks known to exist in this video
    all_chunks = set(peer_count_per_chunk.keys())
    for pid, peer in peers.items():
        if peer["videoName"] == video_id:
            all_chunks.update(peer["chunks"])

    demand_out      = {}
    peer_counts_out = {}

    for c in all_chunks:
        c_int = int(c)
        count = peer_count_per_chunk.get(c_int, 0)
        peer_counts_out[str(c_int)] = count

        # Rarity-based demand: under-replicated → demand = 1.0
        if count <= 1:
            base_demand = 1.0
        elif count <= 2:
            base_demand = 0.8
        else:
            base_demand = max(0.1, 1.0 / count)

        # Request-frequency boost (last 60s)
        key = (str(video_id), c_int)
        recent_requests = len([t for t in chunk_request_times.get(key, []) if now_sec - t < 60])
        freq_boost = min(recent_requests * 0.1, 0.3)  # up to +0.3

        demand_out[str(c_int)] = round(min(1.0, base_demand + freq_boost), 3)

    LOG.info(f'Demand signal for "{video_id}": {len(demand_out)} chunks')
    return jsonify({
        "videoId":    video_id,
        "demand":     demand_out,
        "peerCounts": peer_counts_out,
    })


# ─── WebSocket Signaling Server ──────────────────────────
@sock.route("/")
def websocket_handler(ws):
    my_webrtc_id = None
    ip = request.remote_addr or "?"
    LOG.ws("CONNECT", ip)

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break

            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue

            msg_type = msg.get("type")

            if msg_type == "join":
                my_webrtc_id = msg.get("webrtcId")
                if my_webrtc_id:
                    signaling_clients[my_webrtc_id] = ws
                    LOG.ws("JOIN", my_webrtc_id, f"from {ip}")

            elif msg_type in ("offer", "answer", "ice-candidate"):
                target_id = msg.get("target")
                target_ws = signaling_clients.get(target_id)
                if target_ws:
                    try:
                        target_ws.send(json.dumps({
                            "type": msg_type,
                            "from": my_webrtc_id,
                            "payload": msg.get("payload"),
                        }))
                        LOG.ws("RELAY", msg_type, f"{my_webrtc_id} → {target_id}")
                    except Exception:
                        LOG.ws("MISS", msg_type, f"target {target_id} send failed")
                else:
                    LOG.ws("MISS", msg_type, f"target {target_id} not found")

    except Exception as e:
        if my_webrtc_id:
            LOG.warn(f"WS error from {my_webrtc_id}: {e}")
    finally:
        if my_webrtc_id:
            signaling_clients.pop(my_webrtc_id, None)
            LOG.ws("LEAVE", my_webrtc_id)


# ─── Start ───────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\n🎬 HLS Streaming Server (LAN + P2P) — Python/Flask")
    print(f"─────────────────────────────────────")
    print(f"   Local:   http://localhost:{PORT}")
    print(f"   LAN:     http://{LOCAL_IP}:{PORT}")
    print(f"   WS:      ws://{LOCAL_IP}:{PORT}")
    print(f"─────────────────────────────────────")
    print(f"\n📱 Share: http://{LOCAL_IP}:{PORT}")
    print(f"🔥 Firewall: sudo ufw allow {PORT}/tcp")
    print(f"\n📋 Logs: watching for requests...\n")

    app.run(host="0.0.0.0", port=PORT, debug=False)
