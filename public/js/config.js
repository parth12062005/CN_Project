// ═══════════════════════════════════════════════
//  CONFIG — Constants and shared IDs
// ═══════════════════════════════════════════════

// ─── Cache Budget ────────────────────────────────
const CACHE_BUDGET_MB = 100;           // total memory budget for chunk storage
const PAST_BUDGET_MIN_FRAC = 0.15;     // floor for past chunks to maintain swarm cooperation
const PAST_BUDGET_MAX_FRAC = 0.20;     // max cap before far-past eviction triggers

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
// remaining future chunks: each included with p = score/maxScore (Bernoulli)

// ─── High-rarity override ─────────────────────────
const RARITY_OVERRIDE_THRESHOLD = 0.85; // rarity above this bypasses budget for future chunks
const OVER_BUDGET_CAP_MB = 20;          // max MB above normal budget allowed for high-rarity future


// ─── P2P / Networking ────────────────────────────
const PEER_ID = 'peer_' + Math.random().toString(36).slice(2, 10);
const WEBRTC_ID = 'wrtc_' + Math.random().toString(36).slice(2, 10);
const INVENTORY_INTERVAL = 5000;
const P2P_HAVE_TIMEOUT = 1500;  // ms — must be long enough for a fresh DC round-trip
const P2P_CHUNK_TIMEOUT = 5000;
const CONN_IDLE_TIMEOUT = 30000;
const DC_CHUNK_SIZE = 16384;        // 16 KB DataChannel slice size

let USERNAME = sessionStorage.getItem('streambox_username') || '';
