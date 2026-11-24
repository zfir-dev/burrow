import { existsSync, readFileSync } from 'node:fs';
import { ErrorCode, ProtocolError, shareProject } from './protocol.js';
import { share, removeShare, isShare } from '../share.js';
import { statusJson } from '../commands.js';
import { logFile, readMeta, stopConnector } from '../process.js';
import { recordEvent } from '../history.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const BURROW_VERSION = pkg.version;

// The burrow operations burrow ai connect runs, called in-process (no child `burrow`).
// Each exposure is a burrow share named share-<name>: its own tunnel and hostname
// <name>.<domain>, removed completely (tunnel, DNS, state) on stop. Cloudflare
// credentials stay in burrow's config.env and never leave this machine.
export class LocalBurrow {
  version() { return BURROW_VERSION; }

  // -> { url, hostname, project }
  async share(name, port) {
    const project = shareProject(name);
    try {
      const r = await share(String(port), { name, detach: true, log: () => {} });
      if (!r?.hostname) throw new ProtocolError(ErrorCode.BURROW_ERROR, 'burrow share did not return a hostname');
      recordEvent({ action: 'share', project: `share ${name}`, source: 'cli', detail: `burrow ai: port ${port}` });
      return { url: r.url.toLowerCase(), hostname: r.hostname.toLowerCase(), project };
    } catch (e) { throw toError(e); }
  }

  async status(name) {
    let s;
    try { s = await statusJson(shareProject(name)); } catch (e) { throw toError(e); }
    return {
      running: !!s.running,
      pid: s.pid ?? null,
      tunnel: s.tunnel ? { status: s.tunnel.status ?? 'unknown', connections: Array.isArray(s.tunnel.connections) ? s.tunnel.connections.length : 0 } : null,
      hostnames: s.records.map((r) => r.name),
    };
  }

  async logs(name, lines) {
    const file = logFile(shareProject(name));
    if (!existsSync(file)) throw new ProtocolError(ErrorCode.TUNNEL_NOT_FOUND, `no log for "${name}" on this device`);
    return redact(readFileSync(file, 'utf8')).split('\n').filter((l) => l.length).slice(-lines);
  }

  // Only ever one share-<name>; never a bare "down" (that would stop every project).
  async stop(name) {
    const project = shareProject(name);
    try {
      if (!readMeta(project)) { await stopConnector(project); return; } // already gone (expired or removed by hand)
      if (!isShare(project)) throw new ProtocolError(ErrorCode.NOT_ALLOWED, `${project} is not a share; refusing to touch it`);
      await removeShare(project);
      recordEvent({ action: 'down', project, source: 'cli', detail: 'burrow ai' });
    } catch (e) { throw toError(e); }
  }
}

export function toError(e) {
  if (e instanceof ProtocolError) return e;
  const msg = redact(String(e?.message || e || 'burrow failed')).slice(-2000);
  if (/already exists|already has DNS records/i.test(msg)) return new ProtocolError(ErrorCode.NAME_TAKEN, `hostname is already in use: ${msg}`);
  return new ProtocolError(ErrorCode.BURROW_ERROR, msg);
}

// Strip anything that looks like a token (JWT-ish or long base64) from text sent upstream.
export function redact(text) {
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '[redacted]')
    .replace(/(token|secret|password|authorization)(["'\s:=]+)[^\s"',]+/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted]');
}
