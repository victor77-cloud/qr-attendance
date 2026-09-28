/* Offline QR Attendance PWA — application orchestration (UI glue).
 * Two roles on peer devices: Class Captain (marks + signs + renders) and
 * Lecturer (scans + verifies + commits). No server anywhere in the path.
 */
import * as db from './db.js';
import * as cr from './crypto.js';
import * as codec from './codec.js';
import { qrEncodeToCanvas, decodeVideoFrame } from './qr.js';

const $ = (id) => document.getElementById(id);

const state = {
  role: null,
  session: null,
  stream: null,
  scanning: false,
  raf: 0,
  lastDecode: '',
  scanMode: null
};

const VIEWS = ['home', 'setup', 'captain', 'lecturer', 'audit'];

/* ---- View switching ------------------------------------------------------ */

let totpTimer = null;

function show(view) {
  VIEWS.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== view));
  if (view !== 'lecturer') stopCamera();
  if (view !== 'captain' && totpTimer) {
    clearInterval(totpTimer);
    totpTimer = null;
  }
}

async function refreshStatus() {
  const roster = await db.store.getAll('roster');
  const key = await db.getSharedKey();
  const roleLabel = state.role === 'captain' ? 'Class Captain' : state.role === 'lecturer' ? 'Lecturer' : 'No role selected';
  $('role-badge').textContent = roleLabel;
  $('home-status').textContent =
    `Roster: ${roster.length} student(s) imported · ` +
    `Shared key: ${key ? 'paired' : 'not paired yet'}. ` +
    'Provision both once, in person, then use the app fully offline.';
}

/* ---- Role selection ------------------------------------------------------ */

function selectRole(role) {
  state.role = role;
  $('pairing-lecturer').classList.toggle('hidden', role !== 'lecturer');
  $('pairing-captain').classList.toggle('hidden', role !== 'captain');
  $('pairing-qr').classList.add('hidden');
  $('pairing-status').textContent = '';
  $('pairing-hint').textContent =
    role === 'lecturer'
      ? 'Generate a one-time key and let the captain scan its QR in person.'
      : 'Scan the lecturer\u2019s single-use pairing QR while physically present.';
  show('setup');
  refreshStatus();
}

/* ---- Provisioning: roster + key ----------------------------------------- */

async function onImportRoster() {
  const file = $('roster-file').files[0];
  if (!file) return;
  const text = await file.text();
  const rows = db.parseRosterText(text);
  if (!rows.length) {
    $('roster-count').textContent = 'No rows parsed. Use "id,name" per line.';
    return;
  }
  await db.importRoster(rows);
  $('roster-count').textContent = `Imported ${rows.length} student(s).`;
  refreshStatus();
}

async function displayPairingQr(b64) {
  $('pairing-qr').classList.remove('hidden');
  qrEncodeToCanvas(b64, $('pairing-canvas'));
  $('pairing-status').textContent = 'Key ready. Show this QR to the captain (one-time, in person).';
}

async function onGenerateKey() {
  try {
    const key = cr.randomBytes(32);
    await db.saveSharedKey(key);
    await displayPairingQr(cr.bytesToB64(key));
  } catch (e) {
    $('pairing-status').textContent = `Cannot generate: ${e.message}`;
  }
  refreshStatus();
}

async function savePairingKey(text) {
  try {
    const bytes = cr.b64ToBytes(text.trim());
    await db.saveSharedKey(bytes);
    $('pairing-status').textContent = 'Shared key saved. Pairing complete.';
    stopCamera();
    return true;
  } catch (e) {
    $('pairing-status').textContent = `Pairing failed: ${e.message}`;
    return false;
  }
}

async function onPasteKey() {
  const v = $('key-paste').value;
  if (v) await savePairingKey(v);
}

async function onScanPairing() {
  state.scanMode = 'pairing';
  // Show the camera preview inside the pairing panel (the scanner video
  // normally lives in the hidden lecturer view, so the captain couldn't aim).
  $('pairing-captain').appendChild($('scanner-video'));
  startCamera((text) => savePairingKey(text));
}

/* ---- Captain: session + marking + aggregate ------------------------------ */

