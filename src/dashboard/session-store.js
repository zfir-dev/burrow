// Dashboard sessions that survive a restart: the signing secret and the server-side session
// list are kept in <state>/dashboard/sessions.json (mode 600, directory 700). Cookies are still
// signed with HMAC(secret, password), so changing the password ends every session; expired
// sessions are dropped on load and on save; signing out (one, others, everywhere) is saved
// straight away. Deleting the file ends every session at the next restart.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '../config.js';

export const sessionsFile = () => join(stateDir(), 'dashboard', 'sessions.json');
const TOUCH_MS = 5 * 60 * 1000; // lastSeen changes are saved at most this often

export function openSessionStore({ file = sessionsFile(), now = Date.now } = {}) {
  let data = null;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  let secret = null;
  try { secret = Buffer.from(String(data?.secret || ''), 'base64'); } catch {}
  const fresh = !secret || secret.length < 32;
  if (fresh) secret = randomBytes(32);
  const loaded = new Map();
  if (!fresh && data?.sessions && typeof data.sessions === 'object') {
    for (const [id, s] of Object.entries(data.sessions)) {
      if (/^[A-Za-z0-9_-]+$/.test(id) && Number(s?.exp) > now()) loaded.set(id, { exp: Number(s.exp), info: s.info && typeof s.info === 'object' ? s.info : {} });
    }
  }
  let savedAt = 0;
  const save = (sessions, info) => {
    const t = now();
    const out = {};
    for (const [id, exp] of sessions) if (exp > t) out[id] = { exp, info: info.get(id) || {} };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ secret: secret.toString('base64'), sessions: out }) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    savedAt = t;
  };
  if (fresh) save(new Map(), new Map()); // keep the new secret, so the next restart reuses it
  return {
    secret,
    sessions: loaded,
    save,
    // For lastSeen updates: save only when the last save is old enough.
    touch: (sessions, info) => { if (now() - savedAt >= TOUCH_MS) save(sessions, info); },
  };
}
