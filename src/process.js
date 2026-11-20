import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';

export const pidFile = (project) => join(stateDir(), `${project}.pid`);
export const logFile = (project) => join(stateDir(), `${project}.log`);
export const metaFile = (project) => join(stateDir(), `${project}.json`);

export function readPid(project) {
  const f = pidFile(project);
  if (!existsSync(f)) return null;
  const pid = parseInt(readFileSync(f, 'utf8'), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('cloudflared');
  } catch {
    return true; // no /proc (macOS): trust kill(0)
  }
}

export function runningPid(project) {
  const pid = readPid(project);
  return isAlive(pid) ? pid : null;
}

// Starts cloudflared detached. The tunnel token goes through the TUNNEL_TOKEN
// env var so it never shows in `ps` output or on disk.
export function startConnector(project, token, bin = 'cloudflared') {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const log = openSync(logFile(project), 'a', 0o600);
  const child = spawn(bin, ['tunnel', '--no-autoupdate', 'run'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, TUNNEL_TOKEN: token },
  });
  closeSync(log);
  child.on('error', () => {});
  child.unref();
  if (!child.pid) throw new Error(`Could not start ${bin}. Is cloudflared installed?`);
  writeFileSync(pidFile(project), String(child.pid), { mode: 0o600 });
  return child.pid;
}

export async function stopConnector(project, timeoutMs = 10000) {
  const pid = readPid(project);
  if (!isAlive(pid)) {
    rmSync(pidFile(project), { force: true });
    return null;
  }
  process.kill(pid, 'SIGTERM');
  const start = Date.now();
  while (isAlive(pid) && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 200));
  if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(pidFile(project), { force: true });
  return pid;
}

export function saveMeta(project, meta) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(metaFile(project), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
}
export function readMeta(project) {
  try { return JSON.parse(readFileSync(metaFile(project), 'utf8')); } catch { return null; }
}
export function removeMeta(project) {
  rmSync(metaFile(project), { force: true });
}

// Projects that have a pid file in the state dir (running or stale).
export function localProjects() {
  try {
    return readdirSync(stateDir()).filter((f) => f.endsWith('.pid')).map((f) => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
}
