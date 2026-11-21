import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { assertDomain, assertLabel, hostnameFor } from './naming.js';

export const DEFAULT_FILE = 'tunnel.yml';

// The dashboard's own tunnel: burrow.<domain> -> the local dashboard port.
export const DASHBOARD_PROJECT = 'burrow';
export function dashboardProject(port = 7070) {
  return {
    project: DASHBOARD_PROJECT,
    services: [{ name: 'app', root: true, url: `http://localhost:${port}`, paths: [] }],
    source: '(built-in dashboard)',
  };
}

export function findProjectFile(file) {
  const p = resolve(file || DEFAULT_FILE);
  return existsSync(p) ? p : null;
}

export function loadProjectFile(path) {
  return parseProject(readFileSync(path, 'utf8'), path);
}

function assertUrl(url, where) {
  if (typeof url !== 'string') throw new Error(`${where}: "url" is required`);
  if (/^(http_status:\d{3}|hello_world)$/.test(url)) return;
  let u;
  try { u = new URL(url); } catch { throw new Error(`${where}: invalid url "${url}"`); }
  if (!['http:', 'https:', 'tcp:', 'ssh:', 'unix:', 'ws:', 'wss:'].includes(u.protocol)) {
    throw new Error(`${where}: unsupported url scheme in "${url}"`);
  }
}

// Plain prefixes like /auth/v1 become an anchored regex matching the prefix
// and anything under it. Values starting with ^ are passed through as regex.
export function pathRegex(path) {
  if (typeof path !== 'string' || !path) throw new Error('path must be a non-empty string');
  if (path.startsWith('^')) return path;
  const clean = '/' + path.replace(/^\/+|\/+$/g, '');
  const escaped = clean.replace(/[.*+?()[\]{}|\\$]/g, '\\$&');
  return `^${escaped}(/.*)?$`;
}

export function parseProject(text, source = 'tunnel.yml') {
  const doc = YAML.parse(text) || {};
  const project = String(doc.project ?? '').trim();
  assertLabel(project, `project name in ${source}`);
  if (project === DASHBOARD_PROJECT) throw new Error(`${source}: "${DASHBOARD_PROJECT}" is reserved for the dashboard`);
  let domain;
  if (doc.domain !== undefined && doc.domain !== null && doc.domain !== '') {
    domain = String(doc.domain).trim().toLowerCase().replace(/\.$/, '');
    try { assertDomain(domain); } catch { throw new Error(`${source}: invalid domain "${doc.domain}" (e.g. domain: example.org)`); }
  }
  if (!Array.isArray(doc.services) || doc.services.length === 0) {
    throw new Error(`${source}: "services" must be a non-empty list`);
  }
  const hasExplicitRoot = doc.services.some((s) => s && s.root === true);
  const seen = new Set();
  const services = doc.services.map((s, i) => {
    const where = `${source}: services[${i}]`;
    if (!s || typeof s !== 'object') throw new Error(`${where} must be a mapping`);
    const name = String(s.name ?? '').trim();
    assertLabel(name, `service name (${where})`);
    const root = hasExplicitRoot ? s.root === true : name === 'app';
    assertUrl(s.url, where);
    const paths = (s.paths || []).map((p, j) => {
      const pw = `${where}.paths[${j}]`;
      if (!p || typeof p !== 'object') throw new Error(`${pw} must be {path, url}`);
      assertUrl(p.url, pw);
      return { path: pathRegex(p.path), url: p.url, ...(p.originRequest ? { originRequest: p.originRequest } : {}) };
    });
    const svc = { name, root, url: s.url, paths };
    if (s.originRequest) svc.originRequest = s.originRequest;
    const key = root ? '@root' : name;
    if (seen.has(key)) throw new Error(`${where}: duplicate ${root ? 'root service' : `service "${name}"`}`);
    seen.add(key);
    return svc;
  });
  return { project, services, source, autostart: doc.autostart === true, ...(domain ? { domain } : {}) };
}

export function hostnames(proj, domain) {
  return proj.services.map((s) => ({ service: s.name, hostname: hostnameFor(proj.project, s, domain) }));
}

export function buildIngress(proj, domain) {
  const ingress = [];
  for (const s of proj.services) {
    const hostname = hostnameFor(proj.project, s, domain);
    for (const p of s.paths) {
      const rule = { hostname, path: p.path, service: p.url };
      const origin = p.originRequest || s.originRequest;
      if (origin) rule.originRequest = origin;
      ingress.push(rule);
    }
    const rule = { hostname, service: s.url };
    if (s.originRequest) rule.originRequest = s.originRequest;
    ingress.push(rule);
  }
  ingress.push({ service: 'http_status:404' });
  return ingress;
}
