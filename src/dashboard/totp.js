// Optional two-factor sign-in for the dashboard: TOTP (RFC 6238; SHA-1, 30 s, 6 digits, the
// defaults every authenticator app uses). Off unless you enroll from the Sessions panel.
// The secret lives in the state dir (mode 600) and is only ever shown during setup.
// A code is accepted once (replay protection) and within one step either side of now.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '../config.js';

export const STEP = 30;
export const DIGITS = 6;
export const totpFile = () => join(stateDir(), 'dashboard', 'totp.json');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

// RFC 4226 HOTP for counter `step`.
export function hotp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}
export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
export const totp = (secret, ms = Date.now()) => hotp(secret, stepAt(ms));

// The matching step for code (window ±1) that is newer than lastStep, or null.
export function matchStep(secret, code, { now = Date.now(), lastStep = -1, window = 1 } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepAt(now);
  let found = null;
  for (let s = cur - window; s <= cur + window; s++) {
    const ok = timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(c));
    if (ok && s > lastStep && found === null) found = s;
  }
  return found;
}

export const otpauthUri = (secret, label = 'dashboard') =>
  `otpauth://totp/${encodeURIComponent(`burrow:${label}`)}?secret=${secret}&issuer=burrow&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

export function readTotp() {
  try { return JSON.parse(readFileSync(totpFile(), 'utf8')); } catch { return {}; }
}
function writeTotp(st) {
  if (!st.secret && !st.pending) { rmSync(totpFile(), { force: true }); return; }
  mkdirSync(dirname(totpFile()), { recursive: true, mode: 0o700 });
  writeFileSync(totpFile(), JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
}
export const totpEnabled = () => !!readTotp().enabled;

// Setup: a new pending secret (not active until confirmed with a code). Refused while enabled.
export function beginSetup(label) {
  const st = readTotp();
  if (st.enabled) throw new Error('two-factor sign-in is already on; turn it off first');
  const secret = newSecret();
  writeTotp({ pending: { secret, createdAt: Date.now() } });
  return { secret, uri: otpauthUri(secret, label) };
}
export function confirmSetup(code, now = Date.now()) {
  const st = readTotp();
  if (st.enabled) throw new Error('two-factor sign-in is already on');
  if (!st.pending?.secret || now - st.pending.createdAt > 15 * 60 * 1000) throw new Error('start the setup again (it expires after 15 minutes)');
  const step = matchStep(st.pending.secret, code, { now });
  if (step === null) return false;
  writeTotp({ enabled: true, secret: st.pending.secret, lastStep: step, enabledAt: now });
  return true;
}
// Sign-in and turning it off: a current code that wasn't used before.
export function verifyCode(code, now = Date.now()) {
  const st = readTotp();
  if (!st.enabled) return true;
  const step = matchStep(st.secret, code, { now, lastStep: st.lastStep ?? -1 });
  if (step === null) return false;
  writeTotp({ ...st, lastStep: step });
  return true;
}
export function disable() { writeTotp({}); }
