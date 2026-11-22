import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './config.js';

// Cloudflare Access for services marked `private: true`: one self-hosted Access app per
// hostname, with one allow policy. burrow owns an app when it carries the Access tag
// "burrow" and is named burrow:<project>:<service>. Anything else is never touched.
export const ACCESS_TAG = 'burrow';
export const POLICY_NAME = 'burrow:allow';
export const PERMISSION_HINT = 'The API token needs Account > Access: Apps and Policies > Edit for private: true services.';
export const appName = (project, service) => `burrow:${project}:${service}`;
const log = (...a) => console.log(...a);

export function ownedBy(app, project) {
  const prefix = project ? `burrow:${project}:` : 'burrow:';
  return String(app?.name || '').startsWith(prefix) && (app.tags || []).includes(ACCESS_TAG);
}

// Which apps exist for a project is remembered locally, so projects that never used
// private: true never call the Access API (and tokens without Access permission keep working).
export const accessStateFile = (project) => join(stateDir(), 'access', `${project}.json`);
function readState(project) {
  try { return JSON.parse(readFileSync(accessStateFile(project), 'utf8')).apps || []; } catch { return []; }
}
function writeState(project, apps) {
  if (!apps.length) { rmSync(accessStateFile(project), { force: true }); return; }
  mkdirSync(dirname(accessStateFile(project)), { recursive: true, mode: 0o700 });
  writeFileSync(accessStateFile(project), JSON.stringify({ apps }, null, 2) + '\n', { mode: 0o600 });
}
export function accessProjects() {
  try { return readdirSync(join(stateDir(), 'access')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
}

export function parseEmails(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}
export const validAllow = (e) => /^[^@\s,]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) || /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(e);

export function includeRules(allow) {
  return allow.map((e) => (e.startsWith('@') ? { email_domain: { domain: e.slice(1) } } : { email: { email: e } }));
}

// [{ service, hostname, allow, name }] for the project's private services.
// hosts is hostnames(proj, domain), in the same order as proj.services.
export function privateHosts(proj, hosts, cfg) {
  const out = [];
  proj.services.forEach((s, i) => {
    if (!s.private) return;
    const allow = s.allow?.length ? s.allow : parseEmails(cfg.accessEmails);
    if (!allow.length) {
      throw new Error(`${proj.project}: service "${s.name}" is private but has no "allow" list, and BURROW_ACCESS_EMAILS is empty.`);
    }
    const bad = allow.filter((e) => !validAllow(e));
    if (bad.length) throw new Error(`BURROW_ACCESS_EMAILS: invalid entries ${bad.join(', ')} (use emails or @domain)`);
    out.push({ service: s.name, hostname: hosts[i].hostname, allow, name: appName(proj.project, s.name) });
  });
  return out;
}

const isAuthError = (e) => /HTTP 40[13]\b/.test(e.message) || /\b10000: /.test(e.message);
async function guard(fn) {
  try { return await fn(); } catch (e) {
    if (isAuthError(e)) throw new Error(`Cloudflare Access: ${e.message}. ${PERMISSION_HINT}`);
    throw e;
  }
}

const appsPath = (cf) => `/accounts/${cf.accountId}/access/apps`;
const listApps = (cf) => cf.all(appsPath(cf));

async function ensureTag(cf) {
  const tag = await cf.req('GET', `/accounts/${cf.accountId}/access/tags/${ACCESS_TAG}`, { allow404: true });
  if (!tag) await cf.req('POST', `/accounts/${cf.accountId}/access/tags`, { body: { name: ACCESS_TAG } });
}

const sortRules = (rules) => JSON.stringify((rules || []).map((r) => JSON.stringify(r)).sort());

async function syncPolicy(cf, app, w) {
  const base = `${appsPath(cf)}/${app.id}/policies`;
  const include = includeRules(w.allow);
  const body = { name: POLICY_NAME, decision: 'allow', include, precedence: 1 };
  const ours = (await cf.all(base)).find((p) => p.name === POLICY_NAME);
  if (!ours) {
    await cf.req('POST', base, { body });
    log(`Access: ${w.hostname} allows ${w.allow.join(', ')}`);
  } else if (sortRules(ours.include) !== sortRules(include) || ours.decision !== 'allow') {
    await cf.req('PUT', `${base}/${ours.id}`, { body });
    log(`Access: ${w.hostname} now allows ${w.allow.join(', ')}`);
  }
}

// Called by `burrow up` after DNS: create/update apps for private services and delete
// burrow's apps for services that are no longer private.
export async function syncAccess(cf, cfg, proj, hosts, { dry = false } = {}) {
  const wanted = privateHosts(proj, hosts, cfg);
  if (dry) {
    for (const w of wanted) log(`[dry-run] would protect https://${w.hostname} with Cloudflare Access (allow: ${w.allow.join(', ')})`);
    return;
  }
  if (!wanted.length && !readState(proj.project).length) return;
  await guard(async () => {
    const all = await listApps(cf);
    const ours = all.filter((a) => ownedBy(a, proj.project));
    const kept = [];
    if (wanted.length) await ensureTag(cf);
    for (const w of wanted) {
      const foreign = all.find((a) => a.domain === w.hostname && !ownedBy(a));
      if (foreign) {
        log(`Access: https://${w.hostname} already has an Access app not managed by burrow ("${foreign.name}"); leaving it alone.`);
        continue;
      }
      const body = { name: w.name, domain: w.hostname, type: 'self_hosted', session_duration: '24h', app_launcher_visible: false, tags: [ACCESS_TAG] };
      let app = ours.find((a) => a.name === w.name);
      if (!app) {
        app = (await cf.req('POST', appsPath(cf), { body })).result;
        log(`Access: protected https://${w.hostname} (app ${app.id})`);
      } else if (app.domain !== w.hostname || app.type !== 'self_hosted') {
        app = (await cf.req('PUT', `${appsPath(cf)}/${app.id}`, { body: { ...body, id: app.id } })).result;
        log(`Access: updated the app for https://${w.hostname}`);
      }
      await syncPolicy(cf, app, w);
      kept.push({ id: app.id, name: w.name, hostname: w.hostname });
    }
    for (const a of ours) {
      if (kept.some((k) => k.id === a.id)) continue;
      await cf.req('DELETE', `${appsPath(cf)}/${a.id}`, { allow404: true });
      log(`Access: removed ${a.name}; https://${a.domain} is public again`);
    }
    writeState(proj.project, kept);
  });
}

// Called by `burrow destroy`: delete every Access app burrow made for the project.
export async function removeAccessApps(cf, project) {
  if (!readState(project).length) return 0;
  return guard(async () => {
    let n = 0;
    for (const a of (await listApps(cf)).filter((x) => ownedBy(x, project))) {
      await cf.req('DELETE', `${appsPath(cf)}/${a.id}`, { allow404: true });
      log(`${project}: deleted Access app ${a.name} (${a.domain})`);
      n++;
    }
    writeState(project, []);
    return n;
  });
}

// For `burrow prune`: burrow-owned apps whose project has no local state. A token without
// Access permission (or an account without Access) simply has no orphan apps.
export async function orphanAccessApps(cf, local) {
  try {
    return (await listApps(cf)).filter((a) => ownedBy(a) && !local.has(String(a.name).split(':')[1]));
  } catch (e) {
    if (isAuthError(e)) log(`Skipping Access apps: ${PERMISSION_HINT}`);
    return [];
  }
}

export async function deleteAccessApp(cf, app) {
  await cf.req('DELETE', `${appsPath(cf)}/${app.id}`, { allow404: true });
  rmSync(accessStateFile(String(app.name).split(':')[1]), { force: true });
}