async function enterCaptain() {
  await refreshRosterList();
  $('session-info').textContent = state.session
    ? `Session ${state.session.sessionId} active (nonce ${state.session.nonce.slice(0, 8)}…). Mark present below.`
    : 'No active session yet.';
  $('aggregate-qr').classList.add('hidden');
  show('captain');
  await updateCaptainTotp();
  if (!totpTimer) {
    totpTimer = setInterval(updateCaptainTotp, 1000);
  }
}

async function updateCaptainTotp() {
  if (!state.session) {
    $('session-code-container').classList.add('hidden');
    return;
  }
  const key = await db.getSharedKey();
  if (!key) {
    $('session-code-container').classList.add('hidden');
    return;
  }
  const code = await cr.getSessionTOTP(key, state.session.sessionId);
  $('session-totp-val').textContent = code;
  $('session-code-container').classList.remove('hidden');
}

async function refreshRosterList() {
  const roster = await db.store.getAll('roster');
  const box = $('roster-list');
  box.innerHTML = '';
  if (!roster.length) {
    box.innerHTML = '<p class="muted">No roster imported. Go back to provisioning.</p>';
    return;
  }
  roster.forEach((s) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.studentId;
    cb.checked = true;
    label.append(cb, ` ${s.studentId} — ${s.name}`);
    box.appendChild(label);
  });
}

async function onCreateSession() {
  const key = await db.getSharedKey();
  if (!key) {
    $('session-info').textContent = 'Pair a shared key first (provisioning step).';
    return;
  }
  const sessionId = `S-${Date.now().toString(36)}-${cr.hex(cr.randomBytes(3))}`;
  const nonce = cr.hex(cr.randomBytes(8));
  const ts = codec.nowSeconds();
  const expiryWindow = 2 * 3600; // seconds
  state.session = { sessionId, nonce, ts, expiryWindow };
  await db.createSession(sessionId, nonce, ts, expiryWindow);
  $('session-info').textContent =
    `Session ${sessionId} active (nonce ${nonce.slice(0, 8)}…, expires in ${expiryWindow / 3600}h). Mark present below.`;
  $('aggregate-qr').classList.add('hidden');
  await updateCaptainTotp();
}

function selectedPresent() {
  return Array.from($('roster-list').querySelectorAll('input:checked')).map((cb) => cb.value);
}

async function onRenderAggregate() {
  const key = await db.getSharedKey();
  const present = selectedPresent();
  if (!state.session) {
    $('aggregate-meta').textContent = 'Create a session first.';
    return;
  }
  if (!key) {
    $('aggregate-meta').textContent = 'No shared key. Pair first.';
    return;
  }
  if (!present.length) {
    $('aggregate-meta').textContent = 'Tick at least one present student.';
    return;
  }
  const base = { sessionId: state.session.sessionId, nonce: state.session.nonce, ts: state.session.ts };
  const text = await codec.signAggregate(key, {
    v: 1,
    type: 'aggregate',
    ...base,
    roster: await Promise.all(present.map(codec.shortHash))
  });
  if (text.length <= codec.FRAME_CAPACITY) {
    $('aggregate-qr').classList.remove('hidden');
    qrEncodeToCanvas(text, $('aggregate-canvas'));
    $('aggregate-meta').textContent = `${present.length} present · signed aggregate (single frame)`;
  } else {
    const chunks = await codec.chunkRoster(key, base, present);
    $('aggregate-qr').classList.remove('hidden');
    qrEncodeToCanvas(chunks[0], $('aggregate-canvas'));
    $('aggregate-meta').textContent =
      `${present.length} present · ${chunks.length} chained frames (frame 1 shown; reassembly: TODO)`;
  }
}

/* ---- Lecturer: scan + verify + commit ------------------------------------- */

async function enterLecturer() {
  // Put the scanner preview back in the lecturer's Scan panel.
  $('scan-status').before($('scanner-video'));
  $('result-panel').innerHTML = '<p class="muted">Nothing scanned yet.</p>';
  $('scan-status').textContent = 'Press “Start camera scan” and point at the captain\u2019s aggregate QR.';
  $('scanner-video').classList.add('hidden');
  $('manual-verify-status').textContent = '';
  $('verify-code-input').value = '';
  show('lecturer');
}

