import { hostname } from 'node:os';
import { saveCredentials } from './credentials.js';

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

export function serverUrl(server) {
  let base;
  try { base = new URL(server); } catch { throw new Error(`invalid server URL "${server}"`); }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOCAL.includes(base.hostname))) {
    throw new Error('the server URL must use https (http is only allowed for localhost)');
  }
  return base;
}

// Redeem a one-time pairing code (from the burrow-ai dashboard) for a long-lived device
// token and store it with mode 600.
export async function pair({ code, server, deviceName = hostname(), env = process.env, fetchImpl = fetch }) {
  const base = serverUrl(server);
  const res = await fetchImpl(new URL('/v1/pair', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim(), deviceName: String(deviceName).slice(0, 64) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`pairing failed (${res.status}): ${body?.error?.message || 'unknown error'}`);
  if (!body.deviceId || !body.deviceToken) throw new Error('pairing failed: the server did not return a device token');
  const creds = {
    server: base.origin, deviceId: body.deviceId, deviceName: body.deviceName, deviceToken: body.deviceToken, pairedAt: new Date().toISOString(),
  };
  const file = saveCredentials(creds, env);
  return { file, deviceId: body.deviceId, deviceName: body.deviceName, server: base.origin };
}
