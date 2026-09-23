'use strict';

const resultBox = document.getElementById('result');
const titleEl = document.getElementById('result-title');
const nameEl = document.getElementById('result-name');
const detailEl = document.getElementById('result-detail');
const statsEl = document.getElementById('stats');

let lastToken = null;
let lastTime = 0;
let busy = false;

// Pull the token out of a scanned string, whether it's a full URL or bare token.
function extractToken(text) {
  if (!text) return null;
  try {
    const u = new URL(text, window.location.origin);
    const t = u.searchParams.get('t');
    if (t) return t;
  } catch (_) { /* not a URL */ }
  // Otherwise treat the whole payload as the token (strip whitespace).
  return text.trim() || null;
}

function beep(ok) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = ok ? 880 : 220;
    o.type = 'square';
    g.gain.value = 0.06;
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, ok ? 140 : 320);
  } catch (_) { /* audio not available */ }
}

function showResult(data) {
  resultBox.className = 'result show ' + data.result;
  const a = data.attendee;
  if (data.result === 'entered') {
    titleEl.textContent = '✓ ENTERED';
    nameEl.textContent = a ? a.name : '';
    detailEl.textContent = a && a.email ? a.email : 'Welcome!';
    beep(true);
  } else if (data.result === 'already') {
    titleEl.textContent = '✕ ALREADY ENTERED';
    nameEl.textContent = a ? a.name : '';
    detailEl.textContent = a && a.entered_at ? 'First entry: ' + a.entered_at + ' UTC' : 'Entry denied.';
    beep(false);
  } else {
    titleEl.textContent = '✕ INVALID CODE';
    nameEl.textContent = '';
    detailEl.textContent = 'This QR is not a valid entry pass.';
    beep(false);
  }
}

async function verify(token) {
  if (!token) return;
  busy = true;
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json();
    showResult(data);
    refreshStats();
  } catch (err) {
    resultBox.className = 'result show invalid';
    titleEl.textContent = 'Network error';
    nameEl.textContent = '';
    detailEl.textContent = 'Could not reach the server. Try again.';
  } finally {
    setTimeout(() => { busy = false; }, 800);
  }
}

function onScan(text) {
  const token = extractToken(text);
  const now = Date.now();
  // Ignore the same code re-read within 2.5s, and don't overlap requests.
  if (busy) return;
  if (token === lastToken && now - lastTime < 2500) return;
  lastToken = token;
  lastTime = now;
  verify(token);
}

async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const s = await res.json();
    statsEl.textContent = `${s.entered} in · ${s.remaining} left`;
  } catch (_) { /* ignore */ }
}

// If we arrived via a native-camera scan of the QR URL (/scan?t=TOKEN),
// verify that token immediately, then clean it out of the address bar.
(function handleUrlToken() {
  const t = new URLSearchParams(window.location.search).get('t');
  if (t) {
    verify(t);
    history.replaceState(null, '', '/scan');
  }
})();

// Start the live camera scanner for continuous scanning.
const scanner = new Html5Qrcode('reader');
const cfg = { fps: 10, qrbox: { width: 250, height: 250 } };
Html5Qrcode.getCameras()
  .then((cams) => {
    if (!cams || cams.length === 0) throw new Error('no camera');
    // Prefer a back-facing camera when available.
    const back = cams.find((c) => /back|rear|environment/i.test(c.label));
    const camId = back ? back.id : cams[cams.length - 1].id;
    return scanner.start(camId, cfg, onScan, () => {});
  })
  .catch((err) => {
    document.getElementById('hint').textContent =
      'Could not start the camera (' + err.message + '). Make sure the site is HTTPS and camera access is allowed.';
  });

refreshStats();
setInterval(refreshStats, 15000);