async function onVerifyCode() {
  const code = $('verify-code-input').value.trim();
  const statusEl = $('manual-verify-status');
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    statusEl.textContent = 'Please enter a valid 6-digit code.';
    return;
  }
  statusEl.textContent = 'Verifying…';

  const key = await db.getSharedKey();
  const sessions = await db.store.getAll('sessions');
  const roster = await db.store.getAll('roster');

  // 1. Check session TOTP codes
  if (key && sessions.length > 0) {
    for (const session of sessions) {
      const match = await cr.verifySessionTOTP(key, session.sessionId, code);
      if (match) {
        await db.appendAudit('code_verified', { type: 'session_totp', sessionId: session.sessionId, code });
        showResult(true, `Manual code verified: Valid session TOTP code for session ${session.sessionId}`);
        statusEl.textContent = '✓ Session TOTP code verified.';
        return;
      }
    }
  }

  // 2. Check per-student check-in codes
  if (roster.length > 0 && sessions.length > 0) {
    for (const session of sessions) {
      if (!session.nonce) continue;
      for (const student of roster) {
        if (!student.verificationToken) continue;
        const match = await cr.verifyStudentCheckInCode(student.verificationToken, session.nonce, code);
        if (match) {
          await db.appendAudit('code_verified', {
            type: 'student_checkin',
            studentId: student.studentId,
            sessionId: session.sessionId,
            code
          });
          showResult(
            true,
            `Manual code verified: Student check-in code for ${student.name} (${student.studentId}) in session ${session.sessionId}`
          );
          statusEl.textContent = `✓ Student check-in code verified (${student.studentId}).`;
          return;
        }
      }
    }
  }

  await db.appendAudit('code_rejected', { code, reason: 'invalid or expired code' });
  showResult(false, `Manual code rejected: Code ${code} is invalid or expired.`);
  statusEl.textContent = '✗ Invalid or expired code.';
}

async function onStartScan() {
  state.scanMode = 'aggregate';
  startCamera((text) => handleAggregateScan(text));
}

async function handleAggregateScan(text) {
  const key = await db.getSharedKey();
  if (!key) {
    showResult(false, 'No shared key. Complete provisioning and pairing first.');
    return;
  }
  const res = await codec.verifySigned(key, text);
  if (!res.ok) {
    await db.appendAudit('attendance_rejected', { reason: res.reason });
    showResult(false, `Rejected: ${res.reason}`);
    return;
  }
  const p = res.payload;
  if (p.type !== 'aggregate' || !p.sessionId || !p.nonce || !p.ts || !Array.isArray(p.roster)) {
    await db.appendAudit('attendance_rejected', { reason: 'unexpected payload shape' });
    showResult(false, 'Rejected: payload does not match the aggregate format.');
    return;
  }
  const skew = Math.abs(codec.nowSeconds() - p.ts);
  const maxSkew = 300; // freshness window (s)
  if (skew > maxSkew) {
    await db.appendAudit('attendance_rejected', { reason: `stale payload (${skew}s old)`, sessionId: p.sessionId });
    showResult(false, `Rejected: stale payload (${skew}s old).`);
    return;
  }
  const seen = seenNonces();
  if (seen.has(p.nonce)) {
    await db.appendAudit('attendance_rejected', { reason: 'replayed nonce', sessionId: p.sessionId });
    showResult(false, 'Rejected: this payload was already accepted (replay).');
    return;
  }
  seen.add(p.nonce);
  localStorage.setItem('oqa.seenNonces', JSON.stringify([...seen]));
  await db.store.put('attendance', { sessionId: p.sessionId, ts: p.ts, roster: p.roster, verified: true, receivedAt: Date.now() });
  await db.appendAudit('attendance_committed', { sessionId: p.sessionId, present: p.roster.length });
  showResult(true, `Verified & committed · ${p.roster.length} present · session ${p.sessionId}`);
  stopCamera();
}

function seenNonces() {
  try {
    return new Set(JSON.parse(localStorage.getItem('oqa.seenNonces') || '[]'));
  } catch {
    return new Set();
  }
}

function showResult(ok, html) {
  const panel = $('result-panel');
  panel.className = `result ${ok ? 'ok' : 'fail'}`;
  panel.innerHTML = `<strong>${ok ? 'Accepted' : 'Rejected'}</strong><br/>${html}`;
}

/* ---- Camera --------------------------------------------------------------- */

