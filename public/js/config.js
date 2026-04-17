// ═══════════════════════════════════════════════
//  CONFIG — Constants and shared IDs
// ═══════════════════════════════════════════════

// ─── Cache Budget ────────────────────────────────
const CACHE_BUDGET_MB = 100;          // total memory budget for chunk storage
const PAST_CHUNK_MIN = 0.15;         // min 15% budget retained for far-past chunks (cooperation)
const PAST_CHUNK_MAX = 0.20;         // max 20% budget allowed for far-past chunks

// ─── Zone Boundaries (seconds relative to playhead) ──
const URGENT_SEC = 10;           // [t, t+10s]: always server-fetch
const SAFETY_PAST_SEC = 20;           // [t-20s, t]: never evict
const SAFETY_FUTURE_SEC = 30;           // [t, t+30s]: never evict

// ─── Scoring ─────────────────────────────────────
const LAMBDA = 0.005;         // temporal decay constant
const CHUNK_DURATION = 4;            // seconds per HLS chunk

// ─── Scheduler ───────────────────────────────────
const SCHEDULER_TICK_MS = 2000;         // how often scheduler runs
const TOPK_DET = 4;            // deterministic top-K future chunks (guaranteed)
// remaining future chunks: each included with p = score/maxScore (Bernoulli)


// ─── P2P / Networking ────────────────────────────
const PEER_ID = 'peer_' + Math.random().toString(36).slice(2, 10);
const WEBRTC_ID = 'wrtc_' + Math.random().toString(36).slice(2, 10);
const INVENTORY_INTERVAL = 5000;
const P2P_HAVE_TIMEOUT = 1500;  // ms — must be long enough for a fresh DC round-trip
const P2P_CHUNK_TIMEOUT = 10000;
const CONN_IDLE_TIMEOUT = 30000;
const DC_CHUNK_SIZE = 16384;        // 16 KB DataChannel slice size

let USERNAME = sessionStorage.getItem('streambox_username') || '';
