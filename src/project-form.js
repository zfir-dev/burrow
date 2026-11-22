// tunnel.yml <-> the dashboard's project form. New files are rendered by add.js;
// existing files are edited in place with the YAML document API, so comments and
// keys the form doesn't know about (hooks, domain, private, originRequest…) are kept.
import YAML from 'yaml';
import { assertDomain, assertLabel } from './naming.js';
import { parseProject } from './project.js';
import { buildDoc, renderYaml, toUrl, slug } from './add.js';

const str = (v) => String(v ?? '').trim();

// Form shape: { project, domain, app, paths: [{ path, target }], services: [{ name, target }], autostart }
// domain: '' = BURROW_DOMAIN (no `domain:` key); undefined = leave the file's `domain:` alone.
export function normalizeDomain(v) {
  if (v === undefined || v === null) return undefined;
  const d = str(v).toLowerCase().replace(/\.$/, '');
  if (!d) return '';
  try { assertDomain(d); } catch { throw new Error(`invalid domain "${str(v)}" (e.g. example.org)`); }
  return d;
}

export function normalizeForm(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('form must be an object');
  const project = str(raw.project);
  assertLabel(project, 'project name');
  const rows = (v, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 50) throw new Error(`${what} must be a list (at most 50)`);
    return v;
  };
  const paths = rows(raw.paths, 'paths')
    .map((p) => ({ path: str(p?.path), target: str(p?.target) }))
    .filter((p) => p.path || p.target);
  for (const p of paths) {
    if (!p.path || !p.target) throw new Error('every path needs a path and a port or URL');
    if (!p.path.startsWith('/') && !p.path.startsWith('^')) throw new Error(`path "${p.path}" must start with /`);
  }
  const services = rows(raw.services, 'services')
    .map((s) => ({ name: slug(s?.name), target: str(s?.target) }))
    .filter((s) => s.name || s.target);
  for (const s of services) {
    if (!s.name || !s.target) throw new Error('every sub-service needs a name and a port or URL');
    if (s.name === 'app') throw new Error('"app" is the root service; use the App field');
  }
  const app = str(raw.app);
  if (!app && !services.length) throw new Error('add an app port or at least one sub-service');
  if (!app && paths.length) throw new Error('paths need an app port or URL');
  const domain = normalizeDomain(raw.domain);
  return { project, ...(domain === undefined ? {} : { domain }), app, paths, services, autostart: raw.autostart === true };
}

const target = (url) => {
  const m = String(url).match(/^http:\/\/localhost:(\d+)$/);
  return m ? m[1] : String(url);
};

// Read a tunnel.yml into the form. The root service is the form's "app".
export function formFromText(text, source = 'tunnel.yml') {
  const proj = parseProject(text, source);
  const root = proj.services.find((s) => s.root);
  const raw = YAML.parse(text) || {};
  const list = (raw.services || []).filter((s) => s && typeof s === 'object');
  const explicit = list.some((s) => s.root === true);
  const rawRoot = list.find((s) => (explicit ? s.root === true : s.name === 'app'));
  return {
    project: proj.project,
    domain: proj.domain || '',
    app: root ? target(root.url) : '',
    paths: (rawRoot?.paths || []).map((p) => ({ path: String(p.path), target: target(p.url) })),
    services: proj.services.filter((s) => !s.root).map((s) => ({ name: s.name, target: target(s.url) })),
    autostart: proj.autostart,
  };
}

// New file: same output as `burrow add`, plus autostart.
export function renderNew(form) {
  const f = normalizeForm(form);
  const doc = buildDoc({
    project: f.project, app: f.app, paths: f.paths.map((p) => [p.path, p.target]),
    services: f.services.map((s) => [s.name, s.target]),
  });
  if (f.autostart) doc.autostart = true;
  return renderYaml(f.domain ? { project: doc.project, domain: f.domain, ...doc } : doc);
}

// Existing file: replace services/autostart, keep everything else. Extra keys on a
// service (originRequest, private, …) survive when the service keeps its name.
export function renderEdit(text, form, source = 'tunnel.yml') {
  const f = normalizeForm(form);
  const before = parseProject(text, source);
  if (f.project !== before.project) throw new Error(`renaming is not supported here (${before.project} -> ${f.project})`);
  const doc = YAML.parseDocument(text);
  const old = (doc.toJS().services || []).filter((s) => s && typeof s === 'object');
  const oldRoot = old.find((s) => s.root === true) || old.find((s) => s.name === 'app');
  const keep = (prev, fields) => {
    const out = { ...(prev || {}) };
    for (const k of ['name', 'url', 'paths', 'root']) delete out[k];
    return { ...fields, ...out };
  };
  const services = [];
  if (f.app) {
    const svc = { name: oldRoot?.name || 'app', url: toUrl(f.app) };
    if (oldRoot && oldRoot.name !== 'app') svc.root = true;
    if (f.paths.length) {
      svc.paths = f.paths.map((p) => {
        const prev = (oldRoot?.paths || []).find((x) => String(x.path) === p.path);
        return { ...(prev || {}), path: p.path, url: toUrl(p.target) };
      });
    }
    services.push(keep(oldRoot, svc));
  }
  for (const s of f.services) {
    services.push(keep(old.find((o) => o !== oldRoot && o.name === s.name), { name: s.name, url: toUrl(s.target) }));
  }
  doc.set('services', doc.createNode(services));
  if (f.autostart) doc.set('autostart', true);
  else doc.delete('autostart');
  if (f.domain) doc.set('domain', f.domain);
  else if (f.domain === '') doc.delete('domain');
  const out = doc.toString({ lineWidth: 0 });
  parseProject(out, source); // same errors as `burrow up`
  return out;
}

// Rename: only the `project:` key changes; comments, services and other keys stay.
export function renameText(text, to, source = 'tunnel.yml') {
  assertLabel(to, 'new project name');
  const before = parseProject(text, source);
  if (before.project === to) throw new Error(`${source} is already called ${to}`);
  const doc = YAML.parseDocument(text);
  doc.set('project', to);
  const out = doc.toString({ lineWidth: 0 });
  parseProject(out, source);
  return out;
}
