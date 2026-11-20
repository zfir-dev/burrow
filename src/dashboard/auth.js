import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;

// Constant-time password check. Both sides are hashed first so the compare
// never leaks length and timingSafeEqual always gets equal-sized buffers.
export function passwordMatches(given, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const a = createHash('sha256').update(String(given ?? ''), 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// Signing key = HMAC(per-process secret, password): restarting the server or
// changing the password invalidates every session.
export function sessionKey(secret, password) {
  return createHmac('sha256', secret).update(`burrow-session\0${password}`).digest();
}

const mac = (key, body) => createHmac('sha256', key).update(body).digest();

export function signSession(key, ttlMs, now = Date.now()) {
  const exp = now + ttlMs;
  const id = randomBytes(18).toString('base64url');
  const body = `${exp}.${id}`;
  return { value: `${body}.${mac(key, body).toString('base64url')}`, id, exp };
}

// Returns the session id when the cookie is authentic and unexpired, else null.
export function verifySession(key, value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [exp, id, sig] = parts;
  if (!/^\d+$/.test(exp) || !/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = mac(key, `${exp}.${id}`);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return Number(exp) > now ? id : null;
}

// Fixed-window limiter for login attempts, keyed by client IP.
export class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  check(key, now = Date.now()) {
    const e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) return { allowed: true, retryAfter: 0 };
    if (e.count >= this.max) return { allowed: false, retryAfter: Math.ceil((e.start + this.windowMs - now) / 1000) };
    return { allowed: true, retryAfter: 0 };
  }
  fail(key, now = Date.now()) {
    const e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) this.hits.set(key, { start: now, count: 1 });
    else e.count++;
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    }
  }
  reset(key) {
    this.hits.delete(key);
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const newSecret = () => randomBytes(32);
