/* Persistence layer — thin promise wrapper over IndexedDB.
 * Five object stores: roster, sessions, attendance, keys, audit.
 * The audit store is a hash chain: every entry carries the hash of the
 * previous entry, giving it its tamper-evident property.
 */
import { sha256Hex, randomBytes, hex } from './crypto.js';
import { canonicalString } from './codec.js';

const DB_NAME = 'qr-attendance';
const DB_VERSION = 1;

let dbPromise = null;

export function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('roster')) {
          d.createObjectStore('roster', { keyPath: 'studentId' });
        }
        if (!d.objectStoreNames.contains('sessions')) {
          d.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
        if (!d.objectStoreNames.contains('attendance')) {
          const s = d.createObjectStore('attendance', { keyPath: 'id', autoIncrement: true });
          s.createIndex('bySession', 'sessionId');
        }
        if (!d.objectStoreNames.contains('keys')) {
          d.createObjectStore('keys', { keyPath: 'keyId' });
        }
        if (!d.objectStoreNames.contains('audit')) {
          d.createObjectStore('audit', { keyPath: 'seq', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function objectStore(name, mode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const store = {
  async put(name, value) {
    return requestToPromise((await objectStore(name, 'readwrite')).put(value));
  },
  async get(name, key) {
    return requestToPromise((await objectStore(name, 'readonly')).get(key));
  },
  async getAll(name) {
    return requestToPromise((await objectStore(name, 'readonly')).getAll());
  },
  async delete(name, key) {
    return requestToPromise((await objectStore(name, 'readwrite')).delete(key));
  },
  async clear(name) {
    return requestToPromise((await objectStore(name, 'readwrite')).clear());
  }
};

/* ---- Roster ------------------------------------------------------------- */

export async function importRoster(rows) {
  for (const { studentId, name } of rows) {
    const verificationToken = hex(randomBytes(16));
    await store.put('roster', { studentId: String(studentId).trim(), name: String(name).trim(), verificationToken });
  }
  await appendAudit('roster_imported', { count: rows.length });
}

export function parseRosterText(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const parts = line.split(/[,\t]/);
    if (parts.length >= 2) rows.push({ studentId: parts[0], name: parts.slice(1).join(' ').replace(/^"|"$/g, '') });
  }
  return rows;
}

/* ---- Keys --------------------------------------------------------------- */

export async function saveSharedKey(bytes) {
  const existing = await store.get('keys', 'shared');
  if (existing) throw new Error('A shared key already exists. Reset data to re-pair.');
  await store.put('keys', { keyId: 'shared', key: Array.from(bytes), createdAt: Date.now() });
  await appendAudit('key_stored', {});
}

export async function getSharedKey() {
  const rec = await store.get('keys', 'shared');
  return rec ? new Uint8Array(rec.key) : null;
}

/* ---- Sessions ----------------------------------------------------------- */

export async function createSession(sessionId, nonce, ts, expiryWindow) {
  await store.put('sessions', { sessionId, nonce, ts, expiryWindow });
  await appendAudit('session_created', { sessionId });
  return { sessionId, nonce, ts, expiryWindow };
}

/* ---- Audit (hash-chained) ----------------------------------------------- */

export async function appendAudit(eventType, details = {}) {
  const all = await store.getAll('audit');
  const prev = all.length ? all.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
  const prevHash = prev ? await entryHash(prev) : '0'.repeat(64);
  return store.put('audit', {
    eventType,
    details,
    ts: Date.now(),
    prevHash
  });
}

async function entryHash(entry) {
  const { seq, ...rest } = entry;
  return sha256Hex(canonicalString({ seq, ...rest }));
}

/* Returns [] if the chain is intact, else descriptions of the breaks. */
export async function integrityScan() {
  const all = (await store.getAll('audit')).sort((a, b) => a.seq - b.seq);
  const breaks = [];
  for (let i = 1; i < all.length; i += 1) {
    const expected = await entryHash(all[i - 1]);
    if (all[i].prevHash !== expected) {
      breaks.push({ seq: all[i].seq, expected, found: all[i].prevHash });
    }
  }
  return breaks;
}

export async function wipeAll() {
  for (const name of ['roster', 'sessions', 'attendance', 'keys', 'audit']) {
    await store.clear(name);
  }
}
