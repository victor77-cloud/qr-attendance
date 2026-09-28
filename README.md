# Offline QR Attendance PWA

A **purely offline** QR attendance progressive web app, built to two hard constraints:

1. **No server of any kind** — the app is fully client-side. A service worker serves the shell from cache; IndexedDB holds all state.
2. **QR scan-to-transfer is the only device-to-device channel** — no Wi-Fi Direct, Bluetooth, WebRTC, or NFC.

Two identical PWA instances act as peers. The **class captain** marks present students and renders a signed aggregate QR; the **lecturer** scans it, verifies the HMAC locally, and commits the record.

> Full specification, design, and threat model: [`docs/Offline_QR_Attendance_PWA.md`](docs/Offline_QR_Attendance_PWA.md).
> FoC report draft (Chapters 3 & 4): [`docs/Chapter_3_and_4_Draft.md`](docs/Chapter_3_and_4_Draft.md).

## Architecture

```
service worker (cache-first shell)
        │
┌───────┴───────────────────────────────────────────┐
│  captain workflow      lecturer workflow          │
│   create session         scan aggregate QR        │
│   mark present           verify signature locally │
│   sign + render QR       commit attendance        │
├───────────────────────────────────────────────────┤
│  crypto (WebCrypto): HMAC-SHA256 · HKDF · TOTP    │
│  codec: canonical serialisation · QR framing      │
│  storage: IndexedDB (roster/session/attendance/   │
│            keys/audit hash-chain)                 │
└───────────────────────────────────────────────────┘
        │
   QR scan-to-transfer (the only cross-device link)
```

## Getting started

Requires a modern browser with **Service Worker, IndexedDB, WebCrypto, and camera**. Camera and WebCrypto need a secure context — use `http://localhost` or HTTPS.

```bash
npm start            # static server → http://localhost:8080
```

Open the app on **two devices** (or two browser profiles) and provision once, in person:

1. **Lecturer** → *I am the Lecturer* → generate & display the pairing QR.
2. **Captain** → *I am the Class Captain* → scan the pairing QR (or paste the base64 key).
3. **Both**: import the class roster (`id,name` per line).
4. **Captain**: create a session → tick present students → **Render aggregate QR**.
5. **Lecturer**: **Start camera scan** → point at the QR → verified record is committed and audited.

After this one-time provisioning the app never needs the network again.

## Security model (summary)

- **Integrity**: aggregate payload signed with HMAC-SHA256 under a shared key; lecturer verifies locally.
- **Freshness**: timestamp + time-bound window; replay rejected via a seen-nonce set.
- **Tamper evidence**: audit store is a hash-chained, append-only log — run *Audit → Integrity scan* to detect edits.
- **Honest-threat boundary**: a valid signature proves a key holder produced the payload; it cannot stop a dishonest captain. The captain is a trusted role (classroom trust).

## Repository layout

```
index.html          app shell (role-based views)
manifest.webmanifest PWA manifest
sw.js               service worker (precache + cache-first)
server.js           tiny static server for local dev
css/                styles
js/
  crypto.js         HMAC/HKDF/TOTP, constant-time compare, b64
  codec.js          canonical serialisation, aggregate sign/verify, framing
  db.js             IndexedDB wrapper (5 stores) + audit hash chain
  qr.js             QR encode/decode wrappers
  app.js            role workflows + UI glue
vendor/             vendored UMD libs (qrcode-generator, jsQR) — fully offline
docs/               technical report + FoC chapter drafts + diagram sources
TASKS.md            scoped implementation tasks (next steps)
```

## Status

This is a **working scaffold**: core crypto, codec, storage, service worker, and the captain→lecturer aggregate flow are implemented. Remaining polish and extensions are tracked in [`TASKS.md`](TASKS.md).
