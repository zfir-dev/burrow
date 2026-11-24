import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { ErrorCode, ProtocolError, validateOpArgs } from './protocol.js';
import { serveFolder } from './static-server.js';
import { policyFile, stateDir } from './paths.js';

// Local policy (~/.config/burrow/ai/policy.json), on top of the server's guardrails:
//   { "folderRoots": ["/home/me/sites"], "denyPorts": [5432], "allowPorts": [3000, 5173] }
export function loadLocalPolicy(env = process.env) {
  const file = policyFile(env);
  const home = env.HOME || homedir();
  const p = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    folderRoots: (p.folderRoots || [home]).map((r) => (existsSync(r) ? realpathSync(r) : r)),
    home: existsSync(home) ? realpathSync(home) : home,
    denyPorts: p.denyPorts || [22, 5432, 3306, 6379, 27017, 7070],
    allowPorts: p.allowPorts || null,
  };
}

// Executes the protocol's operations, and nothing else. Every exposure it creates is
// recorded in exposures.json; status/logs/stop only act on names recorded there, so the
// server can't touch tunnels or shares the user made by hand.
export class Executor {
  constructor({ burrow, env = process.env, policy = loadLocalPolicy(env), log = () => {} }) {
    this.burrow = burrow;
    this.policy = policy;
    this.log = log;
    this.dir = stateDir(env);
    this.file = join(this.dir, 'exposures.json');
    this.servers = new Map(); // name -> static server
    this.busy = new Set();
    this.exposures = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }

  #save() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.exposures, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  // After a restart, folder exposures need their static server again on the same port
  // (the burrow share still points at it).
  async restore() {
    for (const [name, e] of Object.entries(this.exposures)) {
      if (e.kind !== 'folder' || this.servers.has(name)) continue;
      try {
        this.servers.set(name, await serveFolder(this.#checkFolder(e.folder), { port: e.port }));
      } catch (err) {
        this.log('restore_failed', { name, error: err.message });
      }
    }
  }

  list() {
    return Object.entries(this.exposures).map(([name, e]) => ({ name, url: e.url, kind: e.kind, port: e.port }));
  }

  async handle(op, rawArgs) {
    const args = validateOpArgs(op, rawArgs);
    switch (op) {
      case 'list': return { exposures: this.list() };
      case 'expose': return this.#locked(args.name, () => this.#expose(args));
      case 'status': return { name: args.name, ...this.#entry(args.name, true), ...(await this.burrow.status(args.name)) };
      case 'logs': this.#entry(args.name); return { name: args.name, lines: await this.burrow.logs(args.name, args.lines) };
      case 'stop': return this.#locked(args.name, () => this.#stop(args.name));
      default: throw new ProtocolError(ErrorCode.INVALID_ARGUMENT, `unknown operation "${op}"`);
    }
  }

  async #locked(name, fn) {
    if (this.busy.has(name)) throw new ProtocolError(ErrorCode.NAME_TAKEN, `"${name}" is busy with another operation`);
    this.busy.add(name);
    try { return await fn(); } finally { this.busy.delete(name); }
  }

  #entry(name, view = false) {
    const e = this.exposures[name];
    if (!e) throw new ProtocolError(ErrorCode.TUNNEL_NOT_FOUND, `this device has no burrow-ai tunnel named "${name}"`);
    return view ? { url: e.url, kind: e.kind, port: e.port } : e;
  }

  #checkPort(port) {
    const p = this.policy;
    if (p.denyPorts.includes(port) || (p.allowPorts && !p.allowPorts.includes(port))) {
      throw new ProtocolError(ErrorCode.PORT_NOT_ALLOWED, `port ${port} is blocked by this device's burrow ai policy.json`);
    }
  }

  #checkFolder(folder) {
    if (!isAbsolute(folder)) throw new ProtocolError(ErrorCode.INVALID_ARGUMENT, 'folder must be an absolute path');
    let real;
    try { real = realpathSync(folder); } catch { throw new ProtocolError(ErrorCode.INVALID_ARGUMENT, `folder ${folder} does not exist`); }
    if (!statSync(real).isDirectory()) throw new ProtocolError(ErrorCode.INVALID_ARGUMENT, `${folder} is not a folder`);
    const root = this.policy.folderRoots.find((r) => real === r || real.startsWith(r + sep));
    if (!root) throw new ProtocolError(ErrorCode.NOT_ALLOWED, `folder ${folder} is outside the allowed roots (${this.policy.folderRoots.join(', ')}); edit policy.json to allow it`);
    if (real === this.policy.home) throw new ProtocolError(ErrorCode.NOT_ALLOWED, 'refusing to serve the whole home folder');
    if (relative(root, real).split(sep).some((seg) => seg.startsWith('.'))) throw new ProtocolError(ErrorCode.NOT_ALLOWED, 'refusing to serve a hidden folder');
    return real;
  }

  async #expose({ name, port, folder }) {
    if (this.exposures[name]) throw new ProtocolError(ErrorCode.NAME_TAKEN, `this device already has a tunnel named "${name}"`);
    let server = null;
    let localPort = port;
    if (folder !== undefined) {
      const real = this.#checkFolder(folder);
      server = await serveFolder(real);
      localPort = server.port;
      folder = real;
    } else {
      this.#checkPort(port);
    }
    try {
      const r = await this.burrow.share(name, localPort);
      this.exposures[name] = { kind: folder !== undefined ? 'folder' : 'port', port: localPort, folder, url: r.url, project: r.project, createdAt: new Date().toISOString() };
      this.#save();
      if (server) this.servers.set(name, server);
      this.log('exposed', { name, url: r.url });
      return { url: r.url, hostname: r.hostname, project: r.project, target: `http://localhost:${localPort}` };
    } catch (e) {
      await server?.close();
      throw e;
    }
  }

  async #stop(name) {
    this.#entry(name);
    await this.burrow.stop(name);
    await this.servers.get(name)?.close();
    this.servers.delete(name);
    delete this.exposures[name];
    this.#save();
    this.log('stopped', { name });
    return { name, stopped: true };
  }

  async close() {
    for (const s of this.servers.values()) await s.close();
    this.servers.clear();
  }
}