async function startCamera(onDecode) {
  if (state.scanning) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch {
    showResult(false, 'Camera unavailable or permission denied.');
    return;
  }
  const video = $('scanner-video');
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  video.classList.remove('hidden');
  $('btn-start-scan').classList.add('hidden');
  $('btn-stop-scan').classList.remove('hidden');
  $('scan-status').textContent = 'Scanning… point the camera at the QR.';
  state.scanning = true;
  state.lastDecode = '';

  const tick = () => {
    if (!state.scanning) return;
    const text = decodeVideoFrame(video, $('scanner-frame'));
    if (text && text !== state.lastDecode) {
      state.lastDecode = text;
      onDecode(text);
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function stopCamera() {
  state.scanning = false;
  cancelAnimationFrame(state.raf);
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  const video = $('scanner-video');
  if (video) video.classList.add('hidden');
  const startBtn = $('btn-start-scan');
  const stopBtn = $('btn-stop-scan');
  if (startBtn) startBtn.classList.remove('hidden');
  if (stopBtn) stopBtn.classList.add('hidden');
}

/* ---- Audit ----------------------------------------------------------------- */

async function renderAudit() {
  const tbody = $('audit-table').querySelector('tbody');
  tbody.innerHTML = '';
  const entries = (await db.store.getAll('audit')).sort((a, b) => b.seq - a.seq);
  entries.forEach((e) => {
    const tr = document.createElement('tr');
    const details = typeof e.details === 'object' ? JSON.stringify(e.details) : e.details;
    tr.innerHTML = `<td>${e.seq}</td><td>${e.eventType}</td><td>${new Date(e.ts).toLocaleString()}</td><td>${details}</td>`;
    tbody.appendChild(tr);
  });
  $('integrity-status').textContent = '';
}

async function onIntegrity() {
  const breaks = await db.integrityScan();
  $('integrity-status').textContent = breaks.length
    ? `⚠ Chain broken at ${breaks.length} entr${breaks.length > 1 ? 'ies' : 'y'}: seq ${breaks.map((b) => b.seq).join(', ')}`
    : '✓ Audit chain intact — no tampering detected.';
}

async function onReset() {
  if (!confirm('Erase all local data (roster, keys, sessions, attendance, audit)?')) return;
  await db.wipeAll();
  localStorage.removeItem('oqa.seenNonces');
  location.reload();
}

/* ---- Boot ------------------------------------------------------------------ */

function bindEvents() {
  $('btn-role-lecturer').addEventListener('click', () => selectRole('lecturer'));
  $('btn-role-captain').addEventListener('click', () => selectRole('captain'));
  $('btn-import-roster').addEventListener('click', onImportRoster);
  $('btn-gen-key').addEventListener('click', onGenerateKey);
  $('btn-scan-pairing').addEventListener('click', onScanPairing);
  $('btn-key-paste').addEventListener('click', onPasteKey);
  $('btn-goto-workspace').addEventListener('click', () => (state.role === 'captain' ? enterCaptain() : enterLecturer()));
  $('btn-new-session').addEventListener('click', onCreateSession);
  $('btn-render-aggregate').addEventListener('click', onRenderAggregate);
  $('btn-start-scan').addEventListener('click', onStartScan);
  $('btn-stop-scan').addEventListener('click', stopCamera);
  $('btn-verify-code').addEventListener('click', onVerifyCode);
  $('btn-captain-audit').addEventListener('click', () => { renderAudit(); show('audit'); });
  $('btn-lecturer-audit').addEventListener('click', () => { renderAudit(); show('audit'); });
  $('btn-captain-back').addEventListener('click', () => show('setup'));
  $('btn-lecturer-back').addEventListener('click', () => show('setup'));
  $('btn-refresh-audit').addEventListener('click', renderAudit);
  $('btn-integrity').addEventListener('click', onIntegrity);
  $('btn-goto-home').addEventListener('click', () => { show('home'); refreshStatus(); });
  $('btn-reset').addEventListener('click', onReset);
}

async function boot() {
  if (!('crypto' in globalThis && crypto.subtle)) {
    alert('This app needs a secure context (WebCrypto). Serve via https:// or http://localhost.');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  try {
    await db.open();
  } catch (err) {
    console.error('Failed to open IndexedDB:', err);
    alert(`Storage could not be initialised: ${err && err.message ? err.message : err}`);
    return;
  }
  bindEvents();
  show('home');
  await refreshStatus();
}

boot();
