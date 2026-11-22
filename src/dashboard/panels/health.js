// Panel: local port health. A dot per hostname shows whether the local port behind it
// answers, so a dead app (port closed) is told apart from a dead tunnel (cloudflared
// stopped, or no Cloudflare connections). Reuses the TCP checks of `burrow watch`.
import { existsSync, readdirSync } from 'node:fs';
import { stateDir } from '../../config.js';
import { hostnames, loadProjectFile, DASHBOARD_PROJECT, dashboardProject } from '../../project.js';
import { readMeta, localProjects } from '../../process.js';
import { localTargets, tcpOpen } from '../../watch.js';

export const order = 20;
const CACHE_MS = 3000;
let cache = { at: 0, data: null };

function projectFor(project, cfg) {
  if (project === DASHBOARD_PROJECT) return dashboardProject(cfg.dashboardPort);
  const file = readMeta(project)?.file;
  if (!file || !existsSync(file)) return null;
  try { return loadProjectFile(file); } catch { return null; }
}

function knownProjects() {
  let metas = [];
  try { metas = readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch {}
  return [...new Set([DASHBOARD_PROJECT, ...metas, ...localProjects()])].sort();
}

// Same host:port rules as localTargets in watch.js.
function hostPort(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const port = Number(u.port) || { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443, 'ssh:': 22 }[u.protocol];
  if (!port || !u.hostname) return null;
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

// { project: [{ service, hostname, targets: [{ host, port, up }], up }] }
export async function probeAll(cfg, { timeoutMs = 1500, probe = tcpOpen } = {}) {
  const out = {};
  await Promise.all(knownProjects().map(async (project) => {
    const proj = projectFor(project, cfg);
    if (!proj) return;
    let hosts = [];
    try { hosts = cfg.domain ? hostnames(proj, cfg.domain) : []; } catch {}
    // localTargets lists each host:port once; a service may share a port with another.
    const status = new Map();
    await Promise.all(localTargets(project, cfg).map(async (t) => {
      status.set(`${t.host}:${t.port}`, await probe(t.host, t.port, timeoutMs));
    }));
    out[project] = proj.services.map((s) => {
      const mine = [];
      for (const url of [s.url, ...s.paths.map((x) => x.url)]) {
        const t = hostPort(url);
        if (t && status.has(`${t.host}:${t.port}`) && !mine.some((m) => m.host === t.host && m.port === t.port)) {
          mine.push({ ...t, up: status.get(`${t.host}:${t.port}`) });
        }
      }
      return {
        service: s.name,
        hostname: hosts.find((h) => h.service === s.name)?.hostname || null,
        targets: mine,
        up: mine.length ? mine.every((t) => t.up) : null, // null: nothing to probe (e.g. http_status:404)
      };
    });
  }));
  return out;
}

export async function route(ctx) {
  if (ctx.method !== 'GET' || ctx.path !== '/api/health') return false;
  if (Date.now() - cache.at > CACHE_MS || !cache.data) cache = { at: Date.now(), data: await probeAll(ctx.loadConfig()) };
  ctx.json(200, { projects: cache.data, at: cache.at });
  return true;
}

export const html = {
  hostExtras: '<span class="dot" :class="dotClass(p, h)" :title="dotTitle(p, h)" role="img" :aria-label="dotTitle(p, h)"></span>',
  localExtras: '<br><small class="verdict" :class="verdictClass(p)" x-text="verdict(p)"></small>',
};

export const css = `
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--pico-muted-border-color);flex:none}
.dot.ok{background:#1f9d55}.dot.bad{background:#dc2626}.dot.warn{background:#d97706}
small.verdict.bad{color:#dc2626}small.verdict.warn{color:#d97706}
`;

export const js = `
burrowPanel(function () {
  return {
    health: {}, healthTimer: null,
    init: function () {
      var self = this;
      this.loadHealth();
      this.healthTimer = setInterval(function () { self.loadHealth(); }, 10000);
    },
    loadHealth: async function () {
      try { this.health = (await getJson('/api/health')).projects || {}; } catch (e) { this.health = {}; }
    },
    serviceFor: function (p, h) {
      var list = this.health[p.project] || [];
      for (var i = 0; i < list.length; i++) if (list[i].hostname === h) return list[i];
      return null;
    },
    tunnelDown: function (p) {
      if (!p.running) return 'cloudflared stopped';
      var s = p.tunnel && p.tunnel.status;
      if (s === 'down' || s === 'inactive') return 'no Cloudflare connections';
      return '';
    },
    deadTargets: function (p) {
      var out = [];
      (this.health[p.project] || []).forEach(function (s) {
        s.targets.forEach(function (t) { if (!t.up) out.push(s.service + ' :' + t.port); });
      });
      return out;
    },
    dotClass: function (p, h) {
      var s = this.serviceFor(p, h);
      if (!s || s.up === null) return '';
      if (!s.up) return 'bad';
      return this.tunnelDown(p) ? 'warn' : 'ok';
    },
    dotTitle: function (p, h) {
      var s = this.serviceFor(p, h);
      if (!s) return 'local port: unknown';
      if (s.up === null) return 'nothing local to check';
      var ports = s.targets.map(function (t) { return t.host + ':' + t.port + (t.up ? ' answers' : ' not answering'); }).join(', ');
      if (!s.up) return 'App down: ' + ports;
      var t = this.tunnelDown(p);
      return t ? 'App up (' + ports + '), tunnel down: ' + t : 'OK: ' + ports;
    },
    verdict: function (p) {
      if (!this.health[p.project]) return '';
      var parts = [];
      var dead = this.deadTargets(p);
      if (dead.length) parts.push('app down: ' + dead.join(', '));
      var t = this.tunnelDown(p);
      if (t && (p.running || p.tunnel)) parts.push('tunnel down: ' + t);
      return parts.length ? parts.join(' · ') : 'ports answer';
    },
    verdictClass: function (p) {
      if (this.deadTargets(p).length) return 'bad';
      return this.tunnelDown(p) && (p.running || p.tunnel) ? 'warn' : '';
    },
  };
});
`;
