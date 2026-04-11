// ═══════════════════════════════════════════════
//  APP INIT — Username modal, signaling, boot
// ═══════════════════════════════════════════════

function initUsernameModal() {
  const modal = document.getElementById('usernameModal');
  const input = document.getElementById('usernameInput');
  const btn = document.getElementById('usernameSubmit');

  if (USERNAME) {
    modal.classList.add('hidden');
    return;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });

  btn.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    USERNAME = name;
    sessionStorage.setItem('streambox_username', USERNAME);
    modal.classList.add('hidden');
  });

  input.focus();
}

// ─── Boot ───────────────────────────────────────
initUsernameModal();

signaling = new SignalingClient();
signaling.connect();

peerManager = new PeerConnectionManager(signaling, null);

loadLibrary();
