import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, rmSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { credentialsFile } from './paths.js';

// device.json: { server, deviceId, deviceName, deviceToken, pairedAt }, mode 600 in a 700 dir.
export function saveCredentials(creds, env = process.env) {
  const file = credentialsFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

export function loadCredentials(env = process.env) {
  const file = credentialsFile(env);
  if (!existsSync(file)) return null;
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (!c.server || !c.deviceToken || !c.deviceId) throw new Error(`${file} is incomplete; run "burrow ai login" again`);
  return c;
}

export function removeCredentials(env = process.env) {
  const file = credentialsFile(env);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
