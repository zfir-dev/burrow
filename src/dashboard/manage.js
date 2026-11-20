import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, stateDir } from '../config.js';
import { isAlive, runningPid, stopConnector } from '../process.js';
import { DASHBOARD_PROJECT, dashboardProject } from '../project.js';
import { hostnameFor } from '../naming.js';
import { MIN_PASSWORD_LENGTH } from './auth.js';
import { runDashboard } from './server.js';
import * as commands from '../commands.js';

const BIN = fileURLToPath(new URL('../../bin/burrow.js', import.meta.url));
// Lives in a subdirectory so it is never mistaken for a project pid file.
const dir = () => join(stateDir(), 'dashboard');
export const serverPidFile = () => join(dir(), 'server.pid');
export const serverLogFile = () => join(dir(), 'server.log');

const log = (...a) => console.log(...a);
const portOf = (opts, cfg) => {
  const port = parseInt(opts.port || cfg.dashboardPort, 10);
  if (!(port > 0 && port < 65536)) throw new Error(`Invalid dashboard port "${opts.port || cfg.dashboardPort}"`);
  return port;
};

export function serverPid() {
  try {
    const pid = parseInt(readFileSync(serverPidFile(), 'utf8'), 10);
    return isAlive(pid, 'burrow') ? pid : null;
  } catch {
    return null;
  }
}

function requirePassword(cfg) {
  if (!cfg.dashboardPassword || cfg.dashboardPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Set BURROW_DASHBOARD_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) in ${cfg.path} first.`
    );
  }
}

export async function foreground(opts) {
  const cfg = loadConfig();
  requirePassword(cfg);
  await runDashboard({ port: portOf(opts, cfg), host: opts.host || '127.0.0.1' });
}

export async function up(opts) {
  const cfg = loadConfig();
  const port = portOf(opts, cfg);
  const host = opts.host || '127.0.0.1';
  const dry = !!opts.dryRun;
  if (!dry) requirePassword(cfg);
  const pid = serverPid();
  if (dry) {
    log(`[dry-run] ${pid ? `dashboard already running (pid ${pid})` : `would start dashboard on http://${host}:${port}, log ${serverLogFile()}`}`);
  } else if (pid) {
    log(`Dashboard already running (pid ${pid})`);
  } else {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const out = openSync(serverLogFile(), 'a', 0o600);
    const child = spawn(process.execPath, [BIN, 'dashboard', '--port', String(port), '--host', host], {
      detached: true, stdio: ['ignore', out, out], env: process.env,
    });
    closeSync(out);
    child.unref();
    writeFileSync(serverPidFile(), String(child.pid), { mode: 0o600 });
    await new Promise((r) => setTimeout(r, 800));
    if (!isAlive(child.pid, 'burrow')) {
      rmSync(serverPidFile(), { force: true });
      throw new Error(`Dashboard exited right away; see ${serverLogFile()}`);
    }
    log(`Dashboard started on http://${host}:${port} (pid ${child.pid}), log ${serverLogFile()}`);
  }
  if (opts.tunnel === false) return;
  await commands.up(DASHBOARD_PROJECT, { dryRun: dry });
}

export async function down() {
  const pid = serverPid();
  if (pid) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 25 && isAlive(pid, 'burrow'); i++) await new Promise((r) => setTimeout(r, 200));
    if (isAlive(pid, 'burrow')) process.kill(pid, 'SIGKILL');
    log(`Dashboard stopped (pid ${pid})`);
  } else log('Dashboard was not running');
  rmSync(serverPidFile(), { force: true });
  const c = await stopConnector(DASHBOARD_PROJECT);
  log(c ? `Dashboard tunnel connector stopped (pid ${c})` : 'Dashboard tunnel connector was not running');
}

export function status() {
  const cfg = loadConfig();
  const pid = serverPid();
  log(`Server: ${pid ? `running (pid ${pid}) on port ${cfg.dashboardPort}` : 'stopped'}`);
  const c = runningPid(DASHBOARD_PROJECT);
  log(`Tunnel connector: ${c ? `running (pid ${c})` : 'stopped'}`);
  if (cfg.domain) log(`URL: https://${hostnameFor(DASHBOARD_PROJECT, dashboardProject(cfg.dashboardPort).services[0], cfg.domain)}`);
  log(`Password: ${cfg.dashboardPassword ? 'set' : 'NOT set (BURROW_DASHBOARD_PASSWORD)'}`);
  if (existsSync(serverLogFile())) log(`Log: ${serverLogFile()}`);
}
