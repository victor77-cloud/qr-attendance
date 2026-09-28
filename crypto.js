/* Cryptographic module — built on WebCrypto (SubtleCrypto).
 * Supplies HMAC-SHA256 sign/verify, HKDF session-key derivation, TOTP
 * derivation, constant-time comparison and byte/base64 helpers.
 * Runs entirely on-device; nothing here touches the network.
 */
const te = new TextEncoder();
const td = new TextDecoder();

export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return te.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('Expected string, Uint8Array or ArrayBuffer');
}

export function randomBytes(n = 32) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', toBytes(data));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacSign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, toBytes(data));
  return new Uint8Array(sig);
}

export async function hmacVerify(secret, data, tag) {
  const key = await hmacKey(secret);
  return crypto.subtle.verify('HMAC', key, toBytes(tag), toBytes(data));
}

/* HKDF-SHA256: derive `length` bytes from an input key material + info. */
export async function hkdf(ikm, info, length = 32) {
  const key = await crypto.subtle.importKey('raw', toBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: toBytes(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

/* RFC 4226 dynamic truncation of an HMAC-SHA256 output. */
export function dynamicTruncate(hmac) {
  const b = toBytes(hmac);
  const offset = b[b.length - 1] & 0x0f;
  const bin =
    ((b[offset] & 0x7f) << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

/* TOTP-style code for a 64-bit counter. Used for per-session codes. */
export async function totp(secret, counter) {
  const key = await hmacKey(secret);
  let c = BigInt(Math.floor(counter));
  const cbuf = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    cbuf[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, cbuf));
  return dynamicTruncate(hmac);
}

/* Session TOTP and Student Check-in Code helpers */

export async function getSessionTOTP(sharedKey, sessionId, timestampInSeconds = Math.floor(Date.now() / 1000)) {
  const Ks = await hkdf(sharedKey, sessionId, 32);
  const counter = Math.floor(timestampInSeconds / 30);
  return totp(Ks, counter);
}

export async function verifySessionTOTP(
  sharedKey,
  sessionId,
  code,
  timestampInSeconds = Math.floor(Date.now() / 1000),
  allowedSkew = 1
) {
  if (typeof code !== 'string') return false;
  const Ks = await hkdf(sharedKey, sessionId, 32);
  const baseCounter = Math.floor(timestampInSeconds / 30);
  for (let skew = -allowedSkew; skew <= allowedSkew; skew++) {
    const expected = await totp(Ks, baseCounter + skew);
    if (constantTimeEqual(code.trim(), expected)) {
      return true;
    }
  }
  return false;
}

export async function getStudentCheckInCode(
  verificationToken,
  sessionNonce,
  timestampInSeconds = Math.floor(Date.now() / 1000)
) {
  const Kstudent = await hkdf(verificationToken, sessionNonce, 32);
  const counter = Math.floor(timestampInSeconds / 30);
  return totp(Kstudent, counter);
}

export async function verifyStudentCheckInCode(
  verificationToken,
  sessionNonce,
  code,
  timestampInSeconds = Math.floor(Date.now() / 1000),
  allowedSkew = 1
) {
  if (typeof code !== 'string') return false;
  const Kstudent = await hkdf(verificationToken, sessionNonce, 32);
  const baseCounter = Math.floor(timestampInSeconds / 30);
  for (let skew = -allowedSkew; skew <= allowedSkew; skew++) {
    const expected = await totp(Kstudent, baseCounter + skew);
    if (constantTimeEqual(code.trim(), expected)) {
      return true;
    }
  }
  return false;
}

/* Constant-time comparison to avoid timing side channels. */
export function constantTimeEqual(a, b) {
  const x = toBytes(a);
  const y = toBytes(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function bytesToB64(bytes) {
  let bin = '';
  for (const b of toBytes(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return [...toBytes(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function utf8Decode(bytes) {
  return td.decode(toBytes(bytes));
}
