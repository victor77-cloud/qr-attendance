/* Transfer codec — canonical serialisation + signed aggregate payloads.
 * Signer and verifier derive identical byte strings so the HMAC matches.
 * Aggregate payload: { v, type, sessionId, nonce, ts, roster } where roster
 * holds short hashes of present student identifiers.
 */
import { toBytes, hmacSign, hmacVerify, sha256Hex, bytesToB64, b64ToBytes, utf8Decode } from './crypto.js';

const VERSION = 1;
const TYPE_AGGREGATE = 'aggregate';
/* Prefix so a scanned payload is recognisable and versioned. */
export const PAYLOAD_PREFIX = 'OQA1:';
/* Rough byte budget per QR frame (version 40 binary). Frames stay well under. */
export const FRAME_CAPACITY = 2500;

/* Deterministic JSON: sort object keys recursively, preserve array order. */
export function canonicalString(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalString(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function serialize(obj) {
  return toBytes(canonicalString(obj));
}

export async function shortHash(id) {
  const h = await sha256Hex(id);
  return h.slice(0, 16);
}

export async function buildAggregate({ sessionId, nonce, ts, roster = [] }) {
  return {
    v: VERSION,
    type: TYPE_AGGREGATE,
    sessionId,
    nonce,
    ts,
    roster: await Promise.all(roster.map(shortHash))
  };
}

/* Returns a QR-safe signed text: "OQA1:<b64(canonical payload)>.<b64(tag)>" */
export async function signAggregate(secret, payload) {
  const body = canonicalString(payload);
  const tag = await hmacSign(secret, body);
  return `${PAYLOAD_PREFIX}${bytesToB64(toBytes(body))}.${bytesToB64(tag)}`;
}

/* Parse signed text back into { payload, tagB64 } or null if malformed. */
export function parseSigned(text) {
  if (typeof text !== 'string' || !text.startsWith(PAYLOAD_PREFIX)) return null;
  const inner = text.slice(PAYLOAD_PREFIX.length);
  const dot = inner.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    const body = utf8Decode(b64ToBytes(inner.slice(0, dot)));
    const payload = JSON.parse(body);
    const tag = b64ToBytes(inner.slice(dot + 1));
    return { payload, tag };
  } catch {
    return null;
  }
}

/* Verify signature over the canonical serialisation of the parsed payload. */
export async function verifySigned(secret, text) {
  const parsed = parseSigned(text);
  if (!parsed) return { ok: false, reason: 'malformed payload' };
  const body = canonicalString(parsed.payload);
  const ok = await hmacVerify(secret, body, parsed.tag);
  return ok
    ? { ok: true, payload: parsed.payload }
    : { ok: false, reason: 'signature mismatch' };
}

/* Split a large roster into chained frames, each a signed aggregate for a
 * slice, with index/total fields so the receiver can reassemble. */
export async function chunkRoster(secret, base, roster, capacity = FRAME_CAPACITY) {
  const chunks = [];
  const sliceCount = Math.max(1, Math.ceil(roster.length / Math.max(1, Math.floor(capacity / 20))));
  for (let i = 0; i < sliceCount; i += 1) {
    const slice = roster.slice(Math.floor((roster.length * i) / sliceCount), Math.floor((roster.length * (i + 1)) / sliceCount));
    const payload = { ...base, idx: i, total: sliceCount, roster: await Promise.all(slice.map(shortHash)) };
    chunks.push(await signAggregate(secret, payload));
  }
  return chunks;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
