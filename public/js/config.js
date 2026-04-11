// ═══════════════════════════════════════════════
//  CONFIG — Constants and shared IDs
// ═══════════════════════════════════════════════
const CACHE_T       = 3;
const CACHE_T_PRIME = 5;
const CHUNK_DURATION = 4;
const PEER_ID = 'peer_' + Math.random().toString(36).slice(2, 10);
const WEBRTC_ID = 'wrtc_' + Math.random().toString(36).slice(2, 10);
const INVENTORY_INTERVAL = 5000;
const P2P_HAVE_TIMEOUT  = 200;
const P2P_CHUNK_TIMEOUT = 5000;
const CONN_IDLE_TIMEOUT = 30000;
const DC_CHUNK_SIZE = 16384;

let USERNAME = sessionStorage.getItem('streambox_username') || '';
